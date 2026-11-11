"""验证「游戏退出后自动以软件设置为准重新应用启停」。

背景（用户反馈）
----
游戏运行期间在软件里禁用 Mod，只是把 addonlist.txt 改成 0；游戏自身的 Add-ons 状态
早在启动时就加载进内存了，退出时会用内存里的旧状态把文件写一遍 —— 于是软件里刚
禁用的几十个 Mod 又变回启用，刷新还会弹「检测到游戏内已更改（已启用）」，用户点了
「同步」就把游戏状态反向采纳进软件，表现就是「怎么都禁不掉」。

修法
----
游戏运行期间改过启停 → 记下 pending_game_reapply 标记；后端在 /api/game/status 检测到
游戏进程消失时，用 apply_mod_prefs_to_addonlist() 把软件设置重新写回文件（并推进指纹），
因此既不会再弹同步询问，禁用也会真正保持住。

覆盖场景
----
1. 游戏运行期间禁用 → 文件/软件都是禁用；
2. 模拟游戏退出写回旧状态 → 检测到 2 项待确认改动（旧流程：弹窗）；
3. 有标记时游戏退出重应用 → 文件回到软件设置、待确认改动清零、标记被清除；
4. 无标记时（用户没在游戏运行期间改过）→ 不自动重应用，仍交给弹窗由用户决定；
5. 标记超过 24 小时视为过期 → 不生效。

隔离：HOME / USERPROFILE 重定向到临时目录，addons 也是临时目录，不触碰真实数据。
报告（UTF-8，便于在 GBK 控制台下回看中文）写入 scripts/_verify_game_exit_out.txt。
"""
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-reapply-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import data_store as ds  # noqa: E402
import bench_scan  # noqa: E402

# bench_scan 在 import 时会把 HOME 指向它自己的压测目录；这里改回来，
# 让稍后 import 的 mod_scanner 与 data_store 使用同一个（临时）缓存目录。
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

import main as backend_main  # noqa: E402

REPORT = Path(__file__).resolve().parent / '_verify_game_exit_out.txt'
lines: list[str] = []
failures = 0


def log(text: str = ''):
    lines.append(text)
    print(text.encode('ascii', 'replace').decode('ascii'))


def check(label: str, actual, expected):
    global failures
    ok = actual == expected
    if not ok:
        failures += 1
    lines.append(f"  [{'OK  ' if ok else 'FAIL'}] {label}: {actual!r}（期望 {expected!r}）")
    print(f"  [{'OK' if ok else 'FAIL'}] {label}")


def make_vpk(path: Path, title: str):
    bench_scan.write_vpk(path, {
        'addoninfo.txt': (
            '"AddonInfo"\n{\n'
            f'\taddontitle "{title}"\n'
            '\taddonversion "1.0"\n'
            '\taddonauthor "Reapply Test"\n'
            '}\n'
        ).encode('utf-8'),
        'materials/reapply_test.vmt': b'// filler',
    })


ROOT = Path(tempfile.mkdtemp(prefix='l4d2-reapply-'))
GAME_DIR = ROOT / 'left4dead2'
ADDONS_DIR = GAME_DIR / 'addons'
ADDONS_DIR.mkdir(parents=True)
ADDONLIST = GAME_DIR / 'addonlist.txt'

LOCAL = ['A.vpk', 'B.vpk']
WORKSHOP = ['ws1.vpk']
for name in LOCAL:
    make_vpk(ADDONS_DIR / name, f'Mod {name}')
ws_dir = ADDONS_DIR / 'workshop'
ws_dir.mkdir()
for name in WORKSHOP:
    make_vpk(ws_dir / name, f'Mod {name}')


def write_addonlist(entries: dict):
    """模拟 addonlist.txt 的写入（游戏格式：制表符分隔 + 0/1）。"""
    out = ['"AddonList"', '{']
    for key, value in entries.items():
        out.append(f'\t"{key}"\t\t"{1 if value else 0}"')
    out.append('}')
    ADDONLIST.write_text('\n'.join(out) + '\n', encoding='utf-8')


ALL_ON = {n: True for n in LOCAL}
ALL_ON.update({f'workshop/{n}': True for n in WORKSHOP})
write_addonlist(ALL_ON)


def key_of(name: str) -> str:
    return f'workshop\\{name}' if name in WORKSHOP else name


scanner = backend_main.scanner           # 复用后端真实实例，确保标记/写入逻辑走同一条路径
scanner._addons_path = str(ADDONS_DIR)
scanner.invalidate_mod_enabled_cache()


def file_state(name: str) -> bool:
    return scanner._read_addonlist()[key_of(name)]


