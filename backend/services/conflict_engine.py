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
    overlaps: list[PairConflict] = field(default_factory=list)    # 私有路径重名
    role: str = 'art'             # campaign / script / art / hud
    pristine_count: int = 0       # 携带的「官方原版副本」文件数（不影响任何人）

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
    skip_hud: bool = True,
) -> dict[str, ModReport]:
    """返回 {mod 名: ModReport}。冲突只在 `conflicts` 里，无害重叠放 `overlaps`。

    「原版副本」不算持有者：某个 mod 携带的文件与游戏本体 CRC/长度完全一致时，
    说明它对这条路径没有修改意图（典型场景：材质包顺手打包了原版模型、地图包
    打包了原版音效）。这类文件赢了等于没装，输了也没有任何外观变化，不该参与
    冲突配对 —— 否则会出现「A 带原版模型 × B 改过模型」这种假冲突。
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

    pairs: dict[tuple[str, str], dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    copy_sides: dict[tuple[str, str], str] = {}
    for path, holders in owners.items():
        names = sorted({n for n, _c, _s in holders})
        fingerprints = {(crc, size) for _n, crc, size in holders}
        if len(names) >= 2 and len(fingerprints) >= 2:
            # 双方都改过、内容还不同 → 真互斥
            sev = severity_of(path, official)
            for i in range(len(names)):
                for j in range(i + 1, len(names)):
                    pairs[(names[i], names[j])][sev].append(path)
        elif len(names) == 1 and pristine_owners.get(path):
            # 一方改过、另一方是原版副本 → 单向覆盖：原版那份赢了只会抹掉改过的
            mod = names[0]
            for keeper in pristine_owners[path]:
                if keeper == mod:
                    continue
                key = tuple(sorted((mod, keeper)))
                pairs[key][SEVERITY_COPY].append(path)
                copy_sides[key] = keeper

    for (a, b), by_sev in pairs.items():
        for sev, files in by_sev.items():
            hit = PairConflict(other=b, severity=sev, files=sorted(files),
                               pristine_of=copy_sides.get((a, b)))
            mirror = PairConflict(other=a, severity=sev, files=hit.files,
                                  pristine_of=hit.pristine_of)
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
