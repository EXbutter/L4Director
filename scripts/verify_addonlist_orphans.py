"""验证 addonlist.txt 卫生：孤儿条目检测 + 一键清理。

背景
----
addonlist.txt 里可能残留指向「已经不在 addons 目录」的 .vpk 的行（用户手删了包，
或整合包带进来的条目从没落地）。这类孤儿行不会自己消失，会让游戏的加载列表指向
空的包。本脚本验证：
  - 能准确识别孤儿条目（只读，不动文件）；
  - 一键清理只删孤儿行，正常条目 / 头部 / 花括号原样保留；
  - 清理前会自动留历史快照，所以清理也能回滚；
  - 没有孤儿时是空操作（不写盘、不产生快照）。

在临时目录里复现，不读写用户真实的 `~/.l4d2-manager` 与 addons 目录。
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-orphan-home-'))
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
            '\taddonauthor "Orphan Test"\n'
            '}\n'
        ).encode('utf-8'),
        'materials/orphan_test.vmt': b'// filler',
    })


ROOT = Path(tempfile.mkdtemp(prefix='l4d2-orphan-'))
GAME_DIR = ROOT / 'left4dead2'
ADDONS_DIR = GAME_DIR / 'addons'
ADDONS_DIR.mkdir(parents=True)
ADDONLIST = GAME_DIR / 'addonlist.txt'

for name in ('A.vpk', 'B.vpk'):
    make_vpk(ADDONS_DIR / name, f'Mod {name}')


def write_addonlist(entries: dict):
    lines = ['"AddonList"', '{']
    for key, value in entries.items():
        lines.append(f'\t"{key}"\t\t"{1 if value else 0}"')
    lines.append('}')
    ADDONLIST.write_text('\n'.join(lines) + '\n', encoding='utf-8')


scanner = ms.ModScanner()
scanner._addons_path = str(ADDONS_DIR)
scanner.invalidate_mod_enabled_cache()

results: list[tuple[bool, str]] = []


def check(desc: str, actual, expected):
    ok = actual == expected
    results.append((ok, desc))
    print(f'  [{"PASS" if ok else "FAIL"}] {desc}  (实际={actual!r} 期望={expected!r})')


print('=' * 78)
print(' 场景 1：识别出指向不存在 .vpk 的孤儿条目（只读，不动文件）')
print('=' * 78)
write_addonlist({'A.vpk': True, 'B.vpk': False, 'ghost.vpk': True})
before = ADDONLIST.read_bytes()
info = scanner.get_addonlist_orphans()
check('孤儿列表 = [ghost.vpk]', info['orphans'], ['ghost.vpk'])
check('条目总数 = 3', info['total'], 3)
check('现存条目 = 2', info['present'], 2)
check('检测不修改文件', ADDONLIST.read_bytes(), before)

print('\n' + '=' * 78)
print(' 场景 2：一键清理只删孤儿行，正常条目 / 头部 / 花括号原样保留')
print('=' * 78)
res = scanner.clean_addonlist_orphans()
check('清理返回 removed=[ghost.vpk]', res['removed'], ['ghost.vpk'])
check('删除了 1 条', res['removed_count'], 1)
check('清理后无孤儿', res['remaining'], 0)
body = ADDONLIST.read_text(encoding='utf-8')
check('文件里不再有 ghost.vpk', 'ghost.vpk' in body, False)
check('保留了 a.vpk 行', '"A.vpk"' in body, True)
check('保留了 b.vpk 行', '"B.vpk"' in body, True)
check('保留了头部', '"AddonList"' in body, True)
check('文件结构仍是 4 行（头/左括号/2 条目/右括号=5 行）',
      len([ln for ln in body.splitlines() if ln.strip()]), 5)

print('\n' + '=' * 78)
print(' 场景 3：清理前自动留历史快照 → 清理本身也能回滚')
print('=' * 78)
backs = scanner.list_addonlist_backups()
check('清理产生了 1 份历史快照', len(backs), 1)
if backs:
    scanner.restore_addonlist_backup(backs[0]['id'])
    restored = scanner._read_addonlist()
    check('回滚后 ghost.vpk 又回来了', 'ghost.vpk' in restored, True)
    # 回滚会再给「清理后」的当前内容留一份快照
    check('回滚也留了快照', len(scanner.list_addonlist_backups()) >= 2, True)

print('\n' + '=' * 78)
print(' 场景 4：没有孤儿时清理是空操作（不写盘、不产生快照）')
print('=' * 78)
shutil.rmtree(ms._ADDONLIST_HISTORY_DIR, ignore_errors=True)
write_addonlist({'A.vpk': True, 'B.vpk': True})
res2 = scanner.clean_addonlist_orphans()
check('空操作 removed_count = 0', res2['removed_count'], 0)
check('空操作不产生快照', scanner.list_addonlist_backups(), [])

print('\n' + '=' * 78)
print(' 场景 5：异常输入被正确拒绝')
print('=' * 78)
ADDONLIST.unlink()
try:
    scanner.clean_addonlist_orphans()
    check('文件不存在应报 FileNotFoundError', False, True)
except FileNotFoundError:
    check('文件不存在报 FileNotFoundError', True, True)

missing = ms.ModScanner()          # 未配置 addons 路径
try:
    missing.clean_addonlist_orphans()
    check('未配置目录应报 ValueError', False, True)
except ValueError:
    check('未配置目录报 ValueError', True, True)
check('未配置目录时检测为空', missing.get_addonlist_orphans(),
      {'orphans': [], 'total': 0, 'present': 0})

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
