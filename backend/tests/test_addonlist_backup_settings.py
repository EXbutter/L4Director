"""ModScanner / API：addonlist.txt 备份设置（定时开关/间隔/数量）+ 导出/导入。"""
import base64
import shutil

from services import mod_scanner as ms


def _clean_history():
    shutil.rmtree(ms._ADDONLIST_HISTORY_DIR, ignore_errors=True)


def _addonlist_path(addons_dir):
    return addons_dir.parent / 'addonlist.txt'


def test_备份设置默认值与范围夹紧(client):
    res = client.get('/api/mods/addonlist-backup-settings')
    assert res.status_code == 200
    cfg = res.json()
    assert cfg['enabled'] is True
    assert cfg['interval_min'] == 30
    assert cfg['limit'] == ms.ADDONLIST_HISTORY_LIMIT
    assert isinstance(cfg['folder'], str) and cfg['folder']
    assert cfg['count'] == 0

    # 超范围会被夹紧：间隔最小 1 分钟、数量最大 200
    res2 = client.post('/api/mods/addonlist-backup-settings',
                       json={'enabled': False, 'interval_min': 0, 'limit': 9999})
    assert res2.status_code == 200
    cfg2 = res2.json()
    assert cfg2['enabled'] is False
    assert cfg2['interval_min'] == 1
    assert cfg2['limit'] == 200

    # 正常值原样保存
    res3 = client.post('/api/mods/addonlist-backup-settings',
                       json={'interval_min': 15, 'limit': 10})
    cfg3 = res3.json()
    assert cfg3['interval_min'] == 15 and cfg3['limit'] == 10


def test_导出再导入往返且写前备份(client, scanner, make_mod, addons_dir):
    _clean_history()
    make_mod('a.vpk')
    make_mod('b.vpk')
    scanner.scan_mods()
    scanner._write_addonlist({'a.vpk': True, 'b.vpk': True})
    original = _addonlist_path(addons_dir).read_bytes()

    res = client.get('/api/mods/addonlist-export')
    assert res.status_code == 200
    payload = res.json()
    assert payload['entries'] == 2
    assert base64.b64decode(payload['content_b64']) == original
    assert payload['default_name'].endswith('.txt')

    before = len(scanner.list_addonlist_backups())
    # 外部把文件改成 a=0，再导入原备份
    _addonlist_path(addons_dir).write_text(
        '"AddonList"\n{\n\t"a.vpk"\t\t"0"\n\t"b.vpk"\t\t"1"\n}\n', encoding='utf-8'
    )
    got = client.post('/api/mods/addonlist-import',
                      json={'content_b64': payload['content_b64']})
    assert got.status_code == 200
    assert got.json()['entries'] == 2
    assert scanner._read_addonlist()['a.vpk'] is True
    assert _addonlist_path(addons_dir).read_bytes() == original
    # 导入前给「被覆盖的当前内容」留了快照，可撤销
    assert len(scanner.list_addonlist_backups()) > before


def test_导入非法或空内容被拒绝(client):
    assert client.post('/api/mods/addonlist-import', json={}).status_code == 400
    assert client.post('/api/mods/addonlist-import',
                       json={'content_b64': '@@@not-base64@@@'}).status_code == 400


def test_立即备份与去重(client, scanner, make_mod):
    _clean_history()
    make_mod('a.vpk')
    scanner.scan_mods()
    scanner._write_addonlist({'a.vpk': True})  # 建文件（首次写盘无旧内容可备份）

    r1 = client.post('/api/mods/addonlist-backup-now')
    assert r1.status_code == 200
    n = len(scanner.list_addonlist_backups())
    assert n == 1

    # 内容没变 → 去重，不新增
    client.post('/api/mods/addonlist-backup-now')
    assert len(scanner.list_addonlist_backups()) == n


def test_未配置目录时相关接口报错(client, scanner, monkeypatch):
    """没有 addons 目录时导出/立即备份应明确报错，而不是 500。"""
    monkeypatch.setattr(scanner, 'get_addons_path', lambda: None)
    assert client.get('/api/mods/addonlist-export').status_code == 400
    assert client.post('/api/mods/addonlist-backup-now').status_code == 400
