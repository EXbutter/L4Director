/**
 * Mod 卡片缩略图优化工具。
 *
 * 背景：玩家 addons 目录里的封面图经常极其离谱，实测存在两类：
 *   1. 8504×8504 的 JPEG（解码后约 276MB 位图，单张就能把内存与 GPU 纹理顶满）；
 *   2. 扩展名写成 `.jpg`、内容其实是 **GIF 动图** 的文件（最大 28MB / 81 帧，
 *      还有 119 帧、114 帧的）。
 *
 * 第 2 类才是真正的性能杀手：Chromium 的 `<img>` 会把动画的**所有帧**都解码
 * 缓存起来（81 帧 × 831×1186 × 4B ≈ 300MB），再加上每帧都要重绘，滚到这张
 * 卡片时帧率会直接掉到个位数。
 *
 * 处理流程：
 *   1. `fetch` 拿 blob，读文件头做两件事：
 *      - 嗅探**真实格式**（扩展名和后端给的 Content-Type 都可能是错的）；
 *      - 解析出原始像素尺寸与「是否动图」（纯头部解析，不碰像素数据）；
 *   2. 静态小图（不超过上限的 2 倍）直接用原图，零开销；
 *   3. 其余一律 `createImageBitmap(blob, { resizeWidth, resizeHeight })` ——
 *      只解第一帧（动图被冻结），并按目标尺寸解码（JPEG 可走缩放解码），
 *      然后在 640×320 以内的小画布上重新编码成 WebP。
 *
 * 两个必须遵守的约束：
 *   - **不能用指向后端的 `<img>` 画 canvas**：页面（`http://localhost:5173` 或
 *     `file://`）与后端（`127.0.0.1:xxxx`）跨源，跨源图片会让 canvas 被污染，
 *     `toBlob()` 直接抛 "Tainted canvases may not be exported"。来自已 fetch
 *     的 blob 的 ImageBitmap 不会有这个问题。
 *   - **不能依赖 WebCodecs 的 ImageDecoder** 来读尺寸：它的 `ImageTrack` 只提供
 *     `frameCount/animated`，没有任何像素尺寸信息（`track.video` 在 Chromium 中
 *     是 undefined），读尺寸只能自己解析文件头。
 *
 * 卡片预览区实际只有 260×130 px，任何原图都能安全降采样。
 *
 * 动图现在的处理分工：
 *   - **静态层**仍然由本模块转成首帧 WebP（视口外、开关关闭时只看这一层）；
 *   - **播放层**由 utils/animatedThumbnail.ts 用 WebCodecs 按需逐帧解码，
 *     卡片进入视口即挂载，帧数与位图都有硬上限。
 *   换句话说，这里的「冻结」不再是永久行为，而是「不播放时的默认形态」。
 */

/** 缩略图目标上限（按 2× 预览区留足余量，保证高 DPI 下依然清晰） */
export const THUMB_MAX_WIDTH = 640;
export const THUMB_MAX_HEIGHT = 320;

/** 编码质量 */
const ENCODE_QUALITY = 0.85;

/**
 * 尺寸容忍倍数：原图不超过「上限 × 该倍数」且是静态图时直接用原图。
 * 640×360 这类工坊常见尺寸没必要为了几十像素做一次转码（还会有画质损失和闪一下）。
 */
const SIZE_TOLERANCE = 2;

/**
 * 头部读取窗口。GIF/PNG/BMP/WebP 只需几十字节，但 JPEG 的 SOFn 段前面可能压着
 * EXIF/ICC/Photoshop 元数据（实测有图把 SOFn 推到 36KB 处），所以要读大一点。
 */
const HEAD_BYTES = 65536;

/** 格式嗅探只需要看文件最前面这一小段 */
const SNIFF_BYTES = 256;

