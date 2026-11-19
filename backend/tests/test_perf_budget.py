"""性能预算（性能要求写成可执行断言）。

预算来源：docs-internal/09-性能与测试规格.md 的「性能要求」一节。
阈值取得比本机实测宽 10 倍以上（CI runner 比开发机慢且会抖动），目的是拦住
**数量级回归**（少了一层缓存、把 O(n) 写成 O(n²)、payload 里塞了整棵目录树），
而不是比谁的机器快。

单独跑：pytest -m perf
跳过：  pytest -m "not perf"
"""
import time
import tracemalloc

import pytest

from services import mod_scanner as ms
from support import vpkbuild

ENTRIES_PER_MOD = 8


def build_library(addons_dir, count: int) -> None:
    for i in range(1, count + 1):
        vpkbuild.write_vpk(
            addons_dir / f'mod_{i:04d}.vpk',
            vpkbuild.mod_files(f'Mod {i:04d}', entries=ENTRIES_PER_MOD),
        )


def fresh_scanner(addons_dir):
    from services.mod_scanner import ModScanner

    s = ModScanner()
    s.set_addons_path(str(addons_dir))
    return s


def reset_caches():
    ms.invalidate_scan_cache()
    ms._VPK_METADATA_CACHE.clear()
    ms._VPK_MANIFEST_CACHE.clear()
    ms._VPK_INDEX_CACHE.clear()
    ms._OFFICIAL_INDEX_CACHE.clear()
    ms._OFFICIAL_INDEX_ERRORS.clear()


@pytest.mark.perf
def test_120_mods_冷扫描预算(addons_dir):
    """冷扫描（进程内缓存全空）要在 4 秒内跑完 120 个 Mod。"""
    build_library(addons_dir, 120)
    scanner = fresh_scanner(addons_dir)
    reset_caches()

    started = time.perf_counter()
    mods = scanner.scan_mods()
    elapsed_ms = (time.perf_counter() - started) * 1000

    assert len(mods) == 120
    assert elapsed_ms < 4000, f'120 个 Mod 冷扫描耗时 {elapsed_ms:.0f}ms，超出预算 4000ms'


@pytest.mark.perf
def test_命中缓存的重扫要快一个数量级(addons_dir):
    """内容没变时重扫只做 stat + 冲突指纹，必须 < 200ms（否则切页会卡）。"""
    build_library(addons_dir, 120)
    scanner = fresh_scanner(addons_dir)
    reset_caches()

    started = time.perf_counter()
    scanner.scan_mods()
    cold_ms = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    scanner.scan_mods()
    warm_ms = (time.perf_counter() - started) * 1000

    assert warm_ms < 200, f'缓存重扫 {warm_ms:.0f}ms，超出预算 200ms'
    assert warm_ms < cold_ms / 5, f'缓存没起作用：冷 {cold_ms:.0f}ms / 热 {warm_ms:.0f}ms'


@pytest.mark.perf
def test_扫描峰值内存预算(addons_dir):
    """120 个 Mod 的扫描峰值分配 < 200MB（防止目录树被整份复制多份）。"""
    build_library(addons_dir, 120)
    scanner = fresh_scanner(addons_dir)
    reset_caches()

    tracemalloc.start()
    try:
        scanner.scan_mods()
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    peak_mb = peak / 1048576
    assert peak_mb < 200, f'扫描峰值分配 {peak_mb:.1f}MB，超出预算 200MB'


@pytest.mark.perf
def test_mod_列表的_json_体积预算(client, addons_dir):
    """每个 Mod 的 JSON 平均 < 3KB：payload 膨胀会同时拖慢后端序列化与前端解析。"""
    build_library(addons_dir, 120)

    res = client.get('/api/mods')
    assert res.status_code == 200
    payload_kb = len(res.content) / 1024
    per_mod_kb = payload_kb / 120

    assert per_mod_kb < 3.0, f'每个 Mod 的 JSON 平均 {per_mod_kb:.2f}KB，超出预算 3KB'


@pytest.mark.perf
def test_状态接口预算(client, addons_dir):
    """`/api/status` 预算 150ms：它多带了一个「官方基准是否可用」字段，
    必须走 pak01 的 mtime 进程缓存，不能每次请求都重读 22k 条目录树。"""
    build_library(addons_dir, 120)
    # 造一个真的 pak01_dir.vpk：这条用例要覆盖「基准可用」的最贵路径（首次解析 + 之后命中缓存）
    vpkbuild.write_vpk(
        addons_dir.parent / 'pak01_dir.vpk',
        {f'materials/models/official/asset_{i:03d}.vmt': b'official' for i in range(64)},
    )
    reset_caches()
    ms._OFFICIAL_INDEX_CACHE.clear()

    client.get('/api/status')  # 预热：冷扫描 + 首次解析 pak01

    started = time.perf_counter()
    res = client.get('/api/status')
    warm_ms = (time.perf_counter() - started) * 1000

    assert res.status_code == 200
    assert res.json()['official_baseline']['available'] is True
    assert warm_ms < 150, f'/api/status 耗时 {warm_ms:.0f}ms，超出预算 150ms'


@pytest.mark.perf
@pytest.mark.slow
def test_冲突检测_300_mods_预算():
    """300 个 Mod × 150 条路径的冲突判定 < 3 秒（倒排索引，不该是 O(n²) 爆炸）。"""
    from services.conflict_engine import analyze

    mods = {}
    for i in range(300):
        files = {f'materials/private/m{i}/asset_{j:03d}.vmt': (i * 100 + j, 10) for j in range(150)}
        # 每 10 个 Mod 覆盖同一条官方资源，制造真实冲突
        if i % 10 == 0:
            files['materials/models/weapons/w_rifle.vmt'] = (i, 100)
        mods[f'mod{i:03d}'] = files

    official = {'materials/models/weapons/w_rifle.vmt': (999, 100)}

    started = time.perf_counter()
    reports = analyze(mods, official)
    elapsed_ms = (time.perf_counter() - started) * 1000

    assert elapsed_ms < 3000, f'冲突检测耗时 {elapsed_ms:.0f}ms，超出预算 3000ms'
    assert len(reports) == 300
    conflicted = [r for r in reports.values() if r.conflicts]
    assert conflicted, '构造的官方资源覆盖应该判出硬冲突'


@pytest.mark.perf
def test_扫描耗时随规模近似线性(addons_dir, tmp_path):
    """120 个 Mod 的耗时不应超过 30 个 Mod 的 12 倍（约 4 倍是正常区间）。"""
    small = tmp_path / 'small' / 'addons'
    big = addons_dir
    for i in range(1, 31):
        vpkbuild.write_vpk(small / f'mod_{i:04d}.vpk',
                           vpkbuild.mod_files(f'Mod {i:04d}', entries=ENTRIES_PER_MOD))
    build_library(big, 120)

    scanner = fresh_scanner(small)
    reset_caches()
    started = time.perf_counter()
    scanner.scan_mods()
    small_ms = (time.perf_counter() - started) * 1000

    scanner = fresh_scanner(big)
    reset_caches()
    started = time.perf_counter()
    scanner.scan_mods()
    big_ms = (time.perf_counter() - started) * 1000

    ratio = big_ms / max(small_ms, 1.0)
    assert ratio < 12, f'规模放大 4 倍，耗时放大 {ratio:.1f} 倍（{small_ms:.0f}ms → {big_ms:.0f}ms），疑似非线性'
