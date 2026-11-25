"""整合包（Packs）后端用例。

覆盖 v1.3.6 新增/扩展的三块能力：
  - 数据层：`PackData.from_dict` 容忍未知键、缺省字段有默认值、新键存盘往返，
    以及 `update_pack` 的「整体替换成员（保序去重）/ 增删成员 / disabled_members
    自动收敛为成员子集 / description / cover_mod 传 null 清空」。
  - 路由：`GET/POST/PUT /api/packs` 返回体字段齐全。
  - 应用：`POST /api/packs/{id}/apply` 按 disabled_members 精确恢复启停、
    `disable_others` 关掉包外已启用项、一次写盘（set_mods_states 只调一次）、
    `missing` 正确；`toggle` 旧行为与返回形状不变。

只补测试，不改业务代码。
"""
from __future__ import annotations

import pytest

from services import data_store as ds
from services.data_store import PackData


# ──────────────────────────────────────────────────────────────────────────
# PackData.from_dict
# ──────────────────────────────────────────────────────────────────────────


def test_packdata_from_dict_tolerates_unknown_keys():
    """旧版回滚读到新字段之外的「未来键」时不能崩：多传一个未知字段不抛错。"""
    raw = {
        'id': 'p1',
        'name': '包',
        'mod_ids': ['a.vpk'],
        'created_at': 't0',
        'updated_at': 't1',
        'disabled_members': ['a.vpk'],
        'description': '说明',
        'cover_mod': 'a.vpk',
        'future_field': 123,          # 未知键
        'another_future': {'x': 1},   # 未知键
    }
    pack = PackData.from_dict(raw)
    assert pack.id == 'p1'
    assert pack.mod_ids == ['a.vpk']
    assert pack.disabled_members == ['a.vpk']
    assert pack.description == '说明'
    assert pack.cover_mod == 'a.vpk'
    assert not hasattr(pack, 'future_field')
    assert not hasattr(pack, 'another_future')


def test_packdata_defaults_when_fields_missing():
    """只有最小字段（旧 data.json 的写法）时，新字段取默认值。"""
    pack = PackData.from_dict({'id': 'p2', 'name': '旧包'})
    assert pack.mod_ids == []
    assert pack.disabled_members == []
    assert pack.description == ''
    assert pack.cover_mod is None


def test_get_packs_reads_legacy_pack_without_new_keys():
    """data.json 里没有 disabled_members/description/cover_mod 的旧包要能读出来。"""
    ds._write_data_raw({
        'version': 2,
        'mod_metas': {},
        'packs': [
            {'id': 'legacy', 'name': '旧包', 'mod_ids': ['a.vpk'],
             'created_at': 'x', 'updated_at': 'y'},
        ],
        'settings': {},
        'scan_manifest': {},
    })
    ds._cache = None
    ds._cache_timestamp = 0.0

    packs = ds.get_packs()
    assert len(packs) == 1
    assert packs[0].id == 'legacy'
    assert packs[0].disabled_members == []
    assert packs[0].description == ''
    assert packs[0].cover_mod is None


def test_new_fields_roundtrip_on_disk():
    """新字段能真的落盘再读回来（走 asdict / from_dict）。"""
    p = ds.add_pack('往返包', ['a.vpk', 'b.vpk'])
    ds.update_pack(p.id, disabled_members=['b.vpk'], description='场景说明', cover_mod='a.vpk')

    ds._cache = None
    ds._cache_timestamp = 0.0
    reloaded = next(x for x in ds.get_packs() if x.id == p.id)
    assert reloaded.mod_ids == ['a.vpk', 'b.vpk']
    assert reloaded.disabled_members == ['b.vpk']
    assert reloaded.description == '场景说明'
    assert reloaded.cover_mod == 'a.vpk'


# ──────────────────────────────────────────────────────────────────────────
# update_pack
# ──────────────────────────────────────────────────────────────────────────


def test_update_pack_replace_mod_ids_preserves_order_and_dedupes():
    """mod_ids 是整体替换：去空、去重、保序。"""
    p = ds.add_pack('替换包', ['a.vpk', 'b.vpk', 'c.vpk'])
    out = ds.update_pack(p.id, mod_ids=['b.vpk', 'a.vpk', 'b.vpk', '', '  c.vpk  ', 'd.vpk'])
    assert out is not None
    assert out.mod_ids == ['b.vpk', 'a.vpk', 'c.vpk', 'd.vpk']


def test_update_pack_add_and_remove_mods():
    p = ds.add_pack('增删包', ['a.vpk', 'b.vpk', 'c.vpk'])
    out = ds.update_pack(p.id, add_mods=['d.vpk', 'e.vpk'], remove_mods=['a.vpk'])
    assert out is not None
    assert out.mod_ids == ['b.vpk', 'c.vpk', 'd.vpk', 'e.vpk']


