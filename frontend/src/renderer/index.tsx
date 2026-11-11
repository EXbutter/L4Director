import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyUiFont, loadUiFontKey } from './utils/uiFont';
import { applyAccent, loadAccent } from './utils/themeColor';

/**
 * 主题属性必须在首帧渲染前就写到 <html> 上：
 * 1) 之前的实现只在「主题发生变化」时才写 data-theme，启动时因为
 *    prevThemeRef 初始值等于当前主题而直接 return，导致 HTML 上始终没有该属性，
 *    界面会落到「默认（夜间色调）」的样式分支 —— 这正是
 *    「以日间模式关闭后重新打开，大部分部件仍是夜间模式、点两次才恢复」的根因；
 * 2) 提前写入还能避免启动瞬间闪一下默认主题。
 * 3) 主题色卡同理：等 React 起来再写会先闪一下默认蓝，所以这里一并应用。
 */
function applyInitialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('l4d2-theme');
    // 与 store/useStore.ts 的 loadTheme() 保持一致（PCL 风格默认 light）
    const theme = saved === 'light' || saved === 'dark' ? saved : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    // 再把主题同步给主进程，让不透明窗口的底色与主题一致
    // （主进程启动时按上次保存的主题设过一次，这里兜底处理不一致的情况）
    (window as any).electronAPI?.setWindowTheme?.(theme);
    return theme;
  } catch {
    document.documentElement.setAttribute('data-theme', 'light');
    (window as any).electronAPI?.setWindowTheme?.('light');
    return 'light';
  }
}

const initialTheme = applyInitialTheme();
// 界面字体也必须在首帧前应用：否则会先闪一下默认字体
applyUiFont(loadUiFontKey());
// 主题色卡同样要在首帧前落到 CSS 变量上
applyAccent(loadAccent(), initialTheme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
