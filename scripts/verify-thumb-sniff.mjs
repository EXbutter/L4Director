/**
 * 校验前端 utils/thumbnailImage.ts 里的 sniffAnimated() 在真实玩家图片上的判定结果。
 *
 * 用法：node scripts/verify-thumb-sniff.mjs ["addons 目录"]
 *
 * 只读取每个文件头部 256 字节（不会因为 28MB 的 GIF 而爆内存）。
 */
import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const ROOT = process.argv[2] || 'D:\\SteamLibrary\\steamapps\\common\\Left 4 Dead 2\\left4dead2\\addons';

/** 与 frontend/src/renderer/utils/thumbnailImage.ts 中的实现保持一致 */
function sniffAnimated(head, mimeType = '') {
  const text = String.fromCharCode(...head);
  if (mimeType === 'image/gif') return true;
  if (text.startsWith('GIF8')) return true;                       // GIF87a / GIF89a
  if (text.startsWith('\x89PNG')) return text.includes('acTL');   // APNG
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') {
    return text.includes('ANIM');                                 // 动图 WebP
  }
  return false;
}

const EXT = /\.(jpg|jpeg|png|webp|bmp|gif)$/i;

/** 解析图片真实尺寸（只读头部，不依赖任何库） */
function readSize(buf, ext) {
  const text = String.fromCharCode(...buf.slice(0, 64));
  try {
    if (text.startsWith('GIF8')) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (text.startsWith('\x89PNG')) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (text.startsWith('BM')) return { w: buf.readUInt32LE(18), h: buf.readUInt32LE(22) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        let marker = buf[off + 1];
        // 跳过 marker 前可能出现的 0xFF 填充字节
        while (marker === 0xff && off + 2 < buf.length) { off++; marker = buf[off + 1]; }
        // 无长度字段的 marker
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          off += 2;
          continue;
        }
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        if (len <= 0) break;
        off += 2 + len;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXT.test(entry.name)) out.push(full);
  }
  return out;
}

const MAX_W = 640;
const MAX_H = 320;
/** 与前端 SIZE_TOLERANCE 保持一致：超过上限 2 倍才降采样 */
const SIZE_TOLERANCE = 2;

const files = walk(ROOT);
let animated = [];
let oversized = [];
let passthrough = 0;

for (const file of files) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(65536);
  const read = readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  const head = buf.subarray(0, Math.min(256, read));
  const size = readSize(buf.subarray(0, read), extname(file));

  const isAnimated = sniffAnimated(head, '');
  const big = size
    ? (size.w > MAX_W * SIZE_TOLERANCE || size.h > MAX_H * SIZE_TOLERANCE)
    : false;

  if (isAnimated) animated.push({ file, size });
  else if (big) oversized.push({ file, size });
  else passthrough++;

  if ((isAnimated || big) && size) {
    console.log(
      `${isAnimated ? '[动图]' : '[大图]'} ${basename(file)} ${size.w}x${size.h} ` +
      `${(statSync(file).size / 1024).toFixed(1)}KB -> 转码为静态小图`,
    );
  }
}

console.log('---------------------------------------------');
console.log(`扫描图片总数      : ${files.length}`);
console.log(`判定为动图(需冻结): ${animated.length}`);
console.log(`判定为超大图(需缩放): ${oversized.length}`);
console.log(`直接使用原图      : ${passthrough}`);
console.log(`合计需要转码      : ${animated.length + oversized.length}`);
