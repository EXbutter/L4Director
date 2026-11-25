/**
 * 把弹出菜单（右键菜单 / 排序下拉等）的位置夹在视口内。
 *
 * 右键点击发生在窗口右下角时，菜单按鼠标坐标定位会溢出到窗口外，
 * 导致部分选项看不到也点不到。这里根据菜单实际尺寸做「右侧越界左移、
 * 下方越界上移」的修正；菜单比视口还大时直接贴边。
 *
 * @param x 期望的左边缘（client 坐标）
 * @param y 期望的上边缘（client 坐标）
 * @param w 菜单宽度（offsetWidth）
 * @param h 菜单高度（offsetHeight）
 * @param margin 距视口边缘的最小间距
 */
export interface MenuPosition {
  x: number;
  y: number;
}

export function clampMenuPosition(x: number, y: number, w: number, h: number, margin = 8): MenuPosition {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0;

  let nx = x;
  let ny = y;

  // 右侧越界 → 左移；左侧越界 → 贴左
  if (nx + w > vw - margin) nx = vw - margin - w;
  if (nx < margin) nx = margin;

  // 下方越界 → 上移；上方越界 → 贴上
  if (ny + h > vh - margin) ny = vh - margin - h;
  if (ny < margin) ny = margin;

  // 菜单比视口还大：贴边（此时上面的 clamp 会算成负值，统一压回 margin）
  if (w > vw - margin * 2) nx = margin;
  if (h > vh - margin * 2) ny = margin;

  return { x: Math.round(nx), y: Math.round(ny) };
}
