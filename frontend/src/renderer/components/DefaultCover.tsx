/**
 * 没有封面时的默认图。
 *
 * 抽成独立组件，是因为「我的模组」「整合包」两处的 ModPreview、以及创意工坊的
 * 卡片/列表行都要用同一张占位图。视觉上不是一块死灰：底色是主题色渐变
 * （跟随设置里的主题色卡一起变），上面压一层很淡的斜纹肌理，中间一个大号
 * 「图片」图标 + 一行小字「暂无封面」—— 跟有封面的卡片排在一起时，一眼能看出
 * 是「这张 Mod 本身没有截图」，而不是加载失败或渲染 bug。
 *
 * 注意底色用的是**固定中性深色**（见 ContentArea.scss .default-cover），
 * 只叠主题色渐变、不引用日间/夜间会翻转的底色变量：换主题色会跟着变色，
 * 但切换日间/夜间时占位图保持不变。
 */
export function DefaultCover({ label = '暂无封面' }: { label?: string }) {
  return (
    <div className="default-cover" aria-hidden="true">
      <svg
        viewBox="0 0 48 48"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="6" y="9" width="36" height="30" rx="4" />
        <circle cx="17" cy="19" r="3" />
        <path d="M9 34l9-9 7 7 5-5 9 9" />
      </svg>
      {label && <span className="default-cover__label">{label}</span>}
    </div>
  );
}
