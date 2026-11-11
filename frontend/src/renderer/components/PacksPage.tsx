import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStore, getApiBase, normalizeModKey, PackData, ModData } from '../store/useStore';
import { ToolBar } from './ToolBar';
import { showToast } from './Toast';
import { ThumbImage } from './ThumbImage';
import { isCampaignMod } from '../utils/modRole';
import { ModSwitch } from './ModSwitch';
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
  options?: IntersectionObserverInit
): [React.RefCallback<HTMLDivElement>, boolean] {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const callbackRef = useCallback((node: HTMLDivElement | null) => {
    elementRef.current = node;
  }, []);

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;
    
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px', threshold: 0, ...options }
    );
    
    observer.observe(el);
    return () => observer.disconnect();
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="9" cy="9" r="2" />
            <path d="M21 15l-4-4-6 6-3-3-5 5" />
          </svg>
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
    packContextMenu,
    setPackContextMenu,
    getModDisplayName,
    refreshAll,
  } = useStore();
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
  const [renamePackId, setRenamePackId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmPackId, setDeleteConfirmPackId] = useState<string | null>(null);
  // 「添加 Mod」弹窗
  const [showAddModsModal, setShowAddModsModal] = useState(false);
  const [addModsSearch, setAddModsSearch] = useState('');
  const [selectedAddMods, setSelectedAddMods] = useState<Set<string>>(new Set());
  const [togglingPack, setTogglingPack] = useState(false);
  // 连点「启用/禁用」时：记一个「结束后再切换一次」的标记（方向由后端决定，无需前端记目标值）
  const queuedPackAgainRef = useRef(false);
  // 冲突详情弹窗
  const [conflictDialogMod, setConflictDialogMod] = useState<string | null>(null);
  const [conflictSnapshot, setConflictSnapshot] = useState<string[]>([]);
  const contextMenuRef = useRef<HTMLDivElement>(null);

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

  const handleCreatePack = () => {
    if (newPackName.trim()) {
      createPack(newPackName.trim());
      setNewPackName('');
      setShowCreateModal(false);
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

  const getPackCoverMod = useCallback((pack: PackData): ModData | null => {
    if (pack.modNames.length === 0) return null;
    // 从后往前找最后一个「仍然存在」的 Mod 作为封面：
    // 直接取最后一个时，一旦它被删除，整张卡片就再没有封面了
    for (let i = pack.modNames.length - 1; i >= 0; i -= 1) {
      const found = mods.find((m) => m.name === pack.modNames[i]);
      if (found) return found;
    }
    return null;
  }, [mods]);

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

  // 整包「启用/禁用」开关：由包内 Mod 的真实状态推导。
  // 以前是本地 useState(true)，打开一个 Mod 全是禁用状态的整合包也会显示成「启用」。
  const toggleOn = packMods.length > 0 && packMods.every((m) => m.enabled);

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

  const runPackToggle = async (packId: string) => {
    setTogglingPack(true);
    try {
      // 不传方向：由后端按成员的真实状态决定（前端不再自己猜，避免算错导致「点了没反应」）
      const result = await enablePackMods(packId);
      if (result === null) {
        showToast('整合包切换失败', 'error');
      } else {
        const label = result.enable ? '启用' : '禁用';
        if (result.missing.length > 0) {
          showToast(
            `已${label} ${result.changed} 个，另有 ${result.missing.length} 个成员在磁盘上找不到对应文件`,
            'warning'
          );
        } else {
          showToast(`已${label}整合包中的 ${result.changed} 个 Mod`, 'success');
        }
      }
    } finally {
      setTogglingPack(false);
    }
  };

  const handleTogglePack = async () => {
    // 注意：不能用 packMods.length 判断空包 —— mods 列表还没加载完时会被误判成「空包」。
    // 这里只看整合包自己的成员数量，并且给用户明确反馈（不再静默 return）。
    if (!selectedPack) return;
    if (selectedPack.modNames.length === 0) {
      showToast('这个整合包里还没有 Mod', 'warning');
      return;
    }
    const packId = selectedPack.id;

    if (togglingPack) {
      // 正在执行中再次点击：打标记，等当前这次结束再切换一轮（连点不会丢操作）
      queuedPackAgainRef.current = true;
      return;
    }

    await runPackToggle(packId);

    if (queuedPackAgainRef.current) {
      queuedPackAgainRef.current = false;
      await runPackToggle(packId);
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
      
      <div className="packs-header">
        <h2 className="packs-title">整合包列表</h2>
        <button className="packs-create-btn" onClick={() => setShowCreateModal(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建整合包
        </button>
      </div>

      {selectedPack ? (
        <div className="pack-detail">
          <div className="pack-detail-header">
            <button className="pack-detail-back" onClick={() => selectPack(null)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="pack-detail-info">
              <h3>{selectedPack.name}</h3>
              <span>
                {packMods.length} 个 Mod
                {filteredPackMods.length !== packMods.length && ` · 已筛出 ${filteredPackMods.length} 个`}
              </span>
            </div>
            <button
              className="pack-detail-action"
              title="添加 Mod 到整合包"
              onClick={openAddModsModal}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
              <button 
                className="pack-detail-action pack-detail-action--export"
                title="导出 ZIP"
                onClick={handleExport}
              >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
            </button>
            <div 
              className={`pack-detail-toggle ${toggleOn ? 'pack-detail-toggle--on' : 'pack-detail-toggle--off'}${togglingPack ? ' pack-detail-toggle--busy' : ''}`}
              onClick={handleTogglePack}
              title={packMods.length === 0 ? '整合包为空' : (toggleOn ? '点击禁用全部' : '点击启用全部')}
            >
              <div className="pack-detail-toggle__track">
                <span className="pack-detail-toggle__label pack-detail-toggle__label--on">启用</span>
                <span className="pack-detail-toggle__label pack-detail-toggle__label--off">禁用</span>
                <div className="pack-detail-toggle__thumb" />
              </div>
            </div>
          </div>
          
          {/* 包内 Mod 筛选：搜索 + 启用状态（口径和「我的 Mod」页面一致） */}
          <div className="pack-filters">
            <div className="pack-filters__search">
              <svg className="pack-filters__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                type="text"
                className="pack-filters__input"
                placeholder="在整合包内搜索 Mod..."
                value={packModSearch}
                onChange={(e) => setPackModSearch(e.target.value)}
              />
              {packModSearch && (
                <button className="pack-filters__clear" title="清空" onClick={() => setPackModSearch('')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            <div className="pack-filters__tabs">
              <button
                className={`pack-filters__tab ${packStatusFilter === 'all' ? 'active' : ''}`}
                onClick={() => setPackStatusFilter('all')}
              >
                全部
                <span className="pack-filters__count">{packStats.all}</span>
              </button>
              <button
                className={`pack-filters__tab pack-filters__tab--enabled ${packStatusFilter === 'enabled' ? 'active' : ''}`}
                onClick={() => setPackStatusFilter(packStatusFilter === 'enabled' ? 'all' : 'enabled')}
              >
                ✅ 已启用
                <span className="pack-filters__count">{packStats.enabled}</span>
              </button>
              <button
                className={`pack-filters__tab pack-filters__tab--disabled ${packStatusFilter === 'disabled' ? 'active' : ''}`}
                onClick={() => setPackStatusFilter(packStatusFilter === 'disabled' ? 'all' : 'disabled')}
              >
                🚫 已禁用
                <span className="pack-filters__count">{packStats.disabled}</span>
              </button>
              <button
                className={`pack-filters__tab pack-filters__tab--conflict ${packStatusFilter === 'conflict' ? 'active' : ''}`}
                onClick={() => setPackStatusFilter(packStatusFilter === 'conflict' ? 'all' : 'conflict')}
              >
                ⚠️ 冲突
                <span className="pack-filters__count">{packStats.conflict}</span>
              </button>
            </div>
          </div>

          <div className={`my-mods-grid pack-detail-grid ${viewMode === 'list' ? 'my-mods-grid--list' : ''}`}>
            {filteredPackMods.length > 0 ? (
              filteredPackMods.map((mod, index) => {
                const displayName = getModTitle(mod, getModDisplayName(mod.name));
                // 冲突只在「已启用」的 Mod 之间才有意义：禁用后立刻不再显示冲突
                const hasConflicts = mod.enabled && !!mod.conflicts && mod.conflicts.length > 0;
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
                          setConflictSnapshot([...(mod.conflicts || [])]);
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
                      {mod.author && <span className="mod-card__author">{mod.author}</span>}
                      {mod.description && (
                        <span className="mod-card__description">{mod.description}</span>
                      )}
                      <span className="mod-card__meta">{formatSize(mod.size_bytes, mod)}</span>
                      {mod.tags && mod.tags.length > 0 && (
                        <div className="mod-card__tags">
                          {mod.tags.slice(0, 3).map((tag, idx) => (
                            <span key={idx} className="mod-card__tag">{tag}</span>
                          ))}
                          {mod.tags.length > 3 && (
                            <span className="mod-card__tag mod-card__tag--more">+{mod.tags.length - 3}</span>
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
                    <span className="mod-card__meta">{pack.modNames.length} 个 Mod</span>
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
                          const m = mods.find(mod => mod.name === mname);
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

      {conflictDialogMod && createPortal(
        <div
          className="modal-overlay"
          onClick={() => {
            setConflictDialogMod(null);
            setConflictSnapshot([]);
          }}
        >
          <div className="conflict-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="conflict-dialog__header">
              <h3>冲突 Mod 详情</h3>
              <button
                className="conflict-dialog__close"
                onClick={() => {
                  setConflictDialogMod(null);
                  setConflictSnapshot([]);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="conflict-dialog__subheader">
              以下 Mod 与{' '}
              <strong>
                {getModTitle(
                  mods.find((m) => m.name === conflictDialogMod) || { name: conflictDialogMod },
                  getModDisplayName(conflictDialogMod)
                )}
              </strong>{' '}
              存在冲突
            </div>
            <div className="conflict-dialog__grid">
              {conflictSnapshot.map((cname) => {
                const conflictMod = mods.find((m) => m.name === cname);
                if (!conflictMod) return null;
                const conflictDisplayName = getModTitle(conflictMod, getModDisplayName(conflictMod.name));
                return (
                  <div
                    key={cname}
                    className={`conflict-card ${conflictMod.enabled ? 'conflict-card--enabled' : 'conflict-card--disabled'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleMod(conflictMod.name);
                    }}
                  >
                    <div className="conflict-card__thumb">
                      {resolveUrl(conflictMod.thumbnail_url) ? (
                        <ThumbImage
                          src={resolveUrl(conflictMod.thumbnail_url)!}
                          alt={conflictDisplayName}
                          className="conflict-card__img"
                          maxWidth={96}
                          maxHeight={96}
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <rect x="3" y="3" width="18" height="18" rx="3" />
                          <circle cx="9" cy="9" r="2" />
                          <path d="M21 15l-4-4-6 6-3-3-5 5" />
                        </svg>
                      )}
                    </div>
                    <div className="conflict-card__info">
                      <span className="conflict-card__name">{conflictDisplayName}</span>
                      <span className={`conflict-card__status ${conflictMod.enabled ? 'conflict-card__status--enabled' : 'conflict-card__status--disabled'}`}>
                        {conflictMod.enabled ? '已启用' : '已禁用'}
                      </span>
                    </div>
                    <div className="conflict-card__toggle">
                      <div className={`conflict-toggle ${conflictMod.enabled ? 'conflict-toggle--on' : 'conflict-toggle--off'}`}>
                        <div className="conflict-toggle__thumb" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="conflict-dialog__footer">
              <span className="conflict-dialog__hint">点击卡片可切换启用/禁用状态</span>
              <button
                className="modal-btn modal-btn-cancel"
                onClick={() => {
                  setConflictDialogMod(null);
                  setConflictSnapshot([]);
                }}
              >
                关闭
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showAddModsModal && selectedPack && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowAddModsModal(false);
            setSelectedAddMods(new Set());
          }}
        >
          <div className="modal-content modal-content--wide" onClick={(e) => e.stopPropagation()}>
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

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
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
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
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
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
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
