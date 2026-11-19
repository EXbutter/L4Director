/**
 * 缩略图嗅探：扩展名与后端 Content-Type 都不可信。
 *
 * 真实场景：工坊封面统一落成 `<id>.jpg`，里面可能是 GIF / PNG / WebP。
 * 判错 MIME → createImageBitmap 选错解码器 → 卡片静默回退成静态图。
 */
import { describe, expect, it } from 'vitest'

import { THUMB_MAX_HEIGHT, THUMB_MAX_WIDTH, sniffAnimated, sniffMime } from '../src/renderer/utils/thumbnailImage'

const bytes = (text: string, pad = 32) => {
  const head = new Uint8Array(pad)
  for (let i = 0; i < text.length && i < pad; i += 1) head[i] = text.charCodeAt(i)
  return head
}

const asciiBytes = (...parts: number[]) => Uint8Array.from(parts)

describe('sniffMime', () => {
  it('按文件头识别常见格式', () => {
    expect(sniffMime(bytes('GIF89a'), 'image/jpeg')).toBe('image/gif')
    expect(sniffMime(asciiBytes(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0), 'image/jpeg')).toBe('image/png')
    expect(sniffMime(bytes('RIFF\0\0\0\0WEBP'), 'image/jpeg')).toBe('image/webp')
    expect(sniffMime(bytes('BM'), 'image/jpeg')).toBe('image/bmp')
    expect(sniffMime(asciiBytes(0xff, 0xd8, 0xff, 0xe0), 'image/png')).toBe('image/jpeg')
  })

  it('认不出来时用后端给的 Content-Type', () => {
    expect(sniffMime(bytes('????'), 'image/avif')).toBe('image/avif')
  })

  it('两边都没有时给一个安全默认值', () => {
    expect(sniffMime(bytes('????'), '')).toBe('application/octet-stream')
  })
})

describe('sniffAnimated', () => {
  it('GIF 一律按动图处理（格式本身就可能多帧）', () => {
    expect(sniffAnimated(bytes('GIF89a'), 'image/gif')).toBe(true)
  })

  it('PNG 看 acTL（APNG）', () => {
    expect(sniffAnimated(bytes('....acTL....'), 'image/png')).toBe(true)
    expect(sniffAnimated(bytes('....IDAT....'), 'image/png')).toBe(false)
  })

  it('WebP 看 ANIM 块', () => {
    expect(sniffAnimated(bytes('....ANIM....'), 'image/webp')).toBe(true)
    expect(sniffAnimated(bytes('....VP8 ....'), 'image/webp')).toBe(false)
  })

  it('其它格式不猜动图', () => {
    expect(sniffAnimated(bytes('acTL'), 'image/jpeg')).toBe(false)
    expect(sniffAnimated(bytes('acTL'), 'image/bmp')).toBe(false)
  })
})

describe('缩略图尺寸常量', () => {
  it('上限是卡片实际需要的两倍（Retina），别随手放大', () => {
    expect(THUMB_MAX_WIDTH).toBe(640)
    expect(THUMB_MAX_HEIGHT).toBe(320)
  })
})
