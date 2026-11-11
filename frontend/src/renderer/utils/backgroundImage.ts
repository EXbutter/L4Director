/**
 * 背景图优化工具。
 *
 * 用户选择的可能是一张几十 MB、上亿像素的原图，如果直接作为全屏 CSS 背景
 * （并且还会叠加 filter: blur 与 backdrop-filter），会带来：
 *   1. 解码后的位图内存暴涨（几千万像素 ≈ 数百 MB）；
 *   2. GPU 纹理超限，每帧都要对超大纹理做重采样；
 *   3. base64 字符串过大，localStorage 直接写爆（5MB 配额）。
 *
 * 这里在导入时把图片等比缩放到"足够显示"的尺寸并重新编码，
 * 体积通常能压到几百 KB，从根上解决卡顿。
 */

/** 背景图已优化过的标记（用于对旧数据做一次性迁移） */
export const BG_OPTIMIZED_FLAG = 'l4d2-bg-optimized-v1';

/** 最长边硬上限 */
const HARD_MAX_EDGE = 2560;
/** 最长边下限（保证小窗口下也足够清晰） */
const MIN_MAX_EDGE = 1920;
/** 编码质量 */
const ENCODE_QUALITY = 0.85;
/** 小于这个体积（字符数）且尺寸合适时不再重新编码，避免不必要的画质损失 */
const KEEP_AS_IS_CHARS = 1_500_000;

/** 超过这个体积的 data URL 视为"重图"，即使标记位存在也应该重新压缩 */
export const BACKGROUND_HEAVY_CHARS = KEEP_AS_IS_CHARS;

/** 按当前窗口分辨率决定缩放上限，避免 4K 窗口下背景糊成一片 */
function computeMaxEdge(): number {
  const dpr = window.devicePixelRatio || 1;
  const viewportEdge = Math.round(Math.max(window.innerWidth, window.innerHeight) * dpr);
  return Math.min(HARD_MAX_EDGE, Math.max(MIN_MAX_EDGE, viewportEdge));
}

/** 兼容老式 Image 解码 */
function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/** 解码图片：优先 createImageBitmap（大图内存占用更低），失败则回退到 <img> */
async function decodeImage(src: string): Promise<DecodedImage> {
  try {
    const response = await fetch(src);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  } catch {
    const img = await loadImageElement(src);
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      release: () => {},
    };
  }
}

/** 优先输出 WebP（体积更小且支持透明），不支持时回退 JPEG */
function encodeCanvas(canvas: HTMLCanvasElement): string {
  const webp = canvas.toDataURL('image/webp', ENCODE_QUALITY);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', ENCODE_QUALITY);
}

/**
 * 把任意图片来源（data URL / blob URL / 文件 URL）压缩成适合做背景的 data URL。
 *
 * @param src 图片来源
 * @param force 为 true 时即使尺寸已经合适也强制重新编码（例如用户刚选择了新图片）
 */
export async function optimizeBackgroundImage(src: string, force = false): Promise<string> {
  const decoded = await decodeImage(src);
  try {
    const { width: srcW, height: srcH } = decoded;
    if (!srcW || !srcH) throw new Error('无法读取背景图尺寸');

    const maxEdge = computeMaxEdge();
    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    const targetW = Math.max(1, Math.round(srcW * scale));
    const targetH = Math.max(1, Math.round(srcH * scale));

    // 尺寸已合适、体积也不大，并且本身就是 data URL：直接沿用，避免重复压缩
    if (!force && scale === 1 && src.startsWith('data:') && src.length <= KEEP_AS_IS_CHARS) {
      return src;
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, targetW, targetH);

    return encodeCanvas(canvas);
  } finally {
    decoded.release();
  }
}

/** 是否已经对当前背景图做过优化处理 */
export function isBackgroundOptimized(): boolean {
  try {
    return localStorage.getItem(BG_OPTIMIZED_FLAG) === '1';
  } catch {
    return false;
  }
}

/** 标记背景图已优化（同时清理旧标记） */
export function markBackgroundOptimized(): void {
  try {
    localStorage.setItem(BG_OPTIMIZED_FLAG, '1');
  } catch {}
}