export interface PreparedThumbnail {
  /** 转码后的静态小图地址（blob URL），可直接用于 <img src> */
  url: string;
  /** 转码后的体积（字节），便于排查 */
  bytes: number;
  /**
   * 原图是否为动图（GIF / APNG / 动图 WebP）。
   *
   * `url` 里的东西**永远是静态的首帧** —— 动图播放由 AnimatedThumb 用
   * WebCodecs 逐帧解码另行负责（见 utils/animatedThumbnail.ts）。
   * 这里带出这个标记，是为了让卡片进入视口时才去解码播放，
   * 而不是让每个组件自己再探一次文件头（那等于把文件下载两遍）。
   */
  animated: boolean;
  /** 嗅探出的真实 MIME（扩展名与后端 Content-Type 都可能不准） */
  mime: string;
}

/**
 * 转码结果缓存：来回滚动 / 切换页面时避免重复下载和解码。
 *
 * 这里刻意**不回收**已生成的 blob URL —— 图片滚出视口再滚回来时会复用同一
 * 个地址，回收会让正在显示中的 <img> 变成破图。每张静态缩略图只有几十 KB，
 * 页面关闭时随渲染进程一起释放。
 */
const CACHE = new Map<string, Promise<PreparedThumbnail | null>>();

// ── 头部嗅探与尺寸解析（不解码像素） ──

const ascii = (bytes: Uint8Array, start: number, len: number) =>
  String.fromCharCode(...bytes.subarray(start, start + len));

/** 按内容判断真实 MIME —— 扩展名和后端给的 Content-Type 都不可信 */
export function sniffMime(head: Uint8Array, fallback: string): string {
  if (ascii(head, 0, 3) === 'GIF') return 'image/gif';
  if (ascii(head, 0, 4) === '\x89PNG') return 'image/png';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(head, 0, 2) === 'BM') return 'image/bmp';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  return fallback || 'application/octet-stream';
}

/** APNG / 动图 WebP 需要看 acTL / ANIM 块；GIF 格式本身就可能有多帧 */
export function sniffAnimated(head: Uint8Array, mime: string): boolean {
  if (mime === 'image/gif') return true;
  // 注意只取前一小段：把 64KB 展开进 fromCharCode 会栈溢出
  const text = ascii(head, 0, Math.min(head.length, SNIFF_BYTES));
  if (mime === 'image/png') return text.includes('acTL');
  if (mime === 'image/webp') return text.includes('ANIM');
  return false;
}

interface ImageSize {
  width: number;
  height: number;
}

/** GIF / PNG / BMP 的尺寸都在文件头固定偏移处 */
function readSimpleSize(head: Uint8Array, mime: string): ImageSize | null {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 32) return null;
  if (mime === 'image/gif') {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (mime === 'image/png') {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === 'image/bmp') {
    return { width: view.getUint32(18, true), height: view.getUint32(22, true) };
  }
  return null;
}

/** JPEG：遍历段直到 SOFn（0xC0-0xCF，排除 DHT/JPG/DAC） */
function readJpegSize(head: Uint8Array): ImageSize | null {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let off = 2;
  while (off + 9 <= head.length) {
    if (head[off] !== 0xff) {
      off++;
      continue;
    }
    let marker = head[off + 1];
    // 跳过 marker 前可能出现的 0xFF 填充
    while (marker === 0xff && off + 2 < head.length) {
      off++;
      marker = head[off + 1];
    }
    // 无长度字段的 marker
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(off + 7), height: view.getUint16(off + 5) };
    }
    const len = view.getUint16(off + 2);
    if (len <= 0) break;
    off += 2 + len;
  }
  return null;
}

