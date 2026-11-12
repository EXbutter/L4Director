"""给缺 addoninfo.txt 的 VPK 补一份最小的 addoninfo.txt。

背景：L4D2 只把「带 addoninfo.txt 的 VPK」当作可管理的附加内容 —— 没有这个文件，
它不会出现在「附加内容」列表里，保存 addonlist.txt 时还会把该条目无条件写回 "1"，
于是软件里点的「禁用」在游戏里永远不生效（社区里管这类包叫「幽灵 Mod」）。

修复方式是把整个包读出来、补上 addoninfo.txt 再重新打包：
VPK 的文件树在文件头部，追加一个条目必须重写树并平移所有数据偏移，
没有「就地插入」这回事，因此只能重建。重建前后逐条目比对，任何一条对不上就不替换，
原文件始终保持原样（新包先写同盘的临时文件，最后 os.replace 原子替换）。
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional

import vpk as vpk_lib


def _open(path: Path):
    """打开 VPK；路径表不是合法 UTF-8 时退回 latin-1（与 conflict_engine.open_vpk 一致）。"""
    try:
        return vpk_lib.VPK(str(path))
    except UnicodeDecodeError:
        return vpk_lib.VPK(str(path), path_enc='latin-1')


def _read_entries(v) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    for entry in v:
        if not isinstance(entry, str) or not entry.strip():
            continue
        out[entry] = v.get_file(entry).read()
    return out


def _escape(value: str) -> str:
    """KeyValues 里只要处理双引号和换行，别把玩家写得花里胡哨的标题搞坏。"""
    return (value or '').replace('"', "'").replace('\r', ' ').replace('\n', ' ').strip()


def build_addoninfo(title: str, author: str = '', description: str = '', version: str = '1.0') -> str:
    lines = ['"addoninfo"', '{']
    lines.append(f'\t"addontitle"\t\t"{_escape(title)}"')
    lines.append(f'\t"addonversion"\t\t"{_escape(version)}"')
    lines.append(f'\t"addonauthor"\t\t"{_escape(author)}"')
    if description:
        lines.append(f'\t"addondescription"\t"{_escape(description)}"')
    lines.append('}')
    # Valve 的 KeyValues 用 CRLF，游戏里解析器对 LF 也宽容，但保持一致更保险
    return '\r\n'.join(lines) + '\r\n'


def inject_addoninfo(
    vpk_path: Path,
    title: Optional[str] = None,
    author: str = '',
    description: str = '',
) -> dict:
    """把 addoninfo.txt 写进 vpk_path。返回 {status, entries, backup}。

    status:
      - 'already'  包里本来就有 addoninfo.txt，什么都没做
      - 'ok'       已重建并替换
    失败时抛 RuntimeError（原文件不受影响）。
    """
    vpk_path = Path(vpk_path)
    if not vpk_path.is_file():
        raise RuntimeError('文件不存在，可能已被移动或删除')

    src = _open(vpk_path)
    entries = _read_entries(src)
    if any(e.rsplit('/', 1)[-1].lower() == 'addoninfo.txt' for e in entries):
        return {'status': 'already', 'entries': len(entries)}

    # 非 ASCII 路径经 latin-1 解码后无法原样重建（编码信息已经丢了），直接拒绝，别赌
    bad = [e for e in entries if not e.isascii()]
    if bad:
        raise RuntimeError(f'包内含有非 ASCII 路径（{bad[0]}），无法安全重建')

    title = title or vpk_path.stem
    staging = Path(tempfile.mkdtemp(prefix='.l4d-addoninfo-', dir=str(vpk_path.parent)))
    new_vpk = vpk_path.with_name(vpk_path.name + '.repack')
    try:
        for name, data in entries.items():
            dst = staging / name.replace('/', os.sep)
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
        (staging / 'addoninfo.txt').write_text(
            build_addoninfo(title, author, description), encoding='utf-8', newline=''
        )

        vpk_lib.new(str(staging)).save(str(new_vpk))

        # —— 校验：条目一个不少、字节完全一致，并且新包能被正常打开 ——
        check = _open(new_vpk)
        got = _read_entries(check)
        for name, data in entries.items():
            if got.get(name) != data:
                raise RuntimeError(f'重建校验失败（{name} 内容不一致），已放弃')
        if 'addoninfo.txt' not in got:
            raise RuntimeError('重建校验失败（没有写入 addoninfo.txt），已放弃')

        os.replace(new_vpk, vpk_path)
        return {'status': 'ok', 'entries': len(got), 'title': title}
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        if new_vpk.exists():
            try:
                new_vpk.unlink()
            except OSError:
                pass
