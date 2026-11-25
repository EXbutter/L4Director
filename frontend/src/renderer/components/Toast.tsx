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

/** 退场淡出时长 & 移除延迟（延迟略大于淡出，保证动画播完再拔 DOM） */
const EXIT_FADE_MS = 240;
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

/** 退场：先标记 exiting 触发淡出，延迟后真正从列表移除 */
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
    // 超出上限时丢弃最旧的一条，并清掉它的计时器
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
  // FLIP：记录每个 toast 的 DOM 节点与上一帧位置
  const nodesRef = useRef<Map<number, HTMLElement>>(new Map());
  const prevRectsRef = useRef<Map<number, DOMRect>>(new Map());

  useEffect(() => {
    setToastsFn = setToasts;
    return () => {
      setToastsFn = null;
      timersRef.forEach((timer) => clearTimeout(timer));
      timersRef.clear();
    };
  }, []);

  // FLIP：某条 toast 被移除后，让「剩下的 toast」从旧位置平滑向上补位。
  // 用 transform 位移做动画，不改变布局高度，所以绝不会互相重叠。
  useLayoutEffect(() => {
    const nextRects = new Map<number, DOMRect>();
    nodesRef.current.forEach((el, id) => nextRects.set(id, el.getBoundingClientRect()));

    nodesRef.current.forEach((el, id) => {
      const prev = prevRectsRef.current.get(id);
      const cur = nextRects.get(id);
      if (!prev || !cur) return; // 新出现的 toast 不做 FLIP
      const dy = prev.top - cur.top;
      if (Math.abs(dy) < 1) return; // 位置没变就不动
      // 先瞬移到旧位置，再过渡回新位置（向上补位）
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      void el.offsetHeight; // 强制重排，确保上面这帧生效
      el.style.transition = 'transform 0.26s cubic-bezier(0.22, 1, 0.36, 1)';
      el.style.transform = 'translateY(0)';
      const done = () => {
        el.style.transition = '';
        el.style.transform = '';
        el.removeEventListener('transitionend', done);
      };
      el.addEventListener('transitionend', done);
    });

    prevRectsRef.current = nextRects;
  }, [toasts]);

  const dismiss = (id: number) => {
    // 点击 ×：走和自动超时同一套退场（淡出 + 移除后剩余项平滑上移）
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
