import { useState, useEffect } from 'react';
import './Toast.scss';

export type ToastType = 'success' | 'info' | 'warning' | 'error';

interface ToastMessage {
  id: number;
  text: string;
  type: ToastType;
  exiting: boolean;
}

/** 同屏最多显示条数：超出丢弃最旧的一条，避免刷屏 */
const MAX_TOASTS = 5;

/** 停留时长按类型区分：错误更久，方便读完整段报错 */
const DURATION: Record<ToastType, number> = {
  success: 3000,
  info: 3000,
  warning: 4500,
  error: 6500,
};

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

/** 退场：先标记 exiting 触发滑出动画，300ms 后真正从列表移除 */
function scheduleRemove(id: number) {
  clearTimer(id);
  setToastsFn?.((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
  const timer = setTimeout(() => {
    setToastsFn?.((prev) => prev.filter((t) => t.id !== id));
    timersRef.delete(id);
  }, 300);
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

  useEffect(() => {
    setToastsFn = setToasts;
    return () => {
      setToastsFn = null;
      // 清理所有定时器
      timersRef.forEach((timer) => clearTimeout(timer));
      timersRef.clear();
    };
  }, []);

  const dismiss = (id: number) => {
    // 点击 × 立即移除（同时清掉自动消失的计时器）
    clearTimer(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
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
