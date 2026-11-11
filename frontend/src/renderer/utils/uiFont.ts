/**
 * 界面字体预设。
 *
 * 需求是「更卡通、清晰、简洁」，同时要照顾不同机器上字体可用性差异：
 * Windows 自带的可选字体并不一致（例如「幼圆」部分精简版系统没有），
 * 所以默认给一套「卡通圆润」的字体栈，并在设置页里提供几个备选。
 *
 * 字体栈是**逐字符回退**的：拉丁字母/数字先命中 Segoe UI（最清晰），
 * 中文再交给后面的圆体/雅黑 —— 这样既能"卡通圆润"，也不会牺牲西文清晰度。
 */
export interface FontPreset {
  key: string;
  label: string;
  hint: string;
  css: string;
}

export const FONT_PRESETS: FontPreset[] = [
  {
    key: 'cartoon',
    label: '卡通圆润',
    hint: '中文用「幼圆」等圆体、西文用 Segoe UI（默认）',
    css:
      "'Segoe UI Variable Text', 'Segoe UI', 'YouYuan', '幼圆', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
  },
  {
    key: 'yahei',
    label: '系统默认',
    hint: '经典微软雅黑 UI，小字号最稳',
    css:
      "'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
  },
  {
    key: 'dengxian',
    label: '简洁现代',
    hint: '等线 DengXian：笔画清爽、留白更多',
    css:
      "'Segoe UI Variable Text', 'Segoe UI', 'DengXian', '等线', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
  },
  {
    key: 'noto',
    label: '无衬线',
    hint: 'Noto Sans SC：现代几何感（需系统装有该字体）',
    css:
      "'Noto Sans SC', 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
  },
];

export const DEFAULT_FONT_KEY = 'cartoon';

const STORAGE_KEY = 'l4d2-ui-font';

export function getFontPreset(key: string | null | undefined): FontPreset {
  return FONT_PRESETS.find((p) => p.key === key) || FONT_PRESETS.find((p) => p.key === DEFAULT_FONT_KEY)!;
}

/** 把字体栈写到 :root 的 --font-family 上（全局样式都引用这个变量） */
export function applyUiFont(key: string) {
  const preset = getFontPreset(key);
  try {
    document.documentElement.style.setProperty('--font-family', preset.css);
  } catch {
    // 忽略：极端情况下拿不到 documentElement 也不该让界面崩掉
  }
}

export function loadUiFontKey(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && FONT_PRESETS.some((p) => p.key === saved)) return saved;
  } catch {}
  return DEFAULT_FONT_KEY;
}

export function saveUiFontKey(key: string) {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {}
}