def ui_state(name: str) -> bool:
    addonlist = scanner._read_addonlist()
    return scanner._resolve_enabled(name, key_of(name), addonlist)


def pending_names() -> list:
    return [c['name'] for c in scanner.get_pending_addonlist_changes()]


log('=' * 78)
log(' 场景 1：游戏运行期间在软件里禁用 A / B / ws1（同时打上「待重新应用」标记）')
log('=' * 78)
for name in LOCAL + WORKSHOP:
    scanner.toggle_mod(name, enable=False)
    ds.set_pending_game_reapply(True)   # 等价于 main._mark_pending_reapply_if_game_running()
check('A 文件=禁用', file_state('A.vpk'), False)
check('ws1 文件=禁用', file_state('ws1.vpk'), False)
check('B 界面=禁用', ui_state('B.vpk'), False)
check('待重新应用标记=true', ds.get_pending_game_reapply(), True)

log('')
log('=' * 78)
log(' 场景 2：模拟游戏退出，把内存里的旧状态（全启用）写回文件')
log('=' * 78)
write_addonlist(ALL_ON)
check('A 文件被游戏改回启用', file_state('A.vpk'), True)
pending = pending_names()
check('检测到 3 项待确认改动（旧流程会弹窗）', len(pending), 3)

log('')
log('=' * 78)
log(' 场景 3：后端检测到游戏退出 → 自动以软件设置为准重新应用')
log('=' * 78)
reapplied = backend_main._reapply_prefs_after_game_exit()
check('重应用条目数=3', reapplied, 3)
check('A 文件回到禁用（软件设置生效）', file_state('A.vpk'), False)
check('ws1 文件回到禁用', file_state('ws1.vpk'), False)
check('B 界面=禁用', ui_state('B.vpk'), False)
check('待确认改动已清零（不会再弹「检测到游戏内已更改」）', pending_names(), [])
check('标记已被清除', ds.get_pending_game_reapply(), False)

log('')
log('=' * 78)
log(' 场景 4：用户在游戏里自己改了启停、软件里没动过 → 不自动重应用，仍由弹窗询问')
log('=' * 78)
write_addonlist(ALL_ON)
check('A 文件=启用（游戏内改动）', file_state('A.vpk'), True)
check('检测到 3 项待确认改动（交给用户决定）', len(pending_names()), 3)
check('重应用返回 None（没有标记，不越权覆盖）', backend_main._reapply_prefs_after_game_exit(), None)
check('文件保持游戏写入的内容', file_state('A.vpk'), True)

log('')
log('=' * 78)
log(' 场景 5：标记超过 24 小时视为过期 → 不生效')
log('=' * 78)
old = (datetime.now() - timedelta(hours=30)).isoformat()
ds.set_pending_game_reapply(True)
data = ds._read_data_raw()
data['pending_game_reapply'] = {'at': old, 'reason': 'stale'}
ds._write_data_raw(data)
check('过期标记读取=false', ds.get_pending_game_reapply(), False)
check('过期标记不触发重应用', backend_main._reapply_prefs_after_game_exit(), None)

log('')
log('=' * 78)
log(' 场景 6：软件启动时（游戏已不在运行）残留标记 → /api/game/status 自动纠正')
log('=' * 78)
# 这台机器上游戏可能真的在运行，为了让断言确定，这里把进程探测替换成「未运行」
backend_main._detect_game_process = lambda: (False, None)

ds.set_pending_game_reapply(True)                       # 上次运行期间改过设置（刷新为新时间戳）
write_addonlist(ALL_ON)                                 # 游戏随后退出，把内存里的旧状态写回文件
backend_main._game_status_cache.update({'time': 0.0, 'running': False, 'pid': None})
status = backend_main.get_game_status()
check('接口返回 running=false', status['running'], False)
check('接口返回 reapplied=3', status.get('reapplied'), 3)
check('A 文件回到禁用（软件设置生效）', file_state('A.vpk'), False)
check('标记已清除', ds.get_pending_game_reapply(), False)

log('')
log('=' * 78)
log(' 场景 7：过期标记在下次改设置时会被刷新（不会永久失效）')
log('=' * 78)
check('先确认过期的读作 false', ds.get_pending_game_reapply(), False)
data = ds._read_data_raw()
data['pending_game_reapply'] = {'at': old, 'reason': 'stale'}
ds._write_data_raw(data)
ds.set_pending_game_reapply(True)
check('再次改设置后标记有效', ds.get_pending_game_reapply(), True)
ds.set_pending_game_reapply(False)
check('清除后无效', ds.get_pending_game_reapply(), False)

