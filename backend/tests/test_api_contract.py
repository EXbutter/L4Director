"""路由契约：路径表快照 + 各域端点的基本行为。

路由表快照的作用：拆 router 这类「纯搬运」的改动最容易悄悄丢一条路由（或把
`/api/mods/{name}` 写成 `/api/mods/{mod_name}` 导致前端 404），而 TypeScript 与
运行时都不会报错。快照一挂，改的人立刻知道少了哪条。

快照更新方式：确认改动是**有意**的之后，重新生成 backend/tests/routes_snapshot.json
（见 tests/README 或 TESTING.md）。
"""
import json
from pathlib import Path

import pytest

SNAPSHOT_PATH = Path(__file__).resolve().parent / 'routes_snapshot.json'


def app_routes(app) -> list[str]:
    rows = []
    for route in app.routes:
        methods = getattr(route, 'methods', None)
        if not methods:
            continue
        for method in sorted(methods):
            if method in ('HEAD', 'OPTIONS'):
                continue
            rows.append(f'{method} {route.path}')
    return sorted(rows)


def test_路由表与快照一致(monkeypatch):
    import app_state
    import main as backend_main
    from fastapi.testclient import TestClient  # noqa: F401  (确保依赖可用)

    expected = json.loads(SNAPSHOT_PATH.read_text(encoding='utf-8'))
    actual = app_routes(backend_main.create_app())

    added = sorted(set(actual) - set(expected))
    removed = sorted(set(expected) - set(actual))
    assert not added and not removed, (
        f'路由表变了：新增 {added}，缺失 {removed}。'
        f'确认是有意改动后重新生成 {SNAPSHOT_PATH.name}'
    )


def test_健康检查带版本号(client):
    from app_state import APP_VERSION

    res = client.get('/api/health')
    assert res.status_code == 200
    assert res.json() == {'status': 'ok', 'version': APP_VERSION}


def test_mod_列表(client, make_mod):
    make_mod('alpha.vpk', title='Alpha Skin')
    make_mod('beta.vpk', title='Beta Skin')

    res = client.get('/api/mods')
    assert res.status_code == 200
    body = res.json()
    assert body['count'] == 2
    names = {m['name'] for m in body['mods']}
    assert names == {'alpha.vpk', 'beta.vpk'}
    # 前端 store 依赖这些字段存在
    first = body['mods'][0]
    for key in ('name', 'display_name', 'path', 'size_bytes', 'enabled',
                'is_workshop', 'tags', 'conflicts'):
        assert key in first, key


def test_切换_mod_状态(client, make_mod):
    make_mod('alpha.vpk')

    res = client.post('/api/mods/alpha.vpk/toggle')
    assert res.status_code == 200
    assert res.json()['enabled'] is False

    res = client.post('/api/mods/alpha.vpk/toggle')
    assert res.json()['enabled'] is True


def test_切换不存在的_mod_返回_404(client):
    res = client.post('/api/mods/not-exist.vpk/toggle')
    assert res.status_code == 404


def test_scan_status_在未配置路径时报_not_configured(client, monkeypatch):
    import app_state
    from services.mod_scanner import ModScanner

    fresh = ModScanner()
    fresh._addons_path = None
    monkeypatch.setattr(app_state, 'scanner', fresh)

    assert client.get('/api/mods/scan-status').json()['reason'] == 'not_configured'


def test_scan_status_首扫后归于安静(client, make_mod, monkeypatch):
    import routers.mods as mods_router

    monkeypatch.setattr(mods_router, '_scan_status_sig', {'sig': None, 'at': 0.0})
    make_mod('alpha.vpk')

    first = client.get('/api/mods/scan-status').json()
    assert first['changed'] is True
    assert first['reason'] in ('no_previous_scan', 'files_changed')

    client.get('/api/mods')                    # 触发一次真实扫描，把清单落盘
    monkeypatch.setattr(mods_router, '_scan_status_sig', {'sig': None, 'at': 0.0})
    assert client.get('/api/mods/scan-status').json()['reason'] == 'no_changes'


def test_缩略图接口拒绝越权路径(client, tmp_path):
    secret = tmp_path / 'secret.txt'
    secret.write_text('不该被读到', encoding='utf-8')

    # 非图片扩展名
    assert client.get('/api/thumbnail', params={'path': str(secret)}).status_code == 403

    # 不存在的文件
    assert client.get('/api/thumbnail', params={'path': str(tmp_path / 'nope.jpg')}).status_code == 404

    # 带目录成分的封面名（路径穿越）
    assert client.get('/api/thumbnail', params={'vpk_cover': '../../secret.jpg'}).status_code == 404

    # 两个参数都没给
    assert client.get('/api/thumbnail').status_code == 400


def test_工坊缩略图拒绝带目录的文件名(client):
    res = client.get('/api/thumbnail/workshop/..%2Faddonlist.txt')
    assert res.status_code in (400, 404)


def test_批量缩略图返回空列表(client):
    assert client.post('/api/thumbnails/batch', json={'covers': []}).json() == {'thumbnails': []}


