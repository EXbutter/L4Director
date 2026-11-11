"""端到端验证（真实 HTTP 服务）：Steam 里取消订阅后，界面能否自动感知。

覆盖两个线上问题在「真实服务器 + 真实请求」下的表现：

  1. 软件之外的文件变化（Steam 取消订阅 → vpk 被删除）
     /api/mods/stream 扫过一次 → 写入 scan_manifest；
     外部删掉 vpk → /api/mods/scan-status 立刻报 changed（前端 5s 轮询据此刷新）；
     刷新（/api/mods）后卡片消失，且 scan-status 恢复平静（否则前端会无限刷新）。

  2. 扫描锁不会泄漏：所有请求（含 /api/health）都在毫秒级返回，
     串行改启停 / 重复点应用不会把后端线程池堵死。

全程在临时 HOME + 临时 addons 目录里跑，**不会读写**用户真实的游戏目录与配置。
用法： python scripts/verify_stream_http_e2e.py [port]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

# 必须在 import 后端模块之前重定向 HOME：data_store / mod_scanner 在 import 时
# 就会执行 Path.home() / '.l4d2-manager'
TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-e2e-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT_DIR / 'backend'
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

import bench_scan  # noqa: E402

PORT = sys.argv[1] if len(sys.argv) > 1 else '8311'
BASE = f'http://127.0.0.1:{PORT}'
LOG_FILE = Path(tempfile.gettempdir()) / 'l4d2_e2e_backend.log'

# ── 临时 Mod 库：2 个本地 mod + 1 个创意工坊 mod ──────────────────────────────
LIB = Path(tempfile.mkdtemp(prefix='l4d2-e2e-lib-'))
ADDONS_DIR = LIB / 'left4dead2' / 'addons'
ADDONS_DIR.mkdir(parents=True)
WS_DIR = ADDONS_DIR / 'workshop'
(WS_DIR / '632').mkdir(parents=True)


def make_vpk(path: Path, title: str, filler: str = 'x'):
    bench_scan.write_vpk(path, {
        'addoninfo.txt': (
            '"AddonInfo"\n{\n'
            f'\taddontitle "{title}"\n'
            '\taddonversion "1.0"\n'
            '\tauthor "E2E Test"\n'
            '}\n'
        ).encode('utf-8'),
        'materials/e2e_test.vmt': filler.encode('utf-8'),
    })


make_vpk(ADDONS_DIR / 'A.vpk', 'Mod A')
make_vpk(ADDONS_DIR / 'B.vpk', 'Mod B')
make_vpk(WS_DIR / '632' / 'ws1.vpk', 'Mod ws1')

results: list = []


def check(desc: str, got, expected):
    ok = got == expected
    results.append((ok, desc))
    print(f'  [{"OK " if ok else "FAIL"}] {desc}' + ('' if ok else f'\n         期望 {expected!r}，实际 {got!r}'))


def request(path: str, timeout: float = 30.0, payload=None):
    """发一个请求，返回 (耗时ms, 响应文本或 None, 错误名)。"""
    url = BASE + path
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=data, method='POST' if data else 'GET')
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode('utf-8', errors='replace')
        return round((time.perf_counter() - t0) * 1000), body, None
    except Exception as e:
        return round((time.perf_counter() - t0) * 1000), None, type(e).__name__ + ': ' + str(e)


def get_json(path: str, timeout: float = 30.0):
    ms, body, err = request(path, timeout=timeout)
    if err:
        raise RuntimeError(f'{path} 请求失败：{err}')
    return ms, json.loads(body)


def wait_health(timeout: float = 90.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        _, _, err = request('/api/health', timeout=3)
        if err is None:
            return True
        time.sleep(0.4)
    return False


def stream_mod_names(timeout: float = 60.0) -> list:
    """完整读一次 /api/mods/stream，返回其中的 Mod 名（模拟前端首次加载）。"""
    ms, body, err = request('/api/mods/stream', timeout=timeout)
    if err:
        raise RuntimeError(f'/api/mods/stream 请求失败：{err}')
    names = []
    for line in body.splitlines():
        line = line.strip()
        if not line:
            continue
        evt = json.loads(line)
        if evt.get('type') == 'mod':
            names.append(evt['mod']['name'])
    return sorted(names)


LOG_FILE.write_text('', encoding='utf-8')
log_handle = LOG_FILE.open('a', encoding='utf-8', errors='replace')
env = {**os.environ, 'HOME': str(TEMP_HOME), 'USERPROFILE': str(TEMP_HOME)}
proc = subprocess.Popen(
    [sys.executable, 'main.py', '--port', PORT],
    cwd=str(BACKEND_DIR),
    stdout=log_handle,
    stderr=subprocess.STDOUT,
    env=env,
)

failure = None
try:
    if not wait_health():
        failure = '后端未能就绪'
        print('[e2e] 后端未就绪，日志尾部：')
        print(LOG_FILE.read_text(encoding='utf-8', errors='replace')[-3000:])
        raise SystemExit(1)

    print('=' * 78)
    print(' 场景 1：指向临时 addons 目录 → 首次流式扫描写入基线 manifest')
    print('=' * 78)
    ms, body, err = request('/api/settings/addons-path', payload={'path': str(ADDONS_DIR)})
    check('设置 addons 路径成功', err, None)
    check('流式扫描返回 3 个 Mod', stream_mod_names(), ['A.vpk', 'B.vpk', 'ws1.vpk'])
    _, st = get_json('/api/mods/scan-status')
    check('扫描后 scan-status 不再报变化', st.get('changed'), False)

    print('\n' + '=' * 78)
    print(' 场景 2：Steam 里取消订阅（外部删掉 vpk）→ 轮询接口应立即报变化')
    print('=' * 78)
    (ADDONS_DIR / 'A.vpk').unlink()  # 模拟 Steam 取消订阅后删除文件
    ms, st = get_json('/api/mods/scan-status')
    check('scan-status 很快返回（前端 5s 轮询不会积压）', ms < 2000, True)
    check('检测到外部变化', st.get('changed'), True)
    check('变化原因', st.get('reason'), 'files_changed')
    check('被删除的文件被点名', sorted(st.get('removed') or []), ['A.vpk'])

    print('\n' + '=' * 78)
    print(' 场景 3：前端据此静默刷新（/api/mods）→ 卡片消失且不再无限刷新')
    print('=' * 78)
    ms, data = get_json('/api/mods')
    check('刷新后 A 的卡片已消失（这就是「取消订阅卡片还留着」的修复）',
          sorted(m['name'] for m in data['mods']), ['B.vpk', 'ws1.vpk'])
    _, st = get_json('/api/mods/scan-status')
    check('刷新后 scan-status 恢复平静', st.get('changed'), False)

    print('\n' + '=' * 78)
    print(' 场景 4：扫描锁没有泄漏 —— 所有接口都在毫秒级返回')
    print('=' * 78)
    slow = []
    for path in ('/api/health', '/api/mods', '/api/mods/scan-status', '/api/settings', '/api/status'):
        ms, _, err = request(path, timeout=10)
        if err or ms > 2000:
            slow.append(f'{path} -> {ms}ms {err}')
        print(f'  [信息] {path}: {ms}ms')
    check('没有接口被卡住（锁已正确释放）', slow, [])

    print('\n' + '=' * 78)
    print(' 场景 5：中途断开流（前端看门狗中止）后，后端仍然可用')
    print('=' * 78)
    try:
        # 只读前 200 字节就断开，模拟看门狗中止 / 用户切页
        with urllib.request.urlopen(BASE + '/api/mods/stream', timeout=10) as r:
            r.read(200)
    except Exception as e:
        print(f'  [信息] 流被提前关闭：{type(e).__name__}')
    time.sleep(0.6)  # 给 worker 一点时间收手
    ms, _, err = request('/api/health', timeout=5)
    check('断开后 health 依然秒回', (err, ms < 2000), (None, True))
    check('断开后 /api/mods 依然可用', request('/api/mods', timeout=10)[2], None)

except SystemExit as e:
    failure = failure or f'退出码 {e.code}'
except Exception as e:  # noqa: BLE001
    failure = f'{type(e).__name__}: {e}'
    print(f'[e2e] 异常：{failure}')
finally:
    try:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    except Exception:
        pass
    log_handle.close()
    shutil.rmtree(TEMP_HOME, ignore_errors=True)
    shutil.rmtree(LIB, ignore_errors=True)

passed = sum(1 for ok, _ in results if ok)
print('\n' + '=' * 78)
print(f' 结果：{passed} / {len(results)} 项通过' + (f'（{failure}）' if failure else ''))
print('=' * 78)
sys.exit(0 if passed == len(results) and failure is None else 1)

