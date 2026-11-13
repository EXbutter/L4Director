/**
 * 卡片动图（GIF / APNG / 动图 WebP）的逐帧解码与生命周期管理。
 *
 * 为什么不用 `<img src="xxx.gif">` 直接播：
 *   Chromium 会把动图的**全部帧**一次性解码并常驻内存。实测玩家目录里
 *   一张 831×1186 / 81 帧的 GIF，解码后占 81 × 831 × 1186 × 4B ≈ 300MB，
 *   再叠加逐帧重绘，滚到那张卡片时整页帧率直接掉到个位数。
 *   —— 这也是此前版本把动图「冻结成第一帧」的原因。
 *
 * 现在的做法：
 *   1. 用 WebCodecs 的 `ImageDecoder` **按需逐帧解码**，配合
 *      `OffscreenCanvas.transferToImageBitmap()` 把每一帧降采样到卡片尺寸，
 *      内存占用从「原始分辨率的全部帧」变成「目标尺寸的抽样帧」；
 *   2. 帧数上限 + 显存上限双闸门：超出就等间隔抽帧，并把被跳过的帧时长
 *      累加到保留帧上 —— 抽稀只降低采样率，不改变动画的播放节奏；
 *   3. 卡片**一进视口就自动播**，所以解码必须限流：同一时刻最多两个动图
 *      在解（`MAX_CONCURRENT_DECODES`），其余排队。十几个 300 帧的 GIF
 *      同时解会把主线程堵出上百毫秒的长帧，那正是「帧数波动」的来源；
 *   4. 解码结果进 LRU 缓存（按组数 + 总字节双上限），滚回来直接复用；
 *      离开视口的播放器会释放引用，缓存才有机会回收；
 *   5. 绘制只有一次 `drawImage`，实测 0.05~0.3ms，相对 180fps 的 5.56ms
 *      单帧预算留有 20 倍余量（见 utils/frameLoop.ts）。
 *
 * 全部位图都来自已 fetch 的 blob，不经过跨源 `<img>`，因此不存在
 * canvas 被污染的问题（这点与 utils/thumbnailImage.ts 的静态转码一致）。
 */

import { sniffAnimated, sniffMime } from './thumbnailImage';

/** 动图播放时单边像素上限：卡片预览区只有 260×116，2× DPI 下 480 宽已够 */
const ANIM_MAX_WIDTH = 480;
const ANIM_MAX_HEIGHT = 240;

/** 单个动图最多保留多少帧（抽稀后的帧数，不是原始帧数） */
const ANIM_MAX_FRAMES = 48;

/** 单个动图的位图总预算：48 帧 × 480×240×4B ≈ 22MB，超了就继续降采样 */
const ANIM_MAX_BYTES = 14 * 1024 * 1024;

/**
 * 缓存里最多留几组解码结果（超出后按最久未使用淘汰）。
 *
 * 自动播放意味着视口里同时有十来张动图，只留 2 组会让滚回去的卡片反复
 * 重解；但也不能无限留 —— 所以还有一个总字节上限兜底。
 */
const MAX_CACHED_ANIMATIONS = 12;

/** 缓存位图总预算：超过后淘汰最久未使用的（正在播的受引用计数保护） */
const MAX_CACHED_BYTES = 96 * 1024 * 1024;

/**
 * 同时解码的动图数量上限。
 * ImageDecoder 的解码本身在别的线程，但逐帧降采样 + transferToImageBitmap
 * 落在主线程；十几个 GIF 一起解会叠出上百毫秒的长帧。
 */
const MAX_CONCURRENT_DECODES = 2;

/** 帧时长缺失/为 0 时的兜底值（GIF 里 0 表示「尽快」，取一个不炸 CPU 的值） */
const DEFAULT_FRAME_MS = 100;

/** 单帧时长下限：再快也没有意义（60Hz 屏一帧都显示不下），且能防死循环 */
const MIN_FRAME_MS = 20;

/** 头部嗅探窗口：格式与动图判定都只需要最前面一小段 */
const HEAD_BYTES = 512;

