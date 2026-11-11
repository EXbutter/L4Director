import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

/**
 * 药丸 / 悬浮块的锚点位置。
 * 不再保存绝对 left/top，而是保存"吸附到哪条边 + 距离这条边的偏移"，
 * 这样窗口缩放时元素会一直贴着该边移动，不会被挤出可视区。
 */
export interface PillAnchor {
  horiz: 'left' | 'right';
  vert: 'top' | 'bottom';
  /** 距离吸附边的像素偏移 */
  x: number;
  y: number;
}

/** 判定为拖拽（而非点击）的位移阈值 */
const DRAG_THRESHOLD = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 定位参照容器（.app）的可用尺寸，绝对定位元素相对它的 padding box 计算 */
function measureBounds(el: HTMLElement): { width: number; height: number } {
  const parent = el.offsetParent as HTMLElement | null;
  if (parent) {
    return { width: parent.clientWidth, height: parent.clientHeight };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

/** 直接在 left/top 与 right/bottom 中选一对来设置位置 */
function applyAnchor(el: HTMLElement, anchor: PillAnchor): void {
  el.style.left = 'auto';
  el.style.right = 'auto';
  el.style.top = 'auto';
  el.style.bottom = 'auto';
  el.style[anchor.horiz] = `${anchor.x}px`;
  el.style[anchor.vert] = `${anchor.y}px`;
}

/** 读取元素当前实际位置，转换成"最近边 + 偏移"的锚点 */
function captureAnchor(el: HTMLElement): PillAnchor {
  const { width: boundW, height: boundH } = measureBounds(el);
  const left = el.offsetLeft;
  const top = el.offsetTop;
  const right = boundW - (left + el.offsetWidth);
  const bottom = boundH - (top + el.offsetHeight);

  const horiz: PillAnchor['horiz'] = left + el.offsetWidth / 2 <= boundW / 2 ? 'left' : 'right';
  const vert: PillAnchor['vert'] = top + el.offsetHeight / 2 <= boundH / 2 ? 'top' : 'bottom';

  return {
    horiz,
    vert,
    x: Math.max(0, horiz === 'left' ? left : right),
    y: Math.max(0, vert === 'top' ? top : bottom),
  };
}

function saveAnchor(storageKey: string, anchor: PillAnchor): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(anchor));
  } catch {}
}

/** 读取已保存的锚点（新格式） */
function readAnchor(storageKey: string): PillAnchor | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<PillAnchor>;
    if (
      (data.horiz === 'left' || data.horiz === 'right') &&
      (data.vert === 'top' || data.vert === 'bottom')
    ) {
      const x = Number(data.x);
      const y = Number(data.y);
      return {
        horiz: data.horiz,
        vert: data.vert,
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
      };
    }
  } catch {}
  return null;
}

/** 旧版本保存的是 { left: '1180px', top: '560px' }，这里读出来做一次性迁移 */
function readLegacyOffset(storageKey: string): { left: number; top: number } | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const data = JSON.parse(raw) as { left?: unknown; top?: unknown };
    if (typeof data.left === 'string' && typeof data.top === 'string') {
      const left = parseFloat(data.left);
      const top = parseFloat(data.top);
      if (Number.isFinite(left) && Number.isFinite(top)) return { left, top };
    }
  } catch {}
  return null;
}

/**
 * 可拖拽的"药丸"悬浮块（当前 Mod 大小、冲突计数等）。
 *
 * - 位置按"最近边 + 偏移"持久化到 localStorage；
 * - 窗口尺寸变化时自动跟随吸附边，并把越界位置钳制回可视区内；
 * - 拖拽过程中不会超出容器边界；
 * - 兼容旧版绝对 left/top 存储格式。
 */
export function useDraggablePill(storageKey: string) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const anchorRef = useRef<PillAnchor | null>(null);
  const dragState = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);

  /** 应用锚点，并保证元素完整落在容器可视范围内 */
  const applyClampedAnchor = useCallback(
    (anchor: PillAnchor): PillAnchor | null => {
      if (!node) return null;
      const { width: boundW, height: boundH } = measureBounds(node);
      const next: PillAnchor = {
        horiz: anchor.horiz,
        vert: anchor.vert,
        x: clamp(anchor.x, 0, Math.max(0, boundW - node.offsetWidth)),
        y: clamp(anchor.y, 0, Math.max(0, boundH - node.offsetHeight)),
      };
      anchorRef.current = next;
      applyAnchor(node, next);
      return next;
    },
    [node]
  );

  // 元素挂载后恢复上次位置（必要时迁移旧格式）
  useEffect(() => {
    if (!node) return;

    const stored = readAnchor(storageKey);
    if (stored) {
      applyClampedAnchor(stored);
      return;
    }

    const legacy = readLegacyOffset(storageKey);
    if (!legacy) return;

    node.style.right = 'auto';
    node.style.bottom = 'auto';
    node.style.left = `${legacy.left}px`;
    node.style.top = `${legacy.top}px`;

    const applied = applyClampedAnchor(captureAnchor(node));
    if (applied) saveAnchor(storageKey, applied);
  }, [node, storageKey, applyClampedAnchor]);

  // 窗口尺寸变化：锚定边保持不动，同时把越界位置拉回可视区
  useEffect(() => {
    if (!node) return;

    const handleResize = () => {
      if (dragState.current) return;
      const current = anchorRef.current;
      if (!current) return;
      const applied = applyClampedAnchor(current);
      if (applied && (applied.x !== current.x || applied.y !== current.y)) {
        saveAnchor(storageKey, applied);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [node, storageKey, applyClampedAnchor]);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const el = node;
      const state = dragState.current;
      if (!el || !state) return;

      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) setIsDragging(true);

      const { width: boundW, height: boundH } = measureBounds(el);
      const x = clamp(state.left + dx, 0, Math.max(0, boundW - el.offsetWidth));
      const y = clamp(state.top + dy, 0, Math.max(0, boundH - el.offsetHeight));

      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    },
    [node]
  );

  const handleMouseUp = useCallback(() => {
    const el = node;
    if (el && dragState.current) {
      const applied = applyClampedAnchor(captureAnchor(el));
      if (applied) saveAnchor(storageKey, applied);
    }
    dragState.current = null;
    setIsDragging(false);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [node, storageKey, applyClampedAnchor, handleMouseMove]);

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const el = node;
      if (!el) return;
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        left: el.offsetLeft,
        top: el.offsetTop,
      };
      setIsDragging(false);
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [node, handleMouseMove, handleMouseUp]
  );

  // 卸载时清理全局监听
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return {
    /** 交给药丸元素的 callback ref，挂载/卸载都会同步 */
    ref: setNode,
    isDragging,
    handleMouseDown,
  };
}

export default useDraggablePill;
