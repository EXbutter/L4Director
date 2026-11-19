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
import { observeViewport } from '../utils/viewportObserver';
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
  /**
   * 动图什么时候播：
   *   - `viewport`（默认）：进入视口就播。「我的模组」用这个 —— 是本地文件，
   *     一次也就百来张，且有并发闸门与位图预算兜着；
   *   - `hover`：鼠标悬停才播。**创意工坊用这个** —— 它的封面是 Steam 图床上
   *     随便什么尺寸的 GIF（实测最大 28 MB），一屏几十张同时进场时，光是
   *     「谁该播」的判断和排队解码就够把主线程压满；
   *   - `off`：只显示静态首帧。
   */
  animation?: 'viewport' | 'hover' | 'off';
  /**
   * 惰性启动：进入视口附近才开始抓图与转码。
   *
   * 「我的模组」不需要（图在后端本地缓存里，抓一张几十毫秒）；创意工坊必须开：
   * 一页 100 张封面、单张动辄几 MB，全量开跑时主线程被几百次编码压死 ——
   * 实测整页掉到 2 FPS，比直接用 `<img>` 还糟。
   */
  lazy?: boolean;
}

/**
 * 视口预取边距：比可视区各多出 160px。
 * 卡片滚进来时解码往往已经完成，不会先看到一张静态图再「跳」成动图。
 */
const VIEW_MARGIN = '160px';

/** 惰性模式的预取边距：比视口多出两屏，滚动时才不会看到空白一格 */
const LAZY_MARGIN = '600px';

/**
 * 卡片缩略图（静态首帧 + **进入视口即自动播放**的动图）。
 *
 * 直接 `<img src={后端缩略图地址}>` 有两个坑（详见 utils/thumbnailImage.ts）：
 * 超大分辨率图吃满内存 / GPU 纹理，后缀写 `.jpg` 实则 GIF 的动图会一直播、
 * 滚动掉到个位数帧率。所以分两层渲染：
 *   - **静态层**永远是首帧转码后的 WebP 小图，进视口就有画面，滚动无解码压力；
 *   - **动图层**进入视口（且未关闭动图预览）时挂载，由 AnimatedThumb 用 canvas
 *     逐帧绘制，滚出视口即卸载并释放位图。不靠 hover，由 IntersectionObserver
 *     决定谁在播，解码另有并发闸门（同刻最多 2 个）。
 *
 * 两层同时存在于 DOM（动图层绝对定位盖在上面）而不是互相替换 —— 替换会让
 * 静态图重新挂载、`thumbIn` 淡入动画再跑一遍，看起来就是闪一下。
 *
 * **拿到安全的小图之前绝不渲染原图地址**，否则那 28MB / 81 帧的动图照样被整体
 * 解码，性能修复就白做了；代价只是预览区短暂空着（转码通常几十毫秒，结果有缓存）。
 * 只有转码失败才回退原图。
 */
export function ThumbImage({
  src,
  alt,
  className,
  maxWidth = THUMB_MAX_WIDTH,
  maxHeight = THUMB_MAX_HEIGHT,
  onError,
  animation = 'viewport',
  lazy = false,
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
  // hover 模式下是否被指针悬停
  const [hovered, setHovered] = useState(false);
  // 惰性模式下是否已进入预取范围（false 时连图都不抓）
  const [ready, setReady] = useState(!lazy);
  // 用 state 持有 DOM 节点而不是 ref：视口观测要在节点挂载后重新建立。
  // 外框现在是**常驻**的（以前要等转码完成才出现），观测才有稳定的锚点。
  const [frameEl, setFrameEl] = useState<HTMLSpanElement | null>(null);

  // 用户在设置页开关动图预览时立即生效（不需要重新扫描或刷新列表）
  useEffect(() => subscribeCardAnimation(setEnabled), []);

  // 惰性启动：进入预取范围才开始抓图 + 转码，离开后不再重新挂起（避免来回滚反复转码）
  useEffect(() => {
    if (!lazy) {
      setReady(true);
      return;
    }
    if (ready || !frameEl) return;
    // 交给共享观察器池（utils/viewportObserver.ts）：边距值不变，但 root 由池
    // 自动选成最近的滚动容器 —— 卡片在 .content-area 里内滚，root: null 时
    // 祖先的 overflow 裁剪会让 rootMargin 完全失效（预取边距形同虚设）。
    return observeViewport(
      frameEl,
      (isIntersecting) => {
        if (isIntersecting) setReady(true);
      },
      { rootMargin: `${LAZY_MARGIN} 0px`, threshold: 0 },
    );
  }, [lazy, ready, frameEl]);

  useEffect(() => {
    if (!ready) return;
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
  }, [ready, src, maxWidth, maxHeight]);

  // 视口观测：进入就播，滚出即停。只有动图 + 开关打开时才需要观察，
  // 静态图没必要挂一个 observer 白占资源。`hover` 模式不挂 observer。
  useEffect(() => {
    if (animation !== 'viewport' || !frameEl || !animated || !enabled || animUnavailable) {
      setInView(false);
      return;
    }

    return observeViewport(
      frameEl,
      (isIntersecting) => setInView(isIntersecting),
      { rootMargin: `${VIEW_MARGIN} 0px`, threshold: 0 },
    );
  }, [frameEl, animated, enabled, animUnavailable, animation]);

  // 第一帧上屏：这时才允许静态首帧让位
  const handlePainted = () => setPainted(true);

  // 解码失败/环境不支持：本次生命周期内不再尝试，静态图兜底
  const handleUnavailable = () => {
    setAnimUnavailable(true);
    setPainted(false);
  };

  const active =
    animation === 'viewport' ? inView : animation === 'hover' ? hovered : false;
  const playing = active && animated && enabled && !animUnavailable;

  // 停止播放（滚出视口/关掉开关）后必须让静态图重新显形，
  // 否则下次进场时静态图被隐藏、动图还在解码，预览区会空一下
  useEffect(() => {
    if (!playing) setPainted(false);
  }, [playing]);

  return (
    <span
      className="thumb-frame"
      ref={setFrameEl}
      onPointerEnter={animation === 'hover' ? () => setHovered(true) : undefined}
      onPointerLeave={animation === 'hover' ? () => setHovered(false) : undefined}
    >
      {displaySrc && (
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
      )}

      {playing && displaySrc && (
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