export interface AnimationFrames {
  /** 已降采样好的帧，按播放顺序排列 */
  frames: ImageBitmap[];
  /** 与 frames 一一对应的帧时长（ms，已把被抽掉的帧时长并入） */
  durations: number[];
  /** 帧的像素尺寸（canvas 的 width/height 用这个值，CSS 负责缩放） */
  width: number;
  height: number;
  /** 原始帧数 / 实际保留帧数，便于诊断抽稀比例 */
  sourceFrames: number;
  /** 位图占用字节数（frames × w × h × 4），用于缓存总量控制 */
  bytes: number;
  /** 释放底层位图。缓存淘汰或组件卸载时调用，重复调用无副作用 */
  release: () => void;
}

interface CacheEntry {
  key: string;
  pending: Promise<AnimationFrames | null>;
  value: AnimationFrames | null;
  /** 正在播放/即将播放的引用计数，>0 时禁止淘汰 */
  refs: number;
  lastUsed: number;
}

const cache = new Map<string, CacheEntry>();

/** 解码并发闸门：超出的排在这里 */
const decodeWaiters: Array<() => void> = [];
let activeDecodes = 0;

async function withDecodeSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeDecodes >= MAX_CONCURRENT_DECODES) {
    // 释放槽位时会直接唤醒队首，不需要轮询
    await new Promise<void>((resolve) => decodeWaiters.push(resolve));
  }
  activeDecodes += 1;
  try {
    return await task();
  } finally {
    activeDecodes -= 1;
    decodeWaiters.shift()?.();
  }
}

