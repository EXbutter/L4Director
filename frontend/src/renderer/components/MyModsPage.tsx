import { useState, useMemo, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStore, getApiBase, ModData, ConflictDetail } from '../store/useStore';
import { ToolBar } from './ToolBar';
import { ThumbImage } from './ThumbImage';
import { ModSwitch } from './ModSwitch';
import './ContentArea.scss';
import './MyModsPage.scss';

/// ── Virtualized list constants ──
const ITEM_HEIGHT = 120;        // approximate card height in px
const OVERSCAN_ITEMS = 10;      // extra items to render above/below viewport
const SCROLL_THROTTLE_MS = 80;  // throttle scroll handler

// Load dismissed-conflicts set from localStorage
function loadDismissedConflicts(): Set<string> {
  try {
    const raw = localStorage.getItem('l4d2-dismissed-conflicts');
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function saveDismissedConflicts(set: Set<string>) {
  localStorage.setItem('l4d2-dismissed-conflicts', JSON.stringify([...set]));
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);
  return `${size} ${units[i]}`;
}

function getModTitle(mod: { vpk_title?: string | null; display_name?: string; name: string }, customName?: string | null): string {
  if (customName) return customName;
  return mod.vpk_title || mod.display_name || mod.name;
}

function getStableModId(mod: ModData): string {
  return `mod-${mod.name}`;
}

const sortOptions = [
  { value: 'name-asc', label: '名称 A-Z' },
  { value: 'name-desc', label: '名称 Z-A' },
  { value: 'size-desc', label: '大小 ↓' },
  { value: 'size-asc', label: '大小 ↑' },
];

function resolveUrl(url: string | null): string | null {
  if (!url) return null;
  // Backend returns relative URLs like /api/thumbnail?... or /api/thumbnail/workshop/...
  // In dev mode (http://localhost:5173) relative URLs work fine
  // In Electron packed mode (file://) we need to prepend the backend base URL
  // （用 getApiBase() 而不是写死端口：8288 被占用时主进程会切换到备用端口）
  if (url.startsWith('/api/')) {
    return `${getApiBase()}${url}`;
  }
  return url;
}

function useIntersectionObserver(
  options?: IntersectionObserverInit
): [React.RefCallback<HTMLDivElement>, boolean] {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Use a callback ref so React calls it with the DOM element directly
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


function ModPreview({ mod, displayName }: { mod: ModData; displayName: string }) {
  const [imgError, setImgError] = useState(false);
  const [containerRef, isVisible] = useIntersectionObserver();
  
  // Reset error state when mod changes
  useEffect(() => {
    setImgError(false);
  }, [mod.thumbnail_url]);

  const imgSrc = resolveUrl(mod.thumbnail_url);

  return (
    <div ref={containerRef} className="mod-card__preview-container">
      {imgSrc && !imgError && isVisible ? (
        <div className="mod-card__preview mod-card__preview--image">
          {/* 超大图 / 伪装成 .jpg 的 GIF 动图会在这里被转成静态小图，
              否则滚到该卡片时帧率会掉到个位数 */}
          <ThumbImage
            src={imgSrc}
            alt={displayName}
            className="mod-card__thumbnail"
            onError={() => setImgError(true)}
          />
        </div>
      ) : (
        <div className="mod-card__preview">
          {isVisible ? null : null /* placeholder (still shows the SVG) */}
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

/**
 * 分类列表（与后端 CATEGORIES 保持一致，顺序即界面顺序）。
 * 自动检测会按 VPK 内容命中多个分类 —— 所以一个 Mod 可以同时有多个标签；
 * 右键卡片可以逐个增删这些标签，或恢复成自动检测。
 */
const VPK_CATEGORIES = [
  '战役',
  '杂项',
  '音效',
  '武器',
  '被感染者',
  '突变模式',
  '生还者',
  '物品',
  '脚本',
  '游戏界面',
  '皮肤',
] as const;

export type VpkCategory = typeof VPK_CATEGORIES[number];

export function MyModsPage() {
  const { mods, packs, fetchMods, refreshAll, loading, scanning, scanProgress, toggleMod, addModToPack, addModsToPack, setContextMenu, contextMenu, deleteMod, deleteConfirmMod, setDeleteConfirmMod, confirmDeleteMod, renameModDisplayName, getModDisplayName, setModCategory, setModTags } = useStore();
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('name-asc');
  // 排版：卡片墙 / 单列列表（记在 localStorage，重启后保持上次选择）
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem('l4d2-mods-view') === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const changeViewMode = useCallback((mode: 'grid' | 'list') => {
    setViewMode(mode);
    try {
      localStorage.setItem('l4d2-mods-view', mode);
    } catch {
      /* 隐私模式等场景下写不进去，忽略即可 */
    }
  }, []);
  const [category, setCategory] = useState<'all' | 'custom' | 'workshop'>('all');
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [conflictFilter, setConflictFilter] = useState<'all' | 'conflict' | 'no-conflict'>('all');
  const [vpkCategory, setVpkCategory] = useState<string | null>(null);
  const [renameModName, setRenameModName] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const categoryTriggerRef = useRef<HTMLDivElement>(null);
  const packTriggerRef = useRef<HTMLDivElement>(null);
  const batchCategoryTriggerRef = useRef<HTMLDivElement>(null);
  const batchPackTriggerRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<'category' | 'pack' | 'batch-category' | 'batch-pack' | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number; onLeft?: boolean } | null>(null);
  const [batchSubmenuOnLeft, setBatchSubmenuOnLeft] = useState(false);
  const [batchCategoryOffset, setBatchCategoryOffset] = useState(0);
  const [batchPackOffset, setBatchPackOffset] = useState(0);
  const submenuTimerRef = useRef<number | null>(null);
  // dismissed conflicts: set of mod names whose conflict warnings we hide
  const [dismissedConflicts, setDismissedConflicts] = useState<Set<string>>(loadDismissedConflicts);
  // Batch selection: set of selected mod names
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set());
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  // Conflict tooltip: which mod's conflicts to show in hover tooltip, + position
  const [conflictTooltip, setConflictTooltip] = useState<{ modName: string; x: number; y: number } | null>(null);
  // Conflict dialog: which mod to show conflict details for (null = closed)
  const [conflictDialogMod, setConflictDialogMod] = useState<string | null>(null);
  // Snapshot of conflicts when dialog opens - prevents list from updating during interaction
  const [conflictSnapshot, setConflictSnapshot] = useState<ConflictDetail[]>([]);
  const [hintSnapshot, setHintSnapshot] = useState<ConflictDetail[]>([]);

  useEffect(() => {
    // 仅当尚无数据时才自动拉取；后端连接后由 App 统一触发首次扫描
    if (useStore.getState().mods.length === 0) {
      fetchMods();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
        setActiveSubmenu(null);
        setSubmenuPos(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close submenu when context menu closes
  useEffect(() => {
    if (!contextMenu) {
      setActiveSubmenu(null);
      setSubmenuPos(null);
    }
  }, [contextMenu]);

  const counts = useMemo(() => ({
    custom: mods.filter((m) => !m.is_workshop).length,
    workshop: mods.filter((m) => m.is_workshop).length,
  }), [mods]);

  const vpkCategoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const cat of VPK_CATEGORIES) {
      counts[cat] = mods.filter((m) => m.tags.includes(cat)).length;
    }
    return counts;
  }, [mods]);

  const combinedCategoryKey = useMemo(() => `${category}-${vpkCategory || 'all'}-${enabledFilter}-${conflictFilter}`, [category, vpkCategory, enabledFilter, conflictFilter]);

  const enabledCounts = useMemo(() => ({
    enabled: mods.filter((m) => m.enabled).length,
    disabled: mods.filter((m) => !m.enabled).length,
  }), [mods]);

  const filtered = useMemo(() => {
    let list = [...mods];

    if (category === 'custom') {
      list = list.filter((m) => !m.is_workshop);
    } else if (category === 'workshop') {
      list = list.filter((m) => m.is_workshop);
    }

    if (vpkCategory) {
      list = list.filter((m) => m.tags.includes(vpkCategory));
    }

    if (enabledFilter === 'enabled') {
      list = list.filter((m) => m.enabled);
    } else if (enabledFilter === 'disabled') {
      list = list.filter((m) => !m.enabled);
    }

    if (conflictFilter === 'conflict') {
      // 冲突只对「已启用」的 Mod 有意义：禁用的 Mod 不该出现在冲突筛选里
      list = list.filter((m) => m.enabled && m.conflicts && m.conflicts.length > 0);
    } else if (conflictFilter === 'no-conflict') {
      list = list.filter((m) => !m.enabled || !m.conflicts || m.conflicts.length === 0);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (m) => getModTitle(m).toLowerCase().includes(q)
      );
    }

    switch (sortBy) {
      case 'name-asc':
        list.sort((a, b) => getModTitle(a).localeCompare(getModTitle(b)));
        break;
      case 'name-desc':
        list.sort((a, b) => getModTitle(b).localeCompare(getModTitle(a)));
        break;
      case 'size-desc':
        list.sort((a, b) => b.size_bytes - a.size_bytes);
        break;
      case 'size-asc':
        list.sort((a, b) => a.size_bytes - b.size_bytes);
        break;
    }

    return list;
  }, [search, sortBy, mods, category, vpkCategory, enabledFilter, conflictFilter]);

  const handleCardClick = (e: React.MouseEvent, modName: string) => {
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      setSelectedMods((prev) => {
        const next = new Set(prev);
        if (next.has(modName)) {
          next.delete(modName);
        } else {
          next.add(modName);
        }
        return next;
      });
    } else {
      // Clear selection if clicking without Ctrl
      if (selectedMods.size > 0) {
        setSelectedMods(new Set());
      }
      toggleMod(modName);
    }
  };

  const getCustomName = useCallback((modName: string) => {
    return getModDisplayName(modName);
  }, [getModDisplayName]);

  const handleContextMenu = (e: React.MouseEvent, modName: string) => {
    e.preventDefault();
    const menuW = selectedMods.size > 0 ? 240 : 210;
    const menuH = selectedMods.size > 0 ? 260 : 220;
    let x = Math.min(e.clientX, window.innerWidth - menuW - 10);
    let y = Math.min(e.clientY, window.innerHeight - menuH - 10);
    if (x < 10) x = 10;
    if (y < 10) y = 10;
    // Make sure the right-clicked mod is in the selection
    if (selectedMods.size > 0 && !selectedMods.has(modName)) {
      // If right-clicking an unselected mod while others are selected, select only this one
      setSelectedMods(new Set([modName]));
    }
    setContextMenu({ x, y, modName });
  };

  const handleRenameSubmit = () => {
    if (renameModName && renameValue.trim()) {
      renameModDisplayName(renameModName, renameValue.trim());
      setRenameModName(null);
      setRenameValue('');
      setContextMenu(null);
    }
  };

  const handleAddToPack = (packId: string) => {
    if (contextMenu) {
      addModToPack(contextMenu.modName, packId);
      setContextMenu(null);
    }
  };

  const [submenuOnLeft, setSubmenuOnLeft] = useState(false);
  const [categoryOffset, setCategoryOffset] = useState(0);
  const [packOffset, setPackOffset] = useState(0);
  // 「分类标签」子菜单的垂直夹紧用：原始偏移 + 实测高度
  const categoryBaseOffsetRef = useRef(0);
  const categorySubmenuBoxRef = useRef<HTMLDivElement>(null);

  const openSubmenu = (type: 'category' | 'pack') => {
    if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current);
    const triggerRef = type === 'category' ? categoryTriggerRef : packTriggerRef;
    if (triggerRef.current && contextMenuRef.current) {
      const parentRect = contextMenuRef.current.getBoundingClientRect();
      const subW = 200;
      // Check if right side has enough space
      const onLeft = (parentRect.right + subW > window.innerWidth - 5);
      setSubmenuOnLeft(onLeft);
      
      // Use offsetTop for pixel-perfect vertical alignment within parent
      const offset = triggerRef.current.offsetTop;
      if (type === 'category') {
        categoryBaseOffsetRef.current = offset;
        setCategoryOffset(offset);
      } else {
        setPackOffset(offset);
      }
    }
    setActiveSubmenu(type);
  };

  /**
   * 「分类标签」子菜单很长（说明 + 11 个分类 + 恢复项）：卡片贴近窗口底部时，
   * 它会伸出窗口、下面的选项点不到。这里量一次真实高度，把整块移回视口内
   * （配合 SCSS 里的 max-height + 内部滚动做双保险）。
   */
  useLayoutEffect(() => {
    if (activeSubmenu !== 'category') return;
    const box = categorySubmenuBoxRef.current;
    const menu = contextMenuRef.current;
    if (!box || !menu) return;

    const margin = 8;
    const menuTop = menu.getBoundingClientRect().top;
    // 用 offsetHeight 而不是 getBoundingClientRect().height：
    // 入场动画带 scale，rect 高度会被缩放，量出来偏小
    const boxHeight = box.offsetHeight;
    const base = categoryBaseOffsetRef.current;

    let offset = base;
    const maxOffset = window.innerHeight - margin - boxHeight - menuTop;
    if (offset > maxOffset) offset = maxOffset;                       // 下方放不下 → 上移
    if (menuTop + offset < margin) offset = margin - menuTop;         // 上移过头 → 压回顶部
    if (offset !== base) setCategoryOffset(offset);
  }, [activeSubmenu, contextMenu]);

  const closeSubmenuDelayed = () => {
    if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current);
    submenuTimerRef.current = window.setTimeout(() => {
      setActiveSubmenu(null);
      setSubmenuPos(null);
    }, 120);
  };

  const keepSubmenu = () => {
    if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current);
  };

  // Open conflict dialog and save snapshot
  const openConflictDialog = (modName: string) => {
    const mod = mods.find(m => m.name === modName);
    setConflictSnapshot(mod?.conflict_details ? [...mod.conflict_details] : []);
    setHintSnapshot(mod?.conflict_hints ? [...mod.conflict_hints] : []);
    setConflictDialogMod(modName);
  };

  // Close conflict dialog, clear snapshot, and refresh data
  const closeConflictDialog = () => {
    setConflictDialogMod(null);
    setConflictSnapshot([]);
    setHintSnapshot([]);
    fetchMods();
  };

  return (
    <div className="content-area">
      <ToolBar
        searchPlaceholder="搜索 Mod..."
        sortOptions={sortOptions}
        defaultSort="name-asc"
        onSearchChange={setSearch}
        onSortChange={setSortBy}
        onRefresh={refreshAll}
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
      />

      <div className="mod-categories">
        <button
          className={`mod-categories__tab ${category === 'all' ? 'active' : ''}`}
          onClick={() => setCategory('all')}
        >
          全部
          <span className="mod-categories__count">{mods.length}</span>
        </button>
        <button
          className={`mod-categories__tab ${category === 'custom' ? 'active' : ''}`}
          onClick={() => setCategory('custom')}
        >
          自定义 Mod
          <span className="mod-categories__count">{counts.custom}</span>
        </button>
        <button
          className={`mod-categories__tab ${category === 'workshop' ? 'active' : ''}`}
          onClick={() => setCategory('workshop')}
        >
          创意工坊 Mod
          <span className="mod-categories__count">{counts.workshop}</span>
        </button>
      </div>

      <div className="vpk-categories">
        <div className="vpk-categories__left">
          <button
            className={`vpk-categories__tab ${!vpkCategory ? 'active' : ''}`}
            onClick={() => setVpkCategory(null)}
          >
            所有类型
          </button>
          {VPK_CATEGORIES.map((cat) => (
            <button
              key={cat}
              data-category={cat}
              className={`vpk-categories__tab ${vpkCategory === cat ? 'active' : ''}`}
              onClick={() => setVpkCategory(vpkCategory === cat ? null : cat)}
            >
              {cat}
              {vpkCategoryCounts[cat] > 0 && (
                <span className="vpk-categories__count">{vpkCategoryCounts[cat]}</span>
              )}
            </button>
          ))}
        </div>
        <div className="vpk-categories__right">
          <span className="vpk-categories__divider" />
          <button
            className={`vpk-categories__tab vpk-categories__tab--enabled ${enabledFilter === 'enabled' ? 'active' : ''}`}
            onClick={() => setEnabledFilter(enabledFilter === 'enabled' ? 'all' : 'enabled')}
          >
            ✅ 已启用
            <span className="vpk-categories__count">{enabledCounts.enabled}</span>
          </button>
          <button
            className={`vpk-categories__tab vpk-categories__tab--disabled ${enabledFilter === 'disabled' ? 'active' : ''}`}
            onClick={() => setEnabledFilter(enabledFilter === 'disabled' ? 'all' : 'disabled')}
          >
            🚫 已禁用
            <span className="vpk-categories__count">{enabledCounts.disabled}</span>
          </button>
          <span className="vpk-categories__divider" />
          <button
            className={`vpk-categories__tab vpk-categories__tab--conflict ${conflictFilter === 'conflict' ? 'active' : ''}`}
            onClick={() => setConflictFilter(conflictFilter === 'conflict' ? 'all' : 'conflict')}
          >
            ⚠️ 冲突
            <span className="vpk-categories__count">{mods.filter(m => m.enabled && m.conflicts && m.conflicts.length > 0).length}</span>
          </button>
          <button
            className={`vpk-categories__tab vpk-categories__tab--no-conflict ${conflictFilter === 'no-conflict' ? 'active' : ''}`}
            onClick={() => setConflictFilter(conflictFilter === 'no-conflict' ? 'all' : 'no-conflict')}
          >
            ✅ 无冲突
            <span className="vpk-categories__count">{mods.filter(m => !m.enabled || !m.conflicts || m.conflicts.length === 0).length}</span>
          </button>
        </div>
      </div>

      {/* 首次/刷新扫描进度条（已有部分数据时显示，仍在逐个加载） */}
      {scanning && scanProgress && scanProgress.total ? (
        <div className="my-mods-scanning-bar">
          <span className="my-mods-scanning-bar__label">
            正在扫描 Mod（{scanProgress.done}/{scanProgress.total}）…
          </span>
          <div className="my-mods-scanning-bar__track">
            <div
              className="my-mods-scanning-bar__fill"
              style={{ width: `${Math.min(100, Math.round((scanProgress.done / scanProgress.total) * 100))}%` }}
            />
          </div>
        </div>
      ) : null}

      {(loading || scanning) && mods.length === 0 ? (
        <div className="my-mods-status">
          <div className="my-mods-status__spinner" />
          <span>
            {scanning && scanProgress && scanProgress.total
              ? `首次扫描初始化中（${scanProgress.done}/${scanProgress.total}）…`
              : '正在扫描 Mod...'}
          </span>
        </div>
      ) : filtered.length > 0 ? (
        <div
          className={`my-mods-grid ${viewMode === 'list' ? 'my-mods-grid--list' : ''}`}
          // key 里带上视图模式：切「卡片 / 列表」时重建容器，卡片会重新错峰入场一次，
          // 比原地改布局显得「换了一种排法」而不是「突然重排」
          key={`${combinedCategoryKey}|${viewMode}`}
        >

          {filtered.map((mod, index) => {
            const enabled = mod.enabled;
            const customName = getCustomName(mod.name);
            const displayName = getModTitle(mod, customName);
            const rawConflicts = enabled && !!mod.conflicts && mod.conflicts.length > 0;
            // Filter out dismissed conflicts so the user can hide specific conflict badges
            const hasConflicts = rawConflicts && !dismissedConflicts.has(mod.name);
            const conflictTitle = rawConflicts ? `冲突: ${mod.conflicts.join(', ')}` : '';
            return (
              <div
                key={`${category}-${getStableModId(mod)}`}
                className={`mod-card ${mod.is_workshop ? 'mod-card--workshop' : 'mod-card--custom'} ${enabled ? 'mod-card--enabled' : 'mod-card--disabled'} ${hasConflicts ? 'mod-card--conflict' : ''} ${selectedMods.has(mod.name) ? 'mod-card--selected' : ''}`}
                onClick={(e) => handleCardClick(e, mod.name)}
                onContextMenu={(e) => handleContextMenu(e, mod.name)}
                // --card-i 给 CSS 算入场延迟用：序号越靠后出场越晚（上限 16，见 SCSS 注释）
                style={{ cursor: 'pointer', '--card-i': Math.min(index, 16) } as CSSProperties}
              >
                {hasConflicts && (
                  <div
                    className="mod-card__conflict-icon"
                    onMouseEnter={(e) => {
                      const rect = (e.target as HTMLElement).getBoundingClientRect();
                      const tooltipWidth = 280; // max-width of tooltip
                      let x: number;
                      if (rect.right + 8 + tooltipWidth > window.innerWidth) {
                        // Use negative value to indicate right-positioning (rendered as "right" style)
                        x = -(window.innerWidth - rect.left);
                      } else {
                        x = rect.right + 8;
                      }
                      setConflictTooltip({ modName: mod.name, x, y: rect.top });
                    }}
                    onMouseLeave={() => setConflictTooltip(null)}
                    onClick={(e) => {
                      e.stopPropagation();
                      openConflictDialog(mod.name);
                      setConflictTooltip(null);
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
                        enabled={enabled}
                        conflict={hasConflicts}
                        onToggle={() => toggleMod(mod.name)}
                      />
                    ) : (
                      <span className={`mod-card__status ${hasConflicts ? 'mod-card__status--conflict' : (enabled ? 'mod-card__status--enabled' : 'mod-card__status--disabled')}`}>
                        {hasConflicts ? '冲突' : (enabled ? '已启用' : '已禁用')}
                      </span>
                    )}
                  </div>
                  {mod.author && <span className="mod-card__author">{mod.author}</span>}
                  {mod.description && (
                    <span className="mod-card__description">{mod.description}</span>
                  )}
                  <span className="mod-card__meta">{formatSize(mod.size_bytes)}</span>
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
              </div>
            );
          })}
        </div>
      ) : (
        <div className="my-mods-status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <span>{mods.length === 0 ? '暂无 Mod，请先设置 Addons 目录' : '未找到匹配的 Mod'}</span>
        </div>
      )}

      {/* Right-click context menu for mod cards */}
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="context-menu show"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {selectedMods.size > 0 ? (
            <>
              <div className="context-menu__header">
                已选择 <strong>{selectedMods.size}</strong> 个 Mod
              </div>
              {/* Batch submenu trigger: 批量添加到整合包 */}
              <div
                ref={batchPackTriggerRef}
                className="context-menu__submenu-trigger"
                onMouseEnter={() => {
                  if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current);
                  setActiveSubmenu('batch-pack');
                  setBatchSubmenuOnLeft(false);
                  if (batchPackTriggerRef.current && contextMenuRef.current) {
                    const rect = contextMenuRef.current.getBoundingClientRect();
                    const onLeft = rect.right + 200 > window.innerWidth - 5;
                    setBatchSubmenuOnLeft(onLeft);
                    setBatchPackOffset(batchPackTriggerRef.current.offsetTop);
                  }
                }}
                onMouseLeave={() => closeSubmenuDelayed()}
              >
                <div className="context-menu__item context-menu__item--submenu-trigger">
                  <span>📦 批量添加到整合包</span>
                  <svg className="context-menu__submenu-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </div>
              </div>

              {/* Batch submenu trigger: 批量设置分类 */}
              <div
                ref={batchCategoryTriggerRef}
                className="context-menu__submenu-trigger"
                onMouseEnter={() => {
                  if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current);
                  setActiveSubmenu('batch-category');
                  setBatchSubmenuOnLeft(false);
                  if (batchCategoryTriggerRef.current && contextMenuRef.current) {
                    const rect = contextMenuRef.current.getBoundingClientRect();
                    const onLeft = rect.right + 200 > window.innerWidth - 5;
                    setBatchSubmenuOnLeft(onLeft);
                    setBatchCategoryOffset(batchCategoryTriggerRef.current.offsetTop);
                  }
                }}
                onMouseLeave={() => closeSubmenuDelayed()}
              >
                <div className="context-menu__item context-menu__item--submenu-trigger">
                  <span>📂 批量设置分类</span>
                  <svg className="context-menu__submenu-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </div>
              </div>
              <button
                className="context-menu__item context-menu__item--danger"
                onClick={() => {
                  if (window.confirm(`确定要删除选中的 ${selectedMods.size} 个 Mod 吗？\n此操作将从磁盘上移除文件，不可撤销。`)) {
                    selectedMods.forEach(modName => deleteMod(modName));
                    setSelectedMods(new Set());
                  }
                  setContextMenu(null);
                }}
              >
                🗑️ 批量删除
              </button>
              <div className="context-menu__divider" />
              <button
                className="context-menu__item"
                onClick={() => {
                  setSelectedMods(new Set());
                  setContextMenu(null);
                }}
              >
                ✕ 取消选择
              </button>

              {/* Batch submenu: 批量添加到整合包 */}
              {activeSubmenu === 'batch-pack' && (
                <div className="context-menu__submenu-wrapper" style={{ left: batchSubmenuOnLeft ? 'auto' : 'calc(100% - 1px)', right: batchSubmenuOnLeft ? 'calc(100% - 1px)' : 'auto', top: batchPackOffset }}>
                  <div
                    className="context-menu__submenu-box"
                    onMouseEnter={() => keepSubmenu()}
                    onMouseLeave={() => closeSubmenuDelayed()}
                  >
                    {packs.length > 0 ? (
                      packs.map((pack) => (
                        <button
                          key={pack.id}
                          className="context-menu__item"
                          onClick={() => {
                            // 批量添加：一次请求写入全部（逐条请求会因响应乱序而只加进去一部分）
                            addModsToPack(Array.from(selectedMods), pack.id);
                            setSelectedMods(new Set());
                            setContextMenu(null);
                          }}
                        >
                          {pack.name}
                        </button>
                      ))
                    ) : (
                      <div className="context-menu__empty">
                        暂无整合包
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Batch submenu: 批量添加分类标签 */}
              {activeSubmenu === 'batch-category' && (
                <div className="context-menu__submenu-wrapper" style={{ left: batchSubmenuOnLeft ? 'auto' : 'calc(100% - 1px)', right: batchSubmenuOnLeft ? 'calc(100% - 1px)' : 'auto', top: batchCategoryOffset }}>
                  <div
                    className="context-menu__submenu-box"
                    onMouseEnter={() => keepSubmenu()}
                    onMouseLeave={() => closeSubmenuDelayed()}
                  >
                    <div className="context-menu__submenu-hint">
                      已选 {selectedMods.size} 个：点分类 = 全部加上该标签
                    </div>
                    <button
                      className="context-menu__item"
                      onClick={() => {
                        selectedMods.forEach((modName) => { void setModTags(modName, null); });
                        setSelectedMods(new Set());
                        setContextMenu(null);
                      }}
                    >
                      ↺ 全部恢复自动检测
                    </button>
                    <div className="context-menu__submenu-divider" />
                    {VPK_CATEGORIES.map((cat) => (
                      <button
                        key={cat}
                        className="context-menu__item"
                        onClick={() => {
                          // 批量「加上」：基于每个 Mod 自己当前的分类型标签追加（不动它其余的标签）
                          selectedMods.forEach((modName) => {
                            const cur = (mods.find((m) => m.name === modName)?.tags || []).filter(
                              (t) => (VPK_CATEGORIES as readonly string[]).includes(t)
                            );
                            if (!cur.includes(cat)) void setModTags(modName, [...cur, cat]);
                          });
                          setSelectedMods(new Set());
                          setContextMenu(null);
                        }}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="context-menu__header">
                <span>Mod 操作</span>
              </div>
              <button
                className="context-menu__item"
                onClick={() => {
                  const currentName = getModDisplayName(contextMenu.modName) || contextMenu.modName;
                  setRenameValue(currentName);
                  setRenameModName(contextMenu.modName);
                  setContextMenu(null);
                }}
              >
                ✏️ 重命名
              </button>
              <button
                className="context-menu__item context-menu__item--danger"
                onClick={() => {
                  setDeleteConfirmMod(contextMenu.modName);
                  setContextMenu(null);
                }}
              >
                🗑️ 删除
              </button>
              {/* Dismiss conflict - only show if the mod actually has conflicts */}
              {(() => {
                const mod = mods.find(m => m.name === contextMenu.modName);
                // 禁用的 Mod 不会显示冲突，这里也不给出「忽略冲突」入口
                return !!mod && mod.enabled && !!mod.conflicts && mod.conflicts.length > 0;
              })() && (
                <button
                  className="context-menu__item"
                  onClick={() => {
                    const modName = contextMenu.modName;
                    const newSet = new Set(dismissedConflicts);
                    if (newSet.has(modName)) {
                      newSet.delete(modName);
                    } else {
                      newSet.add(modName);
                    }
                    setDismissedConflicts(newSet);
                    saveDismissedConflicts(newSet);
                    window.dispatchEvent(new CustomEvent('app:dismissed-conflicts'));
                    setContextMenu(null);
                  }}
                >
                  {dismissedConflicts.has(contextMenu.modName) ? '🔔 恢复冲突提示' : '🔕 移除冲突提示'}
                </button>
              )}
              <div className="context-menu__divider" />

              {/* Submenu trigger: 分类标签（多标签：点一下添加、再点一下移除） */}
              <div
                ref={categoryTriggerRef}
                className="context-menu__submenu-trigger"
                onMouseEnter={() => openSubmenu('category')}
                onMouseLeave={() => closeSubmenuDelayed()}
              >
                <div className="context-menu__item context-menu__item--submenu-trigger">
                  <span>🏷️ 分类标签</span>
                  <svg className="context-menu__submenu-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </div>
              </div>

              {/* Submenu trigger: 添加到整合包 */}
              <div
                ref={packTriggerRef}
                className="context-menu__submenu-trigger"
                onMouseEnter={() => openSubmenu('pack')}
                onMouseLeave={() => closeSubmenuDelayed()}
              >
                <div className="context-menu__item context-menu__item--submenu-trigger">
                  <span>📦 添加到整合包</span>
                  <svg className="context-menu__submenu-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </div>
              </div>

              {/* Submenu: 分类标签（多标签）——点一下加上、再点一下去掉 */}
              {activeSubmenu === 'category' && (() => {
                const target = mods.find((m) => m.name === contextMenu.modName);
                const currentCategories = (target?.tags || []).filter((t) =>
                  (VPK_CATEGORIES as readonly string[]).includes(t)
                );
                const isManual = !!target?.tags_manual;
                const toggle = (cat: string) => {
                  const next = currentCategories.includes(cat)
                    ? currentCategories.filter((c) => c !== cat)
                    : [...currentCategories, cat];
                  void setModTags(contextMenu.modName, next);
                  setContextMenu(null);
                };
                return (
                  <div className="context-menu__submenu-wrapper" style={{ left: submenuOnLeft ? 'auto' : 'calc(100% - 1px)', right: submenuOnLeft ? 'calc(100% - 1px)' : 'auto', top: categoryOffset }}>
                    <div
                      className="context-menu__submenu-box"
                      ref={categorySubmenuBoxRef}
                      onMouseEnter={() => keepSubmenu()}
                      onMouseLeave={() => closeSubmenuDelayed()}
                    >
                      <div className="context-menu__submenu-hint">
                        {isManual ? '手动标签（点一下加 / 再点一下去）' : '自动检测（改动后转为手动）'}
                      </div>
                      {isManual && (
                        <button
                          className="context-menu__item"
                          onClick={() => {
                            void setModTags(contextMenu.modName, null);
                            setContextMenu(null);
                          }}
                        >
                          ↺ 恢复自动检测
                        </button>
                      )}
                      <div className="context-menu__submenu-divider" />
                      {VPK_CATEGORIES.map((cat) => {
                        const on = currentCategories.includes(cat);
                        return (
                          <button
                            key={cat}
                            className={`context-menu__item context-menu__item--checkable${on ? ' context-menu__item--checked' : ''}`}
                            onClick={() => toggle(cat)}
                          >
                            <span className="context-menu__check">{on ? '✓' : ''}</span>
                            <span>{cat}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Submenu: 添加到整合包 (absolute inside context-menu) */}
              {activeSubmenu === 'pack' && (
                <div className="context-menu__submenu-wrapper" style={{ left: submenuOnLeft ? 'auto' : 'calc(100% - 1px)', right: submenuOnLeft ? 'calc(100% - 1px)' : 'auto', top: packOffset }}>
                  <div
                    className="context-menu__submenu-box"
                    onMouseEnter={() => keepSubmenu()}
                    onMouseLeave={() => closeSubmenuDelayed()}
                  >
                    {packs.length > 0 ? (
                      packs.map((pack) => (
                        <button
                          key={pack.id}
                          className="context-menu__item"
                          onClick={() => handleAddToPack(pack.id)}
                        >
                          {pack.name}
                        </button>
                      ))
                    ) : (
                      <div className="context-menu__empty">
                        暂无整合包
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>,
        document.body
      )}

      {/* Delete confirmation modal */}
      {deleteConfirmMod && (
        <div className="modal-overlay" onClick={() => setDeleteConfirmMod(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>确认删除</h3>
            <p className="modal-delete-text">
              确定要删除 Mod <strong>「{deleteConfirmMod}」</strong> 吗？
              <br />
              此操作将从磁盘上移除该文件，不可撤销。
            </p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setDeleteConfirmMod(null)}>
                取消
              </button>
              <button 
                className="modal-btn modal-btn-danger" 
                onClick={() => confirmDeleteMod(deleteConfirmMod)}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename modal */}
      {renameModName && (
        <div className="modal-overlay" onClick={() => { setRenameModName(null); setRenameValue(''); }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>重命名显示名称</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '12px' }}>
              此操作仅修改显示名称，不会修改 VPK 文件名。
            </p>
            <input
              type="text"
              className="modal-input"
              placeholder="输入新的显示名称..."
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleRenameSubmit()}
            />
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => { setRenameModName(null); setRenameValue(''); }}>
                取消
              </button>
              <button className="modal-btn modal-btn-primary" onClick={handleRenameSubmit}>
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Conflict hover tooltip: shows conflict mod names beside the icon */}
      {conflictTooltip && createPortal(
        <div
          className={`conflict-tooltip ${conflictTooltip.x < 0 ? 'conflict-tooltip--left' : ''}`}
          style={conflictTooltip.x < 0 ? { right: -conflictTooltip.x, top: conflictTooltip.y } : { left: conflictTooltip.x, top: conflictTooltip.y }}
          onMouseEnter={() => setConflictTooltip(null)}
        >
          <div className="conflict-tooltip__header">冲突 Detected</div>
          <div className="conflict-tooltip__list">
            {(mods.find(m => m.name === conflictTooltip.modName)?.conflicts || []).map((cname, idx) => {
              const conflictMod = mods.find(m => m.name === cname);
              const conflictDisplayName = conflictMod
                ? getModTitle(conflictMod, getModDisplayName(conflictMod.name) || undefined)
                : cname;
              return (
                <div key={idx} className="conflict-tooltip__item">
                  <span className="conflict-tooltip__dot">⚠️</span>
                  <span>{conflictDisplayName}</span>
                </div>
              );
            })}
          </div>
          <div className="conflict-tooltip__footer">
            点击查看详情
          </div>
        </div>,
        document.body
      )}

      {/* Conflict detail dialog: 硬冲突在前，提示级重叠折叠在后 */}
      {conflictDialogMod && (() => {
        const owner = mods.find(m => m.name === conflictDialogMod);
        const ownerTitle = owner
          ? getModTitle(owner, getModDisplayName(conflictDialogMod) || undefined)
          : conflictDialogMod;
        // 地图包把武器/道具模型、音效一起打进包里，才会和全局皮肤撞上。
        // 这类冲突的表述要跟普通 Mod 冲突区分开，否则用户看不懂为什么地图会跟武器皮打架。
        const isMap = owner?.role === 'campaign';
        const SEV_LABEL: Record<string, string> = {
          hard: '硬冲突',
          script: '脚本冲突',
          copy: '原版副本',
          entry: '入口重叠',
          soft: '资源重叠',
        };

        const renderCard = (d: ConflictDetail) => {
          const conflictMod = mods.find(m => m.name === d.other);
          if (!conflictMod) return null;
          const conflictDisplayName = getModTitle(conflictMod, getModDisplayName(conflictMod.name) || undefined);
          const tags = d.other_role_tags || [];
          return (
            <div
              key={`${d.other}-${d.severity}`}
              className={`conflict-card ${conflictMod.enabled ? 'conflict-card--enabled' : 'conflict-card--disabled'}`}
              title={d.files.join('\n')}
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
                <span className="conflict-card__meta">
                  <span className={`conflict-card__sev conflict-card__sev--${d.severity}`}>
                    {SEV_LABEL[d.severity] || d.severity}
                  </span>
                  <span className="conflict-card__files">
                    {d.count} 个文件{tags.length ? ` · ${tags.join('/')}` : ''}
                  </span>
                  <span className={`conflict-card__status ${conflictMod.enabled ? 'conflict-card__status--enabled' : 'conflict-card__status--disabled'}`}>
                    {conflictMod.enabled ? '已启用' : '已禁用'}
                  </span>
                </span>
              </div>
              <div className="conflict-card__toggle">
                <div className={`conflict-toggle ${conflictMod.enabled ? 'conflict-toggle--on' : 'conflict-toggle--off'}`}>
                  <div className="conflict-toggle__thumb" />
                </div>
              </div>
            </div>
          );
        };

        return createPortal(
          <div className="modal-overlay" onClick={() => closeConflictDialog()}>
            <div className={`conflict-dialog ${isMap ? 'conflict-dialog--map' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="conflict-dialog__header">
                <h3>{isMap ? '地图内置资源冲突' : '冲突 Mod 详情'}</h3>
                <button className="conflict-dialog__close" onClick={() => closeConflictDialog()}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="conflict-dialog__subheader">
                {isMap ? (
                  <>「<strong>{ownerTitle}</strong>」是地图包，它把场景用的模型/音效一并打进了 VPK。
                    当前地图内置资源包与以下 Mod 冲突：
                  </>
                ) : (
                  <>以下 Mod 与 <strong>{ownerTitle}</strong> 存在冲突</>
                )}
              </div>
              {isMap && (
                <div className="conflict-dialog__note">
                  地图里的资源是按全局路径加载的，会盖过同一路径的武器皮肤/角色替换。
                  通常保留地图即可，地图玩法不受影响；想保住皮肤就把皮肤移到地图之前。
                </div>
              )}
              <div className="conflict-dialog__grid">
                {conflictSnapshot.length === 0 ? (
                  <div className="conflict-dialog__empty">没有硬冲突</div>
                ) : conflictSnapshot.map(renderCard)}
              </div>

              {hintSnapshot.length > 0 && (
                <details className="conflict-dialog__hints">
                  <summary>
                    其他重叠 {hintSnapshot.length} 项
                    <span className="conflict-dialog__hints-sub">（不影响使用，展开查看）</span>
                  </summary>
                  <div className="conflict-dialog__hint-list">
                    {hintSnapshot.map((d) => {
                      const m = mods.find(x => x.name === d.other);
                      const nm = m ? getModTitle(m, getModDisplayName(m.name) || undefined) : d.other;
                      return (
                        <div key={`${d.other}-${d.severity}`} className="conflict-hint-row">
                          <span className={`conflict-card__sev conflict-card__sev--${d.severity}`}>
                            {SEV_LABEL[d.severity] || d.severity}
                          </span>
                          <span className="conflict-hint-row__name">{nm}</span>
                          <span className="conflict-hint-row__files">{d.count} 个文件</span>
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}

              <div className="conflict-dialog__footer">
                <span className="conflict-dialog__hint">点击卡片可切换启用/禁用状态</span>
                <button className="modal-btn modal-btn-cancel" onClick={() => closeConflictDialog()}>
                  关闭
                </button>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}
    </div>
  );
}
