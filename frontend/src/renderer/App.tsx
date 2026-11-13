import { useEffect, useRef, useCallback, useState, useMemo, lazy, Suspense } from 'react';
import type { CSSProperties } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { MyModsPage } from './components/MyModsPage';
// 非首屏页面改为按需加载：首屏只需要「我的Mod」这一页，
// 设置/整合包/创意工坊（含 webview 声明）与同步弹窗不必压进首包，
// 可显著减少启动时的 JS 解析/执行时间（首包体积直接决定了首帧时间）。
const WorkshopPage = lazy(() => import('./components/WorkshopPage').then((m) => ({ default: m.WorkshopPage })));
const DownloadPage = lazy(() => import('./components/DownloadPage').then((m) => ({ default: m.DownloadPage })));
const PacksPage = lazy(() => import('./components/PacksPage').then((m) => ({ default: m.PacksPage })));
const SettingsPage = lazy(() => import('./components/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const AddonlistSyncDialog = lazy(() =>
  import('./components/AddonlistSyncDialog').then((m) => ({ default: m.AddonlistSyncDialog }))
);
import { DropOverlay } from './components/DropOverlay';
import { ToastContainer } from './components/Toast';
import { PerfOverlay } from './components/PerfOverlay';
import { ConfirmHost } from './components/ConfirmDialog';
import { WorkshopUpdateDock } from './components/WorkshopUpdateDock';
import { useStore, setBackendApiBase } from './store/useStore';
import { useUpdateStore } from './store/useUpdateStore';
import { useDraggablePill } from './hooks/useDraggablePill';
import { applyAccent } from './utils/themeColor';
import { isCampaignMod } from './utils/modRole';
import xiaochunImg from './assets/xiaochun.png';
import xiaochunpickOgg from './assets/xiaochunpick.ogg';
import xiaochunhit1Ogg from './assets/xiaochunhit1.ogg';
import xiaochunhit3Ogg from './assets/xiaochunhit3.ogg';
import './styles/global.scss';
import './styles/modal.scss';
import './App.scss';

const MAX_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB

/**
 * 把「非首屏必需」的启动任务排到首帧之后执行。
 *
 * 启动时有几件事（背景图压缩、读取界面缩放、Steam 登录、轮询器初始化）
 * 会与首屏渲染抢同一个主线程 / 网络栈。其中 Steam 登录还要走一次外网请求
 * （网络差时会等到超时），放在首帧前跑会明显拖慢「窗口打开就有内容」的观感。
 * 这里统一延后到首帧绘制完成 + 一小段空闲，用户几乎察觉不到差别。
 */
function deferNonCritical(task: () => void, delay = 200) {
  const run = () => {
    try {
      task();
    } catch (e) {
      console.error('[startup] deferred task failed:', e);
    }
  };
  const schedule = () => {
    const ric = (window as any).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(run, { timeout: 1500 });
    } else {
      setTimeout(run, 0);
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(schedule, delay));
  } else {
    setTimeout(schedule, delay);
  }
}

function getBarColor(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb < 4) return '#22c55e';
  if (gb < 8) return '#f97316';
  return '#ef4444';
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);
  return `${size} ${units[i]}`;
}

function useSmoothBytes(bytes: number): number {
  const [smoothed, setSmoothed] = useState(bytes);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const animate = () => {
      setSmoothed((prev) => {
        const diff = bytes - prev;
        if (Math.abs(diff) < 1) return bytes;
        return prev + diff * 0.12;
      });
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [bytes]);

  return smoothed;
}

// ===== 主题切换：交叉淡入（快照遮住旧画面 → 瞬时切主题 → 快照淡出）=====
//
// 这些状态是「整个应用级别」的单例（<App /> 只会存在一个），放在模块作用域而不是
// 组件 ref 里，是为了让「过渡进行中被再次点击（快速连点）」时能把新一轮切换排到
// 当前过渡之后串行播放，而不会因为 effect 重新触发互相干扰（旧定时器/图层打架）。
let themeAnimating = false;
let themeFadeLayer: HTMLDivElement | null = null;
let themeFadeTimer: ReturnType<typeof setTimeout> | null = null;
let themeSwitchingTimer: ReturnType<typeof setTimeout> | null = null;
// 过渡进行中被点击时挂起的目标主题（收尾后再完整播放一次，避免「硬切」）
let pendingTheme: 'light' | 'dark' | null = null;
// 每开始/结束一轮过渡都自增，用于丢弃「过期的异步快照回调」
let themeRunId = 0;