def test_整合包增删改查(client):
    created = client.post('/api/packs', json={'name': '测试包'})
    assert created.status_code == 200
    pack = created.json()['pack']
    pack_id = pack['id']
    assert pack['name'] == '测试包'

    updated = client.put(f'/api/packs/{pack_id}', json={'name': '改名了', 'mod_ids': ['a.vpk']})
    assert updated.status_code == 200

    listed = client.get('/api/packs').json()
    assert [p['name'] for p in listed['packs']] == ['改名了']

    assert client.delete(f'/api/packs/{pack_id}').status_code == 200
    assert client.get('/api/packs').json()['packs'] == []


def test_设置_addons_路径会回报_vpk_数量(client, addons_dir, make_mod, monkeypatch):
    import routers.settings as settings_router

    class _StubUpdates:
        def maybe_auto_check(self, _path):
            return None

    monkeypatch.setattr(settings_router, 'wsu', lambda: _StubUpdates())
    make_mod('alpha.vpk')
    make_mod('beta.vpk')

    res = client.post('/api/settings/addons-path', json={'path': str(addons_dir)})
    assert res.status_code == 200
    body = res.json()
    assert body['addons_path'] == str(addons_dir).replace('\\', '\\')
    assert body['vpk_count'] == 2

    assert client.get('/api/settings').json()['addons_path'] == str(addons_dir)


def test_自定义标签的增删(client):
    res = client.post('/api/custom-tags', json={'name': '待测试'})
    assert res.status_code == 200
    assert res.json()['tags'] == ['待测试']

    # 重名幂等
    assert client.post('/api/custom-tags', json={'name': '待测试'}).json()['tags'] == ['待测试']

    assert client.delete('/api/custom-tags/待测试').status_code == 200
    assert client.get('/api/custom-tags').json()['tags'] == []


def test_游戏状态接口字段齐全(client, monkeypatch):
    from services import game_process

    monkeypatch.setattr(game_process, 'detect_game_process', lambda: (False, None))
    game_process._game_status_cache.update({'time': 0.0, 'running': False, 'pid': None})

    body = client.get('/api/game/status').json()
    assert body['running'] is False
    assert body['process'] == 'left4dead2.exe'
    assert body['pending_reapply'] is False


def test_状态接口汇总扫描性能(client, make_mod):
    make_mod('alpha.vpk')

    body = client.get('/api/status').json()
    assert body['mod_count'] == 1
    assert body['addons_configured'] is True
    assert body['last_scan_perf'] is not None
    assert body['last_scan_perf']['mods'] == 1


def test_缓存统计接口字段齐全(client):
    body = client.get('/api/cache/stats').json()
    assert set(body) >= {'total_bytes', 'total_files', 'dirs'}
    assert set(body['dirs']) == {'covers', 'index', 'metadata', 'manifests'}


def test_apply_state_接口(client):
    body = client.get('/api/mods/apply-state').json()
    assert set(body) >= {'dirty'}


def test_日志导出返回可解压的_zip(client):
    """export_logs 里有一段「按平台收集日志」的逻辑，拆分时清掉了函数内的重复
    import，这条用例保证它没有因此 NameError。"""
    res = client.get('/api/logs/export')
    assert res.status_code == 200
    assert res.content[:2] == b'PK'
    assert res.headers['content-type'].startswith('application/zip')


def test_导出空整合包报_400(client):
    created = client.post('/api/packs', json={'name': '空包'}).json()['pack']
    res = client.post('/api/packs/export', json={'pack_id': created['id']})
    assert res.status_code == 400
    assert '没有 Mod' in res.json()['detail']


def test_日志导出返回可解压的_zip(client):
    """export_logs 里有一段「按平台收集日志」的逻辑，拆分时清掉了函数内的重复
    import，这条用例保证它没有因此 NameError。"""
    res = client.get('/api/logs/export')
    assert res.status_code == 200
    assert res.content[:2] == b'PK'
    assert res.headers['content-type'].startswith('application/zip')


def test_导出空整合包报_400(client):
    created = client.post('/api/packs', json={'name': '空包'}).json()['pack']
    res = client.post('/api/packs/export', json={'pack_id': created['id']})
    assert res.status_code == 400
    assert '没有 Mod' in res.json()['detail']


def test_mod_列表带闪退风险字段(client, addons_dir):
    """崩溃风险是独立信号：两个包可以没有任何路径冲突，但装在一起会崩。"""
    from support import vpkbuild

    # A 只带模型的一半（.mdl + .vvd），B 只带 .vtx —— 没有一条相同路径
    vpkbuild.write_vpk(addons_dir / 'a.vpk', {
        'addoninfo.txt': vpkbuild.addoninfo('A'),
        'models/props/test/tree.mdl': b'mdl-a',
        'models/props/test/tree.vvd': b'vvd-a',
    })
    vpkbuild.write_vpk(addons_dir / 'b.vpk', {
        'addoninfo.txt': vpkbuild.addoninfo('B'),
        'models/props/test/tree.vtx': b'vtx-b',
    })

    mods = {m['name']: m for m in client.get('/api/mods').json()['mods']}
    a = mods['a.vpk']
    assert a['crash_risk'] == 'high'
    assert a['crash_with'] == 'b.vpk'
    assert a['crash_bundle'] == 'models/props/test/tree'
    assert any(f.endswith('.vtx') for f in a['crash_files'])
    assert a['crash_reason']


