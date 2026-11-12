import { create } from 'zustand';
import {
  BACKGROUND_HEAVY_CHARS,
  isBackgroundOptimized,
  markBackgroundOptimized,
  optimizeBackgroundImage,
} from '../utils/backgroundImage';
import { showToast } from '../components/Toast';
import { applyUiFont, loadUiFontKey, saveUiFontKey } from '../utils/uiFont';
import { DEFAULT_ACCENT, applyAccent, loadAccent, normalizeHex, saveAccent } from '../utils/themeColor';

export type Page = 'my-mods' | 'workshop' | 'download' | 'packs' | 'settings';

/**
 * 游戏进程状态：
 * - `idle`      游戏未运行
 * - `launching` 已发出启动请求，正在等待 left4dead2.exe 出现
 * - `running`   检测到游戏进程，正在游戏中
 */
export type GameState = 'idle' | 'launching' | 'running';


export interface ModData {
  name: string;
  display_name: string;
  path: string;
  size_bytes: number;
  enabled: boolean;
  is_workshop: boolean;
  workshop_id: string | null;
  last_modified: string | null;
  /** 文件被放进 addons 的时间（创建时间，取不到时等于 last_modified）。
   *  「按添加时间排序」用它，改动文件不会改变这个值。 */
  added_at?: string | null;
  description: string | null;
  author: string | null;
  version: string | null;
  tags: string[];
  /** 分类标签是手动设置的吗（true = 手动，可通过右键「恢复自动检测」还原） */
  tags_manual?: boolean;
  thumbnail_url: string | null;
  vpk_title: string | null;
  conflicts: string[];
  /** 冲突明细（只含真互斥：双方都改过同一官方资源 / 脚本重名） */
  conflict_details?: ConflictDetail[];
  /** 提示级重叠（单向覆盖 / 脚本入口 / 同系列素材），不报警 */
  conflict_hints?: ConflictDetail[];
  /** 包的主角色：campaign（地图）/ art（美术）/ script（脚本）/ hud */
  role?: 'campaign' | 'art' | 'script' | 'hud';
  /** 多标签：地图 / 脚本 / 音效 / 美术 */
  role_tags?: string[];
  /** VPK 解析失败（坏包 / 非标准编码），这类包不参与冲突判定 */
  unreadable?: boolean;
  /** 同一个 Mod 装在另一处的副本（工坊订阅 + 手动拖进 addons 的同一个包） */
  duplicates?: DuplicateRef[];
  /** content = 两份内容完全一致；version = 标题相同、内容不同（多半是两个版本） */
  duplicate_kind?: 'content' | 'version' | null;
}

export interface DuplicateRef {
  name: string;
  /** 对侧文件的绝对路径（同名副本里只有路径能唯一指认） */
  path: string;
  title: string;
  is_workshop: boolean;
  workshop_id: string | null;
  kind: 'content' | 'version';
}

/** mod 的唯一键：同名文件可能同时存在于 addons 根与 workshop 下，只有路径唯一 */
export function modKey(mod: { path?: string; name: string }): string {
  return mod.path || mod.name;
}

export interface ConflictDetail {
  other: string;
  severity: 'hard' | 'script' | 'copy' | 'entry' | 'soft';
  count: number;
  files: string[];
  other_role?: string;
  other_role_tags?: string[];
}

export interface PackData {
  id: string;
  name: string;
  modNames: string[];  // frontend uses modNames, but API uses mod_ids
  createdAt: string;
}

export interface StatusData {
  game_detected: boolean;
  mod_count: number;
  workshop_count: number;
  game_path: string | null;
  addons_configured: boolean;
}

export interface DynamicThemeColors {
  accent: string;
  accentSecondary: string;
  accentHover: string;
  sidebarActive: string;
  launchBg: string;
  textPrimary: string;
  textSecondary: string;
}

export interface BackgroundSettings {
  imagePath: string | null;   // local file path
  blur: number;               // 0 - 20，无级（支持小数）
  dim: number;                // 0 - 80 (dark overlay %)，无级（支持小数）
  opacity: number;            // 0 - 100，背景图层可见程度：越高背景越明显
  uiTransparency: number;     // 0 - 100，内部窗口（容器底色 + 毛玻璃面板）透明度：越高越透
}

export interface SteamUser {
  steamId: string;
  nickname: string;
  avatarUrl: string;
}

export interface GpuAccelerationStatus {
  gpuAccelerationDisabled: boolean;
}

/**
 * 「游戏内改过、还没同步进软件」的 Mod 启停变更。
 * 后端用 addonlist.txt 的内容指纹判断文件是否被自己以外的东西改过（游戏退出时写回、
 * Steam 云同步、手动编辑），检测到就由界面弹窗询问用户是否同步。
 */
export interface AddonlistChange {
  name: string;
  /** 文件（游戏里）里的当前状态 */
  enabled: boolean;
  /** 软件里原来的记录 */
  previous: boolean;
}

/**
 * 创意工坊 Mod 的更新状态。
 *
 * 后端查 Steam 的 `time_updated` 得到新版时间，和本地「已对齐的基线」比较；
 * 这里只负责展示与操作，判定口径全部在后端（services/workshop_updates.py）。
 */
export interface WorkshopUpdateItem {
  workshop_id: string;
  /** 本地文件名（用于和 ModData.name 对上，addons 根目录里的工坊包没有 is_workshop 标记） */
  name: string;
  paths: string[];
  title: string;
  /** 远端最新版的时间戳（秒） */
  remote_time: number;
  /** 本地文件 mtime（秒） */
  local_time: number;
  local_size: number;
  remote_size: number;
  update_available: boolean;
  /** 条目查不到详情（已下架 / 私有化） */
  unavailable: boolean;
}

export interface WorkshopUpdatesState {
  checked_at: number;
  checking: boolean;
  last_error: string;
  auto_check: boolean;
  interval_hours: number;
  items: WorkshopUpdateItem[];
  update_count: number;
  applying: {
    running: boolean;
    total: number;
    done: number;
    current: string;
    pct: number;
    errors: string[];
    finished_at: number;
  };
}