/** 当前环境是否支持逐帧解码（Electron 28 / Chromium 120 默认开启） */
export function isAnimatedPlaybackSupported(): boolean {
  return typeof ImageDecoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

function clampSize(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const maxW = Math.min(maxWidth, ANIM_MAX_WIDTH);
  const maxH = Math.min(maxHeight, ANIM_MAX_HEIGHT);
  const scale = Math.min(1, maxW / srcWidth, maxH / srcHeight);
  return {
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
  };
}

async function decodeAnimation(
  src: string,
  maxWidth: number,
  maxHeight: number,
): Promise<AnimationFrames | null> {
  // force-cache：静态缩略图早就把这份文件下过一次，这里基本是内存/磁盘命中
  const response = await fetch(src, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`动图请求失败: HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.size) throw new Error('动图为空');

  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
  const mime = sniffMime(head, blob.type);
  if (!sniffAnimated(head, mime)) return null;
  if (!(await ImageDecoder.isTypeSupported(mime))) return null;

  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: mime });
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const total = track?.frameCount ?? 0;
    // 单帧 GIF 在文件头层面仍然是「GIF」，但没有动画可放 —— 当作静态图处理，
    // 免得卡片进了视口还去解码一张永远不会动的图
    if (!total || total < 2) return null;

    // 先解第 0 帧拿真实像素尺寸（ImageTrack 不提供尺寸信息）
    const first = await decoder.decode({ frameIndex: 0 });
    const srcWidth = first.image.displayWidth || first.image.codedWidth;
    const srcHeight = first.image.displayHeight || first.image.codedHeight;
    first.image.close();
    if (!srcWidth || !srcHeight) return null;

    // 抽稀步长：原始帧数超过上限时等间隔取样
    const step = Math.max(1, Math.ceil(total / ANIM_MAX_FRAMES));
    let target = clampSize(srcWidth, srcHeight, maxWidth, maxHeight);

    // 显存闸门：抽样帧数 × 单帧字节 不能超过预算，超了继续等比缩尺寸
    const kept = Math.ceil(total / step);
    let guard = 0;
    while (target.width * target.height * 4 * kept > ANIM_MAX_BYTES && target.width > 64 && guard++ < 10) {
      target = {
        width: Math.max(48, Math.round(target.width * 0.85)),
        height: Math.max(24, Math.round(target.height * 0.85)),
      };
    }

    const frames: ImageBitmap[] = [];
    const durations: number[] = [];

    // 按组解码：每组的第 1 帧转成位图保留，整组时长累加到这一帧上
    for (let start = 0; start < total; start += step) {
      const end = Math.min(start + step, total);
      let groupMs = 0;

      for (let i = start; i < end; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        try {
          groupMs += (image.duration ?? DEFAULT_FRAME_MS * 1000) / 1000;
          if (i === start) {
            const canvas = new OffscreenCanvas(target.width, target.height);
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('无法创建动图画布上下文');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            // VideoFrame 是合法绘制源；降采样在这一步完成，之后只搬小位图
            ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, target.width, target.height);
            frames.push(canvas.transferToImageBitmap());
          }
        } finally {
          image.close();
        }
      }

      durations.push(Math.max(MIN_FRAME_MS, groupMs));
    }

    if (!frames.length) return null;

    let released = false;
    return {
      frames,
      durations,
      width: target.width,
      height: target.height,
      sourceFrames: total,
      bytes: frames.length * target.width * target.height * 4,
      release: () => {
        if (released) return;
        released = true;
        for (const bmp of frames) bmp.close();
        frames.length = 0;
      },
    };
  } finally {
    decoder.close();
  }
}

/**
 * 淘汰最久未使用、且当前没人引用的缓存项，直到**组数和总字节**都回到上限内。
 * 正在视口里播放的条目带着引用计数，不会被淘汰 —— 宁可暂时超预算，
 * 也不能把正在播的位图拔掉。
 */
function evictIdle(keepKey: string): void {
  let totalBytes = 0;
  for (const entry of cache.values()) totalBytes += entry.value?.bytes ?? 0;

  if (cache.size <= MAX_CACHED_ANIMATIONS && totalBytes <= MAX_CACHED_BYTES) return;

  const idle = [...cache.values()]
    .filter((entry) => entry.key !== keepKey && entry.refs <= 0 && entry.value)
    .sort((a, b) => a.lastUsed - b.lastUsed);

  for (const entry of idle) {
    if (cache.size <= MAX_CACHED_ANIMATIONS && totalBytes <= MAX_CACHED_BYTES) break;
    totalBytes -= entry.value?.bytes ?? 0;
    entry.value?.release();
    cache.delete(entry.key);
  }
}

/**
 * 取得（必要时解码）某张动图的可播放帧。
 *
 * 调用方**必须**在停止播放时调用 `release(handle)` 与之配对，
 * 否则该缓存项永远带着引用计数，无法被淘汰，位图会一直占着内存。
 *
 * 返回 null 表示「不是动图」或环境不支持 —— 调用方应继续显示静态图。
 */
export async function acquireAnimation(
  src: string,
  maxWidth: number,
  maxHeight: number,
): Promise<AnimationFrames | null> {
  const key = `${src}|${maxWidth}x${maxHeight}`;
  let entry = cache.get(key);

  if (!entry) {
    const created: CacheEntry = {
      key,
      pending: Promise.resolve(null as AnimationFrames | null),
      value: null,
      refs: 0,
      lastUsed: performance.now(),
    };
    created.pending = withDecodeSlot(() => decodeAnimation(src, maxWidth, maxHeight))
      .then((value) => {
        created.value = value;
        return value;
      })
      .catch((err) => {
        // 失败不缓存，滚回来重新进视口时可以重试（比如文件刚被替换）
        cache.delete(key);
        throw err;
      });
    cache.set(key, created);
    entry = created;
  }

  entry.refs += 1;
  entry.lastUsed = performance.now();
  const handle = await entry.pending;
  evictIdle(key);
  return handle;
}

/** 与 acquireAnimation 配对，引用计数归零后才允许被淘汰 */
export function releaseAnimation(handle: AnimationFrames | null): void {
  if (!handle) return;
  for (const entry of cache.values()) {
    if (entry.value === handle) {
      entry.refs = Math.max(0, entry.refs - 1);
      entry.lastUsed = performance.now();
      return;
    }
  }
}
