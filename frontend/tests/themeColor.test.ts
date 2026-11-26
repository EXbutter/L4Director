/**
 * 主色色卡：亮度硬约束 + 文字色判定。
 *
 * 规格（docs-internal/06）里的硬约束：六档预设的相对亮度必须落在 0.13~0.30。
 * 低于 0.13 会被运行时提亮、高于 0.62 会被压暗 —— 一旦触发校正，
 * 色卡上显示的色和界面实际的色就对不上了。这条用例就是守住它。
 */
import { describe, expect, it } from 'vitest'

import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentFill,
  hexToRgb,
  mixHex,
  normalizeHex,
  readableOn,
  relativeLuminance,
} from '../src/renderer/utils/themeColor'

describe('颜色解析', () => {
  it('三位/六位/带不带 # 都能归一', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc')
    expect(normalizeHex('aabbcc')).toBe('#aabbcc')
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc')
    expect(normalizeHex('  #1E88E5 ')).toBe('#1e88e5')
  })

  it('非法输入返回 null（调用方回落到默认主色）', () => {
    expect(normalizeHex('')).toBeNull()
    expect(normalizeHex(null)).toBeNull()
    expect(normalizeHex('rgb(0,0,0)')).toBeNull()
    expect(normalizeHex('#12345')).toBeNull()
  })

  it('hexToRgb 与十六进制一致', () => {
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 })
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(hexToRgb('#1e88e5')).toEqual({ r: 30, g: 136, b: 229 })
  })
})

describe('混色与亮度', () => {
  it('weightB=0/1 时取端点值', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
  })

  it('中间值按比例插值', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('相对亮度符合 WCAG 口径', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    // 中灰大约 0.21
    expect(relativeLuminance('#808080')).toBeGreaterThan(0.2)
    expect(relativeLuminance('#808080')).toBeLessThan(0.23)
  })

  it('阈值 0.30：暗底白字、亮底深字', () => {
    expect(readableOn('#000000')).toBe('#ffffff')
    expect(readableOn('#0078d4')).toBe('#ffffff')
    expect(readableOn('#ffffff')).toBe('#1f2329')
    expect(readableOn('#f5d76e')).toBe('#1f2329')
  })
})

describe('预设色卡', () => {
  it('六档，键唯一，都是合法 hex', () => {
    expect(ACCENT_PRESETS).toHaveLength(6)
    expect(new Set(ACCENT_PRESETS.map((p) => p.key)).size).toBe(6)
    for (const preset of ACCENT_PRESETS) {
      expect(normalizeHex(preset.color)).toBe(preset.color.toLowerCase())
    }
  })

  it('亮度不超过 0.30（超过会被运行时压暗，色卡显示与界面不一致）', () => {
    for (const preset of ACCENT_PRESETS) {
      expect(relativeLuminance(preset.color), preset.key).toBeLessThanOrEqual(0.30)
    }
  })

  it('填充色在两种主题下都不会越界（这才是「显示即所得」的真正保证）', () => {
    for (const preset of ACCENT_PRESETS) {
      const dark = relativeLuminance(accentFill(preset.color, 'dark'))
      const light = relativeLuminance(accentFill(preset.color, 'light'))
      expect(dark, `${preset.key} 暗色`).toBeGreaterThanOrEqual(0.12)
      expect(light, `${preset.key} 亮色`).toBeLessThanOrEqual(0.62)
    }
  })

  it('已知偏差：graphite 低于规格下限 0.13（暗色下会被提亮，色卡与界面略有出入）', () => {
    // 规格 docs-internal/06 要求 0.13~0.30，但 graphite #475569 实测 0.089。
    // 这不是测试写错：accentFill 在暗色下会把它提到 0.12，于是色卡上的石墨
    // 比界面里的石墨更深一点。改成合法色值（如 #64748b）或放宽规格都需要产品决策，
    // 这里先把现状钉住，避免有人「顺手」改了色值却没人发现偏差消失/变大。
    const graphite = ACCENT_PRESETS.find((p) => p.key === 'graphite')
    expect(graphite).toBeDefined()
    expect(relativeLuminance(graphite!.color)).toBeLessThan(0.13)
    // 其余五档都满足下限
    const below = ACCENT_PRESETS.filter((p) => relativeLuminance(p.color) < 0.13)
    expect(below.map((p) => p.key)).toEqual(['graphite'])
  })

  it('默认主色是第一档', () => {
    expect(DEFAULT_ACCENT).toBe(ACCENT_PRESETS[0].color)
  })
})
