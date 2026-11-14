"""串行跑 scripts/ 下所有 verify_*.py，并汇总成败。

每个脚本都是**独立子进程**：它们会在 import 后端模块之前重定向 HOME/USERPROFILE，
一旦共用进程就会互相污染（模块级的 _CACHE_DIR 只在 import 时求值一次）。

用法：
    python scripts/run_all_verify.py            # 跑全部
    python scripts/run_all_verify.py lru store  # 只跑文件名里含这些关键字的
    python scripts/run_all_verify.py -v         # 同时打印每个脚本的完整输出

退出码：全绿 0，有失败 1。
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
SKIP = {'run_all_verify.py'}


def discover(filters: list[str]) -> list[Path]:
    files = sorted(
        p for p in SCRIPTS_DIR.glob('verify_*.py')
        if p.name not in SKIP
    )
    if not filters:
        return files
    return [p for p in files if any(f.lower() in p.name.lower() for f in filters)]


def main() -> int:
    args = [a for a in sys.argv[1:] if a != '-v']
    verbose = '-v' in sys.argv[1:]

    targets = discover(args)
    if not targets:
        print('没有匹配到任何 verify_*.py')
        return 1

    print(f'共 {len(targets)} 个校验脚本，开始运行…\n')

    results: list[tuple[str, bool, float, str]] = []
    for path in targets:
        t0 = time.perf_counter()
        proc = subprocess.run(
            [sys.executable, str(path)],
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            cwd=str(SCRIPTS_DIR.parent),
        )
        elapsed = time.perf_counter() - t0
        output = (proc.stdout or '') + (proc.stderr or '')
        passed = proc.returncode == 0

        # 早期脚本用 [OK] / [信息]，新脚本用 [PASS] / [FAIL]，两种都算
        ok_lines = [
            ln for ln in output.splitlines()
            if ln.lstrip().startswith(('[PASS]', '[OK]', '[OK ]'))
        ]
        fails = [
            ln for ln in output.splitlines()
            if ln.lstrip().startswith(('[FAIL]', '[ERROR]'))
        ]
        total = len(ok_lines) + len(fails)

        mark = 'OK  ' if passed else 'FAIL'
        print(f'[{mark}] {path.name:<38} {total:>2} 项断言 {elapsed:6.2f}s')
        if not passed:
            for ln in fails:
                print(f'         {ln}')
            if not fails:
                tail = output.strip().splitlines()[-6:]
                for ln in tail:
                    print(f'         {ln}')
        if verbose:
            for ln in output.strip().splitlines():
                print(f'         | {ln}')

        results.append((path.name, passed, elapsed, output))

    ok_count = sum(1 for _n, p, _e, _o in results if p)
    total_time = sum(e for _n, _p, e, _o in results)
    print(f'\n{"=" * 64}')
    print(f'通过 {ok_count}/{len(results)}，总耗时 {total_time:.2f}s')

    if ok_count != len(results):
        print('\n失败清单：')
        for name, passed, _e, _o in results:
            if not passed:
                print(f'  - {name}')
        return 1

    print('全部通过。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
