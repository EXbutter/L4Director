/**
 * 冲突弹窗的纯展示逻辑（排序、总览、标签映射）。
 *
 * 抽成不依赖 React / DOM 的纯函数，是为了能被 vitest 直接单测：
 * 冲突排序与「最高级别 / 闪退风险」的统计最容易回归，且不关心 UI。
 * 真正的渲染在 components/ConflictDialog.tsx。
 */
import type { ConflictDetail } from '../store/useStore';

/** 严重度：数字越小越重要（硬冲突 > 脚本 > 原版副本 > 入口 > 资源重叠） */
export const SEVERITY_ORDER: Record<string, number> = {
  hard: 0,
  script: 1,
  copy: 2,
  entry: 3,
  soft: 4,
};

/** 闪退风险：数字越小越危险 */
export const RISK_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export const SEVERITY_LABEL: Record<string, string> = {
  hard: '硬冲突',
  script: '脚本冲突',
  copy: '原版副本',
  entry: '入口重叠',
  soft: '资源重叠',
};

export const RISK_LABEL: Record<string, string> = {
  high: '闪退风险高',
  medium: '闪退风险中',
  low: '低风险',
};

export const KIND_LABEL: Record<string, string> = {
  model: '模型',
  material: '材质',
  texture: '贴图',
  particle: '粒子',
  sound: '音效',
  script: '脚本',
  map: '地图',
  ui: '界面',
  other: '其他',
};

/** 多类型并列时的展示顺序（把模型/材质这类主资源排前面） */
const KIND_ORDER = ['model', 'material', 'texture', 'particle', 'sound', 'script', 'map', 'ui', 'other'];

export function severityRank(severity: string | undefined | null): number {
  return severity != null && SEVERITY_ORDER[severity] != null ? SEVERITY_ORDER[severity] : 99;
}

export function riskRank(risk: string | undefined | null): number {
  return risk != null && RISK_ORDER[risk] != null ? RISK_ORDER[risk] : RISK_ORDER.low;
}

/**
 * 冲突明细排序：先按闪退风险（高在中低之前），再按严重度，最后按涉及文件数降序。
 * 「会崩的」永远排最上面 —— 用户最怕的是闪退，不是名字冲突。
 */
export function sortConflictDetails(list: ConflictDetail[]): ConflictDetail[] {
  return [...list].sort((a, b) => {
    const byRisk = riskRank(a.risk) - riskRank(b.risk);
    if (byRisk !== 0) return byRisk;
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return (b.count || 0) - (a.count || 0);
  });
}

export interface ConflictSummary {
  /** 涉及的不同 Mod 数（按 other 去重） */
  modCount: number;
  /** 涉及文件总数 */
  fileCount: number;
  /** 最严重的级别（没有则为 null） */
  worstSeverity: string | null;
  /** 最高闪退风险（没有时视为 low） */
  worstRisk: 'low' | 'medium' | 'high';
  /** 明细条数 */
  entryCount: number;
}

/** 顶部总览用：几个 Mod、多少文件、最高级别、最高闪退风险。 */
export function summarizeConflictDetails(list: ConflictDetail[]): ConflictSummary {
  const others = new Set<string>();
  let fileCount = 0;
  let worstSeverity: string | null = null;
  let worstSevRank = 99;
  let worstRisk: 'low' | 'medium' | 'high' = 'low';
  let worstRiskRank = RISK_ORDER.low;

  for (const d of list) {
    others.add(d.other);
    fileCount += d.count || 0;
    const sr = severityRank(d.severity);
    if (sr < worstSevRank) {
      worstSevRank = sr;
      worstSeverity = d.severity;
    }
    const rr = riskRank(d.risk);
    if (rr < worstRiskRank) {
      worstRiskRank = rr;
      worstRisk = (d.risk as 'low' | 'medium' | 'high') || 'low';
    }
  }

  return { modCount: others.size, fileCount, worstSeverity, worstRisk, entryCount: list.length };
}

/**
 * 把一条冲突的资源类型渲染成「模型 3」「贴图 5」这样的标签文本。
 * 优先用 kinds（多类型计数），否则退回 kind_label / kind。
 */
export function conflictKindLabels(detail: ConflictDetail): string[] {
  const kinds = detail.kinds || {};
  const entries = Object.entries(kinds).filter(([, n]) => typeof n === 'number' && n > 0);
  if (entries.length > 0) {
    return entries
      .sort((a, b) => {
        const ia = KIND_ORDER.indexOf(a[0]);
        const ib = KIND_ORDER.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .map(([kind, n]) => `${KIND_LABEL[kind] || kind} ${n}`);
  }
  if (detail.kind_label) return [detail.kind_label];
  if (detail.kind) return [KIND_LABEL[detail.kind] || detail.kind];
  return [];
}
