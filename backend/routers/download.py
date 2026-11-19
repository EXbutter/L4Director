"""下载器域路由：任务管理、落盘目录、工坊封面缓存。"""

import hashlib
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

import app_state
from app_state import download_manager
from services.media_types import image_media_type, image_mime_from_bytes, sniff_file_mime
from services.mod_scanner import _CACHE_DIR
from services.workshop_downloader import (
    default_outdir as download_default_outdir,
    fetch_bytes as download_fetch_bytes,
    outdir_hint as download_outdir_hint,
)

router = APIRouter()

# ===== 创意工坊下载器 API =====
# 功能来自项目根目录的 L4D2创意工坊下载器.pyw：绕过 Steam 客户端，
# 直接从 UGC CDN 多线程分段下载 + SHA1 校验，落成 <工坊ID>.vpk。

_DL_THUMB_DIR = _CACHE_DIR / "dl_thumbs"


@router.get("/api/download/state")
def download_state():
    """下载队列 / 进度 / 日志的完整快照（前端轮询用）。"""
    return download_manager().snapshot()


@router.get("/api/download/default-dir")
def download_default_dir():
    """推荐输出目录（软件里配置的 addons/workshop）。"""
    mgr = download_manager()
    return {
        "outdir": mgr.outdir,
        "detected": download_default_outdir(),
        "hint": download_outdir_hint(mgr.outdir),
    }


@router.post("/api/download/resolve")
def download_resolve(payload: dict):
    """解析粘贴进来的工坊链接/ID，加入下载队列（合集会自动展开）。"""
    text = (payload or {}).get("text", "")
    return download_manager().add_targets(text)


@router.post("/api/download/start")
def download_start(payload: dict):
    """开始下载队列里待处理的条目。"""
    p = payload or {}
    return download_manager().start(p.get("outdir"), p.get("threads"), p.get("force"))


@router.post("/api/download/stop")
def download_stop():
    """停止下载（已下好的分段会保留，下次自动续传）。"""
    return download_manager().stop()


@router.post("/api/download/remove")
def download_remove(payload: dict):
    """从队列里移除若干条目。"""
    wids = [str(w) for w in ((payload or {}).get("wids") or [])]
    download_manager().remove(wids)
    return {"ok": True}


@router.post("/api/download/clear")
def download_clear():
    download_manager().clear()
    return {"ok": True}


@router.post("/api/download/open-dir")
def download_open_dir(payload: dict = None):
    """在资源管理器里打开输出目录。"""
    target = ((payload or {}).get("path") or download_manager().outdir or "").strip()
    if not target or not Path(target).is_dir():
        raise HTTPException(status_code=404, detail="目录不存在")
    try:
        os.startfile(target)  # type: ignore[attr-defined]  # Windows only
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"打开目录失败：{e}")
    return {"ok": True}


_THUMB_CACHE_LIMIT = 256 * 1024 * 1024   # 封面缓存上限，超了按最久未访问淘汰
_THUMB_CACHE_MAX_FILE = 4 * 1024 * 1024  # 单张超过这个大小就不落盘（GIF 动图居多）
_LAST_PRUNE = 0.0                        # 上次扫描缓存的时间戳（节流用）


def _preview_variant_url(url: str, width: int, height: int) -> str:
    """给 Steam 图床地址加上「按尺寸取图」参数。

    L4D2 工坊里有一批封面是几万像素的竖长条 / 二十多 MB 的 GIF 动图，原样抓下来
    既费流量又费显存。Steam 图床支持 `imw/imh/ima/impolicy` 做服务端缩放，
    典型收益：11.8 MB 的 600×600 动图 → 463 KB。

    注意两点：
      * 只有 steamusercontent 这类图床认这些参数，别的域名原样返回；
      * **并非所有文件都生效**（实测有个 24.7 MB 的 GIF 完全无视参数），
        所以客户端仍然必须做本地降采样兜底，参数只是省流量，不是正确性依赖。
    """
    if not url or width <= 0 or height <= 0:
        return url
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if "steamusercontent" not in host and "akamai" not in host:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}imw={width}&imh={height}&ima=fit&impolicy=Letterbox"