function currentThemeAttr(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/**
 * 瞬时切换主题：短时间内禁用所有过渡后一次性改属性。
 * 用于「关闭过渡」模式、以及首帧补写主题属性（避免启动闪一下默认主题）。
 */
function applyThemeInstantly(next: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', next);
  if (themeSwitchingTimer) clearTimeout(themeSwitchingTimer);
  // 用定时器（而不是 rAF + 清理函数）收尾：快速连点时，上一次的清理
  // 不会把本次刚加上的 class 提前移除，导致 theme-switching 残留。
  themeSwitchingTimer = setTimeout(() => {
    document.documentElement.classList.remove('theme-switching');
    themeSwitchingTimer = null;
  }, 60);
}

/** 过渡收尾：移除快照图层、恢复过渡；若过渡期间又有点击，则串行播放它 */
function finishThemeTransition() {
  if (themeFadeTimer) {
    clearTimeout(themeFadeTimer);
    themeFadeTimer = null;
  }
  themeFadeLayer?.remove();
  themeFadeLayer = null;
  themeRunId += 1;
  document.documentElement.classList.remove('theme-switching');
  themeAnimating = false;

  const next = pendingTheme;
  pendingTheme = null;
  // 挂起的切换：等当前过渡收尾后立刻以「完整过渡」再播放一次，保证观感平滑
  if (next && next !== currentThemeAttr()) {
    applyThemeWithTransition(next, currentThemeAttr());
  }
}

/** 带过渡动画的主题切换（快照交叉淡入） */
function applyThemeWithTransition(next: 'light' | 'dark', from: 'light' | 'dark') {
  const root = document.documentElement;
  // 拿不到快照时的兜底底色（用旧主题的底色 + 半透明薄雾，尽量不闪）
  const oldBase =
    getComputedStyle(root).getPropertyValue('--bg-secondary').trim() ||
    (from === 'dark' ? '#12122a' : '#ffffff');

  themeAnimating = true;
  const myRun = (themeRunId += 1);

  const runFade = (snapshot: string | null) => {
    // 过渡已被收尾（组件卸载 / 新的一轮过渡开始）→ 丢弃过期回调
    if (myRun !== themeRunId || !themeAnimating) return;

    const layer = document.createElement('div');
    layer.className = 'theme-fade-layer';
    if (snapshot) {
      layer.style.backgroundImage = `url("${snapshot}")`;
    } else {
      layer.style.background = oldBase;
      layer.style.opacity = '0.5';
    }
    document.body.appendChild(layer);
    themeFadeLayer = layer;

    // 快照就位后才瞬时切主题：同一帧内不会先闪现新主题
    root.classList.add('theme-switching');
    root.setAttribute('data-theme', next);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (themeFadeLayer) themeFadeLayer.style.opacity = '0';
      });
    });
    themeFadeTimer = setTimeout(finishThemeTransition, 420);
  };

  const api = (window as any).electronAPI;
  if (api?.captureThemeSnapshot) {
    // 兜底超时：主进程若长时间不返回快照，也要保证这一步能收尾，
    // 否则 themeAnimating 会一直卡在 true（后续点击全被挂起）。
    Promise.race([
      api.captureThemeSnapshot() as Promise<string | null>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 400)),
    ])
      .then((snapshot) => runFade((snapshot as string | null) ?? null))
      .catch(() => runFade(null));
  } else {
    runFade(null);
  }
}

/** 主题应用入口：from === null 表示首帧补写属性（不做动画） */
function applyTheme(next: 'light' | 'dark', from: 'light' | 'dark' | null, withTransition: boolean) {
  if (!withTransition || from === null) {
    applyThemeInstantly(next);
    return;
  }
  applyThemeWithTransition(next, from);
}

