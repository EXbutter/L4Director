import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStore, getApiBase, normalizeModKey, PackData, ModData, ConflictDetail } from '../store/useStore';
import { useShallow } from 'zustand/react/shallow';
import { ToolBar } from './ToolBar';
import { showToast } from './Toast';
import { ThumbImage } from './ThumbImage';
import { DefaultCover } from './DefaultCover';
import { ConflictDialog } from './ConflictDialog';
import { isCampaignMod } from '../utils/modRole';
import { ModSwitch } from './ModSwitch';
import { FAVORITE_TAG, isFineTag, orderCardTags } from './MyModsPage';
import { useModalA11y } from '../hooks/useModalA11y';
import { observeViewport } from '../utils/viewportObserver';
import './ContentArea.scss';
import './MyModsPage.scss';

/// ── Shared helpers (match MyModsPage exactly) ──
function getStableModId(mod: ModData): string {
  return `mod-${mod.name}`;
}

function getModTitle(mod: { vpk_title?: string | null; display_name?: string; name: string }, customName?: string | null): string {
  if (customName) return customName;
  return mod.vpk_title || mod.display_name || mod.name;
}

function formatSize(bytes: number, mod?: ModData): string {
  // 战役地图体积大但不常驻（只在进那张图时按需载入），不参与内存占用统计 → 显示 '-'
  if (mod && isCampaignMod(mod)) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);
  return `${size} ${units[i]}`;
}

function resolveUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('/api/')) {
    // 必须用「当前」后端地址：8288 被占用时主进程会把后端切到备用端口，
    // 写死端口会让整合包详情页里的缩略图全部 404。
    return `${getApiBase()}${url}`;
  }
  return url;
}

/// ── Intersection observer hook (same as MyModsPage) ──
function useIntersectionObserver(
  // 同 MyModsPage：池只支持单一 threshold，把 IntersectionObserverInit 收窄
  options?: { rootMargin?: string; threshold?: number }
): [React.RefCallback<HTMLDivElement>, boolean] {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const callbackRef = useCallback((node: HTMLDivElement | null) => {
    elementRef.current = node;
  }, []);

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    // 共享观察器池（utils/viewportObserver.ts），与 MyModsPage 同一实现。
    // 一次性触发：首次相交后退订（池里的 observe 记录随之摘除，不再持续观测）。
    let stop: (() => void) | null = null;
    stop = observeViewport(
      el,
      (isIntersecting) => {
        if (!isIntersecting) return;
        setIsVisible(true);
        stop?.();
      },
      { rootMargin: '200px', threshold: 0, ...options }
    );

    return () => stop?.();
  }, [elementRef.current, options?.rootMargin, options?.threshold]);

  return [callbackRef, isVisible];
}

/// ── ModPreview with lazy loading (same as MyModsPage) ──
function ModPreview({ mod, displayName }: { mod: ModData; displayName: string }) {
  const [imgError, setImgError] = useState(false);
  const [containerRef, isVisible] = useIntersectionObserver();
  
  useEffect(() => {
    setImgError(false);
  }, [mod.thumbnail_url]);

  const imgSrc = resolveUrl(mod.thumbnail_url);

  return (
    <div ref={containerRef} className="mod-card__preview-container">
      {imgSrc && !imgError && isVisible ? (
        <div className="mod-card__preview mod-card__preview--image">
          {/* 超大图 / 伪装成 .jpg 的 GIF 动图会在这里被转成静态小图 */}
          <ThumbImage
            src={imgSrc}
            alt={displayName}
            className="mod-card__thumbnail"
            onError={() => setImgError(true)}
          />
        </div>
      ) : (
        <div className="mod-card__preview">
          <DefaultCover />
        </div>
      )}
    </div>
  );
}

/// ── Sort options ──
const sortOptions = [
  { value: 'name-asc', label: '名称 A-Z' },
  { value: 'name-desc', label: '名称 Z-A' },
  { value: 'mods-desc', label: 'Mod 数 ↓' },
  { value: 'mods-asc', label: 'Mod 数 ↑' },
];

