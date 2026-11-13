/**
 * 主题色卡（预设主色）。
 *
 * 设计思路：整套皮肤的深浅色阶、边框、光晕、画布渐变在 CSS 里都由 `--accent`
 * 用 color-mix() 推导（见 styles/global.scss），所以「换主题色」只需要在运行时
 * 覆盖 `--accent` / `--accent-rgb` 两个变量，外加标题栏底色和它的文字色。
 *
 * 这样做的代价是：如果主色取太浅（比如亮黄），白字会看不清。所以这里会按
 * 相对亮度做一次「可用性校正」——浅色会被压暗一点，再决定标题栏/主按钮上用
 * 白字还是深色字。
 */

export interface AccentPreset {
  key: string;
  label: string;
  color: string;
}

/**
 * 预设色卡：六档 —— 默认蓝、青碧、石墨 + 玫红、紫罗兰、琥珀。
 *
 * 前三档是「工具感」的冷/中性色，适合长时间盯着看；后三档是「氛围感」的
 * 暖色与紫调，用来给不同场景换个心情。
 *
 * 六档的色相彼此拉开（蓝 / 青绿 / 中性灰 / 玫红 / 紫 / 橙），任意两档都不会
 * 看着像重复。色卡不支持自定义输入，所有可能的主色都在这里穷举，配色始终可控。
 *
 * 选色的硬约束：相对亮度要落在 0.13~0.30 之间。低于 0.13（暗色主题下和深蓝
 * 画布糊在一起）会被 accentFill 提亮，高于 0.62（亮色主题下白底看不清）会被
 * 压暗 —— 一旦触发校正，色卡显示的色和界面实际的色就对不上了。这六档都
 * 落在区间内，**显示即所得**。
 */
export const ACCENT_PRESETS: AccentPreset[] = [
  { key: 'launcher', label: '默认蓝', color: '#1e88e5' },
  { key: 'cyan', label: '青碧', color: '#0d9488' },
  { key: 'graphite', label: '石墨', color: '#475569' },
  { key: 'rose', label: '玫红', color: '#e11d48' },
  { key: 'violet', label: '紫罗兰', color: '#7c3aed' },
  { key: 'amber', label: '琥珀', color: '#d97706' },
];

export const DEFAULT_ACCENT = ACCENT_PRESETS[0].color;

const STORAGE_KEY = 'l4d2-accent';

