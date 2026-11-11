import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { IS_BETA, CHANNEL_LABEL, VERSION_LABEL } from '../utils/appVersion';
import './TitleBar.scss';

/**
 * 标题栏实时 FPS 指示器（设置 → 调试 中开关）。
 *
 * 注意：内部用 requestAnimationFrame 统计，但**每 500ms 才 setState 一次**，
 * 避免显示 FPS 反而带来额外渲染（也刻意不放进全局 store，防止整树重渲）。
 */
function FpsMeter() {
  const [fps, setFps] = useState<number | null>(null);
  const framesRef = useRef(0);
  const windowStartRef = useRef<number>(typeof performance !== 'undefined' ? performance.now() : 0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      framesRef.current += 1;
      const now = performance.now();
      const elapsed = now - windowStartRef.current;
      if (elapsed >= 500) {
        setFps(Math.round((framesRef.current * 1000) / elapsed));
        framesRef.current = 0;
        windowStartRef.current = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const color =
    fps === null ? 'var(--text-muted)' : fps >= 55 ? '#22c55e' : fps >= 30 ? '#f97316' : '#ef4444';

  return (
    <span className="titlebar-fps" title="实时帧率（可在 设置 → 调试 中关闭）">
      <span className="titlebar-fps__dot" style={{ background: color }} />
      <span className="titlebar-fps__value" style={{ color }}>
        {fps === null ? '--' : fps}
      </span>
      <span className="titlebar-fps__unit">FPS</span>
    </span>
  );
}

export function TitleBar() {
  const { theme, toggleTheme, isMaximized, setMaximized, showFps } = useStore();

  useEffect(() => {
    window.electronAPI?.onMaximized((maximized: boolean) => {
      setMaximized(maximized);
    });
  }, [setMaximized]);

  return (
    <div className="titlebar">
      <div className="titlebar-drag">
        <div className="titlebar-title">
          <svg className="titlebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="4" strokeLinecap="round" strokeLinejoin="round"/>
            <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none"/>
          </svg>
          <span>L4Director</span>
          {IS_BETA && (
            <span className="titlebar-beta" title={`预发布版本 ${VERSION_LABEL}，可能有未完成的功能`}>
              {CHANNEL_LABEL}
            </span>
          )}
        </div>
      </div>

      <div className="titlebar-actions">
        {showFps && <FpsMeter />}
        <button
          className="titlebar-btn titlebar-theme"
          onClick={toggleTheme}
          title={theme === 'light' ? '切换到暗色主题' : '切换到亮色主题'}
        >
          {theme === 'light' ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          )}
        </button>

        <button
          className="titlebar-btn titlebar-minimize"
          onClick={() => window.electronAPI?.minimize()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <button
          className="titlebar-btn titlebar-maximize"
          onClick={() => window.electronAPI?.maximize()}
        >
          {isMaximized ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="5" y="5" width="14" height="14" rx="2" />
              <line x1="5" y1="9" x2="19" y2="9" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="5" y="3" width="14" height="14" rx="2" />
            </svg>
          )}
        </button>

        <button
          className="titlebar-btn titlebar-close"
          onClick={() => window.electronAPI?.close()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
