"""对比「老版路径重名」与「新版内容+官方基准」两种冲突判定。

只读：不改 addonlist.txt、不写缓存。
用法:
    ./.venv/Scripts/python.exe scripts/conflict_compare.py
    ./.venv/Scripts/python.exe scripts/conflict_compare.py --verbose
"""
import argparse
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))

import vpk as vpk_lib
from services.mod_scanner import _parse_addoninfo
from services.conflict_engine import (
    OfficialIndex, read_index, analyze, summarize, is_relevant_path,
    severity_of, role_tags, SEVERITY_HARD, SEVERITY_SCRIPT, SEVERITY_SOFT, SEVERITY_ENTRY,
    SEVERITY_COPY,
)


def parse_addonlist(p: Path) -> dict[str, bool]:
    raw = p.read_bytes()
    text = raw.decode('utf-8-sig', errors='replace') if raw[:3] == b'\xef\xbb\xbf' else raw.decode('gbk', errors='replace')
    out: dict[str, bool] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith('"'):
            continue
        try:
            name = line.split('"')[1]
        except IndexError:
            continue
        out[name] = line.rstrip().endswith('"1"')
    return out


def resolve(entry: str, addons: Path) -> Path | None:
    rel = entry.replace('\\', '/')
    p = addons / rel
    if p.exists():
        return p
    if rel.lower().startswith('workshop/'):
        p2 = addons / 'workshop' / rel.split('/', 1)[1]
        if p2.exists():
            return p2
    return None


def legacy_conflicts(mods: dict[str, dict], subset: set[str]) -> dict[tuple[str, str], list[str]]:
    """复现 backend/services/mod_scanner.py::_detect_conflicts 的判定。"""
    from services.mod_scanner import _is_conflict_file
    owners: dict[str, list[str]] = defaultdict(list)
    for name in subset:
        for path in mods[name]:
            if is_relevant_path_legacy(path):
                owners[path].append(name)
    pairs: dict[tuple[str, str], list[str]] = defaultdict(list)
    for path, os_ in owners.items():
        if len(os_) < 2:
            continue
        for i in range(len(os_)):
            for j in range(i + 1, len(os_)):
                pairs[tuple(sorted((os_[i], os_[j])))].append(path)
    return pairs


