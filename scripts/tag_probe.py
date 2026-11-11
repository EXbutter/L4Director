# -*- coding: utf-8 -*-
"""标签校准探针：把每个已标注 Mod 的真实文件构成摊开来看。

用法：
  python scripts/tag_probe.py            # 打印证据摘要
  python scripts/tag_probe.py --only Baka
"""
from __future__ import annotations

import sys
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'backend'))

ADDONS = Path(r'D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2\addons')
TABLE = ROOT / '标签测试对照表.txt'


def load_ground_truth() -> list[dict]:
    rows = []
    for line in TABLE.read_text(encoding='utf-8-sig').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        cols = [c.strip() for c in line.split('\t')]
        if len(cols) < 3:
            continue
        ident, title, auto = cols[0], cols[1], cols[2]
        true = ''
        for c in cols[2:]:
            if c.startswith('--'):
                true = c[2:].replace('/', ',').strip()
                break
        # 自动标签被写串行的情况：第 3 列以 -- 开头
        if auto.startswith('--'):
            auto = auto[2:].replace('/', ',')
        rows.append({'ident': ident, 'title': title, 'auto': auto, 'true': true})
    return rows


def resolve(ident: str) -> Path | None:
    p = ADDONS / ident
    if p.exists():
        return p
    stem = Path(ident).stem
    for cand in (
        ADDONS / 'workshop' / ident,
        ADDONS / 'workshop' / stem / f'{stem}.vpk',
        ADDONS / 'workshop' / stem / ident,
    ):
        if cand.exists():
            return cand
    return None


def read_manifest(path: Path) -> tuple[set[str], str]:
    """返回 (清单, 状态)。解析失败时用二进制串扫描兜底。"""
    sys.path.insert(0, str(ROOT / 'backend'))
    try:
        import vpk as vpk_lib  # type: ignore
    except Exception:
        return set(), 'no-vpk-lib'
    try:
        v = vpk_lib.VPK(str(path.resolve()), read_header_only=False)
        files = {p.lower().replace('\\', '/') for p in v if isinstance(p, str) and p.strip()}
        if not files and isinstance(getattr(v, 'tree', None), dict):
            files = {p.lower().replace('\\', '/') for p in v.tree if isinstance(p, str)}
        return files, 'ok' if files else 'empty'
    except Exception as e:
        files = binary_scan(path)
        return files, f'fallback({type(e).__name__})'


_PROBE = re.compile(
    rb'((?:materials|models|sound|scripts|maps|missions|resource|particles|scenes)/'
    rb'[\w \-\.\(\)\[\]#@!$&+=,;~\'`^]{1,120}?\.(?:vmt|vtf|mdl|vvd|vtx|phy|wav|mp3|ogg|nut|txt|bsp|pcf|vpcf|vcd|ani))',
    re.IGNORECASE,
)


def binary_scan(path: Path) -> set[str]:
    """VPK 头损坏 / 编码异常时的兜底：直接在字节流里捞合法资源路径。"""
    out: set[str] = set()
    try:
        data = path.read_bytes()
    except Exception:
        return out
    for m in _PROBE.finditer(data):
        try:
            out.add(m.group(1).decode('ascii', 'ignore').lower())
        except Exception:
            pass
    return out


def addoninfo_text(path: Path) -> str:
    try:
        with open(path, 'rb') as f:
            raw = f.read(200_000)
        for enc in ('utf-8', 'gbk', 'latin-1'):
            try:
                t = raw.decode(enc, errors='replace')
                if 'addon' in t.lower():
                    return t
            except Exception:
                continue
    except Exception:
        pass
    return ''


FEATURES = [
    ('bsp', lambda p, n: p.endswith('.bsp')),
    ('mission', lambda p, n: p.startswith('missions/')),
    ('v_model', lambda p, n: p.startswith('models/v_models/')),
    ('w_model', lambda p, n: p.startswith(('models/w_models/', 'models/weapons/'))),
    ('survivor', lambda p, n: 'models/survivors/' in p),
    ('infected', lambda p, n: 'models/infected/' in p),
    ('items', lambda p, n: p.startswith(('models/items/', 'models/props'))),
    ('vgui', lambda p, n: p.startswith('materials/vgui/')),
    ('resource', lambda p, n: p.startswith('resource/')),
    ('hud_mat', lambda p, n: p.startswith('materials/hud/')),
    ('sound', lambda p, n: p.startswith('sound/') and p.rsplit('.', 1)[-1] in ('wav', 'mp3', 'ogg')),
    ('nut', lambda p, n: p.endswith('.nut')),
    ('script_other', lambda p, n: p.startswith('scripts/') and p.endswith(('.txt', '.cfg', '.keyvalues'))),
    ('vtf', lambda p, n: p.endswith('.vtf')),
    ('vmt', lambda p, n: p.endswith('.vmt')),
    ('mdl', lambda p, n: p.endswith('.mdl')),
    ('pcf', lambda p, n: p.endswith(('.pcf', '.vpcf'))),
    ('ani_vcd', lambda p, n: p.endswith(('.ani', '.vcd'))),
]


def main():
    only = None
    if '--only' in sys.argv:
        only = sys.argv[sys.argv.index('--only') + 1].lower()

    rows = load_ground_truth()
    print(f'{"ident":<18}{"true":<16}{"n":>7}  ' + ' '.join(f'{k[:7]:>7}' for k, _ in FEATURES) + '  flags')
    for r in rows:
        if only and only not in (r['ident'] + r['title']).lower():
            continue
        path = resolve(r['ident'])
        if not path:
            print(f'{r["ident"]:<18}{r["true"] or "(未标)":<16}{"MISSING":>7}')
            continue
        files, status = read_manifest(path)
        counts = []
        for _k, fn in FEATURES:
            counts.append(sum(1 for p in files if fn(p, None)))
        ai = addoninfo_text(path)
        flags = []
        for key in ('addonContent_Campaign', 'addonContent_Survivor', 'addonContent_Weapon',
                    'addonContent_Script', 'addonContent_Map'):
            if re.search(key, ai, re.IGNORECASE):
                flags.append(key.replace('addonContent_', '') + '=1')
        m = re.search(r'addonSteamAppID\s+"?(\d+)', ai, re.IGNORECASE)
        print(
            f'{r["ident"]:<18}{(r["true"] or "(未标)"):<16}{len(files):>7}  '
            + ' '.join(f'{c:>7}' for c in counts)
            + f'  {"," .join(flags)} [{status}]'
        )


if __name__ == '__main__':
    main()
