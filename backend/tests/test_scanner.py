"""ModScanner：扫描、启用状态、addonlist 写回、补 addoninfo、冲突回填、流式接口。

全部用合成 VPK（tests/support/vpkbuild.py），不依赖本机是否装了游戏。
"""
import json

import pytest

from support import vpkbuild


def test_归一化_mod_名():
    from services.mod_scanner import _normalize_mod_key

    cases = {
        'mymod.vpk': 'mymod',
        'mod-mymod.vpk': 'mymod',
        'MOD-MyMod.VPK': 'mymod',
        'Mymod': 'mymod',
        'workshop\\mymod.vpk': 'mymod',
        'D:/addons/mymod.vpk': 'mymod',
    }
    for raw, expected in cases.items():
        assert _normalize_mod_key(raw) == expected, raw


def test_扫描读出版本信息与标签(scanner, make_mod):
    make_mod('alpha.vpk', title='Alpha Skin')
    make_mod('beta.vpk', title='Beta Skin')

    mods = scanner.scan_mods()
    by_name = {m.name: m for m in mods}

    assert set(by_name) == {'alpha.vpk', 'beta.vpk'}
    assert by_name['alpha.vpk'].display_name == 'Alpha Skin'
    assert by_name['alpha.vpk'].author == 'Tester'
    assert by_name['alpha.vpk'].size_bytes > 0
    assert by_name['alpha.vpk'].enabled is True          # 默认启用
    assert by_name['alpha.vpk'].missing_addoninfo is False
    assert '外部 Mod' in by_name['alpha.vpk'].tags


def test_缺_addoninfo_的包会被标记(scanner, make_mod):
    make_mod('noinfo.vpk', title='No Info', with_addoninfo=False)

    mod = {m.name: m for m in scanner.scan_mods()}['noinfo.vpk']
    assert mod.missing_addoninfo is True


def test_workshop_下的包被识别为工坊包(scanner, addons_dir):
    ws = addons_dir / 'workshop' / '123456'
    ws.mkdir(parents=True)
    vpkbuild.make_mod(ws, '123456.vpk', title='Workshop Skin')

    mods = scanner.scan_mods()
    assert len(mods) == 1
    mod = mods[0]
    assert mod.is_workshop is True
    assert mod.workshop_id == '123456'
    assert '创意工坊 Mod' in mod.tags
    assert 'ID: 123456' in mod.tags


def test_同名_vpk_在根目录与_workshop_下是两条(scanner, addons_dir):
    """同一个包既订阅工坊又被手动拖进来：按路径区分，不能互相覆盖。"""
    vpkbuild.make_mod(addons_dir, 'same.vpk', title='Root Copy')
    ws = addons_dir / 'workshop'
    vpkbuild.make_mod(ws, 'same.vpk', title='Workshop Copy')

    mods = [m for m in scanner.scan_mods() if m.name == 'same.vpk']
    assert len(mods) == 2
    assert len({m.path for m in mods}) == 2


def test_内容未变化时第二次扫描命中缓存(scanner, make_mod):
    make_mod('alpha.vpk')
    scanner.scan_mods()

    perf_before = scanner.scan_mods()
    from services.mod_scanner import get_last_scan_perf

    perf = get_last_scan_perf()
    assert perf['mode'] in ('cached', 'stream-cached'), perf
    assert perf['elapsed_ms'] < 50
    assert len(perf_before) == 1


def test_toggle_写入_addonlist_并持久化偏好(scanner, make_mod, addons_dir):
    make_mod('alpha.vpk')
    scanner.scan_mods()

    result = scanner.toggle_mod('alpha.vpk', enable=False)
    assert result is not None
    assert result.enabled is False

    # addonlist.txt 在 addons 的上一级（left4dead2/addonlist.txt）
    addonlist = (addons_dir.parent / 'addonlist.txt').read_text(encoding='utf-8')
    assert '"alpha.vpk"' in addonlist
    assert '"0"' in addonlist

    # 重新扫描（新实例模拟重启）也要读到禁用
    from services.mod_scanner import ModScanner
    fresh = ModScanner()
    fresh.set_addons_path(str(addons_dir))
    mod = {m.name: m for m in fresh.scan_mods()}['alpha.vpk']
    assert mod.enabled is False


