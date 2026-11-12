import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import './WorkshopUpdateDock.scss';

/**
 * 屏幕底部的「创意工坊更新」常驻提示条。
 *
 * 为什么不用现成的 Toast：检查要联网、更新要下载，动辄几秒到几分钟，
 * 而 Toast 3.5 秒就消失了 —— 用户一转身切到别的页面，就再也看不到进度，
 * 只能靠猜「到底在跑没有」。所以这里做一个跟着任务走的浮层：
 * 任务在它就一直在，任务结束才收起（结果由 Toast 再提示一次）。
 */
export function WorkshopUpdateDock() {
  const workshopUpdates = useStore((s) => s.workshopUpdates);
  const applying = workshopUpdates?.applying;
  const running = !!applying?.running;
  const checking = !!workshopUpdates?.checking && !running;
  const active = running || checking;

  // 用户可以手动收起（比如它挡住了列表底部），但下一轮任务开始时重新出现，
  // 否则一次误关就永远看不到了
  const [dismissed, setDismissed] = useState(false);
  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current) setDismissed(false);
    wasActive.current = active;
  }, [active]);

  if (!active || dismissed) return null;

  const total = applying?.total ?? 0;
  const done = applying?.done ?? 0;
  const pct = applying?.pct ?? 0;
  // 整体进度 = 已完成条目 + 当前条目自身的下载百分比，这样进度条是连续跑的，
  // 而不是每换一个文件才跳一格
  const overall = total > 0 ? Math.min(100, ((done + pct / 100) / total) * 100) : 0;

  return (
    <div className="ws-dock" role="status" aria-live="polite">
      <span className="ws-dock__spinner" />

      <div className="ws-dock__body">
        <div className="ws-dock__title">
          {running ? (
            <>
              正在更新创意工坊 Mod
              <span className="ws-dock__count">
                {done}/{total}
                {pct > 0 && ` · ${Math.round(overall)}%`}
              </span>
            </>
          ) : (
            <>
              正在检查创意工坊更新
              <span className="ws-dock__hint">正在查询 Steam，请稍候</span>
            </>
          )}
        </div>

        {/* 检查时也留一条进度条（不可确定进度的滑动条）：高度与更新时一致，
            浮层不会因为「检查完了开始下载」而突然长高 */}
        <div className={`ws-dock__bar${running ? '' : ' ws-dock__bar--indeterminate'}`}>
          <i
            className="ws-dock__fill"
            style={running ? { width: `${overall}%` } : undefined}
          />
        </div>

        {running && (
          <div className="ws-dock__current" title={applying?.current || ''}>
            {applying?.current || '准备中…'}
          </div>
        )}
      </div>

      <button
        className="ws-dock__close"
        onClick={() => setDismissed(true)}
        title="收起提示（更新会在后台继续，完成后仍会弹出结果）"
        aria-label="收起"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="13" height="13">
          <line x1="18" y1="6" x2="6" y2="18" strokeLinecap="round" />
          <line x1="6" y1="6" x2="18" y2="18" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
