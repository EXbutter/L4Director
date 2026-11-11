#!/usr/bin/env node
/**
 * L4Director 启动速度基准测试（反复启动应用、统计各里程碑耗时）。
 *
 * 原理
 * ----
 * 主进程会把启动里程碑写入 `startup-perf.json`（默认在 userData 目录）：
 *   app-ready / window-created / backend-spawned / backend-ready / window-shown
 *   renderer-loaded / renderer-ready(首屏) / first-mod(首个 Mod 出现) / scan-done(列表加载完成)
 * 本脚本通过 L4DIRECTOR_PERF_OUT 指定输出文件，反复启动应用并读取该文件，
 * 最后输出 min / 中位数 / 均值 / P95 / 最大值。
 *
 * 用法
 * ----
 *   node scripts/bench-startup.mjs                          # 默认跑已打包的免安装版 3 次
 *   node scripts/bench-startup.mjs --runs 5
 *   node scripts/bench-startup.mjs --exe "G:/path/L4Director.exe"
 *   node scripts/bench-startup.mjs --shell-only             # 只测到「首屏渲染完成」即退出
 *   node scripts/bench-startup.mjs --dev                    # 开发模式（需先起 Vite + 构建主进程）
 *   node scripts/bench-startup.mjs --out bench.json --compare bench.json
 *
 * 注意：默认使用**用户真实的配置**（这样才会真的扫描真实 Mod 库），
 * 只有性能数据文件被重定向到临时目录，不会污染用户配置。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');

const MILESTONES = [
  ['app-ready', 'Electron 就绪'],
  ['window-created', '创建窗口'],
  ['backend-spawned', '后端已启动'],
  ['backend-ready', '后端可用'],
  ['window-shown', '窗口显示'],
  ['renderer-loaded', '页面加载完成'],
  ['renderer-ready', '前端首屏完成'],
  ['first-mod', '首个 Mod 出现'],
  ['scan-done', '列表加载完成'],
];

function parseArgs(argv) {
  const args = {
    runs: 3,
    timeout: 120000,
    exe: null,
    dev: false,
    shellOnly: false,
    out: path.join(__dirname, 'bench_baseline_startup.json'),
    compare: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') args.runs = Number(argv[++i]);
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--exe') args.exe = argv[++i];
    else if (a === '--dev') args.dev = true;
    else if (a === '--shell-only') args.shellOnly = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--compare') args.compare = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('用法见 scripts/bench-startup.mjs 顶部注释');
      process.exit(0);
    }
  }
  return args;
}

function fail(message) {
  console.error(`\n[错误] ${message}\n`);
  process.exit(2);
}

function resolveTarget(args) {
  if (args.dev) {
    // 开发模式：需要已构建的主进程代码（npm run build:main）+ Vite（npm run dev:renderer）
    const electronEntry = path.join(FRONTEND_DIR, 'dist', 'main', 'main.js');
    if (!existsSync(electronEntry)) {
      fail('未找到 frontend/dist/main/main.js，请先执行: cd frontend && npm run build:main');
    }
    // 注意：必须直接调用 electron.exe（node_modules/electron/path.txt 指向它）。
    // 用 shell:true 调 electron.cmd 时，Node 不会给含空格的路径加引号，
    // 命令会被 cmd 截断（本项目路径带空格），导致子进程瞬间退出。
    const pathTxt = path.join(FRONTEND_DIR, 'node_modules', 'electron', 'path.txt');
    const binName = existsSync(pathTxt) ? readFileSync(pathTxt, 'utf-8').trim() : 'electron.exe';
    // path.txt 里是相对 dist/ 的文件名（如 electron.exe）
    const electronBin = path.join(FRONTEND_DIR, 'node_modules', 'electron', 'dist', binName);
    if (!existsSync(electronBin)) {
      fail(`未找到 Electron 可执行文件: ${electronBin}（请先执行 npm install）`);
    }
    return { command: electronBin, args: ['.'], cwd: FRONTEND_DIR, shell: false };
  }
  const exe = args.exe || path.join(FRONTEND_DIR, 'release', 'win-unpacked', 'L4Director.exe');
  if (!existsSync(exe)) {
    fail(
      `未找到可执行文件: ${exe}\n` +
        '请先打包（cd frontend && npm run pack），或用 --exe 指定路径，或使用 --dev。'
    );
  }
  return { command: exe, args: [], cwd: path.dirname(exe), shell: false };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pick = (q) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return {
    min: sorted[0],
    median: pick(0.5),
    mean: Math.round(sum / sorted.length),
    p95: pick(0.95),
    max: sorted[sorted.length - 1],
  };
}

function runOnce(target, perfFile, benchQuitOn, timeout) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      L4DIRECTOR_PERF_OUT: perfFile,
      L4DIRECTOR_BENCH_AUTOQUIT: '600',
      L4DIRECTOR_BENCH_QUIT_ON: benchQuitOn,
    };
    const child = spawn(target.command, target.args, {
      cwd: target.cwd,
      env,
      shell: target.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const started = Date.now();
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      resolve({ ok: false, reason: `超时 ${timeout} ms`, output });
    }, timeout);

    child.stdout.on('data', (d) => {
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, elapsedMs: Date.now() - started, output });
    });
  });
}

function readLatestPerf(perfFile) {
  if (!existsSync(perfFile)) return null;
  try {
    return JSON.parse(readFileSync(perfFile, 'utf-8')).last ?? null;
  } catch {
    return null;
  }
}

function collectRows(runs) {
  const rows = [];
  for (const [key, label] of MILESTONES) {
    const values = [];
    for (const run of runs) {
      let ms = run.milestones_ms?.[key];
      if (ms === undefined) ms = run.renderer?.[key]?.since_process_start_ms;
      if (typeof ms === 'number') values.push(ms);
    }
    if (values.length) rows.push({ key, label, ...stats(values), samples: values.length });
  }
  return rows;
}

function printRows(rows, runCount) {
  console.log('\n' + '='.repeat(78));
  console.log(` 启动耗时统计（毫秒，距进程启动；${runCount} 次有效运行）`);
  console.log('='.repeat(78));
  console.log(
    `${'里程碑'.padEnd(14)} ${'最小'.padStart(8)} ${'中位'.padStart(8)} ` +
      `${'均值'.padStart(8)} ${'P95'.padStart(8)} ${'最大'.padStart(8)}  样本`
  );
  console.log('-'.repeat(78));
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(14)} ${String(r.min).padStart(8)} ${String(r.median).padStart(8)} ` +
        `${String(r.mean).padStart(8)} ${String(r.p95).padStart(8)} ${String(r.max).padStart(8)}  ${r.samples}`
    );
  }
  console.log('='.repeat(78));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Windows 控制台默认 GBK，Node 只输出 UTF-8 → 中文会变乱码；先切到 UTF-8
  if (process.platform === 'win32' && process.stdout.isTTY) {
    try {
      spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore' });
    } catch {}
  }

  const target = resolveTarget(args);
  const perfFile = path.join(
    mkdtempSync(path.join(tmpdir(), 'l4d2-bench-startup-')),
    'startup-perf.json'
  );
  const benchQuitOn = args.shellOnly ? 'shell' : 'scan';

  console.log('='.repeat(78));
  console.log(' L4Director 启动速度基准');
  console.log('='.repeat(78));
  console.log(`  目标     : ${target.command} ${target.args.join(' ')}`.trim());
  console.log(
    `  模式     : ${args.dev ? '开发模式' : '打包版'} / ${args.shellOnly ? '仅测到首屏' : '测到列表加载完成'}`
  );
  console.log(`  次数     : ${args.runs}（第 1 次为冷启动，其余为热启动）`);
  console.log(`  单次超时 : ${args.timeout} ms`);
  console.log(`  性能文件 : ${perfFile}`);
  console.log('='.repeat(78));

  const runs = [];
  for (let i = 1; i <= args.runs; i++) {
    try {
      rmSync(perfFile, { force: true });
    } catch {}
    process.stdout.write(`\n[第 ${i}/${args.runs} 次] 启动中... `);
    const result = await runOnce(target, perfFile, benchQuitOn, args.timeout);
    const perf = readLatestPerf(perfFile);
    if (!result.ok || !perf) {
      console.log('失败');
      console.log(result.reason || '未能读取 startup-perf.json');
      const perfLines = (result.output || '')
        .split('\n')
        .filter((l) => l.includes('[Perf]') || l.includes('[Backend]'))
        .slice(-8);
      if (perfLines.length) console.log(perfLines.join('\n'));
      continue;
    }
    console.log(`完成（进程存活 ${result.elapsedMs} ms）`);
    if ((result.output || '').includes('already running on 8288')) {
      console.log(
        '提示：检测到复用了已有后端进程，backend-ready 数字会失真（请先结束残留的 python.exe 再测）。'
      );
    }
    runs.push(perf);
  }

  if (runs.length === 0) {
    console.log('\n没有采集到任何有效数据。');
    rmSync(path.dirname(perfFile), { recursive: true, force: true });
    process.exit(1);
  }

  const rows = collectRows(runs);
  printRows(rows, runs.length);

  const payload = {
    tool: 'scripts/bench-startup.mjs',
    generated_at: new Date().toISOString(),
    mode: args.dev ? 'dev' : 'packaged',
    shell_only: args.shellOnly,
    runs: runs.length,
    app_version: runs[runs.length - 1]?.app_version ?? null,
    stats: Object.fromEntries(
      rows.map((r) => [
        r.key,
        { min: r.min, median: r.median, mean: r.mean, p95: r.p95, max: r.max, samples: r.samples },
      ])
    ),
    raw: runs.map((r) => ({ milestones_ms: r.milestones_ms, renderer: r.renderer })),
  };

  if (args.compare && existsSync(args.compare)) {
    const base = JSON.parse(readFileSync(args.compare, 'utf-8'));
    console.log(
      `\n=== 与基线对比（${path.basename(args.compare)}，生成于 ${base.generated_at}）===`
    );
    const currentMode = args.dev ? 'dev' : 'packaged';
    if (base.mode && base.mode !== currentMode) {
      console.log(`提示：基线是 ${base.mode} 模式，本次是 ${currentMode} 模式，对比仅供参考。`);
    }
    for (const r of rows) {
      const old = base.stats?.[r.key];
      if (!old?.median) continue;
      const delta = ((r.median - old.median) / old.median) * 100;
      const deltaAbs = r.median - old.median;
      // 相对 + 绝对双阈值：几十毫秒的抖动不值得报警
      const flag = delta > 10 && deltaAbs > 50 ? '[变慢]' : delta < -10 && deltaAbs < -50 ? '[变快]' : '[持平]';
      console.log(
        `${r.label.padEnd(14)} 中位 ${String(old.median).padStart(8)} ms -> ` +
          `${String(r.median).padStart(8)} ms  ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ` +
          `(${deltaAbs >= 0 ? '+' : ''}${deltaAbs} ms)  ${flag}`
      );
    }
  } else {
    const outPath =
      args.out ||
      path.join(
        __dirname,
        args.shellOnly ? 'bench_baseline_startup_shell.json' : 'bench_baseline_startup.json'
      );
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`\n基线已写入: ${outPath}`);
    console.log('（下次可用 --compare 与该基线对比，判断启动速度是否回归）');
  }

  rmSync(path.dirname(perfFile), { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
