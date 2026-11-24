/**
 * 冲突弹窗的纯展示逻辑：排序 / 总览 / 类型标签。
 *
 * 这些函数决定「用户第一眼看到哪条冲突、总览报多大、类型怎么说」，
 * 最容易在后续改动里回归，所以单测守住。
 */
import { describe, expect, it } from 'vitest'

import {
  conflictKindLabels,
  riskRank,
  severityRank,
  sortConflictDetails,
  summarizeConflictDetails,
} from '../src/renderer/utils/conflictView'
import type { ConflictDetail } from '../src/renderer/store/useStore'

function d(partial: Partial<ConflictDetail> & Pick<ConflictDetail, 'other' | 'severity'>): ConflictDetail {
  return { count: 0, files: [], ...partial }
}

describe('严重度 / 风险排序权重', () => {
  it('严重度：硬冲突 < 脚本 < 原版副本 < 入口 < 资源重叠', () => {
    expect(severityRank('hard')).toBeLessThan(severityRank('script'))
    expect(severityRank('script')).toBeLessThan(severityRank('copy'))
    expect(severityRank('copy')).toBeLessThan(severityRank('entry'))
    expect(severityRank('entry')).toBeLessThan(severityRank('soft'))
    expect(severityRank(undefined)).toBe(99)
  })

  it('风险：high < medium < low，缺省视为 low', () => {
    expect(riskRank('high')).toBeLessThan(riskRank('medium'))
    expect(riskRank('medium')).toBeLessThan(riskRank('low'))
    expect(riskRank(undefined)).toBe(riskRank('low'))
  })
})

describe('sortConflictDetails', () => {
  it('闪退风险高的排最前，其次按严重度，再按文件数降序', () => {
    const list = [
      d({ other: 'A', severity: 'soft', count: 9 }),
      d({ other: 'B', severity: 'hard', count: 1, risk: 'low' }),
      d({ other: 'C', severity: 'script', count: 20, risk: 'high' }),
      d({ other: 'D', severity: 'hard', count: 5, risk: 'low' }),
    ]
    const sorted = sortConflictDetails(list).map((x) => x.other)
    // C(high) 最前；然后 hard 的 D(5) 先于 B(1)；最后 soft 的 A
    expect(sorted).toEqual(['C', 'D', 'B', 'A'])
  })

  it('不修改原数组', () => {
    const list = [d({ other: 'A', severity: 'soft' }), d({ other: 'B', severity: 'hard' })]
    const copy = [...list]
    sortConflictDetails(list)
    expect(list).toEqual(copy)
  })
})

describe('summarizeConflictDetails', () => {
  it('去重 Mod 数、累加文件数、取最高级别与最高风险', () => {
    const list = [
      d({ other: 'A', severity: 'hard', count: 3, risk: 'medium' }),
      d({ other: 'A', severity: 'script', count: 2, risk: 'low' }),
      d({ other: 'B', severity: 'soft', count: 5, risk: 'low' }),
    ]
    const s = summarizeConflictDetails(list)
    expect(s.modCount).toBe(2) // A, B
    expect(s.fileCount).toBe(10)
    expect(s.worstSeverity).toBe('hard')
    expect(s.worstRisk).toBe('medium')
    expect(s.entryCount).toBe(3)
  })

  it('空列表给中性结果', () => {
    const s = summarizeConflictDetails([])
    expect(s).toEqual({ modCount: 0, fileCount: 0, worstSeverity: null, worstRisk: 'low', entryCount: 0 })
  })
})

describe('conflictKindLabels', () => {
  it('多类型按主资源优先排序并带计数', () => {
    expect(conflictKindLabels(d({ other: 'A', severity: 'hard', kinds: { texture: 5, model: 3 } }))).toEqual([
      '模型 3',
      '贴图 5',
    ])
  })

  it('只有 kind_label / kind 时退化', () => {
    expect(conflictKindLabels(d({ other: 'A', severity: 'hard', kind_label: '脚本' }))).toEqual(['脚本'])
    expect(conflictKindLabels(d({ other: 'A', severity: 'hard', kind: 'sound' }))).toEqual(['音效'])
  })

  it('什么都没有返回空数组', () => {
    expect(conflictKindLabels(d({ other: 'A', severity: 'soft' }))).toEqual([])
  })
})
