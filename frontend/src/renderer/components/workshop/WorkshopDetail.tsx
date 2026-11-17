import { useEffect, useMemo, useState } from 'react';
import { ThumbImage } from '../ThumbImage';
import { useModalA11y } from '../../hooks/useModalA11y';
import { cleanDescription, downloadCount, downloadTooltip, formatCount, formatDate, formatSize, thumbnailUrl, voteCount, voteTooltip } from './types';
import type { WorkshopItem } from './types';

interface Props {
  item: WorkshopItem;
  api: string;
  onClose: () => void;
  /** 收 { id, title } 就够：依赖项不是完整的 WorkshopItem，也要能进队列 */
  onQueue: (item: { id: string; title?: string }) => void;
  /** 入队并立刻开始下载 */
  onDownloadNow: (item: { id: string; title?: string }) => void;
  onOpenInBrowser: (item: WorkshopItem) => void;
  queued: boolean;
  busy: boolean;
}

export function WorkshopDetail({ item, api, onClose, onQueue, onDownloadNow, onOpenInBrowser, queued, busy }: Props) {
  // Esc 关闭 + 焦点陷阱，和项目里其它弹窗保持一致
  const ref = useModalA11y<HTMLDivElement>(true, onClose);

  // 列表接口只给封面和短描述；抽屉要的完整描述、图集、依赖得再拉一次详情。
  // 详情没到之前先用列表数据渲染 —— 抽屉一打开就有内容，不会先空一小块。
  const [detail, setDetail] = useState<WorkshopItem | null>(null);
  const [detailError, setDetailError] = useState('');
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailError('');
    setActive(0);
    setLoading(true);
    fetch(`${api}/api/workshop/item/${encodeURIComponent(item.id)}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) {
          setDetailError(data.detail || `请求失败（HTTP ${r.status}）`);
          return;
        }
        setDetail(data as WorkshopItem);
      })
      .catch((e) => {
        if (alive) setDetailError(`连不上本地服务：${(e as Error).message}`);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [api, item.id]);

  const view = detail || item;
  const desc = cleanDescription(view.description);
  const deps = view.dependencies || [];

  /**
   * 图集：详情给了 previews 就用它，否则退回封面一张。
   * 空数组时整块不渲染 —— 不留一个 300px 高的灰框。
   */
  const gallery = useMemo(() => {
    const list = (view.previews || []).filter(Boolean);
    if (list.length) return list;
    return view.preview_url ? [view.preview_url] : [];
  }, [view.previews, view.preview_url]);

  // 详情返回后图片数量可能变多，把越界的索引拉回来
  const activeIndex = Math.min(active, Math.max(0, gallery.length - 1));

  return (
    <div className="wk-drawer-mask" onClick={onClose}>
      <div className="wk-drawer" ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="wk-drawer__head">
          <span className="wk-drawer__id">#{item.id}</span>
          <button className="wk-drawer__close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="wk-drawer__scroll">
          {gallery.length > 0 && (
            <div className="wk-drawer__cover">
              {/* 大图同时只有一张，可以放动图；尺寸仍由 ThumbImage 兜住
                  （原图可能是 600×600 的 28 MB GIF，直接塞 <img> 会全速播 + 吃满显存）。
                  key 换图时重挂载，避免上一张的位图残留。 */}
              <ThumbImage
                key={gallery[activeIndex]}
                src={thumbnailUrl(api, view.id, gallery[activeIndex])}
                alt=""
                maxWidth={960}
                maxHeight={540}
              />
            </div>
          )}

          {/* 缩略条：只有一张时不出现，免得占掉一行高度却没什么可点 */}
          {gallery.length > 1 && (
            <div className="wk-gallery" role="group" aria-label="图片预览">
              {gallery.map((url, i) => (
                <button
                  key={url}
                  type="button"
                  className={`wk-gallery__thumb${i === activeIndex ? ' is-active' : ''}`}
                  onClick={() => setActive(i)}
                  aria-label={`第 ${i + 1} 张，共 ${gallery.length} 张`}
                  aria-pressed={i === activeIndex}
                >
                  <ThumbImage
                    src={thumbnailUrl(api, view.id, url)}
                    alt=""
                    maxWidth={160}
                    maxHeight={100}
                    animation="off"
                  />
                </button>
              ))}
            </div>
          )}

          <h2 className="wk-drawer__title">{view.title || `（无标题）${item.id}`}</h2>

          <div className="wk-drawer__stats">
            <div><span>大小</span><b>{formatSize(view.size)}</b></div>
            {/* 累计下载：只有 API 路径有，网页路径整格不出现（别拿当订阅数冒充） */}
            {downloadCount(view) > 0 && (
              <div title={downloadTooltip(view)}>
                <span>下载</span><b>{formatCount(downloadCount(view))}</b>
              </div>
            )}
            <div title={`当前订阅 ${view.subscriptions} 人`}>
              <span>订阅</span><b>{formatCount(view.subscriptions)}</b>
            </div>
            <div><span>浏览</span><b>{formatCount(view.views)}</b></div>
            <div><span>更新</span><b>{formatDate(view.updated_at)}</b></div>
            {/* 好评率改成好评数（条数），好评率本身挪进悬浮提示 */}
            {voteCount(view) > 0 && (
              <div title={voteTooltip(view)}>
                <span>好评</span><b>{formatCount(voteCount(view))}</b>
              </div>
            )}
          </div>

          {view.tags.length > 0 && (
            <div className="wk-drawer__tags">
              {view.tags.map((t) => <span key={t.name} className="wk-chip is-static">{t.label}</span>)}
            </div>
          )}

          {view.downloaded && <div className="wk-drawer__hint">这个 Mod 已经在你本地 addons 里了。</div>}

          {/* ── 依赖 ──
              工坊的 children 就是作者声明的前置项。装漏了主 Mod 往往「看着能用、
              实际少东西」，所以放在描述**前面**：先确认依赖齐不齐，再决定要不要下。 */}
          {deps.length > 0 && (
            <section className="wk-deps">
              <div className="wk-deps__head">
                <h3>需要的前置 Mod</h3>
                <span className="wk-deps__count">
                  {deps.filter((d) => d.downloaded).length}/{deps.length} 已就绪
                </span>
              </div>
              <ul className="wk-deps__list">
                {deps.map((dep) => (
                  <li key={dep.id} className={`wk-deps__item${dep.downloaded ? ' is-ready' : ''}`}>
                    <div className="wk-deps__cover">
                      {dep.preview_url ? (
                        <ThumbImage
                          src={thumbnailUrl(api, dep.id, dep.preview_url)}
                          alt=""
                          maxWidth={96}
                          maxHeight={64}
                          animation="off"
                        />
                      ) : (
                        <span className="wk-deps__cover--empty">?</span>
                      )}
                    </div>
                    <div className="wk-deps__body">
                      <span className="wk-deps__name" title={dep.title || dep.id}>
                        {dep.title || `#${dep.id}`}
                      </span>
                      <span className="wk-deps__meta">
                        #{dep.id}{dep.size > 0 ? ` · ${formatSize(dep.size)}` : ''}
                      </span>
                    </div>
                    {dep.downloaded ? (
                      <span className="wk-deps__ok">已就绪</span>
                    ) : (
                      <button
                        type="button"
                        className="wk-btn wk-btn--mini"
                        disabled={busy}
                        title="直接下载这个前置（入队并立刻开始）"
                        onClick={() => onDownloadNow({ id: dep.id, title: dep.title })}
                      >
                        下载
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {loading && <div className="wk-drawer__hint">正在读取完整详情…</div>}
          {detailError && (
            <div className="wk-drawer__hint wk-drawer__hint--err">
              详情没取到：{detailError}
              <br />
              （列表里的信息照常可用；图集和依赖要详情接口才给）
            </div>
          )}

          <div className="wk-drawer__desc">
            {desc || (loading ? '' : '作者没有写描述。')}
          </div>
        </div>

        <div className="wk-drawer__foot">
          {/* 两个下载入口：直接开始 / 只排队。
              已经入队过的条目，主按钮文案变成「开始下载」—— 点它不会重复入队。 */}
          <button
            className="wk-btn wk-btn--primary"
            disabled={busy}
            onClick={() => onDownloadNow({ id: view.id, title: view.title })}
            title={queued ? '这个条目已在队列里，点一下立刻开始下载' : '加入队列并立刻开始下载'}
          >
            {busy ? '处理中…' : queued ? '开始下载' : '直接下载'}
          </button>
          <button
            className="wk-btn"
            disabled={busy || queued}
            onClick={() => onQueue({ id: view.id, title: view.title })}
            title="只加入下载队列，稍后到「下载」页统一开始"
          >
            {queued ? '已在队列' : '加入队列'}
          </button>
          <button className="wk-btn wk-btn--ghost wk-btn--link" onClick={() => onOpenInBrowser(view)}>
            工坊 ↗
          </button>
        </div>
      </div>
    </div>
  );
}
