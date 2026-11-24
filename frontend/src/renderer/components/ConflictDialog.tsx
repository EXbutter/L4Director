/**
 * 冲突详情弹窗（共用）。
 *
 * 之前「我的 Mod」和「整合包」各写了一套弹窗，信息还只停留在「谁跟谁撞」。
 * 这里统一成一个组件，并把后端早就算好、之前被丢掉的信息如实展示出来：
 *   - 顶部总览：几个 Mod、多少文件、最高级别、最高闪退风险；
 *   - 包级闪退风险 banner（路径不重叠但模型各带一半、装一起会崩）；
 *   - 每张卡：严重度 + 风险 + 资源类型 + 人话原因 + 处理建议；
 *   - 「涉及文件」可展开，不再依赖鼠标悬停的原生 tooltip；
 *   - 卡片主体点击是「展开明细」，右侧才是明确的「禁用/启用」按钮，避免误触。
 *
 * 纯展示逻辑（排序、总览、标签）在 utils/conflictView.ts，已被单测覆盖。
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalA11y } from '../hooks/useModalA11y';
import { ThumbImage } from './ThumbImage';
import { ModSwitch } from './ModSwitch';
import type { ConflictDetail, ModData } from '../store/useStore';
import {
  SEVERITY_LABEL,
  RISK_LABEL,
  sortConflictDetails,
  summarizeConflictDetails,
  conflictKindLabels,
} from '../utils/conflictView';

export interface ConflictDialogProps {
  /** 被查看的 Mod 名（弹窗主角） */
  ownerName: string;
  /** 主角 Mod（可能暂时找不到；用于标题/缩略图/包级闪退风险） */
  owner?: ModData;
  /** 硬冲突明细（hard / script） */
  details: ConflictDetail[];
  /** 提示级重叠（copy / entry / soft），默认折叠 */
  hints?: ConflictDetail[];
  /** 完整明细是否仍在按需加载 */
  loading?: boolean;
  /** 全量 Mod 列表，用于按名字找对方 */
  mods: ModData[];
  /** Mod 标题解析（优先用户自定义显示名） */
  titleOf: (mod: ModData) => string;
  /** 按 Mod 名取显示名（找不到时退回 name） */
  getDisplayName: (name: string) => string | null | undefined;
  /** 封面地址解析 */
  resolveUrl: (url: string | null) => string | null;
  onClose: () => void;
  onToggleMod: (name: string, path?: string) => void;
}

