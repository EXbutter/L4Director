import { useState, useMemo, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStore, getApiBase, ModData, ConflictDetail, WorkshopUpdateItem } from '../store/useStore';
import { ToolBar } from './ToolBar';
import { ThumbImage } from './ThumbImage';
import { ModSwitch } from './ModSwitch';
import { showToast } from './Toast';
import { confirmDialog } from './ConfirmDialog';
import { UnreadableNotice } from './UnreadableNotice';
import { MixPanel } from './MixPanel';
import { CoverageBoard } from './CoverageBoard';
import { useModalA11y } from '../hooks/useModalA11y';
import {
  hasFullSet,
} from '../utils/mix';
import './ContentArea.scss';
import './MyModsPage.scss';

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

/** 添加日期（YYYY-MM-DD）；列表视图里跟在体积后面，让「按添加时间排序」有据可看 */
function formatAddedDate(mod: ModData): string | null {
  const raw = mod.added_at || mod.last_modified;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getModTitle(mod: { vpk_title?: string | null; display_name?: string; name: string }, customName?: string | null): string {
  if (customName) return customName;
  return mod.vpk_title || mod.display_name || mod.name;
}

function getStableModId(mod: ModData): string {
  // 用路径而不是文件名：addons 根与 workshop 下可能是同一个文件名（重复安装）
  return `mod-${mod.path || mod.name}`;
}

/** 「添加时间」时间戳：优先创建时间，老数据/拿不到时退回 mtime */
function getAddedTs(mod: ModData): number {
  const raw = mod.added_at || mod.last_modified;
  if (!raw) return 0;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? 0 : ts;
}

const sortOptions = [
  { value: 'name-asc', label: '名称 A-Z' },
  { value: 'name-desc', label: '名称 Z-A' },
  { value: 'added-desc', label: '添加时间 ↓' },
  { value: 'added-asc', label: '添加时间 ↑' },
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


function ModPreview({ mod, displayName, favorited, onToggleFavorite }: {
  mod: ModData;
  displayName: string;
  favorited: boolean;
  onToggleFavorite: () => void;
}) {
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

      {/* 收藏：缩略图右下角的一颗心。选这里是因为它是整张卡最「空」的角落，
          又不压标题和状态角标；点一下就是加/减「我的最爱」标签。
          没收藏时只描边、半透明，收藏后填实并转成暖红 —— 扫一眼就能分出来。 */}
      <button
        type="button"
        className={`mod-card__fav${favorited ? ' mod-card__fav--on' : ''}`}
        title={favorited ? '已加入「我的最爱」，点击取消' : '加入「我的最爱」'}
        aria-label={favorited ? '取消收藏' : '加入我的最爱'}
        aria-pressed={favorited}
        onClick={(e) => {
          // 点卡片本身是打开预览，这颗心不能顺带把预览也打开
          e.stopPropagation();
          onToggleFavorite();
        }}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"
             fill={favorited ? 'currentColor' : 'none'}
             stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
      </button>
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

/**
 * 二级细分标签（与后端 tagger.FINE_TAGS 保持一致）。
 * 大类是「面上」的分类，细分是「具体改了谁」，一律用游戏里的英文原名：
 * 武器 → AK-47 / Hunting Rifle / Katana…，生还者 → Zoey / Nick…，
 * 被感染者 → Tank / Witch…，物品 → Medkit / Pain Pills…
 * 只有大类成立时后端才会给出细分标签，前端只负责展示与筛选。
 */
const FINE_TAGS: Record<string, string[]> = {
  生还者: ['Zoey', 'Nick', 'Bill', 'Francis', 'Louis', 'Coach', 'Ellis', 'Rochelle'],
  被感染者: ['Tank', 'Witch', 'Boomer', 'Smoker', 'Hunter', 'Charger', 'Jockey', 'Spitter', 'Common Infected'],
  武器: [
    'M16 Rifle', 'AK-47', 'Desert Rifle', 'SG552',
    'SMG', 'Silenced SMG',
    'Pump Shotgun', 'Chrome Shotgun', 'Auto Shotgun', 'SPAS-12',
    'Hunting Rifle', 'Military Sniper', 'AWP', 'Scout',
    'M60', 'Grenade Launcher',
    'Pistol', 'Magnum',
    'Chainsaw', 'Katana', 'Machete', 'Crowbar', 'Fire Axe', 'Shovel',
    'Frying Pan', 'Golf Club', 'Cricket Bat', 'Baseball Bat',
    'Electric Guitar', 'Knife', 'Tonfa', 'Pitchfork',
    'Pipe Bomb', 'Molotov', 'Vomit Jar',
  ],
  物品: ['Medkit', 'Pain Pills', 'Adrenaline', 'Defibrillator'],
};

/** 细分标签 → 它挂在哪个大类下面 */
const FINE_PARENT: Record<string, string> = Object.entries(FINE_TAGS).reduce(
  (acc, [parent, children]) => {
    for (const child of children) acc[child] = parent;
    return acc;
  },
  {} as Record<string, string>
);

const isFineTag = (tag: string) => tag in FINE_PARENT;
export { isFineTag };

/** 来源类标签（不是内容分类），排在卡片标签的最后 */
const isSourceTag = (tag: string) => tag === '外部 Mod' || tag === '创意工坊 Mod' || tag.startsWith('ID: ');

/**
 * 「我的最爱」：内置收藏标签（后端 `mod_scanner.FAVORITE_TAG`，两边字符串必须一致）。
 *
 * 刻意**不算自定义标签**：它不在可删的标签池里、不进 CATEGORIES —— 收藏是功能，
 * 不是用户数据。爱心按钮、筛选栏、右键菜单都直接读写这一个标签名。
 */
export const FAVORITE_TAG = '我的最爱';

/**
 * 卡片上标签的展示顺序：最爱 → 大类 → 细分 → 用户自建标签 → 来源（外部/工坊/ID）。
 * 否则「外部 Mod」永远占掉第一个坑位，细分标签天天被 +n 挡住 —— 等于白加。
 */
export function orderCardTags(tags: string[]): string[] {
  const rank = (tag: string) =>
    tag === FAVORITE_TAG ? -1
      : isSourceTag(tag) ? 3
        : (VPK_CATEGORIES as readonly string[]).includes(tag) ? 0
          : isFineTag(tag) ? 1
            : 2;
  // Array.prototype.sort 在现代引擎里是稳定排序，同档内保持后端给的先后
  return [...tags].sort((a, b) => rank(a) - rank(b));
}

/** 可以手动增删的标签：内置大类、内置细分、收藏标签、用户自建标签（来源标签不算） */
const isPickableTag = (tag: string, customTags: string[] = []) =>
  tag === FAVORITE_TAG
  || (VPK_CATEGORIES as readonly string[]).includes(tag)
  || isFineTag(tag)
  || customTags.includes(tag);

export function MyModsPage() {
  const { mods, packs, fetchMods, refreshAll, loading, scanning, scanProgress, toggleMod, addAddoninfo, addModToPack, addModsToPack, setContextMenu, contextMenu, deleteMod, deleteMods, deleteConfirmMod, setDeleteConfirmMod, confirmDeleteMod, renameModDisplayName, getModDisplayName, setModTags, customTags, createCustomTag, deleteCustomTag, workshopUpdates, checkWorkshopUpdates, cancelWorkshopCheck, applyWorkshopUpdates } = useStore();
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
  // 「只看重复安装」：同一个 Mod 同时存在于 addons 根与 workshop
  const [dupFilter, setDupFilter] = useState(false);
  // 「只看有新版本」：创意工坊条目的 time_updated 超过本地基线（后端判定）
  const [updateFilter, setUpdateFilter] = useState(false);
  // 重复安装详情弹窗（用路径标识，同名文件可能有两份）
  const [dupDialogPath, setDupDialogPath] = useState<string | null>(null);
  const [vpkCategory, setVpkCategory] = useState<string | null>(null);
  // 二级细分筛选：只在大类有子类时出现（选中「武器」才显示 步枪/霰弹枪…）
  const [fineTag, setFineTag] = useState<string | null>(null);
  // 自定义标签筛选（用户自己起的归类，单选，交互和类型/细分保持一致）
  const [customTagFilter, setCustomTagFilter] = useState<string | null>(null);
  // 「只看收藏」：收藏是内置标签，单独一个开关，不混进自定义标签的单选里
  const [favoriteFilter, setFavoriteFilter] = useState(false);
  /** 「补全 Addonlist」正在写文件 */
  const [fillingAddonlist, setFillingAddonlist] = useState(false);
  /** 「同步 Steam 订阅」正在拉订阅列表（首次要几秒） */
  const [syncingSubs, setSyncingSubs] = useState(false);
  // 右键菜单里「+ 新建标签」的输入框内容（null = 输入框没展开）。
  // 和筛选栏那个分开存：两处可能同时开着，共用一个状态会互相串内容。
  const [newTagDraft, setNewTagDraft] = useState<string | null>(null);
  const [menuTagDraft, setMenuTagDraft] = useState<string | null>(null);
  const [renameModName, setRenameModName] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const categoryTriggerRef = useRef<HTMLDivElement>(null);
  const packTriggerRef = useRef<HTMLDivElement>(null);
  const batchCategoryTriggerRef = useRef<HTMLDivElement>(null);
  const batchPackTriggerRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<'category' | 'pack' | 'batch-category' | 'batch-pack' | null>(null);
  // 分类子菜单的当前层级：null = 大类，非空 = 该大类下的细分标签
  const [catParent, setCatParent] = useState<string | null>(null);
  const [batchSubmenuOnLeft, setBatchSubmenuOnLeft] = useState(false);
  const [batchCategoryOffset, setBatchCategoryOffset] = useState(0);
  const [batchPackOffset, setBatchPackOffset] = useState(0);
  const submenuTimerRef = useRef<number | null>(null);
  // dismissed conflicts: set of mod names whose conflict warnings we hide
  const [dismissedConflicts, setDismissedConflicts] = useState<Set<string>>(loadDismissedConflicts);
  // Batch selection: set of selected mod names
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set());
  // 一键混搭面板：给每个角色 / 武器随机挑一个替换包
  const [mixOpen, setMixOpen] = useState(false);
  // 从完整度看板的「补齐缺口」进来时带上的初始条件（只补缺口 + 有缺口的类别）
  const [mixInit, setMixInit] = useState<{ families: string[]; gapOnly: boolean } | null>(null);
  // 「整套替换」筛选：只留下把某一类整个换完的 Mod（coverage.hit === total）
  const [fullSetFilter, setFullSetFilter] = useState(false);
  // Conflict tooltip: which mod's conflicts to show in hover tooltip, + position
  const [conflictTooltip, setConflictTooltip] = useState<{ modName: string; x: number; y: number } | null>(null);
  // Conflict dialog: which mod to show conflict details for (null = closed)
  const [conflictDialogMod, setConflictDialogMod] = useState<string | null>(null);
  // Snapshot of conflicts when dialog opens - prevents list from updating during interaction
  const [conflictSnapshot, setConflictSnapshot] = useState<ConflictDetail[]>([]);

  // 弹窗的 Esc 关闭 + Tab 焦点陷阱。这几个弹窗以前只能用鼠标点遮罩关掉，
  // 而且 Tab 一路按下去焦点会跑到背景页的卡片上。
  const deleteModalRef = useModalA11y(!!deleteConfirmMod, () => setDeleteConfirmMod(null));
  const renameModalRef = useModalA11y(!!renameModName, () => {
    setRenameModName(null);
    setRenameValue('');
  });
  const dupModalRef = useModalA11y(!!dupDialogPath, () => setDupDialogPath(null));
  const conflictModalRef = useModalA11y(!!conflictDialogMod, () => setConflictDialogMod(null));
  const [hintSnapshot, setHintSnapshot] = useState<ConflictDetail[]>([]);

  useEffect(() => {
    // 仅当尚无数据时才自动拉取；后端连接后由 App 统一触发首次扫描
    // （自定义标签池也在那里一起拉，见 App 的 refreshAll 之后）
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
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close submenu when context menu closes
  useEffect(() => {
    if (!contextMenu) {
      setActiveSubmenu(null);
      setCatParent(null);
      setMenuTagDraft(null);
    }
  }, [contextMenu]);

  // 切到别的子菜单时，分类子菜单回到大类层（下次打开不会停在上次的子级）
  useEffect(() => {
    if (activeSubmenu !== 'category') setCatParent(null);
  }, [activeSubmenu]);

  /**
   * 列表里**展示**的 Mod。
   *
   * 解析失败的 VPK 不进列表：它的内容读不出来，标签、分类、冲突、封面全都是空的，
   * 在网格里就是一张几乎信息量为零的卡，还会混进「全部 / 自定义 / 工坊」的计数里，
   * 让用户以为多了个能用的包。这类文件的去处是列表下方那条提示（文件名 + 错误原因
   * + 处理办法 + 打开目录 / 删除），而不是和正常 Mod 排在一起。
   *
   * 注意：只在**展示层**过滤 —— 后端仍然保留记录，启停状态、addonlist 的对应行
   * 都不受影响，修好文件后下次扫描会自动回到列表。
   */
  const visibleMods = useMemo(() => mods.filter((m) => !m.unreadable), [mods]);

  const counts = useMemo(() => ({
    custom: visibleMods.filter((m) => !m.is_workshop).length,
    workshop: visibleMods.filter((m) => m.is_workshop).length,
  }), [visibleMods]);

  // ── 创意工坊更新 ──
  // 用两个键索引：workshop_id（标准订阅路径能找到）和文件名（addons 根目录里的
  // `2503979832.vpk` 这种包，后端认不出 is_workshop，只能靠文件名对上）。
  const updateByKey = useMemo(() => {
    const map = new Map<string, WorkshopUpdateItem>();
    for (const it of workshopUpdates?.items || []) {
      if (it.workshop_id) map.set(`id:${it.workshop_id}`, it);
      if (it.name) map.set(`name:${it.name.toLowerCase()}`, it);
    }
    return map;
  }, [workshopUpdates]);

  const updateFor = useCallback(
    (mod: ModData): WorkshopUpdateItem | undefined =>
      (mod.workshop_id ? updateByKey.get(`id:${mod.workshop_id}`) : undefined) ||
      updateByKey.get(`name:${mod.name.toLowerCase()}`),
    [updateByKey]
  );

  const updateCount = useMemo(
    () => visibleMods.filter((m) => updateFor(m)?.update_available).length,
    [visibleMods, updateFor]
  );

  const applyingInfo = workshopUpdates?.applying;
  const applyingNow = !!applyingInfo?.running;
  const checking = !!workshopUpdates?.checking;
  const checkProgress = workshopUpdates?.check_progress;
  // 阶段文案：后端把一次检查拆成 scan → query → compare。只显示数字的话，
  // 一次两秒的检查在界面上就是「0/88 → 完成」两帧，等于没有进度。
  const checkLabel = useMemo(() => {
    if (!checking) return '检查更新';
    if (!checkProgress || !checkProgress.total) return '扫描本地…';
    if (checkProgress.stage === 'compare') return '比对版本…';
    return `检查中 ${checkProgress.done}/${checkProgress.total}`;
  }, [checking, checkProgress]);
  const checkBatchHint =
    checkProgress && checkProgress.batches
      ? `第 ${Math.max(1, checkProgress.batch || 1)}/${checkProgress.batches} 批`
      : '';

  const vpkCategoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const cat of VPK_CATEGORIES) {
      counts[cat] = visibleMods.filter((m) => m.tags.includes(cat)).length;
    }
    return counts;
  }, [visibleMods]);

  // 细分标签计数：口径跟着「当前大类」走，点进去才知道每一类有几个
  const fineTagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!vpkCategory) return counts;
    for (const tag of FINE_TAGS[vpkCategory] || []) {
      counts[tag] = visibleMods.filter((m) => m.tags.includes(vpkCategory) && m.tags.includes(tag)).length;
    }
    return counts;
  }, [visibleMods, vpkCategory]);

  // 细分标签从 9 个涨到 34 个（具体到每把枪）后全列出来太吵：
  // 只保留有 Mod 的，外加当前选中的那个，避免把筛选行撑成三行
  const visibleFineOptions = useMemo(
    () =>
      vpkCategory
        ? (FINE_TAGS[vpkCategory] || []).filter(
            (t) => (fineTagCounts[t] || 0) > 0 || t === fineTag
          )
        : [],
    [vpkCategory, fineTagCounts, fineTag]
  );

  // 自定义标签计数：和类型不同，这里只统计当前列表里真用得上的（0 个的不占地方）
  const customTagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tag of customTags) {
      counts[tag] = visibleMods.filter((m) => m.tags.includes(tag)).length;
    }
    return counts;
  }, [visibleMods, customTags]);

  const favoriteCount = useMemo(
    () => visibleMods.filter((m) => m.tags.includes(FAVORITE_TAG)).length,
    [visibleMods]
  );

  // 切大类/清空筛选时，二级筛选必须跟着复位，否则会留下一个不存在的组合
  useEffect(() => {
    if (!fineTag) return;
    if (!vpkCategory || !(FINE_TAGS[vpkCategory] || []).includes(fineTag)) setFineTag(null);
  }, [vpkCategory, fineTag]);

  // 标签池里已经没有这个标签了（在别处删掉 / 后端换了数据）→ 别把筛选卡在一个空条件上
  useEffect(() => {
    if (customTagFilter && !customTags.includes(customTagFilter)) setCustomTagFilter(null);
  }, [customTags, customTagFilter]);

  const combinedCategoryKey = useMemo(() => `${category}-${vpkCategory || 'all'}-${fineTag || 'all'}-${customTagFilter || 'all'}-${favoriteFilter ? 'fav' : 'all'}-${enabledFilter}-${conflictFilter}-${dupFilter ? 'dup' : 'all'}-${updateFilter ? 'upd' : 'all'}`, [category, vpkCategory, fineTag, customTagFilter, favoriteFilter, enabledFilter, conflictFilter, dupFilter, updateFilter]);

  const enabledCounts = useMemo(() => ({
    enabled: visibleMods.filter((m) => m.enabled).length,
    disabled: visibleMods.filter((m) => !m.enabled).length,
  }), [visibleMods]);

  const filtered = useMemo(() => {
    let list = [...visibleMods];

    if (category === 'custom') {
      list = list.filter((m) => !m.is_workshop);
    } else if (category === 'workshop') {
      list = list.filter((m) => m.is_workshop);
    }

    if (vpkCategory) {
      list = list.filter((m) => m.tags.includes(vpkCategory));
      if (fineTag) list = list.filter((m) => m.tags.includes(fineTag));
    }

    // 自定义标签是独立维度：和类型/状态取交集（「武器」∩「最爱」就看最爱里的武器）
    if (customTagFilter) {
      list = list.filter((m) => m.tags.includes(customTagFilter));
    }

    if (favoriteFilter) {
      list = list.filter((m) => m.tags.includes(FAVORITE_TAG));
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

    if (dupFilter) {
      list = list.filter((m) => (m.duplicates?.length ?? 0) > 0);
    }

    if (updateFilter) {
      list = list.filter((m) => updateFor(m)?.update_available);
    }

    if (fullSetFilter) {
      // 「整套替换」：某一类的清单全命中（8/8 生还者、35/35 武器…）
      list = list.filter(hasFullSet);
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
      case 'added-desc':
        // 最近添加的排前面；时间相同（同一批拖进来）时按名称兜底，顺序才稳定
        list.sort((a, b) => getAddedTs(b) - getAddedTs(a) || getModTitle(a).localeCompare(getModTitle(b)));
        break;
      case 'added-asc':
        list.sort((a, b) => getAddedTs(a) - getAddedTs(b) || getModTitle(a).localeCompare(getModTitle(b)));
        break;
      case 'size-desc':
        list.sort((a, b) => b.size_bytes - a.size_bytes);
        break;
      case 'size-asc':
        list.sort((a, b) => a.size_bytes - b.size_bytes);
        break;
    }

    return list;
  }, [search, sortBy, visibleMods, category, vpkCategory, fineTag, customTagFilter, favoriteFilter, enabledFilter, conflictFilter, dupFilter, updateFilter, fullSetFilter, updateFor]);

  /** 解析失败的 VPK：不入列表，只在下方提示条里逐条说明（文件名 / 原因 / 处理办法） */
  const unreadableMods = useMemo(() => mods.filter((m) => m.unreadable), [mods]);

  // 扫出新坏包时弹一次 toast 引导用户看下方提示条；同一批坏包不重复弹
  //（前端每 5 秒轮询扫描状态，不加这道判断会变成每轮一次）
  const unreadableKey = unreadableMods.map((m) => m.name).sort().join('|');
  const notifiedUnreadableRef = useRef('');
  useEffect(() => {
    if (!unreadableKey || unreadableKey === notifiedUnreadableRef.current) return;
    notifiedUnreadableRef.current = unreadableKey;
    showToast(
      unreadableMods.length === 1
        ? `「${unreadableMods[0].name}」解析失败，已从列表隐藏，下方有错误原因与处理办法`
        : `${unreadableMods.length} 个 VPK 解析失败，已从列表隐藏，下方有错误原因与处理办法`,
      'warning'
    );
  }, [unreadableKey, unreadableMods]);

  /** 关掉一个「缺 addoninfo.txt」的 Mod 时先把风险说清楚：游戏那边多半不会跟着关。 */
  const warnIfUnmanageable = (mod: ModData) => {
    if (!mod.missing_addoninfo || !mod.enabled) return;
    showToast(
      `「${getModTitle(mod, getModDisplayName(mod.name))}」缺 addoninfo.txt：软件里关掉了，游戏仍可能继续加载它。点卡片上的「补 addoninfo」可修复。`,
      'warning'
    );
  };

  /** 给这个包补 addoninfo.txt（会重写 vpk，先征求同意）。 */
  const handleFixAddoninfo = async (e: React.MouseEvent, mod: ModData) => {
    e.stopPropagation();
    const title = getModTitle(mod, getModDisplayName(mod.name));
    const ok = await confirmDialog({
      title: '补一份 addoninfo.txt？',
      tone: 'warning',
      description: (
        <>
          {'给「'}
          <strong>{title}</strong>
          {'」。这个 VPK 里没有 '}
          <code>addoninfo.txt</code>
          {'，游戏不会把它当作可管理的附加内容 —— 在软件里关掉后，游戏仍会加载它。'}
          {'补上之后，游戏才能在「附加内容」里看到它并真正关掉。'}
        </>
      ),
      detail: mod.path,
      note: '这会重建这个 VPK：先在临时文件里写好、逐条目校验一致后才替换原文件，原文件不会被中途改动。',
      confirmText: '补上',
    });
    if (!ok) return;
    await addAddoninfo(mod.name, mod.path);
  };

  const handleCardClick = (e: React.MouseEvent, mod: ModData) => {
    const modName = mod.name;
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
      warnIfUnmanageable(mod);
      // 带上路径：同名副本（addons 根 + workshop）不能都按文件名去改
      toggleMod(modName, mod.path);
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

  // 二级筛选（类型/状态/问题/细分/自定义标签）里生效的项数：>0 时面板右上角才出现「清除筛选」，
  // 平时不占位置，也让用户一眼看出「现在到底被几个条件卡着」
  const activeFilterCount =
    (vpkCategory ? 1 : 0) +
    (fineTag ? 1 : 0) +
    (customTagFilter ? 1 : 0) +
    (favoriteFilter ? 1 : 0) +
    (enabledFilter !== 'all' ? 1 : 0) +
    (conflictFilter !== 'all' ? 1 : 0) +
    (dupFilter ? 1 : 0) +
    (updateFilter ? 1 : 0) +
    (fullSetFilter ? 1 : 0);

  const resetFilters = useCallback(() => {
    setVpkCategory(null);
    setFineTag(null);
    setCustomTagFilter(null);
    setFavoriteFilter(false);
    setEnabledFilter('all');
    setConflictFilter('all');
    setDupFilter(false);
    setUpdateFilter(false);
    setFullSetFilter(false);
  }, []);

  /**
   * 新建自定义标签。
   *
   * 传了 modName 就是「在这个 Mod 的右键菜单里顺手起的名字」——建完立刻给它打上，
   * 否则用户还要再点一次刚出现的那个勾，白白多一步。
   * 返回创建出来的标签名（失败返回 null，原因已经 toast 过）。
   */
  const handleCreateCustomTag = useCallback(async (rawName: string, modName?: string) => {
    const name = rawName.trim();
    if (!name) return null;
    const created = await createCustomTag(name);
    if (!created) return null;
    if (!modName) return created;

    const target = mods.find((m) => m.name === modName);
    const current = (target?.tags || []).filter((t) => isPickableTag(t, [...customTags, created]));
    if (!current.includes(created)) void setModTags(modName, [...current, created]);
    return created;
  }, [createCustomTag, mods, customTags, setModTags]);

  /**
   * 爱心：切换「我的最爱」。
   *
   * 走和右键标签同一条接口 —— 收藏只是一个标签，不需要单独的存储字段；
   * 这样它能直接被筛选、也能在右键菜单里看到勾选状态，不用维护第二套真相。
   */
  const toggleFavorite = useCallback((mod: ModData) => {
    const tags = mod.tags || [];
    const tagged = tags.includes(FAVORITE_TAG);
    // 只保留「能手动增删」的那些，避免把来源标签（外部 Mod / ID: xxx）写进 override
    const rest = tags.filter((t) => t !== FAVORITE_TAG && isPickableTag(t, customTags));
    void setModTags(mod.name, tagged ? rest : [...rest, FAVORITE_TAG]);
  }, [customTags, setModTags]);

  /**
   * 一键补全 addonlist.txt。
   *
   * 为什么放在这一页：addonlist.txt 是「本地 Mod 的启用清单」，和侧栏的
   * 创意工坊是两件事。刚拖进 addons 或刚订阅下载回来的包常常还没有条目 ——
   * 游戏的「附加内容」列表里看不到它，某些机器上还会被当成没装。
   * 这里一次补齐缺失条目，已有条目的启停状态和编码写法都不动。
   */
  const fillAddonlist = useCallback(async () => {
    setFillingAddonlist(true);
    try {
      const res = await fetch(`${getApiBase()}/api/mods/addonlist/fill`, { method: 'POST' });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok || data.ok === false) {
        showToast(`补全失败：${data.error || data.detail || `HTTP ${res.status}`}`, 'error');
        return;
      }
      const added = Number(data.added) || 0;
      if (added > 0) {
        showToast(`已补全 ${added} 个条目到 addonlist.txt`, 'success');
        // 补进去的都是「启用」→ 列表里的状态要跟着刷新，别让用户以为没生效
        fetchMods();
      } else {
        showToast(`addonlist.txt 已经齐了（本地 ${Number(data.scanned) || 0} 个 Mod 都在里面）`, 'info');
      }
    } catch (e) {
      showToast(`补全失败：${(e as Error).message || '无法连接到后端服务'}`, 'error');
    } finally {
      setFillingAddonlist(false);
    }
  }, [fetchMods]);

  /**
   * 同步 Steam 订阅。
   *
   * 只读方向是真同步（Steam 上是订阅了哪些，这里读得到）；写入方向做不到 ——
   * SubscribePublishedFile 要用户级 OAuth token，API Key 只给到 403。
   * 所以这里的「同步」定义为：把本地对齐到 Steam 的订阅状态 ——
   * 缺的进下载队列，多出来的（已取消订阅）删掉。
   */
  const syncSteamSubscriptions = useCallback(async () => {
    setSyncingSubs(true);
    try {
      const res = await fetch(`${getApiBase()}/api/workshop/subscription-diff`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.detail || `读取订阅失败（HTTP ${res.status}）`, 'error');
        return;
      }

      const toDownload: Array<{ id: string; title?: string }> = data.to_download || [];
      const toDelete: Array<{ id: string; name?: string }> = data.to_delete || [];

      if (!toDownload.length && !toDelete.length) {
        showToast(`已经和 Steam 订阅一致（${data.total_subscribed || 0} 个）`, 'info');
        return;
      }

      const Preview = ({ items, label, tone }: {
        items: Array<{ id: string; title?: string; name?: string }>;
        label: string;
        tone: 'add' | 'del';
      }) => (
        <div className="sub-sync__block">
          <span className={`sub-sync__label sub-sync__label--${tone}`}>{label}</span>
          <ul>
            {items.slice(0, 5).map((x) => (
              <li key={x.id} title={x.title || x.name}>{x.title || x.name || `#${x.id}`}</li>
            ))}
          </ul>
          {items.length > 5 && <span className="sub-sync__more">…还有 {items.length - 5} 个</span>}
        </div>
      );

      const ok = await confirmDialog({
        title: '同步 Steam 订阅',
        tone: toDelete.length ? 'danger' : 'primary',
        confirmText: '执行同步',
        description: (
          <div className="sub-sync">
            <p>
              Steam 上订阅了 <b>{data.total_subscribed || 0}</b> 个，本地有 <b>{data.total_local || 0}</b> 个。
            </p>
            {toDownload.length > 0 && (
              <Preview items={toDownload} label={`加入下载队列 ${toDownload.length} 个`} tone="add" />
            )}
            {toDelete.length > 0 && (
              <Preview items={toDelete} label={`从硬盘删除 ${toDelete.length} 个`} tone="del" />
            )}
          </div>
        ),
        note: toDelete.length
          ? '「删除」的是已经不在你 Steam 订阅里的条目（取消订阅或被作者隐藏），文件会直接移除。'
            + '想留住的话先取消这次同步，把文件挪出 addons 目录。'
          : '只是加入下载队列，不会自动开始 —— 到「下载」页点开始。',
      });
      if (!ok) return;

      const syncRes = await fetch(`${getApiBase()}/api/workshop/subscriptions/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          download_ids: toDownload.map((x) => x.id),
          delete_ids: toDelete.map((x) => x.id),
        }),
      });
      const out = await syncRes.json().catch(() => ({}));
      if (!syncRes.ok) {
        showToast(out.detail || '同步失败', 'error');
        return;
      }

      const parts: string[] = [];
      if (out.queued) parts.push(`${out.queued} 个已加入队列`);
      if (out.already_queued) parts.push(`${out.already_queued} 个本来就在队列里`);
      if (out.deleted) parts.push(`${out.deleted} 个已删除`);
      const failed = (out.failed || []).length;
      if (failed) parts.push(`${failed} 个失败`);

      showToast(
        parts.length ? `同步完成：${parts.join('、')}` : '没有需要变更的条目',
        failed ? 'warning' : 'success',
      );
      if (out.deleted) refreshAll();
    } catch (e) {
      showToast(`同步失败：${(e as Error).message || '无法连接到后端服务'}`, 'error');
    } finally {
      setSyncingSubs(false);
    }
  }, [refreshAll]);

  /** 筛选行里新建标签：只是丰富标签池，不关联具体 Mod */
  const handleCreateTagFromFilter = useCallback(async () => {
    const created = await handleCreateCustomTag(newTagDraft || '');
    setNewTagDraft(null);
    if (created) showToast(`已新建标签「${created}」，右键 Mod 就能打上`, 'success');
  }, [handleCreateCustomTag, newTagDraft]);

  /** 右键菜单里新建标签：建完直接打到这个 Mod 上 */
  const handleCreateTagForMod = useCallback(async () => {
    const created = await handleCreateCustomTag(menuTagDraft || '', contextMenu?.modName);
    setMenuTagDraft(null);
    if (created) setContextMenu(null);
  }, [handleCreateCustomTag, menuTagDraft, contextMenu, setContextMenu]);

  /** 删除自定义标签：会从所有 Mod 身上摘掉，属于不可撤销操作，先确认 */
  const handleDeleteCustomTag = useCallback(async (tag: string) => {
    const used = visibleMods.filter((m) => m.tags.includes(tag)).length;
    const ok = await confirmDialog({
      title: `删除标签「${tag}」？`,
      description:
        used > 0
          ? `会同时从 ${used} 个 Mod 上摘掉这个标签（Mod 本身不会被动到）。`
          : '这个标签目前还没有打在任何 Mod 上。',
      note: used > 0 ? '如果某个 Mod 只挂着这一个标签，它会恢复成按内容自动分类。' : undefined,
      tone: 'danger',
      confirmText: '删除标签',
    });
    if (ok) void deleteCustomTag(tag);
  }, [visibleMods, deleteCustomTag]);

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

      {/* ── 筛选面板 ──
          以前是「一堆 Tab 顺着排」，类型标签会自己折成两三行、状态标签又贴在右边，
          折行后同一个维度被切成两段，看起来就是一锅粥。现在按维度分行：
          来源（主维度，分段控件）／类型／状态·问题／细分，每行左侧固定一个说明标签，
          同行内的选项各自成组、互不干扰，折行也只会折在组内。 */}
      <div className="filter-panel">
        <div className="filter-panel__row filter-panel__row--source">
          <div className="filter-seg">
            <button
              className={`filter-seg__item ${category === 'all' ? 'active' : ''}`}
              onClick={() => setCategory('all')}
            >
              全部<span className="filter-seg__count">{visibleMods.length}</span>
            </button>
            <button
              className={`filter-seg__item ${category === 'custom' ? 'active' : ''}`}
              onClick={() => setCategory('custom')}
            >
              自定义 Mod<span className="filter-seg__count">{counts.custom}</span>
            </button>
            <button
              className={`filter-seg__item ${category === 'workshop' ? 'active' : ''}`}
              onClick={() => setCategory('workshop')}
            >
              创意工坊 Mod<span className="filter-seg__count">{counts.workshop}</span>
            </button>
          </div>
          <div className="filter-panel__summary">
            {/* 统计放在最左：右边连续排的是「能点的操作」，中间夹一个数字
                会把按钮断成两截，视觉上找不到重点 */}
            <span className="filter-panel__result">
              筛出 <strong>{filtered.length}</strong> / {visibleMods.length}
            </span>
            {applyingNow ? (
              <span
                className="filter-panel__updating"
                title={applyingInfo?.current ? `正在更新：${applyingInfo.current}` : '正在更新创意工坊 Mod'}
              >
                更新中 {applyingInfo?.done ?? 0}/{applyingInfo?.total ?? 0}
                {applyingInfo && applyingInfo.pct > 0 ? ` · ${Math.round(applyingInfo.pct)}%` : ''}
              </span>
            ) : updateCount > 0 ? (
              <button
                className="filter-panel__update-all"
                onClick={() => applyWorkshopUpdates()}
                title="重新下载这些创意工坊 Mod 并覆盖本地旧文件（保留启停状态）"
              >
                更新全部 {updateCount}
              </button>
            ) : null}
            {(counts.workshop > 0 || updateCount > 0) && (
              checking ? (
                // 检查在后台跑，这个按钮立刻变成「取消检查」：随时能停，不占着界面
                <button
                  className="filter-panel__check filter-panel__check--busy"
                  onClick={cancelWorkshopCheck}
                  title={`${checkLabel}${checkBatchHint ? ` · ${checkBatchHint}` : ''}，点一下立刻停止，已经查到的结果会保留`}
                >
                  <span className="filter-panel__check-label">{checkLabel}</span>
                  <span className="filter-panel__check-cancel">取消</span>
                </button>
              ) : (
                <button
                  className="filter-panel__check"
                  onClick={checkWorkshopUpdates}
                  disabled={applyingNow}
                  title={
                    workshopUpdates?.last_error
                      ? `上次检查没成功：${workshopUpdates.last_error}`
                      : workshopUpdates?.checked_at
                        ? `上次检查：${new Date(workshopUpdates.checked_at * 1000).toLocaleString('zh-CN')}`
                        : '联网查询创意工坊有没有新版本'
                  }
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden="true">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" strokeLinecap="round" />
                    <path d="M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  检查更新
                </button>
              )
            )}
            {/* 补全 addonlist.txt：只补缺失条目，已有条目的启停/写法不动 */}
            <button
              className="filter-panel__check"
              onClick={() => void fillAddonlist()}
              disabled={fillingAddonlist}
              title={
                '把本地 addons 里还没写进 addonlist.txt 的 Mod 一次补齐。\n'
                + '只补缺失的条目：已有条目的启停状态和编码写法都不动。\n'
                + '刚拖进 addons / 刚订阅下载回来的包在游戏「附加内容」里看不到时用它。'
              }
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden="true">
                <path d="M4 5h9M4 11h6M4 17h5" strokeLinecap="round" />
                <path d="M16 12v7M12.5 15.5h7" strokeLinecap="round" />
              </svg>
              {fillingAddonlist ? '补全中…' : '补全 Addonlist'}
            </button>
            {/* 同步 Steam 订阅：只读 Steam 的订阅列表，把本地对齐过去 */}
            <button
              className="filter-panel__check"
              onClick={() => void syncSteamSubscriptions()}
              disabled={syncingSubs}
              title={
                '读取你 Steam 账号的工坊订阅，和本地文件对一遍：\n'
                + '订阅了但本地没有的 → 加入下载队列；\n'
                + '本地有但已取消订阅的 → 从硬盘删除。\n'
                + '（Steam 不允许第三方改订阅，所以只能把本地对齐到 Steam，反向做不到）'
              }
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden="true">
                <path d="M4 14.5A4 4 0 0 1 5.2 6.7 5.5 5.5 0 0 1 15.6 8a3.6 3.6 0 0 1 3.4 6.3" strokeLinecap="round" />
                <path d="M12 12v7M9 16l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {syncingSubs ? '同步中…' : '同步 Steam 订阅'}
            </button>
            <button
              className="filter-panel__mix"
              onClick={() => {
                setMixInit(null);
                setMixOpen(true);
              }}
              title={
                '给每个角色 / 每把枪单独随机挑一个替换包，凑成一套互相不覆盖的组合。\n'
                + 'Nick 有 5 个皮肤就从这 5 个里随机挑，8 个生还者各挑一个；'
                + '地图、音效、界面这些不相干的 Mod 一概不动。'
              }
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" aria-hidden="true">
                <path d="M16 3h5v5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 20 21 3" strokeLinecap="round" />
                <path d="M21 16v5h-5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="m15 15 6 6" strokeLinecap="round" />
                <path d="m4 4 5 5" strokeLinecap="round" />
              </svg>
              一键混搭
            </button>
            {activeFilterCount > 0 && (
              <button className="filter-panel__clear" onClick={resetFilters} title="清空类型、状态、问题上的筛选">
                清除筛选
              </button>
            )}
          </div>
        </div>

        <div className="filter-panel__row">
          <span className="filter-panel__label">类型</span>
          <div className="filter-panel__chips">
            <button
              className={`filter-chip ${!vpkCategory ? 'filter-chip--on' : ''}`}
              onClick={() => setVpkCategory(null)}
            >
              所有类型
            </button>
            {VPK_CATEGORIES.map((cat) => {
              const n = vpkCategoryCounts[cat] || 0;
              return (
                <button
                  key={cat}
                  className={`filter-chip ${vpkCategory === cat ? 'filter-chip--on' : ''} ${n === 0 ? 'filter-chip--empty' : ''}`}
                  onClick={() => setVpkCategory(vpkCategory === cat ? null : cat)}
                  title={n === 0 ? `没有「${cat}」类型的 Mod` : `${n} 个 Mod`}
                >
                  {cat}
                  {n > 0 && <span className="filter-chip__count">{n}</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="filter-panel__row">
          <span className="filter-panel__label">状态</span>
          <div className="filter-panel__chips">
            <button
              className={`filter-chip filter-chip--ok ${enabledFilter === 'enabled' ? 'filter-chip--on' : ''}`}
              onClick={() => setEnabledFilter(enabledFilter === 'enabled' ? 'all' : 'enabled')}
            >
              <i className="filter-chip__dot" />
              已启用
              <span className="filter-chip__count">{enabledCounts.enabled}</span>
            </button>
            <button
              className={`filter-chip filter-chip--bad ${enabledFilter === 'disabled' ? 'filter-chip--on' : ''}`}
              onClick={() => setEnabledFilter(enabledFilter === 'disabled' ? 'all' : 'disabled')}
            >
              <i className="filter-chip__dot" />
              已禁用
              <span className="filter-chip__count">{enabledCounts.disabled}</span>
            </button>
          </div>
          <span className="filter-panel__vsep" />
          <span className="filter-panel__label filter-panel__label--inline">问题</span>
          <div className="filter-panel__chips">
            <button
              className={`filter-chip filter-chip--warn ${conflictFilter === 'conflict' ? 'filter-chip--on' : ''}`}
              onClick={() => setConflictFilter(conflictFilter === 'conflict' ? 'all' : 'conflict')}
            >
              <i className="filter-chip__dot" />
              有冲突
              <span className="filter-chip__count">
                {visibleMods.filter((m) => m.enabled && m.conflicts && m.conflicts.length > 0).length}
              </span>
            </button>
            <button
              className={`filter-chip filter-chip--ok ${conflictFilter === 'no-conflict' ? 'filter-chip--on' : ''}`}
              onClick={() => setConflictFilter(conflictFilter === 'no-conflict' ? 'all' : 'no-conflict')}
            >
              <i className="filter-chip__dot" />
              无冲突
              <span className="filter-chip__count">
                {visibleMods.filter((m) => !m.enabled || !m.conflicts || m.conflicts.length === 0).length}
              </span>
            </button>
            <button
              className={`filter-chip filter-chip--ok ${fullSetFilter ? 'filter-chip--on' : ''}`}
              onClick={() => setFullSetFilter(!fullSetFilter)}
              title="只留下把某一类整套换完的 Mod：8/8 生还者、8/8 特感、4/4 物品、35/35 武器"
            >
              <i className="filter-chip__dot" />
              整套替换
              <span className="filter-chip__count">
                {visibleMods.filter(hasFullSet).length}
              </span>
            </button>
            <button
              className={`filter-chip filter-chip--warn ${dupFilter ? 'filter-chip--on' : ''}`}
              onClick={() => setDupFilter(!dupFilter)}
              title="同一个 Mod 装了多份：工坊订阅了一份，又把同一个 vpk 拖进了 addons"
            >
              <i className="filter-chip__dot" />
              重复安装
              <span className="filter-chip__count">
                {visibleMods.filter((m) => (m.duplicates?.length ?? 0) > 0).length}
              </span>
            </button>
            {/* 有更新：没查到就整条不出现，免得每台机器上都挂一个 0 */}
            {(updateCount > 0 || updateFilter) && (
              <button
                className={`filter-chip filter-chip--info ${updateFilter ? 'filter-chip--on' : ''}`}
                onClick={() => setUpdateFilter(!updateFilter)}
                title="创意工坊里这些 Mod 发了新版本，可以在这里直接更新"
              >
                <i className="filter-chip__dot" />
                有更新
                <span className="filter-chip__count">{updateCount}</span>
              </button>
            )}
          </div>
        </div>

        {/* 二级细分：选中「武器 / 生还者 / 被感染者 / 物品」时才展开 */}
        {visibleFineOptions.length > 0 && (
          <div className="filter-panel__row filter-panel__row--sub">
            <span className="filter-panel__label">细分</span>
            <div className="filter-panel__chips">
              <button
                className={`filter-chip filter-chip--sub ${!fineTag ? 'filter-chip--on' : ''}`}
                onClick={() => setFineTag(null)}
              >
                全部
              </button>
              {visibleFineOptions.map((tag) => {
                const n = fineTagCounts[tag] || 0;
                return (
                  <button
                    key={tag}
                    className={`filter-chip filter-chip--sub ${fineTag === tag ? 'filter-chip--on' : ''}`}
                    onClick={() => setFineTag(fineTag === tag ? null : tag)}
                    title={`${n} 个`}
                  >
                    {tag}
                    {n > 0 && <span className="filter-chip__count">{n}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {/* ── 标签 ──
            这一行放两样东西，都是「我怎么看这个包」而不是「这个包是什么」（后者是上面的类型）：
              1) 我的最爱 —— 内置的收藏标签，只有一个，固定在最前面；
              2) 用户自建标签 —— 可新建、可删除，可跨 Mod 复用。
            图标标签只写两个字：左侧说明列宽 30px，写「我的标签」会顶到 chip 上去
            （四个字 ~44px，overflow 直接压在第一个 chip 上）。 */}
        <div className="filter-panel__row filter-panel__row--sub filter-panel__row--custom">
          <span className="filter-panel__label" title="收藏与自定义标签">标签</span>
          <div className="filter-panel__chips">
            <button
              className={`filter-chip filter-chip--fav ${favoriteFilter ? 'filter-chip--on' : ''}${favoriteCount === 0 ? ' filter-chip--empty' : ''}`}
              onClick={() => setFavoriteFilter(!favoriteFilter)}
              title={favoriteCount === 0
                ? '还没有收藏：卡片缩略图右下角的心形图标点一下就收进来'
                : `${favoriteCount} 个收藏`}
            >
              <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"
                   fill={favoriteFilter ? 'currentColor' : 'none'}
                   stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              我的最爱
              {favoriteCount > 0 && <span className="filter-chip__count">{favoriteCount}</span>}
            </button>

            {customTags.length > 0 && <span className="filter-panel__vsep" />}

            {customTags.length > 0 && (
              <button
                className={`filter-chip filter-chip--sub ${!customTagFilter ? 'filter-chip--on' : ''}`}
                onClick={() => setCustomTagFilter(null)}
              >
                全部
              </button>
            )}
            {customTags.map((tag) => {
              const n = customTagCounts[tag] || 0;
              const on = customTagFilter === tag;
              return (
                <span key={tag} className={`filter-tag${on ? ' filter-tag--on' : ''}`}>
                  <button
                    className={`filter-chip filter-chip--custom ${on ? 'filter-chip--on' : ''}${n === 0 ? ' filter-chip--empty' : ''}`}
                    onClick={() => setCustomTagFilter(on ? null : tag)}
                    title={n === 0 ? `还没有 Mod 打上「${tag}」` : `${n} 个 Mod`}
                  >
                    {tag}
                    {n > 0 && <span className="filter-chip__count">{n}</span>}
                  </button>
                  <button
                    className="filter-tag__del"
                    title={`删除标签「${tag}」`}
                    aria-label={`删除标签 ${tag}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDeleteCustomTag(tag);
                    }}
                  >
                    ×
                  </button>
                </span>
              );
            })}
            {newTagDraft === null ? (
              <button
                className="filter-chip filter-chip--ghost"
                onClick={() => setNewTagDraft('')}
                title="起一个只有自己看得懂的归类，之后可在任意 Mod 的右键菜单里勾选"
              >
                ＋ 新建标签
              </button>
            ) : (
              <input
                className="filter-tag__input"
                autoFocus
                maxLength={16}
                value={newTagDraft}
                placeholder="标签名，回车确认"
                onChange={(e) => setNewTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleCreateTagFromFilter();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setNewTagDraft(null);
                  }
                }}
                onBlur={() => {
                  // 空着失焦就当放弃；有内容时保留，让用户切个窗口回来还能接着按回车
                  if (!newTagDraft.trim()) setNewTagDraft(null);
                }}
              />
            )}
          </div>
        </div>
      </div>

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

      {/* ── 当前搭配完整度（常驻）──
          回答「现在启用着的包换了名单里的谁、还差谁」：彩色 = 已有包在换，
          虚框 = 还是原版。看板本身只读，不改任何状态；「补齐缺口」把
          有缺口的类别带进混搭面板，且默认只补缺口（不动已启用的组合）。 */}
      {mods.length > 0 && (
        <CoverageBoard
          onFillGaps={(families) => {
            setMixInit({ families, gapOnly: true });
            setMixOpen(true);
          }}
        />
      )}

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
            const addedLabel = formatAddedDate(mod);
            return (
              <div
                key={`${category}-${getStableModId(mod)}`}
                className={`mod-card ${mod.is_workshop ? 'mod-card--workshop' : 'mod-card--custom'} ${enabled ? 'mod-card--enabled' : 'mod-card--disabled'} ${hasConflicts ? 'mod-card--conflict' : ''} ${selectedMods.has(mod.name) ? 'mod-card--selected' : ''}`}
                onClick={(e) => handleCardClick(e, mod)}
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
                <ModPreview
                  mod={mod}
                  displayName={displayName}
                  favorited={(mod.tags || []).includes(FAVORITE_TAG)}
                  onToggleFavorite={() => toggleFavorite(mod)}
                />
                <div className="mod-card__info">
                  <div className="mod-card__info-header">
                    <span className="mod-card__name">{displayName}</span>
                    {viewMode === 'list' ? (
                      <ModSwitch
                        enabled={enabled}
                        conflict={hasConflicts}
                        onToggle={() => {
                          warnIfUnmanageable(mod);
                          void toggleMod(mod.name, mod.path);
                        }}
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
                  <span className="mod-card__meta">
                    {formatSize(mod.size_bytes)}
                    {viewMode === 'list' && addedLabel ? ` · ${addedLabel}` : ''}
                  </span>
                  {((mod.duplicates?.length ?? 0) > 0 || mod.missing_addoninfo || updateFor(mod)?.update_available || (mod.tags && mod.tags.length > 0)) && (
                    <div className="mod-card__tags" title={mod.tags?.join(' / ')}>
                      {/* 这里不再显示「武器 12/35」这类完整度徽标：
                          它字号比标签大一档、又总是排在标签行最前，一张卡上最抢眼的
                          成了覆盖率而不是 Mod 本身。完整度改由上面的常驻看板回答，
                          卡片这里只保留标签。 */}
                      {mod.missing_addoninfo && (
                        <button
                          className="mod-card__addoninfo"
                          title={
                            '这个 VPK 里没有 addoninfo.txt：游戏的「附加内容」列表里看不到它，\n'
                            + '保存 addonlist.txt 时还会把它的条目写回 "1" —— 在软件里关掉，游戏里照样加载。\n'
                            + '点击给它补一份 addoninfo.txt（会重建这个 vpk）。'
                          }
                          onClick={(e) => void handleFixAddoninfo(e, mod)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11">
                            <path d="M12 9v4M12 17v0" strokeLinecap="round" />
                            <path d="M10.3 3.9 2.4 17.6a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                          </svg>
                          缺 addoninfo
                        </button>
                      )}
                      {(() => {
                        const u = updateFor(mod);
                        if (!u?.update_available) return null;
                        const fmt = (ts: number) => new Date(ts * 1000).toLocaleDateString('zh-CN');
                        return (
                          <button
                            className="mod-card__update"
                            disabled={applyingNow}
                            title={
                              `创意工坊在 ${fmt(u.remote_time)} 发布了新版，本地是 ${fmt(u.local_time)} 的版本。\n`
                              + '点击重新下载并覆盖本地 vpk（启停状态不变）。'
                              + (applyingNow ? '\n（正在更新其它 Mod，稍等片刻）' : '')
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              applyWorkshopUpdates([u.workshop_id]);
                            }}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11">
                              <path d="M12 3v12M7 10l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M4 20h16" strokeLinecap="round" />
                            </svg>
                            可更新
                          </button>
                        );
                      })()}
                      {(mod.duplicates?.length ?? 0) > 0 && (() => {
                        const twin = mod.duplicates![0];
                        const src = twin.is_workshop
                          ? `创意工坊 Mod${twin.workshop_id ? ` (ID ${twin.workshop_id})` : ''}`
                          : '外部 Mod';
                        const sameContent = (mod.duplicate_kind || twin.kind) === 'content';
                        return (
                          <button
                            className={`mod-card__dup mod-card__dup--${sameContent ? 'content' : 'version'}`}
                            title={sameContent
                              ? `与同名的${src}内容完全一致：游戏会把两份各加载一遍。点击查看处理方式。`
                              : `与${src}标题相同、内容不同，可能是同一个 Mod 的两个版本。点击查看。`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDupDialogPath(mod.path || mod.name);
                            }}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11">
                              <rect x="9" y="9" width="12" height="12" rx="2" />
                              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                            </svg>
                            {sameContent ? '重复安装' : '疑似重复'}
                          </button>
                        );
                      })()}
                      {mod.tags && orderCardTags(mod.tags).slice(0, 4).map((tag, idx) => (
                        <span
                          key={idx}
                          className={`mod-card__tag${isFineTag(tag) ? ' mod-card__tag--fine' : ''}${customTags.includes(tag) ? ' mod-card__tag--custom' : ''}${tag === FAVORITE_TAG ? ' mod-card__tag--fav' : ''}`}
                        >
                          {tag}
                        </span>
                      ))}
                      {mod.tags && mod.tags.length > 4 && (
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
          <span>
            {visibleMods.length === 0
              ? (mods.length === 0
                  ? '暂无 Mod，请先设置 Addons 目录'
                  : '没有可以正常读取的 Mod，原因见下方说明')
              : '未找到匹配的 Mod'}
          </span>
        </div>
      )}

      {/* 解析失败的 VPK：**不进列表**，只贴在列表下方，写明「哪个文件 / 为什么 / 怎么处理」。
          不放进 toast —— 3.5 秒就消失，用户来不及照着做。 */}
      <UnreadableNotice mods={unreadableMods} />

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
                onClick={async () => {
                  const count = selectedMods.size;
                  const targets = [...selectedMods];
                  setContextMenu(null);
                  const ok = await confirmDialog({
                    title: `删除选中的 ${count} 个 Mod？`,
                    tone: 'danger',
                    description: (
                      <>
                        {'将从磁盘上移除这 '}
                        <strong>{count}</strong>
                        {' 个 Mod 的文件，'}
                        <strong>不可撤销</strong>
                        {'。'}
                      </>
                    ),
                    confirmText: '删除',
                  });
                  if (!ok) return;
                  // 批量删除走专门的串行入口：以前是 targets.forEach(deleteMod)，
                  // 每个 deleteMod 内部都会 fetchMods + fetchStatus + fetchPacks，
                  // 选 10 个就等于 10 次全量扫描 —— 界面会卡十几秒。
                  void deleteMods(targets);
                  setSelectedMods(new Set());
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
                          // 批量「加上」：基于每个 Mod 自己当前的分类标签追加（不动它其余的标签）
                          // 这里要连细分标签一起保留，否则批量加大类会把细分冲掉
                          selectedMods.forEach((modName) => {
                            const cur = (mods.find((m) => m.name === modName)?.tags || []).filter(
                              (t) => isPickableTag(t, customTags)
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

              {/* Submenu: 分类标签（大类 → 细分两级）——点一下加上、再点一下去掉 */}
              {activeSubmenu === 'category' && (() => {
                const target = mods.find((m) => m.name === contextMenu.modName);
                // 大类、细分、自定义标签都算「可编辑标签」：只 filter 大类的话，
                // 点一次细分标签就会把之前手动加过的细分标签全冲掉；
                // 自定义标签更是必须带上，否则「改一次分类」就把自建标签抹掉了
                const currentTags = (target?.tags || []).filter((t) => isPickableTag(t, customTags));
                const isManual = !!target?.tags_manual;
                const apply = (next: string[]) => {
                  void setModTags(contextMenu.modName, next);
                  setContextMenu(null);
                };
                const toggle = (cat: string) => {
                  if (currentTags.includes(cat)) {
                    // 去掉大类时连它的细分一起清掉，否则会留下「有坦克、没有被感染者」的孤儿标签
                    apply(currentTags.filter((t) => t !== cat && FINE_PARENT[t] !== cat));
                  } else {
                    apply([...currentTags, cat]);
                  }
                };
                const toggleFine = (parent: string, fine: string) => {
                  if (currentTags.includes(fine)) {
                    apply(currentTags.filter((t) => t !== fine));
                  } else {
                    // 加细分时自动补上大类：只留「坦克」不留「被感染者」，它会被大类筛选挡在外面
                    apply(currentTags.includes(parent) ? [...currentTags, fine] : [...currentTags, parent, fine]);
                  }
                };
                return (
                  <div className="context-menu__submenu-wrapper" style={{ left: submenuOnLeft ? 'auto' : 'calc(100% - 1px)', right: submenuOnLeft ? 'calc(100% - 1px)' : 'auto', top: categoryOffset }}>
                    <div
                      className="context-menu__submenu-box"
                      ref={categorySubmenuBoxRef}
                      onMouseEnter={() => keepSubmenu()}
                      onMouseLeave={() => closeSubmenuDelayed()}
                    >
                      {catParent === null ? (
                        <>
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
                            const on = currentTags.includes(cat);
                            const children = FINE_TAGS[cat];
                            return (
                              <div key={cat} className="context-menu__row">
                                <button
                                  className={`context-menu__item context-menu__item--checkable${on ? ' context-menu__item--checked' : ''}`}
                                  onClick={() => toggle(cat)}
                                >
                                  <span className="context-menu__check">{on ? '✓' : ''}</span>
                                  <span>{cat}</span>
                                </button>
                                {children && (
                                  <button
                                    className="context-menu__drill"
                                    title={`查看「${cat}」的细分标签`}
                                    onClick={() => setCatParent(cat)}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                                      <path d="M9 6l6 6-6 6" />
                                    </svg>
                                  </button>
                                )}
                              </div>
                            );
                          })}

                          {/* ── 我的标签 ──
                              内置分类是「这个包是什么」，这里是「我怎么看它」。
                              勾选逻辑复用上面的 toggle：加/减一个标签，不牵扯类别父子关系。 */}
                          <div className="context-menu__submenu-divider" />
                          <div className="context-menu__submenu-hint">我的标签</div>
                          {/* 收藏固定排第一：它和自建标签共用 tags_override，
                              所以放在同一个区块里勾选，不会出现「两套标签」的割裂感 */}
                          {(() => {
                            const on = currentTags.includes(FAVORITE_TAG);
                            return (
                              <button
                                className={`context-menu__item context-menu__item--checkable${on ? ' context-menu__item--checked' : ''}`}
                                onClick={() => toggle(FAVORITE_TAG)}
                              >
                                <span className="context-menu__check">{on ? '✓' : ''}</span>
                                <span className="context-menu__tag-fav">我的最爱</span>
                              </button>
                            );
                          })()}
                          {customTags.length === 0 && menuTagDraft === null && (
                            <div className="context-menu__empty">还没有自建标签</div>
                          )}
                          {customTags.map((tag) => {
                            const on = currentTags.includes(tag);
                            return (
                              <button
                                key={tag}
                                className={`context-menu__item context-menu__item--checkable${on ? ' context-menu__item--checked' : ''}`}
                                onClick={() => toggle(tag)}
                              >
                                <span className="context-menu__check">{on ? '✓' : ''}</span>
                                <span className="context-menu__tag-custom">{tag}</span>
                              </button>
                            );
                          })}
                          {menuTagDraft === null ? (
                            <button
                              className="context-menu__item context-menu__item--new"
                              onClick={() => setMenuTagDraft('')}
                            >
                              ＋ 新建标签…
                            </button>
                          ) : (
                            <input
                              className="context-menu__tag-input"
                              autoFocus
                              maxLength={16}
                              value={menuTagDraft}
                              placeholder="标签名，回车确认"
                              onChange={(e) => setMenuTagDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void handleCreateTagForMod();
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setMenuTagDraft(null);
                                }
                              }}
                            />
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            className="context-menu__item context-menu__back"
                            onClick={() => setCatParent(null)}
                          >
                            ‹ 返回大类
                          </button>
                          <div className="context-menu__submenu-hint">
                            {catParent} · 细分标签
                          </div>
                          <div className="context-menu__submenu-divider" />
                          {(FINE_TAGS[catParent] || []).map((fine) => {
                            const on = currentTags.includes(fine);
                            return (
                              <button
                                key={fine}
                                className={`context-menu__item context-menu__item--checkable${on ? ' context-menu__item--checked' : ''}`}
                                onClick={() => toggleFine(catParent, fine)}
                              >
                                <span className="context-menu__check">{on ? '✓' : ''}</span>
                                <span>{fine}</span>
                              </button>
                            );
                          })}
                        </>
                      )}
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
          <div className="modal-content" ref={deleteModalRef} onClick={(e) => e.stopPropagation()}>
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
          <div className="modal-content" ref={renameModalRef} onClick={(e) => e.stopPropagation()}>
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
                toggleMod(conflictMod.name, conflictMod.path);
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
            <div className={`conflict-dialog ${isMap ? 'conflict-dialog--map' : ''}`} ref={conflictModalRef} onClick={(e) => e.stopPropagation()}>
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

      {/* 重复安装详情：同一个 Mod 装在 addons 根与 workshop 两处 */}
      {dupDialogPath && (() => {
        const owner = mods.find((m) => (m.path || m.name) === dupDialogPath);
        if (!owner) return null;

        const sameContent = owner.duplicate_kind === 'content';
        // 当前条目 + 对侧条目一起列出，让用户看清楚「哪两份、各自在哪」
        const entries: { mod: ModData; self: boolean }[] = [{ mod: owner, self: true }];
        for (const ref of owner.duplicates || []) {
          const twin = mods.find((m) => (m.path || m.name) === ref.path);
          if (twin) entries.push({ mod: twin, self: false });
        }

        const removeEntry = async (target: ModData) => {
          const src = target.is_workshop ? '创意工坊副本' : '外部副本';
          const ok = await confirmDialog({
            title: `删除这个${src}？`,
            tone: 'danger',
            description: (
              <>
                将从磁盘上移除下面这个文件，<strong>不可撤销</strong>。
              </>
            ),
            detail: target.path,
            note: target.is_workshop
              ? 'Steam 仍订阅着这个 Mod：删除后下次启动游戏会被重新下载。要彻底去掉它，请同时在 Steam 里取消订阅。'
              : undefined,
            confirmText: '删除',
          });
          if (!ok) return;
          void deleteMod(target.name, target.path);
          setDupDialogPath(null);
        };

        return createPortal(
          <div className="modal-overlay" onClick={() => setDupDialogPath(null)}>
            <div className="conflict-dialog dup-dialog" ref={dupModalRef} onClick={(e) => e.stopPropagation()}>
              <div className="conflict-dialog__header">
                <h3>重复安装</h3>
                <button className="conflict-dialog__close" onClick={() => setDupDialogPath(null)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="conflict-dialog__subheader">
                下面这些条目是<strong>同一个 Mod</strong>：
                {sameContent
                  ? 'VPK 里的资源逐条一致，只是被装在了两个位置。'
                  : '标题相同但内容不同，可能是同一个 Mod 的两个版本。'}
              </div>

              <div className="conflict-dialog__note">
                {sameContent
                  ? '游戏会把两份各加载一遍 —— 既多占内存，也可能出现贴图/音效叠加的怪现象。建议只留一份：通常保留创意工坊版（会自动更新），删掉手动拖进来的外部副本；不确定的话先禁用其中一份。如果你已经不需要它，删掉工坊副本后记得去 Steam 取消订阅。'
                  : '两个版本同时启用时，游戏按加载顺序决定谁生效，表现不可预期。确认好要哪一版后删掉另一份即可。'}
              </div>

              <div className="dup-list">
                {entries.map(({ mod: item, self }) => {
                  const title = getModTitle(item, getModDisplayName(item.name) || undefined);
                  const added = formatAddedDate(item);
                  const srcLabel = item.is_workshop
                    ? `创意工坊 Mod${item.workshop_id ? ` · ID ${item.workshop_id}` : ''}`
                    : '外部 Mod';
                  return (
                    <div className={`dup-row ${self ? 'dup-row--self' : ''}`} key={item.path || item.name}>
                      <div className="dup-row__thumb">
                        {resolveUrl(item.thumbnail_url) ? (
                          <ThumbImage
                            src={resolveUrl(item.thumbnail_url)!}
                            alt={title}
                            className="dup-row__img"
                            maxWidth={72}
                            maxHeight={72}
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
                      <div className="dup-row__info">
                        <span className="dup-row__name">
                          {title}
                          {self && <em className="dup-row__self-tag">当前条目</em>}
                        </span>
                        <span className="dup-row__meta">
                          <span className={`dup-row__src ${item.is_workshop ? 'dup-row__src--ws' : 'dup-row__src--ext'}`}>
                            {srcLabel}
                          </span>
                          <span>{formatSize(item.size_bytes)}{added ? ` · ${added}` : ''}</span>
                          <span className={item.enabled ? 'dup-row__state--on' : 'dup-row__state--off'}>
                            {item.enabled ? '已启用' : '已禁用'}
                          </span>
                        </span>
                        <span className="dup-row__path" title={item.path}>
                          {'addons\\' + (item.path.split(/[\\/]addons[\\/]/i).pop() || item.path)}
                        </span>
                      </div>
                      <div className="dup-row__actions">
                        <button
                          className="dup-btn"
                          onClick={() => toggleMod(item.name, item.path)}
                          title="两份是同一个 Mod，正常只需启用其中一份"
                        >
                          {item.enabled ? '禁用' : '启用'}
                        </button>
                        <button
                          className="dup-btn dup-btn--danger"
                          onClick={() => {
                            void removeEntry(item);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="conflict-dialog__footer">
                <span className="conflict-dialog__hint">删除后不会影响另一份，剩下的那份继续正常使用</span>
                <button className="modal-btn modal-btn-cancel" onClick={() => setDupDialogPath(null)}>
                  关闭
                </button>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}

      {mixOpen && (
        <MixPanel
          initialFamilies={mixInit?.families}
          gapOnlyDefault={mixInit?.gapOnly}
          onClose={() => {
            setMixOpen(false);
            setMixInit(null);
          }}
        />
      )}
    </div>
  );
}
