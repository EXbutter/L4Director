import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import './Toast.scss';

export type ToastType = 'success' | 'info' | 'warning' | 'error';

interface ToastMessage {
  id: number;
  text: string;
  type: ToastType;
  exiting: boolean;
}

/** 同屏最多显示条数：超出丢弃最旧的一条，避免刷屏 */
const MAX_TOASTS = 8;

/** 停留时长按类型区分：错误更久，方便读完整段报错 */
const DURATION: Record<ToastType, number> = {
  success: 3000,
  info: 3000,
  warning: 4500,
  error: 6500,
};

/** 退场折叠时长 & 移除延迟（延迟略大于折叠，保证收完再拔 DOM，末帧不跳） */
const EXIT_COLLAPSE_MS = 280;
const EXIT_REMOVE_MS = 300;

// 全局 Toast 管理
let toastIdCounter = 0;
let setToastsFn: React.Dispatch<React.SetStateAction<ToastMessage[]>> | null = null;
const timersRef: Map<number, ReturnType<typeof setTimeout>> = new Map();

function clearTimer(id: number) {
  const timer = timersRef.get(id);
  if (timer) {
    clearTimeout(timer);
    timersRef.delete(id);
  }
}

/** 退场：先标记 exiting（触发高度折叠动画），延迟后真正从列表移除 */
function scheduleRemove(id: number) {
  clearTimer(id);
  setToastsFn?.((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
  const timer = setTimeout(() => {
    setToastsFn?.((prev) => prev.filter((t) => t.id !== id));
    timersRef.delete(id);
  }, EXIT_REMOVE_MS);
  timersRef.set(id, timer);
}

export function showToast(text: string, type: ToastType = 'info') {
  const id = ++toastIdCounter;
  const newToast: ToastMessage = { id, text, type, exiting: false };

  if (!setToastsFn) return;

  setToastsFn((prev) => {
    const next = [...prev, newToast];
    while (next.length > MAX_TOASTS) {
      const dropped = next.shift();
      if (dropped) clearTimer(dropped.id);
    }
    return next;
  });

  const timer = setTimeout(() => scheduleRemove(id), DURATION[type] ?? 3000);
  timersRef.set(id, timer);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nodesRef = useRef<Map<number, HTMLElement>>(new Map());

  useEffect(() => {
    setToastsFn = setToasts;
    return () => {
      setToastsFn = null;
      timersRef.forEach((timer) => clearTimeout(timer));
      timersRef.clear();
    };
  }, []);

  // 退场折叠：把「正在退出」的那条自身高度从实测像素收到 0。
  // 高度是真实布局高度，父容器是 flex 列 —— 它每帧变矮，下面的 toast 就自然、
  // 连续地向上补位；不使用 transform 位移，因此不会出现「整列弹动」或互相重叠。
  useLayoutEffect(() => {
    nodesRef.current.forEach((el, id) => {
      const t = toasts.find((x) => x.id === id);
      if (!t || !t.exiting) return;
      if ((el as HTMLElement).dataset.collapsing === '1') return;
      (el as HTMLElement).dataset.collapsing = '1';

      const h = el.offsetHeight;
      // 先钉住当前高度，下一帧再收到 0，height: auto → 0 无法过渡
      el.style.height = `${h}px`;
      el.style.overflow = 'hidden';
      void el.offsetHeight; // 强制重排，确保起始帧生效
      el.style.transition =
        `height ${EXIT_COLLAPSE_MS}ms cubic-bezier(0.22, 1, 0.36, 1), ` +
        `padding-top ${EXIT_COLLAPSE_MS}ms cubic-bezier(0.22, 1, 0.36, 1), ` +
        `padding-bottom ${EXIT_COLLAPSE_MS}ms cubic-bezier(0.22, 1, 0.36, 1), ` +
        `margin-bottom ${EXIT_COLLAPSE_MS}ms cubic-bezier(0.22, 1, 0.36, 1), ` +
        `opacity 200ms ease-in`;
      el.style.height = '0px';
      el.style.marginBottom = '0px';
      el.style.paddingTop = '0px';
      el.style.paddingBottom = '0px';
      el.style.opacity = '0';
    });
  }, [toasts]);

  const dismiss = (id: number) => {
    // 点击 ×：和自动超时同一套（折叠退场）
    scheduleRemove(id);
  };

  const setNode = (id: number) => (el: HTMLDivElement | null) => {
    if (el) nodesRef.current.set(id, el);
    else nodesRef.current.delete(id);
  };

  const getIcon = (type: ToastType) => {
    switch (type) {
      case 'success':
        return (
          <svg className="toast-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        );
      case 'info':
        return (
          <svg className="toast-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        );
      case 'warning':
        return (
          <svg className="toast-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        );
      case 'error':
        return (
          <svg className="toast-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        );
    }
  };

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          ref={setNode(toast.id)}
          className={`toast-item toast-item--${toast.type}${toast.exiting ? ' toast-item--exiting' : ''}`}
        >
          {getIcon(toast.type)}
          <span className="toast-item__text">{toast.text}</span>
          <button
            type="button"
            className="toast-item__close"
            aria-label="关闭提示"
            title="关闭"
            onClick={() => dismiss(toast.id)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
