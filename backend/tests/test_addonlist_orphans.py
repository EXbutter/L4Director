"""ModScanner：addonlist.txt 卫生（孤儿条目检测 + 一键清理）。"""
import shutil

import pytest

from services import mod_scanner as ms


def _clean_history():
    shutil.rmtree(ms._ADDONLIST_HISTORY_DIR, ignore_errors=True)


def _write_addonlist(addons_dir, entries: dict):
    lines = ['"AddonList"', '{']
    for key, value in entries.items():
        lines.append(f'\t"{key}"\t\t"{1 if value else 0}"')
    lines.append('}')
    (addons_dir.parent / 'addonlist.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def test_检测孤儿条目(scanner, make_mod, addons_dir):
    _clean_history()
    make_mod('a.vpk')
    make_mod('b.vpk')
    scanner.scan_mods()
    _write_addonlist(addons_dir, {'a.vpk': True, 'b.vpk': True, 'ghost.vpk': True})
    info = scanner.get_addonlist_orphans()
    assert info['orphans'] == ['ghost.vpk']
    assert info['total'] == 3
    assert info['present'] == 2


def test_清理孤儿条目并保留正常行(scanner, make_mod, addons_dir):
    _clean_history()
    make_mod('a.vpk')
    make_mod('b.vpk')
    scanner.scan_mods()
    _write_addonlist(addons_dir, {'a.vpk': True, 'b.vpk': False, 'ghost.vpk': True})

    res = scanner.clean_addonlist_orphans()
    assert res['removed'] == ['ghost.vpk']
    assert res['removed_count'] == 1
    assert res['remaining'] == 0

    body = (addons_dir.parent / 'addonlist.txt').read_text(encoding='utf-8')
    assert 'ghost.vpk' not in body
    assert '"a.vpk"' in body and '"b.vpk"' in body
    assert scanner._read_addonlist() == {'a.vpk': True, 'b.vpk': False}


def test_没有孤儿时清理是空操作(scanner, make_mod, addons_dir):
    _clean_history()
    make_mod('a.vpk')
    scanner.scan_mods()
    _write_addonlist(addons_dir, {'a.vpk': True})
    res = scanner.clean_addonlist_orphans()
    assert res['removed_count'] == 0
    assert res['remaining'] == 0
    # 空操作不应写盘，也不应产生快照
    assert scanner.list_addonlist_backups() == []


def test_清理前留快照_可回滚(scanner, make_mod, addons_dir):
    _clean_history()
    make_mod('a.vpk')
    scanner.scan_mods()
    _write_addonlist(addons_dir, {'a.vpk': True, 'ghost.vpk': True})
    scanner.clean_addonlist_orphans()
    backs = scanner.list_addonlist_backups()
    assert len(backs) == 1
    scanner.restore_addonlist_backup(backs[0]['id'])
    assert 'ghost.vpk' in scanner._read_addonlist()


def test_addonlist_不存在时报错(scanner, addons_dir):
    _clean_history()
    p = addons_dir.parent / 'addonlist.txt'
    if p.exists():
        p.unlink()
    with pytest.raises(FileNotFoundError):
        scanner.clean_addonlist_orphans()


def test_未配置_addons_目录(scanner, monkeypatch):
    _clean_history()
    monkeypatch.setattr(scanner, '_addons_path', None)
    assert scanner.get_addonlist_orphans() == {'orphans': [], 'total': 0, 'present': 0}
    with pytest.raises(ValueError):
        scanner.clean_addonlist_orphans()


def test_api_孤儿检测与清理(client, scanner, make_mod, addons_dir):
    _clean_history()
    make_mod('a.vpk')
    scanner.scan_mods()
    _write_addonlist(addons_dir, {'a.vpk': True, 'ghost.vpk': True})

    r = client.get('/api/mods/addonlist-orphans')
    assert r.status_code == 200
    assert r.json()['orphans'] == ['ghost.vpk']

    r2 = client.post('/api/mods/addonlist-clean-orphans')
    assert r2.status_code == 200
    assert r2.json()['removed_count'] == 1

    assert client.get('/api/mods/addonlist-orphans').json()['orphans'] == []
