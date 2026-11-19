/**
 * 「禁用动图」偏好：三种优先级 + 订阅通知。
 *
 * 语义是「是否允许播放」：用户显式关掉 → 永远不播；系统开了「减少动态效果」
 * → 默认不播但用户显式打开仍要能播（无障碍设置是默认值，不是强锁）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'l4d2-card-animation'

function setupEnv(opts: { stored?: string | null; reduced?: boolean } = {}) {
  const store = new Map<string, string>()
  if (opts.stored != null) store.set(STORAGE_KEY, opts.stored)

  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
  })
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({ matches: !!opts.reduced, media: query }),
  })
  return store
}

async function loadModule() {
  vi.resetModules()
  return import('../src/renderer/utils/animationPreference')
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('默认值', () => {
  it('没有偏好记录时默认播放', async () => {
    setupEnv()
    const mod = await loadModule()
    expect(mod.cardAnimationEnabled()).toBe(true)
  })

  it('系统开启「减少动态效果」时默认不播', async () => {
    setupEnv({ reduced: true })
    const mod = await loadModule()
    expect(mod.cardAnimationEnabled()).toBe(false)
    expect(mod.systemReducedMotion()).toBe(true)
  })

  it('用户显式关掉后即使系统允许也不播', async () => {
    setupEnv({ stored: 'off' })
    const mod = await loadModule()
    expect(mod.cardAnimationEnabled()).toBe(false)
  })

  it('系统减少动态效果但用户显式打开 → 照播（用户选择优先）', async () => {
    setupEnv({ stored: 'on', reduced: true })
    const mod = await loadModule()
    expect(mod.cardAnimationEnabled()).toBe(true)
  })
})

describe('切换与订阅', () => {
  it('切换会写回 localStorage 并通知订阅者', async () => {
    const store = setupEnv()
    const mod = await loadModule()

    const seen: boolean[] = []
    const unsubscribe = mod.subscribeCardAnimation((v) => seen.push(v))

    mod.setCardAnimationEnabled(false)
    expect(mod.cardAnimationEnabled()).toBe(false)
    expect(store.get(STORAGE_KEY)).toBe('off')
    expect(seen).toEqual([false])

    mod.setCardAnimationEnabled(true)
    expect(store.get(STORAGE_KEY)).toBe('on')
    expect(seen).toEqual([false, true])

    unsubscribe()
    mod.setCardAnimationEnabled(false)
    expect(seen).toEqual([false, true])   // 退订后不再收到
  })

  it('localStorage 不可用（隐私模式）时只在本次会话生效，不抛错', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    const mod = await loadModule()

    expect(mod.cardAnimationEnabled()).toBe(true)
    expect(() => mod.setCardAnimationEnabled(false)).not.toThrow()
    expect(mod.cardAnimationEnabled()).toBe(false)
  })
})
