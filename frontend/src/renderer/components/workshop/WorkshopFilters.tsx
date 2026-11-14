import { useState } from 'react';
import type { WorkshopTagGroup } from './types';

interface Props {
  groups: WorkshopTagGroup[];
  selected: string[];
  matchAll: boolean;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
  onMatchAllChange: (v: boolean) => void;
}

/**
 * 标签筛选。按「类型 / 角色 / 特感 / 武器 / 模式」分组折叠。
 *
 * 为什么分组而不是平铺 50 个：实测工坊真实标签有 50 种，全铺开会占掉半屏，
 * 用户还得自己在一堆英文里找「音效」。
 */
export function WorkshopFilters({ groups, selected, matchAll, onToggleTag, onClear, onMatchAllChange }: Props) {
  // 默认只展开「类型」，其余折叠：首屏不该被筛选器占满
  const [open, setOpen] = useState<Record<string, boolean>>({ type: true });

  return (
    <div className="wk-filters">
      <div className="wk-filters__head">
        <span className="wk-filters__title">
          筛选
          {selected.length > 0 && <b className="wk-filters__count">{selected.length}</b>}
        </span>
        <label className="wk-filters__match" title="开启后要求同时具备所有选中标签，否则命中任意一个即可">
          <input
            type="checkbox"
            checked={matchAll}
            onChange={(e) => onMatchAllChange(e.target.checked)}
          />
          同时满足
        </label>
        {selected.length > 0 && (
          <button className="wk-link" onClick={onClear}>清空</button>
        )}
      </div>

      <div className="wk-filters__groups">
        {groups.map((g) => {
          const chosen = g.tags.filter((t) => selected.includes(t.name)).length;
          const isOpen = !!open[g.id];
          return (
            <div className={`wk-group${isOpen ? ' is-open' : ''}`} key={g.id}>
              <button
                className="wk-group__head"
                onClick={() => setOpen((s) => ({ ...s, [g.id]: !s[g.id] }))}
                aria-expanded={isOpen}
                aria-controls={`wk-group-body-${g.id}`}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                {g.label}
                {chosen > 0 && <b className="wk-filters__count">{chosen}</b>}
              </button>

              {/* 标签组**常驻 DOM**，收起时靠 grid-template-rows 0fr 压到 0 高度。
                  以前是 {isOpen && <div>} 条件渲染：DOM 一挂上就占满高度，只有内部
                  淡入，观感是「啪」一下弹开、没有高度过渡；收起更是瞬间消失。
                  改成常驻后高度和透明度一起走，展开/收起都能插值。 */}
              <div className="wk-group__body" id={`wk-group-body-${g.id}`}>
                <div className="wk-group__inner">
                  <div className="wk-group__tags">
                    {g.tags.map((t) => (
                      <button
                        key={t.name}
                        className={`wk-chip${selected.includes(t.name) ? ' is-on' : ''}`}
                        onClick={() => onToggleTag(t.name)}
                        title={t.name}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
