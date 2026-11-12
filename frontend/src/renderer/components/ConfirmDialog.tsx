import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ConfirmDialog.scss';

export type ConfirmTone = 'primary' | 'warning' | 'danger';

export interface ConfirmOptions {
  title: string;
  /** 主体说明，可传 JSX（<strong> / <code> 等） */
  description?: ReactNode;
  /** 等宽展示的关键信息，例如文件路径 */
  detail?: string;
  /** 补充说明（次要信息，浅色小字） */
  note?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmTone;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/**
 * 全局二次确认弹窗。
 *
 * 原生 window.confirm 在 Electron 里是系统对话框（标题写着 L4Director、字体与配色
 * 都和软件无关），和界面里其它弹窗完全是两套外观。这里用同一个 `.modal-*` 体系
 * 画一个应用内弹窗，通过 Promise 返回用户选择：
 *
 *   if (await confirmDialog({ title: '…' })) { … }
 *
 * 同一时刻只保留一个：后来的会顶掉前一个（前一个按「取消」结算，不会有悬挂的 Promise）。
 */
let current: PendingConfirm | null = null;
const subscribers = new Set<(pending: PendingConfirm | null) => void>();

function publish() {
  subscribers.forEach((fn) => fn(current));
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (current) current.resolve(false);
    current = { ...options, resolve };
    publish();
  });
}

const TONE_ICON: Record<ConfirmTone, ReactNode> = {
  warning: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  ),
  danger: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  ),
  primary: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.2a2.6 2.6 0 015.1.6c0 1.7-2.6 2-2.6 3.6M12 17h.01" />
    </svg>
  ),
};

/** 挂在 App 根部的宿主组件：没有待确认请求时不渲染任何东西 */
export function ConfirmHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(current);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    subscribers.add(setPending);
    setPending(current);
    return () => {
      subscribers.delete(setPending);
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    // 等入场动画起来再聚焦，避免按钮在缩放动画中被浏览器滚动到视口
    const timer = window.setTimeout(() => confirmRef.current?.focus(), 80);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        settle(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [pending]);

  function settle(ok: boolean) {
    const target = current;
    if (!target) return;
    current = null;
    publish();
    target.resolve(ok);
  }

  if (!pending) return null;

  const tone = pending.tone ?? 'primary';

  return createPortal(
    <div className="modal-overlay confirm-overlay" onClick={() => settle(false)}>
      <div
        className={`modal-content confirm-dialog confirm-dialog--${tone}`}
        role="dialog"
        aria-modal="true"
        aria-label={pending.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog__head">
          <span className="confirm-dialog__icon">{TONE_ICON[tone]}</span>
          <h3>{pending.title}</h3>
        </div>

        {pending.description && <p className="confirm-dialog__desc">{pending.description}</p>}
        {pending.detail && <div className="confirm-dialog__detail">{pending.detail}</div>}
        {pending.note && <div className="confirm-dialog__note">{pending.note}</div>}

        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={() => settle(false)}>
            {pending.cancelText ?? '取消'}
          </button>
          <button
            ref={confirmRef}
            className={`modal-btn ${tone === 'danger' ? 'modal-btn-danger' : 'modal-btn-primary'}`}
            onClick={() => settle(true)}
          >
            {pending.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
