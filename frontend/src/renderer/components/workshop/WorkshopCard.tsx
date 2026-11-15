import type { CSSProperties } from 'react';
import { ThumbImage } from '../ThumbImage';
import { ItemStats } from './ItemStats';
import { formatCount, formatSize, thumbnailUrl } from './types';
import type { WorkshopItem } from './types';

interface Props {
  item: WorkshopItem;
  api: string;
  /** 在列表里的序号，用来算入场错峰延迟（见 .wk-card 的 --wk-i） */
  index?: number;
  onClick: (item: WorkshopItem) => void;
}

/**
 * 工坊卡片。
 *
 * 封面**必须**走 `ThumbImage`，不能直接 `<img src={代理地址}>`：
 * 工坊封面里混着大量动图 GIF（实测单张最大 28 MB / 600×600，一屏几十张），
 * Chromium 会把每张动图的**全部帧**解码常驻，再叠加逐帧重绘，帧率直接掉到 16。
 * `ThumbImage` 的做法是先用 `createImageBitmap` 只解第一帧、降采样成静态 WebP，
 * 动图只在鼠标悬停时按需逐帧解码（见下方 `animation="hover"`）。
 *
 * 为什么这里用 hover 而不是「进视口就播」：工坊是**浏览**场景，一屏十几张卡，
 * 用户并不需要它们一起动；而 Steam 图床那边的封面尺寸完全不受控，同时解几张
 * 就够把主线程压满。悬停时一次只有一张在播。
 */
export function WorkshopCard({ item, api, index = 0, onClick }: Props) {
  return (
    <button
      className="wk-card"
      style={{ '--wk-i': index } as CSSProperties}
      onClick={() => onClick(item)}
      title={item.title}
    >
      <div className="wk-card__cover">
        <ThumbImage
          src={thumbnailUrl(api, item.id, item.preview_url)}
          alt=""
          maxWidth={360}
          maxHeight={226}
          animation="hover"
          lazy
        />
        {item.downloaded && <span className="wk-card__badge">已下载</span>}
        {/* 原来是好评率角标（55%），换成好评数 + 累计下载量：工坊条目的好评率
            几乎全挤在 50~60%，百分比给不出区分度，条数才能看出样本量 */}
        <ItemStats item={item} variant="overlay" />
      </div>

      <div className="wk-card__title">{item.title || `（无标题）${item.id}`}</div>

      <div className="wk-card__meta">
        <span>{formatSize(item.size)}</span>
        {/* 这里用文字「订阅」而不是 ↓：↓ 已经代表下载量了（封面上那个）。
            两个箭头长得一样、含义差好几倍，最容易把老 Mod 看错 */}
        <span title={`当前订阅 ${item.subscriptions} 人`}>订阅 {formatCount(item.subscriptions)}</span>
      </div>

      <div className="wk-card__tags">
        {item.tags.slice(0, 3).map((t) => (
          <span key={t.name} className="wk-card__tag">{t.label}</span>
        ))}
        {item.tags.length > 3 && <span className="wk-card__tag wk-card__tag--more">+{item.tags.length - 3}</span>}
      </div>
    </button>
  );
}
