import { useEffect, useState, type SyntheticEvent } from 'react';
import {
  getPreparedThumbnail,
  THUMB_MAX_HEIGHT,
  THUMB_MAX_WIDTH,
} from '../utils/thumbnailImage';

interface ThumbImageProps {
  src: string;
  alt: string;
  className?: string;
  /** 缩略图最大宽高（px），默认按卡片预览区尺寸 */
  maxWidth?: number;
  maxHeight?: number;
  /** 加载/转码失败时通知父组件（由父组件决定是否换成占位图） */
  onError?: (event: SyntheticEvent<HTMLImageElement>) => void;
}

/**
 * 卡片缩略图。
 *
 * 直接 `<img src={后端缩略图地址}>` 有两个坑（详见 utils/thumbnailImage.ts）：
 * 超大分辨率图会吃满内存 / GPU 纹理，而后缀写着 `.jpg` 实则 GIF 的动图会
 * 不停播放动画，导致滚动时掉帧到个位数。
 *
 * 关键点：**在拿到安全的小图之前绝不渲染原图地址**。否则那 28MB / 81 帧的
 * 动图照样会被浏览器整体解码，修复就白做了。代价只是预览区会短暂空着
 * （本地转码通常在几十毫秒内完成，结果还会被缓存）。
 *
 * 只有在转码失败时才回退到原图，保证不会比改动前更差。
 */
export function ThumbImage({
  src,
  alt,
  className,
  maxWidth = THUMB_MAX_WIDTH,
  maxHeight = THUMB_MAX_HEIGHT,
  onError,
}: ThumbImageProps) {
  const [displaySrc, setDisplaySrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDisplaySrc(null);

    getPreparedThumbnail(src, maxWidth, maxHeight)
      .then((prepared) => {
        if (cancelled) return;
        // prepared 为 null 表示原图本身就够小且是静态图，直接用原地址
        setDisplaySrc(prepared ? prepared.url : src);
      })
      .catch(() => {
        // 转码失败：回退原图，加载错误交给 <img> 的 onError
        if (!cancelled) setDisplaySrc(src);
      });

    return () => {
      cancelled = true;
    };
  }, [src, maxWidth, maxHeight]);

  if (!displaySrc) return null;

  return (
    <img
      src={displaySrc}
      alt={alt}
      // thumb-img：缩略图从「解码完成」到「贴到卡片上」之间做一次极短的淡入，
      // 避免滚动时图片一张张硬蹦出来（.mod-card__thumbnail 的缩放仍归卡片 hover 管）
      className={className ? `thumb-img ${className}` : 'thumb-img'}
      loading="lazy"
      onError={(event) => onError?.(event)}
    />
  );
}

