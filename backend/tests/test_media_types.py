"""图片 MIME 判定：按文件头优先，扩展名兜底。

标错类型的真实后果：`fetch()` + `createImageBitmap()` 会按 Blob.type 选解码器，
GIF 被标成 image/jpeg 就解不出来，卡片只能静默回退（动图白做）。
"""
from pathlib import Path

import pytest

from services.media_types import image_media_type, image_mime_from_bytes, sniff_file_mime

PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 16
JPEG = b'\xff\xd8\xff\xe0' + b'\x00' * 16
GIF87 = b'GIF87a' + b'\x00' * 16
GIF89 = b'GIF89a' + b'\x00' * 16
WEBP = b'RIFF' + b'\x00\x00\x00\x00' + b'WEBP' + b'\x00' * 8
BMP = b'BM' + b'\x00' * 16


@pytest.mark.parametrize('data,expected', [
    (PNG, 'image/png'),
    (JPEG, 'image/jpeg'),
    (GIF87, 'image/gif'),
    (GIF89, 'image/gif'),
    (WEBP, 'image/webp'),
    (BMP, 'image/bmp'),
])
def test_按文件头识别(data, expected):
    assert image_mime_from_bytes(data) == expected


def test_认不出来时按_jpeg_兜底():
    assert image_mime_from_bytes(b'unknown-bytes') == 'image/jpeg'


@pytest.mark.parametrize('name,expected', [
    ('a.jpg', 'image/jpeg'),
    ('a.JPEG', 'image/jpeg'),
    ('a.png', 'image/png'),
    ('a.webp', 'image/webp'),
    ('a.gif', 'image/gif'),
    ('a.bmp', 'image/bmp'),
    ('a.svg', 'image/svg+xml'),
    ('a.unknown', 'image/jpeg'),
])
def test_按扩展名判定(name, expected):
    assert image_media_type(Path(name)) == expected


def test_读文件头优先于扩展名(tmp_path):
    """工坊封面统一存成 <id>.jpg，实际可能是 GIF —— 必须按内容判。"""
    fake = tmp_path / 'cover.jpg'
    fake.write_bytes(GIF89)
    assert sniff_file_mime(fake) == 'image/gif'

    real = tmp_path / 'real.jpg'
    real.write_bytes(JPEG)
    assert sniff_file_mime(real) == 'image/jpeg'


def test_文件读不到时按扩展名兜底(tmp_path):
    assert sniff_file_mime(tmp_path / 'missing.png') == 'image/png'