def test_update_pack_disabled_members_converges_to_member_subset():
    """disabled_members 必须是成员子集：删成员后它要从 disabled 里自动摘掉。"""
    p = ds.add_pack('收敛包', ['a.vpk', 'b.vpk', 'c.vpk'])
    ds.update_pack(p.id, disabled_members=['a.vpk', 'b.vpk'])

    out = ds.update_pack(p.id, remove_mods=['a.vpk'])
    assert out is not None
    assert out.mod_ids == ['b.vpk', 'c.vpk']
    # a 被移除 → 也从 disabled 摘掉；b 仍是成员，保留
    assert out.disabled_members == ['b.vpk']


def test_update_pack_disabled_members_dropped_when_member_replaced_out():
    """整体替换成员时，落在新成员集之外的 disabled 也要自动消失。"""
    p = ds.add_pack('替换收敛包', ['a.vpk', 'b.vpk'])
    ds.update_pack(p.id, disabled_members=['a.vpk', 'b.vpk'])

    out = ds.update_pack(p.id, mod_ids=['b.vpk'])
    assert out is not None
    assert out.mod_ids == ['b.vpk']
    assert out.disabled_members == ['b.vpk']


def test_update_pack_description_and_cover_mod_null_clears():
    p = ds.add_pack('描述包', ['a.vpk'])
    out = ds.update_pack(p.id, description='这是一段描述', cover_mod='a.vpk')
    assert out is not None
    assert out.description == '这是一段描述'
    assert out.cover_mod == 'a.vpk'

    # 显式传 None 清空封面（回到「最后一个仍存在成员」）
    cleared = ds.update_pack(p.id, cover_mod=None)
    assert cleared is not None
    assert cleared.cover_mod is None
    # description 不传 → 保持不变
    assert cleared.description == '这是一段描述'


def test_update_pack_name_and_updated_at():
    p = ds.add_pack('旧名', ['a.vpk'])
    before = p.updated_at
    out = ds.update_pack(p.id, name='  新名  ')
    assert out is not None
    assert out.name == '新名'          # 去首尾空格
    assert out.updated_at >= before


def test_update_pack_missing_pack_returns_none():
    assert ds.update_pack('no-such-id', description='x') is None


# ──────────────────────────────────────────────────────────────────────────
# GET / POST / PUT /api/packs 返回字段
# ──────────────────────────────────────────────────────────────────────────

_PACK_FIELDS = {
    'id', 'name', 'mod_ids', 'disabled_members',
    'description', 'cover_mod', 'created_at', 'updated_at',
}


def test_post_pack_returns_all_fields(client):
    created = client.post('/api/packs', json={'name': '新包', 'mod_ids': ['a.vpk']})
    assert created.status_code == 200
    pack = created.json()['pack']
    assert _PACK_FIELDS <= set(pack)
    assert pack['mod_ids'] == ['a.vpk']
    assert pack['disabled_members'] == []
    assert pack['description'] == ''
    assert pack['cover_mod'] is None


def test_get_packs_returns_all_fields(client):
    client.post('/api/packs', json={'name': '列包'})
    listed = client.get('/api/packs').json()
    assert listed['count'] == 1
    pack = listed['packs'][0]
    assert _PACK_FIELDS <= set(pack)


def test_put_pack_returns_updated_fields(client):
    pid = client.post('/api/packs', json={'name': '改包', 'mod_ids': ['a.vpk', 'b.vpk']}).json()['pack']['id']
    res = client.put(f'/api/packs/{pid}', json={
        'description': '改后的描述',
        'cover_mod': 'b.vpk',
        'disabled_members': ['a.vpk'],
        'mod_ids': ['a.vpk', 'b.vpk', 'c.vpk'],
    })
    assert res.status_code == 200
    pack = res.json()['pack']
    assert _PACK_FIELDS <= set(pack)
    assert pack['description'] == '改后的描述'
    assert pack['cover_mod'] == 'b.vpk'
    assert pack['disabled_members'] == ['a.vpk']
    assert pack['mod_ids'] == ['a.vpk', 'b.vpk', 'c.vpk']

    # GET 也能看到同样的值
    got = client.get('/api/packs').json()['packs'][0]
    assert got['description'] == '改后的描述'
    assert got['cover_mod'] == 'b.vpk'


def test_put_pack_not_found_returns_404(client):
    res = client.put('/api/packs/does-not-exist', json={'description': 'x'})
    assert res.status_code == 404


# ──────────────────────────────────────────────────────────────────────────
# POST /api/packs/{id}/apply
# ──────────────────────────────────────────────────────────────────────────


def _create_pack(client, mod_ids, disabled=None, name='应用包'):
    pid = client.post('/api/packs', json={'name': name, 'mod_ids': mod_ids}).json()['pack']['id']
    if disabled is not None:
        client.put(f'/api/packs/{pid}', json={'disabled_members': disabled})
    return pid


def test_apply_sets_states_per_disabled_members(client, scanner, make_mod):
    make_mod('a.vpk')
    make_mod('b.vpk')
    pid = _create_pack(client, ['a.vpk', 'b.vpk'], disabled=['b.vpk'])

    res = client.post(f'/api/packs/{pid}/apply', json={})
    assert res.status_code == 200
    body = res.json()
    assert body['status'] == 'ok'
    assert body['enable_map'] == {'a.vpk': True, 'b.vpk': False}
    assert body['changed'] == 2
    assert body['missing'] == []
    assert body['outside_disabled'] == []

    # 真正写进了 addonlist.txt
    states = scanner._read_addonlist()
    assert states.get('a.vpk') is True
    assert states.get('b.vpk') is False