function loadDismissedConflicts(): Set<string> {
  try {
    const raw = localStorage.getItem('l4d2-dismissed-conflicts');
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function ConflictBadge() {
  const { mods } = useStore();
  const [version, setVersion] = useState(0);
  const { ref: badgeRef, isDragging, handleMouseDown } = useDraggablePill('l4d2-conflict-badge-pos');

  useEffect(() => {
    const handler = () => setVersion(v => v + 1);
    window.addEventListener('app:dismissed-conflicts', handler);
    return () => window.removeEventListener('app:dismissed-conflicts', handler);
  }, []);

  const count = useMemo(() => {
    const dismissed = loadDismissedConflicts();
    // 冲突只对「已启用」的 Mod 有意义：禁用后不再计入角标
    return mods.filter(m => m.enabled && m.conflicts && m.conflicts.length > 0 && !dismissed.has(m.name)).length;
  }, [mods, version]);

  // 位置恢复 / 拖拽 / 窗口缩放跟随统一由 useDraggablePill 处理

  if (count === 0) return null;

  return (
    <div
      ref={badgeRef}
      className={`app-conflict-badge${isDragging ? ' app-conflict-badge--drag' : ''}`}
      onMouseDown={handleMouseDown}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14">
        <path d="M12 7v6M12 17v0" stroke="currentColor" strokeLinecap="round"/>
      </svg>
      <span>{count} 个冲突</span>
    </div>
  );
}

function UsageBar() {
  const { mods } = useStore();
  const { ref: pillRef, isDragging, handleMouseDown } = useDraggablePill('l4d2-usage-bar-pos');

  /**
   * 已启用 Mod 的载入占用。
   *
   * **战役（地图）不计入**：地图包动辄 1~2 GB，但它只有在玩那张图时才按需载入，
   * 跟一直在内存里的资源包不是一回事；算进来会让数字常年飘红、失去参考价值。
   * 具体排除规则见 utils/modRole.ts 的 isCampaignMod。
   */
  const { totalBytes, campaignBytes, campaignCount } = useMemo(() => {
    let total = 0;
    let campBytes = 0;
    let campCount = 0;
    for (const m of mods) {
      if (!m.enabled) continue;
      if (isCampaignMod(m)) {
        campBytes += m.size_bytes;
        campCount += 1;
      } else {
        total += m.size_bytes;
      }
    }
    return { totalBytes: total, campaignBytes: campBytes, campaignCount: campCount };
  }, [mods]);
  const smoothedBytes = useSmoothBytes(totalBytes);
  const barPercent = Math.min((smoothedBytes / MAX_BYTES) * 100, 100);
  const barColor = getBarColor(smoothedBytes);
  const tip =
    campaignCount > 0
      ? `已启用 Mod 占用 ${formatSize(totalBytes)}\n战役地图 ${campaignCount} 个不计入（共 ${formatSize(campaignBytes)}）\n地图只在玩那张图时按需载入，不常驻内存`
      : `已启用 Mod 占用 ${formatSize(totalBytes)}`;

  // 位置恢复 / 拖拽 / 窗口缩放跟随统一由 useDraggablePill 处理

  return (
    <div
      ref={pillRef}
      className={`app-usage-bar${isDragging ? ' app-usage-bar--drag' : ''}`}
      onMouseDown={handleMouseDown}
      title={tip}
    >
      <div className="app-usage-bar__ring" style={{ borderColor: barColor }}>
        <div
          className="app-usage-bar__fill"
          style={{
            width: `${barPercent}%`,
            backgroundColor: barColor,
          }}
        />
      </div>
      <span className="app-usage-bar__label" style={{ color: barColor }}>
        {formatSize(smoothedBytes)}
      </span>
    </div>
  );
}

/**
 * 全局扫描提示（仅在非 Mod 页显示）。
 * 延迟 600ms 才出现：缓存命中的扫描往往只有几十毫秒，避免切页时闪一下横幅；
 * 扫描状态本身由 store 里的看门狗保证一定会被复位（见 useStore.fetchMods）。
 */
function ScanningBanner({ done, total }: { done: number; total: number | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 600);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="app-scanning-banner">
      <span className="app-scanning-banner__spinner" />
      <span>{total ? `正在扫描 Mod（${done}/${total}）…` : '正在扫描 Mod…'}</span>
    </div>
  );
}

function BackendErrorOverlay() {
  const { retryCount, checkBackendConnection, exportLogs } = useStore();
  const [connecting, setConnecting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [visible, setVisible] = useState(false);

  // 启动后延迟 10 秒再显示错误
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(true);
    }, 10000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (visible) {
      const interval = setInterval(async () => {
        setConnecting(true);
        await checkBackendConnection();
        setConnecting(false);
      }, retryCount < 3 ? 10000 : 30000);
      return () => clearInterval(interval);
    }
  }, [visible, retryCount, checkBackendConnection]);

  const handleRetry = async () => {
    setConnecting(true);
    // 尽力让主进程重新启动后端（后端进程可能已崩溃/被拦截），随后重新检测连接
    try {
      const api = (window as any).electronAPI as any;
      if (api && typeof api.restartBackend === 'function') {
        await api.restartBackend();
      }
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1500));
    await checkBackendConnection();
    setConnecting(false);
  };

  const handleExportLogs = async () => {
    setExporting(true);
    await exportLogs();
    setExporting(false);
  };

  if (!visible) return null;

  return (
    <div className="app-backend-toast">
      <div className="app-backend-toast__icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4M12 16h0" strokeLinecap="round" />
        </svg>
      </div>
      <div className="app-backend-toast__body">
        <span className="app-backend-toast__title">正在等待后端服务…</span>
        <span className="app-backend-toast__detail">
          首次启动/刚重启电脑时后端初始化较慢（可能被安全软件拦截），程序会自动重试并自动连上
          ({retryCount + 1}) | 可导出日志反馈开发者
        </span>
      </div>
      <button
        className="app-backend-toast__btn app-backend-toast__btn--ghost"
        onClick={handleExportLogs}
        disabled={exporting}
        title="导出日志（即使后端连不上也可用）"
      >
        {exporting ? '导出中…' : '导出日志'}
      </button>
      <button
        className="app-backend-toast__btn"
        onClick={handleRetry}
        disabled={connecting}
      >
        {connecting ? '...' : '重试'}
      </button>
    </div>
  );
}

