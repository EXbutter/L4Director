#!/usr/bin/env python3
"""L4Director 扫描压力测试（加载速度 / 吞吐 / 内存）。

用途
----
生成 50 / 200 / 500 / 1000 个「合成 VPK」作为 Mod 库，测量四种真实场景的耗时：

  1. cold        首次扫描（进程内 + 磁盘缓存全空）—— 新装软件/换 Mod 目录后的最坏情况
  2. warm-mem    同一进程内再次扫描（内容未变化，命中 scan_key）—— 切页/刷新
  3. warm-disk   模拟「重启软件、磁盘缓存仍在」—— 日常启动最常见的情况
  4. stream-cold 清空全部缓存后用流式接口（/api/mods/stream）—— 首屏「看到第一个 Mod」要多久

同时记录吞吐（mods/s）与进程内存（当前工作集增量 + 峰值工作集）。

用法
----
  python backend/bench_scan.py                     # 默认 50,200,500,1000
  python backend/bench_scan.py --quick             # 只跑 50,200（约十几秒）
  python backend/bench_scan.py --counts 50,200     # 自定义规模
  python backend/bench_scan.py --out my_baseline.json
  python backend/bench_scan.py --compare backend/bench_baseline_scan.json   # 与基线对比

说明
----
* 合成 VPK 只包含「元数据规模」（addoninfo / 封面 / 若干条目，每个文件 1KB 左右），
  数据体积可用 --file-kb 调整。扫描耗时主要由「目录树条目数 + addoninfo + 封面提取」决定，
  因此合成库能真实反映扫描开销，且磁盘占用很小。
* 脚本会把 HOME/USERPROFILE 指向临时目录后再导入项目模块，因此**不会污染**用户真实的
  ~/.l4d2-manager 缓存与配置。
* 生成物默认在结束时删除，加 --keep 可保留以便排查。
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import platform
import random
import shutil
import struct
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

# ─────────────────────────────────────────────────────────────────────────────
# 必须在导入项目模块之前隔离缓存目录：
# mod_scanner.py / data_store.py 在 import 时就会执行 Path.home() / '.l4d2-manager'
# ─────────────────────────────────────────────────────────────────────────────
BENCH_ROOT = Path(tempfile.mkdtemp(prefix='l4d2-bench-'))
os.environ['USERPROFILE'] = str(BENCH_ROOT)
os.environ['HOME'] = str(BENCH_ROOT)

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Windows 控制台默认 GBK：先切到 UTF-8（与项目里 run_test.bat 的 chcp 65001 做法一致），
# 避免中文/特殊符号乱码或抛 UnicodeEncodeError
if sys.platform == 'win32':
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleOutputCP(65001)  # type: ignore[attr-defined]
    except Exception:
        pass
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[attr-defined]
except Exception:
    pass

from services.mod_scanner import ModScanner  # noqa: E402
from services import mod_scanner as scanner_mod  # noqa: E402
from services import data_store as data_store_mod  # noqa: E402

# 1x1 的最小合法 JPEG，用于扮演 addonimage.jpg 封面
_JPEG_1PX = base64.b64decode(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
)

VPK_SIGNATURE = 0x55AA1234
VPK_HEADER_LENGTH_V1 = 12  # 3 * uint32
ARCHIVE_INDEX_INLINE = 0x7FFF  # 数据内嵌在同一个 _dir.vpk 里

# ─────────────────────────────────────────────────────────────────────────────
# 内存统计（Windows 原生 API，无第三方依赖）
# ─────────────────────────────────────────────────────────────────────────────
def _mem_counters() -> Optional[dict[str, float]]:
    """返回 {'working_set_mb', 'peak_working_set_mb'}；非 Windows 或失败时为 None。"""
    if sys.platform != 'win32':
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
            _fields_ = [
                ('cb', wintypes.DWORD),
                ('PageFaultCount', wintypes.DWORD),
                ('PeakWorkingSetSize', ctypes.c_size_t),
                ('WorkingSetSize', ctypes.c_size_t),
                ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                ('PagefileUsage', ctypes.c_size_t),
                ('PeakPagefileUsage', ctypes.c_size_t),
                ('PrivateUsage', ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS_EX()
        counters.cb = ctypes.sizeof(counters)
        psapi = ctypes.WinDLL('psapi.dll')
        kernel32 = ctypes.WinDLL('kernel32.dll')
        # 关键：句柄是 64 位指针，必须声明 restype，否则会被截断成 32 位 int
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        psapi.GetProcessMemoryInfo.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX),
            wintypes.DWORD,
        ]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        if not psapi.GetProcessMemoryInfo(
            kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb
        ):
            return None
        mib = 1024.0 * 1024.0
        return {
            'working_set_mb': counters.WorkingSetSize / mib,
            'peak_working_set_mb': counters.PeakWorkingSetSize / mib,
        }
    except Exception:
        return None


def _working_set_mb() -> Optional[float]:
    counters = _mem_counters()
    return None if counters is None else round(counters['working_set_mb'], 1)


def _peak_working_set_mb() -> Optional[float]:
    counters = _mem_counters()
    return None if counters is None else round(counters['peak_working_set_mb'], 1)


# ─────────────────────────────────────────────────────────────────────────────
# 最小 VPK v1 写入器（字节布局与后端所用 vpk 库一致：数据内嵌在 dir 文件中）
# ─────────────────────────────────────────────────────────────────────────────
def _vpk_tree_length(tree: dict[str, dict[str, list[str]]]) -> int:
    """与 vpk 库 NewVPK.calculate_tree_length() 完全一致的算法。"""
    length = 0
    for ext, paths in tree.items():
        length += len(ext.encode()) + 2  # ext + '\x00'
        for relpath, names in paths.items():
            length += len(relpath.encode()) + 2  # relpath + '\x00'
            for name in names:
                length += len(name.encode()) + 1 + 18  # name + '\x00' + 18 字节元数据
    return length + 1  # 目录树结尾的 '\x00'


def write_vpk(target: Path, files: dict[str, bytes]) -> int:
    """把 {路径: 内容} 写成一个合法 VPK v1，返回文件字节数。

    目录树按 ext -> relpath -> filename 三层组织；根目录下的文件 relpath 用 ' ' 表示。
    每个条目 18 字节元数据：crc32(4) preload_length(2) archive_index(2) offset(4) length(4) 0xFFFF(2)。
    """
    tree: dict[str, dict[str, list[str]]] = {}
    lookup: dict[tuple[str, str, str], bytes] = {}

    for full_path, data in files.items():
        rel, _, filename = full_path.replace('\\', '/').rpartition('/')
        relpath = rel if rel else ' '
        name, _, ext = filename.rpartition('.')
        if not name or not ext:
            raise ValueError(f'VPK 内文件必须带扩展名: {full_path}')
        tree.setdefault(ext, {}).setdefault(relpath, []).append(name)
        lookup[(ext, relpath, name)] = data

    tree_length = _vpk_tree_length(tree)

    # 目录树必须按 ext -> relpath -> filename 分组写出，数据区顺序与之完全对应
    meta = bytearray()
    data_blobs: list[bytes] = []
    data_cursor = 0
    for ext, paths in tree.items():
        meta += ext.encode() + b'\x00'
        for relpath, names in paths.items():
            meta += relpath.encode() + b'\x00'
            for name in names:
                data = lookup[(ext, relpath, name)]
                meta += name.encode() + b'\x00'
                meta += struct.pack(
                    'IHHIIH',
                    binascii.crc32(data) & 0xFFFFFFFF,
                    0,                      # preload_length
                    ARCHIVE_INDEX_INLINE,   # 数据就在本文件内
                    data_cursor,            # archive_offset（相对数据区起点）
                    len(data),
                    0xFFFF,
                )
                data_cursor += len(data)
                data_blobs.append(data)
            meta += b'\x00'  # 本 relpath 结束
        meta += b'\x00'      # 本 ext 结束
    meta += b'\x00'          # 目录树结束

    if len(meta) != tree_length:
        raise AssertionError(f'目录树长度计算错误: {len(meta)} != {tree_length}')

    with open(target, 'wb') as f:
        f.write(struct.pack('III', VPK_SIGNATURE, 1, tree_length))
        f.write(bytes(meta))
        for data in data_blobs:
            f.write(data)

    return VPK_HEADER_LENGTH_V1 + tree_length + data_cursor


# ─────────────────────────────────────────────────────────────────────────────
# 合成 Mod 库
# ─────────────────────────────────────────────────────────────────────────────
def _filler(salt: str, size: int) -> bytes:
    """可压缩但非全零的填充数据（更像真实资源文件）。"""
    pattern = f'{salt}|'.encode('utf-8')
    return (pattern * (size // len(pattern) + 1))[:size]


def build_mod_payload(index: int, entries: int, file_kb: int) -> dict[str, bytes]:
    """构造第 index 个合成 Mod 的 VPK 内容（1 起）。

    * 每个 Mod 都有唯一的 addoninfo.txt / 封面 / 若干独有资源（不冲突）
    * 每隔几个 Mod 共用 scripts/vscripts/hud_layout.nut、materials/hud/scoreboard.vmt（触发冲突检测）
    * 每 7 个 Mod 带一张地图（触发「地图」分类，也用于验证标签推断）
    """
    tag = f'{index:04d}'
    kb = max(1, file_kb) * 1024
    files: dict[str, bytes] = {
        'addoninfo.txt': (
            '"AddonInfo"\n{\n'
            f'\taddontitle "Synthetic Mod {tag}"\n'
            '\taddonversion "1.0"\n'
            f'\taddonauthor "Bench Author {index % 5}"\n'
            f'\taddondescription 生成的压力测试 Mod {tag}\n'
            '\taddontags "武器|模型"\n'
            '\taddontype "weapon"\n'
            '}\n'
        ).encode('utf-8'),
        'addonimage.jpg': _JPEG_1PX,
        f'scripts/vscripts/mod_{tag}.nut': _filler(f'nut{tag}', kb),
        f'materials/models/weapons/bench_{tag}.vmt': _filler(f'vmt{tag}', kb),
        f'models/weapons/bench_{tag}.mdl': _filler(f'mdl{tag}', kb),
        f'sound/weapons/bench_{tag}.wav': _filler(f'wav{tag}', kb),
        f'particles/bench_{tag}.pcf': _filler(f'pcf{tag}', kb),
        f'addonlist_entry_{tag}.txt': _filler(f'txt{tag}', kb),
    }

    # 共享文件：制造真实的「多 Mod 覆盖同一文件」冲突
    if index % 3 == 0:
        files['scripts/vscripts/hud_layout.nut'] = _filler('shared-hud', kb)
    if index % 5 == 0:
        files['materials/hud/scoreboard.vmt'] = _filler('shared-score', kb)

    # 地图类 Mod
    if index % 7 == 0:
        files[f'maps/l4d_bench_{tag}.bsp'] = _filler(f'bsp{tag}', kb * 8)

    # 补足到指定条目数，用于控制清单规模
    for extra in range(max(0, entries - len(files))):
        files[f'materials/filler/pack{index}_{extra:03d}.vmt'] = _filler(f'fl{index}{extra}', 256)

    return files


def generate_addons_dir(
    root: Path, count: int, entries: int, file_kb: int, disabled_ratio: float, seed: int
) -> tuple[Path, float]:
    """生成 count 个 VPK 的 addons 目录（含 addonlist.txt），返回 (目录, 总 MB)。"""
    addons_dir = root / f'addons_{count}'
    addons_dir.mkdir(parents=True, exist_ok=True)

    rng = random.Random(seed)
    total_bytes = 0
    for i in range(1, count + 1):
        payload = build_mod_payload(i, entries, file_kb)
        total_bytes += write_vpk(addons_dir / f'benchmod_{i:04d}.vpk', payload)

    # 少量 Mod 处于「已禁用」，让冲突检测只覆盖启用集合（更贴近真实）
    disabled = [i for i in range(1, count + 1) if rng.random() < disabled_ratio]
    if disabled:
        lines = ['"AddonList"\n{']
        for i in range(1, count + 1):
            value = '0' if i in disabled else '1'
            lines.append(f'\t"benchmod_{i:04d}.vpk"\t\t"{value}"')
        lines.append('}\n')
        # 注意：addonlist.txt 位于 addons 目录的上一级
        (addons_dir.parent / 'addonlist.txt').write_text('\n'.join(lines), encoding='utf-8')

    return addons_dir, total_bytes / (1024 * 1024)


def reset_caches(clear_disk: bool) -> None:
    """清空扫描器/数据层缓存；clear_disk=True 时额外清空磁盘缓存（模拟全新安装）。"""
    scanner_mod._VPK_MANIFEST_CACHE.clear()
    scanner_mod._VPK_METADATA_CACHE.clear()
    scanner_mod._LAST_SCAN_KEY = None
    scanner_mod._LAST_SCAN_RESULT = []
    scanner_mod._LAST_CONFLICT_KEY = None
    data_store_mod._cache = None
    data_store_mod._cache_timestamp = 0.0
    if clear_disk:
        for cache_dir in (
            scanner_mod._VPK_CACHE_DIR,
            scanner_mod._MANIFEST_CACHE_DIR,
            scanner_mod._METADATA_CACHE_DIR,
        ):
            shutil.rmtree(cache_dir, ignore_errors=True)



def _phase(label: str, fn, mods_for_throughput: int) -> dict[str, Any]:
    """执行一个阶段并记录耗时/内存。"""
    before_ws = _working_set_mb()
    t0 = time.perf_counter()
    detail = fn()
    elapsed = time.perf_counter() - t0
    after_ws = _working_set_mb()
    result: dict[str, Any] = {
        'label': label,
        'elapsed_ms': round(elapsed * 1000, 1),
        'working_set_delta_mb': (
            None if before_ws is None or after_ws is None else round(after_ws - before_ws, 1)
        ),
        'peak_working_set_mb': _peak_working_set_mb(),
    }
    if detail:
        result.update(detail)
    if elapsed > 0 and mods_for_throughput:
        result['throughput_mods_per_s'] = round(mods_for_throughput / elapsed, 1)
    return result


def verify_synthetic(addons_dir: Path, sample: int = 3) -> str:
    """用后端同款 vpk 库抽查合成文件是否可解析（防止写入器写错格式）。"""
    import vpk as vpk_lib

    checked = 0
    for fp in sorted(addons_dir.glob('*.vpk'))[:sample]:
        entries = [n for n in vpk_lib.VPK(str(fp), read_header_only=False) if isinstance(n, str)]
        if not any('addoninfo' in n.lower() for n in entries):
            raise RuntimeError(f'合成 VPK 无法被 vpk 库正确解析: {fp.name}, entries={entries[:5]}')
        checked += 1
    return f'vpk 库抽查 {checked} 个文件通过'


def measure_scale(scale: int, args: argparse.Namespace, phases: list[str]) -> dict[str, Any]:
    addons_dir, size_mb = generate_addons_dir(
        BENCH_ROOT, scale, args.entries, args.file_kb, args.disabled_ratio, args.seed
    )
    check = verify_synthetic(addons_dir)
    print(
        f'\n=== {scale} 个 Mod（合成体积 {size_mb:.1f} MB，{check}，'
        f'当前内存 {_working_set_mb()} MB）===',
        flush=True,
    )

    scanner = ModScanner(addons_path=str(addons_dir))
    results: dict[str, Any] = {}

    if 'cold' in phases:
        reset_caches(clear_disk=True)

        def cold():
            mods = scanner.scan_mods()
            if len(mods) != scale:
                raise RuntimeError(f'扫描结果数量异常: 期望 {scale}，实际 {len(mods)}')
            return {
                'mods': len(mods),
                'conflicts': len([m for m in mods if m.conflicts]),
                'note': '进程内+磁盘缓存全空',
            }

        results['cold'] = _phase('cold', cold, scale)

    if 'warm-mem' in phases:
        def warm_mem():
            mods = scanner.scan_mods()  # 内容未变化 → 命中 scan_key 缓存
            return {'mods': len(mods), 'note': '同进程再次扫描（缓存命中）'}

        results['warm-mem'] = _phase('warm-mem', warm_mem, scale)

    if 'warm-disk' in phases:
        reset_caches(clear_disk=False)  # 只清内存，磁盘缓存仍在 → 模拟重启软件

        def warm_disk():
            mods = scanner.scan_mods()
            return {'mods': len(mods), 'note': '重启软件后（磁盘缓存命中）'}

        results['warm-disk'] = _phase('warm-disk', warm_disk, scale)

    if 'stream-cold' in phases:
        reset_caches(clear_disk=True)

        def stream_cold():
            t0 = time.perf_counter()
            first_mod_ms: Optional[float] = None
            count = 0
            for evt in scanner.stream_mods():
                if evt.get('type') == 'mod':
                    if first_mod_ms is None:
                        first_mod_ms = (time.perf_counter() - t0) * 1000
                    count += 1
            return {
                'mods': count,
                'first_mod_ms': None if first_mod_ms is None else round(first_mod_ms, 1),
                'note': '流式接口：首个 Mod 出现时间 / 全部完成时间',
            }

        results['stream-cold'] = _phase('stream-cold', stream_cold, scale)

    if not args.keep:
        shutil.rmtree(addons_dir, ignore_errors=True)

    return {'mods': scale, 'library_size_mb': round(size_mb, 2), 'phases': results}


def print_table(results: list[dict[str, Any]]) -> None:
    header = f'{"规模":>6} {"阶段":<12} {"耗时(ms)":>10} {"吞吐(mods/s)":>12} {"内存增量":>10} {"峰值WS":>9}  备注'
    print('\n' + '=' * len(header))
    print(header)
    print('-' * len(header))
    for r in results:
        for name, p in r['phases'].items():
            delta = p.get('working_set_delta_mb')
            delta_txt = '-' if delta is None else f'{delta:+.1f} MB'
            peak = p.get('peak_working_set_mb')
            peak_txt = '-' if peak is None else f'{peak:.0f} MB'
            tput = p.get('throughput_mods_per_s')
            tput_txt = '-' if tput is None else f'{tput:.1f}'
            first = p.get('first_mod_ms')
            note = p.get('note', '')
            if first is not None:
                note = f'首个 Mod {first:.0f} ms；{note}'
            print(
                f'{r["mods"]:>6} {name:<12} {p["elapsed_ms"]:>10.1f} {tput_txt:>12} '
                f'{delta_txt:>10} {peak_txt:>9}  {note}'
            )
    print('=' * len(header))


def compare_with_baseline(baseline_path: Path, results: list[dict[str, Any]]) -> None:
    try:
        base = json.loads(baseline_path.read_text(encoding='utf-8'))
    except Exception as e:
        print(f'[对比] 无法读取基线 {baseline_path}: {e}')
        return
    base_by_scale = {r['mods']: r for r in base.get('results', [])}
    print(f'\n=== 与基线对比（{baseline_path.name}，生成于 {base.get("generated_at", "?")}）===')
    for r in results:
        old_scale = base_by_scale.get(r['mods'])
        if not old_scale:
            continue
        for name, cur in r['phases'].items():
            old = old_scale['phases'].get(name)
            if not old or not old.get('elapsed_ms'):
                continue
            delta = (cur['elapsed_ms'] - old['elapsed_ms']) / old['elapsed_ms'] * 100
            delta_abs = cur['elapsed_ms'] - old['elapsed_ms']
            # 同时看相对与绝对变化：微小耗时（几毫秒）的百分比波动没有参考价值
            if delta > 5 and delta_abs > 20:
                flag = '[变慢]'
            elif delta < -5 and delta_abs < -20:
                flag = '[变快]'
            else:
                flag = '[持平]'
            print(
                f'{r["mods"]:>5} mods  {name:<12} {old["elapsed_ms"]:>9.1f} ms -> '
                f'{cur["elapsed_ms"]:>9.1f} ms  {delta:+6.1f}% ({delta_abs:+.1f} ms)  {flag}'
            )


def main() -> int:
    parser = argparse.ArgumentParser(description='L4Director Mod 扫描压力测试')
    parser.add_argument('--counts', default='50,200,500,1000', help='要测的 Mod 数量（逗号分隔）')
    parser.add_argument('--quick', action='store_true', help='快速模式：只测 50/200，且只跑 cold + warm-mem')
    parser.add_argument('--entries', type=int, default=12, help='每个 VPK 的条目数下限（默认 12）')
    parser.add_argument('--file-kb', type=int, default=1, help='每个条目的大小 KB（默认 1）')
    parser.add_argument('--disabled-ratio', type=float, default=0.1, help='随机禁用的 Mod 比例（默认 0.1）')
    parser.add_argument('--seed', type=int, default=20260924, help='随机种子（保证可复现）')
    parser.add_argument('--phases', default=None, help='只跑指定阶段: cold,warm-mem,warm-disk,stream-cold')
    parser.add_argument('--out', default=None,
                        help='基线 JSON 输出路径（默认 bench_baseline_scan.json，--quick 时为 *_quick.json）')
    parser.add_argument('--compare', default=None, help='与该基线 JSON 对比（不覆盖它）')
    parser.add_argument('--keep', action='store_true', help='保留合成 Mod 与缓存目录（默认跑完删除）')
    args = parser.parse_args()

    counts = [50, 200] if args.quick else [int(c) for c in args.counts.split(',') if c.strip()]
    if args.quick:
        phases = ['cold', 'warm-mem']
    elif args.phases:
        phases = [p.strip() for p in args.phases.split(',') if p.strip()]
    else:
        phases = ['cold', 'warm-mem', 'warm-disk', 'stream-cold']

    print('=' * 72)
    print(' L4Director 扫描压力测试')
    print('=' * 72)
    print(f'  规模       : {counts} 个 Mod')
    print(f'  阶段       : {phases}')
    print(f'  每库条目数 : {args.entries} 个/VPK，每条目 {args.file_kb} KB')
    print(f'  并行       : 扫描器内部 ThreadPoolExecutor(max_workers=4)')
    print(f'  缓存根目录 : {BENCH_ROOT}（已隔离，不会动用户真实缓存）')
    print(f'  Python     : {sys.version.split()[0]}  CPU: {os.cpu_count()} 核')
    print(f'  系统       : {platform.platform()}')
    print('=' * 72)

    results: list[dict[str, Any]] = []
    for scale in sorted(counts):
        try:
            results.append(measure_scale(scale, args, phases))
        except Exception as e:
            print(f'\n[错误] {scale} 个 Mod 的测试失败: {e}')
            if not args.keep:
                shutil.rmtree(BENCH_ROOT, ignore_errors=True)
            return 1

    print_table(results)

    payload = {
        'tool': 'backend/bench_scan.py',
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'machine': {
            'platform': platform.platform(),
            'processor': platform.processor(),
            'cpu_count': os.cpu_count(),
            'python': sys.version.split()[0],
        },
        'params': {
            'counts': counts,
            'phases': phases,
            'entries_per_vpk': args.entries,
            'file_kb': args.file_kb,
            'disabled_ratio': args.disabled_ratio,
            'seed': args.seed,
        },
        'results': results,
    }

    if args.compare:
        compare_with_baseline(Path(args.compare), results)
    else:
        out_path = (
            Path(args.out)
            if args.out
            else Path(__file__).with_name(
                'bench_baseline_scan_quick.json' if args.quick else 'bench_baseline_scan.json'
            )
        )
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'\n基线已写入: {out_path}')
        print('（下次可用 --compare 与该基线对比，判断是否出现性能回归）')

    if not args.keep:
        shutil.rmtree(BENCH_ROOT, ignore_errors=True)
    else:
        print(f'合成数据保留在: {BENCH_ROOT}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