def test_冲突条目带类型与具体文件(client, addons_dir):
    """提示要能说清「这是什么冲突、哪几个文件」。"""
    from support import vpkbuild

    shared = 'models/w_models/weapons/w_m60.mdl'
    vpkbuild.write_vpk(addons_dir / 'a.vpk', {
        'addoninfo.txt': vpkbuild.addoninfo('A'),
        shared: b'm60-a',
        'materials/models/weapons/w_m60/body.vmt': b'vmt-a',
        'sound/weapons/m60/fire.wav': b'wav-a',
    })
    vpkbuild.write_vpk(addons_dir / 'b.vpk', {
        'addoninfo.txt': vpkbuild.addoninfo('B'),
        shared: b'm60-b',
        'materials/models/weapons/w_m60/body.vmt': b'vmt-b',
        'sound/weapons/m60/fire.wav': b'wav-b',
    })

    mods = {m['name']: m for m in client.get('/api/mods').json()['mods']}
    a = mods['a.vpk']
    # 测试环境没有游戏本体 → 官方基准缺失 → 这些重叠只能判 soft（进 hints），
    # 但类型/文件/风险这些字段必须齐备
    detail = (a['conflict_details'] or a['conflict_hints'])[0]
    assert detail['kind'] in ('model', 'material', 'sound')
    assert detail['kind_label']
    assert detail['count'] >= 2
    assert all('/' in f for f in detail['files'])
    assert detail['risk'] in ('high', 'medium', 'low')
    assert isinstance(detail['kinds'], dict)
    advice = detail['advice']
    assert advice['action'] in ('disable', 'keep_one', 'disable_all', 'ignore')
    advice = detail['advice']
    assert advice['action'] in ('disable', 'keep_one', 'disable_all', 'ignore')


def test_mod_列表带闪退风险字段(client, addons_dir):
    """崩溃风险是独立信号：两个包可以没有任何路径冲突，但装在一起会崩。"""
    from support import vpkbuild

    # A 只带模型的一半（.mdl + .vvd），B 只带 .vtx —— 没有一条相同路径
    vpkbuild.write_vpk(addons_dir / 'a.vpk', {
        'addoninfo.txt': vpkbuild.addoninfo('A'),
        'models/props/test/tree.mdl': b'mdl-a',
        'models/props/test/tree.vvd': b'vvd-a',
    })
    vpkbuild.write_vpk(addons_dir / 'b.vpk', {
        'addoninfo.txt': vpkbuild.addoninfo('B'),
        'models/props/test/tree.vtx': b'vtx-b',
    })

    mods = {m['name']: m for m in client.get('/api/mods').json()['mods']}
    a = mods['a.vpk']
    assert a['crash_risk'] == 'high'
    assert a['crash_with'] == 'b.vpk'
    assert a['crash_bundle'] == 'models/props/test/tree'
    assert any(f.endswith('.vtx') for f in a['crash_files'])
    assert a['crash_reason']


def test_冲突条目带类型与具体文件(client, addons_dir):
    """提示要能说清「这是什么冲突、哪几个文件」。"""
    from support import vpkbuild

    shared = 'models/w_models/weapons/w_m60.mdl'
    vpkbuild.write_vpk(addons_dir / 'a.vpk', {
        'addoninfo.txt': vpkbuild.addoninfo('A'),
        shared: b'm60-a',
        'materials/models/weapons/w_m60/body.vmt': b'vmt-a',
        'sound/weapons/m60/fire.wav': b'wav-a',
    })
    vpkbuild.write_vpk(addons_dir / 'b.vpk', {
        'addoninfo.txt': vpkbuild.addoninfo('B'),
        shared: b'm60-b',
        'materials/models/weapons/w_m60/body.vmt': b'vmt-b',
        'sound/weapons/m60/fire.wav': b'wav-b',
    })

    mods = {m['name']: m for m in client.get('/api/mods').json()['mods']}
    a = mods['a.vpk']
    # 测试环境没有游戏本体 → 官方基准缺失 → 这些重叠只能判 soft（进 hints），
    # 但类型/文件/风险这些字段必须齐备
    detail = (a['conflict_details'] or a['conflict_hints'])[0]
    assert detail['kind'] in ('model', 'material', 'sound')
    assert detail['kind_label']
    assert detail['count'] >= 2
    assert all('/' in f for f in detail['files'])
    assert detail['risk'] in ('high', 'medium', 'low')
    assert isinstance(detail['kinds'], dict)
    advice = detail['advice']
    assert advice['action'] in ('disable', 'keep_one', 'disable_all', 'ignore')
    advice = detail['advice']
    assert advice['action'] in ('disable', 'keep_one', 'disable_all', 'ignore')
