"""白盒校验：/api/mods/scan-status 不再让前端无限空转（T6 + T16）。

踩过的坑：addons 目录为空（或不存在）时扫描清单从来不落盘，于是
scan_status 每次都回 changed=true —— 前端 5 秒轮询一次就判一次 changed，
后台永久静默刷新。全新用户第一次打开就命中。

覆盖：
  1. 没配置路径 → not_configured
  2. 空目录、从未扫描 → 先报一次 no_previous_scan（逼前端扫一次）
  3. 扫过之后（哪怕目录是空的）→ no_changes
  4. 新丢进一个 vpk → files_changed，并报出 added
  5. 删掉 vpk → files_changed，并报出 removed
  6. 目录整个消失 → addons_missing（不是把列表刷成空）
  7. 静态目录连查 5 次，只有第一次真正比对（快速负判定命中）

运行：python scripts/verify_scan_status_idle.py
"""
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix='l4d2_ss_'))
os.environ['USERPROFILE'] = str(TMP)
os.environ['HOME'] = str(TMP)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.mod_scanner import ModScanner  # noqa: E402
from services import data_store as ds  # noqa: E402
import main as backend_main  # noqa: E402

ok = True


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


addons = TMP / 'left4dead2' / 'addons'
addons.mkdir(parents=True)


def fresh_scanner(path: str | None) -> ModScanner:
    s = ModScanner()
    if path:
        s.set_addons_path(path)
    return s


def reset_status_cache():
    backend_main._scan_status_sig['sig'] = None
    backend_main._scan_status_sig['at'] = 0.0


# ---------------------------------------------------------- 1. 未配置
backend_main.scanner = fresh_scanner(None)
reset_status_cache()
st = backend_main.scan_status()
check('未配置路径 → not_configured', st.get('reason') == 'not_configured', str(st))

# ---------------------------------------------------------- 2. 空目录首扫
backend_main.scanner = fresh_scanner(str(addons))
ds.save_scan_manifest(ds.ScanManifest(files={}, last_scan=None))
reset_status_cache()
st = backend_main.scan_status()
check('空目录 + 从未扫描 → changed（逼前端扫一次）',
      st.get('changed') is True and st.get('reason') == 'no_previous_scan', str(st))

# ---------------------------------------------------------- 3. 扫过之后不再报 changed
backend_main.scanner.scan_mods()   # 这一步会写入空清单（含 last_scan）
reset_status_cache()
st = backend_main.scan_status()
check('空目录 + 已扫描 → 不再 changed',
      st.get('changed') is False and st.get('reason') == 'no_changes', str(st))

# 再来一次（模拟前端 5 秒后的那次轮询）
reset_status_cache()
st = backend_main.scan_status()
check('第二次轮询仍然安静', st.get('changed') is False, str(st))

# ---------------------------------------------------------- 4. 新丢一个 vpk
# 故意不先扫描：这才是真实场景（在 Steam 里新订阅 → vpk 落到目录里）
(addons / 'NEW.vpk').write_bytes(b'x')
reset_status_cache()
st = backend_main.scan_status()
check('目录里多了一个 vpk → files_changed', st.get('changed') is True, str(st))
check('added 里报出新文件', 'NEW.vpk' in (st.get('added') or []), str(st))

# ---------------------------------------------------------- 5. 删掉 vpk
backend_main.scanner.scan_mods()   # 先让清单吸收掉 NEW.vpk
ds.save_scan_manifest(ds.ScanManifest(
    files={'NEW.vpk': time.time(), 'GONE.vpk': time.time()},
    last_scan='2026-01-01T00:00:00'))
reset_status_cache()
st = backend_main.scan_status()
check('removed 里报出消失的文件', 'GONE.vpk' in (st.get('removed') or []), str(st))

# ---------------------------------------------------------- 6. 目录消失
backend_main.scanner.scan_mods()
shutil.rmtree(addons)
reset_status_cache()
st = backend_main.scan_status()
check('目录消失 → addons_missing（不刷空列表）',
      st.get('changed') is False and st.get('reason') == 'addons_missing', str(st))

# ---------------------------------------------------------- 7. 快速负判定
addons.mkdir(parents=True)
(addons / 'A.vpk').write_bytes(b'x')
backend_main.scanner = fresh_scanner(str(addons))
backend_main.scanner.scan_mods()
reset_status_cache()

first = backend_main.scan_status()
sig_after_first = backend_main._scan_status_sig['sig']
t0 = time.perf_counter()
for _ in range(5):
    backend_main.scan_status()
elapsed_ms = (time.perf_counter() - t0) * 1000 / 5

check('首次比对后记下了目录签名', sig_after_first is not None, str(sig_after_first))
check('后续轮询走快速路径（签名未变）',
      backend_main._scan_status_sig['sig'] == sig_after_first)
check('单次 scan-status 平均耗时 < 5ms', elapsed_ms < 5.0, f'{elapsed_ms:.2f}ms')

print('RESULT:', 'ALL PASS' if ok else 'HAS FAILURE')
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if ok else 1)
