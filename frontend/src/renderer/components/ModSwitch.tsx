interface ModSwitchProps {
  /** 是否启用（决定滑块在右还是在左） */
  enabled: boolean;
  /** 启用且存在冲突：轨道转成橙色，滑块仍在右侧 */
  conflict?: boolean;
  /** 悬停提示，由调用方给出更具体的说明 */
  title?: string;
  onToggle: () => void;
}

/**
 * 列表模式下的「启用 / 禁用」药丸开关。
 *
 * 语义与原来的文字标签一致，只是把「读一个状态」变成「拨一个开关」：
 * 右 = 开（绿）、右 + 冲突（橙）、左 = 关（红）。
 * 冲突不是第三种状态，而是「开着但有问题」，所以滑块位置跟开启一致，仅换颜色。
 */
export function ModSwitch({ enabled, conflict = false, title, onToggle }: ModSwitchProps) {
  const state = conflict ? 'conflict' : enabled ? 'on' : 'off';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={conflict ? '已启用，存在冲突' : enabled ? '已启用' : '已禁用'}
      title={title ?? (conflict ? '已启用，存在冲突，点击禁用' : enabled ? '已启用，点击禁用' : '已禁用，点击启用')}
      className={`mod-switch mod-switch--${state}`}
      onClick={(event) => {
        // 整行都可点击切换，这个开关只是显式的入口；
        // 不阻止冒泡会让一次点击触发两遍 toggle（开关一次 + 卡片一次），状态又弹回原样
        event.stopPropagation();
        onToggle();
      }}
    >
      <span className="mod-switch__knob" />
    </button>
  );
}
