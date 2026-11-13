import { useEffect, useRef, useState } from 'react';
import {
  acquireAnimation,
  releaseAnimation,
  type AnimationFrames,
} from '../utils/animatedThumbnail';
import {
  framePeriodMs,
  recordCadenceGap,
  recordDrawCost,
  recordQuantizedRate,
  subscribeFrame,
} from '../utils/frameLoop';

interface AnimatedThumbProps {
  src: string;
  alt: string;
  className?: string;
  maxWidth: number;
  maxHeight: number;
  /** 卡片在视口内、且系统/用户允许动画时为 true（进入视口即自动播放） */
  playing: boolean;
  /** 第一帧真正画到 canvas 上时回调一次 —— 父组件靠它决定何时让出静态首帧 */
  onPainted?: () => void;
  /** 拿不到可播放帧时通知父组件回落到静态图 */
  onUnavailable?: () => void;
}

/**
 * 把每帧时长量化成**整数个刷新周期**。
 *
 * 这是帧间隔波动 ≤10% 的关键一步。原做法是拿浮点毫秒累加、跨过阈值才换帧，
 * 但 rAF 的间隔天生是刷新周期的整数倍：60Hz 下 100ms 的帧要用 6 个 16.6667ms
 * 拼出来（99.9998ms，差 0.0002ms），浮点误差会让它**偶尔需要 7 帧**才满足条件 ——
 * 上屏间隔就在 100ms / 116.7ms 之间来回跳，波动 16.7%，肉眼就是周期性一顿。
 * 量化成 6 个整数周期后，相邻两帧的间隔严格相同，波动只剩采样噪声。
 *
 * 代价是帧时长会向刷新周期取整（60Hz 下最大 ±8.3ms）：素材越短，相对偏差越
 * 明显（40ms → 33.3ms）。这是「稳定优先于绝对速度」的取舍；而 100ms 这种
 * 最常见的帧长恰好整除，偏差为 0。
 */
function quantizeHolds(durations: number[], period: number): number[] {
  const safe = period > 0 ? period : 1000 / 60;
  return durations.map((ms) => Math.max(1, Math.round((ms || 0) / safe)));
}

/** 量化造成的整段速度偏差（%）—— 稳定性的代价，照实上报给诊断浮层 */
function reportRateError(durations: number[], holds: number[], period: number): void {
  let target = 0;
  for (const ms of durations) target += ms;
  if (target <= 0) return;
  let quantized = 0;
  for (const h of holds) quantized += h * period;
  recordQuantizedRate((Math.abs(quantized - target) / target) * 100);
}

/**
 * 卡片动图播放器。
 *
 * 三个刻意的设计：
 *   1. **画在 canvas 上，而不是把 blob 塞回 `<img>`** —— 只有这条路径能
 *      控制「什么时候解码哪一帧」，内存与帧率才有上限；
 *   2. **播放节奏由共享帧循环驱动**（utils/frameLoop.ts），不额外开 rAF，
 *      也不走 React state —— 每帧 setState 会把整张卡片重渲染 50 次/秒，
 *      那才是真正吃掉帧预算的地方。这里逐帧只碰 canvas，不触发任何渲染；
 *   3. **时间线按整数 tick 推进**，每帧占整数个刷新周期（见 quantizeHolds），
 *      所以上屏间隔不会因为浮点累积误差而周期性多等一帧；
 *      实测偏差通过 recordCadenceGap 上报给诊断浮层；
 *   4. **暂停即释放位图引用**，LRU 才有机会回收；canvas 上已画好的像素
 *      不会因此消失，画面会静静定格在最后一帧。
 */
