/**
 * 共享帧循环 —— 所有卡片动图共用一条 `requestAnimationFrame`。
 *
 * 为什么不让每个播放器各起一条 rAF：
 *   一张卡片一条循环的话，20 张卡片同时播放就是 20 条独立时间线，每帧要在
 *   20 个回调里各画一次 canvas。Chromium 会把它们排在同一个 vsync 上，但回调
 *   数量、React 外的时间线累加、各自的时间戳对齐都是纯浪费；更重要的是无法
 *   统一限流 —— 出了掉帧也说不清是谁干的。
 *   收敛成一条循环后，每帧只遍历一次订阅者集合，谁该出下一帧谁才画，
 *   没到帧的订阅者只做一次数值比较（纳秒级），不开销。
 *
 * 关于「180 帧」这个指标，必须先说清两件事，否则会被测出的数字误导：
 *   1. 这里的 rAF 由 Chromium 的 BeginFrame 驱动，跟着**显示器刷新率**走
 *      （60 / 120 / 144 / 165 / 240Hz）。60Hz 屏上一秒钟只会收到 60 次回调，
 *      这是合成器 vsync 的硬上限，不是代码能突破的；
 *   2. 所以「呈现帧率」永远不可能超过屏幕刷新率，180fps 只在 180Hz 以上的
 *      面板上才可能被观测到。我们能保证、也必须保证的是另一件事：
 *      **动画自己占用的单帧时间远低于 180fps 对应的 5.56ms 预算**，
 *      即动图永远不是掉帧的成因。`FRAME_BUDGET_MS` 就是这条预算线，
 *      诊断浮层会把实测值直接和它摆在一起对比。
 *
 * 关于「帧率波动 ≤ 10%」：
 *   rAF 的间隔天生是刷新周期的整数倍，所以**动画的时间线必须踩在刷新网格上**，
 *   而不能拿浮点毫秒去累加（100ms ÷ 16.6667ms 累加 6 次是 99.9998ms，
 *   差一点就多等一帧，肉眼就是「偶尔顿一下」）。这里提供 `framePeriodMs()`
 *   给播放器把每帧时长量化成整数个刷新周期，播放器则按**整数 tick 计数**
 *   推进时间线（见 components/AnimatedThumb.tsx）。
 *   同时本模块负责采集两个波动指标：
 *     - `jitterPct`：帧间隔 p90 与 p10 的相对间距（呈现节拍的抖动）；
 *     - `fpsSwingPct`：按窗口折算的帧率最大落差（“帧数”的波动）。
 *   诊断浮层把两者按 10% 阈值染色，达标与否不用嘴说。
 */

/**
 * 180 fps 对应的单帧预算（毫秒）≈ 5.56ms。
 *
 * 一次动图绘制的实测耗时通常在 0.05~0.3ms（480×240 位图 → 260×116 画布），
 * 占预算的 1%~5%。留出这一大截余量是刻意的：卡片同时在播、鼠标移动触发
 * hover 重绘、React 自身更新都可能挤在同一帧里，动画不该把余量吃光。
 */
export const FRAME_BUDGET_MS = 1000 / 180;

/** 帧间隔采样窗口（帧）。240 帧 ≈ 60Hz 下 4 秒、144Hz 下 1.7 秒 */
const DELTA_WINDOW = 240;

/** 绘制耗时采样窗口（次） */
const DRAW_WINDOW = 240;

/** 节奏偏差采样窗口（帧） */
const CADENCE_WINDOW = 240;

/** 未测出刷新周期前的兜底值（60Hz） */
const DEFAULT_PERIOD_MS = 1000 / 60;

/** 帧率落差的统计窗口（帧）：30 帧 ≈ 60Hz 下 0.5 秒，短到能看出瞬时抖动 */
const SWING_WINDOW = 30;

/** 判定「波动达标」的阈值（%），浮层与文档共用同一个数 */
export const JITTER_TARGET_PCT = 10;

