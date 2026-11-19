"""图片 MIME 判定（按扩展名 / 按文件头）。

下载器把工坊封面落成 `<id>.jpg`，里面却经常是 GIF 或 PNG；缩略图接口又要按
真实类型发 Content-Type。这两处原先各写一份，判定标准容易跑偏（曾经 webp/bmp
被标成 image/png、GIF 动图被标成 image/jpeg），现在统一在这里。
"""
from pathlib import Path

# 封面图扩展名 → Content-Type。
# 早期版本是 `"image/jpeg" if ext in ('.jpg', '.jpeg') else "image/png"`，
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


def image_media_type(path: Path) -> str:
    """按扩展名给 Content-Type（未知扩展名按 jpeg）。"""
    return _IMAGE_MEDIA_TYPES.get(path.suffix.lower(), 'image/jpeg')


def image_mime_from_bytes(data: bytes) -> str:
    """按**文件头**判格式，不看扩展名。

    工坊封面统一存成 `<id>.jpg`，但里面经常是 GIF（真的动图）或 PNG。
    以前这里缺 GIF 分支，于是动图被标成 image/jpeg 发出去 —— 浏览器靠嗅探
    还能显示，可 `fetch()` + `createImageBitmap()` 这条路会按 Blob 的 type
    选解码器，标错就直接解不出来，卡片只能回退到原图（于是又开始全速播动图）。
    """
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:2] == b"BM":
        return "image/bmp"
    return "image/jpeg"


def sniff_file_mime(path: Path) -> str:
    """读文件头判 MIME；读不到就按扩展名兜底。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(16)
    except OSError:
        return image_media_type(path)
    return image_mime_from_bytes(head)