interface AppState {
  gpuAccelerationDisabled: boolean;
  gpuAccelerationLoading: boolean;
  fetchGpuAccelerationStatus: () => Promise<void>;
  toggleGpuAcceleration: () => Promise<void>;
  currentPage: Page;
  theme: 'light' | 'dark';
  /** 主题主色（色卡），默认 PCL 蓝；改它等于整体换肤 */
  accentColor: string;
  setAccentColor: (color: string) => void;
  isMaximized: boolean;
  mods: ModData[];
  scanning: boolean;
  scanProgress: { done: number; total: number | null } | null;
  packs: PackData[];
  status: StatusData | null;
  /** 创意工坊更新检查结果（启动时后端自动查一次，也可手动触发） */
  workshopUpdates: WorkshopUpdatesState | null;
  addonsPath: string | null;
  loading: boolean;
  error: string | null;
  background: BackgroundSettings;
  showMascot: boolean;
  /** 主题切换是否播放过渡动画 */
  themeTransition: boolean;
  /** 是否在标题栏显示实时 FPS（调试） */
  showFps: boolean;
  /**
   * 界面缩放（字号大小）：1 = 100%，默认 1.1（110%）。
   * 由主进程的 webContents.setZoomFactor 实现 —— 页面会按缩放后的像素重新光栅化，
   * 所以放大后字与图标是「更清楚」而不是被拉伸变糊。
   */
  uiScale: number;
  selectedPack: PackData | null;
  contextMenu: { x: number; y: number; modName: string } | null;
  packContextMenu: { x: number; y: number; packId: string } | null;
  backendConnected: boolean;
  retryCount: number;
  setPage: (page: Page) => void;
  toggleMascot: () => void;
  toggleThemeTransition: () => void;
  toggleFps: () => void;
  /** 设置界面缩放（立即生效并持久化，无需重启） */
  setUiScale: (scale: number) => Promise<void>;
  /** 从主进程读取当前生效的界面缩放（启动时同步一次，保证界面显示与实际一致） */
  fetchUiScale: () => Promise<void>;
  toggleTheme: () => void;
  setMaximized: (value: boolean) => void;
  fetchMods: () => Promise<void>;
  /** 读一次工坊更新状态（纯本地计算，很快；后端自动检查的结果也在这里） */
  fetchWorkshopUpdates: () => Promise<void>;
  /** 让后端联网检查一遍（后台跑，结果靠轮询回来） */
  checkWorkshopUpdates: () => Promise<void>;
  /** 更新指定的工坊 Mod（重新下载覆盖），ids 为空 = 更新全部可更新的 */
  applyWorkshopUpdates: (ids?: string[]) => Promise<void>;
  /** 自动检查开关 / 间隔 */
  setWorkshopUpdateSettings: (patch: { auto_check?: boolean; interval_hours?: number }) => Promise<void>;
  fetchStatus: () => Promise<void>;
  fetchSettings: () => Promise<void>;
  setAddonsPath: (path: string) => Promise<boolean>;
  autoDetectPath: () => Promise<void>;
  toggleMod: (modName: string, path?: string) => Promise<void>;
  deleteMod: (modName: string, path?: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  setBackground: (bg: Partial<BackgroundSettings>) => boolean;
  /** 把（可能是超大原图的）背景图压缩到合适尺寸，仅首次需要执行 */
  ensureBackgroundOptimized: () => Promise<void>;
  /** 游戏进程状态（启动按钮的「正在启动 / 游戏中」展示依赖它） */
  gameState: GameState;
  /** 游戏进程 PID（仅 running 时有值） */
  gamePid: number | null;
  /** 进入当前 gameState 的时间戳：启动中用于超时兜底，游戏中用于「已运行」计时 */
  gameStateSince: number | null;
  /** 本次启动方式（steam / direct / already-running），仅用于诊断展示 */
  gameLaunchMethod: string | null;
  /**
   * 启动游戏。点击后**立即**进入 `launching`（按钮先给出动画反馈，不等网络往返），
   * 随后由 ensureGameStatusPolling 的轮询确认游戏是否真的跑起来。
   * 返回 true 表示请求已被接受（不代表游戏一定成功启动）。
   */
  launchGame: () => Promise<boolean>;
  /** 查询一次游戏进程状态（通常由 ensureGameStatusPolling 自动调用） */
  refreshGameStatus: () => Promise<void>;
  /** 启动游戏状态轮询（幂等）。延迟随状态自适应：启动中 1.2s / 游戏中 3s / 空闲 10s */
  ensureGameStatusPolling: () => void;

  createPack: (name: string) => void;
  deletePack: (packId: string) => void;
  renamePack: (packId: string, newName: string) => void;
  addModToPack: (modName: string, packId: string) => void;
  /** 批量把多个 Mod 加入整合包（一次请求，避免逐个请求的竞态） */
  addModsToPack: (modNames: string[], packId: string) => Promise<void>;
  removeModFromPack: (modName: string, packId: string) => void;
  selectPack: (pack: PackData | null) => void;
  setContextMenu: (menu: { x: number; y: number; modName: string } | null) => void;
  setPackContextMenu: (menu: { x: number; y: number; packId: string } | null) => void;
  /**
   * 一键启用/禁用整个整合包。
   * 不传 `enable` 时由**后端**按成员的真实状态决定方向（切换），避免前端算错方向
   * 导致「点了没反应」。返回后端统计（changed/missing/enable）；失败返回 null。
   */
  enablePackMods: (packId: string, enable?: boolean) => Promise<{ changed: number; missing: string[]; enable: boolean } | null>;
  /** 立刻强制刷新 Mod 列表：绕过「正在扫描」的并发保护，保证界面与后端一致 */
  refreshModsNow: () => Promise<void>;
  /**
   * 静默刷新：只更新 mods 数据（含冲突状态），**不**设置扫描中状态、
   * 因此不会弹出「正在扫描 Mod」横幅，也不会锁住按钮。
   */
  fetchModsSilently: () => Promise<void>;
  /**
   * 检测「游戏内已更改」的 Mod 启停（后端比对 addonlist.txt 指纹）。
   * 有变更时写入 pendingAddonlistChanges，由界面弹窗询问用户是否同步。
   */
  checkAddonlistChanges: () => Promise<void>;
  /**
   * 检测「Mod 文件在软件之外发生变化」（Steam 里取消订阅导致 vpk 被删、
   * 新订阅的 Mod 下载完成、手动往 addons 目录增删文件……）：
   * 命中变化就静默刷新列表，让已取消订阅的卡片自动消失。
   */
  checkModsChanges: () => Promise<void>;
  /** 启动「Mod 文件变化」轮询（幂等）。默认 5 秒一次，窗口不可见/扫描中跳过 */
  ensureModsChangePolling: () => void;
  /** 弹窗「同步」：把游戏里的启停改动写进软件记录，并刷新列表 */
  applyAddonlistChanges: () => Promise<void>;
  /** 弹窗「忽略」：保持软件里的设置（启动游戏时以软件为准），不再重复提示 */
  dismissAddonlistChanges: () => Promise<void>;
  /** 待用户确认的游戏内启停变更（空数组 = 无） */
  pendingAddonlistChanges: AddonlistChange[];
  /**
   * 游戏运行期间在软件里改过启停 → 改动要等游戏退出后才会真正生效。
   * 由后端根据 pending_game_reapply 标记给出（游戏退出时会自动以软件设置为准重写文件）。
   */
  pendingReapply: boolean;
  /** 「应用」是否正在执行（按钮 loading） */
  applyingPrefs: boolean;
  /**
   * 是否有 Mod 启停改动还没写回 addonlist.txt（界面左下角的「应用」按钮据此点亮）。
   * 数据以后端 /api/mods/apply-state 为准，改动 Mod 后会立刻置位。
   */
  modsDirty: boolean;
  /** 拉取「应用」按钮状态（dirty / 游戏是否在运行） */
  fetchApplyState: () => Promise<void>;
  /** 界面字体预设 key（见 utils/uiFont.ts 的 FONT_PRESETS） */
  uiFontKey: string;
  /** 切换界面字体（立即生效并记住） */
  setUiFont: (key: string) => void;
  /**
   * 设置某个 Mod 的分类标签（多标签）。
   * 传 null = 恢复「跟随 VPK 内容自动检测」；传数组 = 以该数组为准（可增可删）。
   */
  setModTags: (modName: string, tags: string[] | null) => Promise<void>;
  /**
   * 「应用到游戏」：把软件里记录的启停状态写入 addonlist.txt。
   *
   * L4D2 会在「启动时加载完创意工坊订阅」「进入/退出附加内容（Add-ons）菜单」时重读该文件，
   * 所以游戏运行中点完这个按钮后，进一次游戏内「附加内容」菜单即可让改动生效；
   * 游戏没运行时，下次启动游戏就是最新状态。
   */
  applyModPrefsToGame: () => Promise<void>;
  exportPackAsZip: (packId: string) => Promise<void>;
  fetchPacks: () => Promise<void>;
  renameModDisplayName: (modName: string, newDisplayName: string) => void;
  getModDisplayName: (modName: string) => string | null;
  setModCategory: (modName: string, category: string | null) => Promise<void>;
  confirmDeleteMod: (modName: string) => Promise<void>;
  setDeleteConfirmMod: (modName: string | null) => void;
  deleteConfirmMod: string | null;
  steamUser: SteamUser | null;
  steamLoginInProgress: boolean;
  initiateSteamLogin: () => Promise<void>;
  checkSteamAuth: () => Promise<void>;
  logoutSteam: () => void;
  checkBackendConnection: () => Promise<void>;
  setBackendConnected: (connected: boolean) => void;
  exportLogs: () => Promise<void>;
}

let API_BASE = 'http://127.0.0.1:8288';

/**
 * 主进程在检测到 8288 被其他程序占用并自动改用备用端口时，
 * 会通过 'backend:info' 事件告知渲染进程，这里动态切换后端地址。
 */
export function setBackendApiBase(url: string): boolean {
  if (API_BASE === url) return false;
  API_BASE = url;
  // 后端端口变了：发往旧端口的流式请求不可能再返回数据，
  // 主动中止并复位扫描状态，避免「正在扫描 Mod」永久停留
  abortScan();
  return true;
}

/**
 * 当前后端地址。
 * 8288 被占用时主进程会把后端换到备用端口，此时组件里**不能**再写死
 * http://127.0.0.1:8288（否则缩略图、封面等 URL 会全部 404）。
 */
export function getApiBase(): string {
  return API_BASE;
}

/**
 * mod 名归一化：容忍历史数据里的各种写法差异
 * （`mod-xxx.vpk` 前缀、缺少 `.vpk` 后缀、`workshop\xxx.vpk` 路径、大小写不同）。
 *
 * 整合包成员（后端 mod_ids）是不同版本写进去的字符串，直接用 `===` 比较时
 * 只要有一点写法差异就会匹配不上 —— 于是「一键禁用」改了后端、界面却纹丝不动。
 * 后端 mod_scanner._normalize_mod_key 使用完全相同的规则。
 */
export function normalizeModKey(name: string): string {
  let n = String(name || '').trim().replace(/\\/g, '/');
  const slash = n.lastIndexOf('/');
  if (slash >= 0) n = n.slice(slash + 1);
  if (n.toLowerCase().startsWith('mod-')) n = n.slice(4);
  if (n.toLowerCase().endsWith('.vpk')) n = n.slice(0, -4);
  return n.toLowerCase();
}

// 仅上报「本次进程的首次扫描」耗时：避免后续手动刷新把启动性能数据覆盖成更大的值
let startupScanPerfReported = false;

// ===== 扫描（流式拉取）的看门狗状态 =====
//
// /api/mods/stream 是长连接流式接口。若连接僵死（后端重启、8288 被占用后切到备用端口、
// 中间层吞掉响应……），reader.read() 会永远 pending，`scanning` 就永久停在 true。
// 表现就是用户反馈的「Mod 列表早就加载完了，一切到别的页面却弹出『正在扫描 Mod』」。
// 下面这组状态（空闲看门狗 + 可中止 + 代号校验）保证扫描状态一定会被复位。
const SCAN_IDLE_TIMEOUT_MS = 20000;  // 连续 20 秒收不到任何数据即视为僵死
let scanRunId = 0;                   // 当前扫描代号：旧请求的回调会被丢弃
let scanAbort: AbortController | null = null;
let scanLastActivity = 0;            // 最近一次收到数据的时间（performance.now）
// 扫描进行中被跳过的刷新请求：扫描结束后自动补一次
// （否则「扫描期间做了启用/禁用」在界面上不会体现 —— 看起来像点了没反应）
let pendingModsRefresh = false;
// 静默刷新的去抖定时器与请求序号：连点启停时会连续触发刷新，
// 一来没必要（后端数据每次都一样），二来多个请求乱序返回会把界面刷回旧状态。
let silentFetchTimer: ReturnType<typeof setTimeout> | null = null;
let silentFetchSeq = 0;

/** 计划一次静默刷新（去抖 300ms；连续操作只跑最后一次） */
function scheduleSilentModsRefresh() {
  if (silentFetchTimer) clearTimeout(silentFetchTimer);
  silentFetchTimer = setTimeout(() => {
    silentFetchTimer = null;
    useStore.getState().fetchModsSilently();
  }, 300);
}

/** 中止正在进行的扫描，并把 scanning/scanProgress 复位（后端断开、后端端口变化时调用） */
function abortScan() {
  scanAbort?.abort();
  scanAbort = null;
  scanRunId += 1;  // 让旧请求的回调失效
  const state = useStore.getState();
  if (state.scanning) {
    useStore.setState({ scanning: false, scanProgress: null });
  }
}

// ===== 后台请求超时 =====
//
// 浏览器（Chromium）对同一个 origin 只允许 6 条并发连接。若某个请求永远不返回
// （后端卡住/卡死后端线程池），它就会永久占着一条连接；这类请求攒到 6 条，
// **连 /api/health 都发不出去**，界面就表现为「整个软件卡死」——
// 这正是「改启停/点应用之后卡死」事故中被放大的那一环（后端锁泄漏是根因，
// 见 backend/services/mod_scanner.py 的 _ScanLock 复盘）。
// 所以：所有非流式的后台请求都必须带超时，超时就放弃这次请求，让连接能被回收。
const BACKGROUND_FETCH_TIMEOUT_MS = 15000;

/** 带超时的 fetch（仅用于不需要外部 signal 的后台请求） */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = BACKGROUND_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ===== 「Mod 文件在软件之外发生变化」的轮询 =====
//
// 用户在 Steam 里取消订阅、新订阅的 Mod 下载完成、手动往 addons 目录丢文件……
// 这些变化软件是感知不到的（没有文件监听），于是「已取消订阅的 Mod 卡片还留在
// 界面上」成为最常见的反馈。这里定期问一次后端「磁盘上的文件集合与上次扫描
// 是否一致」（/api/mods/scan-status，后端只做 glob + stat，开销极小），
// 命中变化就静默刷新列表 —— 不需要用户手动刷新，也不会弹出扫描横幅。
const MODS_CHANGE_POLL_MS = 5000;

let modsChangePollTimer: ReturnType<typeof setTimeout> | null = null;
let modsChangeVisibilityHooked = false;

/** 安排下一次「文件变化」轮询（幂等：重复调用只会重置定时器，不会产生多个循环） */
function scheduleModsChangePoll() {
  if (modsChangePollTimer) clearTimeout(modsChangePollTimer);
  modsChangePollTimer = setTimeout(async () => {
    try {
      await useStore.getState().checkModsChanges();
    } finally {
      // 无论成功失败都继续排期（后端暂时不可用时下次再试）
      scheduleModsChangePoll();
    }
  }, MODS_CHANGE_POLL_MS);
}


// ===== 游戏进程状态的轮询调度 =====
//
// 后端 /api/game/status 用 tasklist 查询 left4dead2.exe（自带 2 秒缓存）。
// 前端按状态自适应轮询频率：启动中要快（尽快把按钮从「正在启动」切到「游戏中」），
// 游戏中 3 秒（及时感知退出），空闲 10 秒（几乎零开销）。
const GAME_POLL_DELAY_MS: Record<GameState, number> = {
  idle: 10000,
  launching: 1200,
  running: 3000,
};

/** 启动确认超时：超过这个时间还没检测到进程就回到 idle（Steam 弹窗/校验/被拦截等） */
const GAME_LAUNCH_TIMEOUT_MS = 90000;

/** 连续两次都查不到进程才判定「游戏已退出」，避免 tasklist 偶发抖动导致状态闪烁 */
const GAME_EXIT_CONFIRMATIONS = 2;

let gamePollTimer: ReturnType<typeof setTimeout> | null = null;
let gameMissCount = 0;

/**
 * 安排下一次游戏状态轮询。每次调用都会重置定时器，
 * 因此「状态刚变化时立刻重新排期」可以马上切到新的频率。
 */
function scheduleGamePoll() {
  if (gamePollTimer) clearTimeout(gamePollTimer);
  const delay = GAME_POLL_DELAY_MS[useStore.getState().gameState] ?? GAME_POLL_DELAY_MS.idle;
  gamePollTimer = setTimeout(async () => {
    try {
      await useStore.getState().refreshGameStatus();
    } finally {
      // 无论成功失败都继续排期：状态可能已变化，这里会采用新的延迟
      scheduleGamePoll();
    }
  }, delay);
}

let workshopPollTimer: ReturnType<typeof setTimeout> | null = null;
/** 上一次轮询时「是否正在更新」，用来在跑完的那一刻弹一次结果提示 */
let workshopApplyingBefore = false;
/** 上一次轮询时「是否正在检查更新」，同样用来在检查结束那一刻给个结果 */
let workshopCheckingBefore = false;
/**
 * 这一轮检查是谁发起的：
 * - 'manual' 用户点了「检查更新」/「立即检查」→ 无论有没有新版本都要回一句，
 *   否则点完按钮什么也没发生，像是没反应；
 * - 'auto' 启动时后端自己查的 → 只有发现新版本或出错才提示，别每次开软件都报平安。
 */
let workshopCheckIntent: 'manual' | 'auto' | null = null;

/**
 * 检查/更新过程中的状态轮询。检查要联网、更新要下载，都可能持续几十秒，
 * 全靠后端状态快照驱动界面；一旦两边都空闲就停表，不留空转的定时器。
 */
function scheduleWorkshopUpdatePoll() {
  if (workshopPollTimer) clearTimeout(workshopPollTimer);
  workshopPollTimer = setTimeout(async () => {
    try {
      await useStore.getState().fetchWorkshopUpdates();
    } finally {
      const st = useStore.getState().workshopUpdates;
      if (st && (st.checking || st.applying.running)) scheduleWorkshopUpdatePoll();
    }
  }, 1200);
}

/** 把「已运行时长」格式化成 mm:ss / h:mm:ss */
export function formatGameElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

const DEFAULT_BACKGROUND: BackgroundSettings = {
  imagePath: null,
  blur: 8,
  dim: 30,
  opacity: 100,
  // 默认 0 = 保持原有观感；越高界面越透，最高可透出底层背景图
  uiTransparency: 0,
};

/** 读取历史数据时把数值限制在有效区间，避免脏数据把界面撑坏 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

function loadBackground(): BackgroundSettings {
  try {
    const saved = localStorage.getItem('l4d2-bg-settings');
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<BackgroundSettings>;
      return {
        imagePath: typeof parsed.imagePath === 'string' ? parsed.imagePath : null,
        blur: clampNumber(parsed.blur, 0, 20, DEFAULT_BACKGROUND.blur),
        dim: clampNumber(parsed.dim, 0, 80, DEFAULT_BACKGROUND.dim),
        // 老版本没有 opacity 字段，缺失时按"背景完全可见"处理
        opacity: clampNumber(parsed.opacity, 0, 100, DEFAULT_BACKGROUND.opacity),
        // 老版本没有 uiTransparency 字段，缺失时按"保持原有观感"处理
        uiTransparency: clampNumber(
          parsed.uiTransparency,
          0,
          100,
          DEFAULT_BACKGROUND.uiTransparency
        ),
      };
    }
  } catch {}
  return { ...DEFAULT_BACKGROUND };
}

function loadMascotVisible(): boolean {
  try {
    const saved = localStorage.getItem('l4d2-mascot-visible');
    if (saved !== null) return JSON.parse(saved);
  } catch {}
  return true;
}

/** 主题切换是否播放过渡动画（默认开；机器卡的用户可在设置里关掉） */
function loadThemeTransition(): boolean {
  try {
    const saved = localStorage.getItem('l4d2-theme-transition');
    if (saved !== null) return JSON.parse(saved);
  } catch {}
  return true;
}

function saveThemeTransition(enabled: boolean) {
  try {
    localStorage.setItem('l4d2-theme-transition', JSON.stringify(enabled));
  } catch {}
}

/** 是否在标题栏显示实时 FPS（默认关；调试用） */
function loadShowFps(): boolean {
  try {
    const saved = localStorage.getItem('l4d2-show-fps');
    if (saved !== null) return JSON.parse(saved);
  } catch {}
  return false;
}

function saveShowFps(enabled: boolean) {
  try {
    localStorage.setItem('l4d2-show-fps', JSON.stringify(enabled));
  } catch {}
}

// ── 界面缩放（字号大小）───────────────────────────────────────────────
// 用户反馈「软件内字体太小 / 不清晰」。除了把过小字号抬到 12px 底线、提高次要文字
// 对比度之外，这里提供整体缩放：主进程用 webContents.setZoomFactor 实现，
// Chromium 会按缩放后的设备像素重新光栅化，所以字体是变清晰而不是被拉糊。
/** 取值边界（与主进程 main.ts 里的 UI_SCALE_MIN/MAX 保持一致） */
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 2.0;
/** 默认 110%：既不显得挤，又比原来明显清晰 */
export const DEFAULT_UI_SCALE = 1.1;

function clampUiScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_UI_SCALE;
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value));
  return Math.round(clamped * 100) / 100;
}

