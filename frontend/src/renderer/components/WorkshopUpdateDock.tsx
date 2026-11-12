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
 *
 * 关于进度条，踩过两个坑，这里都按「进度条只能往前走」来兜：
 * 1. 检查阶段原本画的是来回滑动的 indeterminate 条，视觉上就是「没走到头
 *    就从头开始」，看着像坏了 —— 干脆不画条，只留转圈和文字；
 * 2. 下载进度按「已完成条目 + 当前文件百分比」算，但后端每换一个条目都会把
 *    当前文件百分比清零，一个条目有多个落地路径时还会在条目内部回零，算出来
 *    的整体进度就会往回跳。所以本地只保留最大值（bar 单调递增）。
 */
export function WorkshopUpdateDock() {
  const workshopUpdates = useStore((s) => s.workshopUpdates);
  const applying = workshopUpdates?.applying;
  const running = !!applying?.running;
  const checking = !!workshopUpdates?.checking && !running;

  // 进度的单调值：只在比上一次大时更新，任务结束再清零
  const [bar, setBar] = useState(0);
  // 刚跑完时先停在 100% 亮一会儿再收起，否则进度条永远走不到头
  const [finished, setFinished] = useState<{ done: number; errors: number } | null>(null);

  const latestApplying = useRef(applying);
  latestApplying.current = applying;
  const wasRunning = useRef(false);

  // 这个 effect 必须声明在「进度推进」那个之前：新任务开始时先把 bar 清零，
  // 后面那个 effect 的 setBar(max) 才会从 0 开始算，不会继承上一轮的值
  useEffect(() => {
    const prev = wasRunning.current;
    wasRunning.current = running;

    if (running) {
      if (!prev) {
        // 新一轮任务：清掉上一轮的完成定格和进度
        setFinished(null);
        setBar(0);
      }
      return;
    }
    if (!prev) return;

    // 刚好跑完：先停在 100% 亮一会儿，否则进度条永远走不到头就消失了
    const ap = latestApplying.current;
    setFinished({ done: ap?.done ?? 0, errors: ap?.errors?.length ?? 0 });
    const timer = setTimeout(() => {
      setFinished(null);
      setBar(0);
    }, 1600);
    return () => clearTimeout(timer);
  }, [running]);

  // 进度只增不减：后端每换一个条目都会把「当前文件百分比」清零，
  // 一个条目有多个落地路径时还会在条目内部回零，直接算会看到进度条往回跳
  useEffect(() => {
    if (!running) return;
    const total = applying?.total ?? 0;
    const done = applying?.done ?? 0;
    const pct = applying?.pct ?? 0;
    const raw = total > 0 ? Math.min(100, ((done + pct / 100) / total) * 100) : 0;
    setBar((prev) => (raw > prev ? raw : prev));
  }, [running, applying?.total, applying?.done, applying?.pct]);

  const active = running || checking || !!finished;

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
  const done = finished ? finished.done : (applying?.done ?? 0);
  // 定格态直接给 100%：用户要的就是「走到底」这个交代
  const overall = finished ? 100 : bar;
  const failed = finished ? finished.errors > 0 : false;

  return (
    <div className="ws-dock" role="status" aria-live="polite">
      {finished ? (
        <span className={`ws-dock__mark ${failed ? 'ws-dock__mark--warn' : ''}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" width="12" height="12">
            {failed ? (
              <>
                <line x1="12" y1="7" x2="12" y2="13" strokeLinecap="round" />
                <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" />
              </>
            ) : (
              <polyline points="20 6 9 17 4 12" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </span>
      ) : (
        <span className="ws-dock__spinner" />
      )}

      <div className="ws-dock__body">
        <div className="ws-dock__title">
          {finished ? (
            <>
              {failed ? '更新结束' : '更新完成'}
              <span className={`ws-dock__count ${failed ? 'ws-dock__count--warn' : ''}`}>
                {done} 个
                {failed && ` · ${finished.errors} 个失败`}
              </span>
            </>
          ) : running ? (
            <>
              正在更新创意工坊 Mod
              <span className="ws-dock__count">
                {done}/{total}
                {bar > 0 && ` · ${Math.round(bar)}%`}
              </span>
            </>
          ) : (
            <>
              正在检查创意工坊更新
              <span className="ws-dock__hint">正在查询 Steam，请稍候</span>
            </>
          )}
        </div>

        {/* 只有真正有进度可走时才画进度条：检查阶段没有百分比，
            画成滑动条只会让人以为「没走完就重来」 */}
        {(running || finished) && (
          <div className="ws-dock__bar">
            <i className="ws-dock__fill" style={{ width: `${overall}%` }} />
          </div>
        )}

        {(running || finished) && (
          <div className="ws-dock__current" title={running ? applying?.current || '' : ''}>
            {running ? applying?.current || '准备中…' : '文件已覆盖到原位置，启停状态保持不变'}
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