export function AnimatedThumb({
  src,
  alt,
  className,
  maxWidth,
  maxHeight,
  playing,
  onPainted,
  onUnavailable,
}: AnimatedThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frames, setFrames] = useState<AnimationFrames | null>(null);
  const paintedRef = useRef(false);

  // ── 按需解码：只在这张卡真正要播的时候才动 ──
  useEffect(() => {
    if (!playing) {
      setFrames(null);
      return;
    }

    let cancelled = false;
    let handle: AnimationFrames | null = null;
    paintedRef.current = false;

    acquireAnimation(src, maxWidth, maxHeight)
      .then((result) => {
        if (cancelled) {
          releaseAnimation(result);
          return;
        }
        handle = result;
        if (!result) {
          onUnavailable?.();
          return;
        }
        setFrames(result);
      })
      .catch((err) => {
        // 解码失败不抛到界面上，静默回落静态图即可
        console.warn('[AnimatedThumb] 动图解码失败:', err);
        if (!cancelled) onUnavailable?.();
      });

    return () => {
      cancelled = true;
      releaseAnimation(handle);
      setFrames(null);
    };
    // onUnavailable 由父组件用 useCallback 固定，不必进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, src, maxWidth, maxHeight]);

  // ── 播放：共享帧循环 + 整数 tick 时间线 ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!playing || !frames || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { frames: bitmaps, durations } = frames;
    if (!bitmaps.length) return;

    let period = framePeriodMs();
    let holds = quantizeHolds(durations, period);
    reportRateError(durations, holds, period);
    let index = 0;
    /** 当前这一帧已经占用了几个刷新周期 */
    let ticks = 0;
    let lastTs = 0;
    let lastPaintTs = performance.now();

    const paint = (ts: number) => {
      const started = performance.now();
      ctx.drawImage(bitmaps[index], 0, 0);
      // 单帧耗时直接上报给诊断浮层，和 180fps 预算（5.56ms）摆在一起看
      recordDrawCost(performance.now() - started);
      lastPaintTs = ts;
      if (!paintedRef.current) {
        paintedRef.current = true;
        onPainted?.();
      }
    };

    // 首帧立刻上屏：静态首帧要等到这一刻才让位
    paint(lastPaintTs);

    const unsubscribe = subscribeFrame((now) => {
      // 首帧只记时间戳；切标签页/休眠回来后 delta 会很大，
      // 钳到 250ms 以内，避免一恢复就「快进」掉好几帧
      if (!lastTs) {
        lastTs = now;
        return;
      }
      const raw = now - lastTs;
      const dt = Math.min(raw, 250);
      lastTs = now;
      // 被钳过说明刚从中断里恢复，这一段间隔不是播放节奏问题，
      // 记进去会在统计窗口里留下一条几百 % 的假样本
      const resumed = raw > 250;

      // 换屏（60Hz ↔ 144Hz）后量化基准要跟着变，否则整段动画会整体跑快/跑慢
      const live = framePeriodMs();
      if (Math.abs(live - period) / period > 0.02) {
        period = live;
        holds = quantizeHolds(durations, period);
        reportRateError(durations, holds, period);
      }

      // 流逝时间折算成「刷新周期数」而不是毫秒：整数计数没有浮点漂移，
      // 每帧的上屏间隔因此严格等于 hold × period
      ticks += Math.max(1, Math.round(dt / period));

      let moved = false;
      let expectedMs = 0;
      // guard 防的是 holds 异常时死循环（量化后每帧至少 1 tick）
      let guard = 0;
      while (ticks >= holds[index] && guard++ < bitmaps.length) {
        ticks -= holds[index];
        // 这一帧就是「刚才那段间隔」的目标时长
        expectedMs += holds[index] * period;
        index = (index + 1) % bitmaps.length;
        moved = true;
      }
      if (!moved) return;

      // 实际间隔 vs 目标间隔：正常应≈0%，丢刷新周期才会被顶上去。
      // 只统计到「上屏间隔」，不统计解码耗时，才是纯播放节奏的度量。
      if (!resumed) recordCadenceGap(now - lastPaintTs, expectedMs);
      paint(now);
    });

    return () => {
      unsubscribe();
    };
    // onPainted 由父组件用 useCallback 固定，不必进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, frames]);

  return (
    <canvas
      ref={canvasRef}
      width={frames?.width ?? maxWidth}
      height={frames?.height ?? maxHeight}
      className={className ? `thumb-img thumb-canvas ${className}` : 'thumb-img thumb-canvas'}
      aria-label={alt}
      role="img"
    />
  );
}
