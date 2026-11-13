import { useRef, useEffect, useState, useCallback } from 'react';
import { useStore, getApiBase, formatGameElapsed, Page } from '../store/useStore';
import { VERSION_LABEL, VERSION_DISPLAY, IS_BETA } from '../utils/appVersion';
import { useUpdateStore, hasPendingUpdate } from '../store/useUpdateStore';
import './Sidebar.scss';

const navItems: { page: Page; label: string; icon: JSX.Element }[] = [
  {
    page: 'my-mods',
    label: '我的Mod',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    ),
  },
  {
    page: 'packs',
    label: '整合包',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    ),
  },
  {
    page: 'workshop',
    label: '创意工坊',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
        <path d="M2 12h20" />
      </svg>
    ),
  },
  {
    page: 'download',
    label: '下载',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    ),
  },
  {
    page: 'settings',
    label: '设置',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
];

const NAV_ITEM_HEIGHT = 40; // approximate item height for initial position

/** 点击水波纹：记录坐标与直径，播完动画后从列表里移除 */
interface LaunchRipple {
  id: number;
  x: number;
  y: number;
  size: number;
}

/** 与 SCSS 中 .sidebar-launch-ripple 的动画时长保持一致 */
const RIPPLE_DURATION_MS = 620;

export function Sidebar() {
  const { currentPage, setPage, status, packs, launchGame, steamUser, steamLoginInProgress, initiateSteamLogin, logoutSteam, gameState, gamePid, gameStateSince } = useStore();

  // 点击反馈：按下态 + 水波纹
  const [pressed, setPressed] = useState(false);
  const [ripples, setRipples] = useState<LaunchRipple[]>([]);
  const rippleIdRef = useRef(0);

  // 「已运行」计时用的本地时钟（每秒 tick 一次，只在 running 时运行）
  const [clockNow, setClockNow] = useState(() => Date.now());

  const spawnRipple = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const id = rippleIdRef.current + 1;
    rippleIdRef.current = id;
    setRipples((prev) => [
      ...prev,
      {
        id,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        // 直径取对角线的近似值，保证波纹能铺满整个按钮
        size: Math.max(rect.width, rect.height) * 2.2,
      },
    ]);
    window.setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, RIPPLE_DURATION_MS);
  };

  const handleLaunchGame = (event: React.MouseEvent<HTMLButtonElement>) => {
    spawnRipple(event);
    // 成功/失败/超时的提示统一由 store 里的 Toast 负责，
    // 这里不再用 alert（会阻塞渲染、打断按钮动画，观感很差）
    void launchGame();
  };

  useEffect(() => {
    if (gameState !== 'running' || !gameStateSince) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [gameState, gameStateSince]);

  const elapsedText =
    gameState === 'running' && gameStateSince ? formatGameElapsed(clockNow - gameStateSince) : null;

  const launchLabel =
    gameState === 'launching' ? '正在启动…' : gameState === 'running' ? '游戏中' : '启动游戏';

  // 「游戏中」的计时行是否显示（布局变化 → 需要重新对齐导航指示器）
  const showLaunchTimer = elapsedText !== null;

  // 有新版本时版本号旁边点一个小圆点，点一下直接跳去设置页
  const updateInfo = useUpdateStore((s) => s.info);
  const hasUpdate = hasPendingUpdate(updateInfo ?? null);

  const navRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({
    height: NAV_ITEM_HEIGHT,
    transform: 'translateY(0)',
  });
  // 首次定位前先关掉过渡：否则启动时高亮块会从导航顶端一路滑到当前页，
  // 和页面入场动画叠在一起，看着像「刚打开就抖了一下」。
  const positionedRef = useRef(false);
  const [indicatorSettled, setIndicatorSettled] = useState(false);

  // 指示器的位移/高度由 CSS transition 负责（`.sidebar-indicator`），
  // 这里只改 style，不再额外挂 animating 类 —— 那只会在切换后 400ms 抖一次无用的 setState。
  const updateIndicator = useCallback((targetPage: Page) => {
    const btn = itemRefs.current.get(targetPage);
    if (!btn || !navRef.current) return;

    const navRect = navRef.current.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();

    const top = btnRect.top - navRect.top;
    const height = btnRect.height;

    setIndicatorStyle({
      height,
      transform: `translateY(${top}px)`,
    });

    if (!positionedRef.current) {
      positionedRef.current = true;
      // 等这一帧（带 transition: none）先落地，下一帧再把过渡交还给 CSS
      requestAnimationFrame(() => setIndicatorSettled(true));
    }
  }, []);

  useEffect(() => {
    // Position indicator on initial render and when currentPage changes。
    // 「游戏中」的计时行出现/消失会改变导航项上方的整体高度，也要重新对齐，
    // 否则高亮条会停留在旧位置（表现为高亮条与选中项错位）。
    const timer = setTimeout(() => updateIndicator(currentPage), 50);
    return () => clearTimeout(timer);
  }, [currentPage, showLaunchTimer, updateIndicator]);

  const handleSetPage = (page: Page) => {
    setPage(page);
    updateIndicator(page);
  };

  const setItemRef = (page: string, el: HTMLButtonElement | null) => {
    if (el) {
      itemRefs.current.set(page, el);
    } else {
      itemRefs.current.delete(page);
    }
  };

  return (
    <nav className="sidebar">
      <div className="sidebar-nav" ref={navRef}>
        {/* Launch Game button at the very top */}
        <button
          className={[
            'sidebar-item',
            'sidebar-item--launch',
            gameState === 'launching' ? 'sidebar-item--launch--launching' : '',
            gameState === 'running' ? 'sidebar-item--launch--running' : '',
            pressed ? 'sidebar-item--launch--pressed' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={handleLaunchGame}
          onMouseDown={() => setPressed(true)}
          onMouseUp={() => setPressed(false)}
          onMouseLeave={() => setPressed(false)}
          onBlur={() => setPressed(false)}
          aria-busy={gameState === 'launching'}
          title={
            gameState === 'launching'
              ? '正在等待游戏进程启动…'
              : gameState === 'running'
                ? `游戏运行中${gamePid ? `（PID ${gamePid}）` : ''}`
                : '通过 Steam 启动 Left 4 Dead 2'
          }
        >
          {/* 点击水波纹（按钮本身 overflow: hidden，会被裁在按钮内） */}
          {ripples.map((ripple) => (
            <span
              key={ripple.id}
              className="sidebar-launch-ripple"
              style={{ left: ripple.x, top: ripple.y, width: ripple.size, height: ripple.size }}
              aria-hidden="true"
            />
          ))}

          <span className="sidebar-icon">
            {gameState === 'launching' ? (
              <span className="sidebar-launch-spinner" aria-hidden="true" />
            ) : gameState === 'running' ? (
              <span className="sidebar-launch-eq" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )}
          </span>
          <span className="sidebar-label">{launchLabel}</span>

          {/* 启动中：底部不确定进度条 */}
          {gameState === 'launching' && <span className="sidebar-launch-progress" aria-hidden="true" />}
        </button>

        {/* 游戏中：已运行时长 */}
        {elapsedText && (
          <div
            className="sidebar-launch-timer"
            title={gamePid ? `游戏进程 PID ${gamePid}` : undefined}
          >
            <span className="sidebar-launch-timer__dot" />
            已运行 {elapsedText}
          </div>
        )}

        <div className="sidebar-divider" />

        {/* Sliding indicator background */}
        <div
          className="sidebar-indicator"
          style={indicatorSettled ? indicatorStyle : { ...indicatorStyle, transition: 'none' }}
        />

        <div className="sidebar-nav-items">
          {navItems.map((item) => (
            <button
              key={item.page}
              ref={(el) => setItemRef(item.page, el)}
              className={`sidebar-item ${currentPage === item.page ? 'active' : ''}`}
              onClick={() => handleSetPage(item.page)}
            >
              <span className="sidebar-icon">{item.icon}</span>
              <span className="sidebar-label">{item.label}</span>
              {item.page === 'my-mods' && status && status.mod_count > 0 && (
                <span className="sidebar-badge">{status.mod_count}</span>
              )}
              {item.page === 'packs' && packs.length > 0 && (
                <span className="sidebar-badge">{packs.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-footer">
        {/* Steam User Avatar / Login */}
        <div
          className={`sidebar-steam ${steamUser ? 'sidebar-steam--logged' : ''} ${steamLoginInProgress ? 'sidebar-steam--loading' : ''}`}
          onClick={() => {
            if (steamLoginInProgress) return;
            if (steamUser) {
              logoutSteam();
            } else {
              initiateSteamLogin();
            }
          }}
          title={steamUser ? `已登录为 ${steamUser.nickname}，点击退出` : '点击登录 Steam 账户'}
        >
          {steamUser ? (
            <>
              <img
                className="sidebar-steam__avatar"
                src={`${getApiBase()}/api/auth/steam/avatar`}
                alt={steamUser.nickname}
                referrerPolicy="no-referrer"
              />
              <span className="sidebar-steam__name">{steamUser.nickname}</span>
            </>
          ) : (
            <>
              <div className="sidebar-steam__avatar sidebar-steam__avatar--default">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 22c0-4.418 3.582-8 8-8s8 3.582 8 8" />
                </svg>
              </div>
              <span className="sidebar-steam__name">
                {steamLoginInProgress ? '登录中...' : '登录 Steam'}
              </span>
            </>
          )}
        </div>

        {status?.game_detected ? (
          <div className="sidebar-status connected">
            <span className="sidebar-status-dot" />
            已连接
          </div>
        ) : (
          <div className="sidebar-status disconnected">
            <span className="sidebar-status-dot" />
            未连接
          </div>
        )}
        <div
          className={`sidebar-version${hasUpdate ? ' sidebar-version--update' : ''}`}
          title={
            hasUpdate
              ? `发现新版本 v${updateInfo?.version}，点击去「设置 → 关于」更新`
              : `L4Director ${VERSION_LABEL}`
          }
          onClick={hasUpdate ? () => handleSetPage('settings') : undefined}
        >
          <span className={`sidebar-version__num${IS_BETA ? ' sidebar-version__num--beta' : ''}`}>
            {VERSION_DISPLAY}
          </span>
          {hasUpdate && <span className="sidebar-version__dot" aria-label="有新版本" />}
        </div>
      </div>
    </nav>
  );
}