def test_补_addoninfo_后不再标记缺失且不丢条目(scanner, make_mod):
    path = make_mod('noinfo.vpk', title='No Info', with_addoninfo=False, entries=6)
    before = {m.name: m for m in scanner.scan_mods()}['noinfo.vpk']
    assert before.missing_addoninfo is True

    result = scanner.add_addoninfo('noinfo.vpk')
    assert result.get('added') is not False

    scanner.invalidate_mod_enabled_cache()
    from services.mod_scanner import invalidate_scan_cache
    invalidate_scan_cache()

    after = {m.name: m for m in scanner.scan_mods()}['noinfo.vpk']
    assert after.missing_addoninfo is False
    # 原有资源不能被重写过程吞掉
    from services.conflict_engine import read_index
    index = read_index(path)
    assert 'addoninfo.txt' in index
    assert sum(1 for p in index if p.startswith('materials/models/test/')) == 6


def test_冲突检测走官方名单时判硬冲突(scanner, make_mod, monkeypatch):
    """两个包改同一条官方资源、内容不同 → 双方 conflicts 里都要有对方。"""
    from services import mod_scanner as ms
    from services.conflict_engine import OfficialIndex

    shared = 'materials/models/weapons/w_rifle.vmt'
    make_mod('a.vpk', title='A', extra={shared: b'aaaa'})
    make_mod('b.vpk', title='B', extra={shared: b'bbbb'})

    monkeypatch.setattr(ms, '_get_official_index', lambda addons_path: OfficialIndex({shared: (1, 999)}))
    ms.invalidate_scan_cache()

    mods = {m.name: m for m in scanner.scan_mods()}
    assert mods['a.vpk'].conflicts == ['b.vpk']
    assert mods['b.vpk'].conflicts == ['a.vpk']
    assert mods['a.vpk'].conflict_details[0]['severity'] == 'hard'


def test_私有路径重名只进提示不进红点(scanner, make_mod, monkeypatch):
    from services import mod_scanner as ms
    from services.conflict_engine import OfficialIndex

    private = 'materials/models/private/shared.vmt'
    make_mod('a.vpk', title='A', extra={private: b'aaaa'})
    make_mod('b.vpk', title='B', extra={private: b'bbbb'})

    monkeypatch.setattr(ms, '_get_official_index', lambda addons_path: OfficialIndex({}))
    ms.invalidate_scan_cache()

    mods = {m.name: m for m in scanner.scan_mods()}
    assert mods['a.vpk'].conflicts == []
    assert mods['a.vpk'].conflict_hints, '私有路径重名应该出现在提示里'


def test_流式扫描的事件序列(scanner, make_mod):
    make_mod('alpha.vpk')
    make_mod('beta.vpk')

    events = list(scanner.stream_mods())
    kinds = [e['type'] for e in events]

    assert kinds[0] == 'meta'
    assert kinds[0] and events[0]['total'] == 2
    assert kinds.count('mod') == 2
    assert kinds[-1] == 'done'
    assert events[-1]['count'] == 2
    # 冲突回填事件数量与 Mod 数一致
    assert kinds.count('conflict') == 2


def test_未配置路径时扫描返回空(caplog):
    from services.mod_scanner import ModScanner

    s = ModScanner()
    s._addons_path = None
    assert s.scan_mods() == []


def test_拿不到官方基准时硬冲突会降级成提示(scanner, make_mod, monkeypatch):
    """没有 pak01_dir.vpk = 不知道哪些路径是官方的 → 只能判「私有路径重名」。

    这是排查过的真实误判：把 Mod 放在非游戏目录（测试库 `D:/Sample`）扫描时，
    hard 会静默消失，界面上只是「没有红点」，脚本冲突还在。用例把这条降级语义钉住。
    """
    from services import mod_scanner as ms

    shared = 'models/weapons/melee/v_chainsaw.mdl'
    make_mod('a.vpk', title='A', extra={shared: b'aaaa'})
    make_mod('b.vpk', title='B', extra={shared: b'bbbb'})

    monkeypatch.setattr(ms, '_get_official_index', lambda _addons: None)
    ms.invalidate_scan_cache()

    mods = {m.name: m for m in scanner.scan_mods()}
    assert mods['a.vpk'].conflicts == []
    assert mods['a.vpk'].conflict_hints, '降级后必须仍然出现在提示里，不能当作没冲突'
    assert mods['a.vpk'].conflict_hints[0]['severity'] == 'soft'
