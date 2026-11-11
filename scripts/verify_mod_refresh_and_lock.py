"""回归验证：两个用户反馈的线上问题。

问题 1 「在 Steam 里取消订阅后，界面上的 Mod 卡片还留着」
--------------------------------------------------------
取消订阅是**软件之外**发生的事情，软件没有文件监听，于是列表一直停留在旧状态。
修复：每次扫描后把磁盘现状（相对路径 → mtime）写进 `data.json` 的 `scan_manifest`，
前端每 5 秒轮询 `/api/mods/scan-status`，命中变化就静默刷新列表。
本脚本验证后端这一环：manifest 的键/值必须与检测端完全一致（否则会「永远 changed」
把前端拖进无限刷新），并且增 / 删 / 改三种情况都能被准确识别。

问题 2 「改 Mod 启停 / 点应用之后软件卡死」
------------------------------------------
`stream_mods()` 原本写成 `with _SCAN_LOCK: yield from ...`，而这个同步生成器会被
Starlette 丢进线程池逐块迭代 —— 生成器的收尾（最后一次 `next()` / 客户端断开后的
`close()`）经常落在**另一个线程**上，`RLock.release()` 抛
「cannot release un-acquired lock」，锁被永久攥住；之后所有 /api/mods、
/api/mods/stream 全部永久阻塞，每个卡住的请求还各占一条浏览器连接，攒到 6 条
连 /api/health 都发不出去 → 界面表现为「整个软件卡死」。
修复：`_ScanLock`（可重入、允许跨线程释放）+ `stream_mods()` 把整段扫描放进
单独工作线程、用队列转交事件。
本脚本在「另一个线程 close 生成器」以及「并发 + 中途断开」两种情况下，
验证锁不会泄漏、请求不会永久阻塞。

全程在临时目录里跑（HOME 已重定向），**不会读写**用户真实的
`~/.l4d2-manager` 与 addons 目录。
"""
import os
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

# ── 必须在导入项目模块之前隔离缓存目录 ────────────────────────────────────────
# mod_scanner.py / data_store.py 在 import 时就会执行 Path.home() / '.l4d2-manager'
TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-refresh-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

if sys.platform == 'win32':
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleOutputCP(65001)  # type: ignore[attr-defined]
    except Exception:
        pass
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[attr-defined]
except Exception:
    pass

from services import data_store as ds  # noqa: E402
from services import mod_scanner as ms  # noqa: E402
import bench_scan  # noqa: E402
import main as backend_main  # noqa: E402


# ── 临时 Mod 库：2 个本地 mod + 1 个创意工坊 mod ──────────────────────────────
ROOT = Path(tempfile.mkdtemp(prefix='l4d2-refresh-'))
ADDONS_DIR = ROOT / 'left4dead2' / 'addons'
ADDONS_DIR.mkdir(parents=True)
WS_DIR = ADDONS_DIR / 'workshop'
(WS_DIR / '632').mkdir(parents=True)  # 创意工坊 Mod 的真实布局：workshop/<id>/<name>.vpk


def make_vpk(path: Path, title: str, filler: str = 'x'):
    """写一个能被扫描器正常解析的最小 VPK。"""
    bench_scan.write_vpk(path, {
        'addoninfo.txt': (
            '"AddonInfo"\n{\n'
            f'\taddontitle "{title}"\n'
            '\taddonversion "1.0"\n'
            '\taddonauthor "Refresh Test"\n'
            '}\n'
        ).encode('utf-8'),
        'materials/refresh_test.vmt': filler.encode('utf-8'),
    })


make_vpk(ADDONS_DIR / 'A.vpk', 'Mod A')
make_vpk(ADDONS_DIR / 'B.vpk', 'Mod B')
make_vpk(WS_DIR / '632' / 'ws1.vpk', 'Mod ws1')

# 复用后端真实实例（确认走的是生产代码路径）
scanner = backend_main.scanner
scanner._addons_path = str(ADDONS_DIR)
scanner.invalidate_mod_enabled_cache()
ds.set_addons_path(str(ADDONS_DIR))  # 供 /api/settings 等其它路径读取

results: list = []


def check(desc: str, got, expected):
    ok = got == expected
    results.append((ok, desc))
    print(f'  [{"OK " if ok else "FAIL"}] {desc}' + ('' if ok else f'\n         期望 {expected!r}，实际 {got!r}'))


def scan_status() -> dict:
    return backend_main.scan_status()


def mod_names() -> list:
    """界面拿到的 Mod 名列表（即 /api/mods 返回的顺序）。"""
    return sorted(m['name'] for m in backend_main.list_mods()['mods'])


def lock_held() -> int:
    return ms._SCAN_LOCK.held_count()


