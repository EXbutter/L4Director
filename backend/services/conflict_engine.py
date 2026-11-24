"""更精确的 Mod 冲突判定引擎（原型）。

与现有 `_detect_conflicts`（只看"文件路径重名"）相比，这里引入了三层修正：

1. **内容等价**：VPK 目录项自带 CRC32 + 文件长度，两个 Mod 携带同一路径且
   指纹相同 = 无害覆盖，不算冲突。零解压成本。
2. **官方基准**：把游戏本体 `pak01_dir.vpk` 的目录树当作"官方资源名单"。
   覆盖官方路径说明两个 Mod 都在替换游戏自带资源（武器、角色、音效），
   只能有一个生效 = 硬冲突；官方没有的路径是 Mod 私有资源，重名多半是
   同系列 / 同作者的分发包共用素材，实际通常无感 = 软重叠。
3. **使用场景**：脚本类（scripts/、missions/）无论是否官方都单独成档，
   因为它们是常驻加载的，差异会互相打断。

同时按用户视角忽略元数据、引擎生成文件、HUD/UI 资源，并可整包跳过
HUD 型 Mod（vgui + resource 占比过半）。
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional

import vpk as vpk_lib

# ── 不参与判定 ────────────────────────────────────────────────
META_FILES = frozenset({
    'addoninfo.txt', 'addonimage.jpg', 'addonimage.png',
    'thumb.jpg', 'thumbnail.jpg', 'thumbnail.png',
    'logo.png', 'addon_logo.png', 'addon.dat', 'readme.txt',
})

# 引擎每次启动都会重建 / 只是索引，内容差异无意义
GENERATED_FILES = frozenset({
    'sound/sound.cache',
    'scripts/weapon_manifest.txt',   # 引擎导出，非模组资产
})

# HUD / UI 资源：互相覆盖是常态，不算冲突
UI_PREFIXES = (
    'materials/vgui/',
    'materials/console/',
    'materials/letterbox/',
    'materials/tff/',
    'materials/correction/',
    'resource/',
)

# 常驻加载的玩法脚本：差异会互相打断，单独成档
SCRIPT_PREFIXES = ('scripts/vscripts/', 'scripts/', 'missions/')

# 单实例「入口」文件：每个脚本类 Mod 都必须自带一份，引擎只加载优先级最高的那一份。
# 多个 Mod 各带一份属于 L4D2 的结构性限制，不是普通的资源争夺，降级为提示。
ENTRY_FILES = frozenset({
    'scripts/vscripts/director_base_addon.nut',
    'scripts/vscripts/scriptedmode_addon.nut',
    'scripts/vscripts/director_base.nut',
})

SEVERITY_ENTRY = 'entry'      # 脚本入口重叠（单实例约定文件）
SEVERITY_HARD = 'hard'        # 双方都改过官方资源且内容不同：互斥，只能一个生效
SEVERITY_SCRIPT = 'script'    # 脚本重名：功能可能被顶掉
SEVERITY_COPY = 'copy'        # 一方是官方原版副本：单向覆盖，只会抹掉另一方
SEVERITY_SOFT = 'soft'        # 私有路径重名：多为同系列共用素材

SEVERITY_ORDER = {
    SEVERITY_HARD: 0, SEVERITY_SCRIPT: 1, SEVERITY_COPY: 2,
    SEVERITY_ENTRY: 3, SEVERITY_SOFT: 4,
}


# ── 冲突类型（kind）与闪退风险（risk）─────────────────────────────────
# kind 说明「这是什么资源」，用于在提示里说清「哪几个文件、什么类型」，
# 也是界面分组/图标的基础。风险（risk）与严重度（severity）是**两件不同的事**：
# 严重度看「是不是互斥」，风险看「装到一起会不会崩」。两个包整份替换同一模型
# 是 hard 冲突（互斥），但因为双方都成套，谁赢都不崩（risk=low）；反过来 A 只带
# .mdl、B 只带 .vtx —— 甚至没有一条相同路径（不是路径冲突），最终磁盘上却是
# A 的网格配 B 的顶点数据，加载时崩（risk=high）。样本里 74 组闪退全是这种「包
# 只打了半个模型」造成的。
RISK_HIGH = 'high'
RISK_MEDIUM = 'medium'
RISK_LOW = 'low'

KIND_LABELS = {
    'model': '模型',
    'material': '材质',
    'texture': '贴图',
    'particle': '粒子',
    'sound': '音效',
    'script': '脚本',
    'map': '地图',
    'ui': '界面',
    'other': '其他',
}

# 主类型并列时的优先顺序（让「模型/材质」这类主资源排在前面，便于展示）
KIND_ORDER = ['model', 'material', 'texture', 'particle', 'sound', 'script', 'map', 'ui', 'other']

# 模型文件集：一个 .mdl 必须配齐 .vtx/.vvd 才能被正确加载；.phy 可选。
# DX90/DX80 是同一模型的另一套 LOD，必须归到同一个桶（见 bundle_of）。
_CRITICAL_EXTS = frozenset({'mdl', 'vtx', 'vvd'})
_OPTIONAL_EXTS = frozenset({'phy'})
_RISK_RANK = {RISK_HIGH: 3, RISK_MEDIUM: 2, RISK_LOW: 1}


@lru_cache(maxsize=65536)
def classify_path(path: str) -> str:
    """把资源路径归到一个粗粒度类型（kind）。顺序敏感：先判 UI，再判其它。"""
    p = path.lower().replace('\\', '/')
    if p.startswith(('materials/vgui/', 'resource/')):
        return 'ui'
    if p.startswith('models/'):
        return 'model'
    if p.startswith('materials/'):
        return 'texture' if p.endswith('.vtf') else 'material'
    if p.startswith('sound/'):
        return 'sound'
    if p.startswith('particles/'):
        return 'particle'
    if p.startswith(('scripts/', 'missions/')):
        return 'script'
    if p.startswith('maps/'):
        return 'map'
    return 'other'


@lru_cache(maxsize=65536)
def bundle_of(path: str) -> Optional[tuple[str, str]]:
    """模型文件集归一化：返回 (家族 stem, 扩展名)；非模型文件返回 None。

    `models/x/y.mdl`        -> ('models/x/y', 'mdl')
    `models/x/y.dx90.vtx`   -> ('models/x/y', 'dx90.vtx')   # DX90 LOD 同桶
    `materials/x/y.vmt`     -> None
    `models/x/y.txt`        -> None
    """
    p = path.lower().replace('\\', '/')
    if not p.startswith('models/'):
        return None
    for ext in ('dx90.vtx', 'dx80.vtx', 'dx90.vvd', 'dx80.vvd'):
        if p.endswith('.' + ext):
            return p[: -(len(ext) + 1)], ext
    base, dot, ext = p.rpartition('.')
    if not dot:
        return None
    if ext in ('mdl', 'vtx', 'vvd', 'phy', 'ani'):
        return base, ext
    return None


@lru_cache(maxsize=65536)
def path_facts(path: str) -> tuple[bool, Optional[tuple[str, str]]]:
    """(是否参与判定, 模型文件集归属)。元数据 / UI / 生成文件一律 (False, None)。"""
    if not is_relevant_path(path):
        return False, None
    return True, bundle_of(path)


def dominant_kind(paths: Iterable[str]) -> tuple[str, dict[str, int]]:
    """一组文件的主类型（按数量最多者，并列按 KIND_ORDER）与各类型计数。"""
    counts: dict[str, int] = {}
    for p in paths:
        k = classify_path(p)
        counts[k] = counts.get(k, 0) + 1
    if not counts:
        return 'other', {}
    kind = sorted(
        counts,
        key=lambda k: (-counts[k], KIND_ORDER.index(k) if k in KIND_ORDER else 99),
    )[0]
    return kind, counts


def _ext_family(ext: str) -> str:
    if 'vtx' in ext:
        return 'vtx'
    if 'vvd' in ext:
        return 'vvd'
    return ext


def _label(labels: Optional[dict], name: str) -> str:
    if labels and name in labels:
        return labels[name]
    return name


def _pair_bundle_risk(ex_a: set, ex_b: set):
    """比较两方在同一个模型文件集里各自提供的扩展名，返回 (risk, diff_exts, cross)。

    * 双方提供的集合完全一致：齐全(⊇mdl/vtx/vvd)→low；都不全→medium
    * 一方缺少的关键扩展恰好是另一方提供的（cross）→ high（拼出不匹配的模型）
    * 只差 .phy 等可选扩展 → medium
    """
    if ex_a == ex_b:
        if _CRITICAL_EXTS <= ex_a:
            return RISK_LOW, set(), False
        return RISK_MEDIUM, set(_CRITICAL_EXTS - ex_a), False
    miss_a = _CRITICAL_EXTS - ex_a
    miss_b = _CRITICAL_EXTS - ex_b
    cross = (miss_a & ex_b) | (miss_b & ex_a)
    if cross:
        return RISK_HIGH, cross, True
    return RISK_MEDIUM, (ex_a ^ ex_b) & _OPTIONAL_EXTS, False


@lru_cache(maxsize=65536)
def _is_ui_path(path: str) -> bool:
    return path.lower().replace('\\', '/').startswith(UI_PREFIXES)


@dataclass
class ModFiles:
    name: str
    path: Path
    files: dict[str, tuple[int, int]] = field(default_factory=dict)  # 路径 -> (crc32, size)
    title: Optional[str] = None

    @property
    def is_hud(self) -> bool:
        if not self.files:
            return False
        ui = sum(1 for p in self.files if p.startswith(('materials/vgui/', 'resource/')))
        ratio = ui / len(self.files)
        return ratio >= 0.5 or (ui >= 8 and ratio >= 0.3)


@dataclass
class PairConflict:
    other: str
    severity: str
    files: list[str]
    pristine_of: Optional[str] = None   # copy 级专用：哪一方携带的是官方原版副本
    # 类型 / 风险 / 建议（v2）：让「冲突条目」也能说清「哪几类文件、装一起崩不崩、怎么办」。
    kind: str = 'other'                       # 主类型（classify_path 聚合）
    kinds: dict = field(default_factory=dict)  # 多类型计数（仅当 >1 种时回传）
    risk: str = RISK_LOW                      # 该冲突的闪退风险
    reason: str = ''                          # 风险说明（human readable）
    advice: dict = field(default_factory=dict)  # {action, target?, text?}

    @property
    def count(self) -> int:
        return len(self.files)


@dataclass
class ModReport:
    name: str
    title: Optional[str] = None
    conflicts: list[PairConflict] = field(default_factory=list)   # hard / script
    entries: list[PairConflict] = field(default_factory=list)     # 单实例入口文件重叠
    copies: list[PairConflict] = field(default_factory=list)      # 对方或我是原版副本，单向覆盖
    overlaps: list[PairConflict] = field(default_factory=list)    # 私有路径重名 / UI 重叠
    role: str = 'art'             # campaign / script / art / hud
    pristine_count: int = 0       # 携带的「官方原版副本」文件数（不影响任何人）
    # 包级闪退风险（v2）：即使两条路径毫不重叠，各自只带半个模型也会崩。
    crash_risk: str = RISK_LOW
    crash_with: str = ''          # 与之拼出闪退的另一个包
    crash_reason: str = ''
    crash_files: list[str] = field(default_factory=list)
    crash_bundle: str = ''        # 出问题的模型文件集 stem
    crash_advice: dict = field(default_factory=dict)

    @property
    def worst(self) -> Optional[str]:
        if not self.conflicts:
            return None
        return min((c.severity for c in self.conflicts), key=SEVERITY_ORDER.get)


def is_campaign_pack(files: dict[str, tuple[int, int]]) -> bool:
    """这个包是不是「战役地图包」。

    不能见到 .bsp 就当地图：材质/音效整合包常顺手塞一张测试地图，
    体量上连 1% 都不到（`Reality Mixture` 200MB 材质里就夹了一张，
    见 .bsp 就判会把它整个当地图，连「不计入内存占用」都跟着错）。
    与 tagger 的判定保持一致：≥2 张地图，或地图占全部条目 ≥1%。

    为什么这条判定要严格：地图只有进那张图时才按需载入，不常驻内存；
    被误判成地图的资源包反而会被排除在占用统计之外，让数字偏低。
    """
    total = len(files)
    if not total:
        return False
    bsp = sum(1 for p in files if p.startswith('maps/') and p.endswith('.bsp'))
    return bsp >= 2 or (bsp >= 1 and bsp / total >= 0.01)


def detect_role(files: dict[str, tuple[int, int]]) -> str:
    """从文件构成粗略判断 mod 主子角色（用于给「该保留谁」提建议）。"""
    if not files:
        return 'art'
    if is_campaign_pack(files):
        return 'campaign'
    ui = sum(1 for p in files if p.startswith(('materials/vgui/', 'resource/')))
    if ui and ui / len(files) >= 0.5:
        return 'hud'
    if any(p.startswith('scripts/') or p.startswith('missions/') for p in files):
        if len(files) <= 40:
            return 'script'
    return 'art'


def role_tags(files: dict[str, tuple[int, int]]) -> list[str]:
    """多标签：一个包里可能同时是地图 + 材质 + 音效，单一角色会误导。"""
    tags: list[str] = []
    if is_campaign_pack(files):
        tags.append('地图')
    if any(p.startswith('scripts/') for p in files):
        tags.append('脚本')
    if any(p.startswith('sound/') for p in files):
        tags.append('音效')
    if any(p.startswith(('models/', 'materials/')) for p in files):
        tags.append('美术')
    return tags or ['其他']


@lru_cache(maxsize=65536)
def is_relevant_path(path: str) -> bool:
    """是否参与冲突判定（元数据 / 生成文件 / UI 资源除外）。"""
    name = path.rsplit('/', 1)[-1]
    if name in META_FILES or path in GENERATED_FILES:
        return False
    for prefix in UI_PREFIXES:
        if path.startswith(prefix):
            return False
    return True


def severity_of(path: str, official: 'OfficialIndex | frozenset[str] | set[str]') -> str:
    if path in ENTRY_FILES:
        return SEVERITY_ENTRY
    if path.startswith(SCRIPT_PREFIXES):
        return SEVERITY_SCRIPT
    return SEVERITY_HARD if path in official else SEVERITY_SOFT


class OfficialIndex:
    """游戏本体资源名单（路径 → 原版指纹）。只读 pak01 目录树，22k 条约 50ms。"""

    def __init__(self, entries: dict[str, tuple[int, int]] | Iterable[str]):
        if isinstance(entries, dict):
            self.entries: dict[str, tuple[int, int]] = {
                p.lower().replace('\\', '/'): fp for p, fp in entries.items()
            }
        else:
            self.entries = {p.lower().replace('\\', '/'): (-1, -1) for p in entries}
        self.paths = frozenset(self.entries)

    @classmethod
    def from_game(cls, game_root: Path, verbose: bool = False) -> 'OfficialIndex':
        pak = Path(game_root) / 'left4dead2' / 'pak01_dir.vpk'
        if not pak.exists():
            raise FileNotFoundError(f'找不到游戏本体 VPK: {pak}')
        t0 = time.time()
        tree = open_vpk(pak).tree or {}
        entries: dict[str, tuple[int, int]] = {}
        for key, meta in tree.items():
            if not isinstance(key, str) or not key.strip():
                continue
            preload, crc, preload_len, _arch, _off, length = meta
            entries[key] = (int(crc) if crc else -1, int(length) + int(preload_len or 0))
        if verbose:
            print(f'[official] {len(entries)} 条官方路径，{time.time() - t0:.2f}s')
        return cls(entries)

    def __contains__(self, path: str) -> bool:
        return path in self.paths

    def fingerprint(self, path: str) -> tuple[int, int] | None:
        """官方原版指纹；路径不在官方名单或 CRC 未知时返回 None。"""
        fp = self.entries.get(path)
        if fp is None or fp[0] in (0, -1):
            return None
        return fp


def open_vpk(path, read_header_only: bool = False):
    """打开 VPK；路径表不是合法 UTF-8 时退回 latin-1 再试一次。

    工坊里有不少老 Mod 的资源路径按 GBK/ANSI 写进去（中文贴图名常见），
    库默认硬解 utf-8 会抛 UnicodeDecodeError，整棵目录树都读不出来 ——
    冲突、重复、细分标签随之全部失效，界面上只剩一句「解析失败」。
    latin-1 是字节→字符的一一映射、永不失败，ASCII 部分（models/、
    materials/ 这些判定真正依赖的目录名）保持原样，足够继续往下算。
    """
    try:
        return vpk_lib.VPK(str(path), read_header_only=read_header_only)
    except UnicodeDecodeError:
        return vpk_lib.VPK(str(path), read_header_only=read_header_only, path_enc='latin-1')


def read_index(vpk_path: Path) -> dict[str, tuple[int, int]]:
    """只读目录树：返回 {小写路径: (crc32, 总字节)}，不解压任何内容。"""
    tree = open_vpk(vpk_path).tree or {}
    out: dict[str, tuple[int, int]] = {}
    for key, meta in tree.items():
        if not isinstance(key, str) or not key.strip():
            continue
        preload, crc, preload_len, _arch, _off, length = meta
        if crc == 0:
            # 少数打包器不写 CRC：用长度 + preload 长度占位，调用方视为"未知"
            crc = -1
        out[key.lower().replace('\\', '/')] = (crc, int(length) + int(preload_len or 0))
    return out


def analyze(
    mods: dict[str, dict[str, tuple[int, int]]],
    official: 'OfficialIndex | frozenset[str] | set[str]',
    *,
    skip_hud: bool = False,
    labels: Optional[dict] = None,
) -> dict[str, ModReport]:
    """返回 {mod 名: ModReport}。冲突只在 `conflicts` 里，无害重叠放 `overlaps`。

    「原版副本」不算持有者：某个 mod 携带的文件与游戏本体 CRC/长度完全一致时，
    说明它对这条路径没有修改意图（典型场景：材质包顺手打包了原版模型、地图包
    打包了原版音效）。这类文件赢了等于没装，输了也没有任何外观变化，不该参与
    冲突配对 —— 否则会出现「A 带原版模型 × B 改过模型」这种假冲突。

    v2 起：
    * `skip_hud` 默认 False —— 不再整包跳过 HUD 包（HUD 包常混着模型/材质，
      整包跳过会漏判它和别的包的模型冲突）；纯 UI 覆盖改走 `overlaps`。
    * 新增「模型文件集」闪退风险：即使两条路径毫不重叠，一方只带 .mdl、另一方
      只带 .vtx，装到一起也会崩。`labels` 用于给提示里的 mod 起友好名。
    """
    reports = {
        name: ModReport(name=name, role=detect_role(files))
        for name, files in mods.items()
    }

    considered = {
        name: files for name, files in mods.items()
        if files and not (skip_hud and ModFiles(name, Path(), files).is_hud)
    }

    if isinstance(official, OfficialIndex):
        official_fp = official.fingerprint
    else:
        def official_fp(_path: str):
            return None

    # 路径 -> [(mod, crc, size)]，只登记"真的改过"的持有者
    owners: dict[str, list[tuple[str, int, int]]] = defaultdict(list)
    pristine_owners: dict[str, list[str]] = defaultdict(list)
    for name, files in considered.items():
        pristine = 0
        for path, fp in files.items():
            if not is_relevant_path(path):
                continue
            crc, size = fp
            off = official_fp(path)
            if off is not None and crc not in (0, -1) and (crc, size) == off:
                pristine += 1
                pristine_owners[path].append(name)
                continue  # 与官方逐字节一致 → 原版副本，不构成"修改"
            owners[path].append((name, crc, size))
        reports[name].pristine_count = pristine

    # ── 模型文件集分桶（用于闪退风险判定）────────────────────────
    # name -> {stem: {ext_family: path}}
    bundles_by_mod: dict[str, dict[str, dict[str, str]]] = {}
    for name, files in considered.items():
        bmap: dict[str, dict[str, str]] = defaultdict(dict)
        for path in files:
            relevant, bundle = path_facts(path)
            if not relevant or bundle is None:
                continue
            stem, ext = bundle
            bmap[stem][_ext_family(ext)] = path
        bundles_by_mod[name] = dict(bmap)

    stem_providers: dict[str, dict[str, set]] = defaultdict(dict)
    for name, bmap in bundles_by_mod.items():
        for stem, extmap in bmap.items():
            stem_providers[stem][name] = set(extmap)

    crash_best: dict[str, dict] = {}

    def _consider_crash(mod, other, risk, stem, files, reason, advice):
        cur = crash_best.get(mod)
        if cur is None or _RISK_RANK[risk] > _RISK_RANK[cur['risk']]:
            crash_best[mod] = {
                'risk': risk, 'other': other, 'bundle': stem,
                'files': list(files), 'reason': reason, 'advice': dict(advice),
            }

    for stem, provs in stem_providers.items():
        names = sorted(provs)
        if len(names) < 2:
            continue
        base_mods = [m for m in names if 'mdl' in provs[m]]
        if len(base_mods) == 1:
            advice = {
                'action': 'disable',
                'target': base_mods[0],
                'text': (f"建议禁用 {_label(labels, base_mods[0])}：它只带了模型的一部分，"
                         f"单独保留会和另一方的文件拼出不完整的模型"),
            }
        else:
            advice = {
                'action': 'disable_all',
                'target': '',
                'text': "两个包都只带了模型的一部分文件，建议都禁用",
            }
        stem_short = stem.rsplit('/', 1)[-1]
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                a, b = names[i], names[j]
                risk, diff, _cross = _pair_bundle_risk(provs[a], provs[b])
                if risk == RISK_LOW:
                    continue
                for x, y in ((a, b), (b, a)):
                    ex_x = provs[x]
                    files_x = [
                        p for ext, p in bundles_by_mod[y][stem].items()
                        if ext not in ex_x
                    ]
                    if risk == RISK_HIGH:
                        miss = _CRITICAL_EXTS - ex_x
                        reason = (
                            f"{_label(labels, x)} 和 {_label(labels, y)} 各自只提供了"
                            f"模型「{stem_short}」的一部分（{_label(labels, x)} 缺 "
                            f"{'/'.join(sorted(miss)) or '—'}），装在一起会加载到不匹配的"
                            f"模型部件，导致闪退"
                        )
                    else:
                        diff_show = sorted(diff) or sorted(_CRITICAL_EXTS - ex_x)
                        reason = (
                            f"{_label(labels, x)} 和 {_label(labels, y)} 的模型「{stem_short}」"
                            f"只差 {'/'.join(diff_show) or '部分文件'}，可能出现轻微异常"
                        )
                    _consider_crash(x, y, risk, stem, files_x, reason, advice)

    # ── 路径级冲突 / 原版副本覆盖 ─────────────────────────────
    pairs: dict[tuple[str, str], dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    copy_sides: dict[tuple[str, str], str] = {}
    for path, holders in owners.items():
        names = sorted({n for n, _c, _s in holders})
        fingerprints = {(crc, size) for _n, crc, size in holders}
        if len(names) >= 2 and len(fingerprints) >= 2:
            sev = severity_of(path, official)
            for i in range(len(names)):
                for j in range(i + 1, len(names)):
                    pairs[(names[i], names[j])][sev].append(path)
        elif len(names) == 1 and pristine_owners.get(path):
            mod = names[0]
            for keeper in pristine_owners[path]:
                if keeper == mod:
                    continue
                key = tuple(sorted((mod, keeper)))
                pairs[key][SEVERITY_COPY].append(path)
                copy_sides[key] = keeper

    # ── UI 重叠（共享界面资源，内容不同且 >=3 个才算）────────────
    ui_owners: dict[str, list[tuple[str, int, int]]] = defaultdict(list)
    for name, files in considered.items():
        for path, fp in files.items():
            if _is_ui_path(path):
                ui_owners[path].append((name, fp[0], fp[1]))
    ui_pairs: dict[tuple[str, str], list[str]] = defaultdict(list)
    for path, holders in ui_owners.items():
        names = sorted({n for n, _c, _s in holders})
        fingerprints = {(crc, size) for _n, crc, size in holders}
        if len(names) >= 2 and len(fingerprints) >= 2:
            for i in range(len(names)):
                for j in range(i + 1, len(names)):
                    ui_pairs[(names[i], names[j])].append(path)

    def _make_pair(a: str, b: str, sev: str, files, pristine_of=None) -> PairConflict:
        files_sorted = sorted(files)
        kind, counts = dominant_kind(files_sorted)
        kinds_out = dict(counts) if len(counts) > 1 else {}
        risk = RISK_LOW
        reason = ''
        advice: dict = {}
        if sev in (SEVERITY_HARD, SEVERITY_SCRIPT):
            stems = set()
            for p in files_sorted:
                bd = bundle_of(p)
                if bd is not None:
                    stems.add(bd[0])
            worst_rank = -1
            worst_stem = None
            target = ''
            for stem in stems:
                ex_a = set(bundles_by_mod.get(a, {}).get(stem, {}))
                ex_b = set(bundles_by_mod.get(b, {}).get(stem, {}))
                if not ex_a or not ex_b:
                    continue
                r, _diff, _c = _pair_bundle_risk(ex_a, ex_b)
                if _RISK_RANK[r] > worst_rank:
                    worst_rank = _RISK_RANK[r]
                    worst_stem = stem
                    na = len(_CRITICAL_EXTS & ex_a)
                    nb = len(_CRITICAL_EXTS & ex_b)
                    target = a if na < nb else (b if nb < na else min(a, b))
            if worst_rank >= 0:
                risk = {3: RISK_HIGH, 2: RISK_MEDIUM, 1: RISK_LOW}[worst_rank]
            if kind == 'script':
                advice = {'action': 'keep_one', 'target': '', 'text': ''}
            elif risk == RISK_HIGH:
                stem_short = (worst_stem or '').rsplit('/', 1)[-1]
                reason = (
                    f"{_label(labels, a)} 和 {_label(labels, b)} 的模型「{stem_short}」"
                    f"只提供了部分文件，装在一起可能闪退"
                )
                advice = {'action': 'disable', 'target': target,
                          'text': '只保留完整的那个，避免模型部件不匹配'}
            elif risk == RISK_MEDIUM:
                advice = {'action': 'keep_one', 'target': '',
                          'text': '两方模型文件都不完整，建议只保留一个'}
            else:
                advice = {'action': 'keep_one', 'target': '', 'text': ''}
        elif sev == SEVERITY_COPY:
            advice = {'action': 'ignore', 'text': '原版副本，谁生效都不改变外观'}
        else:  # SEVERITY_ENTRY / SEVERITY_SOFT（私有路径重名）
            advice = {'action': 'ignore', 'text': ''}
        return PairConflict(
            other=b, severity=sev, files=files_sorted, pristine_of=pristine_of,
            kind=kind, kinds=kinds_out, risk=risk, reason=reason, advice=advice,
        )

    for (a, b), by_sev in pairs.items():
        for sev, files in by_sev.items():
            hit = _make_pair(a, b, sev, files, copy_sides.get((a, b)))
            mirror = _make_pair(b, a, sev, files, copy_sides.get((a, b)))
            for name, item in ((a, hit), (b, mirror)):
                bucket = reports[name]
                if sev == SEVERITY_SOFT:
                    bucket.overlaps.append(item)
                elif sev == SEVERITY_ENTRY:
                    bucket.entries.append(item)
                elif sev == SEVERITY_COPY:
                    bucket.copies.append(item)
                else:
                    bucket.conflicts.append(item)

    _ui_text = '界面资源重叠，谁生效看加载顺序，一般不影响游戏'
    for (a, b), files in ui_pairs.items():
        if len(files) < 3:
            continue
        reports[a].overlaps.append(PairConflict(
            other=b, severity=SEVERITY_SOFT, files=sorted(files),
            kind='ui', kinds={}, risk=RISK_LOW,
            advice={'action': 'ignore', 'text': _ui_text},
        ))
        reports[b].overlaps.append(PairConflict(
            other=a, severity=SEVERITY_SOFT, files=sorted(files),
            kind='ui', kinds={}, risk=RISK_LOW,
            advice={'action': 'ignore', 'text': _ui_text},
        ))

    # ── 写回包级闪退风险 ─────────────────────────────────────
    for name, rep in reports.items():
        info = crash_best.get(name)
        if info and info['risk'] != RISK_LOW:
            rep.crash_risk = info['risk']
            rep.crash_with = info['other']
            rep.crash_reason = info['reason']
            rep.crash_files = info['files']
            rep.crash_bundle = info['bundle']
            rep.crash_advice = info['advice']

    for rep in reports.values():
        rep.conflicts.sort(key=lambda c: (SEVERITY_ORDER[c.severity], -c.count))
        rep.overlaps.sort(key=lambda c: -c.count)
        rep.entries.sort(key=lambda c: -c.count)
        rep.copies.sort(key=lambda c: -c.count)
    return reports


def summarize(reports: dict[str, ModReport]) -> dict[str, int]:
    """返回各类"Mod 对"的数量（去重后的对数，不是单侧计数）。"""
    hard: set = set()
    script: set = set()
    entry: set = set()
    copy: set = set()
    soft: set = set()
    for name, rep in reports.items():
        for c in rep.conflicts:
            key = tuple(sorted((name, c.other)))
            (hard if c.severity == SEVERITY_HARD else script).add(key)
        for c in rep.entries:
            entry.add(tuple(sorted((name, c.other))))
        for c in rep.copies:
            copy.add(tuple(sorted((name, c.other))))
        for c in rep.overlaps:
            soft.add(tuple(sorted((name, c.other))))
    return {
        'hard_pairs': len(hard),
        'script_pairs': len(script),
        'copy_pairs': len(copy),
        'entry_pairs': len(entry),
        'soft_pairs': len(soft),
    }
