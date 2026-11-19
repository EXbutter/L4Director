/**
 * 战役地图判定：占用统计必须把地图排除。
 *
 * 依据：地图动辄几百 MB 到 2 GB，但只在玩那张图时才会被引擎载入。
 * 误判成普通资源包 → 右下角占用永远飘红，失去参考价值。
 */
import { describe, expect, it } from 'vitest'

import { isCampaignMod } from '../src/renderer/utils/modRole'

describe('isCampaignMod', () => {
  it('后端判出的 role=campaign 最可靠', () => {
    expect(isCampaignMod({ role: 'campaign' })).toBe(true)
  })

  it('禁用包的 role 还是默认 art，靠标签兜底', () => {
    expect(isCampaignMod({ role: 'art', role_tags: ['地图'] })).toBe(true)
    expect(isCampaignMod({ role: 'art', tags: ['战役'] })).toBe(true)
  })

  it('普通资源包不算地图', () => {
    expect(isCampaignMod({ role: 'art', tags: ['材质/皮肤'], role_tags: ['美术'] })).toBe(false)
    expect(isCampaignMod({ role: 'hud', tags: [] })).toBe(false)
  })

  it('空数据不抛错', () => {
    expect(isCampaignMod(null)).toBe(false)
    expect(isCampaignMod(undefined)).toBe(false)
    expect(isCampaignMod({})).toBe(false)
    expect(isCampaignMod({ tags: null, role_tags: null })).toBe(false)
  })
})