function App() {
  const { currentPage, theme, accentColor, themeTransition, refreshAll, background, showMascot, addonsPath, backendConnected, scanning, scanProgress, setBackendConnected, checkBackendConnection, ensureBackgroundOptimized, applyModPrefsToGame, applyingPrefs, modsDirty } = useStore();
  const mascotRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);
  const [bouncing, setBouncing] = useState(false);
  // 'entering' = playing bounce-in animation
  // 'entered' = fully visible, no animation
  // 'exiting' = playing shrink-out animation
  // 'hidden' = invisible
  const [animState, setAnimState] = useState<'entering' | 'entered' | 'exiting' | 'hidden'>('hidden');
  const prevShowMascot = useRef(showMascot);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 记录上一次的主题，用于判断「主题真的切换了」以及取旧主题的底色。
  // 初始为 null（而不是当前主题）：首帧必须把主题属性补写到 <html> 上，
  // 否则 HTML 上没有 data-theme，界面会落到「默认（夜间色调）」的样式分支。
  const prevThemeRef = useRef<'light' | 'dark' | null>(null);

  // Preload audio（复用单个元素播放，避免快速连点导致声音叠加过大）
  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.volume = 0.2;
  }, []);

  // 旧版本可能把超大原图直接存成了背景（全屏 blur + backdrop-filter 会非常卡），
  // 启动时做一次性的压缩迁移。
  // 注意：图片解码/重编码是重活，必须让开首屏渲染，否则会把首帧往后推几百毫秒。
  useEffect(() => {
    deferNonCritical(() => ensureBackgroundOptimized());
  }, [ensureBackgroundOptimized]);

  // 同步「界面缩放」：主进程在窗口创建时已按配置文件设置好 zoom factor，
  // 这里只把实际值同步进 store（让设置页显示的比例与生效值一致）
  useEffect(() => {
    deferNonCritical(() => useStore.getState().fetchUiScale());
  }, []);

  // 自动更新：订阅主进程推来的状态。检查本身由主进程在启动 15 秒后自己做，
  // 这里只是把状态接进界面（有新版本时侧边栏亮小点、设置页显示按钮）。
  useEffect(() => {
    useUpdateStore.getState().init();
  }, []);

  // 后端连上（或重连）后拉一次「应用」按钮状态：有未应用的改动时会点亮
  useEffect(() => {
    if (!backendConnected) return;
    useStore.getState().fetchApplyState();
  }, [backendConnected]);

  // 创意工坊更新：后端启动时可能已在后台自动检查（见 main.py 的 lifespan），
  // 这里把结果读回来；检查/更新进行中时 store 会自己按需轮询。
  // 延后执行：这是纯附加信息，不该和首屏的 Mod 列表抢请求。
  useEffect(() => {
    if (!backendConnected) return;
    deferNonCritical(() => {
      useStore.getState().fetchWorkshopUpdates();
    }, 600);
  }, [backendConnected]);

  // 上报「首屏渲染完成」时间（渲染进程侧不可再快的时间点），供加载速度基准使用
  useEffect(() => {
    const el = document.querySelector('.app');
    const report = () => {
      (window as any).electronAPI?.reportPerf?.('renderer-ready', {
        elapsed: Math.round(performance.now()),
        dom_ready: el !== null,
      });
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(report);
    } else {
      report();
    }
  }, []);

  const playSound = useCallback((src: string, volume = 0.2) => {
    const audio = audioRef.current;
    if (!audio) return;
    try { audio.pause(); } catch { /* ignore */ }
    try { audio.src = src; } catch { /* ignore */ }
    audio.volume = volume;
    try { audio.currentTime = 0; } catch { /* ignore */ }
    audio.play().catch(() => {});
  }, []);

  const wasDraggedRef = useRef(false);
  const [wasDragged, setWasDragged] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragEnd, setDragEnd] = useState(false);
  const dragPickPlayedRef = useRef(false);

  const handleClick = useCallback(() => {
    if (bouncing || wasDragged) return;
    setBouncing(true);
    const hitSound = Math.random() < 0.5 ? xiaochunhit1Ogg : xiaochunhit3Ogg;
    // 点击音效尽量轻（默认音量已下调，这里再降低一点）
    playSound(hitSound, 0.12);
    setTimeout(() => setBouncing(false), 700);
  }, [bouncing, wasDragged, playSound]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const el = mascotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      left: rect.left,
      top: rect.top,
    };
    setWasDragged(false);
    wasDraggedRef.current = false;
    dragPickPlayedRef.current = false;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragState.current) return;
    const el = mascotRef.current;
    if (!el) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      setWasDragged(true);
      wasDraggedRef.current = true;
      if (!dragPickPlayedRef.current) {
        dragPickPlayedRef.current = true;
        setDragging(true);
        playSound(xiaochunpickOgg, 0.18);
      }
    }
    el.style.left = `${dragState.current.left + dx}px`;
    el.style.top = `${dragState.current.top + dy}px`;
    el.style.bottom = 'auto';
    el.style.right = 'auto';
  }, [playSound]);

  const handleMouseUp = useCallback(() => {
    dragState.current = null;
    setDragging(false);
    if (wasDraggedRef.current) {
      setDragEnd(true);
      setTimeout(() => setDragEnd(false), 300);
    }
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  // 主题 → <html data-theme>：首帧补写属性 + 切换时播放过渡动画
  useEffect(() => {
    const root = document.documentElement;
    const oldTheme = prevThemeRef.current;
    // 主题没变、且 HTML 上的属性也已经同步 → 无需处理
    // （themeTransition 开关变化时也会走到这里，属性一致就直接返回）
    if (oldTheme === theme && root.getAttribute('data-theme') === theme) return;
    prevThemeRef.current = theme;

    // 首帧：HTML 上还没有 data-theme，必须立即补写（不做动画）。
    // 以前这里是 `if (oldTheme === theme) return` —— 启动时 oldTheme 就等于 theme，
    // 于是属性永远不会被写入，界面落到「默认（夜间色调）」分支：
    // 表现为「以日间模式关闭后重新打开，大部分部件仍是夜间模式，切两次才正常」。
    if (oldTheme === null) {
      applyTheme(theme, null, themeTransition);
      return;
    }

    if (themeAnimating) {
      // 上一次过渡还没结束（快速连点）：不能直接硬切，否则就是用户看到的「瞬间切换」。
      const layerOpacity = themeFadeLayer
        ? parseFloat(getComputedStyle(themeFadeLayer).opacity || '0')
        : 0;
      if (themeFadeLayer && layerOpacity >= 0.95) {
        // 快照还完整遮住画面：直接改底板主题（被快照挡着看不见），
        // 让它继续淡出即可 —— 观感上仍是平滑过渡，且不会叠图层。
        root.setAttribute('data-theme', theme);
        pendingTheme = null;
      } else {
        // 快照已开始淡出（或还没拿到快照）：挂起，等收尾后再完整播放一次过渡。
        pendingTheme = theme;
      }
      return;
    }

    applyTheme(theme, oldTheme, themeTransition);
  }, [theme, themeTransition]);

  // 主题色卡 → CSS 变量。主色在亮/暗两套主题下取不同明度（暗色底要提亮），
  // 所以主题变了也要重算一次；写在同一个 effect 里，保证换主题和换色卡都只跑一遍。
  useEffect(() => {
    applyAccent(accentColor, theme);
  }, [accentColor, theme]);

  // 组件卸载时兜底清理（App 不会卸载，仅防御）
  useEffect(() => {
    return () => {
      if (themeFadeTimer) {
        clearTimeout(themeFadeTimer);
        themeFadeTimer = null;
      }
      if (themeSwitchingTimer) {
        clearTimeout(themeSwitchingTimer);
        themeSwitchingTimer = null;
      }
      themeFadeLayer?.remove();
      themeFadeLayer = null;
      themeAnimating = false;
      pendingTheme = null;
      themeRunId += 1;
      document.documentElement.classList.remove('theme-switching');
    };
  }, []);

  // 后端连接检测
  useEffect(() => {
    // 启动时先检测后端连接
    checkBackendConnection();

    // 监听后端就绪事件（来自 main process）
    if ((window as any).electronAPI?.onBackendReady) {
      (window as any).electronAPI.onBackendReady(() => {
        setBackendConnected(true);
        // 后端就绪后自动刷新数据
        refreshAll();
      });
    }

    // 监听主进程通知的实际后端端口（8288 被占用时会自动改用备用端口）
    if ((window as any).electronAPI?.onBackendInfo) {
      (window as any).electronAPI.onBackendInfo(({ port }: { port: number }) => {
        console.log(`[App] Backend reported port ${port}`);
        const changed = setBackendApiBase(`http://127.0.0.1:${port}`);
        checkBackendConnection();
        if (changed) void useStore.getState().refreshAll();
      });
    }

    // 后端往往比界面先就绪，那条 push 通知可能在本组件挂载前就发出去了。
    // 主动问一次当前端口，否则会一直连默认的 8288（装了旧版时读到旧代码的数据）。
    if ((window as any).electronAPI?.getBackendPort) {
      (window as any).electronAPI
        .getBackendPort()
        .then((port: number) => {
          if (!port) return;
          const changed = setBackendApiBase(`http://127.0.0.1:${port}`);
          checkBackendConnection();
          if (changed) void useStore.getState().refreshAll();
        })
        .catch(() => { /* 拿不到就继续用默认端口 */ });
    }

    // 定期检测后端连接：统一 3 秒轮询（本地请求开销极小），这样冷启动后后端一就绪就能立刻接上。
    // checkBackendConnection 内部会跳过「状态没变化」的 set，因此高频轮询不会带来额外重渲染。
    // 窗口在后台/最小化时跳过：用户看不见界面，没必要持续占用 CPU 与网络栈。
    const interval = setInterval(() => {
      if (document.hidden) return;
      checkBackendConnection();
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // 游戏进程状态轮询：让侧边栏的「启动游戏」按钮能在 空闲 → 正在启动 → 游戏中 之间自动切换。
  // 轮询频率由 store 按状态自适应（启动中 1.2s / 游戏中 3s / 空闲 10s），这里只需启动一次。
  // 延后到首帧之后：首次状态查询要走后端，没必要挡住首屏。
  useEffect(() => {
    deferNonCritical(() => useStore.getState().ensureGameStatusPolling());
  }, []);

  // Mod 文件变化轮询：在 Steam 里取消订阅（vpk 被删）、新订阅下载完成、
  // 手动往 addons 目录增删文件……都能在几秒内自动反映到界面（静默刷新，不弹扫描横幅）。
  useEffect(() => {
    deferNonCritical(() => useStore.getState().ensureModsChangePolling());
  }, []);

  useEffect(() => {
    // 拉数据放在最前：它决定列表能否尽快出现
    refreshAll();
    // Steam 登录要发外网请求（网络差时会等到超时）：一定不能挡住首屏，
    // 延迟到空闲时再发起（失败也只会让左下角显示「登录 Steam」）
    deferNonCritical(() => useStore.getState().initiateSteamLogin(), 600);
  }, [backendConnected]);

  // Show/hide animation: toggle showMascot
  useEffect(() => {
    const was = prevShowMascot.current;
    prevShowMascot.current = showMascot;

    if (!was && showMascot) {
      // Show: reset to default position (bottom-right via CSS), play entrance
      const el = mascotRef.current;
      if (el) {
        el.style.left = '';
        el.style.top = '';
        el.style.bottom = '';
        el.style.right = '';
      }
      setAnimState('entering');
      const t = setTimeout(() => setAnimState('entered'), 600);
      return () => clearTimeout(t);
    } else if (was && !showMascot) {
      // Hide: play exit animation (short)
      setAnimState('exiting');
      const t = setTimeout(() => setAnimState('hidden'), 200);
      return () => clearTimeout(t);
    }
  }, [showMascot]);

  // Initialize on mount
  useEffect(() => {
    if (showMascot) {
      setAnimState('entering');
      const t = setTimeout(() => setAnimState('entered'), 600);
      return () => clearTimeout(t);
    } else {
      setAnimState('hidden');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mascotClasses = [
    'app-mascot',
    animState === 'entering' ? 'app-mascot--enter' : '',
    animState === 'entered' ? 'app-mascot--visible' : '',
    animState === 'exiting' ? 'app-mascot--exit' : '',
    animState === 'hidden' ? 'app-mascot--hidden' : '',
    bouncing ? 'app-mascot--bounce' : '',
    dragging ? 'app-mascot--drag' : '',
    dragEnd ? 'app-mascot--drag-end' : '',
  ].filter(Boolean).join(' ');

  const renderPage = () => {
    const page = (() => {
      switch (currentPage) {
        case 'my-mods':
          return <MyModsPage />;
        case 'workshop':
          return <WorkshopPage />;
        case 'download':
          return <DownloadPage />;
        case 'packs':
          return <PacksPage />;
        case 'settings':
          return <SettingsPage />;
        default:
          return <MyModsPage />;
      }
    })();
    return (
      <div key={currentPage} className="page-transition-wrapper">
        {/* 按需加载的页面在首次切换时会有极短的空档：给一个同色占位，避免闪白 */}
        <Suspense fallback={<div className="page-lazy-fallback" />}>{page}</Suspense>
      </div>
    );
  };

  const hasBg = Boolean(background.imagePath);
  const bgImageUrl = background.imagePath;
  // 无级模糊：保留小数，让内部面板的毛玻璃也跟随滑杆连续变化
  const mainBlur = Math.min(Math.round((background.blur / 2) * 100) / 100, 10);
  // 「界面透明度」→ 容器底色/毛玻璃面板 alpha 的系数：1 = 默认观感，0 = 完全通透
  const uiAlpha = Math.round((1 - background.uiTransparency / 100) * 1000) / 1000;

  return (
    <div
      className={`app${hasBg ? ' app--has-bg' : ''}`}
      style={{ '--ui-alpha': uiAlpha } as CSSProperties}
    >
      {hasBg && (
        <div
          className="app-bg-layer"
          // 透明度 100% 时不下发内联样式，保持与之前完全相同的渲染路径
          style={background.opacity < 100 ? { opacity: background.opacity / 100 } : undefined}
        >
          <div
            className="app-bg"
            style={{
              backgroundImage: `url("${bgImageUrl}")`,
              filter: `blur(${background.blur}px)`,
            }}
          />
          <div
            className="app-bg-dim"
            style={{ opacity: background.dim / 100 }}
          />
        </div>
      )}

      <TitleBar />
      <div className="app-body">
        <Sidebar />
        {/*
          注意：即使 mainBlur 为 0 也必须保留 backdrop-filter（blur(0px)）。
          只要该属性存在（非 none），元素就会走 backdrop-root 的合成路径；
          一旦在模糊滑块最小值时把它移除，面板的透明度/颜色会因合成方式改变而突变。
        */}
        <main
          className={`app-main${hasBg ? ' app-main--transparent' : ''}`}
          style={hasBg ? { backdropFilter: `blur(${mainBlur}px)`, WebkitBackdropFilter: `blur(${mainBlur}px)` } : undefined}
        >
          {renderPage()}
        </main>
      </div>

      {/* 底部这三个浮动 HUD（应用按钮 / 容量条 / 冲突角标）都是「Mod 管理」语境下的元素，
          而且都是贴窗口底部的 absolute 定位。下载页自带一条同样贴底的底部操作栏
          （输出目录 + 线程 + 开始下载），两者必然重叠 —— 所以在下载页整体隐藏，
          切回其它页面自动恢复（状态由 store 决定，不会丢）。 */}
      {currentPage !== 'download' && (
        <>
          {/* 「应用」：把软件里的启停设置写回 addonlist.txt —— 放在主内容左下角。
              有改动没应用时按钮点亮（见 store.modsDirty），一眼能看出还没同步给游戏。 */}
          <button
            className={[
              'app-apply',
              modsDirty ? 'app-apply--dirty' : '',
              applyingPrefs ? 'app-apply--busy' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => void applyModPrefsToGame()}
            disabled={applyingPrefs || !modsDirty}
            title={
              modsDirty
                ? '把这里的启用/禁用状态写入 addonlist.txt\n' +
                  '游戏运行中：点完在游戏主页面进一次「附加内容」，游戏会重读并应用\n' +
                  '游戏未运行：下次启动游戏即生效'
                : '当前没有未应用的改动（改过 Mod 启停后这个按钮才会亮起）'
            }
          >
            {applyingPrefs ? '应用中' : '应用'}
          </button>

          <UsageBar />

          {/* Standalone conflict counter - bottom right, above usage bar */}
          <ConflictBadge />
        </>
      )}

      {!backendConnected && <BackendErrorOverlay />}

      <DropOverlay addonsPath={addonsPath} />

      {/* 检测到游戏内改过 Mod 启停（游戏退出写回 addonlist.txt）时询问是否同步 */}
      <Suspense fallback={null}>
        <AddonlistSyncDialog />
      </Suspense>

      <ToastContainer />

      {/* 帧率诊断浮层（Ctrl+Shift+F）：动图播放的耗时/掉帧是否符合 180fps 预算，靠它读 */}
      <PerfOverlay />

      {/* 应用内二次确认弹窗（替代原生 window.confirm） */}
      <ConfirmHost />

      {/* 创意工坊检查/更新的常驻进度条：挂在根部，切到任何页面都看得到 */}
      <WorkshopUpdateDock />

      {/* 首次/刷新扫描中的全局进度提示（Mod 页内已有更详细展示） */}
      {scanning && currentPage !== 'my-mods' && (
        <ScanningBanner
          done={scanProgress ? scanProgress.done : 0}
          total={scanProgress ? scanProgress.total : null}
        />
      )}

      {/* Mascot always in DOM - CSS controls visibility */}
      <div
        className={mascotClasses}
        ref={mascotRef}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
      >
        <img src={xiaochunImg} alt="小春" />
      </div>
    </div>
  );
}

export default App;
