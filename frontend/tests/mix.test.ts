/**
 * 混搭（rollMix / planMix）的语义验证。
 *
 * 这套逻辑的核心不变量：**一个成员只由一个包提供**（两个包都换 Nick，装在一起
 * 只会互相盖文件，谁赢取决于加载顺序）。以前实现是「每类挑一个覆盖率最高的大包」，
 * 那是错的 —— 这些用例就是防止有人再改回去。
 */
import { describe, expect, it } from 'vitest'

import type { ModData } from '../src/renderer/store/useStore'
import {
  buildCoverIndex,
  coverageBadges,
  coveredEntities,
  entityHint,
  entityKey,
  isFullSet,
  keyEntity,
  keyFamily,
  planMix,
  rollMix,
  rosterFromMods,
  type CoverageMap,
  type RosterFamily,
} from '../src/renderer/utils/mix'

function mod(name: string, coverage: CoverageMap, extra: Partial<ModData> = {}): ModData {
  return {
    name,
    display_name: name,
    path: `D:/addons/${name}`,
    size_bytes: 1024,
    enabled: false,
    is_workshop: false,
    workshop_id: null,
    last_modified: null,
    description: null,
    author: null,
    version: null,
    tags: [],
    thumbnail_url: null,
    vpk_title: null,
    conflicts: [],
    coverage,
    ...extra,
  } as ModData
}

const roster: RosterFamily[] = [
  { key: '生还者', total: 3, names: ['Nick', 'Zoey', 'Coach'] },
  { key: '武器', total: 1, names: ['Rifle'] },
]

const nickA = mod('nick_a.vpk', { 生还者: { hit: 1, total: 3, names: ['Nick'] } })
const nickB = mod('nick_b.vpk', { 生还者: { hit: 1, total: 3, names: ['Nick'] } })
const zoey = mod('zoey.vpk', { 生还者: { hit: 1, total: 3, names: ['Zoey'] } })
const rifle = mod('rifle.vpk', { 武器: { hit: 1, total: 1, names: ['Rifle'] } })

describe('成员键与标签', () => {
  it('成员名一律是官方英文名（界面不做翻译）', () => {
    expect(entityHint('Nick')).toBe('Nick（尼克）')
    expect(entityHint('NotARealName')).toBe('NotARealName')
  })

  it('entityKey 拆分可逆', () => {
    const key = entityKey('生还者', 'Coach')
    expect(keyFamily(key)).toBe('生还者')
    expect(keyEntity(key)).toBe('Coach')
    // 不含分隔符时按空家族 / 原样处理，不能抛错
    expect(keyFamily('abc')).toBe('')
    expect(keyEntity('abc')).toBe('abc')
  })
})

describe('覆盖度索引', () => {
  it('同一个成员的多个包都进候选', () => {
    const index = buildCoverIndex([nickA, nickB, zoey])
    expect(index.get(entityKey('生还者', 'Nick'))).toHaveLength(2)
    expect(index.get(entityKey('生还者', 'Zoey'))).toHaveLength(1)
    expect(index.get(entityKey('生还者', 'Coach'))).toBeUndefined()
  })

  it('坏包不参与混搭', () => {
    const broken = mod('broken.vpk', { 生还者: { hit: 1, total: 3, names: ['Nick'] } }, { unreadable: true })
    const index = buildCoverIndex([broken, nickA])
    expect(index.get(entityKey('生还者', 'Nick'))).toHaveLength(1)
  })

  it('整套命中才算 full set，徽标最多给 2 个', () => {
    const fullSet = mod('set.vpk', {
      生还者: { hit: 3, total: 3, names: ['Nick', 'Zoey', 'Coach'] },
      武器: { hit: 1, total: 1, names: ['Rifle'] },
    })
    expect(isFullSet(fullSet, '生还者')).toBe(true)
    expect(isFullSet(nickA, '生还者')).toBe(false)
    expect(coverageBadges(fullSet).map((b) => b.family)).toEqual(['生还者', '武器'])
    expect(coverageBadges(fullSet, 1)).toHaveLength(1)
  })

  it('coveredEntities 只返回真实命中的成员', () => {
    expect(coveredEntities(nickA)).toEqual([entityKey('生还者', 'Nick')])
    // hit 为 0 的家族不算覆盖
    expect(coveredEntities(mod('x.vpk', { 武器: { hit: 0, total: 1, names: [] } }))).toEqual([])
  })
})