log('')
log('=' * 78)
log(' 场景 8：游戏运行期间的启停会自动打上标记（_mark_pending_reapply_if_game_running）')
log('=' * 78)
backend_main._detect_game_process = lambda: (True, 4321)
backend_main._game_status_cache.update({'time': 0.0, 'running': False, 'pid': None})
backend_main._mark_pending_reapply_if_game_running()
check('检测到游戏在运行 → 标记已置位', ds.get_pending_game_reapply(), True)
backend_main._detect_game_process = lambda: (False, None)
backend_main._game_status_cache.update({'time': 0.0, 'running': True, 'pid': 4321})
ds.set_pending_game_reapply(False)
backend_main._mark_pending_reapply_if_game_running()
check('游戏未运行时不打标记', ds.get_pending_game_reapply(), False)

log('')
log('=' * 78)
log(' 场景 9：/api/game/status 的 pending_reapply（界面「退出游戏后生效」提示的数据来源）')
log('=' * 78)
# 9a) 游戏运行中：标记保留、不做重应用 → 界面应显示「待生效」提示
ds.set_pending_game_reapply(True)
backend_main._detect_game_process = lambda: (True, 8899)
backend_main._game_status_cache.update({'time': 0.0, 'running': False, 'pid': None})
status = backend_main.get_game_status()
check('运行中：pending_reapply=true', status.get('pending_reapply'), True)
check('运行中：不重应用（标记仍在）', ds.get_pending_game_reapply(), True)
# 9b) 游戏退出（软件开着）：自动以软件设置为准重写文件 → 提示消失
backend_main._detect_game_process = lambda: (False, None)
backend_main._game_status_cache.update({'time': 0.0, 'running': True, 'pid': 8899})
status = backend_main.get_game_status()
check('退出后：pending_reapply=false', status.get('pending_reapply'), False)
check('退出后：标记已消费', ds.get_pending_game_reapply(), False)
check('退出后：返回 reapplied（重应用条目数）', isinstance(status.get('reapplied'), int), True)
check('退回正常状态：A 文件=禁用', file_state('A.vpk'), False)

log('')
log('=' * 78)
log(' 场景 10：「应用到游戏」接口（POST /api/mods/apply-prefs）')
log('=' * 78)
# 10a) 游戏运行中：写文件 + **保留**标记（保证游戏退出后再纠正一次）
write_addonlist(ALL_ON)                                  # 模拟游戏把它内存里的状态回写文件
ds.set_pending_game_reapply(True)
backend_main._detect_game_process = lambda: (True, 7777)
backend_main._game_status_cache.update({'time': 0.0, 'running': False, 'pid': None})
res = backend_main.apply_mod_prefs_endpoint()
check('运行中：game_running=true', res.get('game_running'), True)
check('运行中：文件已按软件设置写回（A=禁用）', file_state('A.vpk'), False)
check('运行中：标记保留（退出后还会再纠正一次）', ds.get_pending_game_reapply(), True)
# 10b) 游戏未运行：写文件 + 清标记（文件就是最终状态）
write_addonlist(ALL_ON)
backend_main._detect_game_process = lambda: (False, None)
backend_main._game_status_cache.update({'time': 0.0, 'running': True, 'pid': 7777})
res = backend_main.apply_mod_prefs_endpoint()
check('未运行：game_running=false', res.get('game_running'), False)
check('未运行：文件已按软件设置写回', file_state('A.vpk'), False)
check('未运行：标记已清除', ds.get_pending_game_reapply(), False)

log('')
log('=' * 78)
log(' 场景 11：游戏里改的启停（在「附加内容」点完成写回文件）→ 照常上报等待用户确认')
log('=' * 78)
ds.set_pending_game_reapply(False)
write_addonlist(ALL_ON)                     # 游戏把「它那边的状态」写回了文件
backend_main._detect_game_process = lambda: (True, 6666)
backend_main._game_status_cache.update({'time': 0.0, 'running': False, 'pid': None})
changes = backend_main.get_addonlist_changes()
check('游戏运行中也能检测到改动', len(changes.get('changes', [])) > 0, True)
# 即使软件里刚改过（标记存在）也不再抑制：用户要能看到游戏里的改动，自己决定同步/忽略
ds.set_pending_game_reapply(True)
backend_main._game_status_cache.update({'time': 0.0, 'running': True, 'pid': 6666})
changes = backend_main.get_addonlist_changes()
check('有软件改动标记时同样上报（不再抑制）', len(changes.get('changes', [])) > 0, True)

log('')
log('=' * 78)
log(f' 结果：{"全部通过" if failures == 0 else f"{failures} 项失败"}')
log('=' * 78)

REPORT.write_text('\n'.join(lines), encoding='utf-8')
print(f'REPORT: {"ALL PASS" if failures == 0 else f"{failures} FAILED"}')
sys.exit(1 if failures else 0)
