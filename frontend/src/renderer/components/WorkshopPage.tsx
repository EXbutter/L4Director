import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBase } from '../store/useStore';
import { showToast } from './Toast';
import { WorkshopCard } from './workshop/WorkshopCard';
import { WorkshopRow } from './workshop/WorkshopRow';
import { WorkshopDetail } from './workshop/WorkshopDetail';
import { WorkshopFilters } from './workshop/WorkshopFilters';
import type { WorkshopBrowseResult, WorkshopItem, WorkshopMeta } from './workshop/types';
import './ContentArea.scss';
import './Workshop.scss';

const SEARCH_DEBOUNCE_MS = 400;
// 抽屉退场动画时长：与 Workshop.scss 的 wk-drawer-out 保持一致
// （遮罩淡出 0.2s 更短，取抽屉的 0.26s）。
const DRAWER_EXIT_MS = 260;

export function WorkshopPage() {
  const api = getApiBase();

  const [meta, setMeta] = useState<WorkshopMeta | null>(null);
  const [metaError, setMetaError] = useState('');

  // 输入框里正在打的字 vs 真正生效的关键词：不加这道防抖，每敲一个字都会打一次接口
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [matchAll, setMatchAll] = useState(false);
  const [sort, setSort] = useState('trend');
  const [days, setDays] = useState(0);
  const [onlyNew, setOnlyNew] = useState(false);

  const [items, setItems] = useState<WorkshopItem[]>([]);
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [source, setSource] = useState<'api' | 'html'>('html');
  const [note, setNote] = useState('');

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const [detail, setDetail] = useState<WorkshopItem | null>(null);
  const [detailClosing, setDetailClosing] = useState(false);
  const detailExitTimer = useRef<number | null>(null);
  const closeDetail = useCallback(() => {
    // 退场动画期间保留 DOM，给遮罩/抽屉挂 --closing class；
    // 动画结束后（按 DRAWER_EXIT_MS）再真正卸载，避免瞬间消失。
    setDetailClosing(true);
    if (detailExitTimer.current !== null) window.clearTimeout(detailExitTimer.current);
    detailExitTimer.current = window.setTimeout(() => {
      detailExitTimer.current = null;
      setDetail(null);
      setDetailClosing(false);
    }, DRAWER_EXIT_MS);
  }, []);
  const openDetail = useCallback((item: WorkshopItem) => {
    // 关闭动画进行中又点了别的卡：取消未决的卸载定时器，直接打开新的
    if (detailExitTimer.current !== null) {
      window.clearTimeout(detailExitTimer.current);
      detailExitTimer.current = null;
    }
    setDetailClosing(false);
    setDetail(item);
  }, []);
  const [queued, setQueued] = useState<Record<string, boolean>>({});
  const [queueing, setQueueing] = useState(false);

  // 排版：卡片墙 / 单列列表。与「我的 Mod」同一个做法，记在 localStorage 里，
  // 重启后保持上次选择（但键名分开，两个页面的密度偏好互不影响）。
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem('l4d2-workshop-view') === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const changeViewMode = useCallback((mode: 'grid' | 'list') => {
    setViewMode(mode);
    try {
      localStorage.setItem('l4d2-workshop-view', mode);
    } catch {
      /* 隐私模式写不进去，忽略 */
    }
  }, []);

  // 每次请求带一个自增号：筛选连点时只认最后一次，避免旧结果盖掉新结果
  const reqSeq = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(qInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [qInput]);

  useEffect(() => {
    let alive = true;
    fetch(`${api}/api/workshop/meta`)
      .then((r) => r.json())
      .then((d: WorkshopMeta) => { if (alive) { setMeta(d); setSort((s) => (d.sorts.some((x) => x.id === s) ? s : 'trend')); } })
      .catch((e) => { if (alive) setMetaError(String(e)); });
    return () => { alive = false; };
  }, [api]);

  const buildParams = useCallback((next: string) => {
    const p = new URLSearchParams();
    p.set('sort', sort);
    if (q) p.set('q', q);
    if (tags.length) p.set('tags', tags.join(','));
    if (matchAll) p.set('match_all', 'true');
    if (days) p.set('days', String(days));
    if (next) p.set('page', next);
    return p;
  }, [sort, q, tags, matchAll, days]);

  const load = useCallback(async (reset: boolean) => {
    const seq = ++reqSeq.current;
    if (reset) { setLoading(true); setError(''); } else { setLoadingMore(true); }
    try {
      const p = buildParams(reset ? '' : cursor);
      const res = await fetch(`${api}/api/workshop/browse?${p.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (seq !== reqSeq.current) return;          // 已被更新的请求取代
      if (!res.ok) {
        setError(data.detail || `请求失败（HTTP ${res.status}）`);
        if (reset) { setItems([]); setCursor(''); setHasMore(false); }
        return;
      }
      const d = data as WorkshopBrowseResult;
      setItems((prev) => (reset ? d.items : [...prev, ...d.items]));
      setCursor(d.next || '');
      setHasMore(!!d.has_more);
      setTotal(d.total || 0);
      setSource(d.source);
      setNote(d.note || '');
      setError('');
    } catch (e) {
      if (seq === reqSeq.current) {
        setError(`连不上本地服务：${(e as Error).message}`);
        if (reset) setItems([]);
      }
    } finally {
      if (seq === reqSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [api, buildParams, cursor]);

  // 筛选条件一变就回到第一页：否则会出现「第 5 页 + 新条件 = 空页」
  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sort, q, tags.join(','), matchAll, days]);

  const toggleTag = (tag: string) => {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const shown = useMemo(
    () => (onlyNew ? items.filter((it) => !it.downloaded) : items),
    [items, onlyNew],
  );

  const openInBrowser = useCallback((item: WorkshopItem) => {
    const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}`;
    const el = window.electronAPI as { openExternal?: (u: string) => Promise<void> } | undefined;
    void el?.openExternal?.(url);
  }, []);

  /** 加入下载队列（只入队、不开始）。返回是否真的进队了。 */
  const enqueue = useCallback(async (item: { id: string; title?: string }) => {
    const res = await fetch(`${api}/api/download/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: item.id }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      // 这个接口连「解析失败」都是 200 + error 字段返回的，所以两个都要看
      showToast(data.detail || data.error || '加入队列失败', 'error');
      return false;
    }
    const added = (data.added || []).length;
    const ignored = (data.ignored || []).length;
    if (added > 0) {
      setQueued((s) => ({ ...s, [item.id]: true }));
      return true;
    }
    // 已经在队列里 / 已在本地：这不是错，但要说清为什么没进去
    showToast(ignored ? '这个 Mod 已经在下载队列里，或本地已有' : '没有加入任何任务', 'warning');
    return false;
  }, [api]);

  /** 只加入队列，等用户到「下载」页点开始 */
  const queue = useCallback(async (item: { id: string; title?: string }) => {
    setQueueing(true);
    try {
      if (await enqueue(item)) showToast(`已加入下载队列：${item.title || item.id}`, 'success');
    } catch (e) {
      showToast(`加入队列失败：${(e as Error).message}`, 'error');
    } finally {
      setQueueing(false);
    }
  }, [enqueue]);

  /**
   * 直接下载：入队 + 立刻开始。
   *
   * 开始失败（比如队列里已经有一个任务在跑、或输出目录不可写）时并不取消入队 ——
   * 条目还在队列里，用户到「下载」页点一下就能继续，所以这里只提示「已入队但没开始」。
   */
  const downloadNow = useCallback(async (item: { id: string; title?: string }) => {
    setQueueing(true);
    try {
      // 不看返回值：条目「已经在队列里」时 enqueue 会返回 false，
      // 但这时仍然应该让它开始下载 —— 用户点的是「开始」，不是「再入一次队」。
      await enqueue(item);
      const res = await fetch(`${api}/api/download/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        showToast(
          `没能开始下载：${data.error || data.detail || `HTTP ${res.status}`}。条目已在队列里，可到「下载」页处理。`,
          'warning',
        );
        return;
      }
      showToast(`开始下载：${item.title || item.id}`, 'success');
    } catch (e) {
      showToast(`下载失败：${(e as Error).message}`, 'error');
    } finally {
      setQueueing(false);
    }
  }, [api, enqueue]);

  const headerHint = meta?.has_key
    ? `已启用 API（每页 ${meta.page_size} 条，带好评数 / 下载量）`
    : '未配置 API Key：走工坊网页，每页 30 条';

  return (
    <div className="content-area wk-page">
      <div className="wk-top">
        <div className="wk-top__row">
          <input
            className="wk-search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="搜索工坊 Mod 标题或描述（中文也行）…"
          />
          <select className="wk-select" value={sort} onChange={(e) => setSort(e.target.value)} title="排序">
            {(meta?.sorts || [{ id: 'trend', label: '趋势', requires_key: false }]).map((s) => {
              const blocked = s.requires_key && !meta?.has_key;
              return (
                <option key={s.id} value={s.id} disabled={blocked}>
                  {s.label}{blocked ? '（需 API Key）' : ''}
                </option>
              );
            })}
          </select>
          <select className="wk-select" value={days} onChange={(e) => setDays(Number(e.target.value))} title="时间范围">
            <option value={0}>不限时间</option>
            <option value={7}>最近 7 天热门</option>
            <option value={30}>最近 30 天热门</option>
          </select>
          <label className="wk-toggle" title="只显示还没下载的（仅过滤已加载的部分）">
            <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
            只看未下载
          </label>
          <button className="wk-btn wk-btn--ghost" onClick={() => void load(true)} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>

          {/* 排版切换：卡片墙 / 单列列表。图标与「我的 Mod」工具栏那组保持一致，
              免得同一个功能在两个页面长得不一样。 */}
          <div className="wk-view" role="group" aria-label="布局方式">
            <button
              type="button"
              className={`wk-view__btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => changeViewMode('grid')}
              title="卡片视图"
              aria-pressed={viewMode === 'grid'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </button>
            <button
              type="button"
              className={`wk-view__btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => changeViewMode('list')}
              title="列表视图"
              aria-pressed={viewMode === 'list'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="5" height="5" rx="1" />
                <line x1="11" y1="6.5" x2="21" y2="6.5" strokeLinecap="round" />
                <rect x="3" y="15" width="5" height="5" rx="1" />
                <line x1="11" y1="17.5" x2="21" y2="17.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="wk-top__sub">
          <span className={`wk-source wk-source--${source}`}>
            {source === 'api' ? 'Steam API' : '工坊网页'}
          </span>
          <span>
            {total > 0 ? `共 ${total.toLocaleString()} 个结果 · ` : ''}
            已加载 {shown.length} 个
            {onlyNew && items.length !== shown.length ? `（本地已有 ${items.length - shown.length} 个已隐藏）` : ''}
          </span>
          <span className="wk-top__hint" title={headerHint}>{headerHint}</span>
        </div>
      </div>

      <div className="wk-main">
        {meta && (
          <aside className="wk-side">
            <WorkshopFilters
              groups={meta.tag_groups}
              selected={tags}
              matchAll={matchAll}
              onToggleTag={toggleTag}
              onClear={() => setTags([])}
              onMatchAllChange={setMatchAll}
            />
          </aside>
        )}

        <div className="wk-content">
          {note && !error && <div className="wk-note">{note}</div>}

          {metaError && (
            <div className="wk-state wk-state--err">
              <b>读不到筛选项</b>
              <p>{metaError}</p>
              <button className="wk-btn" onClick={() => window.location.reload()}>重新加载</button>
            </div>
          )}

          {error ? (
            <div className="wk-state wk-state--err">
              <b>没取到列表</b>
              <p>{error}</p>
              <button className="wk-btn wk-btn--primary" onClick={() => void load(true)}>重试</button>
            </div>
          ) : loading && items.length === 0 ? (
            <div className={viewMode === 'list' ? 'wk-list' : 'wk-grid'}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className={`wk-skeleton${viewMode === 'list' ? ' wk-skeleton--row' : ''}`} />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <div className="wk-state">
              <b>{items.length > 0 ? '当前页的 Mod 都已下载' : '没有匹配的 Mod'}</b>
              <p>
                {items.length > 0
                  ? '关掉「只看未下载」，或者点「加载更多」继续往后翻。'
                  : '换几个标签试试，或者清空筛选条件。工坊里同一个 Mod 的标签可能和你猜的不一样（比如「音效」的内部名是 Sounds）。'}
              </p>
              {(tags.length > 0 || q) && (
                <button className="wk-btn" onClick={() => { setTags([]); setQInput(''); setDays(0); }}>清空条件</button>
              )}
            </div>
          ) : (
            <>
              {/* key 里带上 viewMode：切换排版时重建容器，新的一批卡片/行会重新
                  错峰入场一次，切换这个动作本身有明确反馈（与本地 Mod 列表同理）。 */}
              <div className={viewMode === 'list' ? 'wk-list' : 'wk-grid'} key={viewMode}>
                {viewMode === 'list'
                  ? shown.map((it, i) => (
                      <WorkshopRow key={it.id} item={it} api={api} index={i} onClick={openDetail} />
                    ))
                  : shown.map((it, i) => (
                      <WorkshopCard key={it.id} item={it} api={api} index={i} onClick={openDetail} />
                    ))}
              </div>
              {hasMore && (
                <div className="wk-more">
                  <button className="wk-btn" onClick={() => void load(false)} disabled={loadingMore}>
                    {loadingMore ? '加载中…' : '加载更多'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {detail && (
        <WorkshopDetail
          item={detail}
          api={api}
          onClose={closeDetail}
          onQueue={queue}
          onDownloadNow={downloadNow}
          onOpenInBrowser={openInBrowser}
          queued={!!queued[detail.id]}
          busy={queueing}
          closing={detailClosing}
        />
      )}
    </div>
  );
}