def is_relevant_path_legacy(path: str) -> bool:
    from services.mod_scanner import _is_conflict_file
    return _is_conflict_file(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', default=r'D:\SteamLibrary\steamapps\common\Left 4 Dead 2')
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()

    game = Path(args.game)
    addons = game / 'left4dead2' / 'addons'
    listing = parse_addonlist(addons.parent / 'addonlist.txt')
    enabled = [k for k, v in listing.items() if v]
    disabled = [k for k, v in listing.items() if not v]
    print(f'addonlist.txt: {len(listing)} 条 / 启用 {len(enabled)} / 禁用 {len(disabled)}')
    print('  已排除的禁用 mod: ' + (', '.join(disabled) or '无'))

    t0 = time.time()
    mods: dict[str, dict[str, tuple[int, int]]] = {}
    titles: dict[str, str] = {}
    broken = []
    for entry in enabled:
        p = resolve(entry, addons)
        if p is None:
            broken.append(entry)
            continue
        try:
            tree = read_index(p)
        except Exception as e:
            broken.append(f'{entry} ({e})')
            continue
        if not tree:
            broken.append(f'{entry} (空清单)')
            continue
        mods[entry] = tree
        v = vpk_lib.VPK(str(p), read_header_only=False)
        fp = v.get_file('addoninfo.txt') if 'addoninfo.txt' in (v.tree or {}) else None
        if fp:
            try:
                titles[entry] = _parse_addoninfo(fp.read()).get('title') or ''
            except Exception:
                pass
    print(f'读取 {len(mods)} 个 vpk（{time.time() - t0:.2f}s），失败 {len(broken)}')
    for b in broken:
        print('   !', b)

    official = OfficialIndex.from_game(game, verbose=True)

    from services.conflict_engine import ModFiles
    hud = {n for n, f in mods.items() if ModFiles(n, Path(), f).is_hud}
    normal = set(mods) - hud
    print(f'HUD/UI 型 mod（整包跳过）: {len(hud)}  → ' + ', '.join(sorted(hud)))
    print(f'参与判定的 mod: {len(normal)}')

    def title(n: str) -> str:
        t = titles.get(n) or n
        return f'{t} [{Path(n).name}]'

    print('\n' + '=' * 68)
    print('方法一：老版 _detect_conflicts —— 只看路径重名（全部启用 mod，含 HUD）')
    print('=' * 68)
    legacy = legacy_conflicts(mods, set(mods))
    print(f'  文件重叠 {sum(len(v) for v in legacy.values()) // 2 if legacy else 0} 处')
    print(f'  判定冲突的 mod 对: {len(legacy)}')

    print('\n' + '=' * 68)
    print('方法二：新版 —— 内容等价 + 原版副本剔除 + 官方资源基准（排除 HUD / 禁用）')
    print('=' * 68)
    reports = analyze(mods, official, skip_hud=True)
    stats = summarize(reports)

    ROLE = {'campaign': '地图', 'art': '美术', 'script': '脚本', 'hud': 'HUD'}
    pos = {k: i + 1 for i, k in enumerate(listing)}

    def role_of(n: str) -> str:
        return ' / '.join(role_tags(mods.get(n, {})))

    def rank_of(n: str) -> str:
        return f'addonlist #{pos.get(n, "?")}'

    pristine = {n: reports[n].pristine_count for n in reports if reports[n].pristine_count}
    print(f'  识别到「官方原版副本」（不算冲突）: {len(pristine)} 个 mod，'
          f'共 {sum(pristine.values())} 个文件')
    for n, c in sorted(pristine.items(), key=lambda kv: -kv[1])[:6]:
        print(f'    {c:4d} 个原版文件  {title(n)}')

    def collect(sev):
        out = set()
        for name, rep in reports.items():
            for c in rep.conflicts:
                if c.severity == sev:
                    out.add(tuple(sorted((name, c.other))))
        return out

    hard_pairs = collect(SEVERITY_HARD)
    script_pairs = collect(SEVERITY_SCRIPT)
    entry_pairs = set()
    copy_pairs = set()
    soft_pairs = set()
    for name, rep in reports.items():
        for c in rep.entries:
            entry_pairs.add(tuple(sorted((name, c.other))))
        for c in rep.copies:
            copy_pairs.add(tuple(sorted((name, c.other))))
        for c in rep.overlaps:
            soft_pairs.add(tuple(sorted((name, c.other))))
    print(f'\n  硬冲突（双方都改过官方资源）    : {len(hard_pairs)} 对')
    print(f'  脚本冲突（共享库/脚本重名）     : {len(script_pairs)} 对')
    print(f'  单向覆盖（一方是官方原版副本）  : {len(copy_pairs)} 对')
    print(f'  脚本入口重叠（单实例约定文件）  : {len(entry_pairs)} 对')
    print(f'  软重叠（私有路径重名，同系列）  : {len(soft_pairs)} 对')

    def conflict_obj(a: str, b: str, sev: str):
        rep = reports[a]
        pool = {
            SEVERITY_SOFT: rep.overlaps,
            SEVERITY_ENTRY: rep.entries,
            SEVERITY_COPY: rep.copies,
        }.get(sev, rep.conflicts)
        for c in pool:
            if c.other == b and c.severity == sev:
                return c
        return None

    def files_of(a: str, b: str, sev: str) -> list[str]:
        c = conflict_obj(a, b, sev)
        return c.files if c else []

    KEEP = {'art': 3, 'script': 4, 'hud': 2, 'campaign': 1}

    def dump(pairs, sev, limit=10):
        if not pairs:
            return
        rows = [((a, b), files_of(a, b, sev)) for a, b in pairs]
        rows.sort(key=lambda r: -len(r[1]))
        for (a, b), files in rows[:limit]:
            kinds = defaultdict(int)
            for f in files:
                kinds[f.split('/')[0]] += 1
            detail = ', '.join(f'{k}×{n}' for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]))
            print(f'    [{role_of(a)}] {title(a)}  ({rank_of(a)})')
            print(f'    ×  [{role_of(b)}] {title(b)}  ({rank_of(b)})')
            print(f'       {len(files)} 个文件: {detail}')
            if sev == SEVERITY_HARD:
                # 不断言顺序方向：只给可操作建议 —— 想留住哪份就把它往上移
                keep = a if KEEP.get(reports[a].role, 0) >= KEEP.get(reports[b].role, 0) else b
                other = b if keep == a else a
                print(f'       两者只有一份能生效。要留住「{title(keep)}」，'
                      f'把它移到 {rank_of(other)} 之上')
            elif sev == SEVERITY_SOFT:
                print('       同系列分发包共用素材，谁生效都不影响观感')
            elif sev == SEVERITY_COPY:
                obj = conflict_obj(a, b, sev)
                side = getattr(obj, 'pristine_of', None) if obj else None
                if side and side in (a, b):
                    other_side = b if side == a else a
                    print(f'       {title(side)} 带的是官方原版副本（等于没改），'
                          f'自身不会改变任何外观')
                    print(f'       但若它生效，会抹掉 {title(other_side)} 的这 {len(files)} 处改动；'
                          f'想保住就把 {title(other_side)} 移到它上面')
                else:
                    print('       一方带的是官方原版副本，只有它生效时才抹掉另一方的改动')
            if args.verbose:
                for f in files[:6]:
                    print(f'         - {f}')
            print()
        if len(rows) > limit:
            print(f'    …另 {len(rows) - limit} 对')

    print('\n  硬冲突明细（真正会互相顶掉的）:')
    dump(hard_pairs, SEVERITY_HARD)
    print('  脚本冲突明细:')
    dump(script_pairs, SEVERITY_SCRIPT)
    print('  单向覆盖明细（一方是原版副本，只会抹掉另一方）:')
    dump(copy_pairs, SEVERITY_COPY, limit=6)
    print('  脚本入口重叠（L4D2 只加载一份入口，装多个脚本 mod 必然出现）:')
    if entry_pairs:
        involved = sorted({m for p in entry_pairs for m in p})
        print(f'    涉及 {len(involved)} 个 mod: ' + ', '.join(titles.get(m) or m for m in involved))
    print('\n  软重叠明细（前 6 对，同系列分发包共用素材）:')
    dump(soft_pairs, SEVERITY_SOFT, limit=6)

    print('=' * 68)
    print('对比结论')
    print('=' * 68)
    functional = len(script_pairs)
    visual = len(hard_pairs)
    print(f'  老版报出                : {len(legacy)} 对')
    print(f'  新版·功能层冲突（脚本）  : {functional} 对  ← 会改变玩法/报错')
    print(f'  新版·外观层互斥（资源）  : {visual} 对  ← 只有一个能显示，纯视觉')
    print(f'  新版降级为提示          : 入口重叠 {len(entry_pairs)} 对 / 软重叠 {len(soft_pairs)} 对')
    if legacy:
        noise = len(legacy) - functional - visual
        print(f'  老版多报噪音            : {noise} 对（{noise / len(legacy) * 100:.0f}%）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
