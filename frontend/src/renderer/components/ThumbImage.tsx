import { useEffect, useState, type SyntheticEvent } from 'react';
import {
  getPreparedThumbnail,
  THUMB_MAX_HEIGHT,
  THUMB_MAX_WIDTH,
} from '../utils/thumbnailImage';
import {
  cardAnimationEnabled,
  subscribeCardAnimation,
} from '../utils/animationPreference';
import { isAnimatedPlaybackSupported } from '../utils/animatedThumbnail';
import { AnimatedThumb } from './AnimatedThumb';

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
 * 视口预取边距：比可视区各多出 160px。
 * 卡片滚进来时解码往往已经完成，不会先看到一张静态图再「跳」成动图。
 */
const VIEW_MARGIN = '160px';

/**
 * 卡片缩略图（静态首帧 + **进入视口即自动播放**的动图）。
 *
 * 直接 `<img src={后端缩略图地址}>` 有两个坑（详见 utils/thumbnailImage.ts）：
 * 超大分辨率图会吃满内存 / GPU 纹理，而后缀写着 `.jpg` 实则 GIF 的动图会
 * 不停播放动画，导致滚动时掉帧到个位数。
 *
 * 所以渲染分两层：
 *   - **静态层**永远是首帧转码后的 WebP 小图，一进视口就有画面，
 *     滚动时不存在任何解码压力；
 *   - **动图层**在卡片进入视口（且用户没有关掉动图预览）时自动挂载，
 *     由 AnimatedThumb 用 canvas 逐帧绘制；滚出视口即卸载并释放位图。
 *
 * 不需要鼠标悬停：`IntersectionObserver` 决定谁在播，视口外的一律不占 GPU。
 * 解码本身另有并发闸门（同刻最多 2 个），所以一屏十几张动图同时进场也不会
 * 叠出长帧 —— 帧率波动正是这么压住的。
 *
 * 两层同时存在于 DOM 里（动图层绝对定位盖在上面），而不是互相替换 ——
 * 替换会让静态图重新挂载，`thumbIn` 淡入动画再跑一遍，就会出现闪烁。
 *
 * 关键点：**在拿到安全的小图之前绝不渲染原图地址**。否则那 28MB / 81 帧的
 * 动图照样会被浏览器整体解码，性能修复就白做了。代价只是预览区会短暂空着
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
  const [animated, setAnimated] = useState(false);
  // 第一帧真正画上 canvas 之前保持静态首帧可见：28MB 的动图解码要几百毫秒，
  // 先藏起静态图会留下一块空白，比不动还难受
  const [painted, setPainted] = useState(false);
  // 环境不支持逐帧解码（如被禁用了 WebCodecs）时，一开始就当动图不可用，
  // 直接把卡片留在静态首帧上，不必白观察视口
  const [animUnavailable, setAnimUnavailable] = useState(() => !isAnimatedPlaybackSupported());
  const [enabled, setEnabled] = useState(cardAnimationEnabled);
  // 是否进入视口（含 160px 预取边距）
  const [inView, setInView] = useState(false);
  // 用 state 持有 DOM 节点而不是 ref：视口观测要在节点挂载后重新建立，
  // 而 <span> 是缩略图转码完成（displaySrc 就绪）后才出现的
  const [frameEl, setFrameEl] = useState<HTMLSpanElement | null>(null);

  // 用户在设置页开关动图预览时立即生效（不需要重新扫描或刷新列表）
  useEffect(() => subscribeCardAnimation(setEnabled), []);

  useEffect(() => {
    let cancelled = false;
    setDisplaySrc(null);
    setAnimated(false);
    setAnimUnavailable(false);
    setPainted(false);

    getPreparedThumbnail(src, maxWidth, maxHeight)
      .then((prepared) => {
        if (cancelled) return;
        // prepared 为 null 表示原图本身就够小且是静态图，直接用原地址
        setDisplaySrc(prepared ? prepared.url : src);
        setAnimated(Boolean(prepared?.animated));
      })
      .catch(() => {
        // 转码失败：回退原图，加载错误交给 <img> 的 onError
        if (!cancelled) setDisplaySrc(src);
      });

    return () => {
      cancelled = true;
    };
  }, [src, maxWidth, maxHeight]);

  // 视口观测：进入就播，滚出即停。只有动图 + 开关打开时才需要观察，
  // 静态图没必要挂一个 observer 白占资源。
  useEffect(() => {
    if (!frameEl || !animated || !enabled || animUnavailable) {
      setInView(false);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setInView(entries[0]?.isIntersecting ?? false);
      },
      { root: null, rootMargin: `${VIEW_MARGIN} 0px`, threshold: 0 },
    );
    observer.observe(frameEl);
    return () => observer.disconnect();
  }, [frameEl, animated, enabled, animUnavailable]);

  // 第一帧上屏：这时才允许静态首帧让位
  const handlePainted = () => setPainted(true);

  // 解码失败/环境不支持：本次生命周期内不再尝试，静态图兜底
  const handleUnavailable = () => {
    setAnimUnavailable(true);
    setPainted(false);
  };

  const playing = inView && animated && enabled && !animUnavailable;

  // 停止播放（滚出视口/关掉开关）后必须让静态图重新显形，
  // 否则下次进场时静态图被隐藏、动图还在解码，预览区会空一下
  useEffect(() => {
    if (!playing) setPainted(false);
  }, [playing]);

  if (!displaySrc) return null;

  return (
    <span className="thumb-frame" ref={setFrameEl}>
      <img
        src={displaySrc}
        alt={alt}
        // thumb-img：缩略图从「解码完成」到「贴到卡片上」之间做一次极短的淡入，
        // 避免滚动时图片一张张硬蹦出来（.mod-card__thumbnail 的缩放仍归卡片 hover 管）
        className={className ? `thumb-img ${className}` : 'thumb-img'}
        loading="lazy"
        // 动图真正画出第一帧之后静态首帧才让位。
        // 这里必须用 visibility 而不是 opacity：`.thumb-img` 的 thumbIn 动画带
        // `fill-mode: both`，动画里那条 `opacity: 1` 在层叠里优先于内联样式，
        // 用 opacity 会被它一直盖住 —— 静态图根本不会让位（实测踩过）。
        style={playing && painted ? { visibility: 'hidden' } : undefined}
        onError={(event) => onError?.(event)}
      />

      {playing && (
        <AnimatedThumb
          src={src}
          alt={alt}
          className={className}
          maxWidth={maxWidth}
          maxHeight={maxHeight}
          playing
          onPainted={handlePainted}
          onUnavailable={handleUnavailable}
        />
      )}
    </span>
  );
}
