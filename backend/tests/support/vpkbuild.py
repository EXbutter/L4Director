"""测试专用的最小 VPK 写入器。

与 ``backend/bench_scan.py`` 的 ``write_vpk`` 同源（VPK v1：header + 目录树 + 内嵌数据）。
测试里自带一份而不是 import bench_scan，是因为 bench_scan 在 **import 时**就会把
HOME/USERPROFILE 改到它自己的临时目录，会打乱 pytest 的隔离环境。

格式变更时两处要一起改：bench_scan.write_vpk 与这里。
"""
import base64
import binascii
import struct
from pathlib import Path

VPK_SIGNATURE = 0x55AA1234
VPK_HEADER_LENGTH_V1 = 12   # 3 * uint32
ARCHIVE_INDEX_INLINE = 0x7FFF

# 1x1 的最小合法 JPEG，扮演 addonimage.jpg 封面
JPEG_1PX = base64.b64decode(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
)


def _tree_length(tree: dict[str, dict[str, list[str]]]) -> int:
    length = 0
    for ext, paths in tree.items():
        length += len(ext.encode()) + 2
        for relpath, names in paths.items():
            length += len(relpath.encode()) + 2
            for name in names:
                length += len(name.encode()) + 1 + 18
    return length + 1


def write_vpk(target: Path, files: dict[str, bytes]) -> int:
    """把 {路径: 内容} 写成合法 VPK v1，返回文件字节数。"""
    target = Path(target)
    tree: dict[str, dict[str, list[str]]] = {}
    lookup: dict[tuple[str, str, str], bytes] = {}

    for full_path, data in files.items():
        rel, _, filename = full_path.replace('\\', '/').rpartition('/')
        relpath = rel if rel else ' '
        name, _, ext = filename.rpartition('.')
        if not name or not ext:
            raise ValueError(f'VPK 内文件必须带扩展名: {full_path}')
        tree.setdefault(ext, {}).setdefault(relpath, []).append(name)
        lookup[(ext, relpath, name)] = data

    tree_len = _tree_length(tree)
    meta = bytearray()
    blobs: list[bytes] = []
    cursor = 0
    for ext, paths in tree.items():
        meta += ext.encode() + b'\x00'
        for relpath, names in paths.items():
            meta += relpath.encode() + b'\x00'
            for name in names:
                data = lookup[(ext, relpath, name)]
                meta += name.encode() + b'\x00'
                meta += struct.pack(
                    'IHHIIH',
                    binascii.crc32(data) & 0xFFFFFFFF,
                    0,                      # preload_length
                    ARCHIVE_INDEX_INLINE,   # 数据在本文件内
                    cursor,
                    len(data),
                    0xFFFF,
                )
                cursor += len(data)
                blobs.append(data)
            meta += b'\x00'
        meta += b'\x00'
    meta += b'\x00'

    assert len(meta) == tree_len, f'目录树长度错误: {len(meta)} != {tree_len}'
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, 'wb') as fh:
        fh.write(struct.pack('III', VPK_SIGNATURE, 1, tree_len))
        fh.write(bytes(meta))
        for data in blobs:
            fh.write(data)
    return VPK_HEADER_LENGTH_V1 + tree_len + cursor


def _filler(salt: str, size: int) -> bytes:
    pattern = f'{salt}|'.encode('utf-8')
    return (pattern * (size // len(pattern) + 1))[:size]


def addoninfo(title: str, author: str = 'Tester', type_: str = 'weapon',
              tags: str = '武器|模型') -> bytes:
    return (
        '"AddonInfo"\n{\n'
        f'\taddontitle "{title}"\n'
        '\taddonversion "1.0"\n'
        f'\taddonauthor "{author}"\n'
        '\taddondescription 测试用合成 Mod\n'
        f'\taddontags "{tags}"\n'
        f'\taddontype "{type_}"\n'
        '}\n'
    ).encode('utf-8')


def mod_files(title: str, entries: int = 8, size_kb: int = 1,
              extra: dict[str, bytes] | None = None,
              with_addoninfo: bool = True) -> dict[str, bytes]:
    """一个「看起来正常」的 Mod：addoninfo + 封面 + 若干美术资源。"""
    kb = max(1, size_kb) * 1024
    files: dict[str, bytes] = {'addonimage.jpg': JPEG_1PX}
    if with_addoninfo:
        files['addoninfo.txt'] = addoninfo(title)
    for i in range(max(0, entries)):
        files[f'materials/models/test/{title}_{i:03d}.vmt'] = _filler(f'{title}{i}', kb)
    if extra:
        files.update(extra)
    return files


def make_mod(addons_dir: Path, filename: str, **kwargs) -> Path:
    """在 addons 目录里生成一个 VPK，返回路径。"""
    title = kwargs.pop('title', Path(filename).stem)
    path = Path(addons_dir) / filename
    write_vpk(path, mod_files(title, **kwargs))
    return path


def write_addonlist(addons_dir: Path, states: dict[str, bool]) -> Path:
    """按游戏格式写 addonlist.txt（键是 vpk 文件名）。"""
    lines = ['"AddonList"', '{']
    for name, enabled in states.items():
        lines.append(f'\t"{name}"\t\t"{1 if enabled else 0}"')
    lines.append('}')
    path = Path(addons_dir) / 'addonlist.txt'
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return path
