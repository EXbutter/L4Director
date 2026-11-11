"""验证「游戏里改 mod 启用/禁用」能被检测到、并由用户确认后同步进软件。

背景
----
用户反馈：**游戏里改 mod 启用/禁用无法同步到软件里**，且希望软件在检测到游戏内改动时
弹出「检测到游戏内已更改，是否同步」，由用户决定，而不是自动覆盖任何一边的设置。

根因
----
软件把「用户设置过的启用状态」持久化为权威来源（`data.json` 的
`mod_metas[*].enabled`），而 `_resolve_enabled()` 无条件优先返回它；而
`addonlist.txt` 恰恰是游戏退出时把启停改动写回的位置。于是：

    游戏里启用 A → addonlist.txt 里 A=1 → 软件仍按旧记录显示「禁用」

实现
----
软件每次写 `addonlist.txt` 都记录「内容指纹」，据此判断文件是否被软件以外的程序改过：

  * 指纹一致 → 文件是软件自己写的 → 不算改动；
  * 指纹不一致 → 文件被外部改过（游戏里启停 / Steam 云 / 手动编辑）→
    由 `get_pending_addonlist_changes()` 报出「待确认的变更」，
    界面弹窗询问：点「同步」→ `apply_addonlist_changes()`；
                点「忽略」→ `dismiss_addonlist_changes()`
                （保持软件设置并把软件里的状态写回文件，之后不再重复提示）。

本脚本在临时目录里复现并验证 10 个场景，**不会读写**用户真实的
`~/.l4d2-manager` 与 addons 目录（HOME 已重定向到临时目录）。
"""
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

# ── 必须在导入项目模块之前隔离缓存目录 ────────────────────────────────────────
# mod_scanner.py / data_store.py 在 import 时就会执行 Path.home() / '.l4d2-manager'
TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-sync-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import data_store as ds  # noqa: E402
from services import mod_scanner as ms  # noqa: E402
# 复用压测脚本里的最小 VPK 写入器（它 import 时才会重定向 HOME，此时项目模块已加载）
import bench_scan  # noqa: E402


def make_vpk(path: Path, title: str):
    """写一个能被扫描器正常解析的最小 VPK。"""
    bench_scan.write_vpk(path, {
        'addoninfo.txt': (
            '"AddonInfo"\n{\n'
            f'\taddontitle "{title}"\n'
            '\taddonversion "1.0"\n'
            '\taddonauthor "Sync Test"\n'
            '}\n'
        ).encode('utf-8'),
        'materials/sync_test.vmt': b'// filler',
    })


# ── 临时 Mod 库：3 个本地 mod + 1 个创意工坊 mod ─────────────────────────────
ROOT = Path(tempfile.mkdtemp(prefix='l4d2-sync-'))
GAME_DIR = ROOT / 'left4dead2'
ADDONS_DIR = GAME_DIR / 'addons'
ADDONS_DIR.mkdir(parents=True)
ADDONLIST = GAME_DIR / 'addonlist.txt'

LOCAL = ['A.vpk', 'B.vpk', '中文名.vpk']
WORKSHOP = ['ws1.vpk']
for name in LOCAL:
    make_vpk(ADDONS_DIR / name, f'Mod {name}')
ws_dir = ADDONS_DIR / 'workshop'
ws_dir.mkdir()
for name in WORKSHOP:
    make_vpk(ws_dir / name, f'Mod {name}')


def write_addonlist(entries: dict, path: Path = ADDONLIST):
    """模拟游戏退出时写回 addonlist.txt（格式与游戏一致：制表符分隔 + 0/1）。"""
    lines = ['"AddonList"', '{']
    for key, value in entries.items():
        lines.append(f'\t"{key}"\t\t"{1 if value else 0}"')
    lines.append('}')
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def game_write(entries: dict):
    """外部（游戏）改写文件：值与软件记录不同时才会被采纳。"""
    write_addonlist(entries, ADDONLIST)


def current_entries() -> dict:
    """当前 addonlist.txt 里的条目（模拟游戏把内存里的列表整体写回）。"""
    return dict(scanner._read_addonlist())


ALL_ON = {n: True for n in LOCAL}
ALL_ON.update({f'workshop/{n}': True for n in WORKSHOP})
write_addonlist(ALL_ON)

scanner = ms.ModScanner()
scanner._addons_path = str(ADDONS_DIR)
scanner.invalidate_mod_enabled_cache()


def ui_state(name: str) -> bool:
    """界面看到的状态（与扫描器内部同一套取数逻辑）。"""
    addonlist = scanner._read_addonlist()
    key = f'workshop\\{name}' if name in WORKSHOP else name
    return scanner._resolve_enabled(name, key, addonlist)


def file_state(name: str) -> bool:
    key = f'workshop\\{name}' if name in WORKSHOP else name
    return scanner._read_addonlist()[key]


def rescan():
    """走完整扫描入口（解析 VPK 并回填 enabled）。"""
    return {m.name: m.enabled for m in scanner.scan_mods()}


def pending_names() -> list:
    """后端报出的「待用户确认的游戏内改动」涉及的 Mod 名。"""
    return [c['name'] for c in scanner.get_pending_addonlist_changes()]


results: list[tuple[bool, str]] = []


def check(desc: str, actual, expected):
    ok = actual == expected
    results.append((ok, desc))
    mark = 'PASS' if ok else 'FAIL'
    print(f'  [{mark}] {desc}  (实际={actual!r} 期望={expected!r})')


print('=' * 78)
print(' 场景 1：软件里禁用 A → 文件与软件配置都记录为「禁用」，且不算「游戏内改动」')
print('=' * 78)
scanner.toggle_mod('A.vpk', enable=False)
check('addonlist.txt 里 A=0', file_state('A.vpk'), False)
check('软件配置里 A=禁用', ds.get_mod_enabled('A.vpk'), False)
check('没有待确认的游戏内改动', pending_names(), [])