function loadUiScale(): number {
  try {
    const saved = localStorage.getItem('l4d2-ui-scale');
    if (saved !== null) return clampUiScale(Number(JSON.parse(saved)));
  } catch {}
  return DEFAULT_UI_SCALE;
}

function saveUiScale(scale: number) {
  try {
    localStorage.setItem('l4d2-ui-scale', JSON.stringify(scale));
  } catch {}
}

function saveBackground(bg: BackgroundSettings): boolean {
  try {
    localStorage.setItem('l4d2-bg-settings', JSON.stringify(bg));
    return true;
  } catch (e) {
    // 图片过大时可能触发 localStorage 配额限制
    console.error('[store] 保存背景设置失败:', e);
    return false;
  }
}

function loadTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('l4d2-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  // PCL 风格默认亮色
  return 'light';
}

function saveTheme(theme: 'light' | 'dark') {
  localStorage.setItem('l4d2-theme', theme);
}

function loadModDisplayNames(): Record<string, string> {
  try {
    const saved = localStorage.getItem('l4d2-mod-display-names');
    if (saved) return JSON.parse(saved);
  } catch {}
  return {};
}

function saveModDisplayNames(names: Record<string, string>) {
  localStorage.setItem('l4d2-mod-display-names', JSON.stringify(names));
}

