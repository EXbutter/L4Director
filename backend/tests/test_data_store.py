"""data_store 的数据安全语义。

这一组是「用户数据不能丢」的护栏：原子写、上一版备份、损坏隔离、只读模式、
批量写盘只写一次。任何一条挂掉都意味着用户可能丢掉合辑 / 自定义名 / 标签。
"""
import json

import pytest


@pytest.fixture
def ds():
    from services import data_store as _ds
    return _ds


def test_写盘是原子的且不留临时文件(ds):
    ds.set_mod_meta('a.vpk', ds.ModMeta(display_name='A'))

    assert ds._DATA_FILE.exists()
    raw = json.loads(ds._DATA_FILE.read_text(encoding='utf-8'))
    assert raw['mod_metas']['a.vpk']['display_name'] == 'A'
    # fsync + replace 之后临时文件必须已经消失
    assert not ds._DATA_FILE.with_suffix('.tmp').exists()


def test_写盘前留上一版备份(ds):
    ds.set_mod_meta('a.vpk', ds.ModMeta(display_name='first'))
    ds.set_mod_meta('a.vpk', ds.ModMeta(display_name='second'))

    bak = ds._DATA_FILE.with_name(ds._DATA_FILE.name + '.bak')
    assert bak.exists()
    assert json.loads(bak.read_text(encoding='utf-8'))['mod_metas']['a.vpk']['display_name'] == 'first'
    assert ds.get_mod_meta('a.vpk').display_name == 'second'


def test_损坏的_json_被隔离而不是被覆盖(ds):
    ds._DATA_FILE.write_text('{ 这不是 JSON', encoding='utf-8')

    # 读不到就回落默认值，但原文件必须被挪走留档
    assert ds.get_mod_meta('x').display_name is None
    quarantined = sorted(ds._CACHE_DIR.glob('data.json.corrupt-*'))
    assert quarantined, '损坏文件没有被隔离'
    assert 'JSON' in (ds.get_last_recovery() or {}).get('reason', '')

    # 再写入不能把隔离出来的那份覆盖掉
    ds.set_mod_meta('b.vpk', ds.ModMeta(display_name='B'))
    assert quarantined[0].read_text(encoding='utf-8') == '{ 这不是 JSON'


def test_读不出来时进入只读模式_拒绝一切写盘(ds, monkeypatch):
    ds.set_mod_meta('a.vpk', ds.ModMeta(display_name='原始值'))
    ds._cache = None

    class _Unreadable:
        name = 'data.json'

        def exists(self):
            return True

        def read_text(self, encoding=None):
            raise OSError(13, 'denied')

    monkeypatch.setattr(ds, '_DATA_FILE', _Unreadable())

    # 读 → 回落默认值，同时置位只读
    assert ds.get_mod_meta('a.vpk').display_name is None
    assert ds.get_read_only_reason()

    with pytest.raises(ds.DataStoreReadOnlyError):
        ds.set_mod_meta('a.vpk', ds.ModMeta(display_name='被覆盖了'))


def test_批量启停只写一次盘(ds, monkeypatch):
    calls = []
    original = ds._write_data_raw

    def counting(data):
        calls.append(dict(data))
        return original(data)

    monkeypatch.setattr(ds, '_write_data_raw', counting)

    ds.set_mods_enabled_bulk({'a.vpk': False, 'b.vpk': True, 'c.vpk': False})

    assert len(calls) == 1, f'整合包批量操作应该只写一次盘，实际 {len(calls)} 次'
    assert ds.get_mod_enabled('a.vpk') is False
    assert ds.get_mod_enabled('b.vpk') is True


def test_重复设置同一个标记不重复写盘(ds, monkeypatch):
    calls = []
    original = ds._write_data_raw
    monkeypatch.setattr(ds, '_write_data_raw', lambda d: (calls.append(1), original(d))[1])

    ds.set_prefs_dirty(False)   # 默认就是 False → 不写
    assert calls == []

    ds.set_prefs_dirty(True)
    assert len(calls) == 1
    ds.set_prefs_dirty(True)    # 已经是 True → 不再写
    assert len(calls) == 1