print('\n' + '=' * 78)
print(' 场景 2：软件自己写的文件不应被「反向采纳」')
print('=' * 78)
rescan()
check('界面显示 A=禁用', ui_state('A.vpk'), False)
check('软件配置里 A 仍=禁用', ds.get_mod_enabled('A.vpk'), False)
check('依然没有待确认的游戏内改动', pending_names(), [])

print('\n' + '=' * 78)
print(' 场景 3：【用户反馈场景】游戏里启用 A → 应检测到 1 项待确认改动')
print('=' * 78)
entries = current_entries()
entries['A.vpk'] = True          # 游戏里把 A 启用了
game_write(entries)
rescan()
changes = scanner.get_pending_addonlist_changes()
check('检测到 1 项改动', len(changes), 1)
check(
    '改动内容：A 由「禁用」→「启用」',
    (changes[0]['name'], changes[0]['previous'], changes[0]['enabled']) if changes else None,
    ('A.vpk', False, True),
)
check('未确认前界面仍显示 A=禁用（不自动覆盖）', ui_state('A.vpk'), False)

print('\n' + '=' * 78)
print(' 场景 4：用户点「同步」→ 采纳游戏里的改动')
print('=' * 78)
check('同步条目数=1', scanner.apply_addonlist_changes(), 1)
check('界面显示 A=启用', ui_state('A.vpk'), True)
check('软件配置里 A=启用', ds.get_mod_enabled('A.vpk'), True)
check('同步后不再有待确认改动', pending_names(), [])

print('\n' + '=' * 78)
print(' 场景 5：用户点「忽略」→ 保持软件设置，且不再重复提示')
print('=' * 78)
scanner.toggle_mod('B.vpk', enable=True)        # 软件里 B=启用
entries = current_entries()
entries['B.vpk'] = False                        # 游戏里把 B 禁用了
game_write(entries)
rescan()
check('检测到 B 的改动', pending_names(), ['B.vpk'])
check('忽略条目数=1', scanner.dismiss_addonlist_changes(), 1)
check('界面显示 B 仍=启用（保持软件设置）', ui_state('B.vpk'), True)
check('软件配置里 B 仍=启用', ds.get_mod_enabled('B.vpk'), True)
check('忽略后把软件设置写回文件（文件里 B=启用）', file_state('B.vpk'), True)
check('忽略后不再重复提示', pending_names(), [])

print('\n' + '=' * 78)
print(' 场景 6：Steam 云回滚出「缺少条目的旧文件」→ 不应产生待确认改动')
print('=' * 78)
scanner.toggle_mod('B.vpk', enable=False)
entries = current_entries()
del entries['B.vpk']                                   # 旧文件里没有 B 这一条
game_write(entries)
rescan()
check('没有待确认改动', pending_names(), [])
check('界面显示 B 仍=禁用（没有被推定成启用）', ui_state('B.vpk'), False)

print('\n' + '=' * 78)
print(' 场景 7：创意工坊 Mod（workshop/<name>.vpk）同样能检测到')
print('=' * 78)
scanner.toggle_mod('ws1.vpk', enable=True)
entries = current_entries()
entries['workshop\\ws1.vpk'] = False                   # 游戏里禁用了工坊 Mod
game_write(entries)
rescan()
check('检测到 ws1 的改动', pending_names(), ['ws1.vpk'])
check('同步条目数=1', scanner.apply_addonlist_changes(), 1)
check('界面显示 ws1=禁用', ui_state('ws1.vpk'), False)

print('\n' + '=' * 78)
print(' 场景 8：老版本升级上来（没有指纹基线）→ 靠时间判断同样能检测到')
print('=' * 78)
scanner.toggle_mod('中文名.vpk', enable=True)
time.sleep(1.2)                        # 让文件 mtime 明显晚于软件记录时间
ds.set_addonlist_state('')             # 模拟旧版本没有记录过指纹
entries = current_entries()
entries['中文名.vpk'] = False          # 用户在游戏里禁用了它
game_write(entries)
rescan()
check('检测到 中文名 的改动', pending_names(), ['中文名.vpk'])
check('同步条目数=1', scanner.apply_addonlist_changes(), 1)
check('界面显示 中文名=禁用', ui_state('中文名.vpk'), False)

print('\n' + '=' * 78)
print(' 场景 9：未处理（还没点同步/忽略）就直接启动游戏 → 以软件设置为准')
print('=' * 78)
scanner.toggle_mod('A.vpk', enable=False)      # 软件里禁用 A（同时把文件写成 0）
entries = current_entries()
entries['A.vpk'] = True                        # 游戏里把 A 启用了
game_write(entries)
rescan()
check('检测到 A 的改动', pending_names(), ['A.vpk'])
scanner.apply_mod_prefs_to_addonlist()         # 启动游戏前写回软件设置
check('启动前写回后 A=禁用（以软件为准）', file_state('A.vpk'), False)
check('软件配置里 A 仍=禁用', ds.get_mod_enabled('A.vpk'), False)
check('写回后不再有待确认改动', pending_names(), [])

print('\n' + '=' * 78)
failed = [d for ok, d in results if not ok]
print(f' 结果：{len(results) - len(failed)} / {len(results)} 项通过')
for d in failed:
    print(f'   - 未通过：{d}')
print('=' * 78)

# ── 清理临时目录（不动用户真实配置） ────────────────────────────────────────
shutil.rmtree(ROOT, ignore_errors=True)
shutil.rmtree(TEMP_HOME, ignore_errors=True)
shutil.rmtree(bench_scan.BENCH_ROOT, ignore_errors=True)

raise SystemExit(1 if failed else 0)
