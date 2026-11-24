"""ModScanner：addonlist.txt 写盘兜底（自动历史快照 + 一键回滚）。"""
import shutil

import pytest

from services import mod_scanner as ms


def _clean_history():
    shutil.rmtree(ms._ADDONLIST_HISTORY_DIR, ignore_errors=True)


def _addonlist_path(addons_dir):
    return addons_dir.parent / 'addonlist.txt'


def test_写盘前自动快照旧内容(scanner, make_mod, addons_dir):
    _clean_history()
    make_mod('a.vpk')
    make_mod('b.vpk')
    scanner.scan_mods()
    # 文件还不存在：首次写盘没有可备份的旧内容
    scanner._write_addonlist({'a.vpk': True, 'b.vpk': True})
    assert scanner.list_addonlist_backups() == []
    # 再改状态：覆盖前应把旧的（a、b 都启用）快照下来
    scanner._write_addonlist({'a.vpk': False, 'b.vpk': True})
    backs = scanner.list_addonlist_backups()
    assert len(backs) == 1
    assert backs[0]['entries'] == 2
    assert backs[0]['created_at']
    text = _addonlist_path(addons_dir).read_text(encoding='utf-8')
    assert '"a.vpk"' in text and '"0"' in text


def test_内容相同的连续写盘不重复快照(scanner, make_mod):
    _clean_history()
    make_mod('a.vpk')
    scanner.scan_mods()
    scanner._write_addonlist({'a.vpk': True})     # 建文件
    scanner._write_addonlist({'a.vpk': False})    # 快照 {a:1}
    n = len(scanner.list_addonlist_backups())
    scanner._write_addonlist({'a.vpk': False})    # 快照 {a:0}（与最新不同）
    assert len(scanner.list_addonlist_backups()) == n + 1
    m = len(scanner.list_addonlist_backups())
    scanner._write_addonlist({'a.vpk': False})    # 内容相同 → 去重
    assert len(scanner.list_addonlist_backups()) == m


def test_一键回滚把旧内容写回且可再回滚(scanner, make_mod, addons_dir):
    _clean_history()
    make_mod('a.vpk')
    make_mod('b.vpk')
    scanner.scan_mods()
    scanner._write_addonlist({'a.vpk': True, 'b.vpk': True})   # 建文件 a=1,b=1
    scanner._write_addonlist({'a.vpk': False, 'b.vpk': True})  # 快照 a=1,b=1；文件 a=0
    older = scanner.list_addonlist_backups()[0]['id']
    # 模拟游戏/外部把文件改成 a=1,b=0
    _addonlist_path(addons_dir).write_text(
        '"AddonList"\n{\n\t"a.vpk"\t\t"1"\n\t"b.vpk"\t\t"0"\n}\n', encoding='utf-8'
    )
    result = scanner.restore_addonlist_backup(older)
    assert result['status'] == 'ok' and result['restored_from'] == older
    restored = scanner._read_addonlist()
    assert restored['a.vpk'] is True and restored['b.vpk'] is True
    # 回滚前也留了当前（a=1,b=0）的快照，历史只增不减
    assert len(scanner.list_addonlist_backups()) >= 2


def test_非法备份标识被拒绝(scanner):
    _clean_history()
    for bad in (
        '..\\evil.txt',
        'addonlist-.txt',
        '../addonlist-20200101-000000-000000-deadbeef.txt',
    ):
        with pytest.raises(ValueError):
            scanner.restore_addonlist_backup(bad)


def test_不存在的备份报_FileNotFoundError(scanner):
    _clean_history()
    with pytest.raises(FileNotFoundError):
        scanner.restore_addonlist_backup('addonlist-19700101-000000-000000-deadbeef.txt')


def test_历史快照轮转保留上限(scanner, make_mod, addons_dir):
    _clean_history()
    make_mod('a.vpk')
    scanner.scan_mods()
    path = _addonlist_path(addons_dir)
    for i in range(ms.ADDONLIST_HISTORY_LIMIT + 5):
        path.write_text(
            '"AddonList"\n{\n\t"a.vpk"\t\t"1"\n\t"pad%d.vpk"\t\t"1"\n}\n' % i,
            encoding='utf-8',
        )
        scanner._snapshot_current_addonlist(path)
    assert len(scanner.list_addonlist_backups()) == ms.ADDONLIST_HISTORY_LIMIT


def test_api_列出与回滚备份(client, scanner, make_mod):
    _clean_history()
    make_mod('a.vpk')
    make_mod('b.vpk')
    scanner.scan_mods()
    scanner._write_addonlist({'a.vpk': True, 'b.vpk': True})
    scanner._write_addonlist({'a.vpk': False, 'b.vpk': True})

    res = client.get('/api/mods/addonlist-backups')
    assert res.status_code == 200
    backs = res.json()['backups']
    assert len(backs) == 1
    bid = backs[0]['id']

    res2 = client.post(f'/api/mods/addonlist-backups/{bid}/restore')
    assert res2.status_code == 200
    assert res2.json()['restored_from'] == bid
    assert scanner._read_addonlist()['a.vpk'] is True

    # 非法 id → 400
    assert client.post('/api/mods/addonlist-backups/evil/restore').status_code == 400