export function PacksPage() {
  // 以前是 `useStore()` 整店订阅：扫描进度（每扫完一个文件就 set 一次）、
  // 工坊轮询、Toast 队列……任何一处变化都会让整个收藏包页重渲染。
  // 现在只订阅本页真正用到的字段，并用 useShallow 做浅比较 ——
  // selector 每次返回新对象，不套 useShallow 会无限重渲染。
  // 数组字段（packs/mods/customTags）在 store 里都是「整体替换」的不可变更新，
  // 浅比较看引用即可，不会漏更新。
  const {
    packs,
    mods,
    createPack,
    deletePack,
    renamePack,
    selectPack,
    selectedPack,
    removeModFromPack,
    addModsToPack,
    toggleMod,
    enablePackMods,
    exportPackAsZip,
    applyPack,
    updatePackSnapshot,
    removeMissingMembers,
    setPackDescription,
    importPack,
    packContextMenu,
    setPackContextMenu,
    getModDisplayName,
    refreshAll,
    customTags,
  } = useStore(useShallow((s) => ({
    packs: s.packs,
    mods: s.mods,
    createPack: s.createPack,
    deletePack: s.deletePack,
    renamePack: s.renamePack,
    selectPack: s.selectPack,
    selectedPack: s.selectedPack,
    removeModFromPack: s.removeModFromPack,
    addModsToPack: s.addModsToPack,
    toggleMod: s.toggleMod,
    enablePackMods: s.enablePackMods,
    exportPackAsZip: s.exportPackAsZip,
    applyPack: s.applyPack,
    updatePackSnapshot: s.updatePackSnapshot,
    removeMissingMembers: s.removeMissingMembers,
    setPackDescription: s.setPackDescription,
    importPack: s.importPack,
    packContextMenu: s.packContextMenu,
    setPackContextMenu: s.setPackContextMenu,
    getModDisplayName: s.getModDisplayName,
    refreshAll: s.refreshAll,
    customTags: s.customTags,
  })));
  const [exportError, setExportError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('name-asc');
  // 排版：卡片墙 / 单列列表。和「我的 Mod」分开记，两边互不影响
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem('l4d2-packs-view') === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const changeViewMode = useCallback((mode: 'grid' | 'list') => {
    setViewMode(mode);
    try {
      localStorage.setItem('l4d2-packs-view', mode);
    } catch {
      /* 隐私模式等场景写不进去，忽略 */
    }
  }, []);
  // 整合包「详情里」的 Mod 筛选
  const [packModSearch, setPackModSearch] = useState('');
  const [packStatusFilter, setPackStatusFilter] = useState<'all' | 'enabled' | 'disabled' | 'conflict'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newPackName, setNewPackName] = useState('');
  // 「把已启用的 Mod 一键导入新整合包」
  const [showImportModal, setShowImportModal] = useState(false);
  const [importPackName, setImportPackName] = useState('');
  const [importing, setImporting] = useState(false);
  const [renamePackId, setRenamePackId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmPackId, setDeleteConfirmPackId] = useState<string | null>(null);
  // 「添加 Mod」弹窗
  const [showAddModsModal, setShowAddModsModal] = useState(false);
  const [addModsSearch, setAddModsSearch] = useState('');
  const [selectedAddMods, setSelectedAddMods] = useState<Set<string>>(new Set());
  const [togglingPack, setTogglingPack] = useState(false);
  // 「应用此整合包」：是否同时关闭包外 Mod（默认关）+ 执行中标记
  const [disableOthers, setDisableOthers] = useState(false);
  const [applyingPack, setApplyingPack] = useState(false);
  // 新建 / 导入弹窗：保存当前启停状态（默认开）
  const [saveSnapshot, setSaveSnapshot] = useState(true);
  // 导入整合包 ZIP 执行中
  const [importingZip, setImportingZip] = useState(false);
  // 描述草稿（详情页 inline 编辑，失焦保存）
  const [descDraft, setDescDraft] = useState('');
  // 冲突详情弹窗
  const [conflictDialogMod, setConflictDialogMod] = useState<string | null>(null);
  const [conflictSnapshot, setConflictSnapshot] = useState<ConflictDetail[]>([]);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 弹窗的 Esc 关闭 + Tab 焦点陷阱（与 MyModsPage 同一套，见 hooks/useModalA11y）
  const createModalRef = useModalA11y(showCreateModal, () => setShowCreateModal(false));
  const renameModalRef = useModalA11y(!!renamePackId, () => {
    setRenamePackId(null);
    setRenameValue('');
  });
  const deleteModalRef = useModalA11y(!!deleteConfirmPackId, () => setDeleteConfirmPackId(null));
  const addModsModalRef = useModalA11y(showAddModsModal, () => {
    setShowAddModsModal(false);
    setSelectedAddMods(new Set());
  });

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setPackContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filtered = useMemo(() => {
    let list = packs;

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }

    switch (sortBy) {
      case 'name-asc':
        list = [...list].sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'name-desc':
        list = [...list].sort((a, b) => b.name.localeCompare(a.name));
        break;
      case 'mods-desc':
        list = [...list].sort((a, b) => b.modNames.length - a.modNames.length);
        break;
      case 'mods-asc':
        list = [...list].sort((a, b) => a.modNames.length - b.modNames.length);
        break;
    }

    return list;
  }, [search, sortBy, packs]);

  const handleCreatePack = async () => {
    if (!newPackName.trim()) return;
    const created = await createPack(newPackName.trim());
    setNewPackName('');
    setShowCreateModal(false);
    if (created && saveSnapshot && created.modNames.length > 0) {
      await updatePackSnapshot(created.id);
    }
  };

  // 当前已启用的 Mod：一键导入的取材范围。
  // 只认 enabled，不看筛选/搜索 —— 那是「我的 Mod」页面的浏览状态，与整合包无关。
  const enabledMods = useMemo(() => mods.filter((m) => m.enabled), [mods]);

  const openImportModal = () => {
    if (enabledMods.length === 0) {
      showToast('当前没有已启用的 Mod，去「我的 Mod」里先启用一些', 'warning');
      return;
    }
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    setImportPackName(`已启用 Mod ${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    setShowImportModal(true);
  };

  const handleImportEnabled = async () => {
    const name = importPackName.trim();
    if (!name || importing) return;
    if (enabledMods.length === 0) {
      showToast('当前没有已启用的 Mod', 'warning');
      return;
    }
    setImporting(true);
    try {
      // 一次请求就把成员写进去：先建空包再补一次 PUT 会多一次读写盘，
      // 中途失败还会留下一个「名字有了但里面是空的」整合包
      const created = await createPack(name, enabledMods.map((m) => m.name));
      if (!created) {
        showToast('创建整合包失败', 'error');
        return;
      }
      setShowImportModal(false);
      setImportPackName('');
      showToast(`已创建「${created.name}」，包含 ${created.modNames.length} 个 Mod`, 'success');
      // 直接进详情页：省得用户建完之后还要在列表里再找一遍
      selectPack(created);
      // 按需保存当前启停状态（导入的都是已启用 Mod，通常为空快照）
      if (saveSnapshot && created.modNames.length > 0) {
        await updatePackSnapshot(created.id);
      }
    } finally {
      setImporting(false);
    }
  };

  const handlePackClick = (pack: PackData) => {
    selectPack(selectedPack?.id === pack.id ? null : pack);
  };

  const handleRemoveMod = (modName: string) => {
    if (selectedPack) {
      removeModFromPack(modName, selectedPack.id);
    }
  };

  const handleToggleMod = useCallback((modName: string) => {
    toggleMod(modName);
  }, [toggleMod]);

  const handleContextMenu = (e: React.MouseEvent, packId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setPackContextMenu({ x: e.clientX, y: e.clientY, packId });
  };

  const handleRenameSubmit = () => {
    if (renamePackId && renameValue.trim()) {
      renamePack(renamePackId, renameValue.trim());
      setRenamePackId(null);
      setRenameValue('');
      setPackContextMenu(null);
    }
  };

  const handleDeletePack = (packId: string) => {
    deletePack(packId);
    setPackContextMenu(null);
  };

  // mods 的归一化索引：成员匹配（含 coverMod / 失效判断）统一走 normalizeModKey
  const modsByKey = useMemo(() => {
    const map = new Map<string, ModData>();
    for (const m of mods) {
      const k = normalizeModKey(m.name);
      if (!map.has(k)) map.set(k, m);
    }
    return map;
  }, [mods]);

  const getPackCoverMod = useCallback((pack: PackData): ModData | null => {
    // 1) 优先用钉住的封面（coverMod）
    if (pack.coverMod) {
      const pinned = modsByKey.get(normalizeModKey(pack.coverMod));
      if (pinned) return pinned;
    }
    if (pack.modNames.length === 0) return null;
    // 2) 否则从后往前找最后一个「仍然存在」的 Mod 作为封面：
    //    直接取最后一个时，一旦它被删除，整张卡片就再没有封面了
    for (let i = pack.modNames.length - 1; i >= 0; i -= 1) {
      const found = modsByKey.get(normalizeModKey(pack.modNames[i]));
      if (found) return found;
    }
    return null;
  }, [modsByKey]);

  // 单个整合包的派生统计：总数 / 存在数 / 启用数 / 冲突数 / 失效数
  const deriveStats = useCallback((pack: PackData) => {
    let present = 0;
    let enabled = 0;
    let conflict = 0;
    let missing = 0;
    const seen = new Set<string>();
    for (const name of pack.modNames) {
      const k = normalizeModKey(name);
      if (seen.has(k)) continue;
      seen.add(k);
      const m = modsByKey.get(k);
      if (!m) {
        missing += 1;
        continue;
      }
      present += 1;
      if (m.enabled) {
        enabled += 1;
        if (m.conflicts && m.conflicts.length > 0) conflict += 1;
      }
    }
    return { total: seen.size, present, enabled, conflict, missing };
  }, [modsByKey]);

  const packMods = useMemo(() => {
    if (!selectedPack) return [];
    // 按整合包里的顺序展示（而不是 mods 全表的顺序），更符合「整合包」的直觉；
    // 匹配统一走 normalizeModKey：兼容历史数据里的写法差异
    //（`mod-xxx.vpk` 前缀 / 缺 `.vpk` 后缀 / `workshop\\xxx.vpk` / 大小写），
    // 同时顺带过滤掉已被删除、但还残留在包里的名字。
    const byKey = new Map(mods.map((m) => [normalizeModKey(m.name), m]));
    const seen = new Set<string>();
    const result: ModData[] = [];
    for (const name of selectedPack.modNames) {
      const key = normalizeModKey(name);
      const mod = byKey.get(key);
      if (mod && !seen.has(key)) {
        seen.add(key);
        result.push(mod);
      }
    }
    return result;
  }, [selectedPack, mods]);

  // 失效成员：成员里磁盘上已不存在的（用 mods + normalizeModKey 判断）
  const missingMembers = useMemo(() => {
    if (!selectedPack) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of selectedPack.modNames) {
      const k = normalizeModKey(name);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!modsByKey.has(k)) out.push(name);
    }
    return out;
  }, [selectedPack, modsByKey]);

  // 本包内「目标为禁用」的成员 key 集合（用于成员卡上的「本包内关闭」角标）
  const disabledMemberKeys = useMemo(() => {
    return new Set((selectedPack?.disabledMembers || []).map((n) => normalizeModKey(n)));
  }, [selectedPack?.disabledMembers]);

  // 筛选用的计数（始终按整合包的完整成员统计，不受当前筛选影响）
  const packStats = useMemo(() => {
    let enabled = 0;
    let conflict = 0;
    for (const m of packMods) {
      if (m.enabled) enabled += 1;
      if (m.enabled && m.conflicts && m.conflicts.length > 0) conflict += 1;
    }
    return { all: packMods.length, enabled, disabled: packMods.length - enabled, conflict };
  }, [packMods]);

  // 详情页里真正渲染的 Mod：搜索 + 状态筛选
  const filteredPackMods = useMemo(() => {
    const q = packModSearch.trim().toLowerCase();
    return packMods.filter((m) => {
      const hasConflict = m.enabled && !!m.conflicts && m.conflicts.length > 0;
      if (packStatusFilter === 'enabled' && !m.enabled) return false;
      if (packStatusFilter === 'disabled' && m.enabled) return false;
      if (packStatusFilter === 'conflict' && !hasConflict) return false;
      if (!q) return true;
      const title = getModTitle(m, getModDisplayName(m.name));
      return title.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    });
  }, [packMods, packModSearch, packStatusFilter, getModDisplayName]);

  // 切换整合包时清掉上一个包的筛选条件，否则会莫名其妙「空的」
  useEffect(() => {
    setPackModSearch('');
    setPackStatusFilter('all');
  }, [selectedPack?.id]);

  // 可添加到当前整合包的 Mod（排除已在包内的），供「添加 Mod」弹窗使用
  const addableMods = useMemo(() => {
    if (!selectedPack) return [];
    const inPack = new Set(selectedPack.modNames.map(normalizeModKey));
    const q = addModsSearch.trim().toLowerCase();
    return mods
      .filter((m) => !inPack.has(normalizeModKey(m.name)))
      .filter((m) => {
        if (!q) return true;
        const title = getModTitle(m, getModDisplayName(m.name));
        return title.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
      });
  }, [mods, selectedPack, addModsSearch, getModDisplayName]);

  useEffect(() => {
    if (exportError) {
      const timer = setTimeout(() => setExportError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [exportError]);

  const handleExport = useCallback(async () => {
    if (!selectedPack) return;
    setExportError(null);
    try {
      await exportPackAsZip(selectedPack.id);
    } catch (e: any) {
      setExportError(e?.message || '导出失败');
    }
  }, [selectedPack, exportPackAsZip]);

  // 描述草稿：切换整合包时重置（仅在 id 变化时同步，避免保存后光标跳）
  useEffect(() => {
    setDescDraft(selectedPack?.description || '');
  }, [selectedPack?.id]);

  const handleDescriptionBlur = () => {
    if (!selectedPack) return;
    const next = descDraft.trim();
    if (next !== (selectedPack.description || '')) {
      setPackDescription(selectedPack.id, next);
    }
  };

  // 「应用此整合包」：按本包目标启停精确恢复，可选关闭包外 Mod
  const handleApplyPack = async () => {
    if (!selectedPack) return;
    if (selectedPack.modNames.length === 0) {
      showToast('这个整合包里还没有 Mod', 'warning');
      return;
    }
    if (applyingPack) return;
    setApplyingPack(true);
    try {
      const result = await applyPack(selectedPack.id, { disableOthers });
      if (!result) return; // 失败已在 store 里 toast
      const parts: string[] = [`已应用「${selectedPack.name}」`];
      if (result.changed > 0) parts.push(`改动 ${result.changed} 个`);
      if (result.outsideDisabled.length > 0) parts.push(`关闭包外 ${result.outsideDisabled.length} 个`);
      if (result.missing.length > 0) parts.push(`${result.missing.length} 个成员失效`);
      showToast(parts.join('，'), result.missing.length > 0 ? 'warning' : 'success');
    } finally {
      setApplyingPack(false);
    }
  };

  // 「从当前启停状态更新本包」：把成员里当前禁用的记入 disabledMembers
  const handleUpdateSnapshot = async () => {
    if (!selectedPack) return;
    await updatePackSnapshot(selectedPack.id);
    showToast('已按当前启停状态更新本包', 'success');
  };

  // 「清理失效成员」
  const handleCleanMissing = async () => {
    if (!selectedPack) return;
    const count = missingMembers.length;
    if (count === 0) {
      showToast('没有失效成员需要清理', 'info');
      return;
    }
    await removeMissingMembers(selectedPack.id);
    showToast(`已清理 ${count} 个失效成员`, 'success');
  };

  // 「导入整合包」：主进程挑 ZIP + 解压落盘，再建包进入详情
  const handleImportZip = async () => {
    if (importingZip) return;
    const api = (window as any).electronAPI;
    if (!api || typeof api.pickPackZip !== 'function') {
      showToast('当前版本不支持导入整合包', 'error');
      return;
    }
    let picked: { canceled: boolean; path?: string } | null = null;
    try {
      picked = await api.pickPackZip();
    } catch {
      picked = null;
    }
    if (!picked || picked.canceled || !picked.path) return;
    setImportingZip(true);
    try {
      const created = await importPack(picked.path, { saveSnapshot: true });
      if (created) {
        showToast(`已导入「${created.name}」，包含 ${created.modNames.length} 个 Mod`, 'success');
        selectPack(created);
      }
    } finally {
      setImportingZip(false);
    }
  };

  // 旧的整包滑块降级为「全部启用 / 全部禁用」
  const runPackBulk = async (enable: boolean) => {
    if (!selectedPack) return;
    if (selectedPack.modNames.length === 0) {
      showToast('这个整合包里还没有 Mod', 'warning');
      return;
    }
    if (togglingPack) return;
    setTogglingPack(true);
    try {
      const result = await enablePackMods(selectedPack.id, enable);
      if (result === null) {
        showToast('操作失败', 'error');
        return;
      }
      const label = enable ? '启用' : '禁用';
      if (result.missing.length > 0) {
        showToast(
          `已${label} ${result.changed} 个，另有 ${result.missing.length} 个成员在磁盘上找不到对应文件`,
          'warning'
        );
      } else {
        showToast(`已${label}整合包中的 ${result.changed} 个 Mod`, 'success');
      }
    } finally {
      setTogglingPack(false);
    }
  };

  const openAddModsModal = () => {
    setAddModsSearch('');
    setSelectedAddMods(new Set());
    setShowAddModsModal(true);
  };

  const toggleAddSelection = (name: string) => {
    setSelectedAddMods((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleAddModsConfirm = async () => {
    if (!selectedPack || selectedAddMods.size === 0) return;
    const names = Array.from(selectedAddMods);
    const packId = selectedPack.id;
    setShowAddModsModal(false);
    setSelectedAddMods(new Set());
    // 一次请求加入全部（逐条请求会出现「只加进去一部分」的中间状态）
    await addModsToPack(names, packId);
    showToast(`已添加 ${names.length} 个 Mod 到整合包`, 'success');
  };

  return (
    <div className="content-area">
      {exportError && (
        <div className="export-error-toast" style={{
          position: 'fixed',
          top: '60px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#ef4444',
          color: 'white',
          padding: '10px 20px',
          borderRadius: '8px',
          fontSize: '13px',
          fontWeight: 500,
          zIndex: 9999,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {exportError}
        </div>
      )}
      <ToolBar
        searchPlaceholder="搜索整合包..."
        sortOptions={sortOptions}
        defaultSort="name-asc"
        onSearchChange={setSearch}
        onSortChange={setSortBy}
        onRefresh={refreshAll}
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
      />
      
      <div className="packs-pagebar">
        <div className="packs-pagebar__intro">
          <div className="packs-kicker">Library</div>
          <h1 className="packs-pagebar__title">整合包</h1>
          <p className="packs-pagebar__sub">把一组 Mod 存成场景，一键切换整套启停</p>
        </div>
        <div className="packs-pagebar__acts">
          <button
            className="packs-btn-ghost"
            onClick={openImportModal}
            title={
              enabledMods.length > 0
                ? `把当前已启用的 ${enabledMods.length} 个 Mod 归入一个新整合包`
                : '当前没有已启用的 Mod'
            }
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
            导入已启用 Mod
            {enabledMods.length > 0 && (
              <span className="packs-btn-ghost__badge">{enabledMods.length}</span>
            )}
          </button>
          <button
            className="packs-btn-ghost"
            onClick={handleImportZip}
            disabled={importingZip}
            title="从 .zip 整合包文件导入（「导出整合包」得到的 ZIP 可直接导回）"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {importingZip ? '导入中…' : '导入整合包'}
          </button>
          <button className="packs-btn-primary" onClick={() => setShowCreateModal(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            新建整合包
          </button>
        </div>
      </div>

      {selectedPack ? (
        <div className="pack-detail">
          <div className="packs-hero">
            <div className="packs-hero__main">
              <button className="packs-hero__back" onClick={() => selectPack(null)} title="返回整合包列表">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <div className="packs-hero__cover">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                  <line x1="12" y1="22.08" x2="12" y2="12" />
                </svg>
              </div>
              <div className="packs-hero__id">
                <div className="packs-hero__row">
                  <h2 className="packs-hero__name">{selectedPack.name}</h2>
                  {packMods.length === 0 ? (
                    <span className="packs-pill packs-pill--empty"><i />空整合包</span>
                  ) : packStats.enabled === packMods.length ? (
                    <span className="packs-pill packs-pill--ok"><i />全部启用</span>
                  ) : packStats.enabled === 0 ? (
                    <span className="packs-pill packs-pill--off"><i />全部禁用</span>
                  ) : (
                    <span className="packs-pill packs-pill--partial"><i />部分启用</span>
                  )}
                </div>
                <div className="packs-hero__sub">
                  <span>{packMods.length} 个 Mod</span>
                  <span className="packs-hero__dot" />
                  <input
                    className="pack-detail-desc"
                    type="text"
                    placeholder="点击添加描述…"
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    onBlur={handleDescriptionBlur}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                    }}
                  />
                </div>
                <div className="packs-hero__chips">
                  <span className="packs-stat packs-stat--ok"><i />已启用 <b>{packStats.enabled}</b></span>
                  <span className="packs-stat packs-stat--off"><i />已禁用 <b>{packStats.disabled}</b></span>
                  <span className={`packs-stat packs-stat--warn${packStats.conflict === 0 ? ' packs-stat--zero' : ''}`}><i />冲突 <b>{packStats.conflict}</b></span>
                  {missingMembers.length > 0 && (
                    <span className="packs-stat packs-stat--missing"><i />失效 <b>{missingMembers.length}</b></span>
                  )}
                </div>
              </div>
            </div>
            <div className="packs-hero__side">
              <div className="packs-side-top">
                <label className="packs-switchline" title="勾选后，应用本包时会把本包以外的 Mod 一并关闭">
                  <input
                    type="checkbox"
                    className="packs-switchline__input"
                    checked={disableOthers}
                    onChange={(e) => setDisableOthers(e.target.checked)}
                  />
                  <span className="packs-switchline__track" />
                  同时关闭本包以外
                </label>
                <button
                  type="button"
                  className="packs-apply-btn"
                  onClick={handleApplyPack}
                  disabled={applyingPack || selectedPack.modNames.length === 0}
                  title={selectedPack.modNames.length === 0 ? '整合包为空' : '按本包目标启停恢复'}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M6 4l14 8-14 8V4z" />
                  </svg>
                  {applyingPack ? '应用中…' : '应用此整合包'}
                </button>
              </div>
              <div className="packs-side-tools">
                <button type="button" className="packs-iconbtn" onClick={handleUpdateSnapshot} title="从当前启停状态更新本包">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                </button>
                <button type="button" className="packs-iconbtn" title="添加 Mod 到整合包" onClick={openAddModsModal}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                <button type="button" className="packs-iconbtn" title="导出 ZIP" onClick={handleExport}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                </button>
                <div className="packs-seg">
                  <button
                    type="button"
                    className={`packs-seg__item${packMods.length > 0 && packStats.enabled === packMods.length ? ' packs-seg__item--on' : ''}`}
                    onClick={() => runPackBulk(true)}
                    disabled={togglingPack || selectedPack.modNames.length === 0}
                  >
                    全部启用
                  </button>
                  <button
                    type="button"
                    className={`packs-seg__item${packMods.length > 0 && packStats.enabled === 0 ? ' packs-seg__item--on' : ''}`}
                    onClick={() => runPackBulk(false)}
                    disabled={togglingPack || selectedPack.modNames.length === 0}
                  >
                    全部禁用
                  </button>
                </div>
              </div>
            </div>
          </div>

          {missingMembers.length > 0 && (
            <div className="pack-warn-bar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 9v4M12 17v0" strokeLinecap="round" />
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <span>
                <strong>{missingMembers.length}</strong> 个成员已失效（磁盘上已找不到对应文件）
              </span>
              <button type="button" className="pack-warn-bar__btn" onClick={handleCleanMissing}>
                清理失效成员
              </button>
            </div>
          )}
          
          {/* 包内 Mod 筛选：搜索 + 启用状态（口径和「我的 Mod」页面一致） */}
          <div className="packs-filterbar">
            <div className="packs-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                type="text"
                placeholder="在整合包内搜索 Mod..."
                value={packModSearch}
                onChange={(e) => setPackModSearch(e.target.value)}
              />
              {packModSearch && (
                <button className="packs-search__clear" title="清空" onClick={() => setPackModSearch('')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            <div className="packs-tabs">
              <button
                className={`packs-tab${packStatusFilter === 'all' ? ' packs-tab--active' : ''}`}
                onClick={() => setPackStatusFilter('all')}
              >
                全部 <b>{packStats.all}</b>
              </button>
              <button
                className={`packs-tab packs-tab--ok${packStatusFilter === 'enabled' ? ' packs-tab--active' : ''}`}
                onClick={() => setPackStatusFilter(packStatusFilter === 'enabled' ? 'all' : 'enabled')}
              >
                <i />已启用 <b>{packStats.enabled}</b>
              </button>
              <button
                className={`packs-tab packs-tab--off${packStatusFilter === 'disabled' ? ' packs-tab--active' : ''}`}
                onClick={() => setPackStatusFilter(packStatusFilter === 'disabled' ? 'all' : 'disabled')}
              >
                <i />已禁用 <b>{packStats.disabled}</b>
              </button>
              <button
                className={`packs-tab packs-tab--warn${packStatusFilter === 'conflict' ? ' packs-tab--active' : ''}`}
                onClick={() => setPackStatusFilter(packStatusFilter === 'conflict' ? 'all' : 'conflict')}
              >
                <i />冲突 <b>{packStats.conflict}</b>
              </button>
            </div>
            <div className="packs-filterbar__spacer" />
            <span className="packs-count">筛出 {filteredPackMods.length} / {packMods.length}</span>
          </div>

          <div className={`my-mods-grid pack-detail-grid ${viewMode === 'list' ? 'my-mods-grid--list' : ''}`}>
            {filteredPackMods.length > 0 ? (
              filteredPackMods.map((mod, index) => {
                const displayName = getModTitle(mod, getModDisplayName(mod.name));
                // 冲突只在「已启用」的 Mod 之间才有意义：禁用后立刻不再显示冲突
                const hasConflicts = mod.enabled && !!mod.conflicts && mod.conflicts.length > 0;
                // 该成员在本包里被记录为「目标禁用」（应用本包时会被关闭）
                const isTargetDisabled = disabledMemberKeys.has(normalizeModKey(mod.name));
                return (
                  <div
                    key={getStableModId(mod)}
                    className={`mod-card ${mod.is_workshop ? 'mod-card--workshop' : 'mod-card--custom'} ${mod.enabled ? 'mod-card--enabled' : 'mod-card--disabled'} ${hasConflicts ? 'mod-card--conflict' : ''}`}
                    onClick={() => handleToggleMod(mod.name)}
                    title={mod.enabled ? '点击禁用该 Mod' : '点击启用该 Mod'}
                    style={{ cursor: 'pointer', '--card-i': Math.min(index, 16) } as CSSProperties}
                  >
                    {hasConflicts && (
                      <div
                        className="mod-card__conflict-icon"
                        title={`冲突: ${mod.conflicts!.join(', ')}（点击查看详情）`}
                        onClick={(e) => {
                          // 必须阻止冒泡：否则点这个图标会顺手把整张卡片启用/禁用掉 ——
                          // 之前用户反馈的「点冲突按钮结果变成切换启停」就是这个原因。
                          e.stopPropagation();
                          setConflictSnapshot(mod.conflict_details ? [...mod.conflict_details] : []);
                          setConflictDialogMod(mod.name);
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14">
                          <path d="M12 7v6M12 17v0" stroke="white" strokeLinecap="round"/>
                        </svg>
                      </div>
                    )}
                    <ModPreview mod={mod} displayName={displayName} />
                    <div className="mod-card__info">
                      <div className="mod-card__info-header">
                        <span className="mod-card__name">{displayName}</span>
                        {viewMode === 'list' ? (
                          <ModSwitch
                            enabled={mod.enabled}
                            conflict={hasConflicts}
                            onToggle={() => handleToggleMod(mod.name)}
                          />
                        ) : (
                          <span className={`mod-card__status ${hasConflicts ? 'mod-card__status--conflict' : (mod.enabled ? 'mod-card__status--enabled' : 'mod-card__status--disabled')}`}>
                            {hasConflicts ? '冲突' : (mod.enabled ? '已启用' : '已禁用')}
                          </span>
                        )}
                      </div>
                      {isTargetDisabled && (
                        <span className="pack-member-flag" title="应用本包时该成员会被关闭">本包内关闭</span>
                      )}
                      {mod.author && <span className="mod-card__author">{mod.author}</span>}
                      {mod.description && (
                        <span className="mod-card__description">{mod.description}</span>
                      )}
                      <span className="mod-card__meta">{formatSize(mod.size_bytes, mod)}</span>
                      {mod.tags && mod.tags.length > 0 && (
                        <div className="mod-card__tags">
                          {orderCardTags(mod.tags).slice(0, 4).map((tag, idx) => (
                            <span
                              key={idx}
                              className={`mod-card__tag${isFineTag(tag) ? ' mod-card__tag--fine' : ''}${customTags.includes(tag) ? ' mod-card__tag--custom' : ''}${tag === FAVORITE_TAG ? ' mod-card__tag--fav' : ''}`}
                            >
                              {tag}
                            </span>
                          ))}
                          {mod.tags.length > 4 && (
                            <span
                              className="mod-card__tag mod-card__tag--more"
                              title={orderCardTags(mod.tags).slice(4).join(' / ')}
                            >
                              +{mod.tags.length - 4}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <button 
                      className={`mod-card__remove ${hasConflicts ? 'mod-card__remove--conflict' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveMod(mod.name);
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="my-mods-status">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="11" cy="11" r="8" />
                  <path d="M21 21l-4.35-4.35" />
                </svg>
                <span>{packMods.length === 0 ? '该整合包暂无 Mod' : '没有匹配筛选条件的 Mod'}</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={`my-mods-grid pack-list-grid ${viewMode === 'list' ? 'my-mods-grid--list' : ''}`}>
          {filtered.length > 0 ? (
            filtered.map((pack, index) => {
              const coverMod = getPackCoverMod(pack);
              const stats = deriveStats(pack);
              return (
                <div
                  key={pack.id}
                  className="mod-card pack-card"
                  onClick={() => handlePackClick(pack)}
                  onContextMenu={(e) => handleContextMenu(e, pack.id)}
                  style={{ cursor: 'pointer', '--card-i': Math.min(index, 16) } as CSSProperties}
                >
                  {coverMod ? (
                    <ModPreview mod={coverMod} displayName={getModTitle(coverMod, getModDisplayName(coverMod.name))} />
                  ) : (
                    <div className="mod-card__preview-container">
                      <div className="mod-card__preview">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
                          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                          <line x1="12" y1="22.08" x2="12" y2="12" />
                        </svg>
                      </div>
                    </div>
                  )}
                  <div className="mod-card__info">
                    <div className="mod-card__info-header">
                      <span className="mod-card__name">{pack.name}</span>
                    </div>
                    <span className="mod-card__meta">
                      {stats.total} 个 Mod
                    </span>
                    {pack.description && <span className="mod-card__desc" title={pack.description}>{pack.description}</span>}
                    <div className="pack-card__badges">
                      <span className="pack-badge pack-badge--enabled">启用 {stats.enabled}/{stats.present}</span>
                      {stats.conflict > 0 && (
                        <span className="pack-badge pack-badge--conflict">⚠冲突 {stats.conflict}</span>
                      )}
                      {stats.missing > 0 && (
                        <span className="pack-badge pack-badge--missing">⚠失效 {stats.missing}</span>
                      )}
                    </div>
                    {pack.createdAt && (
                      // 不再用 opacity 弱化：半透明文字与背景混合后会发虚，
                      // 直接沿用 .mod-card__meta 的 --text-muted 颜色即可
                      <span className="mod-card__meta" style={{ fontSize: '12px' }}>
                        {new Date(pack.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {pack.modNames.length > 0 && (
                      <div className="mod-card__tags" style={{ marginTop: '4px' }}>
                        {pack.modNames.slice(0, 3).map((mname, idx) => {
                          const m = modsByKey.get(normalizeModKey(mname));
                          return (
                            <span key={idx} className="mod-card__tag" title={mname}>
                              {m ? getModTitle(m, getModDisplayName(m.name)) : mname}
                            </span>
                          );
                        })}
                        {pack.modNames.length > 3 && (
                          <span className="mod-card__tag mod-card__tag--more">+{pack.modNames.length - 3}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="my-mods-status">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <span>暂无整合包，点击上方按钮创建</span>
            </div>
          )}
        </div>
      )}

      {conflictDialogMod && (
        <ConflictDialog
          ownerName={conflictDialogMod}
          owner={mods.find((m) => m.name === conflictDialogMod)}
          details={conflictSnapshot}
          hints={mods.find((m) => m.name === conflictDialogMod)?.conflict_hints || []}
          mods={mods}
          titleOf={(m) => getModTitle(m, getModDisplayName(m.name))}
          getDisplayName={getModDisplayName}
          resolveUrl={resolveUrl}
          onClose={() => { setConflictDialogMod(null); setConflictSnapshot([]); }}
          onToggleMod={(name, path) => toggleMod(name, path)}
        />
      )}

      {showAddModsModal && selectedPack && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowAddModsModal(false);
            setSelectedAddMods(new Set());
          }}
        >
          <div className="modal-content modal-content--wide" ref={addModsModalRef} onClick={(e) => e.stopPropagation()}>
            <h3>添加 Mod 到「{selectedPack.name}」</h3>
            <input
              type="text"
              className="modal-input"
              placeholder="搜索 Mod..."
              value={addModsSearch}
              onChange={(e) => setAddModsSearch(e.target.value)}
              autoFocus
            />
            <div className="add-mods-list">
              {addableMods.length === 0 ? (
                <div className="add-mods-empty">
                  {mods.length === 0 ? '还没有扫描到任何 Mod' : '没有可添加的 Mod'}
                </div>
              ) : (
                addableMods.map((mod) => {
                  const displayName = getModTitle(mod, getModDisplayName(mod.name));
                  const checked = selectedAddMods.has(mod.name);
                  return (
                    <label
                      key={getStableModId(mod)}
                      className={`add-mods-item${checked ? ' add-mods-item--checked' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAddSelection(mod.name)}
                      />
                      <span className="add-mods-item__name" title={displayName}>{displayName}</span>
                      <span className="add-mods-item__tag">{mod.is_workshop ? '工坊' : '外部'}</span>
                    </label>
                  );
                })
              )}
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn modal-btn-cancel"
                onClick={() => {
                  setShowAddModsModal(false);
                  setSelectedAddMods(new Set());
                }}
              >
                取消
              </button>
              <button
                className="modal-btn modal-btn-primary"
                disabled={selectedAddMods.size === 0}
                onClick={handleAddModsConfirm}
              >
                添加{selectedAddMods.size > 0 ? `（${selectedAddMods.size}）` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {showImportModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (importing) return;
            setShowImportModal(false);
          }}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>导入已启用 Mod</h3>
            <p className="packs-import-hint">
              将当前已启用的 <strong>{enabledMods.length}</strong> 个 Mod 归入一个新整合包。
              只做归集，<strong>不会改动</strong>这些 Mod 的启用状态；已禁用的 Mod 不包含在内。
            </p>
            <input
              type="text"
              className="modal-input"
              placeholder="输入整合包名称..."
              value={importPackName}
              onChange={(e) => setImportPackName(e.target.value)}
              autoFocus
              onFocus={(e) => e.target.select()}
              disabled={importing}
              onKeyDown={(e) => e.key === 'Enter' && handleImportEnabled()}
            />
            <label className="pack-modal-opt">
              <input
                type="checkbox"
                checked={saveSnapshot}
                onChange={(e) => setSaveSnapshot(e.target.checked)}
                disabled={importing}
              />
              保存当前启停状态
            </label>
            <div className="modal-actions">
              <button
                className="modal-btn modal-btn-cancel"
                disabled={importing}
                onClick={() => setShowImportModal(false)}
              >
                取消
              </button>
              <button
                className="modal-btn modal-btn-primary"
                disabled={!importPackName.trim() || importing}
                onClick={handleImportEnabled}
              >
                {importing ? '创建中…' : `创建（${enabledMods.length} 个 Mod）`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" ref={createModalRef} onClick={(e) => e.stopPropagation()}>
            <h3>新建整合包</h3>
            <input
              type="text"
              className="modal-input"
              placeholder="输入整合包名称..."
              value={newPackName}
              onChange={(e) => setNewPackName(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreatePack()}
            />
            <label className="pack-modal-opt">
              <input
                type="checkbox"
                checked={saveSnapshot}
                onChange={(e) => setSaveSnapshot(e.target.checked)}
              />
              保存当前启停状态
            </label>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setShowCreateModal(false)}>
                取消
              </button>
              <button className="modal-btn modal-btn-primary" onClick={handleCreatePack}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {renamePackId && (
        <div className="modal-overlay" onClick={() => { setRenamePackId(null); setRenameValue(''); }}>
          <div className="modal-content" ref={renameModalRef} onClick={(e) => e.stopPropagation()}>
            <h3>重命名整合包</h3>
            <input
              type="text"
              className="modal-input"
              placeholder="输入新名称..."
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleRenameSubmit()}
            />
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => { setRenamePackId(null); setRenameValue(''); }}>
                取消
              </button>
              <button className="modal-btn modal-btn-primary" onClick={handleRenameSubmit}>
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      {packContextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="context-menu show"
          style={{ left: packContextMenu.x, top: packContextMenu.y }}
        >
          <div className="context-menu__header">
            <span>操作</span>
          </div>
          <button
            className="context-menu__item"
            onClick={() => {
              const pack = packs.find(p => p.id === packContextMenu.packId);
              if (pack) {
                setRenameValue(pack.name);
                setRenamePackId(packContextMenu.packId);
              }
              setPackContextMenu(null);
            }}
          >
            ✏️ 重命名
          </button>
          <button
            className="context-menu__item context-menu__item--danger"
            onClick={() => {
              setDeleteConfirmPackId(packContextMenu.packId);
              setPackContextMenu(null);
            }}
          >
            🗑️ 删除
          </button>
        </div>,
        document.body
      )}

      {deleteConfirmPackId && (
        <div className="modal-overlay" onClick={() => setDeleteConfirmPackId(null)}>
          <div className="modal-content" ref={deleteModalRef} onClick={(e) => e.stopPropagation()}>
            <h3>确认删除</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '16px' }}>
              确定要删除该整合包吗？
              <br />
              此操作不可撤销。
            </p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setDeleteConfirmPackId(null)}>
                取消
              </button>
              <button 
                className="modal-btn modal-btn-danger" 
                onClick={() => {
                  handleDeletePack(deleteConfirmPackId);
                  setDeleteConfirmPackId(null);
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
