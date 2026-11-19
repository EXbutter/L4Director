/**
 * 窗口初始尺寸与位置（纯函数，便于单测）。
 *
 * 为什么不再写死 1440×900：
 *   - 2K（2560×1440）上 1440 只占 56% 宽，一屏 4 张卡、右侧大片空；
 *   - 1080p@150% 的工作区只有约 1280×680，写死的 1440×900 会跑到屏幕外；
 *   - 用户习惯最大化/放副屏，重启却每次都回到固定值（这里只算初始值，
 *     持久化在 main.ts 里做）。
 *
 * 尺寸口径来自实测（1440 → 4 张卡 / 网格 1194；加 340 右栏后 → 3 张）：
 *   每行卡片 = floor((窗口宽 - 246 - 右栏 + 14) / 244)，卡最小 230、间距 14。
 * 因此 2K 上取 1680 能让「没右栏 5 张、有右栏 4 张」，正好是加一列而不挤。
 */

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface InitialWindow {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** 最小可用尺寸：1360×660 下仍是 3 张卡/行，且能塞进 1080p@150% 的工作区 */
export const MIN_WINDOW_WIDTH = 1360;
export const MIN_WINDOW_HEIGHT = 660;

/** 首启上限：再宽在 1080p 上就放不下，再高会压掉一行卡 */
export const MAX_WINDOW_WIDTH = 1680;
export const MAX_WINDOW_HEIGHT = 1000;

/**
 * 首启占工作区的比例。
 *   宽 0.75：1080p → 1920×0.75 = 1440（与旧默认一致，不倒退）；2K → 1920，被上限压到 1680（+1 列卡）
 *   高 0.86：1080p → 894 ≈ 旧默认 900；2K → 1197，被上限压到 1000（多出约半行）
 */
const WIDTH_RATIO = 0.75;
const HEIGHT_RATIO = 0.86;
const FALLBACK_WIDTH = 1440;
const FALLBACK_HEIGHT = 900;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function centeredIn(area: WorkArea, width: number, height: number): InitialWindow {
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    maximized: false,
  };
}

/** 首次启动（或存档不可用）时的尺寸：按工作区比例算，再夹进上下限 */
export function defaultWindowFor(area: WorkArea): InitialWindow {
  // 屏幕上限优先于「最小可用尺寸」：1080p@150% 的工作区只有 1280 宽，
  // 硬套 1360 的下限会让窗口超出屏幕（比小一点更糟）。
  const maxW = Math.max(640, Math.min(MAX_WINDOW_WIDTH, area.width));
  const maxH = Math.max(480, Math.min(MAX_WINDOW_HEIGHT, area.height - 40));
  const width = Math.round(clamp(area.width * WIDTH_RATIO, Math.min(MIN_WINDOW_WIDTH, maxW), maxW));
  const height = Math.round(clamp(area.height * HEIGHT_RATIO, Math.min(MIN_WINDOW_HEIGHT, maxH), maxH));
  return centeredIn(area, width, height);
}

/**
 * 把上次的窗口矩形放回屏幕里。
 *
 * 位置策略：**完整可见就保留，否则回这块屏居中**（尺寸尽量保住）。
 * 不做「留 120px 在屏幕边缘」那种夹取 —— 拔掉副屏后窗口只剩一条边露在屏幕外，
 * 用户的第一反应是「软件打不开」而不是「它还在那儿」。尺寸则一定夹进工作区，
 * 否则换小屏后窗口会伸到屏幕外面。
 */
export function restoreWindowInto(area: WorkArea, saved: SavedBounds): InitialWindow {
  const width = Math.round(clamp(saved.width, Math.min(MIN_WINDOW_WIDTH, area.width), area.width));
  const height = Math.round(
    clamp(saved.height, Math.min(MIN_WINDOW_HEIGHT, Math.max(480, area.height - 40)), Math.max(240, area.height - 40)),
  );
  const fallbackX = Math.round(area.x + (area.width - width) / 2);
  const fallbackY = Math.round(area.y + (area.height - height) / 2);
  const x0 = saved.x;
  const y0 = saved.y;
  const fullyInside =
    typeof x0 === 'number' && typeof y0 === 'number' &&
    x0 >= area.x && y0 >= area.y &&
    x0 + width <= area.x + area.width && y0 + height <= area.y + area.height;
  return {
    x: fullyInside ? Math.round(x0 as number) : fallbackX,
    y: fullyInside ? Math.round(y0 as number) : fallbackY,
    width,
    height,
    maximized: !!saved.maximized,
  };
}

/**
 * 决定这次启动用多大的窗口。
 *
 * @param areas  所有显示器的工作区（第一项应是当前主显示器）
 * @param saved  上次关闭时的窗口状态（可能来自已拔掉的显示器）
 */
export function computeInitialWindow(areas: WorkArea[], saved?: SavedBounds | null): InitialWindow {
  if (!areas.length) {
    return { x: 0, y: 0, width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT, maximized: false };
  }
  const primary = areas[0];
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)
      || saved.width <= 0 || saved.height <= 0) {
    return defaultWindowFor(primary);
  }
  // 存档落在某个显示器上就按那块屏夹取，否则回主屏 —— 「看得见」优先于「位置不变」
  const host =
    areas.find((a) => {
      const cx = (saved.x ?? a.x) + saved.width / 2;
      const cy = (saved.y ?? a.y) + saved.height / 2;
      return cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height;
    }) ?? primary;
  return restoreWindowInto(host, saved);
}