type FrameSubscriber = (now: number, deltaMs: number) => void;

const subscribers = new Set<FrameSubscriber>();
const deltas: number[] = [];
const drawCosts: number[] = [];
const cadenceErrors: number[] = [];

let rafId = 0;
let lastTimestamp = 0;
/** 实测刷新周期（ms），取帧间隔中位数；换屏/改刷新率时自动跟随 */
let periodMs = DEFAULT_PERIOD_MS;
/** 动图量化后最差的速度偏差（%），只由播放器上报 */
let rateErrorPct = 0;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function refreshPeriod(): void {
  if (deltas.length < 8) return;
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  // 中位数落在 4ms 以下或 100ms 以上只可能是采样异常，宁可继续用旧值
  if (median > 4 && median < 100) periodMs = median;
}

function tick(now: number) {
  rafId = requestAnimationFrame(tick);

  const delta = lastTimestamp ? now - lastTimestamp : 0;
  lastTimestamp = now;

  // 单帧间隔超过 1s 说明页面刚被切回来 / 刚从休眠恢复，这类样本会把
  // 「中位帧率」以外的统计拉得很难看，直接丢弃
  if (delta > 0 && delta < 1000) {
    deltas.push(delta);
    if (deltas.length > DELTA_WINDOW) deltas.shift();
    refreshPeriod();
  }

  // 遍历副本：订阅者可能在回调里退订（比如播完最后一帧就停），
  // 直接对着 Set 迭代并修改是未定义行为
  for (const fn of Array.from(subscribers)) {
    try {
      fn(now, delta);
    } catch (err) {
      // 单个播放器出错不该让整条循环停摆（其他卡片还在播）
      console.error('[frameLoop] 订阅者异常:', err);
    }
  }
}

/**
 * 订阅全局帧循环。
 *
 * 返回退订函数；**最后一个订阅者退出时循环会自动停掉**，
 * 界面静止时不会有一个空转的 rAF 一直唤醒 GPU。
 */
