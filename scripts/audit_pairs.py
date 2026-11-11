"""核查可疑冲突对：每个共享文件到底是谁的、内容和原版是否一致。

用法： python scripts/audit_pairs.py <modA> <modB> ...
mod 名可以是 addonlist 里的相对路径，也可以是 vpk 文件名。
"""
from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
import vpk  # noqa: E402
from services.mod_scanner import _parse_addoninfo  # noqa: E402

GAME = Path(r"D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2")
ADDONS = GAME / "addons"


def resolve(name: str) -> Path:
    for cand in (ADDONS / name, ADDONS / name.replace("\\", "/"), ADDONS / "workshop" / name):
        if cand.exists():
            return cand
    p = ADDONS / "workshop" / f"{name}.vpk"
    if p.exists():
        return p
    raise FileNotFoundError(name)


def index(path: Path) -> dict[str, tuple[int, int]]:
    """{path: (crc32, size)}，只读目录树。"""
    v = vpk.VPK(str(path), read_header_only=False)
    out = {}
    for p in (v.tree or {}):
        m = v.get_file_meta(p)
        out[p] = (m.get("crc32", 0), m.get("file_length", 0))
    return out


def title_of(path: Path) -> str:
    try:
        v = vpk.VPK(str(path), read_header_only=False)
    except Exception:
        return "(读取失败)"
    for cand in ("addoninfo.txt", "AddonInfo.txt"):
        try:
            fp = v.get_file(cand)
        except Exception:
            continue
        if fp:
            info = _parse_addoninfo(fp.read())
            return info.get("title") or "(无标题)"
    return "(无标题)"


def main() -> int:
    names = sys.argv[1:]
    if len(names) != 2:
        print("需要两个 mod 名")
        return 2

    print("读取官方 pak01_dir.vpk ...")
    official = index(GAME / "pak01_dir.vpk")
    print(f"  官方路径 {len(official)} 条\n")

    mods = {}
    for n in names:
        p = resolve(n)
        idx = index(p)
        mods[p.name] = idx
        print(f"{p.name}\n  标题: {title_of(p)}\n  文件: {len(idx)}\n")

    a_name, b_name = list(mods)
    shared = set(mods[a_name]) & set(mods[b_name])
    print(f"共享路径 {len(shared)} 条\n")

    buckets = defaultdict(list)
    for path in sorted(shared):
        ca, sa = mods[a_name][path]
        cb, sb = mods[b_name][path]
        off = official.get(path)
        if ca == cb:
            kind = "内容相同(谁赢都一样)"
        elif off and off[0] == ca:
            kind = f"B {b_name} 改过 / A {a_name} 是原版副本"
        elif off and off[0] == cb:
            kind = f"A {a_name} 改过 / B {b_name} 是原版副本"
        elif off:
            kind = "两边都改过原版 → 硬冲突"
        else:
            kind = "私有路径,两边内容不同"
        buckets[kind].append((path, ca, cb, off))

    for kind, rows in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        print(f"== {kind}  ({len(rows)} 条)")
        for path, ca, cb, off in rows[:12]:
            print(f"   {path}")
            print(f"      A crc={ca:08x} len={mods[a_name][path][1]:<8} B crc={cb:08x} len={mods[b_name][path][1]:<8}"
                  f" 原版={'crc=%08x' % off[0] if off else '不存在'}")
        if len(rows) > 12:
            print(f"   …另 {len(rows) - 12} 条")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