export function ConflictDialog({
  ownerName,
  owner,
  details,
  hints = [],
  loading = false,
  mods,
  titleOf,
  getDisplayName,
  resolveUrl,
  onClose,
  onToggleMod,
}: ConflictDialogProps) {
  const modalRef = useModalA11y<HTMLDivElement>(true, onClose);
  // 展开的文件明细：用 Set 记录哪些卡片被展开（key = other+severity+idx）
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());

  const byName = new Map(mods.map((m) => [m.name, m]));
  const ownerTitle = owner ? titleOf(owner) : (getDisplayName(ownerName) || ownerName);
  const isMap = owner?.role === 'campaign';
  const crashRisk = owner?.crash_risk && owner.crash_risk !== 'low' ? owner.crash_risk : null;

  const sortedDetails = sortConflictDetails(details);
  const sortedHints = sortConflictDetails(hints);
  const summary = summarizeConflictDetails(details);

  const nameOf = (name: string): string => {
    const m = byName.get(name);
    return m ? titleOf(m) : (getDisplayName(name) || name);
  };

  const toggleOpen = (key: string) => {
    setOpenFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 建议禁用哪一方：advice.target 可能是对方，也可能指向主角自己 */
  const adviceTargetText = (d: ConflictDetail): string => {
    const target = d.advice?.target;
    if (!target) return '';
    if (target === d.other) return nameOf(d.other);
    if (target === ownerName) return ownerTitle;
    return nameOf(target);
  };

  const renderCard = (d: ConflictDetail, idx: number) => {
    const other = byName.get(d.other);
    const otherTitle = other ? titleOf(other) : (getDisplayName(d.other) || d.other);
    const key = `${d.other}-${d.severity}-${idx}`;
    const open = openFiles.has(key);
    const kindLabels = conflictKindLabels(d);
    const extraFiles = Math.max(0, (d.count || 0) - (d.files?.length || 0));
    const adviceTarget = adviceTargetText(d);

    return (
      <div
        key={key}
        className={`conflict-card conflict-card--${d.severity}${other && !other.enabled ? ' conflict-card--off' : ''}`}
      >
        <div className="conflict-card__row">
          <div className="conflict-card__thumb">
            {other && resolveUrl(other.thumbnail_url) ? (
              <ThumbImage
                src={resolveUrl(other.thumbnail_url)!}
                alt={otherTitle}
                className="conflict-card__img"
                maxWidth={96}
                maxHeight={96}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="9" cy="9" r="2" />
                <path d="M21 15l-4-4-6 6-3-3-5 5" />
              </svg>
            )}
          </div>

          <div className="conflict-card__info">
            <div className="conflict-card__titleline">
              <span className="conflict-card__name" title={otherTitle}>{otherTitle}</span>
              <span className={`conflict-card__sev conflict-card__sev--${d.severity}`}>
                {SEVERITY_LABEL[d.severity] || d.severity}
              </span>
              {d.risk && d.risk !== 'low' && (
                <span className={`conflict-card__risk conflict-card__risk--${d.risk}`}>
                  {RISK_LABEL[d.risk]}
                </span>
              )}
            </div>

            {(kindLabels.length > 0 || (d.other_role_tags?.length ?? 0) > 0) && (
              <div className="conflict-card__tags">
                {kindLabels.map((t) => (
                  <span key={`k-${t}`} className="conflict-card__kind">{t}</span>
                ))}
                {(d.other_role_tags || []).slice(0, 4).map((t) => (
                  <span key={`r-${t}`} className="conflict-card__roletag">{t}</span>
                ))}
              </div>
            )}

            {d.risk && d.risk !== 'low' && d.reason && (
              <div className="conflict-card__reason">{d.reason}</div>
            )}
            {(d.advice?.text || adviceTarget) && (
              <div className="conflict-card__advice">
                {d.advice?.text}
                {adviceTarget && (
                  <>{d.advice?.text ? ' ' : ''}建议禁用「<strong>{adviceTarget}</strong>」。</>
                )}
              </div>
            )}

            <button
              type="button"
              className={`conflict-card__files-toggle${open ? ' is-open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleOpen(key);
              }}
            >
              涉及 {d.count} 个文件
              {extraFiles > 0 ? `（此处列前 ${d.files?.length || 0} 个）` : ''}
              <span className="conflict-card__caret" aria-hidden="true" />
            </button>
            {open && (
              <ul className="conflict-card__filelist">
                {(d.files || []).map((f, i) => (
                  <li key={`${f}-${i}`}>{f}</li>
                ))}
                {extraFiles > 0 && (
                  <li className="conflict-card__filelist-more">…还有 {extraFiles} 个未列出</li>
                )}
              </ul>
            )}
          </div>

          {other && (
            <div className="conflict-card__action">
              <ModSwitch
                enabled={other.enabled}
                title={`${otherTitle}：${other.enabled ? '已启用，点击禁用' : '已禁用，点击启用'}`}
                onToggle={() => onToggleMod(other.name, other.path)}
              />
            </div>
          )}
        </div>
      </div>
    );
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`conflict-dialog${isMap ? ' conflict-dialog--map' : ''}`}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="conflict-dialog__header">
          <h3>{isMap ? '地图内置资源冲突' : '冲突 Mod 详情'}</h3>
          <button type="button" className="conflict-dialog__close" onClick={onClose} aria-label="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="conflict-dialog__subheader">
          {isMap ? (
            <>「<strong>{ownerTitle}</strong>」是地图包，它把场景用的模型/音效一并打进了 VPK。</>
          ) : (
            <>以下 Mod 与 <strong>{ownerTitle}</strong> 存在冲突</>
          )}
        </div>

        {/* 顶部总览：一眼看清规模与最高级别（没有硬冲突时不显示，避免「与 0 个冲突」） */}
        {sortedDetails.length > 0 && (
          <div className="conflict-summary">
            <div className="conflict-summary__main">
              {isMap ? '地图内置资源包与' : '与'} <strong>{summary.modCount}</strong> 个 Mod 冲突
              {summary.fileCount > 0 && <> · 共 <strong>{summary.fileCount}</strong> 个文件</>}
            </div>
            <div className="conflict-summary__badges">
              {summary.worstSeverity && (
                <span className={`conflict-card__sev conflict-card__sev--${summary.worstSeverity}`}>
                  最高：{SEVERITY_LABEL[summary.worstSeverity] || summary.worstSeverity}
                </span>
              )}
              {crashRisk && (
                <span className={`conflict-card__risk conflict-card__risk--${crashRisk}`}>
                  {RISK_LABEL[crashRisk]}
                </span>
              )}
            </div>
          </div>
        )}

        {/* 包级闪退风险：路径不重叠也可能崩，最需要用户知道 */}
        {crashRisk && (
          <div className={`conflict-crash conflict-crash--${crashRisk}`}>
            <div className="conflict-crash__title">
              ⚠ 闪退风险{crashRisk === 'high' ? '高' : '中'}
              {owner?.crash_with ? <> · 与「<strong>{nameOf(owner.crash_with)}</strong>」</> : null}
            </div>
            {owner?.crash_reason && <div className="conflict-crash__reason">{owner.crash_reason}</div>}
            {(owner?.crash_files?.length ?? 0) > 0 && (
              <div className="conflict-crash__files">
                缺失/不完整：{owner!.crash_files!.slice(0, 4).join('、')}
                {owner!.crash_files!.length > 4 ? ` 等 ${owner!.crash_files!.length} 个` : ''}
              </div>
            )}
            <div className="conflict-crash__advice">
              {owner?.crash_advice?.text || '两个包各带不完整的模型部件，建议禁用其中一个。'}
            </div>
          </div>
        )}

        {isMap && (
          <div className="conflict-dialog__note">
            地图里的资源是按全局路径加载的，会盖过同一路径的武器皮肤/角色替换。
            通常保留地图即可，地图玩法不受影响；想保住皮肤就把皮肤移到地图之前。
          </div>
        )}

        <div className="conflict-dialog__grid">
          {sortedDetails.length === 0 ? (
            <div className="conflict-dialog__empty">
              {loading ? '正在加载完整冲突明细…' : '没有硬冲突'}
            </div>
          ) : (
            sortedDetails.map((d, i) => renderCard(d, i))
          )}
          {loading && sortedDetails.length > 0 && (
            <div className="conflict-dialog__loading">正在补齐完整文件清单…</div>
          )}
        </div>

        {sortedHints.length > 0 && (
          <details className="conflict-dialog__hints">
            <summary>
              其他重叠 {sortedHints.length} 项
              <span className="conflict-dialog__hints-sub">（不影响使用，展开查看）</span>
            </summary>
            <div className="conflict-dialog__hint-list">
              {sortedHints.map((d, i) => {
                const kindLabels = conflictKindLabels(d);
                return (
                  <div key={`${d.other}-${d.severity}-${i}`} className="conflict-hint-row">
                    <span className={`conflict-card__sev conflict-card__sev--${d.severity}`}>
                      {SEVERITY_LABEL[d.severity] || d.severity}
                    </span>
                    <span className="conflict-hint-row__name">{nameOf(d.other)}</span>
                    {kindLabels.length > 0 && (
                      <span className="conflict-hint-row__kinds">{kindLabels.join(' · ')}</span>
                    )}
                    <span className="conflict-hint-row__files">{d.count} 个文件</span>
                  </div>
                );
              })}
            </div>
          </details>
        )}

        <div className="conflict-dialog__footer">
          <span className="conflict-dialog__hint">点「涉及文件」看明细；右侧按钮切换对方启停</span>
          <button type="button" className="modal-btn modal-btn-cancel" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
