import { useState, useCallback, useEffect, useRef } from 'react';
import * as ReactDOM from 'react-dom/client';
import './Toast.scss';

export type ToastType = 'success' | 'info' | 'warning' | 'error';

interface ToastMessage {
  id: number;
  text: string;
  type: ToastType;
  exiting: boolean;
}

// 全局 Toast 管理
let toastIdCounter = 0;
let setToastsFn: React.Dispatch<React.SetStateAction<ToastMessage[]>> | null = null;
let timersRef: Map<number, ReturnType<typeof setTimeout>> = new Map();

export function showToast(text: string, type: ToastType = 'info') {
  const id = ++toastIdCounter;
  const newToast: ToastMessage = { id, text, type, exiting: false };

  if (setToastsFn) {
    setToastsFn((prev) => [...prev, newToast]);

    // 3.5 秒后自动移除
    const timer = setTimeout(() => {
      // 先标记为 exiting（触发淡出动画）
      setToastsFn?.((prev) =>
        prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
      );
      // 再 300ms 后移除
      setTimeout(() => {
        setToastsFn?.((prev) => prev.filter((t) => t.id !== id));
      }, 300);
    }, 3500);
    timersRef.set(id, timer);
  }
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
        </div>
      ))}
    </div>
  );
}
