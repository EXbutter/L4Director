import { useCallback, useEffect, useState } from 'react';
import {
  FRAME_BUDGET_MS,
  JITTER_TARGET_PCT,
  readFrameStats,
  resetFrameStats,
  subscribeFrame,
  type FrameStats,
} from '../utils/frameLoop';
import './PerfOverlay.scss';

const STORAGE_KEY = 'l4d2-perf-hud';

/**
 * 帧率诊断浮层（Ctrl + Shift + F 开关，状态记在 localStorage）。
 *
 * 动图有没有给界面添负担，不能靠「看着挺顺」断言，得能读数。四组指标：
 *
 *   1. **呈现帧率** —— rAF 实际回调频率，跟显示器刷新率走（60/120/144/240Hz）；
 *      60Hz 屏上任何应用都只有 60 帧，与代码无关；
 *   2. **长帧 / 最慢帧** —— 明显长于中位间隔的帧数，即肉眼可感的卡顿，
 *      长期为 0 就说明动图没拖累整页；
 *   3. **动图单帧耗时 vs 180fps 预算** —— canvas 绘制实测耗时与 5.56ms 的比值，
 *      这一项才是代码真正负责的部分；
 *   4. **帧率波动 / 节奏偏差** —— 目标均 ≤10%（超标染红），反映有没有忽快忽慢。
 *
 * 刻意不做「绘制吞吐基准」：`drawImage` 是异步提交，空跑 300 次量到的是下发耗时，
 * 能测出几十万 fps 这种无意义的数字。真实成本看播放中的 p95 才有意义。
 */
export function PerfOverlay() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [stats, setStats] = useState<FrameStats | null>(null);

  // 快捷键：Ctrl + Shift + F
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && (event.key === 'F' || event.key === 'f')) {
        event.preventDefault();
        setOpen((prev) => {
          const next = !prev;
          try {
            localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
          } catch {
            /* 写不进去就只在本次会话生效 */
          }
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 打开时挂一个空订阅者，把共享帧循环跑起来 —— 没有订阅者时循环会停，
  // 那样就采不到帧间隔样本了
  useEffect(() => {
    if (!open) return;
    return subscribeFrame(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setStats(readFrameStats());
    const timer = window.setInterval(() => setStats(readFrameStats()), 500);
    return () => window.clearInterval(timer);
  }, [open]);

  const handleReset = useCallback(() => {
    resetFrameStats();
    setStats(readFrameStats());
  }, []);

  if (!open) return null;

  const fps = stats?.fps ?? 0;
  const drawMs = stats?.drawP95 ?? 0;
  const budgetShare = drawMs > 0 ? (drawMs / FRAME_BUDGET_MS) * 100 : 0;
  // 「帧数波动」取两者中更差的那个：jitterPct 看单帧间隔，fpsSwingPct 看
  // 半秒窗口折算出的帧率落差。任何一个超过 10% 都算没达标。
  const swingPct = stats ? Math.max(stats.jitterPct, stats.fpsSwingPct) : 0;
  const swingOk = swingPct <= JITTER_TARGET_PCT;
  const cadenceOk = (stats?.cadenceP95 ?? 0) <= JITTER_TARGET_PCT;

  return (
    <div className="perf-hud" role="status" aria-live="off">
      <div className="perf-hud__head">
        <span className="perf-hud__title">帧率诊断</span>
        <button className="perf-hud__btn" onClick={handleReset} title="清空采样，重新开始统计">
          重置
        </button>
      </div>

      <div className="perf-hud__row">
        <span className="perf-hud__label">呈现帧率</span>
        <span className="perf-hud__value">{fps ? fps.toFixed(1) : '—'} fps</span>
      </div>
      <div className="perf-hud__row">
        <span className="perf-hud__label">刷新周期</span>
        <span className="perf-hud__value">
          {stats?.periodMs ? `${stats.periodMs.toFixed(2)} ms` : '—'}
        </span>
      </div>
      <div className="perf-hud__row">
        <span className="perf-hud__label">帧率波动</span>
        <span className={`perf-hud__value ${stats?.samples ? (swingOk ? 'is-ok' : 'is-warn') : ''}`}>
          {stats?.samples ? `${swingPct.toFixed(1)}%` : '—'}
        </span>
      </div>
      <div className="perf-hud__row">
        <span className="perf-hud__label">长帧</span>
        <span className={`perf-hud__value ${stats && stats.longFrames > 0 ? 'is-warn' : 'is-ok'}`}>
          {stats?.longFrames ?? 0} / {stats?.samples ?? 0}
        </span>
      </div>
      <div className="perf-hud__row">
        <span className="perf-hud__label">最慢帧</span>
        <span className="perf-hud__value">
          {stats?.worstMs ? `${stats.worstMs.toFixed(1)} ms` : '—'}
        </span>
      </div>

      <div className="perf-hud__divider" />

      <div className="perf-hud__row">
        <span className="perf-hud__label">动图节奏偏差</span>
        <span
          className={`perf-hud__value ${
            stats?.cadenceSamples ? (cadenceOk ? 'is-ok' : 'is-warn') : ''
          }`}
        >
          {stats?.cadenceSamples ? `${stats.cadenceP95.toFixed(1)}%` : '未采样'}
        </span>
      </div>
      <div className="perf-hud__row">
        <span className="perf-hud__label">量化速度偏差</span>
        <span
          className={`perf-hud__value ${
            stats?.cadenceSamples
              ? stats.rateErrorPct > JITTER_TARGET_PCT
                ? 'is-warn'
                : 'is-ok'
              : ''
          }`}
        >
          {stats?.cadenceSamples ? `${stats.rateErrorPct.toFixed(1)}%` : '未采样'}
        </span>
      </div>
      <div className="perf-hud__row">
        <span className="perf-hud__label">动图单帧 p95</span>
        <span className="perf-hud__value">
          {stats?.drawSamples ? `${drawMs.toFixed(2)} ms` : '未采样'}
        </span>
      </div>
      <div className="perf-hud__row">
        <span className="perf-hud__label">180fps 预算</span>
        <span className="perf-hud__value">{FRAME_BUDGET_MS.toFixed(2)} ms</span>
      </div>
      <div className="perf-hud__row">
        <span className="perf-hud__label">预算占用</span>
        <span className={`perf-hud__value ${budgetShare > 50 ? 'is-warn' : 'is-ok'}`}>
          {stats?.drawSamples ? `${budgetShare.toFixed(1)}%` : '—'}
        </span>
      </div>

      <p className="perf-hud__note">
        目标：帧率波动、动图节奏偏差均 ≤{JITTER_TARGET_PCT}%。呈现帧率上限由显示器刷新率
        决定；量化速度偏差是「帧时长贴合刷新周期」的代价，100ms 帧长为 0。
      </p>
    </div>
  );
}
