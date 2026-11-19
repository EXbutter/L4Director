/**
 * 窗口初始尺寸规则（纯函数）。
 *
 * 真实约束来自布局实测：网格宽 = 窗口宽 - 246，卡最小 230、间距 14，
 * 所以「每行几张卡」是可算的，窗口尺寸不该拍脑袋。
 */
import { describe, expect, it } from 'vitest'

import {
  MAX_WINDOW_HEIGHT,
  MAX_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  computeInitialWindow,
  defaultWindowFor,
  restoreWindowInto,
  type WorkArea,
} from '../src/main/windowBounds'

/** 各类屏幕的工作区（DIP，已扣掉任务栏） */
const SCREENS = {
  '2k': { x: 0, y: 0, width: 2560, height: 1392 },
  '1080p': { x: 0, y: 0, width: 1920, height: 1040 },
  '1080p@125%': { x: 0, y: 0, width: 1536, height: 816 },
  '1080p@150%': { x: 0, y: 0, width: 1280, height: 680 },
  '1366x768': { x: 0, y: 0, width: 1366, height: 728 },
} satisfies Record<string, WorkArea>

const area = (k: keyof typeof SCREENS) => SCREENS[k]

describe('首启尺寸按屏幕分配', () => {
  it('2K 上给 1680×1000（比旧默认 1440×900 多一列卡）', () => {
    const w = defaultWindowFor(area('2k'))
    expect(w.width).toBe(MAX_WINDOW_WIDTH)
    expect(w.height).toBe(MAX_WINDOW_HEIGHT)
  })

  it('1080p 上不倒退：仍是 1440×894（≈旧的 1440×900）', () => {
    const w = defaultWindowFor(area('1080p'))
    expect(w.width).toBe(1440)
    expect(w.height).toBeGreaterThanOrEqual(890)
    expect(w.height).toBeLessThanOrEqual(900)
  })

  it('缩放屏不超出工作区（这是写死 1440×900 最容易翻车的地方）', () => {
    for (const key of ['1080p@125%', '1080p@150%', '1366x768'] as const) {
      const a = area(key)
      const w = defaultWindowFor(a)
      expect(w.width, key).toBeLessThanOrEqual(a.width)
      expect(w.height, key).toBeLessThanOrEqual(a.height)
      expect(w.x, key).toBeGreaterThanOrEqual(a.x)
      expect(w.y, key).toBeGreaterThanOrEqual(a.y)
      expect(w.x + w.width, key).toBeLessThanOrEqual(a.x + a.width)
      expect(w.y + w.height, key).toBeLessThanOrEqual(a.y + a.height)
    }
  })

  it('窗口居中', () => {
    const w = defaultWindowFor(area('2k'))
    expect(w.x).toBe(Math.round((2560 - w.width) / 2))
    expect(w.maximized).toBe(false)
  })

  it('尺寸不低于可用下限（除非屏幕比下限还小）', () => {
    const w = defaultWindowFor(area('2k'))
    expect(w.width).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH)
    expect(w.height).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT)
  })
})

describe('恢复上次窗口', () => {
  it('存档在屏幕内时原样恢复，并带回最大化状态', () => {
    const got = computeInitialWindow([area('2k')], {
      x: 100, y: 80, width: 1600, height: 950, maximized: true,
    })
    expect(got).toMatchObject({ x: 100, y: 80, width: 1600, height: 950, maximized: true })
  })

  it('存档比工作区大时夹回工作区（换小屏后不该出现跑出屏幕的窗口）', () => {
    const got = computeInitialWindow([area('1080p')], { x: 0, y: 0, width: 1680, height: 1000 })
    expect(got.width).toBeLessThanOrEqual(1680)
    expect(got.height).toBeLessThanOrEqual(1000)
    expect(got.x + got.width).toBeLessThanOrEqual(1920)
  })

  it('存档在已拔掉的副屏上时回到主屏，尺寸不丢', () => {
    const got = computeInitialWindow([area('2k')], { x: 4000, y: 200, width: 1500, height: 900 })
    expect(got.width).toBe(1500)
    expect(got.height).toBe(900)
    expect(got.x).toBeGreaterThanOrEqual(0)
    expect(got.x + got.width).toBeLessThanOrEqual(2560)
  })

  it('副屏仍在且窗口完整可见时，位置原样保留', () => {
    const second: WorkArea = { x: 2560, y: 0, width: 1920, height: 1040 }
    const got = computeInitialWindow([area('2k'), second], {
      x: 3000, y: 100, width: 1400, height: 900,   // 3000+1400 = 4400 ≤ 4480
    })
    expect(got.x).toBe(3000)          // 保留在副屏上的位置
    expect(got.y).toBe(100)
  })

  it('副屏上稍微超出边界时，仍留在这块屏（居中）而不是跳回主屏', () => {
    const second: WorkArea = { x: 2560, y: 0, width: 1920, height: 1040 }
    const got = computeInitialWindow([area('2k'), second], {
      x: 3000, y: 100, width: 1500, height: 900,   // 3000+1500 = 4500 > 4480
    })
    expect(got.width).toBe(1500)
    expect(got.x).toBe(2770)          // 2560 + (1920-1500)/2
  })

  it('存档损坏/不完整时退回首启策略', () => {
    expect(computeInitialWindow([area('2k')], null).width).toBe(MAX_WINDOW_WIDTH)
    expect(computeInitialWindow([area('2k')], { width: 0, height: 0 }).width).toBe(MAX_WINDOW_WIDTH)
    expect(
      computeInitialWindow([area('2k')], { width: Number.NaN, height: 900 }).width,
    ).toBe(MAX_WINDOW_WIDTH)
  })

  it('没有显示器信息时给一个安全兜底', () => {
    expect(computeInitialWindow([], null)).toMatchObject({ width: 1440, height: 900 })
  })
})

describe('restoreWindowInto', () => {
  it('过小的存档会被抬到最小可用尺寸（否则界面挤成一列）', () => {
    const got = restoreWindowInto(area('2k'), { x: 10, y: 10, width: 600, height: 400 })
    expect(got.width).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH)
    expect(got.height).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT)
  })
})