def test_apply_calls_set_mods_states_once(client, scanner, make_mod, monkeypatch):
    """批量写盘必须一次完成：apply 只调用一次 set_mods_states。"""
    make_mod('a.vpk')
    make_mod('b.vpk')
    pid = _create_pack(client, ['a.vpk', 'b.vpk'], disabled=['b.vpk'])

    calls = []
    orig = scanner.set_mods_states

    def wrapped(states):
        calls.append(dict(states))
        return orig(states)

    monkeypatch.setattr(scanner, 'set_mods_states', wrapped)

    res = client.post(f'/api/packs/{pid}/apply', json={})
    assert res.status_code == 200
    assert len(calls) == 1, f'set_mods_states 被调用 {len(calls)} 次，应该只写一次盘'
    assert calls[0] == {'a.vpk': True, 'b.vpk': False}


def test_apply_disable_others_closes_outside_enabled_mods(client, scanner, make_mod):
    make_mod('a.vpk')
    make_mod('b.vpk')
    make_mod('c.vpk')
    # 先把包外的 c 打开（模拟上一个场景残留的启用 Mod）
    scanner.set_mods_states({'c.vpk': True})

    pid = _create_pack(client, ['a.vpk', 'b.vpk'], disabled=['b.vpk'])

    res = client.post(f'/api/packs/{pid}/apply', json={'disable_others': True})
    assert res.status_code == 200
    body = res.json()
    assert body['enable_map']['a.vpk'] is True
    assert body['enable_map']['b.vpk'] is False
    # 包外已启用的 c 被关掉，并在 outside_disabled 里回报
    assert body['enable_map']['c.vpk'] is False
    assert 'c.vpk' in body['outside_disabled']

    states = scanner._read_addonlist()
    assert states.get('c.vpk') is False


def test_apply_disable_others_off_keeps_outside_mods(client, scanner, make_mod):
    make_mod('a.vpk')
    make_mod('c.vpk')
    scanner.set_mods_states({'c.vpk': True})

    pid = _create_pack(client, ['a.vpk'])

    body = client.post(f'/api/packs/{pid}/apply', json={'disable_others': False}).json()
    # 默认不动包外：c 仍是启用
    assert body['outside_disabled'] == []
    assert 'c.vpk' not in body['enable_map']
    assert scanner._read_addonlist().get('c.vpk') is True


def test_apply_reports_missing_members(client, make_mod):
    make_mod('a.vpk')
    pid = _create_pack(client, ['a.vpk', 'ghost.vpk'])

    body = client.post(f'/api/packs/{pid}/apply', json={}).json()
    assert 'ghost.vpk' in body['missing']
    assert body['enable_map'].get('a.vpk') is True
    assert 'ghost.vpk' not in body['enable_map']


def test_apply_missing_pack_returns_404(client):
    res = client.post('/api/packs/nope/apply', json={})
    assert res.status_code == 404


# ──────────────────────────────────────────────────────────────────────────
# POST /api/packs/{id}/toggle（旧行为兼容）
# ──────────────────────────────────────────────────────────────────────────


def test_toggle_shape_and_behavior_unchanged(client, scanner, make_mod):
    make_mod('a.vpk')
    make_mod('b.vpk')
    pid = _create_pack(client, ['a.vpk', 'b.vpk'])

    first = client.post(f'/api/packs/{pid}/toggle', json={})
    assert first.status_code == 200
    body = first.json()
    assert set(body) >= {'status', 'enable', 'changed', 'missing', 'updated'}
    assert body['status'] == 'ok'
    # 默认全启用 → 一次 toggle 变全禁用
    assert body['enable'] is False
    assert body['changed'] == 2
    assert body['missing'] == []
    assert body['updated'] == {'a.vpk': False, 'b.vpk': False}

    second = client.post(f'/api/packs/{pid}/toggle', json={}).json()
    assert second['enable'] is True
    assert second['updated'] == {'a.vpk': True, 'b.vpk': True}


def test_toggle_explicit_enable(client, scanner, make_mod):
    make_mod('a.vpk')
    pid = _create_pack(client, ['a.vpk'])

    body = client.post(f'/api/packs/{pid}/toggle', json={'enable': False}).json()
    assert body['enable'] is False
    assert scanner._read_addonlist().get('a.vpk') is False


def test_toggle_empty_pack_is_noop(client):
    pid = client.post('/api/packs', json={'name': '空包'}).json()['pack']['id']
    body = client.post(f'/api/packs/{pid}/toggle', json={}).json()
    assert body == {'status': 'ok', 'enable': False, 'changed': 0, 'missing': [], 'updated': {}}


def test_toggle_missing_pack_returns_404(client):
    assert client.post('/api/packs/nope/toggle', json={}).status_code == 404