def _prune_thumb_cache(limit: int = _THUMB_CACHE_LIMIT) -> None:
    """把封面缓存压到限额以内（按最后访问时间淘汰最旧的）。

    这不是用户数据，是随时可重建的派生缓存；不设上限时实测跑一趟工坊就能
    堆到 500 MB（一张 28 MB 的动图比比皆是）。删不掉的文件（正被读取/占用）
    直接跳过，下次再收。

    每 60 秒最多扫一次：卡片是一张张加载的，每写一张就 glob 一遍目录，
    缓存上万文件时光这一项就够拖慢响应。
    """
    global _LAST_PRUNE
    now = time.time()
    if now - _LAST_PRUNE < 60:
        return
    _LAST_PRUNE = now
    try:
        files = [p for p in _DL_THUMB_DIR.glob("*") if p.is_file()]
    except OSError:
        return
    total = sum(p.stat().st_size for p in files if p.exists())
    if total <= limit:
        return
    files.sort(key=lambda p: p.stat().st_mtime)
    for p in files:
        if total <= limit * 0.8:      # 一次收到 80%，避免每次写盘都触发一轮扫描
            break
        try:
            size = p.stat().st_size
            p.unlink()
            total -= size
        except OSError:
            continue


def _thumb_cache_name(wid: str, url: Optional[str],
                      w: Optional[int], h: Optional[int]) -> str:
    """工坊缩略图在磁盘上的缓存文件名。

    键里**必须**带上这张图 URL 的指纹。以前只用 `wid`，同一个 Mod 的多张截图
    会撞进同一个缓存文件 —— 表现就是详情页图集里每一张都显示成第一张（封面）。
    """
    variant = f"_{w}x{h}" if w and h else ""
    url_tag = hashlib.md5(url.encode('utf-8')).hexdigest()[:12] if url else 'nocover'
    return f"{wid}_{url_tag}{variant}.jpg"


@router.get("/api/download/thumbnail")
def download_thumbnail(wid: str, url: Optional[str] = None,
                       w: Optional[int] = None, h: Optional[int] = None):
    """工坊封面：优先读本地已下载的 <id>.jpg，其次走同一套直连逻辑抓取并缓存。

    `w` / `h` 是**卡片显示尺寸**（不是原图尺寸）：传了就让图床把图缩到这个
    大小再抓，缓存也按尺寸分开存（`<id>_320x180.jpg`）。不传则保持原行为，
    已下载的 Mod 目录里那份封面仍然优先。
    """
    if not wid:
        raise HTTPException(status_code=400, detail="wid is required")
    # 工坊 ID 一定是纯数字。以前直接 f"{wid}.jpg" 拼路径，传 ../../ 就能读到目录外的东西。
    if not re.fullmatch(r'[0-9]{1,20}', wid):
        raise HTTPException(status_code=400, detail="wid 必须是纯数字的创意工坊 ID")

    cache_headers = {"Cache-Control": "public, max-age=86400"}
    local = Path(download_manager().outdir) / f"{wid}.jpg"
    # 本地这份是 Steam 客户端下载时附带的**封面**，好坏都得认（用户已经装了这个 Mod）。
    # 但只有「没指定具体图」时才用它：详情页图集里每张图都带着自己的 url，
    # 一旦这里无条件优先返回本地封面，整个图集就会全部显示成封面那一张。
    if not url and not w and not h and local.is_file() and local.stat().st_size > 512:
        return FileResponse(str(local), media_type=sniff_file_mime(local), headers=cache_headers)

    cached = _DL_THUMB_DIR / _thumb_cache_name(wid, url, w, h)
    if cached.is_file() and cached.stat().st_size > 512:
        try:
            os.utime(cached, None)      # 记一次访问，LRU 淘汰时不会被误杀
        except OSError:
            pass
        return FileResponse(str(cached), media_type=sniff_file_mime(cached), headers=cache_headers)

    if not url:
        raise HTTPException(status_code=404, detail="no preview")

    data = download_fetch_bytes(_preview_variant_url(url, w or 0, h or 0))
    if not data:
        raise HTTPException(status_code=404, detail="preview fetch failed")
    # 超大封面不落盘：工坊里既有 28 MB 的 GIF，也有 11 MB 的竖长条，缓存它们
    # 等于让磁盘替 CDN 背锅（实测跑几趟就 500 MB）。这些图本来就来自边缘缓存、
    # 重取只要 0.2 秒，不缓存反而更好；常见尺寸（几百 KB）照常缓存。
    if len(data) <= _THUMB_CACHE_MAX_FILE:
        try:
            _DL_THUMB_DIR.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(data)
        except Exception:
            pass
    _prune_thumb_cache()
    return Response(content=data, media_type=image_mime_from_bytes(data), headers=cache_headers)