def wait_lock_free(timeout: float = 5.0) -> bool:
    """等锁回到空闲（中途断开的流让 worker 自行收手，可能要几百毫秒）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if lock_held() == 0:
            return True
        time.sleep(0.02)
    return lock_held() == 0


print('=' * 78)
print(' 场景 1：基线 —— 首次扫描后写入 manifest，scan-status 不应再报 changed')
print('=' * 78)
check('未扫描过 → 提示没有基线', scan_status().get('reason'), 'no_previous_scan')
check('扫描到 3 个 Mod', len(mod_names()), 3)
check('扫描后 manifest 已写入',
      sorted(ds.get_scan_manifest().files),
      ['A.vpk', 'B.vpk', 'workshop/632/ws1.vpk'])
check('扫描后 scan-status 不再报变化（否则前端会无限刷新）', scan_status()['changed'], False)

print('\n' + '=' * 78)
print(' 场景 2：Steam 里取消订阅 → 本地 vpk 被删 → 应被检测到并刷新掉卡片')
print('=' * 78)
(ADDONS_DIR / 'A.vpk').unlink()
st = scan_status()
check('检测到变化', st['changed'], True)
check('变化原因', st['reason'], 'files_changed')
check('被删除的文件被点名', st['removed'], ['A.vpk'])
check('界面刷新后 A 已消失（这就是「取消订阅卡片还留着」的修复）', mod_names(), ['B.vpk', 'ws1.vpk'])
check('刷新后 scan-status 恢复平静（不会无限刷新）', scan_status()['changed'], False)

print('\n' + '=' * 78)
print(' 场景 3：创意工坊 Mod 被取消订阅（workshop/<id>/<name>.vpk）')
print('=' * 78)
(WS_DIR / '632' / 'ws1.vpk').unlink()
st = scan_status()
check('检测到变化', st['changed'], True)
# 注意：这里必须是 posix 写法 —— 写 manifest 与检测端两侧的键格式必须一致
check('工坊子目录的键是 posix 写法', st['removed'], ['workshop/632/ws1.vpk'])
check('界面刷新后 ws1 已消失', mod_names(), ['B.vpk'])

print('\n' + '=' * 78)
print(' 场景 4：新订阅的 Mod 下载完成 / 手动丢进 addons → 应自动出现')
print('=' * 78)
make_vpk(ADDONS_DIR / 'C.vpk', 'Mod C')
st = scan_status()
check('检测到新增', st['added'], ['C.vpk'])
check('界面刷新后 C 出现', mod_names(), ['B.vpk', 'C.vpk'])

print('\n' + '=' * 78)
print(' 场景 5：同名文件被替换（Steam 更新 / 手动覆盖）→ 应被识别')
print('=' * 78)
time.sleep(0.02)  # 让 mtime 明显变化
make_vpk(ADDONS_DIR / 'B.vpk', 'Mod B v2', filler='updated content is longer than before')
st = scan_status()
check('识别为修改而非新增/删除', (st['added'], st['removed'], st['modified']), ([], [], ['B.vpk']))
check('界面刷新后仍是 2 个 Mod', mod_names(), ['B.vpk', 'C.vpk'])
check('再次扫描后恢复平静', scan_status()['changed'], False)
check('锁空闲（前面的扫描都正确释放了）', lock_held(), 0)

print('\n' + '=' * 78)
print(' 场景 6：跨线程收尾生成器（复现原崩溃路径）——不得泄漏锁')
print('=' * 78)
# 旧实现下：RLock 在「另一个线程」里 release → RuntimeError: cannot release un-acquired lock
# → with 块退出失败 → 锁被永久持有 → 之后所有 /api/mods 永久阻塞。
gen = scanner.stream_mods()
next(gen)
close_errors: list = []


def close_in_other_thread():
    try:
        gen.close()  # Starlette 在别的线程里收尾生成器就是这个效果
    except BaseException as e:  # noqa: BLE001
        close_errors.append(f'{type(e).__name__}: {e}')


t = threading.Thread(target=close_in_other_thread, name='starlette-like-closer')
t.start()
t.join(30)
check('跨线程 close 没有抛异常', close_errors, [])
check('生成器未卡死（close 已返回）', t.is_alive(), False)
check('锁没有泄漏（5 秒内回到空闲）', wait_lock_free(5), True)

# 锁若泄漏，下面这一步会永远拿不到 —— 用「另一线程限时获取」验证它真的空闲
got_lock: list = []


def try_acquire():
    ok = ms._SCAN_LOCK.acquire(2.0)
    got_lock.append(ok)
    if ok:
        ms._SCAN_LOCK.release()


t2 = threading.Thread(target=try_acquire)
t2.start()
t2.join(5)
check('别的线程能在 2 秒内拿到锁（后端不会卡死）', got_lock, [True])
t3 = time.perf_counter()
check('之后 /api/mods 依然可用', len(mod_names()), 2)
print(f'  [信息] 卡死修复后 /api/mods 耗时 {(time.perf_counter() - t3) * 1000:.0f}ms')

print('\n' + '=' * 78)
print(' 场景 7：并发 + 中途断开（模拟前端看门狗中止 + 用户连点启停）')
print('=' * 78)
errors: list = []
err_lock = threading.Lock()


def read_stream(full: bool):
    for _ in range(3):
        try:
            stream = scanner.stream_mods()
            if full:
                for _evt in stream:
                    pass
            else:
                stream.__next__()  # 只读第一个事件
                stream.close()     # 然后直接断开
        except BaseException as e:  # noqa: BLE001
            with err_lock:
                errors.append(f'{type(e).__name__}: {e}')


threads = [threading.Thread(target=read_stream, args=(True,)) for _ in range(3)]
threads += [threading.Thread(target=read_stream, args=(False,)) for _ in range(3)]
t0 = time.perf_counter()
for th in threads:
    th.start()
for th in threads:
    th.join(60)
elapsed = time.perf_counter() - t0
check('并发读写没有异常', errors, [])
check('所有线程都结束了（没有卡死）', all(not th.is_alive() for th in threads), True)
check('压测后锁仍然空闲', wait_lock_free(10), True)
print(f'  [信息] 6 线程 × 3 轮（含 9 次中途断开）耗时 {elapsed * 1000:.0f}ms')

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