/** 把 #abc / #aabbcc / aabbcc 统一成 #aabbcc；非法输入返回 null */
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  let v = input.trim().replace(/^#/, '');
  if (v.length === 3) {
    v = v
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return null;
  return `#${v.toLowerCase()}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = normalizeHex(hex) || DEFAULT_ACCENT;
  return {
    r: parseInt(v.slice(1, 3), 16),
    g: parseInt(v.slice(3, 5), 16),
    b: parseInt(v.slice(5, 7), 16),
  };
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** 按比例混合两个颜色，weightB 是「第二个颜色占多少」（0~1） */
export function mixHex(a: string, b: string, weightB: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const w = Math.max(0, Math.min(1, weightB));
  return rgbToHex(
    ca.r + (cb.r - ca.r) * w,
    ca.g + (cb.g - ca.g) * w,
    ca.b + (cb.b - ca.b) * w
  );
}

/** 相对亮度（WCAG 口径），用来判断该配白字还是深色字 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const srgb = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

/**
 * 主色底上应该用哪种文字色。
 *
 * 阈值 0.30：低于它的底色用白字（对比度 ≥ 3:1，够按钮标题这种较大字号用），
 * 高于它的用深色字。原先取 0.55，导致中浅色底（如自定义的粉、青）配白字只有
 * 2.x:1，暗色模式下尤其糊。预设色卡都落在 0.30 以下，观感与之前一致。
 */
export function readableOn(hex: string): string {
  return relativeLuminance(hex) > 0.3 ? '#1f2329' : '#ffffff';
}

/**
 * 在**保持色相**的前提下，把颜色朝白/黑一点一点混合，直到达到目标相对亮度。
 *
 * 为什么不直接「混 30% 白」：那样对任何颜色都一刀切，中等明度的色
 * 会被抬成藕粉色 —— 这正是「暗色下选的色卡和实际界面颜色对不上」的原因。
 * 这里只在真的达不到对比度时才逐步加白/加黑，颜色能保住本来的观感。
 */
function adjustToLuminance(
  hex: string,
  target: number,
  toward: '#ffffff' | '#000000'
): string {
  const reach = (v: number) =>
    toward === '#ffffff' ? v >= target : v <= target;
  if (reach(relativeLuminance(hex))) return hex;
  for (let w = 0.02; w <= 0.72; w += 0.02) {
    const next = mixHex(hex, toward, w);
    if (reach(relativeLuminance(next))) return next;
  }
  return mixHex(hex, toward, 0.72);
}

/**
 * 「填充色」——按钮底色、开关、徽标这类**大面积上色**用的主色。
 *
 * - 亮色主题：颜色太浅（比如亮黄）时压暗，否则白底上看不清；
 * - 暗色主题：**保持色卡原色**，只在深到和深蓝底糊在一起时才提亮到刚好能分辨。
 *   之前统一混 30% 白，中等明度的色会被抬成粉调、石墨会变成灰蓝，选什么色都不像什么色。
 */
export function accentFill(color: string, theme: 'light' | 'dark'): string {
  const base = normalizeHex(color) || DEFAULT_ACCENT;
  const lum = relativeLuminance(base);
  if (theme === 'dark') {
    // 0.12 ≈ 与深蓝画布约 3:1 的分界：只有石墨这类很深的灰会被提亮，
    // 青碧这类中等明度的品牌色保持原样
    return lum < 0.12 ? adjustToLuminance(base, 0.12, '#ffffff') : base;
  }
  return lum > 0.62 ? mixHex(base, '#000000', 0.22) : base;
}

/**
 * 「文字色」——深底/浅底上作为文字、图标的主色。
 * 和填充色分开：暗色下按钮要是原色（够浓），文字却必须够亮才读得清，
 * 两者对明度的要求正好相反，共用一个变量必然有一头不合适。
 */
export function accentText(color: string, theme: 'light' | 'dark'): string {
  const base = normalizeHex(color) || DEFAULT_ACCENT;
  if (theme === 'dark') {
    // 深蓝底（相对亮度约 0.011）上，文字要 L ≥ 0.26 才有约 5:1 的对比度
    return adjustToLuminance(base, 0.26, '#ffffff');
  }
  return relativeLuminance(base) > 0.55 ? mixHex(base, '#000000', 0.28) : base;
}

/** 暗色主题下标题栏用主色压暗（亮底白字才不刺眼），亮色主题直接铺主色 */
function titlebarBg(accent: string, theme: 'light' | 'dark'): string {
  // 混的是「中性极深色」而不是深蓝：画布已经改成由主色推导，
  // 再往蓝里压会让红色/绿色主题的标题栏发紫发灰，色相对不上。
  return theme === 'dark' ? mixHex(accent, '#080b0f', 0.35) : accent;
}

/** 把主色写进 :root 的 CSS 变量（其余色阶由 global.scss 里的 color-mix 自动推导） */
export function applyAccent(color: string, theme: 'light' | 'dark'): void {
  try {
    const accent = accentFill(color, theme);
    const text = accentText(color, theme);
    const { r, g, b } = hexToRgb(accent);
    const bar = titlebarBg(accent, theme);
    const root = document.documentElement;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    root.style.setProperty('--accent-text', text);
    root.style.setProperty('--on-accent', readableOn(accent));
    root.style.setProperty('--titlebar-bg', bar);
    root.style.setProperty('--titlebar-fg', readableOn(bar));
  } catch {
    // 拿不到 documentElement（极端情况）时保持 CSS 默认色即可
  }
}

/** 找出与给定颜色最接近的预设（RGB 平方距离），用于把历史自定义色归拢到色卡上 */
export function nearestPreset(color: string): string {
  const target = hexToRgb(color);
  let best = ACCENT_PRESETS[0].color;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const preset of ACCENT_PRESETS) {
    const c = hexToRgb(preset.color);
    const dist =
      (c.r - target.r) ** 2 + (c.g - target.g) ** 2 + (c.b - target.b) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = preset.color;
    }
  }
  return best;
}

/**
 * 读取已保存的主色。
 *
 * 色卡收敛成有限几档后，旧版本存下的自定义色/已下线色卡都不再合法：直接归拢到
 * 最接近的预设并回写，避免「设置里一张卡都没高亮，界面却是个橙色」这种
 * 说不清来源的状态。
 */
export function loadAccent(): string {
  try {
    const stored = normalizeHex(localStorage.getItem(STORAGE_KEY));
    if (!stored) return DEFAULT_ACCENT;
    const hit = ACCENT_PRESETS.find((p) => p.color === stored);
    if (hit) return hit.color;
    const snapped = nearestPreset(stored);
    localStorage.setItem(STORAGE_KEY, snapped);
    return snapped;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function saveAccent(color: string): void {
  try {
    const hex = normalizeHex(color);
    if (hex) localStorage.setItem(STORAGE_KEY, hex);
  } catch {}
}
