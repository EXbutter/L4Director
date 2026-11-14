"""白盒校验：缩略图接口不能读本机任意文件（T7）。

以前 GET /api/thumbnail?path= 直接 FileResponse(Path(path))，等于把「读任意文件」
暴露给了渲染进程；/api/download/thumbnail?wid= 也能用 ../../ 穿出去。
内容会被原样返回（media_type 只是标签，不影响字节）。

覆盖：
  1. addons / 缓存目录之外的文件 → 403
  2. 非图片扩展名（哪怕在 addons 里）→ 403
  3. addons 里的正常封面 → 200 + 正确的 content-type
  4. 缓存目录（vpk_covers）里的封面 → 200
  5. /api/download/thumbnail 的 wid 必须是纯数字，带 ../ 一律 400
  6. /api/thumbnail/workshop/<name> 不接受带目录成分的名字

运行：python scripts/verify_thumbnail_guard.py
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix='l4d2_tg_'))
os.environ['USERPROFILE'] = str(TMP)
os.environ['HOME'] = str(TMP)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi import HTTPException  # noqa: E402
import main as backend_main  # noqa: E402
from services.mod_scanner import ModScanner, _CACHE_DIR  # noqa: E402

ok = True


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


addons = TMP / 'left4dead2' / 'addons'
addons.mkdir(parents=True)
scanner = ModScanner()
scanner.set_addons_path(str(addons))
backend_main.scanner = scanner

# 各种真实文件
cover = addons / 'mod_a.jpg'
cover.write_bytes(b'\xff\xd8\xff\xe0fake-jpeg')
secret = TMP / 'secret.txt'
secret.write_text('data.json 里面的东西', encoding='utf-8')
not_image = addons / 'notes.txt'
not_image.write_text('不是图片', encoding='utf-8')

covers_dir = _CACHE_DIR / 'vpk_covers'
covers_dir.mkdir(parents=True, exist_ok=True)
cached = covers_dir / 'abc123.jpg'
cached.write_bytes(b'\xff\xd8\xff\xe0cached')


def expect_http(label, fn, status):
    try:
        fn()
        check(label, False, f'没有抛错（期望 {status}）')
    except HTTPException as exc:
        check(label, exc.status_code == status, f'HTTP {exc.status_code}: {exc.detail}')
    except Exception as exc:  # noqa: BLE001
        check(label, False, f'{type(exc).__name__}: {exc}')


# ------------------------------------------------------ 1/2. 越界与非图片
expect_http(
    'addons 之外的任意文件被拒绝',
    lambda: backend_main.get_thumbnail(path=str(secret)),
    403,
)
expect_http(
    'addons 里的非图片被拒绝',
    lambda: backend_main.get_thumbnail(path=str(not_image)),
    403,
)
expect_http(
    '不存在的文件仍然是 404（不泄露存在性之外的信息）',
    lambda: backend_main.get_thumbnail(path=str(TMP / 'nope.jpg')),
    404,
)

# ------------------------------------------------------ 3/4. 合法路径
resp = backend_main.get_thumbnail(path=str(cover))
check('addons 里的封面可读', resp is not None, type(resp).__name__)
check('封面 content-type 是 image/jpeg', resp.media_type == 'image/jpeg', str(resp.media_type))

resp = backend_main.get_thumbnail(vpk_cover='abc123.jpg')
check('缓存目录里的封面可读（走 vpk_cover）', resp is not None, type(resp).__name__)

# ------------------------------------------------------ 5. wid 白名单
expect_http(
    'wid 带路径穿越 → 400',
    lambda: backend_main.download_thumbnail(wid='../../secret'),
    400,
)
expect_http(
    'wid 不是数字 → 400',
    lambda: backend_main.download_thumbnail(wid='abc'),
    400,
)

# ------------------------------------------------------ 6. workshop 文件名
expect_http(
    'workshop 缩略图不接受带目录的名字',
    lambda: backend_main.get_workshop_thumbnail(filename='../addonlist.txt'),
    400,
)

print('RESULT:', 'ALL PASS' if ok else 'HAS FAILURE')
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if ok else 1)
