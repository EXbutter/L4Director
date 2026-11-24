import type { CSSProperties, KeyboardEvent } from 'react';
import { ThumbImage } from '../ThumbImage';
import { DefaultCover } from '../DefaultCover';
import { ItemStats } from './ItemStats';
import { cleanDescription, formatCount, formatDate, formatSize, thumbnailUrl } from './types';
import type { WorkshopItem } from './types';

interface Props {
  item: WorkshopItem;
  api: string;
  /** 在列表里的行号，用来算入场错峰延迟（见 .wk-row 的 --wk-i） */
  index?: number;
  onClick: (item: WorkshopItem) => void;
}

/**
 * 工坊列表行（网格模式之外的另一种排版）。
 *
 * 和卡片一样，封面必须走 `ThumbImage`（原因见 WorkshopCard.tsx 顶部注释）。
 * 行内封面更小，采样上限压到 192×120，缓存里不必存一份和卡片等大的位图。
 *
 * 为什么整行用 div + role="button" 而不是 <button>：以后要在行尾放「加入队列」
 * 这类二级按钮，而 HTML 不允许 button 套 button（内层点击会被外层吞掉）。
 */
export function WorkshopRow({ item, api, index = 0, onClick }: Props) {
  // 描述只取一行：列表模式的用处是「快速扫」，不是读简介。
  // 先过 cleanDescription 去掉 BBCode/图片直链，再把所有空白压成单个空格、
  // 截到 160 字 —— 不截断的话超长描述会参与排版计算，一屏几十行白白多算几百万字符。
  const desc = cleanDescription(item.description || '').replace(/\s+/g, ' ').slice(0, 160);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(item);
    }
  };

  return (
    <div
      className="wk-row"
      style={{ '--wk-i': index } as CSSProperties}
      role="button"
      tabIndex={0}
      onClick={() => onClick(item)}
      onKeyDown={onKeyDown}
      title={item.title}
    >
      <div className="wk-row__cover">
        <ThumbImage
          src={thumbnailUrl(api, item.id, item.preview_url)}
          alt=""
          maxWidth={192}
          maxHeight={120}
          animation="hover"
          lazy
          fallback={<DefaultCover />}
        />
      </div>

      <div className="wk-row__main">
        <div className="wk-row__titleline">
          <span className="wk-row__title">{item.title || `（无标题）${item.id}`}</span>
          {item.downloaded && <span className="wk-row__flag">已下载</span>}
          <ItemStats item={item} />
        </div>
        <div className="wk-row__desc">{desc || '（原作者没有填写简介）'}</div>
        <div className="wk-row__tags">
          {item.tags.slice(0, 5).map((t) => (
            <span key={t.name} className="wk-row__tag">{t.label}</span>
          ))}
          {item.tags.length > 5 && <span className="wk-row__tag">+{item.tags.length - 5}</span>}
        </div>
      </div>

      <div className="wk-row__stats">
        <span title="文件体积">{formatSize(item.size)}</span>
        <span title={`当前订阅 ${item.subscriptions} 人`}>订阅 {formatCount(item.subscriptions)}</span>
        <span title="最后更新">{formatDate(item.updated_at)}</span>
      </div>
    </div>
  );
}
