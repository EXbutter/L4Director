import { formatCount, downloadCount, downloadTooltip, voteCount, voteTooltip } from './types';
import type { WorkshopItem } from './types';

interface Props {
  item: WorkshopItem;
  /**
   * overlay：压在封面右下角的浮层（卡片墙用，替换原来的好评率角标）
   * inline：标题行里的小字（单列列表用）
   */
  variant?: 'overlay' | 'inline';
}

/**
 * 好评数 + 下载量。卡片、列表行共用一处渲染，避免两边文案/取整方式跑偏。
 *
 * 两个数都可能缺：好评数要 API Key；累计下载量连 API 路径里也可能为 0。
 * 缺哪个就不渲染哪个，缺两个就整块不渲染 —— 宁可少一行字，也不能显示「赞 0」
 * 让人以为是没人点赞（实际是没数据）。
 */
export function ItemStats({ item, variant = 'inline' }: Props) {
  const up = voteCount(item);
  const down = downloadCount(item);
  if (!up && !down) return null;

  return (
    <span className={`wk-stats wk-stats--${variant}`}>
      {up > 0 && (
        <span className="wk-stats__item wk-stats__item--up" title={voteTooltip(item)}>
          赞 {formatCount(up)}
        </span>
      )}
      {down > 0 && (
        <span className="wk-stats__item" title={downloadTooltip(item)}>
          ↓ {formatCount(down)}
        </span>
      )}
    </span>
  );
}