describe('rollMix：按成员随机指派', () => {
  it('两个包换同一个成员时只会选一个', () => {
    const roll = rollMix([nickA, nickB], roster, {
      families: ['生还者'],
      rand: () => 0.7,
    })

    const nickProviders = roll.chosen.filter((m) => m.name.startsWith('nick_'))
    expect(nickProviders).toHaveLength(1)
    expect(roll.candidates.get(entityKey('生还者', 'Nick'))).toHaveLength(2)
  })

  it('每个成员各自随机，凑成一整套', () => {
    const roll = rollMix([nickA, nickB, zoey, rifle], roster, {
      families: ['生还者', '武器'],
      rand: () => 0.1,
    })

    expect(roll.assignment.get(entityKey('生还者', 'Nick'))).toBeDefined()
    expect(roll.assignment.get(entityKey('生还者', 'Zoey'))).toBeDefined()
    expect(roll.assignment.get(entityKey('武器', 'Rifle'))).toBe(rifle)
    // Coach 库里没人换 → 记进 missing，不静默忽略
    expect(roll.missing).toContain(entityKey('生还者', 'Coach'))
  })

  it('候选为空的成员进 missing', () => {
    const roll = rollMix([rifle], roster, { families: ['生还者'], rand: () => 0.5 })
    expect(roll.chosen).toHaveLength(0)
    expect(roll.missing.sort()).toEqual([
      entityKey('生还者', 'Coach'),
      entityKey('生还者', 'Nick'),
      entityKey('生还者', 'Zoey'),
    ].sort())
  })

  it('gapOnly 会钉住已启用的包，不把它算成「需要启用」', () => {
    const roll = rollMix([nickA, nickB, zoey], roster, {
      families: ['生还者'],
      gapOnly: true,
      rand: () => 0.5,
    })

    expect(roll.lockedNames.size).toBe(0)   // 都不在启用状态 → 没东西可钉

    const enabledNick = { ...nickA, enabled: true }
    const roll2 = rollMix([enabledNick, nickB, zoey], roster, {
      families: ['生还者'],
      gapOnly: true,
      rand: () => 0.5,
    })
    expect(roll2.lockedNames.has('nick_a.vpk')).toBe(true)
    expect(roll2.assignment.get(entityKey('生还者', 'Nick'))?.name).toBe('nick_a.vpk')
    // 被钉住的包不会再出现在 chosen 里（它本来就在生效）
    expect(roll2.chosen.map((m) => m.name)).not.toContain('nick_a.vpk')
  })

  it('选中的包之间不会撞同一个成员（合集与单体混选）', () => {
    const fullSet = mod('fullset.vpk', {
      生还者: { hit: 3, total: 3, names: ['Nick', 'Zoey', 'Coach'] },
    })
    const roll = rollMix([fullSet, nickA, zoey], roster, {
      families: ['生还者'],
      rand: () => 0.42,
    })

    // 一旦选了合集，其它「换生还者」的包就不该再被选
    const names = roll.chosen.map((m) => m.name)
    if (names.includes('fullset.vpk')) {
      expect(names).toHaveLength(1)
    }
  })
})

describe('planMix：只关真正撞车的', () => {
  it('禁用与选中包冲突的已启用包，未启用的不动', () => {
    const roll = rollMix([nickA, nickB, zoey], roster, {
      families: ['生还者'],
      rand: () => 0.9,
    })
    const chosen = roll.chosen[0]
    const rival = { ...(chosen.name === 'nick_a.vpk' ? nickB : nickA), enabled: true }
    const plan = planMix([rival, ...roll.chosen], roll, ['生还者'])

    expect(plan.enable).toContain(chosen.name)
    expect(plan.disable).toContain(rival.name)
    expect(plan.conflicts[0].entity).toContain('Nick')
  })

  it('没有任何覆盖信息的 Mod 一律不动（地图/语音包不该被顺手关掉）', () => {
    const roll = rollMix([nickA], roster, { families: ['生还者'], rand: () => 0.1 })
    const voice = mod('voice.vpk', {}, { enabled: true })
    const map = mod('map.vpk', {}, { enabled: true, role: 'campaign', role_tags: ['地图'] })
    const plan = planMix([voice, map], roll, ['生还者'])

    expect(roll.chosen[0].name).toBe('nick_a.vpk')
    expect(plan.disable).not.toContain('voice.vpk')
    expect(plan.disable).not.toContain('map.vpk')
  })

  it('已经选中的包不会出现在 disable 里', () => {
    const roll = rollMix([nickA, zoey], roster, { families: ['生还者'], rand: () => 0.3 })
    const plan = planMix(roll.chosen, roll, ['生还者'])
    for (const name of plan.enable) {
      expect(plan.disable).not.toContain(name)
    }
  })
})

describe('rosterFromMods', () => {
  it('从各 Mod 的覆盖信息还原名册，并按家族顺序排列', () => {
    const r = rosterFromMods([
      mod('a.vpk', { 武器: { hit: 1, total: 1, names: ['Rifle'] } }),
      mod('b.vpk', { 生还者: { hit: 1, total: 8, names: ['Nick'] } }),
    ])
    expect(r.map((f) => f.key)).toEqual(['生还者', '武器'])
    expect(r[0]).toMatchObject({ total: 8, names: ['Nick'] })
  })
})
