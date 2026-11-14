import { ThumbImage } from '../ThumbImage';
import { useModalA11y } from '../../hooks/useModalA11y';
import { cleanDescription, formatCount, formatDate, formatSize, thumbnailUrl } from './types';
import type { WorkshopItem } from './types';

interface Props {
  item: WorkshopItem;
  api: string;
  onClose: () => void;
  onQueue: (item: WorkshopItem) => void;
  onOpenInBrowser: (item: WorkshopItem) => void;
  queued: boolean;
  busy: boolean;
}

export function WorkshopDetail({ item, api, onClose, onQueue, onOpenInBrowser, queued, busy }: Props) {
  // Esc 关闭 + 焦点陷阱，和项目里其它弹窗保持一致
  const ref = useModalA11y<HTMLDivElement>(true, onClose);
  const desc = cleanDescription(item.description);

  return (
    <div className="wk-drawer-mask" onClick={onClose}>
      <div className="wk-drawer" ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="wk-drawer__head">
          <span className="wk-drawer__id">#{item.id}</span>
          <button className="wk-drawer__close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="wk-drawer__scroll">
          <div className="wk-drawer__cover">
            {/* 抽屉里同时只有一张，可以放动图；尺寸仍由 ThumbImage 兜住
                （原图可能是 600×600 的 28 MB GIF，直接塞 <img> 会全速播 + 吃满显存） */}
            <ThumbImage
              src={thumbnailUrl(api, item.id, item.preview_url)}
              alt=""
              maxWidth={960}
              maxHeight={540}
            />
          </div>

          <h2 className="wk-drawer__title">{item.title || `（无标题）${item.id}`}</h2>

          <div className="wk-drawer__stats">
            <div><span>大小</span><b>{formatSize(item.size)}</b></div>
            <div><span>订阅</span><b>{formatCount(item.subscriptions)}</b></div>
            <div><span>浏览</span><b>{formatCount(item.views)}</b></div>
            <div><span>更新</span><b>{formatDate(item.updated_at)}</b></div>
            {item.score !== null && (
              <div title={`赞 ${item.votes_up} / 踩 ${item.votes_down}`}>
                <span>好评</span><b>{Math.round(item.score)}%</b>
              </div>
            )}
          </div>

          {item.tags.length > 0 && (
            <div className="wk-drawer__tags">
              {item.tags.map((t) => <span key={t.name} className="wk-chip is-static">{t.label}</span>)}
            </div>
          )}

          {item.downloaded && <div className="wk-drawer__hint">这个 Mod 已经在你本地 addons 里了。</div>}

          <div className="wk-drawer__desc">
            {desc || '作者没有写描述。'}
          </div>
        </div>

        <div className="wk-drawer__foot">
          <button
            className="wk-btn wk-btn--primary"
            disabled={busy || queued}
            onClick={() => onQueue(item)}
          >
            {queued ? '已加入队列' : busy ? '正在加入…' : '加入下载队列'}
          </button>
          <button className="wk-btn" onClick={() => onOpenInBrowser(item)}>
            在工坊打开 ↗
          </button>
        </div>
      </div>
    </div>
  );
}
