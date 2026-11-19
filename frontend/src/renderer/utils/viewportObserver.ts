/**
 * 共享 IntersectionObserver 池。
 *
 * 「我的 Mod」一张卡一个 ModPreview、一个 ThumbImage，各自 new IntersectionObserver
 * 的话 98 张卡就是一两百个观察器实例——每个都是浏览器侧的独立追踪任务，
 * 滚动时逐个回调。这里按 (root, rootMargin, threshold) 合并成一个 observer，
 * 回调批量分发给订阅者：98 张卡最终只占 2~3 个实例。
 *
 * 用法与 observer.observe 语义一致，返回退订函数：
 *
 *   const stop = observeViewport(el, (vis) => setNear(vis), { rootMargin: '100% 0px' });
 *   // unmount 时
 *   stop();
 *
 * 注意：同一个元素订阅同一配置会复用条目；不同回调各自独立收状态。
 * 首次 observe 后 IntersectionObserver 本来就会补发一次初始状态，无需手动触发。
 */

type VisCallback = (isIntersecting: boolean) => void;

interface PoolEntry {
  observer: IntersectionObserver;
  subs: Map<Element, Set<VisCallback>>;
}

const pool = new Map<string, PoolEntry>();

/** root 元素 → 池键 id（不同滚动容器不能共用一个 observer） */
const rootIds = new WeakMap<Element, number>();
let nextRootId = 1;

/**
 * 找最近的滚动祖先。
 *
 * **不能用 root: null 了事**：IntersectionObserver 的 rootMargin 只加在 root 的
 * 矩形上，而 overflow 裁剪来自中间祖先 —— 在 .content-area 这种内滚容器里，
 * root:null 时滚出容器可视区的目标会被裁掉，上下 100% 的预取边距完全不生效
 * （实测：折叠线下方 319px 的卡片 root:null=false，root=容器=true）。
 * 所以必须把滚动容器本身当 root，边距才能越过它的边缘。
 */
function findScrollRoot(el: Element): Element | null {
  for (let p: Element | null = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p;
  }
  return null;
}

function poolKey(root: Element | null, rootMargin: string, threshold: number): string {
  if (!root) return `viewport|${rootMargin}|${threshold}`;
  let id = rootIds.get(root);
  if (id === undefined) {
    id = nextRootId++;
    rootIds.set(root, id);
  }
  return `el:${id}|${rootMargin}|${threshold}`;
}

export function observeViewport(
  el: Element,
  cb: VisCallback,
  options?: { root?: Element | null; rootMargin?: string; threshold?: number },
): () => void {
  // root 显式传 null = 用视口；不传 = 自动找滚动祖先
  const root = options && 'root' in options ? options.root ?? null : findScrollRoot(el);
  const rootMargin = options?.rootMargin ?? '0px';
  const threshold = options?.threshold ?? 0;
  const key = poolKey(root, rootMargin, threshold);

  let entry = pool.get(key);
  if (!entry) {
    const subs = new Map<Element, Set<VisCallback>>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const rec of records) {
          const set = subs.get(rec.target);
          if (!set) continue;
          // 复制一份：回调里可能立刻退订，边遍历边改集合会漏人
          for (const fn of [...set]) fn(rec.isIntersecting);
        }
      },
      { root, rootMargin, threshold },
    );
    entry = { observer, subs };
    pool.set(key, entry);
  }

  let set = entry.subs.get(el);
  if (!set) {
    set = new Set();
    entry.subs.set(el, set);
    entry.observer.observe(el);
  }
  set.add(cb);

  return () => {
    const rec = pool.get(key);
    if (!rec) return;
    const callbacks = rec.subs.get(el);
    if (!callbacks) return;
    callbacks.delete(cb);
    if (callbacks.size === 0) {
      rec.subs.delete(el);
      rec.observer.unobserve(el);
    }
  };
}