export function subscribeFrame(fn: FrameSubscriber): () => void {
  subscribers.add(fn);
  if (!rafId) {
    lastTimestamp = 0;
    rafId = requestAnimationFrame(tick);
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers.delete(fn);
    if (!subscribers.size && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}

/**
 * 当前显示器的刷新周期（ms，实测中位数，未测出时按 60Hz 兜底）。
 *
 * 播放器用它把每帧时长量化成整数个刷新周期 —— 这是帧间隔稳定在
 * ±10% 以内的前提：只要每帧占整数个 vsync，相邻两帧的上屏间隔就完全相同。
 */
export function framePeriodMs(): number {
  return periodMs;
}

/** 播放器上报一次「绘制一帧动图」的实际耗时（ms），供诊断浮层统计 */
export function recordDrawCost(ms: number): void {
  drawCosts.push(ms);
  if (drawCosts.length > DRAW_WINDOW) drawCosts.shift();
}

/**
 * 播放器上报一次「两帧之间的实际间隔」与「按刷新周期量化后的目标间隔」。
 *
 * 只在两者明显不等时才有意义，所以这里存的是**相对偏差**而不是原始间隔：
 * 不同卡片每帧占用的 vsync 数不一样（6 个 / 12 个），原始间隔没法混在一起
 * 统计，偏差可以。理想值是 0%，掉帧才会把它顶上去。
 */
export function recordCadenceGap(actualMs: number, expectedMs: number): void {
  if (actualMs <= 0 || expectedMs <= 0) return;
  const error = (Math.abs(actualMs - expectedMs) / expectedMs) * 100;
  cadenceErrors.push(error);
  if (cadenceErrors.length > CADENCE_WINDOW) cadenceErrors.shift();
}

/**
 * 播放器上报一次「把帧时长量化到刷新网格后，整段动画的速度偏差」。
 *
 * 稳定与准确是互相拉扯的：40ms 的帧在 60Hz 上只能用 2 个周期（33.3ms）或
 * 3 个周期（50ms）显示，选前者会快 16.7%。这里存的是所有动图里**最差**的
 * 那个偏差，浮层照实显示，不让「波动很小」掩盖掉「稍微快了一点」。
 */
export function recordQuantizedRate(pct: number): void {
  if (!Number.isFinite(pct)) return;
  rateErrorPct = Math.max(rateErrorPct, pct);
}

/** 清空采样，重新开始统计（诊断浮层点「重置」时用） */
export function resetFrameStats(): void {
  deltas.length = 0;
  drawCosts.length = 0;
  cadenceErrors.length = 0;
  rateErrorPct = 0;
  lastTimestamp = 0;
}

export interface FrameStats {
  /** 最近窗口内的呈现帧率（按帧间隔中位数折算，避免偶发长帧把均值拉低） */
  fps: number;
  /** 最长的一次帧间隔（ms） */
  worstMs: number;
  /** 明显偏长的帧数（> 中位间隔 × 1.5），即肉眼能感知的卡顿次数 */
  longFrames: number;
  /** 已采集的帧间隔样本数 */
  samples: number;
  /** 帧间隔波动：(p90 - p10) / 中位数，越小越稳 */
  jitterPct: number;
  /** 帧率波动：各统计窗口帧率的最大落差 / 平均帧率 */
  fpsSwingPct: number;
  /** 动图绘制耗时 p95（ms） */
  drawP95: number;
  /** 动图绘制耗时中位数（ms） */
  drawMedian: number;
  /** 已采集的绘制样本数 */
  drawSamples: number;
  /** 动图播放节奏偏差 p95（%），与 10% 目标对比 */
  cadenceP95: number;
  /** 已采集的节奏样本数 */
  cadenceSamples: number;
  /** 帧时长量化到刷新网格后最差的速度偏差（%），衡量「稳」的代价 */
  rateErrorPct: number;
  /** 实测刷新周期（ms） */
  periodMs: number;
}

export function readFrameStats(): FrameStats {
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const threshold = median > 0 ? median * 1.5 : 0;
  const drawSorted = [...drawCosts].sort((a, b) => a - b);
  const cadenceSorted = [...cadenceErrors].sort((a, b) => a - b);

  // 按窗口折算帧率再取落差：比单个间隔的极值更能反映「帧数忽高忽低」
  let fpsSwingPct = 0;
  if (deltas.length >= SWING_WINDOW * 2) {
    let minFps = Infinity;
    let maxFps = 0;
    let sum = 0;
    let windows = 0;
    for (let i = 0; i + SWING_WINDOW <= deltas.length; i += SWING_WINDOW) {
      const slice = deltas.slice(i, i + SWING_WINDOW);
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
      if (mean <= 0) continue;
      const fps = 1000 / mean;
      minFps = Math.min(minFps, fps);
      maxFps = Math.max(maxFps, fps);
      sum += fps;
      windows++;
    }
    if (windows > 0 && sum > 0) {
      const avg = sum / windows;
      fpsSwingPct = ((maxFps - minFps) / avg) * 100;
    }
  }

  return {
    fps: median > 0 ? 1000 / median : 0,
    worstMs: sorted.length ? sorted[sorted.length - 1] : 0,
    longFrames: threshold > 0 ? deltas.filter((d) => d > threshold).length : 0,
    samples: deltas.length,
    // p90 与 p10 的间距对偶发长帧不敏感，才是「节拍稳不稳」的稳定度量
    jitterPct: median > 0 ? ((percentile(sorted, 0.9) - percentile(sorted, 0.1)) / median) * 100 : 0,
    fpsSwingPct,
    drawP95: percentile(drawSorted, 0.95),
    drawMedian: percentile(drawSorted, 0.5),
    drawSamples: drawCosts.length,
    cadenceP95: percentile(cadenceSorted, 0.95),
    cadenceSamples: cadenceErrors.length,
    rateErrorPct,
    periodMs,
  };
}
