"""白盒校验：工坊封面的「取图尺寸」与「缓存策略」（性能回归）。

背景：创意工坊页曾把 100 张封面直接交给 `<img>`，其中夹着一批 600×600 的
GIF 动图（单张最大 28 MB）。Chromium 会把动图的**全部帧**解码常驻，一屏
十几张就把主线程压死 —— 实测整页 16 FPS。修法有三层，本脚本各守一条：

  1. 尺寸请求：后端支持让 Steam 图床先缩放（`?imw=&imh=`），但**不能默认用**
     —— 图床的缩放是服务端实时算的，实测 3~12 秒/张，比原图（0.2 秒）慢一个
     数量级。所以默认不带尺寸参数，尺寸交给前端 `ThumbImage` 本地降采样。
  2. MIME 必须按文件头判：封面统一存成 `<id>.jpg`，内容却常是 GIF/PNG。
     标成 image/jpeg 时 `<img>` 靠嗅探还能显示，但 `fetch()+createImageBitmap`
     会按 Blob 的 type 选解码器，标错就解不出来，前端只能回退原图（又开始播动图）。
  3. 缓存要有上限、且不收超大文件：不设限时跑几趟工坊就堆到 500 MB。

运行：python scripts/verify_workshop_thumb_perf.py
"""
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

TMP = Path(tempfile.mkdtemp(prefix='l4d2_thumb_'))
os.environ['USERPROFILE'] = str(TMP)
os.environ['HOME'] = str(TMP)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import main as backend_main  # noqa: E402

ok = True
GIF_HEAD = b'GIF89a\x58\x02\x58\x02\xf7\x00\x00' + b'\x00' * 600


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


def fresh_cache_dir():
    d = TMP / 'dl_thumbs'
    if d.exists():
        for p in d.iterdir():
            p.unlink()
    d.mkdir(parents=True, exist_ok=True)
    backend_main._DL_THUMB_DIR = d
    backend_main._LAST_PRUNE = 0.0
    return d


# ---------------------------------------------------------------- 1. 缩放 URL
print('\n== 尺寸参数拼装 ==')
cdn = 'https://images.steamusercontent.com/ugc/123/ABC/'
check('图床地址会加上缩放参数',
      backend_main._preview_variant_url(cdn, 268, 150)
      == cdn + '?imw=268&imh=150&ima=fit&impolicy=Letterbox')

check('已有查询串时用 & 续接',
      backend_main._preview_variant_url(cdn + '?v=2', 320, 200).endswith('&imw=320&imh=200&ima=fit&impolicy=Letterbox'),
      backend_main._preview_variant_url(cdn + '?v=2', 320, 200))

check('不传尺寸时原样返回', backend_main._preview_variant_url(cdn, 0, 0) == cdn)

check('非图床域名不加参数（别人的 CDN 不认这套）',
      backend_main._preview_variant_url('https://example.com/a.jpg', 320, 200) == 'https://example.com/a.jpg')

check('akamai 图床也认', 'imw=320' in backend_main._preview_variant_url(
    'https://cdn.akamai.steamstatic.com/steam/apps/550/a.jpg', 320, 200))


# ---------------------------------------------------------------- 2. MIME 嗅探
print('\n== 按文件头判 MIME ==')
check('GIF87a', backend_main._image_mime_from_bytes(b'GIF87a' + b'\x00' * 20) == 'image/gif')
check('GIF89a', backend_main._image_mime_from_bytes(GIF_HEAD) == 'image/gif')
check('PNG', backend_main._image_mime_from_bytes(b'\x89PNG\r\n\x1a\n' + b'\x00' * 20) == 'image/png')
check('JPEG', backend_main._image_mime_from_bytes(b'\xff\xd8\xff\xe0' + b'\x00' * 20) == 'image/jpeg')
check('WEBP', backend_main._image_mime_from_bytes(b'RIFF' + b'\x00' * 4 + b'WEBP' + b'\x00' * 8) == 'image/webp')

