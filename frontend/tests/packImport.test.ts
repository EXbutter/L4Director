/**
 * 整合包 ZIP 导入（`src/main/packImport.ts`）的纯 Node 单测。
 *
 * `packImport.ts` 不依赖 electron（只用到 fs / path / os + extract-zip + vpkImport），
 * 可以在 vitest 的 node 环境直接跑。这里用自带的极简 ZIP 构造器（store 不压缩）造出
 * 几种 ZIP，端到端验证：
 *   - 按 `_name_map.json` 把 `mod_1.vpk` 还原成原文件名并落进 addons；
 *   - 无 `_name_map.json` 时按条目自身文件名导入；
 *   - 同名同内容重复导入不产生第二份（duplicateSources）；
 *   - zip-slip（`../`）条目被拒绝；
 *   - 符号链接条目被拒绝；
 *   - 不存在 / 空的 ZIP 给出错误。
 *
 * 不修改业务代码：所有断言都针对 `importPackZip` 的可观察结果（返回体 + 真实落盘）。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import { importPackZip } from '../src/main/packImport'

// ── 极简 ZIP 构造（store 不压缩，够 yauzl 解析即可）─────────────────────────

interface ZipEntry {
  name: string
  data?: Buffer
  /** 标记成 unix 符号链接（external attr 的高 16 位） */
  symlink?: boolean
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const data = e.data ?? Buffer.alloc(0)
    const crc = crc32(data)
    const mode = e.symlink ? 0o120777 : 0o100644
    const external = ((mode << 16) >>> 0)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)       // version needed
    local.writeUInt16LE(0, 6)        // flags
    local.writeUInt16LE(0, 8)        // method = store
    local.writeUInt16LE(0, 10)       // time
    local.writeUInt16LE(0, 12)       // date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)     // version made by
    central.writeUInt16LE(20, 6)     // version needed
    central.writeUInt16LE(0, 8)      // flags
    central.writeUInt16LE(0, 10)     // method
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)     // disk number start
    central.writeUInt16LE(0, 36)     // internal attrs
    central.writeUInt32LE(external, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }

  const centralStart = offset
  const centralBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralBuf, eocd])
}

// ── 临时目录工具 ──────────────────────────────────────────────────────────

const tmpDirs: string[] = []

function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

function makeAddons(): string {
  const d = path.join(mkTmp('l4d2-addons-'), 'addons')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function writeZip(entries: ZipEntry[]): string {
  const p = path.join(mkTmp('l4d2-zipfile-'), 'pack.zip')
  fs.writeFileSync(p, buildZip(entries))
  return p
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ── 用例 ──────────────────────────────────────────────────────────────────

describe('importPackZip：正常导入', () => {
  it('按 _name_map.json 还原原文件名并落进 addons，members 为该 vpk 原名', async () => {
    const addons = makeAddons()
    const nameMap = {
      'mod_1.vpk': 'RealMod.vpk',
      'mod_1_thumb.jpg': 'RealMod.jpg',
    }
    const zip = writeZip([
      { name: '_name_map.json', data: Buffer.from(JSON.stringify(nameMap), 'utf8') },
      { name: 'mod_1.vpk', data: Buffer.from('fake-vpk-bytes-AAA') },
      { name: 'mod_1_thumb.jpg', data: Buffer.from('fake-jpg-bytes') },
    ])

    const result = await importPackZip(zip, addons)

    expect(result.ok).toBe(true)
    expect(result.members).toEqual(['RealMod.vpk'])
    expect(fs.existsSync(path.join(addons, 'RealMod.vpk'))).toBe(true)
    // 封面一起落盘
    expect(fs.existsSync(path.join(addons, 'RealMod.jpg'))).toBe(true)
    // 还原的是原名，不是归档里的 mod_1.vpk
    expect(fs.existsSync(path.join(addons, 'mod_1.vpk'))).toBe(false)
  })

  it('没有 _name_map.json 时按条目自身文件名导入', async () => {
    const addons = makeAddons()
    const zip = writeZip([
      { name: 'Plain.vpk', data: Buffer.from('plain-vpk-content') },
      { name: 'Plain.jpg', data: Buffer.from('plain-jpg') },
    ])

    const result = await importPackZip(zip, addons)

    expect(result.ok).toBe(true)
    expect(result.members).toEqual(['Plain.vpk'])
    expect(fs.existsSync(path.join(addons, 'Plain.vpk'))).toBe(true)
  })

  it('同名同内容重复导入不产生第二份（duplicateSources 记录已存在）', async () => {
    const addons = makeAddons()
    const zip = writeZip([
      { name: '_name_map.json', data: Buffer.from(JSON.stringify({ 'mod_1.vpk': 'Dup.vpk' })) },
      { name: 'mod_1.vpk', data: Buffer.from('same-content-123') },
    ])

    const first = await importPackZip(zip, addons)
    expect(first.ok).toBe(true)
    expect(fs.readdirSync(addons).filter((f) => f === 'Dup.vpk').length).toBe(1)

    const second = await importPackZip(zip, addons)
    expect(second.ok).toBe(true)
    // 仍然只有一份
    expect(fs.readdirSync(addons).filter((f) => f === 'Dup.vpk').length).toBe(1)
    // 且被识别为重复来源
    expect((second.importResult?.duplicateSources || []).length).toBeGreaterThanOrEqual(1)
    // 成员仍能指向已存在的同名文件
    expect(second.members).toEqual(['Dup.vpk'])
  })
})

describe('importPackZip：安全拒绝', () => {
  it('zip-slip（../ 父目录穿越）条目被拒绝，且不在临时目录外落文件', async () => {
    const addons = makeAddons()
    const zip = writeZip([
      { name: '../evil.vpk', data: Buffer.from('evil') },
    ])

    const result = await importPackZip(zip, addons)

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    // 没有把东西写进 addons
    expect(fs.readdirSync(addons)).toEqual([])
  })

  it('符号链接条目被拒绝', async () => {
    const addons = makeAddons()
    const zip = writeZip([
      { name: 'link.vpk', data: Buffer.from('C:/Windows/system32'), symlink: true },
    ])

    const result = await importPackZip(zip, addons)

    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('符号链接')
    expect(fs.readdirSync(addons)).toEqual([])
  })

  it('不存在的 ZIP 文件 → ok=false 且给出错误', async () => {
    const addons = makeAddons()
    const result = await importPackZip(path.join(mkTmp('l4d2-nope-'), 'missing.zip'), addons)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('addons 目录无效 → ok=false', async () => {
    const zip = writeZip([{ name: 'x.vpk', data: Buffer.from('x') }])
    const result = await importPackZip(zip, path.join(mkTmp('l4d2-badaddons-'), 'no-such-addons'))
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('ZIP 里没有任何 .vpk / 封面 → ok=false', async () => {
    const addons = makeAddons()
    const zip = writeZip([{ name: 'readme.txt', data: Buffer.from('hello') }])
    const result = await importPackZip(zip, addons)
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('没有可导入')
  })
})
