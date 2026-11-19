import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import {
  buildCoverIndex,
  coverageBoard,
  entityHint,
  rosterFromMods,
} from '../utils/mix';
import './CoverageBoard.scss';

const OPEN_KEY = 'l4d2.covBoard.open';

/**
 * 「当前搭配完整度」看板 —— 常驻在「我的 Mod」页面。
 *
 * 回答两个问题：现在启用着的包换掉了清单里哪些成员（彩色），哪些还是原版（虚框）。
 * 只统计**已启用**的包：看板说的是「进游戏会看到什么」，不是「库里有什么」，
 * 所以禁用一张卡片，对应的成员会立刻退成虚框。
 */
export function CoverageBoard({ onFillGaps }: { onFillGaps: (families: string[]) => void }) {
  const mods = useStore((s) => s.mods);
  const roster = useStore((s) => s.coverageRoster);
  const fetchRoster = useStore((s) => s.fetchCoverageRoster);
  const connected = useStore((s) => s.backendConnected);
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== '0');

  useEffect(() => {
    // 后端连上之前 fetch 会直接返回，所以把 connected 也算进依赖，
    // 否则「先渲染、后连上」时会一直拿不到名册
    if (connected && roster.length === 0) void fetchRoster();
  }, [connected, roster.length, fetchRoster]);

  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(OPEN_KEY, v ? '0' : '1');
      return !v;
    });
  };

  const index = useMemo(() => buildCoverIndex(mods), [mods]);
  // 名册拉不到（老后端 / 接口失败）时退到「见过谁」，总数仍是后端给的 total
  const families = useMemo(() => {
    const base = roster.length > 0 ? roster : rosterFromMods(mods);
    return coverageBoard(mods, base, index);
  }, [mods, roster, index]);

  if (families.length === 0) return null;

  const totalCovered = families.reduce((n, f) => n + f.covered, 0);
  const totalAll = families.reduce((n, f) => n + f.total, 0);
  // 「补齐缺口」只数**库里有包但没启用**的成员：库里压根没有替换包的，
  // 补也补不上，把它们算进按钮数字只会让人反复点一个没用的按钮
  const gaps = families.filter((f) =>
    f.entities.some((e) => e.providers.length === 0 && e.available > 0),
  );
  const gapCount = families.reduce(
    (n, f) => n + f.entities.filter((e) => e.providers.length === 0 && e.available > 0).length,
    0,
  );

  return (
    <div className={`cov-board${open ? ' cov-board--open' : ''}`}>
      <div className="cov-board__head">
        <span className="cov-board__title">
          当前搭配
          <em title="已启用的 Mod 一共替换了多少个成员">
            {totalCovered}
            <i>/{totalAll}</i>
          </em>
        </span>

        <div className="cov-board__bars">
          {families.map((f) => (
            <span className="cov-board__fam" key={f.key} title={`${f.key} ${f.covered}/${f.total}`}>
              <span>{f.key}</span>
              <b className={f.covered >= f.total ? 'is-full' : ''}>{f.covered}/{f.total}</b>
              <i className="cov-board__bar">
                <i
                  className="cov-board__bar-fill"
                  style={{ width: `${f.total ? (f.covered / f.total) * 100 : 0}%` }}
                />
              </i>
            </span>
          ))}
        </div>

        {gapCount > 0 && (
          <button
            className="cov-board__gaps"
            onClick={() => onFillGaps(gaps.map((f) => f.key))}
            title={
              '为这些还没有包替换的成员随机挑一个（库里有货才补得上）。\n'
              + '已经启用着的包一律不动 —— 只补缺，不拆已经搭好的组合。'
            }
          >
            补齐缺口 <b>{gapCount}</b>
          </button>
        )}

        <button
          className="cov-board__toggle"
          onClick={toggle}
          title={open ? '收起成员明细' : '展开成员明细'}
        >
          {open ? '收起' : '明细'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11">
            <path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* 明细常驻 DOM，靠 grid 0fr → 1fr 做高度过渡（不再 {open && <div>} 条件渲染：
          否则展开「啪」一下弹开、收起瞬间消失）。 */}
      <div className="cov-board__detail">
        <div className="cov-board__detail-inner">
          <div className="cov-board__detail-body">
            {families.map((f) => (
              <div className="cov-fam" key={f.key}>
                <span className="cov-fam__label">
                  {f.key}
                  <em>{f.covered}/{f.total}</em>
                </span>
                <div className="cov-fam__chips">
                  {f.entities.map((e) => {
                    const hint = entityHint(e.name);
                    if (e.providers.length > 0) {
                      const names = e.providers.map((m) => m.display_name).join('\n');
                      return (
                        <span
                          key={e.name}
                          className={`cov-chip cov-chip--on${e.providers.length > 1 ? ' cov-chip--dup' : ''}`}
                          title={`${hint} ← ${names}${
                            e.providers.length > 1 ? '\n（有多个已启用的包都在换它，游戏里会互相覆盖）' : ''
                          }`}
                        >
                          {e.label}
                        </span>
                      );
                    }
                    return (
                      <span
                        key={e.name}
                        className={`cov-chip cov-chip--off${e.available === 0 ? ' cov-chip--none' : ''}`}
                        title={
                          e.available === 0
                            ? `${hint}：库里没有替换它的 Mod`
                            : `${hint}：没有启用任何替换它的 Mod\n库里有 ${e.available} 个，可在「一键混搭」里挑`
                        }
                      >
                        {e.label}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