cache = fresh_cache_dir()
fake = cache / '123.jpg'
fake.write_bytes(GIF_HEAD)
check('后缀写着 .jpg、内容是 GIF → 仍然报 image/gif（前端靠它选解码器）',
      backend_main._sniff_file_mime(fake) == 'image/gif',
      backend_main._sniff_file_mime(fake))
fake.write_bytes(b'\xff\xd8\xff\xe0' + b'\x00' * 100)
check('真 JPEG 不会被误判', backend_main._sniff_file_mime(fake) == 'image/jpeg')


# ---------------------------------------------------------------- 3. 缓存策略
print('\n== 缓存策略 ==')
backend_main._dl = lambda: SimpleNamespace(outdir=str(TMP / 'addons'))   # 没有本地封面那份

big = b'\xff\xd8\xff\xe0' + b'\x00' * (backend_main._THUMB_CACHE_MAX_FILE + 1024)
backend_main.download_fetch_bytes = lambda url, **kw: big
resp = backend_main.download_thumbnail('900000001', cdn, 320, 200)
check('超大封面不落盘（避免 28 MB 的动图把磁盘吃满）',
      not (cache / '900000001_320x200.jpg').exists())
check('超大封面仍照常返回', getattr(resp, 'body', b'')[:2] == b'\xff\xd8')

small = GIF_HEAD * 4
backend_main.download_fetch_bytes = lambda url, **kw: small
resp = backend_main.download_thumbnail('900000002', cdn, 320, 200)
saved = cache / '900000002_320x200.jpg'
check('常见尺寸的封面会落盘', saved.is_file() and saved.stat().st_size == len(small))
check('落盘文件名带尺寸后缀（同一工坊条目的大图/小图分开放）', saved.name == '900000002_320x200.jpg')
check('按尺寸请求时响应类型取自文件头', resp.media_type == 'image/gif', str(resp.media_type))

# 命中缓存：第二次不再联网
calls = {'n': 0}
def boom(url, **kw):
    calls['n'] += 1
    return small
backend_main.download_fetch_bytes = boom
r2 = backend_main.download_thumbnail('900000002', cdn, 320, 200)
check('第二次直接命中磁盘缓存，不再联网', calls['n'] == 0 and r2.media_type == 'image/gif')

# 不传尺寸时行为不变（兼容旧调用）
backend_main.download_fetch_bytes = lambda url, **kw: small
backend_main.download_thumbnail('900000003', cdn)
check('不传尺寸时缓存名保持 <id>.jpg（兼容旧缓存）', (cache / '900000003.jpg').is_file())


# ---------------------------------------------------------------- 4. 容量回收
print('\n== 缓存容量回收 ==')
cache = fresh_cache_dir()
now = 1_700_000_000
for i in range(10):
    p = cache / f'x{i}.jpg'
    p.write_bytes(b'\xff\xd8' + b'\x00' * (256 * 1024))
    os.utime(p, (now + i, now + i))     # 递增 mtime，x0 最旧
total = sum(p.stat().st_size for p in cache.iterdir())
backend_main._LAST_PRUNE = 0.0
backend_main._prune_thumb_cache(limit=total // 2)
left = sorted(p.name for p in cache.iterdir())
check('超限时删掉最旧的那批', 'x0.jpg' not in left, ','.join(left))
check('保留最新的文件', 'x9.jpg' in left, ','.join(left))
check('删到限额的 80% 以下就停手', len(left) <= 5, f'剩 {len(left)} 个')

backend_main._LAST_PRUNE = 0.0
backend_main._prune_thumb_cache(limit=1)          # 先清空
for i in range(3):
    (cache / f'y{i}.jpg').write_bytes(b'\x00' * 4096)
backend_main._prune_thumb_cache(limit=1)          # 60 秒内再调：应被节流跳过
check('限流生效：60 秒内不重复扫目录（否则每写一张卡都 glob 一遍）',
      len(list(cache.iterdir())) == 3, f'剩 {len(list(cache.iterdir()))} 个')

print('\n' + ('全部通过' if ok else '存在失败项'))
sys.exit(0 if ok else 1)
