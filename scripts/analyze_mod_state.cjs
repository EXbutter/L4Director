// 分析 L4Director 导出的 mods_snapshot.json 与真实 addonlist.txt 的差异
const fs = require('fs');
const path = require('path');

const logDir = process.argv[2];
const addonlistPath = process.argv[3];

const snapshot = JSON.parse(fs.readFileSync(path.join(logDir, 'mods_snapshot.json'), 'utf8'));

// 解析 addonlist.txt（UTF-8 + surrogateescape 语义：这里按 latin1 读字节再转）
const rawBuf = fs.readFileSync(addonlistPath);
const text = rawBuf.toString('utf8');
const entries = new Map();
for (const line of text.split(/\r?\n/)) {
  const m = line.trim().match(/^"([^"]+)"\s+"(\d+)"/);
  if (m) entries.set(m[1].replace(/\//g, '\\'), m[2] === '1');
}

const norm = (n) => String(n || '').trim().replace(/\\/g, '/').split('/').pop().replace(/^mod-/i, '').replace(/\.vpk$/i, '').toLowerCase();

console.log('=== 快照总览 ===');
console.log('mod 总数            :', snapshot.length);
const enabledTrue = snapshot.filter((m) => m.enabled === true).length;
const enabledFalse = snapshot.filter((m) => m.enabled === false).length;
console.log('enabled=true        :', enabledTrue);
console.log('enabled=false       :', enabledFalse);
console.log('workshop 数量       :', snapshot.filter((m) => m.is_workshop).length);
console.log('本地 mod 数量       :', snapshot.filter((m) => !m.is_workshop).length);
console.log('addonlist.txt 条目  :', entries.size);

const entryByName = new Map();
for (const [k, v] of entries) entryByName.set(norm(k), { key: k, value: v });

console.log('\n=== 本地(mod) 在 addonlist.txt 中【没有条目】的情况 ===');
const localMods = snapshot.filter((m) => !m.is_workshop);
let missing = 0;
for (const mod of localMods) {
  if (!entryByName.has(norm(mod.name))) {
    missing++;
    if (missing <= 15) console.log(`  ${mod.name}  (enabled=${mod.enabled})`);
  }
}
console.log(`  ... 共 ${missing} / ${localMods.length} 个本地 mod 在 addonlist.txt 里没有条目`);

console.log('\n=== 本地 mod 在 addonlist.txt 中【有条目但值为 0(禁用)】的情况 ===');
for (const mod of localMods) {
  const hit = entryByName.get(norm(mod.name));
  if (hit && hit.value === false) {
    console.log(`  ${mod.name}  addonlist="${hit.key}"=0  界面显示 enabled=${mod.enabled}`);
  }
}

console.log('\n=== workshop mod 有条目但值为 0 的 ===');
let wsDisabled = 0;
for (const mod of snapshot.filter((m) => m.is_workshop)) {
  const hit = entryByName.get(norm(mod.name));
  if (hit && hit.value === false) {
    wsDisabled++;
    console.log(`  ${mod.name}  addonlist="${hit.key}"=0  界面显示 enabled=${mod.enabled}`);
  }
}
if (!wsDisabled) console.log('  （无）');

console.log('\n=== addonlist.txt 里有、但快照里找不到对应文件的条目 ===');
const snapshotNames = new Set(snapshot.map((m) => norm(m.name)));
for (const [k, v] of entries) {
  if (!snapshotNames.has(norm(k))) console.log(`  ${k} = ${v ? 1 : 0}`);
}

console.log('\n=== addonlist.txt 原始字节是否含非 UTF-8 序列 ===');
const decoded = rawBuf.toString('utf8');
const lossy = Buffer.from(decoded, 'utf8').equals(rawBuf);
console.log('  纯 UTF-8 :', lossy);
if (!lossy) {
  for (let i = 0; i < rawBuf.length; i++) {
    if (rawBuf[i] >= 0x80 && !(rawBuf[i] >= 0xc0)) {
      console.log(`  首个可疑字节 offset=${i}: 0x${rawBuf[i].toString(16)}`);
      const around = rawBuf.subarray(Math.max(0, i - 40), i + 40);
      console.log('    上下文:', JSON.stringify(around.toString('latin1')));
      break;
    }
  }
}

// 名字含 glob 特殊字符的 mod：旧实现用 glob(f'*{name}*') 找文件时，
// `[ ]` 会被当成字符类，导致切换/分类/删除/导出全部失效。
console.log('\n=== 名字含 glob 特殊字符([ ] ? *)的 mod（旧实现会失效）===');
const globSpecial = /[[\]?*]/;
const riskyMods = snapshot.filter((m) => globSpecial.test(m.name));
for (const m of riskyMods) {
  console.log(`  enabled=${m.enabled ? 'true ' : 'false'}  ${m.name}`);
}
console.log(`  共 ${riskyMods.length} / ${snapshot.length} 个`);

const disabledRisky = snapshot.filter((m) => globSpecial.test(m.name) && m.enabled === false);
console.log(`  其中处于「禁用」状态的有 ${disabledRisky.length} 个 —— ` +
  '这些正是用户在软件里点「启用」却没反应的 mod');

