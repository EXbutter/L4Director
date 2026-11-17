/**
 * 生成标题栏字标 `BrandLogo.tsx`（把 "L4Director" 从字体轮廓转成 SVG path）。
 *
 * 用法（opentype.js 不常驻依赖，临时装一份就行）：
 *   npm i --prefix .tmp_preview/logo opentype.js
 *   NODE_PATH=.tmp_preview/logo/node_modules node scripts/gen_brand_logo.js \
 *       frontend/src/renderer/components/BrandLogo.tsx
 *
 * 产物是纯 path（不含 <text>），所以不受运行环境字体影响。
 *
 * 为什么要转：用户要求 logo 不用 <text>（字体渲染的字面留白不可控、不同机器字宽也不一样），
 * 要真正画出来的矢量字形。Roboto 是 Apache-2.0，字形可以自由用于标识。
 */
const fs = require('fs');
const opentype = require('opentype.js');

const FONT = 'C:/Windows/Fonts/Roboto-Regular.ttf';
const buf = fs.readFileSync(FONT);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const BASELINE = 26;

function seg(text, size, x, tracking) {
  let cur = x;
  const parts = [];
  for (const ch of text) {
    const p = font.getPath(ch, cur, BASELINE, size);
    parts.push(p.toPathData(2));
    cur += font.getAdvanceWidth(ch, size) + tracking;
  }
  return { d: parts.join(''), width: cur - x - tracking };
}

const main = seg('L4D', 27, 0, -0.7);
const gap = 4.2;
const sub = seg('irector', 16, main.width + gap, 0.15);

const full = new opentype.Path();
full.parse?.();
const d = main.d + sub.d;

// 用 path 自己的 bbox 定 viewBox（opentype 的 Path 支持 getBoundingBox）
const p = new opentype.Path();
// 重新用同一批指令构造，方便量 bbox
function collect(text, size, x, tracking) {
  let cur = x;
  for (const ch of text) {
    const g = font.getPath(ch, cur, BASELINE, size);
    p.extend(g);
    cur += font.getAdvanceWidth(ch, size) + tracking;
  }
}
collect('L4D', 27, 0, -0.7);
collect('irector', 16, main.width + gap, 0.15);

const bb = p.getBoundingBox();
const pad = 0.6;
const vb = {
  x: +(bb.x1 - pad).toFixed(2),
  y: +(bb.y1 - pad).toFixed(2),
  w: +(bb.x2 - bb.x1 + pad * 2).toFixed(2),
  h: +(bb.y2 - bb.y1 + pad * 2).toFixed(2),
};

console.log('main width:', main.width.toFixed(2), '| sub width:', sub.width.toFixed(2), '| total:', (main.width + gap + sub.width).toFixed(2));
console.log('bbox:', JSON.stringify(bb));
console.log('viewBox:', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
console.log('d length:', d.length);

// 直接生成组件：path 手工复制容易出错，让脚本落盘更稳
const tsx = `/**
 * 标题栏字标：L4Director。
 *
 * 为什么是 path 而不是 <text>：两段文字用不同字号并排时，字体的字面留白
 * 会让「D」的右边和「i」的左边贴得过近（实测重叠），而且不同机器的字体
 * 度量还会让整宽漂移。转成 path 后，字形与间距（2.4 个单位）都是硬编码的，
 * 任何环境渲染都一模一样。
 *
 * 字形取自 Roboto-Regular（Apache-2.0，可自由用于标识）；「L4D」与「irector」
 * 分别按 26 / 16.5 的字号生成，共基线，所以看起来是一个词而不是两截。
 *
 * 这个文件由一次性脚本生成，不要手工改 path —— 要调字号/间距/字重，
 * 改 .tmp_preview/logo/gen.js 重新生成。
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}"
      role="img"
      aria-label="L4Director"
    >
      <path fill="currentColor" d="${d}" />
    </svg>
  );
}
`;

const outPath = process.argv[2];
if (outPath) {
  fs.writeFileSync(outPath, tsx, 'utf8');
  console.log('written:', outPath);
}

