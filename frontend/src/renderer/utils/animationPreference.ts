/**
 * 「禁用动图」偏好（设置 → 性能）。
 *
 * 注意语义：存储的是「**是否允许播放**」（`enabled`），而设置页上的开关是
 * 「**禁用**动图」—— 开关打开时 `enabled === false`。这样代码里所有判断都是
 * 正向的（能不能播），不用到处写 `!disabled`。
 *
 * 三种情况按优先级从高到低决定是否播放：
 *   1. 用户在设置页显式关掉 → 永远不播；
 *   2. 系统开启了「减少动态效果」(prefers-reduced-motion) → 默认不播，
 *      但用户显式打开仍然要能播（无障碍设置是默认值，不是强锁）；
 *   3. 其余情况 → 播放。
 *
 * 用 localStorage + 订阅而不是塞进 zustand store：读取发生在每张卡片的
 * 渲染路径上，store 更新会牵动整个 Mod 列表重渲染，代价不值得。
 */

const STORAGE_KEY = 'l4d2-card-animation';

type Listener = (enabled: boolean) => void;

const listeners = new Set<Listener>();

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function readPreference(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'off') return false;
    if (raw === 'on') return true;
  } catch {
    /* 隐私模式等场景读不到，走默认值 */
  }
  return !prefersReducedMotion();
}

let enabled = readPreference();

export function cardAnimationEnabled(): boolean {
  return enabled;
}

export function setCardAnimationEnabled(next: boolean): void {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
  } catch {
    /* 写不进去就只在本次会话生效 */
  }
  for (const fn of Array.from(listeners)) fn(next);
}

export function subscribeCardAnimation(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 系统级「减少动态效果」是否开启（设置页用来解释默认值来源） */
export function systemReducedMotion(): boolean {
  return prefersReducedMotion();
}