def test_一次切换只写一次盘(scanner, make_mod, monkeypatch):
    """开关一批 Mod 只该碰一次 data.json（指纹 + 偏好 + 脏标记合成一次写）。

    以前 `set_mods_states` 分三次写：写 addonlist.txt 后记指纹、写每个 Mod 的启用
    偏好、置「有改动还没应用」标记 —— 三次 fsync + 三次 .bak 备份。它们本来就住在
    同一份 data.json 里，合成一次既快，也不会留下「偏好写进去了、指纹没写」的半截状态。
    """
    from services import data_store as ds

    make_mod('alpha.vpk')
    make_mod('beta.vpk')
    scanner.scan_mods()

    calls = []
    original = ds._write_data_raw
    monkeypatch.setattr(ds, '_write_data_raw', lambda d: (calls.append(dict(d)), original(d))[1])

    result = scanner.set_mods_states({'alpha.vpk': False})
    assert result['changed'] == 1

    assert len(calls) == 1, f'一次切换应该只写一次 data.json，实际 {len(calls)} 次'
    written = calls[0]
    assert written['mod_metas']['alpha.vpk']['enabled'] is False
    assert written['prefs_dirty'] is True
    assert written['addonlist_state']['fingerprint']


def test_空操作切换不写盘(scanner, make_mod, monkeypatch):
    """已经是目标状态 → 不改文件、不写盘、也不点亮「应用」按钮。"""
    from services import data_store as ds

    make_mod('alpha.vpk')
    scanner.scan_mods()
    # 先真的禁用一次（第一次要写 addonlist.txt，因为文件还不存在）
    assert scanner.set_mods_states({'alpha.vpk': False})['changed'] == 1

    calls = []
    original = ds._write_data_raw
    monkeypatch.setattr(ds, '_write_data_raw', lambda d: (calls.append(1), original(d))[1])

    result = scanner.set_mods_states({'alpha.vpk': False})   # 重复同一次禁用
    assert result['changed'] == 0

    assert calls == [], '什么都没变还写盘，等于白做一次 fsync + 备份'
    assert ds.get_prefs_dirty() is True


def test_删除自定义标签会从所有_mod_上摘掉_内置标签摘不动(ds):
    ds.add_custom_tag('收藏')
    ds.set_mod_tags_override('a.vpk', ['我的最爱', '收藏'])

    remaining, touched = ds.remove_custom_tag('收藏')
    assert remaining == []
    assert touched == 1
    # 其它标签必须原样保留
    assert ds.get_mod_tags_override('a.vpk') == ['我的最爱']

    # 内置标签不在自定义池里 → 什么都不做（防止 DELETE 一个内置名把全库收藏抹掉）
    assert ds.remove_custom_tag('我的最爱') == ([], 0)
    assert ds.get_mod_tags_override('a.vpk') == ['我的最爱']


def test_只挂自定义标签的_mod_删标签后回落自动检测(ds):
    ds.add_custom_tag('待测试')
    ds.set_mod_tags_override('b.vpk', ['待测试'])

    ds.remove_custom_tag('待测试')
    # 回落成 None（恢复自动检测），而不是变成「什么标签都没有」
    assert ds.get_mod_tags_override('b.vpk') is None


def test_整合包批量加成员去重且只写一次(ds, monkeypatch):
    pack = ds.add_pack('测试包', ['a.vpk'])

    calls = []
    original = ds._write_data_raw
    monkeypatch.setattr(ds, '_write_data_raw', lambda d: (calls.append(1), original(d))[1])

    assert ds.add_mods_to_pack(pack.id, ['b.vpk', 'b.vpk', 'a.vpk']) is True
    assert len(calls) == 1
    assert ds.get_packs()[0].mod_ids == ['a.vpk', 'b.vpk']


def test_删除_mod_时按归一化名清理整合包(ds):
    pack = ds.add_pack('测试包', ['a.vpk', 'b.vpk'])

    # 历史写法差异（大小写 / mod- 前缀 / 缺扩展名）也要能清掉
    assert ds.remove_mod_from_all_packs('MOD-A.VPK') == 1
    assert ds.get_packs()[0].mod_ids == ['b.vpk']


def test_未知设置键不会让_read_settings_抛错(ds):
    ds.set_setting('test_key', '污染数据')
    ds.set_setting('theme', 'light')

    settings = ds.get_settings()
    assert settings.theme == 'light'
    assert not hasattr(settings, 'test_key')
