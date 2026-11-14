import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * 弹窗的键盘与可访问性兜底。
 *
 * 之前 11 个弹窗里只有 ConfirmDialog 认 Esc，其余只能点遮罩关闭；Tab 还能把焦点
 * 甩到背景页面上（焦点陷阱完全没有）。三个口子一起补：
 *   - Esc 关闭（capture 阶段拦，避免被内部输入框的按键处理吃掉）
 *   - Tab / Shift+Tab 在弹窗内循环
 *   - 打开时把焦点放进弹窗，关闭时还给原来的元素
 *
 * 调用方把返回的 ref 挂到 `.modal-content` 上即可，另外记得补 role="dialog"
 * 与 aria-modal（本 hook 会替你补上，如果元素上没写）。
 */
export function useModalA11y<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
  onClose: () => void,
) {
  const ref = useRef<T | null>(null);
  // 用 ref 存回调：调用方经常直接传内联箭头函数，若进 deps 会每次渲染重跑 effect，
  // 焦点就被反复重置到第一个元素上（打字时尤其明显）。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;

    if (!node.hasAttribute('role')) node.setAttribute('role', 'dialog');
    if (!node.hasAttribute('aria-modal')) node.setAttribute('aria-modal', 'true');

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusableIn(node);
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement as HTMLElement | null;
      const inside = current ? node.contains(current) : false;
      if (!e.shiftKey && (!inside || current === last)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (!inside || current === first)) {
        e.preventDefault();
        last.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);

    // 等入场动画起来再聚焦：缩放动画期间 focus() 会让浏览器把元素滚进视口，
    // 弹窗看起来像"跳了一下"。
    const timer = window.setTimeout(() => {
      const list = focusableIn(node);
      // 优先聚焦第一个输入框（重命名这类弹窗就该直接能打字）
      const input = node.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])');
      (input || list[0])?.focus();
    }, 60);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [active]);

  return ref;
}