export const useStore = create<AppState>((set, get) => ({
  currentPage: 'my-mods',
  theme: loadTheme(),
  accentColor: loadAccent(),
  isMaximized: false,
  mods: [],
  scanning: false,
  scanProgress: null,
  packs: [],
  status: null,
  workshopUpdates: null,
  addonsPath: null,
  loading: false,
  error: null,
  background: loadBackground(),
  showMascot: loadMascotVisible(),
  themeTransition: loadThemeTransition(),
  showFps: loadShowFps(),
  uiScale: loadUiScale(),
  selectedPack: null,
  contextMenu: null,
  packContextMenu: null,
  deleteConfirmMod: null,
  steamUser: null,
  steamLoginInProgress: false,
  backendConnected: false,
  retryCount: 0,
  gpuAccelerationDisabled: false,
  gpuAccelerationLoading: false,
  gameState: 'idle',
  gamePid: null,
  gameStateSince: null,
  gameLaunchMethod: null,
  pendingAddonlistChanges: [],
  pendingReapply: false,
  applyingPrefs: false,
  modsDirty: false,
  uiFontKey: loadUiFontKey(),
  
  exportLogs: async () => {
    // 1) 后端在线时优先走后端 API（含 mods 快照等更完整信息）
    let backendExported = false;
    try {
      const res = await fetch(`${API_BASE}/api/logs/export`);
      if (res.ok) {
        // Download the zip file
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        // Extract filename from Content-Disposition header, or use default
        const cdHeader = res.headers.get('Content-Disposition');
        let filename = `L4Director_logs.zip`;
        if (cdHeader) {
          const match = cdHeader.match(/filename\*?=UTF-8''([^;\s]+)/i);
          if (match) {
            filename = decodeURIComponent(match[1]);
          }
        }
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        backendExported = true;
      }
    } catch { /* 后端不可用，走下面的本地导出 */ }

    if (!backendExported) {
      // 2) 后端连不上/导出失败时，回退到主进程本地导出（收集本地日志，不依赖后端）
      const api = (window as any).electronAPI as any;
      if (api && typeof api.exportLogs === 'function') {
        try {
          const r = await api.exportLogs();
          if (r && r.canceled) return; // 用户取消，不算错误
          if (r && r.ok) return;
          set({ error: '导出日志失败: ' + ((r && r.error) || '未知错误') });
        } catch (e) {
          set({ error: '导出日志失败: ' + String(e) });
        }
        return;
      }
      set({ error: '导出日志失败: 无法连接到后端服务' });
    }
  },

  checkBackendConnection: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok') {
          // 只有状态真的变化时才 set，避免每次轮询都触发整树重渲染
          if (!get().backendConnected || get().retryCount !== 0) {
            set({ backendConnected: true, retryCount: 0 });
          }
          return;
        }
      }
    } catch {
      // 连接失败按“未连接”处理（冷启动阶段后端可能还没起来）
    }
    // 未连接：累计失败次数（用于提示文案与错误提示的轮询退避）
    // 同时中止正在进行的扫描：连接都没了，流式请求不可能再有数据回来，
    // 否则「正在扫描 Mod」会永久停留（切到别的页面就会弹出这个横幅）
    if (get().scanning) abortScan();
    set((state) => ({
      backendConnected: false,
      retryCount: state.retryCount + 1,
    }));
  },
  
  setBackendConnected: (connected: boolean) => {
    set({ backendConnected: connected, retryCount: connected ? 0 : get().retryCount + 1 });
  },

  fetchGpuAccelerationStatus: async () => {
    if (!(window as any).electronAPI?.getGpuAccelerationStatus) return;
    set({ gpuAccelerationLoading: true });
    try {
      const status = await (window as any).electronAPI.getGpuAccelerationStatus();
      set({ gpuAccelerationDisabled: status.gpuAccelerationDisabled, gpuAccelerationLoading: false });
    } catch (e) {
      console.error('Failed to fetch GPU acceleration status:', e);
      set({ gpuAccelerationLoading: false });
    }
  },

  toggleGpuAcceleration: async () => {
    if (!(window as any).electronAPI?.setGpuAcceleration) return;
    const current = get().gpuAccelerationDisabled;
    const newValue = !current;
    set({ gpuAccelerationDisabled: newValue, gpuAccelerationLoading: true });
    try {
      const result = await (window as any).electronAPI.setGpuAcceleration(newValue);
      if (!result.success) {
        // Revert on failure
        set({ gpuAccelerationDisabled: current });
        console.error('Failed to toggle GPU acceleration:', result.error);
      }
      set({ gpuAccelerationLoading: false });
    } catch (e) {
      set({ gpuAccelerationDisabled: current, gpuAccelerationLoading: false });
      console.error('Failed to toggle GPU acceleration:', e);
    }
  },

  setPage: (page) => set({ currentPage: page }),
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === 'light' ? 'dark' : 'light';
      saveTheme(next);
      // 不透明窗口的底色要跟着主题走：否则切到日间后窗口边缘仍是深色，
      // 又变成「显示的边界和窗口边界不一致」的观感。
      (window as any).electronAPI?.setWindowTheme?.(next);
      return { theme: next };
    }),
  // 换主题色：立刻写 CSS 变量（皮肤整体跟着变），并记住选择
  setAccentColor: (color) =>
    set((state) => {
      const hex = normalizeHex(color) || DEFAULT_ACCENT;
      saveAccent(hex);
      applyAccent(hex, state.theme);
      return { accentColor: hex };
    }),
  setMaximized: (value) => set({ isMaximized: value }),

  launchGame: async () => {
    const state = get();

    // 正在启动：忽略重复点击，只给个提示，避免连点拉起多个启动请求
    if (state.gameState === 'launching') {
      showToast('游戏正在启动中，请稍候…', 'info');
      return true;
    }
    // 已经在游戏中：同样不重复启动（后端也会拦一层）
    if (state.gameState === 'running') {
      showToast('游戏已经在运行中啦', 'info');
      return true;
    }

    // 点击立刻进入「正在启动」：按钮马上开始播放动画，不等网络往返，
    // 否则后端在写 addonlist.txt / 查 Steam 路径时按钮会「毫无反应」。
    set({
      gameState: 'launching',
      gamePid: null,
      gameStateSince: Date.now(),
      gameLaunchMethod: null,
    });
    gameMissCount = 0;
    scheduleGamePoll(); // 立刻切到 1.2s 的快轮询，尽快确认游戏是否真的起来了

    try {
      const res = await fetch(`${API_BASE}/api/game/launch`, { method: 'POST' });
      const data = await res.json().catch(() => ({} as any));

      if (res.ok) {
        set({ gameLaunchMethod: typeof data.method === 'string' ? data.method : null });
        showToast(`${data.message || '游戏已启动'}`, 'success');
        return true;
      }

      // 失败（例如没配置 Addons 目录）：退回 idle，让按钮恢复可点
      set({ gameState: 'idle', gamePid: null, gameStateSince: null, gameLaunchMethod: null });
      const detail = (data && data.detail) || '启动游戏失败';
      console.error('Launch game error:', detail);
      showToast(`${detail}`, 'error');
      return false;
    } catch (e) {
      set({ gameState: 'idle', gamePid: null, gameStateSince: null, gameLaunchMethod: null });
      console.error('Launch game error:', e);
      showToast('启动游戏失败：无法连接到后端服务', 'error');
      return false;
    }
  },

  refreshGameStatus: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/game/status`);
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data) return;

      const running = Boolean(data.running);
      const pid = typeof data.pid === 'number' ? data.pid : null;
      // 后端在「游戏运行期间软件里改过启停、游戏刚退出」时，会把软件设置重新写回
      // addonlist.txt（否则会被游戏内存里的旧状态覆盖）。这里给出明确反馈。
      const reapplied = typeof data.reapplied === 'number' ? data.reapplied : null;
      if (reapplied !== null && reapplied > 0) {
        showToast(`游戏已退出：已按软件设置重新应用 ${reapplied} 个 Mod 的启停`, 'success');
      }
      // 游戏运行期间改过启停（后端标记未消费）→ 界面要提示「退出游戏后才会生效」
      const pendingReapply = Boolean(data.pending_reapply);
      if (get().pendingReapply !== pendingReapply) set({ pendingReapply });
      const state = get();

      if (running) {
        gameMissCount = 0;
        // 只有状态真的变化时才 set，避免每次轮询都触发重渲染
        if (state.gameState !== 'running' || state.gamePid !== pid) {
          set({ gameState: 'running', gamePid: pid, gameStateSince: Date.now() });
        }
        return;
      }

      // 未检测到进程
      if (state.gameState === 'idle') return;

      if (state.gameState === 'launching') {
        // 还没起来：超时后放弃等待，避免按钮永远停在「正在启动」
        if (state.gameStateSince && Date.now() - state.gameStateSince > GAME_LAUNCH_TIMEOUT_MS) {
          set({ gameState: 'idle', gamePid: null, gameStateSince: null, gameLaunchMethod: null });
          showToast('等待游戏启动超时，请检查 Steam 是否正常弹出了启动提示', 'warning');
        }
        return;
      }

      // running -> idle：需要连续两次确认，防止偶发的检测失败让按钮闪回「启动游戏」
      gameMissCount += 1;
      if (gameMissCount >= GAME_EXIT_CONFIRMATIONS) {
        gameMissCount = 0;
        set({ gameState: 'idle', gamePid: null, gameStateSince: null, gameLaunchMethod: null });
        showToast('游戏已退出', 'info');
        // 用户很可能刚在游戏里（Add-ons 菜单）启用了/禁用了 Mod：游戏退出时会把改动写回
        // addonlist.txt。稍等一下（Steam 云同步可能还在写文件）再检测一次，检测到就弹窗
        // 询问「是否同步」，由用户决定（不会自动改动任何一边的设置）。
        window.setTimeout(() => { get().checkAddonlistChanges(); }, 1500);
      }
    } catch {
      // 后端不可用：保持当前状态不动（避免误报「游戏已退出」）
    }
  },

  ensureGameStatusPolling: () => {
    // 幂等：scheduleGamePoll 内部会先清掉旧定时器，重复调用不会产生多个循环
    scheduleGamePoll();
  },

  setBackground: (partial) => {
    let saved = true;
    set((state) => {
      const updated = { ...state.background, ...partial };
      saved = saveBackground(updated);
      return { background: updated };
    });
    return saved;
  },

  /**
   * 老版本把用户选择的原图（可能几千万像素）直接存进了 localStorage，
   * 会导致解码内存暴涨、GPU 纹理超限而卡顿；这里在启动时做一次性压缩迁移。
   */
  ensureBackgroundOptimized: async () => {
    const current = get().background.imagePath;
    if (!current) return;
    // 标记位用于避免重复处理；但若存的仍是"重图"（例如旧版本又写入过一次大图），
    // 也要重新压缩一次
    if (isBackgroundOptimized() && current.length <= BACKGROUND_HEAVY_CHARS) return;
    try {
      const optimized = await optimizeBackgroundImage(current);
      if (optimized !== current) {
        get().setBackground({ imagePath: optimized });
        console.info('[store] 背景图已压缩优化，体积:', current.length, '->', optimized.length);
      }
    } catch (e) {
      console.warn('[store] 背景图优化失败，保留原图:', e);
    } finally {
      // 无论成功与否都标记，避免每次启动重复处理
      markBackgroundOptimized();
    }
  },

  toggleMascot: () => {
    set((state) => {
      const newVal = !state.showMascot;
      localStorage.setItem('l4d2-mascot-visible', JSON.stringify(newVal));
      return { showMascot: newVal };
    });
  },

  toggleThemeTransition: () => {
    set((state) => {
      const newVal = !state.themeTransition;
      saveThemeTransition(newVal);
      return { themeTransition: newVal };
    });
  },

  toggleFps: () => {
    set((state) => {
      const newVal = !state.showFps;
      saveShowFps(newVal);
      return { showFps: newVal };
    });
  },

  setUiScale: async (scale: number) => {
    const next = clampUiScale(scale);
    const prev = get().uiScale;
    set({ uiScale: next });
    saveUiScale(next);

    const api = (window as any).electronAPI;
    if (!api?.setUiScale) {
      // 浏览器里调试（没有 Electron 桥）：退回 CSS zoom，同样能放大且重新光栅化
      document.documentElement.style.zoom = String(next);
      return;
    }
    try {
      const result = await api.setUiScale(next);
      if (result && result.success === false) {
        set({ uiScale: prev });
        saveUiScale(prev);
        showToast('界面缩放设置失败，已恢复原值', 'error');
        return;
      }
      // 以主进程实际生效的值（做了边界收敛）为准
      const applied = clampUiScale(Number(result?.scale ?? next));
      if (applied !== next) {
        set({ uiScale: applied });
        saveUiScale(applied);
      }
      showToast(`界面缩放已设为 ${Math.round(applied * 100)}%`, 'success');
    } catch (e) {
      console.error('setUiScale error:', e);
      set({ uiScale: prev });
      saveUiScale(prev);
      showToast('界面缩放设置失败', 'error');
    }
  },

  fetchUiScale: async () => {
    const api = (window as any).electronAPI;
    // 主进程在窗口创建时就按配置文件设置了 zoom factor，因此这里的返回值才是权威值
    // （localStorage 只用于首屏渲染前的兜底展示）
    if (!api?.getUiScale) {
      document.documentElement.style.zoom = String(get().uiScale);
      return;
    }
    try {
      const result = await api.getUiScale();
      const scale = clampUiScale(Number(result?.scale));
      saveUiScale(scale);
      if (scale !== get().uiScale) set({ uiScale: scale });
    } catch (e) {
      console.error('fetchUiScale error:', e);
    }
  },

  applyModPrefsToGame: async () => {
    if (get().applyingPrefs) return;
    const running = get().gameState === 'running';
    set({ applyingPrefs: true });
    try {
      const res = await fetch(`${API_BASE}/api/mods/apply-prefs`, { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || `HTTP ${res.status}`);
      }
      const data = await res.json().catch(() => ({} as any));
      const count = typeof data?.count === 'number' ? data.count : 0;
      if (running) {
        // 游戏已把 Add-ons 读进内存：需要在游戏里进一次「附加内容」菜单让它重读文件
        showToast(
          `已写入 addonlist.txt（${count} 项）：请在游戏里打开一次「附加内容」菜单让游戏重读（退出游戏后也会自动生效）`,
          'success'
        );
      } else {
        showToast(`已应用：${count} 项设置已写入 addonlist.txt，下次启动游戏即生效`, 'success');
      }
      // 应用成功：清掉「未应用」标记（左下角按钮熄灭），并同步游戏状态
      set({ modsDirty: false });
      get().refreshGameStatus();
      get().fetchApplyState();
    } catch (e: any) {
      console.error('applyModPrefsToGame error:', e);
      showToast(`应用失败：${e?.message || '无法连接到后端服务'}`, 'error');
    } finally {
      set({ applyingPrefs: false });
    }
  },

  setUiFont: (key: string) => {
    saveUiFontKey(key);
    applyUiFont(key);
    set({ uiFontKey: key });
  },

  fetchApplyState: async () => {
    if (!get().backendConnected) return;
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/mods/apply-state`);
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data) return;
      const dirty = Boolean(data.dirty);
      if (get().modsDirty !== dirty) set({ modsDirty: dirty });
    } catch {
      // 后端不可用时保持现状：下次改动或刷新还会再拉
    }
  },

  setModTags: async (modName: string, tags: string[] | null) => {
    try {
      const encoded = encodeURIComponent(modName);
      const res = await fetch(`${API_BASE}/api/mods/${encoded}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || `HTTP ${res.status}`);
      }
      const data = await res.json().catch(() => ({} as any));
      const newTags: string[] = Array.isArray(data?.tags) ? data.tags : [];
      const manual = Boolean(data?.manual);
      // 局部更新这张卡片（不触发全量扫描）
      const key = normalizeModKey(modName);
      set((state) => ({
        mods: state.mods.map((m) =>
          normalizeModKey(m.name) === key
            ? { ...m, tags: newTags, tags_manual: manual }
            : m
        ),
      }));
      if (tags === null) {
        showToast('已恢复为自动检测的分类', 'info');
      } else if (newTags.length === 0) {
        showToast('已清空该 Mod 的分类标签', 'info');
      } else {
        showToast(`分类已更新：${newTags.join(' / ')}`, 'success');
      }
    } catch (e: any) {
      console.error('setModTags error:', e);
      showToast(`分类修改失败：${e?.message || '无法连接到后端服务'}`, 'error');
    }
  },

  fetchMods: async () => {
    // 后端未连接时先不加载；等连接上后再由 App 触发
    if (!get().backendConnected) return;
    // 避免并发重复拉取；但上一次扫描若已经僵死（长时间收不到数据），允许抢占重试
    if (get().scanning) {
      if (scanLastActivity && performance.now() - scanLastActivity < SCAN_IDLE_TIMEOUT_MS) {
        // 扫描正在正常进行：记下这次刷新请求，等扫描结束后自动补一次。
        // 直接 return 会让「扫描期间用户点的启用/禁用」在界面上不体现出来。
        pendingModsRefresh = true;
        return;
      }
      abortScan();
    }

    const runId = ++scanRunId;
    const controller = new AbortController();
    scanAbort = controller;
    scanLastActivity = performance.now();

    // 空闲看门狗：流式接口正常会持续推送；长时间毫无动静说明连接已僵死，
    // 主动中止（由 finally 复位 scanning），避免「正在扫描 Mod」永久停留
    const watchdog = setInterval(() => {
      if (performance.now() - scanLastActivity > SCAN_IDLE_TIMEOUT_MS) {
        controller.abort();
      }
    }, 2000);

    set({ scanning: true, scanProgress: { done: get().mods.length, total: null }, error: null });
    const perfStart = performance.now();
    let perfFirstReported = false;
    const reportPerf = (name: string, extra: Record<string, any> = {}) => {
      (window as any).electronAPI?.reportPerf?.(name, {
        elapsed: Math.round(performance.now()),
        ...extra,
      });
    };
    try {
      const res = await fetch(`${API_BASE}/api/mods/stream`, { signal: controller.signal });
      if (!res.ok || !res.body) {
        // 旧后端或无流支持时回退到一次性接口
        const data = await res.json();
        set({ mods: (data && data.mods) || [], error: null });
        if (!startupScanPerfReported) {
          startupScanPerfReported = true;
          reportPerf('first-mod', { fallback: true, renderer_first_mod_ms: Math.round(performance.now() - perfStart) });
          reportPerf('scan-done', { fallback: true, count: (data && data.mods)?.length ?? 0 });
        }
        return;
      }

      // 非首次刷新时保留已有数据，避免界面闪空；逐块批量更新，实现“收一个显示一个”
      // 且不会每次事件都整表重渲。
      // 键用**路径**而不是文件名：addons 根目录与 workshop 下可能各有一份同名 vpk
      //（同一个 Mod 既订阅了工坊、又被手动拖进来），用文件名当键会让两条互相覆盖，
      // 一次流式刷新后只剩一条，而静默刷新（/api/mods 数组）又变回两条。
      const modsMap = new Map<string, ModData>();
      if (get().mods.length > 0) {
        for (const m of get().mods) modsMap.set(modKey(m), m);
      }
      const streamSeen = new Set<string>();

      let total: number | null = null;
      let backendDone: Record<string, any> | null = null;
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        scanLastActivity = performance.now();
        buffer += decoder.decode(value, { stream: true });

        let changed = false;
        let conflictsChanged = false;
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'meta') {
              total = evt.total ?? total;
            } else if (evt.type === 'done') {
              backendDone = evt;
            } else if (evt.type === 'mod') {
              const m = evt.mod as ModData;
              if (m && m.name) {
                modsMap.set(modKey(m), m);
                streamSeen.add(modKey(m));
                changed = true;
                if (!perfFirstReported) {
                  perfFirstReported = true;
                  reportPerf('first-mod', {
                    renderer_first_mod_ms: Math.round(performance.now() - perfStart),
                  });
                }
              }
            } else if (evt.type === 'conflict' && evt.name && Array.isArray(evt.conflicts)) {
              const cur = modsMap.get(evt.name);
              if (cur) {
                cur.conflicts = evt.conflicts;
                if (Array.isArray(evt.conflict_details)) cur.conflict_details = evt.conflict_details;
                if (Array.isArray(evt.conflict_hints)) cur.conflict_hints = evt.conflict_hints;
                if (evt.role) cur.role = evt.role;
                if (Array.isArray(evt.role_tags)) cur.role_tags = evt.role_tags;
              }
              conflictsChanged = true;
            } else if (evt.type === 'duplicates' && evt.items) {
              // 重复安装只能等全部包解析完才能判定，后端单独补一条事件。
              // 键是文件路径（同名文件可能有两份，文件名不唯一）。
              for (const [key, refs] of Object.entries(evt.items as Record<string, DuplicateRef[]>)) {
                const target = modsMap.get(key);
                if (!target) continue;
                target.duplicates = refs;
                target.duplicate_kind = refs.some((r) => r.kind === 'content') ? 'content' : 'version';
                conflictsChanged = true;
              }
            }
          } catch { /* 跳过异常/半行 */ }
          nl = buffer.indexOf('\n');
        }

        // 每收到一个网络 chunk 就刷新一次，进度与列表渐进更新
        if (changed || conflictsChanged || total != null) {
          set({
            mods: Array.from(modsMap.values()),
            scanProgress: { done: streamSeen.size, total },
          });
        }
      }

      // 清理已从磁盘删除的 mod（本次流中未出现的旧条目）
      if (streamSeen.size > 0) {
        for (const key of Array.from(modsMap.keys())) {
          if (!streamSeen.has(key)) modsMap.delete(key);
        }
      }

      set({ mods: Array.from(modsMap.values()), error: null });

      // 上报「扫描完成」耗时（含后端自己的统计），作为加载速度基准的最终里程碑
      if (!startupScanPerfReported) {
        startupScanPerfReported = true;
        reportPerf('scan-done', {
          count: modsMap.size,
          backend_mode: backendDone?.cached ? 'cached' : 'full',
          backend_elapsed_ms: backendDone?.elapsed_ms ?? null,
          backend_first_mod_ms: backendDone?.first_mod_ms ?? null,
          renderer_total_ms: Math.round(performance.now() - perfStart),
        });
      }
    } catch (e) {
      // 看门狗超时或后端端口切换导致的中止不算错误，不必打扰用户
      if (!controller.signal.aborted) {
        console.error('fetchMods error:', e);
        set({ error: '无法连接到后端服务' });
      }
    } finally {
      clearInterval(watchdog);
      if (scanAbort === controller) scanAbort = null;
      // 只有仍是本轮扫描时才复位，避免过期请求把新一轮扫描的状态清掉
      if (runId === scanRunId) {
        set({ scanning: false, scanProgress: null });
        if (pendingModsRefresh) {
          pendingModsRefresh = false;
          setTimeout(() => { get().fetchMods(); }, 0);
        }
        // 每次扫描结束后顺手检测一次「游戏内更改」：覆盖「软件一直开着、用户在游戏里
        // 改完退出」「Steam 云把文件同步回来」等场景（已有的弹窗不会被重复弹出）。
        get().checkAddonlistChanges();
      }
    }
  },

  // 批量启用/禁用之后必须能立刻看到结果：这里先中止可能残留的扫描（否则 fetchMods
  // 会被并发保护直接跳过），再重新拉取一次。
  refreshModsNow: async () => {
    abortScan();
    await get().fetchMods();
  },

  // 静默刷新：一次性接口，只替换 mods 数据，不碰 scanning/进度。
  // 用于「启用/禁用之后同步冲突状态」——不会有扫描横幅，也不会阻塞按钮。
  // 带超时：后端若卡住，不能让这条连接永远挂着（见 fetchWithTimeout 的说明）。
  fetchModsSilently: async () => {
    const seq = ++silentFetchSeq;
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/mods`);
      if (!res.ok) return;
      const data = await res.json();
      // 期间又发起了新的静默刷新 → 丢弃这次过期响应，避免把界面刷回旧状态
      if (seq !== silentFetchSeq) return;
      if (data && Array.isArray(data.mods)) {
        set({ mods: data.mods });
      }
    } catch {
      // 静默刷新失败无需打扰用户（下次扫描或手动刷新会纠正）
    }
  },

  // 检测游戏内改过的 Mod 启停：后端比对 addonlist.txt 的内容指纹（软件自己写的文件
  // 指纹一致 → 没有外部改动），有变更就弹窗询问用户，而不是自动覆盖任何一边的设置。
  checkAddonlistChanges: async () => {
    if (!get().backendConnected) return;
    // 注意：游戏运行中要不要弹「检测到游戏内已更改」由**后端**判断 ——
    // 只有「游戏运行中 + 用户在软件里刚改过启停」时才抑制（那种差异是游戏把它内存里的
    // 旧状态回写造成的，弹窗会诱导用户点「同步」把软件里的设置撤销）；
    // 用户在游戏「附加内容」菜单里自己改的，照常提示。
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/mods/addonlist-changes`);
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      const changes: AddonlistChange[] = Array.isArray(data?.changes) ? data.changes : [];
      const current = get().pendingAddonlistChanges;
      // 没有变化就不要重复 set：避免弹窗在用户操作过程中被无谓地重渲染
      if (changes.length === 0 && current.length === 0) return;
      set({ pendingAddonlistChanges: changes });
    } catch {
      // 后端不可用时静默：下次扫描或游戏退出时会再检测
    }
  },

  // 「Mod 文件在软件之外变化」的检测：后端 /api/mods/scan-status 会用
  // scan_manifest（每次扫描后写入）与当前磁盘做对比。
  // 命中变化 → 静默刷新列表：已取消订阅的 Mod 卡片会随之消失，
  // 新下载/新丢进来的 Mod 也会自动出现。
  checkModsChanges: async () => {
    const state = get();
    if (!state.backendConnected) return;
    // 窗口在后台时不必轮询：既没有观感收益，也只是白白唤醒磁盘
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    // 正在扫描时不要插队（扫描结束后会自然排到下一次轮询）
    if (state.scanning) return;
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/mods/scan-status`, {}, 10000);
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data || !data.changed) return;
      console.log('[Mods] 检测到 addons 目录变化：', data.reason, data.added, data.removed);
      await get().fetchModsSilently();
    } catch {
      // 后端不可用或超时：下一次轮询再试
    }
  },

  ensureModsChangePolling: () => {
    // 幂等：scheduleModsChangePoll 内部会先清掉旧定时器，重复调用不会产生多个循环
    scheduleModsChangePoll();
    // 窗口从后台切回时立刻查一次：用户在 Steam 里取消订阅后切回软件，
    // 不用再等一个轮询周期；同时重置节奏，避免刚切回来又立刻轮询。
    if (!modsChangeVisibilityHooked && typeof document !== 'undefined') {
      modsChangeVisibilityHooked = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          useStore.getState().checkModsChanges();
          scheduleModsChangePoll();
        }
      });
    }
  },

  applyAddonlistChanges: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/mods/addonlist-changes/apply`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({} as any));
      set({ pendingAddonlistChanges: [] });
      const count = typeof data?.count === 'number' ? data.count : 0;
      showToast(`已同步游戏内的 ${count} 项 Mod 改动`, 'success');
      // 启用状态已经变了：静默刷新列表（不会有扫描横幅、不锁按钮）
      await get().fetchModsSilently();
    } catch (e) {
      console.error('applyAddonlistChanges error:', e);
      showToast('同步失败：无法连接到后端服务', 'error');
    }
  },

  dismissAddonlistChanges: async () => {
    set({ pendingAddonlistChanges: [] });
    try {
      await fetch(`${API_BASE}/api/mods/addonlist-changes/dismiss`, { method: 'POST' });
      showToast('已忽略游戏内的改动：保持软件里的设置，并已写回 addonlist.txt', 'info');
    } catch {
      // 忽略失败也不打扰用户：下次扫描会重新检测出来
    }
  },

  fetchStatus: async () => {
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/status`);
      const data = await res.json();
      set({ status: data, error: null });
    } catch (e) {
      set({ error: '无法连接到后端服务' });
    }
  },

  fetchSettings: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings`);
      const data = await res.json();
      set({ addonsPath: data.addons_path, error: null });
    } catch (e) {
      set({ error: '无法连接到后端服务' });
    }
  },

  setAddonsPath: async (path: string) => {
    try {
      console.log('[Store] setAddonsPath called with:', path);
      const res = await fetch(`${API_BASE}/api/settings/addons-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      console.log('[Store] Response status:', res.status, res.statusText);
      if (res.ok) {
        const data = await res.json();
        console.log('[Store] Response body:', data);
        set({ addonsPath: data.addons_path, error: null });
        return true;
      }
      const errText = await res.text();
      console.error('[Store] Error response:', res.status, errText);
      return false;
    } catch (e) {
      console.error('[Store] Network error:', e);
      set({ error: '无法连接到后端服务' });
      return false;
    }
  },

  autoDetectPath: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings/auto-detect`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        set({ addonsPath: data.addons_path, error: null });
        await get().refreshAll();
      }
    } catch (e) {
      set({ error: '自动检测路径失败' });
    }
  },

  toggleMod: async (modName: string, path?: string) => {
    const target = normalizeModKey(modName);
    // 传了路径就按路径匹配：同名副本（addons 根 + workshop）必须各改各的
    const match = (m: ModData) => (path ? m.path === path : normalizeModKey(m.name) === target);
    const prevState = get().mods.find(match)?.enabled;

    // 失败时回滚到点击前的状态
    const rollback = () => {
      set((state) => ({
        mods: state.mods.map((m) => (match(m) ? { ...m, enabled: prevState ?? !m.enabled } : m)),
      }));
    };

    // 先乐观切换，界面立刻响应（用归一化名字匹配，兼容各种历史写法）
    set((state) => ({
      mods: state.mods.map((m) => (match(m) ? { ...m, enabled: !m.enabled } : m)),
    }));

    try {
      const encoded = encodeURIComponent(modName);
      const qs = path ? `?path=${encodeURIComponent(path)}` : '';
      const res = await fetch(`${API_BASE}/api/mods/${encoded}/toggle${qs}`, {
        method: 'POST',
      });
      if (!res.ok) {
        rollback();
        // 以前这里只写 store.error，而界面上并没有地方展示它 —— 用户只感觉到
        // 「点了没反应」。现在把后端的说明弹出来（例如文件被移动/改名后找不到）。
        const detail = await res.json().catch(() => null);
        const message = (detail && detail.detail) || '切换 Mod 状态失败';
        set({ error: message });
        showToast(`${message}`, 'error');
        return;
      }

      // 用后端返回的最新数据替换该 Mod。
      // 不再调用全量刷新：那会弹出「正在扫描 Mod」，而且要点卡片就得等一整轮扫描。
      const data = await res.json().catch(() => null);
      if (data && data.name) {
        const key = normalizeModKey(data.name);
        // 后端按名字返回、不带路径：优先用路径精确落到那一条
        const hitPath = path || (data.path as string | undefined);
        set((state) => ({
          mods: state.mods.map((m) => {
            const same = hitPath ? m.path === hitPath : normalizeModKey(m.name) === key;
            if (!same) return m;
            const merged = { ...m, ...data };
            // 禁用后立刻清掉冲突（冲突只在启用中的 Mod 之间才有意义）；
            // 仍启用时先沿用旧值，等随后的静默刷新来校正。
            merged.conflicts = merged.enabled ? (m.conflicts || []) : [];
            merged.conflict_details = merged.enabled ? (m.conflict_details || []) : [];
            merged.conflict_hints = merged.enabled ? (m.conflict_hints || []) : [];
            // 重复信息由扫描产出，toggle 的返回值里没有，沿用旧值
            merged.duplicates = m.duplicates;
            merged.duplicate_kind = m.duplicate_kind;
            return merged;
          }),
        }));
      }
      // 后台静默同步（刷新冲突等派生数据）：不 await、不显示扫描横幅
      // 改动已落到软件设置里但还没写回 addonlist.txt → 点亮左下角的「应用」
      set({ modsDirty: true });
      scheduleSilentModsRefresh();
    } catch (e) {
      rollback();
      set({ error: '切换 Mod 状态失败' });
      showToast('切换 Mod 状态失败：无法连接到后端服务', 'error');
    }
  },

  deleteMod: async (modName: string, path?: string) => {
    try {
      const encoded = encodeURIComponent(modName);
      const qs = path ? `?path=${encodeURIComponent(path)}` : '';
      const res = await fetch(`${API_BASE}/api/mods/${encoded}${qs}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await get().fetchMods();
        await get().fetchStatus();
        // 后端会把该 Mod 从所有整合包里移除，这里同步一下
        // （否则整合包卡片上的数量会虚高、详情页却匹配不到）
        await get().fetchPacks();
      }
    } catch (e) {
      set({ error: '删除 Mod 失败' });
    }
  },

  refreshAll: async () => {
    set({ loading: true });
    // 先流式加载 mods（冷启动/首次扫描较慢），完成后缓存已就绪，
    // 其余轻量接口再并行刷新（避免与流式扫描同时触发重复的全量解析）。
    await get().fetchMods();
    await Promise.all([
      get().fetchStatus(),
      get().fetchSettings(),
      get().fetchPacks(),
    ]);
    set({ loading: false });
  },

  fetchPacks: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/packs`);
      if (res.ok) {
        const data = await res.json();
        // Convert backend format (mod_ids) to frontend format (modNames)
        const packs: PackData[] = data.packs.map((p: any) => ({
          id: p.id,
          name: p.name,
          modNames: p.mod_ids || [],
          createdAt: p.created_at || p.updated_at || new Date().toISOString(),
        }));
        set((state) => {
          const current = state.selectedPack;
          return {
            packs,
            // 关键：让 selectedPack 重新指向新数组里的对象。
            // 以前这里只 set({ packs })，selectedPack 仍引用旧对象 ——
            // 于是「在 Mod 页往整合包里加了 Mod / 重命名 / 任何 refreshAll」之后，
            // 整合包详情页依旧渲染那份陈旧数据（加了 Mod 却不显示、名字不更新）。
            selectedPack: current ? packs.find((p) => p.id === current.id) || null : null,
          };
        });
      }
    } catch (e) {
      console.error('Failed to fetch packs:', e);
    }
  },

  createPack: async (name: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/packs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        await get().fetchPacks();
      }
    } catch (e) {
      console.error('Failed to create pack:', e);
    }
  },

  deletePack: async (packId: string) => {
    // 先乐观移除，UI 立刻响应
    set((state) => ({
      packs: state.packs.filter((p) => p.id !== packId),
      selectedPack: state.selectedPack?.id === packId ? null : state.selectedPack,
    }));
    try {
      // 404 表示服务端本来就没有这个包，同样按已删除处理
      await fetch(`${API_BASE}/api/packs/${packId}`, { method: 'DELETE' });
    } catch (e) {
      console.error('Failed to delete pack:', e);
    }
    // 以服务端为准（失败时会自动恢复，避免界面与后端不一致）
    await get().fetchPacks();
  },

  renamePack: async (packId: string, newName: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/packs/${packId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (res.ok) {
        await get().fetchPacks();
      }
    } catch (e) {
      console.error('Failed to rename pack:', e);
    }
  },

  addModToPack: async (modName: string, packId: string) => {
    await get().addModsToPack([modName], packId);
  },

  addModsToPack: async (modNames: string[], packId: string) => {
    const unique = Array.from(new Set(modNames.filter(Boolean)));
    if (unique.length === 0) return;

    // 乐观更新：立刻反映到界面
    set((state) => {
      const merged = (names: string[]) => {
        const out = [...names];
        for (const n of unique) if (!out.includes(n)) out.push(n);
        return out;
      };
      return {
        packs: state.packs.map((p) =>
          p.id === packId ? { ...p, modNames: merged(p.modNames) } : p
        ),
        selectedPack:
          state.selectedPack?.id === packId
            ? { ...state.selectedPack, modNames: merged(state.selectedPack.modNames) }
            : state.selectedPack,
      };
    });

    try {
      await fetch(`${API_BASE}/api/packs/${packId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // 一次请求写入全部：逐个请求时多个响应会乱序返回，
        // 界面会停在「只加进去一部分」的中间状态（刷新后才恢复正常）。
        body: JSON.stringify({ add_mods: unique }),
      });
    } catch (e) {
      console.error('Failed to add mods to pack:', e);
    }
    // 以服务端为准（同时把 selectedPack 重新绑定到最新数据）
    await get().fetchPacks();
  },

  removeModFromPack: async (modName: string, packId: string) => {
    // Optimistic update
    set((state) => ({
      packs: state.packs.map((p) =>
        p.id === packId ? { ...p, modNames: p.modNames.filter((m) => m !== modName) } : p
      ),
      selectedPack:
        state.selectedPack?.id === packId
          ? { ...state.selectedPack, modNames: state.selectedPack.modNames.filter((m) => m !== modName) }
          : state.selectedPack,
    }));
    try {
      const res = await fetch(`${API_BASE}/api/packs/${packId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remove_mod: modName }),
      });
      if (res.ok) {
        await get().fetchPacks();
      } else {
        // Revert on failure
        set((state) => ({
          packs: state.packs.map((p) =>
            p.id === packId && !p.modNames.includes(modName)
              ? { ...p, modNames: [...p.modNames, modName] }
              : p
          ),
          selectedPack:
            state.selectedPack?.id === packId &&
            !state.selectedPack.modNames.includes(modName)
              ? { ...state.selectedPack, modNames: [...state.selectedPack.modNames, modName] }
              : state.selectedPack,
        }));
      }
    } catch (e) {
      console.error('Failed to remove mod from pack:', e);
      // Revert on error
      set((state) => ({
        packs: state.packs.map((p) =>
          p.id === packId && !p.modNames.includes(modName)
            ? { ...p, modNames: [...p.modNames, modName] }
            : p
        ),
        selectedPack:
          state.selectedPack?.id === packId &&
          !state.selectedPack.modNames.includes(modName)
            ? { ...state.selectedPack, modNames: [...state.selectedPack.modNames, modName] }
            : state.selectedPack,
      }));
    }
  },

  selectPack: (pack) => set({ selectedPack: pack }),

  setContextMenu: (menu) => set({ contextMenu: menu }),

  setPackContextMenu: (menu) => set({ packContextMenu: menu }),

  setModCategory: async (modName: string, category: string | null) => {
    try {
      const encoded = encodeURIComponent(modName);
      const res = await fetch(`${API_BASE}/api/mods/${encoded}/category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      if (res.ok) {
        // Re-fetch all mods to get fully consistent data (tags, category, etc.)
        await get().fetchMods();
      } else {
        console.error('Failed to set category:', await res.text());
      }
    } catch (e) {
      console.error('Failed to set category:', e);
    }
  },

  setDeleteConfirmMod: (modName) => set({ deleteConfirmMod: modName }),

  getModDisplayName: (modName) => {
    const names = loadModDisplayNames();
    return names[modName] || null;
  },

  renameModDisplayName: (modName, newDisplayName) => {
    const names = loadModDisplayNames();
    if (newDisplayName.trim()) {
      names[modName] = newDisplayName.trim();
    } else {
      delete names[modName];
    }
    saveModDisplayNames(names);
  },

  confirmDeleteMod: async (modName) => {
    await get().deleteMod(modName);
    set({ deleteConfirmMod: null });
  },

  initiateSteamLogin: async () => {
    // 防抖：启动阶段 backendConnected / backend:ready 可能连续触发多次，
    // 早期实现会重复发起 3 次登录请求（后端每次都要联网取头像，网络不通时会各卡一个超时）
    if (get().steamLoginInProgress || get().steamUser) return;
    try {
      set({ steamLoginInProgress: true });
      const res = await fetch(`${API_BASE}/api/auth/steam/login`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          set({
            steamUser: data.user,
            steamLoginInProgress: false,
          });
        } else {
          set({
            steamLoginInProgress: false,
          });
          if (data.error) {
            console.error('Steam login error:', data.error);
            set({ error: data.error });
          }
        }
      } else {
        set({ steamLoginInProgress: false });
      }
    } catch (e) {
      console.error('Steam login error:', e);
      set({ steamLoginInProgress: false });
    }
  },

  checkSteamAuth: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/steam/status`);
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          set({ steamUser: data.user });
        }
      }
    } catch (e) {
      // Ignore
    }
  },

  logoutSteam: async () => {
    try {
      await fetch(`${API_BASE}/api/auth/steam/logout`, { method: 'POST' });
    } catch (e) {
      // Ignore
    }
    // 清除内置浏览器的 cookie，确保 Steam 真正退出
    try {
      if ((window as any).electronAPI?.clearWorkshopCookies) {
        await (window as any).electronAPI.clearWorkshopCookies();
      }
    } catch (e) {
      console.error('Failed to clear workshop cookies:', e);
    }
    set({ steamUser: null });
  },

  enablePackMods: async (packId: string, enable?: boolean) => {
    const state = get();
    const pack = state.packs.find((p) => p.id === packId);
    if (!pack || pack.modNames.length === 0) return null;

    // 后端批量接口：整包只读写一次 addonlist.txt。
    // 以前是循环调用 /api/mods/{name}/toggle —— 每个 Mod 都要读写一遍文件并重新解析 VPK，
    // 几百个 Mod 的整合包会卡住很久，而且前端还无法感知进度。
    try {
      const res = await fetch(`${API_BASE}/api/packs/${packId}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 不传 enable 时由后端按成员真实状态决定方向（切换语义）
        body: JSON.stringify(enable === undefined ? {} : { enable }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({} as any));
        set({ error: detail.detail || '整合包切换失败' });
        return null;
      }
      const data = await res.json().catch(() => ({} as any));

      // 一律以后端返回的「实际目标」为准（前端不再自己猜方向）
      const finalEnable = typeof data.enable === 'boolean' ? data.enable : Boolean(enable);
      // 改动还没写回 addonlist.txt → 点亮左下角的「应用」
      set({ modsDirty: true });

      const targets = new Set(pack.modNames.map(normalizeModKey));
      const updated: Record<string, boolean> =
        data && typeof data.updated === 'object' && data.updated ? data.updated : {};
      for (const name of Object.keys(updated)) targets.add(normalizeModKey(name));

      // 局部更新界面状态（不触发全量扫描：那会弹出「正在扫描 Mod」并锁住按钮）
      let matchedAny = false;
      const nextMods = get().mods.map((m) => {
        if (!targets.has(normalizeModKey(m.name))) return m;
        matchedAny = true;
        // 关键：被禁用后必须立刻清掉冲突信息。
        // 冲突只在「已启用」的 Mod 之间才有意义（后端也只在启用集合里计算），
        // 若这里保留旧的 conflicts，卡片就会在禁用后继续显示「冲突」。
        return {
          ...m,
          enabled: finalEnable,
          conflicts: finalEnable ? m.conflicts : [],
          conflict_details: finalEnable ? m.conflict_details : [],
          conflict_hints: finalEnable ? m.conflict_hints : [],
        };
      });

      if (matchedAny) {
        set({ mods: nextMods });
        // 后台静默同步（刷新冲突等派生数据）：不 await、不显示扫描横幅
        scheduleSilentModsRefresh();
      } else {
        // 一个都没匹配上：说明当前 mods 列表里没有这些成员（可能还没加载完，
        // 或成员名是历史写法）。用静默刷新兜底，保证界面最终与后端一致。
        await get().fetchModsSilently();
      }

      return {
        changed: typeof data.changed === 'number' ? data.changed : 0,
        missing: Array.isArray(data.missing) ? (data.missing as string[]) : [],
        enable: finalEnable,
      };
    } catch (e) {
      console.error('Failed to toggle pack mods:', e);
      set({ error: '整合包切换失败：网络错误' });
      return null;
    }
  },


  exportPackAsZip: async (packId: string) => {
    const state = get();
    const pack = state.packs.find((p) => p.id === packId);
    if (!pack || pack.modNames.length === 0) {
      // 抛给调用方显示提示（以前是静默 return，用户点了导出没有任何反应）
      throw new Error('整合包中没有 Mod');
    }

    const res = await fetch(`${API_BASE}/api/packs/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packName: pack.name,
        modNames: pack.modNames,
      }),
    });

    if (!res.ok) {
      let detail = '未知错误';
      try {
        const err = await res.json();
        detail = err.detail || detail;
      } catch {
        // ignore
      }
      // 抛错而不是写全局 error：全局 error 会在其它页面/组件里被当成别的错误显示
      throw new Error(detail);
    }

    // Download the zip file
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pack.name}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // ── 创意工坊更新 ──────────────────────────────────────────────
  // 判定全在后端（查 Steam 的 time_updated 与基线比对），这里只管轮询与交互反馈。

  fetchWorkshopUpdates: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/workshop-updates`);
      if (!res.ok) return;
      const data: WorkshopUpdatesState = await res.json();
      const wasRunning = workshopApplyingBefore;
      workshopApplyingBefore = !!data.applying?.running;
      // 刚跑完更新：给一次明确的结果提示（成功几个 / 失败几个），
      // 否则用户只能盯着卡片上的小字猜到底做完了没有
      if (wasRunning && !workshopApplyingBefore) {
        const errs = data.applying?.errors?.length ?? 0;
        const okCount = data.applying?.done ?? 0;
        if (errs > 0) {
          showToast(`更新结束：${okCount} 个已更新，${errs} 个失败（详见悬浮提示）`, 'warning');
        } else if (okCount > 0) {
          showToast(`已更新 ${okCount} 个创意工坊 Mod`, 'success');
        }
      }

      // 检查也同理：结束那一刻要在底部给一句结论，不能只是按钮从「检查中…」变回来
      const wasChecking = workshopCheckingBefore;
      workshopCheckingBefore = !!data.checking;
      if (data.checking && workshopCheckIntent === null) {
        // 不是用户点的，那就是后端启动时的自动检查
        workshopCheckIntent = 'auto';
      }
      if (wasChecking && !data.checking) {
        const manual = workshopCheckIntent === 'manual';
        if (data.last_error) {
          showToast(`检查更新失败：${data.last_error}`, 'error');
        } else if (data.update_count > 0) {
          showToast(`检查完成：${data.update_count} 个 Mod 有更新`, 'info');
        } else if (manual) {
          showToast('检查完成：所有创意工坊 Mod 都是最新版本', 'success');
        }
        workshopCheckIntent = null;
      }

      set({ workshopUpdates: data });
      if (data.checking || data.applying?.running) scheduleWorkshopUpdatePoll();
    } catch {
      // 后端不可用：保留上次结果，不打扰用户
    }
  },

  checkWorkshopUpdates: async () => {
    try {
      workshopCheckIntent = 'manual';
      workshopCheckingBefore = true;
      set((s) => (s.workshopUpdates ? { workshopUpdates: { ...s.workshopUpdates, checking: true } } : {}));
      const res = await fetch(`${API_BASE}/api/workshop-updates/check`, { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.detail || '检查更新失败', 'error');
        workshopCheckIntent = null;
        workshopCheckingBefore = false;
        await get().fetchWorkshopUpdates();
        return;
      }
      scheduleWorkshopUpdatePoll();
    } catch {
      workshopCheckIntent = null;
      workshopCheckingBefore = false;
      showToast('检查更新失败：无法连接到后端服务', 'error');
    }
  },

  applyWorkshopUpdates: async (ids) => {
    try {
      const body = ids && ids.length > 0 ? { ids } : { all: true };
      const res = await fetch(`${API_BASE}/api/workshop-updates/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.detail || '更新失败', 'error');
        return;
      }
      workshopApplyingBefore = true;
      scheduleWorkshopUpdatePoll();
      showToast(
        ids && ids.length > 0 ? `开始更新 ${ids.length} 个 Mod…` : '开始更新全部可更新的 Mod…',
        'info'
      );
    } catch {
      showToast('更新失败：无法连接到后端服务', 'error');
    }
  },

  setWorkshopUpdateSettings: async (patch) => {
    try {
      const res = await fetch(`${API_BASE}/api/workshop-updates/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return;
      const data = await res.json();
      set((s) => (s.workshopUpdates ? { workshopUpdates: { ...s.workshopUpdates, ...data } } : {}));
    } catch {
      // 保存失败时保持原值，下次进设置页还能看到真实状态
    }
  },
}));