/** WebP：三种头结构（VP8X 扩展 / VP8 有损 / VP8L 无损） */
function readWebpSize(head: Uint8Array): ImageSize | null {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 30) return null;
  const chunk = ascii(head, 12, 4);
  if (chunk === 'VP8X') {
    return {
      width: (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)) + 1,
      height: (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

/** 解析原始像素尺寸；无法识别时返回 null（调用方按「需要转码」保守处理） */
function readImageSize(head: Uint8Array, mime: string): ImageSize | null {
  if (mime === 'image/jpeg') return readJpegSize(head);
  if (mime === 'image/webp') return readWebpSize(head);
  return readSimpleSize(head, mime);
}


// ── 转码 ──

function computeTarget(width: number, height: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function oversized(width: number, height: number, maxWidth: number, maxHeight: number): boolean {
  return width > maxWidth * SIZE_TOLERANCE || height > maxHeight * SIZE_TOLERANCE;
}

function encodeCanvas(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/webp', ENCODE_QUALITY);
  });
}

/**
 * 按目标尺寸解码第一帧。
 *
 * `createImageBitmap(blob, { resizeWidth, resizeHeight })` 对动图只解第一帧，
 * 对 JPEG 可以走缩放解码，且得到的位图来自已 fetch 的 blob，不会污染 canvas。
 */
async function decodeCardImage(
  blob: Blob,
  size: ImageSize | null,
  animated: boolean,
  maxWidth: number,
  maxHeight: number,
): Promise<{ bitmap: ImageBitmap; width: number; height: number } | null> {
  if (size) {
    const target = computeTarget(size.width, size.height, maxWidth, maxHeight);
    const unchanged = target.width === size.width && target.height === size.height;
    // 尺寸本来就合适、且是静态图：不需要转码
    // （动图即使尺寸合适也必须转码，否则会一直播放动画）
    if (unchanged && !animated) return null;
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: target.width,
      resizeHeight: target.height,
      resizeQuality: 'high',
    });
    return { bitmap, width: target.width, height: target.height };
  }

  // 头部解析不出尺寸（极少见）：只能先解一次拿到真实尺寸
  const full = await createImageBitmap(blob);
  const target = computeTarget(full.width, full.height, maxWidth, maxHeight);
  const unchanged = target.width === full.width && target.height === full.height;
  if (unchanged) {
    if (!animated) {
      full.close();
      return null;
    }
    // createImageBitmap 拿到的只有第一帧：动图正好借此被冻结
    return { bitmap: full, width: full.width, height: full.height };
  }
  try {
    const scaled = await createImageBitmap(full, {
      resizeWidth: target.width,
      resizeHeight: target.height,
      resizeQuality: 'high',
    });
    return { bitmap: scaled, width: target.width, height: target.height };
  } finally {
    full.close();
  }
}

async function buildThumbnail(
  src: string,
  maxWidth: number,
  maxHeight: number,
): Promise<PreparedThumbnail | null> {
  const response = await fetch(src, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`缩略图请求失败: HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.size) throw new Error('缩略图为空');

  // 只读文件头：格式嗅探 + 尺寸解析都不需要触碰像素数据
  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
  const mime = sniffMime(head, blob.type);
  const animated = sniffAnimated(head, mime);
  const size = readImageSize(head, mime);

  // 静态小图：原图直接显示，连一次转码都省掉
  if (!animated && size && !oversized(size.width, size.height, maxWidth, maxHeight)) {
    return null;
  }

  const decoded = await decodeCardImage(blob, size, animated, maxWidth, maxHeight);
  if (!decoded) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // 只画第一帧：动图被冻结，不会再有逐帧解码与重绘
    ctx.drawImage(decoded.bitmap, 0, 0, decoded.width, decoded.height);

    const out = await encodeCanvas(canvas);
    if (!out) throw new Error('缩略图编码失败');
    return { url: URL.createObjectURL(out), bytes: out.size, animated, mime };
  } finally {
    decoded.bitmap.close();
  }
}

/**
 * 获取（带缓存）适合卡片显示的缩略图。
 *
 * @returns
 *   - `PreparedThumbnail`：使用转码后的静态小图；
 *   - `null`：原图尺寸与格式都无需处理，直接用原 URL 即可；
 *   - 抛错：网络 / 解码失败，调用方应回退到原 URL。
 */
export function getPreparedThumbnail(
  src: string,
  maxWidth: number = THUMB_MAX_WIDTH,
  maxHeight: number = THUMB_MAX_HEIGHT,
): Promise<PreparedThumbnail | null> {
  const key = `${src}|${maxWidth}x${maxHeight}`;
  const cached = CACHE.get(key);
  if (cached) return cached;

  const pending = buildThumbnail(src, maxWidth, maxHeight).catch((err) => {
    // 失败不缓存，下次仍可重试
    CACHE.delete(key);
    throw err;
  });

  CACHE.set(key, pending);
  return pending;
}

