#!/usr/bin/env node
/**
 * 生成一份"裁剪过的 Electron 发行版"，供 electron-builder 通过 config.electronDist 使用。
 *
 * 为什么需要它：
 * electron-builder 的默认流程是把完整 Electron 发行版（54 个 locales）复制到输出目录，
 * 打包完再按 build.electronLanguages 逐个删掉不要的语言（ElectronFramework 的
 * removeUnusedLanguagesIfNeeded，一次 50+ 个 unlink）。在受管/沙箱环境里这种集中删除
 * 会触发批量删除保护，整个打包直接失败（SAFE_DELETE_BULK_CONFIRM_REJECTED）。
 *
 * 预裁剪之后，输出目录里本来就只有需要的那几个 .pak，electron-builder 无需删除任何文件。
 * 顺带省掉 37MB 的无效写入。
 *
 * 用硬链接实现（同一卷上零拷贝、不占额外空间）；跨卷或硬链接不可用时退回复制。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.join(here, '..', 'frontend');
const pkgPath = path.join(frontendDir, 'package.json');

const die = (msg) => {
  console.error(`[electron-dist] ${msg}`);
  process.exit(1);
};

if (!fs.existsSync(pkgPath)) die(`找不到 ${pkgPath}`);

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
// 和 electron-builder 保持一致的取值方式：平台配置优先，其次全局配置
const wantedLanguages = (
  pkg.build?.win?.electronLanguages
  || pkg.build?.electronLanguages
  || []
);
if (!wantedLanguages.length) die('package.json 里没有 build.electronLanguages，无需裁剪，直接跑 electron-builder 即可');

const electronDir = path.join(frontendDir, 'node_modules', 'electron');
const srcDir = path.join(electronDir, 'dist');
if (!fs.existsSync(srcDir)) die(`找不到 ${srcDir}，请先 npm install`);

const electronVersion = JSON.parse(
  fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8'),
).version;

// 固定目录名，npm script 里就能写成常量 --config.electronDist=.cache/electron-dist
const outDir = path.join(frontendDir, '.cache', 'electron-dist');

// 这两项 electron-builder 的默认流程会在解包后删掉（isFullCleanup 分支），
// 走自定义 electronDist 时不会删，所以干脆不复制
const skipFiles = new Set(['version', path.join('resources', 'default_app.asar')]);

let linked = 0;
let copied = 0;
let skippedLocales = 0;

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

/** 硬链接（同卷零开销），失败则复制 */
function place(src, dest) {
  ensureDir(path.dirname(dest));
  // 已存在就先删掉目标再重建，避免尺寸/内容过期
  try {
    fs.unlinkSync(dest);
  } catch {
    /* 不存在，忽略 */
  }
  try {
    fs.linkSync(src, dest);
    linked += 1;
  } catch {
    fs.copyFileSync(src, dest);
    copied += 1;
  }
}

function walk(rel) {
  const abs = path.join(srcDir, rel);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (childRel === 'locales') {
        ensureDir(path.join(outDir, 'locales'));
        for (const pak of fs.readdirSync(path.join(srcDir, 'locales'))) {
          if (!pak.endsWith('.pak')) continue;
          const lang = path.basename(pak, '.pak');
          if (!wantedLanguages.includes(lang)) {
            skippedLocales += 1;
            continue;
          }
          place(path.join(srcDir, 'locales', pak), path.join(outDir, 'locales', pak));
        }
        continue;
      }
      walk(childRel);
      continue;
    }
    if (skipFiles.has(childRel)) continue;
    place(path.join(srcDir, childRel), path.join(outDir, childRel));
  }
}

walk('');

// 记下这次裁剪依据，便于排查"为什么包里没有 xx 语言"
fs.writeFileSync(
  path.join(outDir, '.trimmed.json'),
  JSON.stringify({ electronVersion, wantedLanguages, skippedLocales }, null, 2),
  'utf8',
);

const relOut = path.relative(frontendDir, outDir).split(path.sep).join('/');
console.log(
  `[electron-dist] electron ${electronVersion} → ${relOut}`
  + `（保留 ${wantedLanguages.join('/')}，跳过 ${skippedLocales} 个语言包；`
  + `硬链接 ${linked}、复制 ${copied} 个文件）`,
);
