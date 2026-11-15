import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalA11y } from '../hooks/useModalA11y';
import { showToast } from './Toast';
import { useStore } from '../store/useStore';
import {
  FAMILY_ORDER,
  buildCoverIndex,
  entityHint,
  entityKey,
  entityLabel,
  planMix,
  rollMix,
  rollSummary,
  rosterFromMods,
} from '../utils/mix';
import './MixPanel.scss';

interface Props {
  onClose: () => void;
  /** 从看板的「补齐缺口」进来时：默认只补缺口，且只开有缺口的类别 */
  initialFamilies?: string[];
  gapOnlyDefault?: boolean;
}

/**
 * 一键混搭面板。
 *
 * 语义是「每个成员随机挑一个提供者」：尼克有 5 个皮肤，8 个生还者各随机挑一个，
 * 拼出一套新的组合；两个包不能覆盖同一个成员（那在游戏里就是互相盖文件）。
 * 合集包（8 人生还者 + 21 把武器那种）一旦被挑中，它覆盖的成员整片落地。
 */
export function MixPanel({ onClose, initialFamilies, gapOnlyDefault }: Props) {
  const mods = useStore((s) => s.mods);
  const rosterFromStore = useStore((s) => s.coverageRoster);
  const applyModMix = useStore((s) => s.applyModMix);
  const ref = useModalA11y<HTMLDivElement>(true, onClose);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  const roster = useMemo(
    () => (rosterFromStore.length > 0 ? rosterFromStore : rosterFromMods(mods)),
    [rosterFromStore, mods],
  );

  const index = useMemo(() => buildCoverIndex(mods), [mods]);

  // 每个家族有多少个包能换它（决定这一行能不能点）
  const familyCounts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const mod of mods) {
      if (mod.unreadable) continue;
      for (const f of FAMILY_ORDER) {
        if (mod.coverage?.[f]?.hit) acc[f] = (acc[f] || 0) + 1;
      }
    }
    return acc;
  }, [mods]);

  const [families, setFamilies] = useState<string[]>(() => {
    // 只默认勾选「库里真的有包可换」的类别：一个候选都没有的类别勾上也是
    // 四行「库里没有替换它的 Mod」，白占版面
    const usable = FAMILY_ORDER.filter(
      (f) => roster.some((r) => r.key === f) && (familyCounts[f] || 0) > 0,
    );
    if (initialFamilies && initialFamilies.length > 0) {
      const wanted = usable.filter((f) => initialFamilies.includes(f));
      if (wanted.length > 0) return wanted;
    }
    return usable;
  });
  const [gapOnly, setGapOnly] = useState(!!gapOnlyDefault);

  const roll = useMemo(
    () => rollMix(mods, roster, { families, gapOnly }),
    // nonce 只用来触发「换一批」；families/gapOnly 变化时也要重滚
    [mods, roster, families, gapOnly, nonce],
  );

  const plan = useMemo(() => planMix(mods, roll, families), [mods, roll, families]);
  const summary = useMemo(() => rollSummary(roll, roster, families), [roll, roster, families]);

  const toggleFamily = (fam: string) => {
    if ((familyCounts[fam] || 0) === 0) return;
    setFamilies((prev) => (prev.includes(fam) ? prev.filter((f) => f !== fam) : [...prev, fam]));
  };

  const coveredTotal = summary.reduce((n, s) => n + s.covered, 0);
  const wantedTotal = summary.reduce((n, s) => n + s.total, 0);
  const missingTotal = wantedTotal - coveredTotal;
  const changed = plan.enable.length + plan.disable.length;

  // 缺口里有多少是「库里根本没有替换它的包」（这种再滚也补不上），
  // 剩下的只是这次没排上 —— 两者得分开说，否则用户会一直点「换一批」
  const noSource = useMemo(() => {
    let n = 0;
    for (const fam of roster) {
      if (!families.includes(fam.key)) continue;
      for (const name of fam.names) {
        const key = entityKey(fam.key, name);
        if (!roll.assignment.has(key) && (index.get(key)?.length ?? 0) === 0) n += 1;
      }
    }
    return n;
  }, [roster, families, index, roll]);

  const submit = async () => {
    if (busy || changed === 0) return;
    setBusy(true);
    try {
      const result = await applyModMix(plan.enable, plan.disable);
      if (!result) return; // 失败提示已经在 store 里弹过
      const parts = [result.changed > 0 ? `改动了 ${result.changed} 个 Mod` : '状态本来就是这样'];
      if (result.writeError) parts.push(`但写入 addonlist.txt 失败：${result.writeError}`);
      if (result.missing.length > 0) parts.push(`${result.missing.length} 个没找到`);
      showToast(`混搭已应用：${parts.join('，')}`, result.writeError ? 'error' : 'success');
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content mix-panel"
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mix-panel__head">
          <h3>一键混搭</h3>
          <p>
            每个角色、每把枪都<strong>单独随机</strong>挑一个替换包，凑成一套互不覆盖的组合。
            Nick 有 5 个皮肤就从这 5 个里随机挑，8 个生还者各挑一个；合集包被挑中时，
            它覆盖的那批成员会整片落地。
          </p>
        </div>

        <div className="mix-panel__families">
          {FAMILY_ORDER.map((fam) => {
            const on = families.includes(fam);
            const n = familyCounts[fam] || 0;
            return (
              <button
                key={fam}
                className={`mix-fam-chip${on ? ' mix-fam-chip--on' : ''}${n === 0 ? ' mix-fam-chip--empty' : ''}`}
                disabled={n === 0}
                onClick={() => toggleFamily(fam)}
                title={n === 0 ? `库里没有替换「${fam}」的 Mod` : `${n} 个 Mod 可换${fam}`}
              >
                <span className="mix-fam-chip__box">{on ? '✓' : ''}</span>
                {fam}
                <em>{n}</em>
              </button>
            );
          })}
          <label className="mix-panel__gap" title="只为现在没人替换的成员随机挑，已经启用的包一律不动">
            <input type="checkbox" checked={gapOnly} onChange={(e) => setGapOnly(e.target.checked)} />
            只补缺口
          </label>
          <button
            className="mix-panel__reroll"
            onClick={() => setNonce((n) => n + 1)}
            title="重新随机一套（同一批成员再挑一次）"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <rect x="3" y="3" width="18" height="18" rx="4" />
              <circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" />
              <circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" />
              <circle cx="12" cy="12" r="1.2" fill="currentColor" />
            </svg>
            换一批
          </button>
        </div>

        {summary.length > 0 && (
          <div className="mix-panel__stat">
            {summary.map((s) => (
              <span key={s.key} className={s.covered >= s.total ? 'is-full' : ''}>
                {s.key}
                <b>{s.covered}/{s.total}</b>
              </span>
            ))}
            <span className="mix-panel__stat-mod">
              选中 <b>{roll.chosen.length}</b> 个包
            </span>
          </div>
        )}

        <div className="mix-panel__list">
          {roster
            .filter((f) => families.includes(f.key))
            .map((f) => {
              const cov = f.names.filter((n) => roll.assignment.has(entityKey(f.key, n))).length;
              return (
                <div className="mix-fam" key={f.key}>
                  <div className="mix-fam__head">
                    <span>{f.key}</span>
                    <em className={cov >= f.total ? 'is-full' : ''}>{cov}/{f.total}</em>
                  </div>
                  <div className="mix-fam__items">
                    {f.names.map((name) => {
                      const key = entityKey(f.key, name);
                      const mod = roll.assignment.get(key);
                      const cands = roll.candidates.get(key)?.length ?? 0;
                      return (
                        <div className={`mix-ent${mod ? '' : ' mix-ent--gap'}`} key={name}>
                          <span className="mix-ent__name" title={entityHint(name)}>{entityLabel(name)}</span>
                          {mod ? (
                            <>
                              <span className="mix-ent__mod" title={mod.display_name}>
                                <span className="mix-ent__modname">{mod.display_name}</span>
                                {mod.enabled && <i className="mix-ent__on">已启用</i>}
                              </span>
                              <span
                                className="mix-ent__cand"
                                title={
                                  cands > 1
                                    ? `库里有 ${cands} 个包能换它，本次随机选了这一个`
                                    : '库里只有这一个包能换它'
                                }
                              >
                                {cands > 1 ? `${cands} 选 1` : '唯一'}
                              </span>
                            </>
                          ) : (
                            <span className="mix-ent__none">
                              {cands === 0 ? '库里没有替换它的 Mod' : '本次没排上（换一批试试）'}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
        </div>

        <div className="mix-panel__plan">
          <div className="mix-panel__summary">
            <span>
              启用 <strong>{plan.enable.length}</strong> 个
              <span className="mix-panel__dot">·</span>
              关掉冲突 <strong>{plan.disable.length}</strong> 个
            </span>
            <span className="mix-panel__detail">
              覆盖 {coveredTotal}/{wantedTotal}
              {missingTotal > 0 ? ` · 还差 ${missingTotal}` : ' · 已满'}
            </span>
          </div>

          {plan.conflicts.length > 0 && (
            <div className="mix-panel__warn">
              {plan.conflicts.slice(0, 2).map((c, i) => (
                <div key={i}>
                  会关掉 <b>{c.modLabel}</b>：它和 {c.with} 都在换{c.entity}。
                </div>
              ))}
              {plan.conflicts.length > 2 && <div>…还有 {plan.conflicts.length - 2} 个同类冲突</div>}
            </div>
          )}

          {plan.spill.length > 0 && (
            <div className="mix-panel__hint">
              {plan.spill.slice(0, 2).map((s, i) => (
                <div key={i}>
                  {s.label} 还会顺带替换 {s.families.join('、')}（这类没参与本次混搭）。
                </div>
              ))}
            </div>
          )}

          {families.length === 0 && (
            <div className="mix-panel__hint">上面至少勾一个类别，才有得挑。</div>
          )}
          {families.length > 0 && changed === 0 && (
            <div className="mix-panel__hint">
              {gapOnly ? '没有缺口需要补 —— 当前启用的包已经覆盖了勾选的类别。' : '这套组合就是当前状态，点了也不会变。'}
            </div>
          )}
          {missingTotal > 0 && changed > 0 && (
            <div className="mix-panel__hint">
              还差 {missingTotal} 个成员：
              {noSource > 0 && `${noSource} 个库里就没有替换它的包（只能留原版）`}
              {noSource > 0 && missingTotal - noSource > 0 && '，'}
              {missingTotal - noSource > 0 && `${missingTotal - noSource} 个这次没排上（点「换一批」再滚一次）`}
              {noSource === missingTotal ? '。' : '。'}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onClose}>取消</button>
          <button
            className="modal-btn modal-btn-primary"
            disabled={busy || changed === 0}
            onClick={() => void submit()}
          >
            {busy ? '正在应用…' : changed === 0 ? '无需改动' : `应用这套（${plan.enable.length + plan.disable.length}）`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
