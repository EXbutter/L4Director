"""媒体域路由：缩略图读取（带路径白名单，防路径穿越）。"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

import app_state
from app_state import download_manager
from services.media_types import image_media_type
from services.mod_scanner import _CACHE_DIR

router = APIRouter()

# 封面图扩展名 → Content-Type。
# 以前这里是 `"image/jpeg" if ext in ('.jpg', '.jpeg') else "image/png"`，
# 于是 webp/bmp/gif 会被标成 image/png（同名封面图支持更多格式后就会踩到）。
_IMAGE_MEDIA_TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.tga': 'image/x-tga',
}


def _allowed_media_roots() -> list[Path]:
    """允许通过缩略图接口读取的根目录。

    这个接口原本直接 `FileResponse(Path(path))`，等于把「读本机任意文件」暴露给了
    渲染进程 —— 只要有人能让它发一个请求（页面注入、恶意 Mod 里的 HTML 封面），
    就能把 `data.json`、`loginusers.vdf` 之类的东西读出来。媒体类型标错不影响内容返回。
    所以除了限定根目录，还要限定扩展名（见 `_is_readable_media`）。
    """
    roots: list[Path] = [_CACHE_DIR]
    addons = app_state.scanner.get_addons_path()
    if addons:
        roots.append(Path(addons))
    try:
        outdir = download_manager().outdir
        if outdir:
            roots.append(Path(outdir))
    except Exception:
        pass
    return roots


def _is_readable_media(file_path: Path) -> bool:
    """缩略图接口只允许读图片，且必须落在已知目录内。"""
    if file_path.suffix.lower() not in _IMAGE_MEDIA_TYPES:
        return False
    try:
        resolved = file_path.resolve()
    except OSError:
        return False
    for root in _allowed_media_roots():
        try:
            resolved.relative_to(root.resolve())
            return True
        except (ValueError, OSError):
            continue
    return False


@router.get("/api/thumbnail/workshop/{filename}")
def get_workshop_thumbnail(filename: str):
    """获取创意工坊缩略图"""
    addons_path = app_state.scanner.get_addons_path()
    if not addons_path:
        raise HTTPException(status_code=404, detail="Addons path not configured")
    if Path(filename).name != filename:
        # 与上面两个接口同一类问题：不允许带目录成分
        raise HTTPException(status_code=400, detail="文件名不合法")
    thumb_path = Path(addons_path) / 'workshop' / filename
    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(str(thumb_path), media_type=image_media_type(thumb_path))


# VPK 封面缓存实际存放在 vpk_covers/ 子目录；早期版本曾直接放在 _CACHE_DIR 根目录。
# 两个位置都查一次，既修好「本地 Mod 封面 404」（原先只查根目录 → 全部找不到），
# 也兼容历史缓存文件。
_VPK_COVER_DIR = _CACHE_DIR / 'vpk_covers'


def _resolve_cover_path(cover_name: str) -> Optional[Path]:
    """把 URL 里的封面名解析成磁盘路径（拒绝带目录的非法名，避免路径穿越）。"""
    if not cover_name:
        return None
    try:
        if Path(cover_name).name != cover_name:
            return None
    except Exception:
        return None
    for base in (_VPK_COVER_DIR, _CACHE_DIR):
        p = base / cover_name
        if p.is_file():
            return p
    return None


@router.get("/api/thumbnail")
def get_thumbnail(path: Optional[str] = None, vpk_cover: Optional[str] = None):
    """通过绝对路径获取缩略图，或从 VPK 封面缓存中获取

    缓存策略：缩略图是「文件路径 + mtime」驱动的静态资源，一次会话内不会变。
    加 Cache-Control 让 Chromium 直接命中内存/磁盘缓存，切页回 Mod 列表时
    不再为几十张封面重复发起请求并重新读盘（这是切页卡顿的主要来源之一）。
    """
    # 1 小时：足够覆盖一次使用会话；封面被替换也能自然失效
    cache_headers = {"Cache-Control": "public, max-age=3600"}
    if path:
        file_path = Path(path)
        if not file_path.exists() or not file_path.is_file():
            raise HTTPException(status_code=404, detail="Thumbnail not found")
        if not _is_readable_media(file_path):
            # 不在 addons / 缓存 / 下载目录内，或不是图片扩展名：拒绝
            raise HTTPException(status_code=403, detail="这个路径不允许读取")
        return FileResponse(str(file_path), media_type=image_media_type(file_path), headers=cache_headers)
    elif vpk_cover:
        cover_path = _resolve_cover_path(vpk_cover)
        if cover_path is None:
            raise HTTPException(status_code=404, detail="VPK cover not found")
        return FileResponse(str(cover_path), media_type=image_media_type(cover_path), headers=cache_headers)
    else:
        raise HTTPException(status_code=400, detail="Either 'path' or 'vpk_cover' parameter is required")
