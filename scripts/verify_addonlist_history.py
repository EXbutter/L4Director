"""验证 addonlist.txt 的「写盘兜底：自动历史快照 + 一键回滚」。

背景
----
addonlist.txt 是游戏的启停清单，软件会反复覆盖它；而游戏退出 / Steam 云同步也会
反向覆盖。1.3.4 只给 data.json 留了单份 .bak，addonlist.txt 一旦被写错或被外部改坏，
用户没有任何回滚手段。本版补上：软件每次覆盖前先把旧内容存一份历史快照（去重 +
轮转保留最近 N 份），并支持一键把某份快照写回文件（写回前再留一份当前快照，
所以「回滚」本身也能再回滚）。

本脚本在临时目录里复现并验证，**不读写**用户真实的 `~/.l4d2-manager` 与 addons 目录
（HOME 已重定向到临时目录）。
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

# ── 必须在导入项目模块之前隔离缓存目录 ────────────────────────────────────────
TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-hist-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import mod_scanner as ms  # noqa: E402
import bench_scan  # noqa: E402


def make_vpk(path: Path, title: str):
    bench_scan.write_vpk(path, {
        'addoninfo.txt': (
            '"AddonInfo"\n{\n'
            f'\taddontitle "{title}"\n'
            '\taddonversion "1.0"\n'
            '\taddonauthor "Hist Test"\n'
            '}\n'
        ).encode('utf-8'),
        'materials/hist_test.vmt': b'// filler',
    })


ROOT = Path(tempfile.mkdtemp(prefix='l4d2-hist-'))
GAME_DIR = ROOT / 'left4dead2'
ADDONS_DIR = GAME_DIR / 'addons'
ADDONS_DIR.mkdir(parents=True)
ADDONLIST = GAME_DIR / 'addonlist.txt'

for name in ('A.vpk', 'B.vpk'):
    make_vpk(ADDONS_DIR / name, f'Mod {name}')


def write_addonlist(entries: dict, path: Path = ADDONLIST):
    lines = ['"AddonList"', '{']
    for key, value in entries.items():
        lines.append(f'\t"{key}"\t\t"{1 if value else 0}"')
    lines.append('}')
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')


scanner = ms.ModScanner()
scanner._addons_path = str(ADDONS_DIR)
scanner.invalidate_mod_enabled_cache()

results: list[tuple[bool, str]] = []


def check(desc: str, actual, expected):
    ok = actual == expected
    results.append((ok, desc))
    mark = 'PASS' if ok else 'FAIL'
    print(f'  [{mark}] {desc}  (实际={actual!r} 期望={expected!r})')


print('=' * 78)
print(' 场景 1：文件还不存在时首次写盘 → 没有可备份的旧内容，不产生快照')
print('=' * 78)
scanner._write_addonlist({'A.vpk': True, 'B.vpk': True})
check('首次写盘后没有历史快照', scanner.list_addonlist_backups(), [])

print('\n' + '=' * 78)
print(' 场景 2：已有文件时再写盘 → 先把「即将被覆盖」的旧内容存成快照')
print('=' * 78)
scanner._write_addonlist({'A.vpk': False, 'B.vpk': True})
backs = scanner.list_addonlist_backups()
check('产生 1 份历史快照', len(backs), 1)
check('快照里有 2 个条目', backs[0]['entries'] if backs else None, 2)
check('快照带可解析的时间戳', bool(backs[0]['created_at']) if backs else False, True)
check('文件已被写成 A=禁用', scanner._read_addonlist().get('A.vpk'), False)

print('\n' + '=' * 78)
print(' 场景 3：内容没变时连续写盘 → 去重，不重复堆积快照')
print('=' * 78)
scanner._write_addonlist({'A.vpk': False, 'B.vpk': True})   # 快照 {A:0}（与最新不同）
n = len(scanner.list_addonlist_backups())
scanner._write_addonlist({'A.vpk': False, 'B.vpk': True})   # 内容相同 → 去重
check('内容相同不新增快照', len(scanner.list_addonlist_backups()), n)

print('\n' + '=' * 78)
print(' 场景 4：一键回滚 → 把旧快照写回文件')
print('=' * 78)
# 此刻最早的快照是场景 2 写下的「A=1,B=1」；先记下它的 id
first_id = sorted(p.name for p in ms._ADDONLIST_HISTORY_DIR.glob('addonlist-*.txt'))[0]
# 模拟游戏/外部把文件改成 A=1,B=0
write_addonlist({'A.vpk': True, 'B.vpk': False})
check('外部改写后文件是 A=1,B=0',
      (scanner._read_addonlist().get('A.vpk'), scanner._read_addonlist().get('B.vpk')),
      (True, False))
before = len(scanner.list_addonlist_backups())
res = scanner.restore_addonlist_backup(first_id)
check('回滚成功', res.get('status'), 'ok')
check('回滚来源正确', res.get('restored_from'), first_id)
after = scanner._read_addonlist()
check('回滚后文件回到 A=1,B=1', (after.get('A.vpk'), after.get('B.vpk')), (True, True))
check('回滚前也为当前内容留了快照（历史只增不减）',
      len(scanner.list_addonlist_backups()), before + 1)

print('\n' + '=' * 78)
print(' 场景 5：非法 / 不存在的备份标识被拒绝（防路径穿越）')
print('=' * 78)


def expect_exc(exc_type, fn, desc):
    try:
        fn()
    except exc_type:
        check(desc, True, True)
    except Exception as e:  # noqa: BLE001
        check(f'{desc}（实际抛出 {type(e).__name__}）', False, True)
    else:
        check(desc, False, True)


expect_exc(ValueError, lambda: scanner.restore_addonlist_backup('..\\evil.txt'),
           '路径穿越被拒绝')
expect_exc(ValueError, lambda: scanner.restore_addonlist_backup('..%2Faddonlist.txt'),
           '非法文件名被拒绝')
expect_exc(FileNotFoundError,
           lambda: scanner.restore_addonlist_backup('addonlist-19700101-000000-000000-deadbeef.txt'),
           '不存在的备份报 FileNotFoundError')

print('\n' + '=' * 78)
print(' 场景 6：历史快照按上限轮转，不会无限增长')
print('=' * 78)
for i in range(ms.ADDONLIST_HISTORY_LIMIT + 5):
    write_addonlist({'A.vpk': True, 'B.vpk': True, f'pad{i}.vpk': True})
    scanner._snapshot_current_addonlist(ADDONLIST)
check('快照数量不超过上限', len(scanner.list_addonlist_backups()), ms.ADDONLIST_HISTORY_LIMIT)

print('\n' + '=' * 78)
failed = [d for ok, d in results if not ok]
print(f' 结果：{len(results) - len(failed)} / {len(results)} 项通过')
for d in failed:
    print(f'   - 未通过：{d}')
print('=' * 78)

shutil.rmtree(ROOT, ignore_errors=True)
shutil.rmtree(TEMP_HOME, ignore_errors=True)
shutil.rmtree(bench_scan.BENCH_ROOT, ignore_errors=True)

raise SystemExit(1 if failed else 0)
