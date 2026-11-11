"""L4D2 Mod Scanner Service"""
import os
import re
import json
import queue
import shutil
import threading
import time
import locale
from urllib.parse import quote
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field
from datetime import datetime
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
import vpk as vpk_lib

from . import tagger
from .conflict_engine import (
    OfficialIndex,
    analyze as analyze_conflicts,
    detect_role,
    role_tags,
    SEVERITY_COPY,
    SEVERITY_ENTRY,
    SEVERITY_HARD,
    SEVERITY_SCRIPT,
    SEVERITY_SOFT,
)

# 冲突告警只认这两种：双方都真改过、内容还不同；以及脚本互相顶掉。
# 入口重叠 / 单向覆盖 / 软重叠 只进冲突详情里的「提示」区。
_ALERT_SEVERITIES = (SEVERITY_HARD, SEVERITY_SCRIPT)

# Use unified data store instead of scattered file I/O
from .data_store import (
    get_mod_category, set_mod_category,
    get_mod_tags_override, set_mod_tags_override,
    set_mod_enabled, set_mods_enabled_bulk,
    get_all_mod_metas,
    get_scan_manifest, save_scan_manifest, ScanManifest,
    get_addons_path,
    get_addonlist_state, set_addonlist_state,
    set_prefs_dirty,
    remove_mod_from_all_packs,
)


@dataclass
class ModInfo:
    name: str
    display_name: str
    path: str
    size_bytes: int
    enabled: bool
    is_workshop: bool
    workshop_id: Optional[str] = None
    last_modified: Optional[str] = None
    description: Optional[str] = None
    author: Optional[str] = None
    version: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    thumbnail_url: Optional[str] = None
    vpk_title: Optional[str] = None
    category: Optional[str] = None
    conflicts: list[str] = field(default_factory=list)
    # ── 冲突检测（优化版）─────────────────────────────────────────────
    # conflicts 只放"真互斥"（双方都改过同一官方资源 / 脚本重名），用于红色告警；
    # 单向覆盖、入口重叠、软重叠放 conflict_hints，只做提示，不报警。
    conflict_details: list[dict] = field(default_factory=list)
    conflict_hints: list[dict] = field(default_factory=list)
    role: str = 'art'                     # campaign / art / script / hud
    role_tags: list[str] = field(default_factory=list)   # 地图 / 脚本 / 音效 / 美术
    unreadable: bool = False              # VPK 解析失败（坏包/非标准编码）
    # 分类标签是用户手动设置的吗（true = 手动，可通过右键「恢复自动检测」还原）
    tags_manual: bool = False


_VPK_COVER_NAMES = [
    'thumb.jpg', 'thumbnail.jpg', 'thumbnail.png',
    'logo.png', 'addon_logo.png',
    'addonimage.jpg', 'addonimage.png',
    'preview.jpg', 'preview.png',
    'icon.png', 'icon.jpg',
    'materials/vgui/thumbnails/thumb.jpg',
    'materials/vgui/thumbnails/thumb.png',
    'materials/vgui/thumbnails/thumbnail.jpg',
    'materials/vgui/thumbnails/thumbnail.png',
    'materials/vgui/thumbnails/preview.jpg',
    'materials/vgui/thumbnails/preview.png',
    'materials/vgui/logos/spray/default.png',
    'materials/console/startup_loading.tga',
]

# 从 VPK 文件清单里「兜底」挑预览图的文件名关键词（按这个顺序优先）：
# 很多工坊 Mod 的预览图放在五花八门的位置，靠上面的固定路径根本找不到，
# 这里再从清单里挑「看起来就是预览图」的图片（避免误抓游戏本体的普通贴图）。
_COVER_HINT_KEYWORDS = ('thumb', 'preview', 'logo', 'addonimage', 'addon_logo', 'icon', 'cover')
_COVER_IMAGE_EXTS = ('.jpg', '.jpeg', '.png')


def _cover_candidates_from_manifest(manifest: set) -> list:
    """从 VPK 文件清单里挑出可能的预览图路径（按可信度排序）。

    规则（从严到宽）：
      1. 路径里带 thumb/preview/logo/addonimage/icon/cover 的图片；
      2. VPK 根目录下的图片（`xxx.jpg` 这种没目录的，大概率就是封面）；
      3. materials/vgui/thumbnails/ 下的图片（工坊 Mod 的惯用位置）。
    """
    hinted: list = []
    root_level: list = []
    thumbnails: list = []
    for path in manifest:
        if not isinstance(path, str):
            continue
        low = path.lower()
        if not low.endswith(_COVER_IMAGE_EXTS):
            continue
        if any(k in low for k in _COVER_HINT_KEYWORDS):
            hinted.append(low)
        elif '/' not in low:
            root_level.append(low)
        elif low.startswith('materials/vgui/thumbnails/'):
            thumbnails.append(low)

    def _rank(p: str) -> tuple:
        # 根目录优先、路径越短越优先（避免挑到深层素材图）
        return ('/' in p, len(p))

    return sorted(hinted, key=_rank) + sorted(root_level, key=_rank) + sorted(thumbnails, key=_rank)

# 与 VPK 同名的外部封面图扩展名
# （L4D2 没有官方的本地 Mod 封面约定，玩家普遍就用「和 vpk 同名」的图片）
_SIDECAR_THUMB_EXTS = ('.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif')

# _find_sidecar_thumbnail 的短 TTL 缓存：该函数既被缓存键计算调用、又被扫描解析调用
# （同一个 vpk 一次扫描要被问好几遍），而每次查找最多要 stat 十几个候选路径。
# TTL 很短 —— 用户新放一张图片后重新扫描就能生效。
_SIDECAR_CACHE: dict = {}
_SIDECAR_CACHE_TTL = 3.0


def _normalize_mod_key(name: str) -> str:
    """把 mod 名归一化成可比较的 key，容忍历史数据里的各种写法差异：

    - `mod-xxx.vpk` 前缀（早期版本存进整合包的 id 形式）
    - 缺少/多出 `.vpk` 后缀
    - `workshop\\xxx.vpk` / `workshop/<id>/xxx.vpk` 之类的路径写法
    - 大小写差异
    """
    n = str(name or '').strip().replace('\\', '/')
    n = n.rsplit('/', 1)[-1]
    if n.lower().startswith('mod-'):
        n = n[4:]
    if n.lower().endswith('.vpk'):
        n = n[:-4]
    return n.lower()


# ── addonlist.txt 的编码兼容 ───────────────────────────────────────────────
# L4D2（Source 引擎）写 addonlist.txt 用的是**系统 ANSI 代码页**（简中 Windows = CP936），
# 中文 Mod 名在 UTF-8 下解析不出来，会被 surrogateescape 保留成代理字符（U+DC80–U+DCFF）。
# 不还原的话就会出现用户反馈的：
#   「软件里禁用了某个中文名 Mod，游戏里其实还是启用」
# —— 软件匹配不到游戏写的那一行，于是又追加了一条 UTF-8 名字的新条目，
#    而游戏只认它自己写的那条（值仍然是 1）。

_ANSI_ENCODINGS_CACHE: Optional[list] = None


def _has_surrogates(text: str) -> bool:
    """是否含 surrogateescape 留下的代理字符（= 这段文本里混着「非 UTF-8 字节」）。"""
    return any('\udc80' <= ch <= '\udcff' for ch in text)


def _ansi_encodings() -> list:
    """本地 ANSI 代码页候选（按可信度排序，带缓存）。"""
    global _ANSI_ENCODINGS_CACHE
    if _ANSI_ENCODINGS_CACHE is not None:
        return _ANSI_ENCODINGS_CACHE

    candidates: list = []
    if os.name == 'nt':
        # Windows 的 'mbcs' 就是当前 ANSI 代码页（简中 = cp936，繁中 = cp950 …）
        candidates.append('mbcs')
    try:
        candidates.append(locale.getpreferredencoding(False))
    except Exception:
        pass
    candidates += ['gbk', 'cp936', 'big5', 'cp1252']

    ordered: list = []
    for enc in candidates:
        if enc and enc.lower() not in [e.lower() for e in ordered]:
            ordered.append(enc)
    _ANSI_ENCODINGS_CACHE = ordered
    return ordered


def _decode_ansi_key(raw: str) -> str:
    """把「代理字符形式」的条目名还原成真正的 Unicode 文本（无需还原时原样返回）。"""
    if not _has_surrogates(raw):
        return raw
    try:
        data = raw.encode('utf-8', errors='surrogateescape')
    except Exception:
        return raw
    for enc in _ansi_encodings():
        try:
            decoded = data.decode(enc)
        except Exception:
            continue
        if _has_surrogates(decoded):
            continue
        return decoded
    return raw


def _encode_key_for(ansi_encoding: Optional[str], key: str) -> str:
    """把待写出的条目名转成「文件正在使用的编码」对应的文本。

    转成代理字符后，写入方的 `.encode('utf-8', 'surrogateescape')` 会把它还原成原始
    ANSI 字节 —— 游戏才认得出这是同一个 Mod；该编码表示不了时退回 UTF-8。
    """
    text = str(key).replace('\\', '/')
    if not ansi_encoding or text.isascii():
        return text
    try:
        return text.encode(ansi_encoding).decode('utf-8', errors='surrogateescape')
    except Exception:
        return text


def _detect_ansi_encoding(text: str) -> Optional[str]:
    """从文件内容推断它用的 ANSI 代码页（只有含代理字符时才有意义）。"""
    if not _has_surrogates(text):
        return None
    for enc in _ansi_encodings():
        try:
            text.encode('utf-8', errors='surrogateescape').decode(enc)
            return enc
        except Exception:
            continue
    return None


def _find_sidecar_thumbnail(vpk_path: Path) -> Optional[Path]:
    """查找与 VPK「同名」的外部封面图，例如 `myaddon.vpk` + `myaddon.jpg`。

    支持两类位置：
    1. 与 vpk 同目录、同名（本地 Mod 与创意工坊 Mod 都适用）；
    2. 创意工坊的 vpk 位于 `addons/workshop/<id>/<id>.vpk` 时，
       图片也可能被放在上一级 `addons/workshop/<id>.jpg`。

    以前这里只判断 is_workshop 且只认 `.jpg`，于是「本地 Mod 的 vpk 和图片同名」
    时卡片始终没有封面图。
    """
    key = str(vpk_path)
    now = time.time()
    cached = _SIDECAR_CACHE.get(key)
    if cached and (now - cached[0]) <= _SIDECAR_CACHE_TTL:
        return Path(cached[1]) if cached[1] else None

    found: Optional[Path] = None
    try:
        # 1) 同目录 + 同名
        for ext in _SIDECAR_THUMB_EXTS:
            candidate = vpk_path.with_suffix(ext)
            if candidate.is_file():
                found = candidate
                break
        # 2) 创意工坊：addons/workshop/<id>/<id>.vpk → addons/workshop/<id>.jpg
        if found is None and vpk_path.parent.parent.name.lower() == 'workshop':
            for ext in _SIDECAR_THUMB_EXTS:
                candidate = vpk_path.parent.parent / f'{vpk_path.stem}{ext}'
                if candidate.is_file():
                    found = candidate
                    break
    except Exception:
        found = None

    _SIDECAR_CACHE[key] = (now, str(found) if found else None)
    return found


_CACHE_DIR = Path.home() / '.l4d2-manager'
_VPK_CACHE_DIR = _CACHE_DIR / 'vpk_covers'
_INDEX_CACHE_DIR = _CACHE_DIR / 'vpk_index'
_MANIFEST_CACHE_DIR = _CACHE_DIR / 'manifests'
_METADATA_CACHE_DIR = _CACHE_DIR / 'vpk_metadata'

# ── 元数据缓存的版本号 ──────────────────────────────────────────────
# 解析逻辑有实质变化时 +1：缓存键里带上它，旧磁盘缓存自然失效并重新解析。
# 不加版本号的话，老缓存里没有新字段（例如 category_tags），
# 会把旧数据一直喂给界面（用户反馈：分类改成新 11 类后，旧标签还在）。
#   v3: 分类换成 11 类 + 多标签（category_tags）；旧的单值 category 不再当标签用
#   v4: 自动分类换成 tagger（按人工标注校准），旧缓存里的旧标签必须重算
_METADATA_VERSION = 4

# 旧版分类名（曾作为自动分类）：老缓存里可能残留，展示时一并过滤掉
_LEGACY_CATEGORY_NAMES = {
    '地图', '武器/道具', '角色模型', '材质/皮肤', '脚本/插件', 'UI/界面', '字体',
}

# Priority-ordered patterns for addoninfo scraping
_ADDONINFO_PATTERNS = {
    'title': [
        r'\t"AddonTitle"\s+"(.+?)"',
        r'\t"addontitle"\s+"(.+?)"',
        r'"addontitle"[ \t\x00]*"([^"]+)"',
        r'"AddonTitle"[ \t\x00]*"([^"]+)"',
        r'addontitle[ \t\x00]*"([^"]+)"',
        r'AddonTitle[ \t\x00]*"([^"]+)"',
        r'"AddonName"\s*"(.+?)"',
        r'"addonname"\s*"(.+?)"',
    ],
    'author': [
        r'"addonauthor"[ \t\x00]*"([^"]+)"',
        r'"AddonAuthor"[ \t\x00]*"([^"]+)"',
        r'addonauthor[ \t]*"([^"]+)"',
        r'AddonAuthor[ \t\x00]*"([^"]+)"',
    ],
    'description': [
        r'"addondescription"\s*"(.+?)"',
        r'"AddonDescription"\s*"(.+?)"',
        r'addondescription\s+"(.+?)"',
    ],
    'version': [
        r'"addonversion"\s*"(.+?)"',
        r'"AddonVersion"\s*"(.+?)"',
        r'addonversion\s+(\d+\.?\d*)',
    ],
    'type': [
        r'"addontype"\s*"(.+?)"',
        r'"AddonType"\s*"(.+?)"',
        r'addontype\s+"(.+?)"',
    ],
    'tags': [
        r'"addontags"\s*"(.+?)"',
        r'"AddonTags"\s*"(.+?)"',
        r'addontags\s+"(.+?)"',
    ],
}

_NON_CONFLICT_FILES = {
    'addoninfo.txt', 'addonimage.jpg', 'addonimage.png',
    'thumb.jpg', 'thumbnail.jpg', 'thumbnail.png',
    'logo.png', 'addon_logo.png', 'addon.dat',
}

# 这些前缀下的文件即使被多个 Mod 同时覆盖，对玩家也基本「无感」：
# 游戏只是后加载的覆盖先加载的，界面图标、缩略图、色调校正这类资源人人自带一份，
# 以前把它们也算成冲突，导致软件报出来的冲突数比游戏里实际多得多
# （用户反馈「当前冲突比游戏里实际的多很多」）。
_NON_CONFLICT_PREFIXES = (
    'materials/vgui/',        # 界面图标 / HUD 贴图 / 缩略图（海量且互相覆盖无感）
    'materials/console/',     # 控制台背景图
    'materials/letterbox/',   # 上下黑边遮罩
    'materials/tff/',         # 字体贴图
    'materials/correction/',  # 色调校正（几乎所有 Mod 都自带一份）
)

# In-memory caches (persist across requests for speed)
_VPK_MANIFEST_CACHE: dict[str, set[str]] = {}
_VPK_METADATA_CACHE: dict[str, dict] = {}

# 冲突检测用的「路径 + CRC」索引缓存。索引格式升级时把版本号 +1，旧缓存自动失效。
_INDEX_VERSION = 1
_VPK_INDEX_CACHE: dict[str, dict[str, tuple[int, int]]] = {}
_OFFICIAL_INDEX_CACHE: dict[str, tuple[float, object]] = {}
_LAST_SCAN_KEY: Optional[str] = None
_LAST_SCAN_RESULT: list[ModInfo] = []
# 冲突检测结果缓存：仅当“启用状态指纹”变化时才重算（避免每次请求都重复 O(N^3) 计算）
_LAST_CONFLICT_KEY: Optional[str] = None

# 扫描并发度：每个任务要做的是「读 VPK 目录树 / 解压封面」这类 I/O + 解压工作。
# 原来固定 4，在 8 核以上的机器上磁盘与 CPU 都有空闲；这里按核数自适应
# （下限 4 保证小机器不回退，上限 8 避免 HDD 上并发读过多反而抖动）。
_SCAN_WORKERS = min(8, max(4, (os.cpu_count() or 4) // 2))

# 最近一次扫描的性能数据（供 /api/status 展示、导出日志与压力测试对比使用）
_LAST_SCAN_PERF: Optional[dict] = None

# 扫描串行锁：后端所有端点都跑在线程池里（FastAPI 的 def 路由），
# 因此必须保证同一时刻只有一个扫描在进行 —— 既避免重复全量解析，
# 也避免多个请求同时改写 _LAST_SCAN_RESULT / 冲突缓存造成数据竞争。
#
# ⚠️ 这里刻意**不用 threading.Lock / RLock**（事故复盘）：
#   stream_mods() 原本写成 `with _SCAN_LOCK: yield from self._stream_mods_impl()`，
#   而 Starlette 会把同步生成器交给线程池逐块迭代（每块一次 run_in_threadpool），
#   于是生成器的收尾（最后一次 next()，或连接断开后被回收时的 close()）经常落在
#   **另一个线程**上 → RLock.release() 抛「cannot release un-acquired lock」，
#   with 块退出失败 → 这把锁被永久攥住。
#   后果：之后所有 /api/mods、/api/mods/stream（以及任何走 scan_mods 的接口）
#   永远阻塞；每个卡住的请求还各自占着一条后端线程和一条浏览器连接，而 Chromium
#   对同一个源只有 6 条连接 —— 占满后连 /api/health 都发不出去，界面表现为
#   「改一下 Mod 启停 / 点一下应用，整个软件就卡死」。
# 现在改用「信号量 + 线程局部计数」实现的可重入锁，并且允许任意线程释放：
#   * 跨线程释放不会抛异常，也不会把锁泄漏；
#   * 同线程重复 with 不会自死锁（保持原来 RLock 的可重入语义）；
#   * 多余的释放会被计数挡住，不会把信号量越撑越大。
_SCAN_LOCK_TIMEOUT = 180.0  # 等锁兜底上限（秒）：超时宁可降级并发扫描，也不永久挂住请求


class _ScanLock:
    """可重入、且允许跨线程释放的扫描锁（见上方事故复盘）。"""

    def __init__(self) -> None:
        self._sem = threading.Semaphore(1)
        self._guard = threading.Lock()
        self._held = 0  # 累计 acquire 次数（含重入），用于挡住多余的 release
        self._local = threading.local()

    def acquire(self, timeout: Optional[float] = None) -> bool:
        depth = getattr(self._local, 'depth', 0)
        if depth > 0:  # 同线程重入：只计数，不再抢信号量
            self._local.depth = depth + 1
            with self._guard:
                self._held += 1
            return True
        ok = self._sem.acquire(True, timeout) if timeout is not None else self._sem.acquire(True)
        if ok:
            self._local.depth = 1
            with self._guard:
                self._held += 1
        return ok

    def release(self) -> None:
        depth = getattr(self._local, 'depth', 0)
        if depth > 1:  # 只退掉一层重入
            self._local.depth = depth - 1
            with self._guard:
                self._held = max(0, self._held - 1)
            return
        if depth == 1:
            self._local.depth = 0
        with self._guard:
            if self._held <= 0:  # 多余/跨线程的释放：忽略，别让信号量变大
                return
            self._held -= 1
        self._sem.release()

    def __enter__(self):
        if self.acquire(_SCAN_LOCK_TIMEOUT):
            self._local.owned = True
        else:
            # 兜底：万一哪天又有人漏放锁，也只会短暂降级为「允许并发扫描」，
            # 而不是把之后的请求永久挂死。
            self._local.owned = False
            print(
                f"[Scan] WARNING: 等待扫描锁超过 {_SCAN_LOCK_TIMEOUT:.0f}s，"
                f"本次降级为不持锁扫描（若反复出现，请检查是否有扫描没释放锁）"
            )
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if getattr(self._local, 'owned', False):
            self._local.owned = False
            self.release()
        return False

    def held_count(self) -> int:
        """当前持有次数（0 = 空闲）。用于日志/诊断与回归测试判断锁有没有泄漏。"""
        with self._guard:
            return self._held


_SCAN_LOCK = _ScanLock()


def _record_scan_perf(mode: str, elapsed_ms: float, mods: int, extra: Optional[dict] = None) -> None:
    """记录一次扫描的耗时等信息（mode: full / cached / stream / stream-cached）。"""
    global _LAST_SCAN_PERF
    perf = {
        'at': datetime.now().isoformat(timespec='seconds'),
        'mode': mode,
        'elapsed_ms': round(elapsed_ms, 1),
        'mods': mods,
    }
    if extra:
        perf.update(extra)
    _LAST_SCAN_PERF = perf


def get_last_scan_perf() -> Optional[dict]:
    """获取最近一次扫描的性能数据（可能为 None，表示尚未扫描过）。"""
    return _LAST_SCAN_PERF


# 分类检测规则：VPK 内的文件路径命中这些前缀/片段就给对应标签（**支持多标签**）。
# 一个 Mod 可以同时命中多个分类 —— 例如「武器皮肤」既改模型又改贴图，
# 就会同时拿到「武器」和「皮肤」两个标签。
CATEGORIES = {
    '战役': [
        'maps/', 'missions/', '.bsp',
    ],
    '音效': [
        'sound/',
    ],
    '武器': [
        'models/weapons/', 'models/v_models/', 'models/w_models/',
        'materials/models/weapons/', 'materials/models/v_models/', 'materials/models/w_models/',
        'sound/weapons/', 'scripts/weapons/',
    ],
    '被感染者': [
        'models/infected/', 'materials/models/infected/',
        'sound/infected/', 'sound/npc/',
    ],
    '突变模式': [
        'scripts/mutations/', 'scripts/vscripts/mutation',
    ],
    '生还者': [
        'models/survivors/', 'materials/models/survivors/', 'sound/player/survivor/',
    ],
    '物品': [
        'models/items/', 'materials/models/items/', 'models/props/', 'scripts/items/',
    ],
    '脚本': [
        'scripts/', 'vscripts/', '.nut',
    ],
    '游戏界面': [
        'resource/', 'materials/vgui/', 'materials/hud/',
    ],
    '皮肤': [
        'materials/', 'overlays/',
    ],
    # 兜底分类：只用于手动选择，不参与自动检测（否则什么 Mod 都会被打上）
    '杂项': [],
}

_ALL_CATEGORY_NAMES = set(CATEGORIES.keys())
# 注：自动分类不再走 CATEGORIES 的前缀命中打分（那套会把地图判成皮肤），
# 改由 services/tagger.py 判定；这里保留词表，用于校验手动改标签的合法性。


def _get_vpk_cache_key(vpk_path: Path) -> str:
    """Generate a cache key based on vpk name + file size + mtime（+ 同名封面图指纹）。"""
    try:
        stat = vpk_path.stat()
        # Combine name, size, and mtime into a stable hash
        # 带上元数据缓存版本：解析逻辑升级后，旧缓存自动失效（见 _METADATA_VERSION）
        raw = (f"v{_METADATA_VERSION}.{tagger.RULES_VERSION}|"
               f"{vpk_path.name}|{stat.st_size}|{int(stat.st_mtime)}")
        # 把「与 vpk 同名的封面图」也纳入指纹：
        # 否则用户后补一张 myaddon.jpg 之后，磁盘缓存里那份 thumbnail_url=None 的
        # 元数据会一直被复用 —— 卡片永远显示不出图片（必须手动删缓存才行）。
        sidecar = _find_sidecar_thumbnail(vpk_path)
        if sidecar is not None:
            try:
                s = sidecar.stat()
                raw += f"|{sidecar.name}|{int(s.st_mtime)}"
            except Exception:
                raw += f"|{sidecar.name}"
        return hashlib.md5(raw.encode()).hexdigest()[:16]
    except:
        return vpk_path.name


def _load_manifest_from_disk(cache_key: str) -> Optional[set[str]]:
    """Load a cached manifest from disk."""
    cache_file = _MANIFEST_CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            data = json.loads(cache_file.read_text(encoding='utf-8'))
            return set(data)
        except:
            pass
    return None


def _save_manifest_to_disk(cache_key: str, manifest: set[str]):
    """Save a manifest to disk cache."""
    _MANIFEST_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = _MANIFEST_CACHE_DIR / f"{cache_key}.json"
    try:
        cache_file.write_text(json.dumps(list(manifest), ensure_ascii=False), encoding='utf-8')
    except:
        pass


def _load_metadata_from_disk(cache_key: str) -> Optional[dict]:
    """Load cached VPK metadata (title/author/cover/category/...) from disk.

    冷启动时避免重新打开每个 VPK：直接从磁盘 JSON 恢复元数据。
    """
    cache_file = _METADATA_CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            data = json.loads(cache_file.read_text(encoding='utf-8'))
            # 旧版本写的缓存直接忽略（重新解析）：否则新字段（如 category_tags）永远是空的
            if data.get('_meta_version') != _METADATA_VERSION:
                return None
            return data
        except:
            pass
    return None


def _save_metadata_to_disk(cache_key: str, metadata: dict):
    """Persist VPK metadata to disk cache.

    排除 `_manifest` 字段——它体积大且已由 _MANIFEST_CACHE_DIR 单独缓存。
    """
    _METADATA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = _METADATA_CACHE_DIR / f"{cache_key}.json"
    try:
        to_save = {k: v for k, v in metadata.items() if k != '_manifest'}
        to_save['_meta_version'] = _METADATA_VERSION
        cache_file.write_text(json.dumps(to_save, ensure_ascii=False), encoding='utf-8')
    except:
        pass


def _parse_addoninfo_text(text: str) -> dict:
    result = {}
    for key, patterns in _ADDONINFO_PATTERNS.items():
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                result[key] = match.group(1).strip().strip('"').strip("'")
                break
    return result


def _parse_addoninfo(data: bytes) -> dict:
    text = None
    for enc in ['utf-8-sig', 'utf-8', 'utf-16-le', 'utf-16', 'shift-jis', 'gbk', 'latin-1']:
        try:
            text = data.decode(enc, errors='replace')
            if any(c.isalpha() for c in text[:200]):
                break
        except:
            continue
    if text is None:
        text = data.decode('utf-8', errors='replace')
    return _parse_addoninfo_text(text.strip())


def _extract_manifest(path: Path) -> set[str]:
    """Extract file manifest from a VPK file."""
    manifest: set[str] = set()
    try:
        v = vpk_lib.VPK(str(path.resolve()), read_header_only=False)
        for p in v:
            if isinstance(p, str) and p.strip():
                manifest.add(p.lower().replace('\\', '/'))
        if not manifest and hasattr(v, 'tree') and isinstance(v.tree, dict):
            for p in v.tree:
                if isinstance(p, str) and p.strip():
                    manifest.add(p.lower().replace('\\', '/'))
    except Exception as e:
        print(f"[VPK] Error extracting manifest from {path.name}: {e}")
    return manifest


def _get_manifest(path: Path) -> set[str]:
    """Get VPK manifest from cache (in-memory then disk), parse on miss."""
    path_str = str(path.resolve())
    
    # 1. Check in-memory cache
    if path_str in _VPK_MANIFEST_CACHE:
        return _VPK_MANIFEST_CACHE[path_str]
    
    # 2. Check disk cache
    cache_key = _get_vpk_cache_key(path)
    disk_manifest = _load_manifest_from_disk(cache_key)
    if disk_manifest is not None:
        _VPK_MANIFEST_CACHE[path_str] = disk_manifest
        return disk_manifest
    
    # 3. Parse from VPK (slow)
    manifest = _extract_manifest(path)
    _VPK_MANIFEST_CACHE[path_str] = manifest
    _save_manifest_to_disk(cache_key, manifest)
    return manifest


def _get_vpk_data(path: Path) -> dict:
    """Open VPK once and extract ALL data: manifest + metadata + cover. 
    This is the core optimization — one VPK open per file."""
    path_str = str(path.resolve())
    cache_key = _get_vpk_cache_key(path)
    
    # Check in-memory cache first
    if path_str in _VPK_METADATA_CACHE:
        return _VPK_METADATA_CACHE[path_str]
    
    # Check disk cache (cold-start speedup — avoid reopening every VPK)
    disk_meta = _load_metadata_from_disk(cache_key)
    if disk_meta is not None:
        _VPK_METADATA_CACHE[path_str] = disk_meta
        return disk_meta
    
    result = {
        'vpk_title': None, 'author': None, 'description': None,
        'version': None, 'category': None, 'category_tags': [], 'tags': [],
        'display_name': None, 'thumbnail_url': None,
        '_manifest': None,  # will store parsed manifest to warm the manifest cache
    }
    
    v = None
    
    try:
        v = vpk_lib.VPK(str(path.resolve()), read_header_only=False)
        
        # ── 1. Extract addoninfo (metadata) ──
        addoninfo_files = []
        for entry in v:
            if isinstance(entry, str) and 'addoninfo' in entry.lower():
                addoninfo_files.append(entry)
        
        for name in (addoninfo_files if addoninfo_files else ['addoninfo.txt']):
            try:
                if v.get_file(name):
                    fp = v.get_file(name)
                    parsed = _parse_addoninfo(fp.read())
                    if parsed.get('title'):
                        result['vpk_title'] = parsed['title']
                        result['author'] = parsed.get('author')
                        result['description'] = parsed.get('description')
                        result['version'] = parsed.get('version')
                        result['category'] = parsed.get('type')
                        if 'tags' in parsed:
                            result['tags'] = [t.strip() for t in parsed['tags'].split(',')]
                        if result['vpk_title']:
                            result['display_name'] = result['vpk_title']
                        break
            except:
                continue
        
        # ── 2. Extract manifest (file list) for conflict detection & categorization ──
        manifest_paths: set[str] = set()
        for entry in v:
            if isinstance(entry, str) and entry.strip():
                manifest_paths.add(entry.lower().replace('\\', '/'))
        if not manifest_paths and hasattr(v, 'tree') and isinstance(v.tree, dict):
            for entry in v.tree:
                if isinstance(entry, str) and entry.strip():
                    manifest_paths.add(entry.lower().replace('\\', '/'))
        
        # Warm the manifest cache
        if manifest_paths:
            _VPK_MANIFEST_CACHE[path_str] = manifest_paths
            _save_manifest_to_disk(cache_key, manifest_paths)
            result['_manifest'] = manifest_paths
            
            # 分类交给 tagger：按 57 个人工标注样本校准过的规则判定（见 tagger.py）。
            # reader 只在「纯脚本 Mod」时才被调用，用来判断它其实是音效包这类情况。
            def _read_inner(name: str, _v=v):
                fp = _v.get_file(name)
                return fp.read() if fp else b''

            tag_list, _degraded = tagger.classify(manifest_paths, reader=_read_inner)
            result['category_tags'] = tag_list
        
        # ── 3. Extract cover image (lazy — only if not cached) ──
        cached_cover = _get_vpk_cover_cached_path(cache_key)
        if cached_cover:
            result['thumbnail_url'] = f'/api/thumbnail?vpk_cover={cached_cover.name}'
        else:
            # Try to extract cover from already-open VPK：
            # 先试约定路径，再从文件清单里兜底找（见 _cover_candidates_from_manifest）
            candidates = list(_VPK_COVER_NAMES) + _cover_candidates_from_manifest(manifest_paths)
            for cover_name in candidates:
                try:
                    if v.get_file(cover_name):
                        fp = v.get_file(cover_name)
                        data = fp.read()
                        ext = Path(cover_name).suffix.lower()
                        if ext in ('.jpg', '.jpeg'):
                            ext = '.jpg'
                        elif ext == '.tga':
                            continue  # Skip TGA
                        _VPK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                        out_path = _VPK_CACHE_DIR / f'{cache_key}{ext}'
                        out_path.write_bytes(data)
                        result['thumbnail_url'] = f'/api/thumbnail?vpk_cover={out_path.name}'
                        break
                except:
                    continue
    
    except Exception as e:
        print(f"[VPK] Error reading {path.name}: {e}")
        # Raw binary fallback for metadata only.
        # addoninfo 位于 VPK 前部（header + 目录区/preload），只读文件开头即可，
        # 避免对超大文件整文件读取 + 解码 + 正则扫描（会灾难性回溯，拖慢扫描）。
        try:
            with open(path, 'rb') as f:
                raw = f.read(1_000_000)  # 前 1MB，足够覆盖 addoninfo 元数据
            for enc in ['utf-8', 'latin-1', 'gbk', 'shift-jis']:
                try:
                    decoded = raw.decode(enc, errors='replace')
                    if any(c.isalpha() for c in decoded[100:300]):
                        parsed = _parse_addoninfo_text(decoded)
                        if parsed.get('title'):
                            result['vpk_title'] = parsed['title']
                            result['author'] = parsed.get('author')
                            if result['vpk_title']:
                                result['display_name'] = result['vpk_title']
                            break
                except:
                    continue
        except:
            pass
    
    # VPK handle cleaned up automatically by Python GC
    
    # Friendly name fallback
    if not result['display_name']:
        stem = path.stem
        if not (stem.isdigit() and len(stem) >= 8):
            friendly = stem.replace('_', ' ').replace('-', ' ')
            friendly = re.sub(r'\s+', ' ', friendly).strip()
            if friendly:
                result['display_name'] = friendly.title() if friendly else None
    
    # 分类兜底：VPK 头损坏 / 条目名非 UTF-8 时上面会抛异常或给出空清单，
    # 退化成字节流关键词扫描，至少还能判出大类（旧版这种情况直接没有标签）。
    if not result.get('category_tags'):
        tag_list, _degraded = tagger.classify(None, vpk_path=path)
        result['category_tags'] = tag_list

    _VPK_METADATA_CACHE[path_str] = result
    _save_metadata_to_disk(cache_key, result)
    return result


def _get_metadata(path: Path) -> dict:
    """Get VPK metadata from cache or parse on miss. Wrapper for _get_vpk_data."""
    data = _get_vpk_data(path)
    # Return a copy without the internal _manifest field
    return {k: v for k, v in data.items() if k != '_manifest'}




def _get_vpk_cover_cached_path(cache_key: str) -> Optional[Path]:
    """Check if cover is already cached on disk."""
    _VPK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached_jpg = _VPK_CACHE_DIR / f'{cache_key}.jpg'
    cached_png = _VPK_CACHE_DIR / f'{cache_key}.png'
    if cached_jpg.exists():
        return cached_jpg
    if cached_png.exists():
        return cached_png
    return None


def _extract_vpk_cover(v: vpk_lib.VPK, cache_key: str) -> Optional[Path]:
    """Extract cover image from an already-open VPK object."""
    _VPK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    
    for cover_name in _VPK_COVER_NAMES:
        try:
            if v.get_file(cover_name):
                fp = v.get_file(cover_name)
                data = fp.read()
                ext = Path(cover_name).suffix.lower()
                if ext in ('.jpg', '.jpeg'):
                    ext = '.jpg'
                elif ext == '.tga':
                    ext = '.png'  # Will skip below since we don't handle TGA
                    continue
                out_path = _VPK_CACHE_DIR / f'{cache_key}{ext}'
                out_path.write_bytes(data)
                return out_path
        except:
            continue
    return None


def _is_conflict_file(file_path: str) -> bool:
    file_name = file_path.rsplit('/', 1)[-1] if '/' in file_path else file_path
    if file_name in _NON_CONFLICT_FILES:
        return False
    for prefix in _NON_CONFLICT_PREFIXES:
        if file_path.startswith(prefix):
            return False
    return True


def _conflict_fingerprint(mods: list[ModInfo], addons_path: Optional[str] = None) -> str:
    """冲突结果取决于「启用集合 + 每个 VPK 的身份 + 游戏路径」。

    除了名称和启用状态，还要带上 size/mtime：用户在工坊更新了某个 Mod
    （同名同启用状态、内容却变了）时必须重算，否则会一直复用旧的冲突结果。
    """
    parts = sorted(
        f"{m.name}:{'1' if m.enabled else '0'}:{m.size_bytes}:{m.last_modified or ''}"
        for m in mods
    )
    raw = '|'.join(parts) + f"@{addons_path or ''}"
    return hashlib.md5(raw.encode()).hexdigest()


def _get_vpk_index(path: Path) -> dict[str, tuple[int, int]]:
    """VPK 目录树索引：{小写路径: (crc32, 字节数)}。

    比老的 `_get_manifest()` 只多读目录项里的 CRC32 字段，不解压任何内容。
    有了 CRC 才能判断「两个 Mod 带的同名文件是不是同一份内容」以及
    「某个文件是不是官方原版副本」—— 这两条是老逻辑 99% 误报的来源。
    """
    path_str = str(path.resolve())
    cached = _VPK_INDEX_CACHE.get(path_str)
    if cached is not None:
        return cached

    cache_key = _get_vpk_cache_key(path)
    cache_file = _INDEX_CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            raw = json.loads(cache_file.read_text(encoding='utf-8'))
            if raw.get('v') == _INDEX_VERSION:
                out = {p: (int(v[0]), int(v[1])) for p, v in (raw.get('files') or {}).items()}
                _VPK_INDEX_CACHE[path_str] = out
                return out
        except Exception:
            pass

    out: dict[str, tuple[int, int]] = {}
    try:
        v = vpk_lib.VPK(str(path.resolve()), read_header_only=False)
        for key, meta in (v.tree or {}).items():
            if not isinstance(key, str) or not key.strip():
                continue
            preload, crc, preload_len, _arch, _off, length = meta
            out[key.lower().replace('\\', '/')] = (
                int(crc) if crc else -1,
                int(length) + int(preload_len or 0),
            )
        try:
            _INDEX_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(
                json.dumps({'v': _INDEX_VERSION, 'files': out}, ensure_ascii=False),
                encoding='utf-8',
            )
        except Exception:
            pass
    except Exception as e:
        print(f"[VPK] 索引失败 {path.name}: {e}")
    _VPK_INDEX_CACHE[path_str] = out
    return out


def _get_official_index(addons_path: Optional[str]):
    """游戏本体资源名单（含 CRC），用于识别「原版副本」和判断是否官方路径。

    只读 pak01_dir.vpk 的目录树，约 50ms；按 pak 的 mtime 缓存在进程内。
    addons_path = <game>/left4dead2/addons，往上两级就是游戏根目录。
    """
    if not addons_path:
        return None
    try:
        game_root = Path(addons_path).resolve().parent.parent
    except Exception:
        return None
    pak = game_root / 'left4dead2' / 'pak01_dir.vpk'
    try:
        mtime = pak.stat().st_mtime
    except Exception:
        return None

    key = str(pak)
    hit = _OFFICIAL_INDEX_CACHE.get(key)
    if hit is not None and hit[0] == mtime:
        return hit[1]
    try:
        idx = OfficialIndex.from_game(game_root)
    except Exception as e:
        print(f"[Conflict] 读取官方资源名单失败: {e}")
        return None
    _OFFICIAL_INDEX_CACHE[key] = (mtime, idx)
    return idx


def _conflict_entry(other: str, sev: str, files: list[str],
                    reports: dict, indices: dict) -> dict:
    """给前端的一份冲突明细。files 只带前 12 个，避免 JSON 过大。"""
    other_rep = reports.get(other)
    return {
        'other': other,
        'severity': sev,
        'count': len(files),
        'files': files[:12],
        'other_role': getattr(other_rep, 'role', 'art') if other_rep else 'art',
        'other_role_tags': role_tags(indices.get(other, {})),
    }


def _detect_conflicts(mods: list[ModInfo], addons_path: Optional[str] = None):
    """冲突检测：只看启用中的 Mod，基于 VPK 目录树（路径 + CRC + 长度）。

    与旧实现（纯路径重名）相比，判定分五档：

      hard    双方都改过同一条官方资源、内容还不同 → 红色告警，只能一个生效
      script  共享脚本 / 库重名 → 红色告警，功能可能被顶掉
      copy    一方带的是官方原版副本（逐字节相同）→ 提示，只会单向抹掉另一方
      entry   单实例入口文件（director_base_addon.nut 等）→ L4D2 结构限制，提示
      soft    私有路径重名（同系列地图共用素材）→ 提示

    只有 hard / script 会写进 `mod.conflicts`（前端红点、冲突筛选都读它），
    其余进 `mod.conflict_hints`，在冲突详情里折叠展示。
    """
    for mod in mods:
        mod.conflicts = []
        mod.conflict_details = []
        mod.conflict_hints = []
        mod.role_tags = []
        mod.unreadable = False

    enabled_mods = [m for m in mods if m.enabled]
    if len(enabled_mods) < 2:
        return

    # 1) 读索引（坏包标记为 unreadable，不再像以前那样静默当空清单）
    indices: dict[str, dict[str, tuple[int, int]]] = {}
    for mod in enabled_mods:
        try:
            idx = _get_vpk_index(Path(mod.path))
        except Exception:
            idx = {}
        if not idx:
            mod.unreadable = True
            continue
        indices[mod.name] = idx
        mod.role = detect_role(idx)
        mod.role_tags = role_tags(idx)

    if len(indices) < 2:
        return

    # 2) 判定
    official = _get_official_index(addons_path)
    reports = analyze_conflicts(indices, official if official is not None else frozenset())

    # 3) 写回
    for mod in enabled_mods:
        rep = reports.get(mod.name)
        if rep is None:
            continue
        alerts: list[dict] = []
        hints: list[dict] = []
        for c in rep.conflicts:
            item = _conflict_entry(c.other, c.severity, c.files, reports, indices)
            (alerts if c.severity in _ALERT_SEVERITIES else hints).append(item)
        for c in rep.copies:
            hints.append(_conflict_entry(c.other, c.severity, c.files, reports, indices))
        for c in rep.entries:
            hints.append(_conflict_entry(c.other, c.severity, c.files, reports, indices))
        for c in rep.overlaps:
            hints.append(_conflict_entry(c.other, c.severity, c.files, reports, indices))

        # 严重度从高到低，同级按涉及文件数排序
        order = {SEVERITY_HARD: 0, SEVERITY_SCRIPT: 1, SEVERITY_COPY: 2,
                 SEVERITY_ENTRY: 3, SEVERITY_SOFT: 4}
        alerts.sort(key=lambda d: (order.get(d['severity'], 9), -d['count']))
        hints.sort(key=lambda d: (order.get(d['severity'], 9), -d['count']))

        mod.conflict_details = alerts
        mod.conflict_hints = hints
        mod.conflicts = sorted({d['other'] for d in alerts})


def _make_friendly_name(filename: str) -> Optional[str]:
    stem = Path(filename).stem
    if stem.isdigit() and len(stem) >= 8:
        return None
    friendly = stem.replace('_', ' ').replace('-', ' ')
    friendly = re.sub(r'\s+', ' ', friendly).strip()
    return friendly.title() if friendly else None




class ModScanner:
    def __init__(self, addons_path: Optional[str] = None):
        self._addons_path = None
        if addons_path:
            self.set_addons_path(addons_path)
        self._load_config()
        # 「软件里手动设置的启用状态」缓存（权威来源，见 _resolve_enabled）
        self._pref_cache: Optional[dict[str, bool]] = None
        # 偏好键的归一化索引：兼容历史数据里的 mod- 前缀 / 缺扩展名 / 大小写差异
        self._pref_norm_index: dict[str, bool] = {}
        self._pref_cache_ts: float = 0.0
        self._pref_lock = threading.Lock()

    def _get_addons_path_from_store(self) -> Optional[str]:
        """Get addons path from unified data store."""
        return get_addons_path()

    def _get_config_path(self) -> Path:
        return _CACHE_DIR / 'config.json'

    def _get_addonlist_path(self) -> Optional[Path]:
        if not self._addons_path:
            return None
        return Path(self._addons_path).parent / 'addonlist.txt'

    def _read_addonlist(self) -> dict[str, bool]:
        result = {}
        addonlist_path = self._get_addonlist_path()
        if not addonlist_path or not addonlist_path.exists():
            return result
        try:
            text = addonlist_path.read_text(encoding='utf-8-sig', errors='surrogateescape')
            for line in text.splitlines():
                line = line.strip()
                if not line or line in ('{', '}') or line.startswith('"AddonList"'):
                    continue
                match = re.match(r'^"([^"]+)"\s+"(\d+)"', line)
                if match:
                    # 游戏用系统 ANSI 代码页写中文名（UTF-8 解析不出来 → 代理字符），
                    # 这里先还原成真正的 Unicode 名字，后面的匹配/比较才对得上磁盘文件名。
                    key = _decode_ansi_key(match.group(1)).replace('/', '\\')
                    result[key] = (match.group(2) == '1')
        except:
            pass
        return result

    def _read_addonlist_text(self) -> str:
        """读取 addonlist.txt 的原始文本。

        用 surrogateescape 保留「无法按 UTF-8 解码」的字节（例如游戏按 ANSI 写入的
        中文文件名），这样写回时能原样还原，不会把整份列表写成乱码。
        """
        addonlist_path = self._get_addonlist_path()
        if not addonlist_path or not addonlist_path.exists():
            return ''
        try:
            return addonlist_path.read_text(encoding='utf-8-sig', errors='surrogateescape')
        except Exception:
            return ''

    def _addonlist_fingerprint(self) -> str:
        """addonlist.txt 的「内容指纹」（原始字节的 md5），文件不存在/读不到时返回 ''。

        用来区分「软件自己写的文件」和「被外部改过的文件」：
        软件每次写文件都会记录指纹，因此指纹对不上就说明文件被游戏（退出时写回）、
        Steam 云同步或手动编辑改过 —— 详见 get_pending_addonlist_changes()。
        """
        addonlist_path = self._get_addonlist_path()
        if not addonlist_path or not addonlist_path.exists():
            return ''
        try:
            return hashlib.md5(addonlist_path.read_bytes()).hexdigest()
        except Exception:
            return ''

    def _write_addonlist(self, entries: dict[str, bool]):
        """把 entries 里的启用状态写回 addonlist.txt（只改匹配到的行，其余原样保留）。

        以前是「用解析结果重建整个文件」：只要某个条目解析不到（编码差异、格式变体），
        它就会从文件里消失 —— 游戏随后会把「文件里不存在的 addon」当成默认启用写回，
        表现就是用户反馈的「软件里禁用了，启动一次游戏后又变回启用」。
        """
        addonlist_path = self._get_addonlist_path()
        if not addonlist_path:
            return
        try:
            addonlist_path.parent.mkdir(parents=True, exist_ok=True)

            old_text = self._read_addonlist_text()
            if not old_text and addonlist_path.exists():
                # 文件存在却读不出内容（异常）→ 宁可不写，也不要覆盖掉用户的配置
                print("[AddonList] Refuse to overwrite: existing file could not be read")
                return

            had_bom = False
            try:
                had_bom = addonlist_path.read_bytes()[:3] == b'\xef\xbb\xbf'
            except Exception:
                had_bom = False

            lines = old_text.splitlines() if old_text else []
            # 文件里已有内容时，按它自身的编码写新条目（游戏用 ANSI，就是 GBK 字节）
            ansi_encoding = _detect_ansi_encoding(old_text)
            used: set = set()
            out: list = []
            seen_header = False

            for line in lines:
                s = line.strip()
                if s.startswith('"AddonList"'):
                    seen_header = True
                if s and s not in ('{', '}') and not s.startswith('"AddonList"'):
                    m = re.match(r'^"([^"]+)"\s+"(\d+)"', s)
                    if m:
                        raw_key = m.group(1)
                        # 关键：把 ANSI（GBK）形式的中文条目名也还原出来比对，
                        # 否则匹配不到游戏写的那一行 → 会追加一条游戏看不懂的 UTF-8 条目，
                        # 游戏仍按自己那条（1）执行 → 「软件里禁用了，游戏里没禁用」。
                        norm_key = _decode_ansi_key(raw_key).replace('/', '\\')
                        if norm_key in entries:
                            used.add(norm_key)
                            # 原样保留文件里的 key 写法（游戏只认它自己那种编码）
                            out.append(f'\t"{raw_key}"\t\t"{"1" if entries[norm_key] else "0"}"')
                            continue
                out.append(line)

            missing = sorted(k for k in entries if k not in used)
            new_lines = [
                '\t"' + _encode_key_for(ansi_encoding, k) + '"\t\t"' + ('1' if entries[k] else '0') + '"'
                for k in missing
            ]

            if not seen_header:
                # 文件不存在/内容为空 → 按游戏的标准格式新建
                out = ['"AddonList"', '{'] + new_lines + ['}']
            elif new_lines:
                # 插到结尾的 '}' 之前
                insert_at = len(out)
                if out and out[-1].strip() == '}':
                    insert_at = len(out) - 1
                out[insert_at:insert_at] = new_lines

            text = '\n'.join(out) + '\n'
            data = text.encode('utf-8', errors='surrogateescape')
            if had_bom:
                data = b'\xef\xbb\xbf' + data

            # 原子写：先写临时文件再替换，避免游戏/Steam 恰好读到半个文件
            tmp_path = addonlist_path.with_suffix('.tmp')
            tmp_path.write_bytes(data)
            tmp_path.replace(addonlist_path)

            # 记下「软件自己写出来的内容」：下次扫描时若指纹对不上，
            # 就说明文件被外部（游戏 / Steam 云 / 手动编辑）改过，需要把改动采纳回来。
            try:
                set_addonlist_state(hashlib.md5(data).hexdigest(), str(addonlist_path))
            except Exception as e:
                print(f"[AddonList] Failed to record fingerprint: {e}")
        except Exception as e:
            print(f"[AddonList] Write failed: {e}")

    # ===== mod 启用状态偏好：软件里的设置是权威来源 =====

    def _mod_enabled_prefs(self) -> dict[str, bool]:
        """读取用户在软件里手动设置过的 mod 启用状态（1 秒内复用缓存）。"""
        now = time.time()
        if self._pref_cache is not None and (now - self._pref_cache_ts) <= 1.0:
            return self._pref_cache
        with self._pref_lock:
            now = time.time()
            if self._pref_cache is None or (now - self._pref_cache_ts) > 1.0:
                prefs: dict[str, bool] = {}
                index: dict[str, bool] = {}
                try:
                    metas = get_all_mod_metas()
                except Exception as e:
                    print(f"[Prefs] Failed to read mod enabled prefs: {e}")
                    metas = {}

                # 按 last_updated 升序处理：历史数据里同一个 mod 可能同时存在
                # `mymod2.vpk` 与 `mod-mymod2.vpk` 两条偏好（不同版本写下的写法），
                # 归一化后同名 —— 必须以「最后设置的那条」为准。
                ordered = sorted(
                    ((n, m) for n, m in metas.items() if m.enabled is not None),
                    key=lambda kv: kv[1].last_updated or '',
                )
                for name, meta in ordered:
                    value = bool(meta.enabled)
                    prefs[name] = value
                    index[_normalize_mod_key(name)] = value   # 覆盖：后更新的胜出

                self._pref_cache = prefs
                self._pref_norm_index = index
                self._pref_cache_ts = now
            return self._pref_cache

    def invalidate_mod_enabled_cache(self):
        """丢弃偏好缓存（本地改动之后调用）。"""
        with self._pref_lock:
            self._pref_cache = None
            self._pref_norm_index = {}
            self._pref_cache_ts = 0.0

    def prefs_in_sync_with_addonlist(self) -> bool:
        """软件里记录的启停偏好是否已经和 addonlist.txt 的实际内容一致。

        用途：启动时校正持久化的「有改动还没应用」标记（data.json 的 prefs_dirty）。
        该标记只增不减的话，用户「改了 Mod 启停 → 没点应用就退出软件」，
        下次启动左下角的「应用」按钮就会一直亮着；而 toggle 时其实早就把状态写进
        addonlist.txt 了，那个提醒是假的。启动时按文件实际内容核对一次就能熄灯。

        判定口径与界面保持一致（_resolve_enabled）：只比较软件里手动设置过的 mod，
        磁盘上已经删掉的 mod 不算差异。
        """
        try:
            prefs = self._mod_enabled_prefs()
            if not prefs:
                return True
            addonlist = self._read_addonlist()
            if not addonlist:
                # 文件不存在 / 为空：没有可比对的内容，按「一致」处理，
                # 免得每次启动都把提示灭掉又点不亮（真正的缺文件由扫描逻辑负责）
                return True
            keys = self._mod_list_keys()
            for mod_name, enabled in prefs.items():
                list_key = keys.get(mod_name) or keys.get(_normalize_mod_key(mod_name))
                if not list_key:
                    continue
                list_key = self._resolve_list_key(addonlist, list_key)
                if list_key not in addonlist:
                    # 文件里没有这一条 = 游戏会按「启用」处理；偏好是禁用就属于不一致
                    if not enabled:
                        return False
                    continue
                if bool(addonlist[list_key]) != bool(enabled):
                    return False
            return True
        except Exception as e:
            print(f"[Prefs] Sync check failed: {e}")
            return True

    def _resolve_enabled(self, mod_name: str, list_key: str, addonlist: dict[str, bool]) -> bool:
        """决定某个 mod 的启用状态（界面上显示的就是这里的结果）。

        优先使用软件里设置过的状态：游戏（尤其是 Steam 云同步）会在软件之外改写
        addonlist.txt，若直接采信文件，就会出现用户反馈的
        「软件里禁用了 mod，启动游戏后再看软件又变回修改前的配置」。
        """
        prefs = self._mod_enabled_prefs()
        pref = prefs.get(mod_name)
        if pref is None:
            pref = self._pref_norm_index.get(_normalize_mod_key(mod_name))
        if pref is not None:
            return pref
        return addonlist.get(self._resolve_list_key(addonlist, list_key), True)

    def _mod_list_keys(self) -> dict[str, str]:
        """mod 名（含多种历史写法）-> addonlist.txt 里的真实条目 key。

        额外登记归一化别名（去掉 `mod-` 前缀 / `.vpk` 后缀 / 目录、统一小写），
        这样即使早期版本把成员记成了 `mod-xxx.vpk`、或漏了扩展名，也能正确匹配到文件。
        """
        mapping: dict[str, str] = {}
        if not self._addons_path:
            return mapping

        def add(name: str, list_key: str):
            mapping.setdefault(name, list_key)
            mapping.setdefault(name.lower(), list_key)
            mapping.setdefault(_normalize_mod_key(name), list_key)
            mapping.setdefault(f'mod-{name}', list_key)
            mapping.setdefault(_normalize_mod_key(f'mod-{name}'), list_key)

        addons_dir = Path(self._addons_path)
        try:
            for p in addons_dir.glob('*.vpk'):
                add(p.name, p.name)
            workshop_dir = addons_dir / 'workshop'
            if workshop_dir.exists():
                for p in workshop_dir.glob('*.vpk'):
                    add(p.name, 'workshop\\' + p.name)
                for item in workshop_dir.iterdir():
                    if item.is_dir():
                        for p in item.glob('*.vpk'):
                            add(p.name, 'workshop\\' + p.name)
        except Exception as e:
            print(f"[Prefs] Failed to enumerate mods: {e}")
        return mapping

    def _resolve_list_key(self, addonlist: dict, list_key: str) -> str:
        """找到 addonlist 里与 list_key 等价的真实条目。

        兼容 `workshop/<id>/<name>.vpk`（带子目录）等写法：只要文件名相同就视为同一条目。
        否则会出现「软件写入了一个新条目、游戏仍在读原来那一条」的分裂状态，
        表现就是「点了禁用游戏里却还是启用」「界面上又显示成启用」。
        """
        if list_key in addonlist:
            return list_key
        target = _normalize_mod_key(list_key)
        for k in addonlist:
            if _normalize_mod_key(k) == target:
                return k
        return list_key

    def iter_mod_files(self):
        """枚举 addons 目录下所有 mod 的 VPK 文件，产出 (path, is_workshop)。"""
        if not self._addons_path:
            return
        addons_dir = Path(self._addons_path)
        try:
            for p in addons_dir.glob('*.vpk'):
                if p.is_file():
                    yield p, False
        except Exception:
            pass

        workshop_dir = addons_dir / 'workshop'
        if not workshop_dir.exists():
            return
        try:
            for p in workshop_dir.glob('*.vpk'):
                if p.is_file():
                    yield p, True
            for item in workshop_dir.iterdir():
                if item.is_dir():
                    for p in item.glob('*.vpk'):
                        if p.is_file():
                            yield p, True
        except Exception:
            pass

    def find_mod_file(self, mod_name: str) -> Optional[tuple[Path, bool]]:
        """按名字精确查找 mod 的 VPK，返回 (文件路径, 是否创意工坊)。

        这里**不能**用 `glob(f'*{mod_name}*')`：玩家的 mod 名里经常带方括号
        （`[武器]SCAR.vpk`、`(F)Props REmastered [ 4k  Full HD ].vpk`、
        `[2]Admin Menu 2.0.vpk` ……），而 glob 会把 `[ ]` 当成字符类解释，
        于是 pattern 与真实文件名再也对不上 —— 表现就是用户反馈的
        「有几个 mod 无法启用 / 禁用无效 / 分类设置不上」。

        匹配规则（前者优先）：
          1. 文件名（忽略大小写）完全相同；
          2. 归一化后相同（兼容 `mod-xxx.vpk` 前缀、缺 `.vpk` 后缀、带目录写法）。
        """
        if not self._addons_path or not mod_name:
            return None

        wanted = Path(str(mod_name).replace('\\', '/')).name
        if not wanted:
            return None
        wanted_lower = wanted.lower()
        wanted_norm = _normalize_mod_key(wanted)

        normalized_hit: Optional[tuple[Path, bool]] = None
        for path, is_workshop in self.iter_mod_files():
            if path.name.lower() == wanted_lower:
                return path, is_workshop
            # 归一化后为空（例如名字就是 `mod-`）时不做模糊回退，避免误匹配
            if wanted_norm and normalized_hit is None and _normalize_mod_key(path.name) == wanted_norm:
                normalized_hit = (path, is_workshop)
        return normalized_hit

    def apply_mod_prefs_to_addonlist(self) -> int:
        """把软件里记录的启用状态写回 addonlist.txt（启动游戏前调用）。

        游戏会把「它内存里认为的」addon 列表写回该文件；启动前先写一次，
        能保证游戏读到的是软件里的配置，避免禁用设置被游戏（或 Steam 云同步）覆盖。
        返回实际同步的条目数。

        注意：此时还没被用户确认「同步」的游戏内改动会一并被覆盖掉 —— 这是有意的，
        因为「忽略 / 未处理」的语义就是「以软件里的设置为准」。
        """
        prefs = self._mod_enabled_prefs()
        if not prefs:
            return 0
        keys = self._mod_list_keys()
        addonlist = self._read_addonlist()
        changed = False
        applied = 0
        for mod_name, enabled in prefs.items():
            # 偏好键可能是历史写法（mod- 前缀 / 缺扩展名 / 大小写），同样做归一化回退查找
            list_key = keys.get(mod_name) or keys.get(_normalize_mod_key(mod_name))
            # 只处理仍然存在的 mod，避免把已删除 mod 的残留条目补回文件
            if not list_key:
                continue
            list_key = self._resolve_list_key(addonlist, list_key)
            applied += 1
            if addonlist.get(list_key) != enabled:
                addonlist[list_key] = enabled
                changed = True
        if changed:
            self._write_addonlist(addonlist)
            print(f"[Prefs] Synced {applied} mod state(s) into addonlist.txt before launch")
        # 调用这个入口就意味着「已经按软件设置应用过一次」→ 清掉「未应用」标记
        # （界面上的「应用」按钮随之熄灭）
        try:
            set_prefs_dirty(False)
        except Exception as e:
            print(f"[Prefs] Failed to clear dirty flag: {e}")
        return applied

    def _collect_addonlist_changes(self) -> tuple[str, list[dict]]:
        """算出「addonlist.txt 与软件记录不一致」的条目（只计算，不写任何数据）。

        返回 (当前指纹, 变更列表)；变更项形如
        {'name': 'xx.vpk', 'enabled': True, 'previous': False}。

        这里用「内容指纹」区分改动来源（软件写文件时会记录指纹，见 _write_addonlist）：
          * 指纹一致 → 文件是软件自己写的，没有外部改动；
          * 指纹不一致 → 文件被外部改过（游戏里启停 Mod / Steam 云 / 手动编辑）。

        安全策略：只处理文件里**显式存在**的条目，且只关心**软件里本来就有记录**的 mod。
        这样既不会把 addonlist 里的历史僵尸条目当成变更，也不会因为 Steam 云回滚出一份
        「缺少条目的旧文件」就把用户好不容易禁用的 Mod 又改回启用。

        首次建立基线（老版本升级上来、或用户删掉了 data.json）时没有旧指纹可比，
        只能靠时间判断：文件比软件记录新 → 视为外部改动。
        """
        addonlist_path = self._get_addonlist_path()
        if not addonlist_path:
            return '', []

        fingerprint = self._addonlist_fingerprint()
        if not fingerprint:
            # 文件不存在/读不到：清掉基线，避免下次拿旧指纹做比较
            if get_addonlist_state().get('fingerprint'):
                set_addonlist_state('', str(addonlist_path))
            return '', []

        known = get_addonlist_state().get('fingerprint')
        if known == fingerprint:
            return fingerprint, []

        addonlist = self._read_addonlist()
        prefs = self._mod_enabled_prefs()
        metas = {}
        if not known:
            try:
                metas = get_all_mod_metas()
            except Exception:
                metas = {}

        changes: list[dict] = []
        for path, is_workshop in self.iter_mod_files():
            name = path.name
            list_key = f'workshop\\{name}' if is_workshop else name
            list_key = self._resolve_list_key(addonlist, list_key)
            # 条目在文件里不存在时不做任何推测（保持软件里的记录不变）
            if list_key not in addonlist:
                continue

            value = addonlist[list_key]
            pref = prefs.get(name)
            if pref is None:
                pref = self._pref_norm_index.get(_normalize_mod_key(name))
            # 软件里没记录过的 mod：界面本来就跟随文件，无需提示同步
            if pref is None or pref == value:
                continue

            if not known and not self._file_is_newer_than_pref(addonlist_path, name, metas):
                continue

            changes.append({'name': name, 'enabled': bool(value), 'previous': bool(pref)})

        changes.sort(key=lambda c: c['name'].lower())
        return fingerprint, changes

    def get_pending_addonlist_changes(self) -> list[dict]:
        """检测「游戏里改过、还没同步进软件」的 Mod 启停（只检测，不改动任何数据）。

        界面据此弹出「检测到游戏内已更改，是否同步」：
        点「同步」→ apply_addonlist_changes()，点「忽略」→ dismiss_addonlist_changes()。
        """
        try:
            return self._collect_addonlist_changes()[1]
        except Exception as e:
            print(f"[Sync] Failed to detect addonlist.txt changes: {e}")
            return []

    def apply_addonlist_changes(self) -> int:
        """把游戏里的启停改动同步进软件（用户点「同步」时调用），返回同步条目数。"""
        addonlist_path = self._get_addonlist_path()
        try:
            fingerprint, changes = self._collect_addonlist_changes()
            if fingerprint:
                # 即使没有变更也要推进指纹：否则同一份文件会被反复检测出来
                set_addonlist_state(fingerprint, str(addonlist_path))
            if not changes:
                return 0
            set_mods_enabled_bulk({c['name']: c['enabled'] for c in changes})
            self.invalidate_mod_enabled_cache()
            print(f"[Sync] Applied {len(changes)} mod state(s) changed in game")
            return len(changes)
        except Exception as e:
            print(f"[Sync] Failed to apply addonlist.txt changes: {e}")
            return 0

    def dismiss_addonlist_changes(self) -> int:
        """忽略游戏里的启停改动（用户点「忽略」时调用），返回被忽略的条目数。

        「忽略」= 以软件里的设置为准：除了推进指纹（不再重复提示），还会把软件里的
        设置立刻写回 addonlist.txt —— 否则文件里仍是游戏改过的值，用户从 Steam 启动
        游戏时看到的还是「软件里禁用了、游戏里却没禁用」，正是用户反馈的现象。
        """
        addonlist_path = self._get_addonlist_path()
        try:
            fingerprint, changes = self._collect_addonlist_changes()
            if fingerprint:
                # 先以「当前文件」为基线（apply_mod_prefs_to_addonlist 写完后会再更新一次）
                set_addonlist_state(fingerprint, str(addonlist_path))
            if not changes:
                return 0
            # 把软件里的设置写回文件，让「软件状态」和「游戏读到的状态」立刻一致
            self.apply_mod_prefs_to_addonlist()
            print(f"[Sync] Dismissed {len(changes)} mod state(s) changed in game (kept app state)")
            return len(changes)
        except Exception as e:
            print(f"[Sync] Failed to dismiss addonlist.txt changes: {e}")
            return 0

    def _file_is_newer_than_pref(self, addonlist_path: Path, mod_name: str, metas: dict) -> bool:
        """addonlist.txt 的修改时间是否晚于软件里该 mod 的记录时间。

        只在「首次建立指纹基线」时使用：此时没有历史指纹可比，需要判断到底是
        「游戏改了文件」还是「软件刚把设置写进了文件」。留 1 秒容差，
        避免同一秒内的写入顺序导致误判。
        """
        try:
            meta = metas.get(mod_name)
            if meta is None or not meta.last_updated:
                return False
            try:
                pref_ts = datetime.fromisoformat(meta.last_updated).timestamp()
            except Exception:
                return False
            return addonlist_path.stat().st_mtime > pref_ts + 1.0
        except Exception:
            return False

    def diagnose_mod_states(self) -> dict:
        """导出「软件里的状态 vs addonlist.txt 里的真实条目」对账信息。

        用于排查「软件里禁用了某些 Mod，游戏里其实没有禁用」这类问题：
        逐条给出软件记录（pref）、文件里的条目（是否存在 / 值 / 原始出现次数）以及
        界面显示值，并把不一致或可疑的条目挑出来。

        注意：文件里**没有条目**时，游戏按「启用」处理（默认值），这里也按此估算
        `game_enabled`；它只是推断，不代表游戏一定如此。
        """
        addonlist_path = self._get_addonlist_path()
        raw_text = self._read_addonlist_text()
        addonlist = self._read_addonlist()
        prefs = self._mod_enabled_prefs()

        # 原始条目：同一名字可能出现多条（例如旧版本按 UTF-8 追加过一条）
        raw_entries: dict[str, list] = {}
        for line in raw_text.splitlines():
            s = line.strip()
            if not s or s.startswith('"AddonList"'):
                continue
            m = re.match(r'^"([^"]+)"\s+"(\d+)"', s)
            if not m:
                continue
            key = _decode_ansi_key(m.group(1)).replace('/', '\\')
            raw_entries.setdefault(key, []).append(m.group(2))

        suspicious: list = []
        total = 0
        for path, is_workshop in self.iter_mod_files():
            total += 1
            name = path.name
            list_key = f'workshop\\{name}' if is_workshop else name
            resolved = self._resolve_list_key(addonlist, list_key)
            in_file = resolved in addonlist
            occurrences = raw_entries.get(resolved, [])

            pref = prefs.get(name)
            if pref is None:
                pref = self._pref_norm_index.get(_normalize_mod_key(name))

            ui_enabled = self._resolve_enabled(name, list_key, addonlist)
            game_enabled = addonlist[resolved] if in_file else True

            if in_file and ui_enabled == game_enabled and len(occurrences) <= 1:
                continue

            suspicious.append({
                'name': name,
                'is_workshop': is_workshop,
                'pref': pref,
                'in_addonlist': in_file,
                'file_value': addonlist.get(resolved) if in_file else None,
                'file_occurrences': occurrences,
                'ui_enabled': ui_enabled,
                'game_enabled_guess': game_enabled,
            })

        return {
            'addons_path': self._addons_path,
            'addonlist_path': str(addonlist_path) if addonlist_path else None,
            'addonlist_found': bool(raw_text),
            # True = 文件里有按 ANSI 代码页写的中文条目（游戏写的），本次修复会正确处理它们
            'addonlist_uses_ansi': _has_surrogates(raw_text),
            'addonlist_entry_count': len(raw_entries),
            'mod_count': total,
            'pref_count': len(prefs),
            'suspicious_count': len(suspicious),
            'suspicious': suspicious,
            'addonlist_entries': raw_entries,
            'prefs': prefs,
        }

    def set_mods_enabled(self, mod_names: list, enable: Optional[bool] = None) -> dict:
        """批量设置一组 mod 的启用状态（整个整合包一次完成）。

        逐个调用 toggle_mod() 时，每个 mod 都要「读 addonlist → 写 addonlist → 重新解析 VPK」，
        整合包里几百个 mod 会卡住很久、界面也没有反馈；这里只读写一次文件。

        ``enable=None`` 表示「切换」：由后端按成员的真实状态决定目标
        （全启用 → 禁用；其余情况 → 全部启用）。让后端决定可以避免前端因为
        成员名匹配不上而算错方向 —— 那正是「一键启用/禁用点了没反应」的成因之一。

        返回 {'changed': 变更数量, 'missing': [没找到的 mod 名], 'updated': {名: 状态}, 'enable': 实际目标}
        """
        result = {'changed': 0, 'missing': [], 'updated': {}, 'enable': enable}
        if not self._addons_path or not mod_names:
            return result

        keys = self._mod_list_keys()
        addonlist = self._read_addonlist()

        if enable is None:
            # 切换语义：以成员的真实状态为准
            current_states = []
            for name in mod_names:
                list_key = keys.get(name) or keys.get(_normalize_mod_key(name))
                if not list_key:
                    continue
                current_states.append(self._resolve_enabled(name, list_key, addonlist))
            enable = (not all(current_states)) if current_states else False
        result['enable'] = enable

        states: dict = {}
        changed_count = 0
        file_changed = False

        for name in mod_names:
            # 先按原名查，再退化到归一化名（兼容 `MYMOD2` / `mod-xx.vpk` 这类历史写法）
            list_key = keys.get(name) or keys.get(_normalize_mod_key(name))
            if not list_key:
                result['missing'].append(name)
                continue
            # 写到文件里真实存在的那个条目（兼容各种历史写法）
            list_key = self._resolve_list_key(addonlist, list_key)
            states[name] = enable
            # 回传给前端的「实际生效状态」：前端据此做局部更新，
            # 不必再触发一次全量流式扫描（那会让界面弹出「正在扫描 Mod」并把按钮锁住）
            result['updated'][name] = enable
            if addonlist.get(list_key) != enable:
                addonlist[list_key] = enable
                file_changed = True
                changed_count += 1

        if file_changed:
            self._write_addonlist(addonlist)

        # 持久化用户选择（整个整合包只写一次 data.json）
        try:
            set_mods_enabled_bulk(states)
            # 同单个启停：标记「有改动还没应用」，让界面上的「应用」按钮点亮
            set_prefs_dirty(True)
        except Exception as e:
            print(f"[Packs] Failed to persist mod states: {e}")
        self.invalidate_mod_enabled_cache()

        # 让下一次扫描带上新状态（否则缓存里还是旧值）
        global _LAST_SCAN_KEY, _LAST_SCAN_RESULT, _LAST_CONFLICT_KEY
        _LAST_SCAN_KEY = None
        _LAST_SCAN_RESULT = []
        _LAST_CONFLICT_KEY = None

        result['changed'] = changed_count
        return result

    def _forget_mod_pref(self, mod_name: str):
        """mod 被删除后清理它的残留数据：启用偏好 + 所有整合包里的引用。

        不清整合包的话，包卡片上的 Mod 数量会虚高、详情页却匹配不到任何东西，
        导出时还会报「文件缺失」。
        """
        try:
            set_mod_enabled(mod_name, None)
        except Exception:
            pass
        try:
            remove_mod_from_all_packs(mod_name)
        except Exception as e:
            print(f"[Prefs] Failed to remove {mod_name} from packs: {e}")
        self.invalidate_mod_enabled_cache()

    def _load_config(self):
        config_path = self._get_config_path()
        if config_path.exists():
            try:
                data = json.loads(config_path.read_text(encoding='utf-8'))
                if data.get('addons_path') and not self._addons_path:
                    self.set_addons_path(data['addons_path'])
            except:
                pass

    def _save_config(self):
        config_path = self._get_config_path()
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            json.dumps({'addons_path': self._addons_path, 'updated_at': datetime.now().isoformat()},
                       ensure_ascii=False, indent=2),
            encoding='utf-8'
        )

    def get_addons_path(self) -> Optional[str]:
        return self._addons_path

    def set_addons_path(self, path: str) -> bool:
        p = Path(path)
        if not p.exists() or not p.is_dir():
            return False
        self._addons_path = str(p.resolve())
        self._save_config()
        return True

    def auto_detect_addons_path(self) -> Optional[str]:
        for path in [
            r'C:\Program Files (x86)\Steam\steamapps\common\Left 4 Dead 2\left4dead2\addons',
            r'C:\Program Files\Steam\steamapps\common\Left 4 Dead 2\left4dead2\addons',
            r'D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2\addons',
        ]:
            if Path(path).exists():
                self.set_addons_path(path)
                return path
        return None

    def _sync_scan_manifest(self, files: dict[str, float]) -> None:
        """把「当前 Mod 文件清单（相对路径 -> mtime）」写进 data.json。

        `/api/mods/scan-status` 靠它判断「文件是否在软件之外发生了增删改」，
        前端据此轮询刷新列表 —— 这样「在 Steam 里取消订阅（vpk 被删掉）」
        「新订阅的 Mod 下载完成」「手动往 addons 里丢文件」都能自动反映到界面，
        不会再出现「已经取消订阅，卡片还留在界面上」。
        只有真的变化了才写盘，避免每次扫描都碰 data.json。
        """
        try:
            if get_scan_manifest().files == files:
                return
            save_scan_manifest(ScanManifest(
                files=files,
                last_scan=datetime.now().isoformat(timespec='seconds'),
            ))
        except Exception as e:
            print(f"[Scan] Failed to sync scan manifest: {e}")

    def scan_mods(self) -> list[ModInfo]:
        """线程安全入口：把真正的扫描实现包在锁里串行执行。"""
        with _SCAN_LOCK:
            return self._scan_mods_impl()

    def _scan_mods_impl(self) -> list[ModInfo]:
        if not self._addons_path:
            return []
        
        addons_dir = Path(self._addons_path)
        if not addons_dir.exists():
            return []
        
        global _LAST_SCAN_RESULT, _LAST_SCAN_KEY, _LAST_CONFLICT_KEY
        
        # Build a scan key: path + all vpk filenames + sizes + mtimes
        vpk_files = sorted(addons_dir.glob('*.vpk'), key=lambda f: f.stem.lower())
        workshop_dir = addons_dir / 'workshop'
        workshop_vpk = sorted(workshop_dir.glob('*.vpk'), key=lambda f: f.stem.lower()) if workshop_dir.exists() else []
        workshop_dirs = sorted(workshop_dir.iterdir()) if workshop_dir.exists() else []
        
        # Quick check if anything changed
        scan_parts = [self._addons_path]
        manifest: dict[str, float] = {}   # 相对路径(posix) -> mtime，供 /api/mods/scan-status 比对
        for fp in vpk_files:
            try:
                s = fp.stat()
                scan_parts.append(f"{fp.name}|{s.st_size}|{int(s.st_mtime)}")
                manifest[fp.name] = s.st_mtime
            except:
                pass
        for fp in workshop_vpk:
            try:
                s = fp.stat()
                scan_parts.append(f"w|{fp.name}|{s.st_size}|{int(s.st_mtime)}")
                manifest[f"workshop/{fp.name}"] = s.st_mtime
            except:
                pass
        for d in workshop_dirs:
            if d.is_dir():
                for fp in d.glob('*.vpk'):
                    try:
                        s = fp.stat()
                        scan_parts.append(f"wd|{d.name}|{fp.name}|{s.st_size}|{int(s.st_mtime)}")
                        manifest[f"workshop/{d.name}/{fp.name}"] = s.st_mtime
                    except:
                        pass
        
        scan_key = hashlib.md5('|'.join(scan_parts).encode()).hexdigest()
        # 记录磁盘现状（缓存命中与否都要记），供界面轮询发现「软件之外的文件变化」
        self._sync_scan_manifest(manifest)
        
        # If nothing changed, return cached result
        if _LAST_SCAN_KEY == scan_key and _LAST_SCAN_RESULT:
            _t_cache0 = time.perf_counter()
            # Still need to refresh addonlist (toggles might have changed)
            addonlist = self._read_addonlist()
            for mod in _LAST_SCAN_RESULT:
                list_key = f'workshop\\{mod.name}' if mod.is_workshop else mod.name
                mod.enabled = self._resolve_enabled(mod.name, list_key, addonlist)
            # 仅当启用状态指纹变化时才重算冲突，否则直接复用上次结果，
            # 避免每次 /api/mods 请求都重复做昂贵的冲突检测。
            fp = _conflict_fingerprint(_LAST_SCAN_RESULT, self._addons_path)
            if fp != _LAST_CONFLICT_KEY:
                _detect_conflicts(_LAST_SCAN_RESULT, self._addons_path)
                _LAST_CONFLICT_KEY = fp
            _record_scan_perf(
                'cached', (time.perf_counter() - _t_cache0) * 1000, len(_LAST_SCAN_RESULT)
            )
            return _LAST_SCAN_RESULT

        print(f"[Scan] Scanning mods (key={scan_key[:8]}...)")
        _t_scan0 = time.perf_counter()
        
        addonlist = self._read_addonlist()
        all_mods: list[ModInfo] = []
        
        # Parse mods using ThreadPoolExecutor for parallel VPK parsing
        mod_tasks = []
        with ThreadPoolExecutor(max_workers=_SCAN_WORKERS) as executor:
            # Submit all VPK parsing tasks
            for file_path in vpk_files:
                mod_tasks.append(executor.submit(self._parse_vpk_fast, file_path, addonlist, False, None))
            
            if workshop_dir.exists():
                for file_path in workshop_vpk:
                    mod_tasks.append(executor.submit(
                        self._parse_vpk_fast, file_path, addonlist, True, file_path.stem
                    ))
                for item in workshop_dirs:
                    if item.is_dir():
                        vpk_list = list(item.glob('*.vpk'))
                        if vpk_list:
                            mod_tasks.append(executor.submit(
                                self._parse_vpk_fast, vpk_list[0], addonlist, True, item.name
                            ))
            
            # Collect results as they complete
            for future in as_completed(mod_tasks):
                try:
                    mod = future.result()
                    if mod:
                        all_mods.append(mod)
                except Exception as e:
                    print(f"[Scan] Task error: {e}")
        
        # Sort
        all_mods.sort(key=lambda m: (0 if not m.is_workshop else 1, m.display_name.lower()))
        
        # Detect conflicts（读 VPK 目录树的路径 + CRC，走磁盘索引缓存）
        _detect_conflicts(all_mods, self._addons_path)
        
        # Cache result
        _LAST_SCAN_KEY = scan_key
        _LAST_SCAN_RESULT = all_mods
        _LAST_CONFLICT_KEY = _conflict_fingerprint(all_mods, self._addons_path)
        
        print(f"[Scan] Done: {len(all_mods)} mods, {len([m for m in all_mods if m.conflicts])} with conflicts")
        _record_scan_perf(
            'full',
            (time.perf_counter() - _t_scan0) * 1000,
            len(all_mods),
            {'conflicts': len([m for m in all_mods if m.conflicts])},
        )
        return all_mods

    def stream_mods(self):
        """线程安全入口（生成器）：整段扫描在**单独一个工作线程**里跑完，
        解析结果通过队列交给调用方。

        为什么必须这样（而不是简单地 `with _SCAN_LOCK: yield from ...`）：
        这个同步生成器会被 Starlette 丢进线程池逐块迭代，生成器的收尾可能落在
        **另一个线程**上 —— 只要 acquire/release 不在同一线程，锁就会泄漏，
        之后整个后端被永久锁死（详见 _ScanLock 上方的事故复盘）。
        把整段扫描放进同一个线程 + 队列转交，acquire/release 一定成对且同线程；
        客户端中途断开（前端看门狗中止）时，下面的 finally 会把队列排空并等 worker
        收尾，锁照样会释放。
        """
        events: "queue.Queue" = queue.Queue()
        abandoned = threading.Event()  # 消费端提前退出时置位，worker 据此尽早收手
        _DONE = object()

        def worker():
            try:
                with _SCAN_LOCK:
                    for evt in self._stream_mods_impl():
                        if abandoned.is_set():
                            # 消费端已经断开（前端看门狗中止 / 用户切页 / 关闭窗口）：
                            # 尽早跳出，把扫描锁让给下一个请求，别空跑完整轮。
                            break
                        events.put(evt)
            except BaseException as e:  # 任何异常都要让消费端能正常结束
                try:
                    events.put({'type': 'error', 'detail': str(e)})
                except Exception:
                    pass
            finally:
                events.put(_DONE)

        threading.Thread(target=worker, name='mod-scan-stream', daemon=True).start()

        finished = False
        try:
            while True:
                evt = events.get()
                if evt is _DONE:
                    finished = True
                    return
                yield evt
        finally:
            if not finished:
                # 消费端提前退出：通知 worker 收手，并排空队列。
                # ⚠️ 这里**绝不能长时间等待**：同步生成器的收尾有可能发生在事件循环
                # 线程上（Starlette 的 async 生成器被回收时会就地 close 同步生成器），
                # 等太久会把整个后端的事件循环一起卡住。所以只做「置位 + 排空 + 短宽限」，
                # worker 会在下一个事件处自行跳出并释放扫描锁。
                abandoned.set()
                deadline = time.monotonic() + 0.25
                while True:
                    try:
                        if events.get(timeout=max(0.0, deadline - time.monotonic())) is _DONE:
                            break
                    except queue.Empty:
                        break

    def _stream_mods_impl(self):
        """流式扫描：每解析完一个 Mod 就产出一条事件，前端可“收一个显示一个”。

        产出事件（每条序列化为一行 NDJSON）：
          {'type':'meta','total':n}
          {'type':'mod','mod': {...ModInfo 字段...}}
          {'type':'conflict','name':...,'conflicts':[...]}   # 全量扫描完成后回填
          {'type':'done','count':n}
          {'type':'error','detail':...}
        """
        global _LAST_SCAN_KEY, _LAST_SCAN_RESULT, _LAST_CONFLICT_KEY
        if not self._addons_path:
            yield {'type': 'error', 'detail': 'Addons 路径未配置'}
            return

        addons_dir = Path(self._addons_path)
        if not addons_dir.exists():
            yield {'type': 'error', 'detail': f'Addons 目录不存在: {addons_dir}'}
            return

        # 枚举 vpk（与 scan_mods 保持一致）
        vpk_files = sorted(addons_dir.glob('*.vpk'), key=lambda f: f.stem.lower())
        workshop_dir = addons_dir / 'workshop'
        workshop_vpk = sorted(workshop_dir.glob('*.vpk'), key=lambda f: f.stem.lower()) if workshop_dir.exists() else []
        workshop_dir_vpk: list[tuple[Path, str]] = []  # (file_path, workshop_id)
        if workshop_dir.exists():
            for d in sorted(workshop_dir.iterdir()):
                if d.is_dir():
                    vl = sorted(d.glob('*.vpk'), key=lambda f: f.stem.lower())
                    if vl:
                        workshop_dir_vpk.append((vl[0], d.name))

        total = len(vpk_files) + len(workshop_vpk) + len(workshop_dir_vpk)

        # 构建 scan_key（与 scan_mods 一致：路径 + 名称/大小/修改时间）
        scan_parts = [self._addons_path]
        manifest: dict[str, float] = {}   # 相对路径(posix) -> mtime，供 /api/mods/scan-status 比对
        for fp in vpk_files:
            try:
                s = fp.stat()
                scan_parts.append(f"{fp.name}|{s.st_size}|{int(s.st_mtime)}")
                manifest[fp.name] = s.st_mtime
            except Exception:
                pass
        for fp in workshop_vpk:
            try:
                s = fp.stat()
                scan_parts.append(f"w|{fp.name}|{s.st_size}|{int(s.st_mtime)}")
                manifest[f"workshop/{fp.name}"] = s.st_mtime
            except Exception:
                pass
        for fp, ws_id in workshop_dir_vpk:
            try:
                s = fp.stat()
                scan_parts.append(f"wd|{ws_id}|{fp.name}|{s.st_size}|{int(s.st_mtime)}")
                manifest[f"workshop/{ws_id}/{fp.name}"] = s.st_mtime
            except Exception:
                pass
        scan_key = hashlib.md5('|'.join(scan_parts).encode()).hexdigest()
        # 记录磁盘现状（缓存命中与否都要记），供界面轮询发现「软件之外的文件变化」
        self._sync_scan_manifest(manifest)

        # 缓存命中：内容未变化 → 快速返回上次结果（含冲突），无需重新解析 VPK
        if _LAST_SCAN_RESULT and _LAST_SCAN_KEY == scan_key:
            _t_cache0 = time.perf_counter()
            yield {'type': 'meta', 'total': len(_LAST_SCAN_RESULT)}
            addonlist = self._read_addonlist()
            for mod in _LAST_SCAN_RESULT:
                list_key = f'workshop\\{mod.name}' if mod.is_workshop else mod.name
                mod.enabled = self._resolve_enabled(mod.name, list_key, addonlist)
            fp = _conflict_fingerprint(_LAST_SCAN_RESULT, self._addons_path)
            if fp != _LAST_CONFLICT_KEY:
                _detect_conflicts(_LAST_SCAN_RESULT, self._addons_path)
                _LAST_CONFLICT_KEY = fp
            for mod in _LAST_SCAN_RESULT:
                yield {'type': 'mod', 'mod': vars(mod)}
                yield {
                    'type': 'conflict',
                    'name': mod.name,
                    'conflicts': mod.conflicts,
                    'conflict_details': mod.conflict_details,
                    'conflict_hints': mod.conflict_hints,
                    'role': mod.role,
                    'role_tags': mod.role_tags,
                }
            _cached_elapsed = (time.perf_counter() - _t_cache0) * 1000
            _record_scan_perf('stream-cached', _cached_elapsed, len(_LAST_SCAN_RESULT))
            yield {
                'type': 'done',
                'count': len(_LAST_SCAN_RESULT),
                'cached': True,
                'elapsed_ms': round(_cached_elapsed, 1),
            }
            return

        print(f"[Scan] Streaming scan start (key={scan_key[:8]}...) total={total}")
        _t_stream0 = time.perf_counter()
        _first_mod_ms: Optional[float] = None
        yield {'type': 'meta', 'total': total}

        addonlist = self._read_addonlist()
        collected: list[ModInfo] = []
        mod_tasks = []

        with ThreadPoolExecutor(max_workers=_SCAN_WORKERS) as executor:
            for fp in vpk_files:
                mod_tasks.append(executor.submit(self._parse_vpk_fast, fp, addonlist, False, None))
            for fp in workshop_vpk:
                mod_tasks.append(executor.submit(self._parse_vpk_fast, fp, addonlist, True, fp.stem))
            for fp, ws_id in workshop_dir_vpk:
                mod_tasks.append(executor.submit(self._parse_vpk_fast, fp, addonlist, True, ws_id))

            for future in as_completed(mod_tasks):
                try:
                    mod = future.result()
                except Exception as e:
                    print(f"[Scan] Task error: {e}")
                    continue
                if mod:
                    collected.append(mod)
                    if _first_mod_ms is None:
                        _first_mod_ms = (time.perf_counter() - _t_stream0) * 1000
                    yield {'type': 'mod', 'mod': vars(mod)}

        collected.sort(key=lambda m: (0 if not m.is_workshop else 1, m.display_name.lower()))
        _detect_conflicts(collected, self._addons_path)

        _LAST_SCAN_KEY = scan_key
        _LAST_SCAN_RESULT = collected
        _LAST_CONFLICT_KEY = _conflict_fingerprint(collected, self._addons_path)

        # 全部解析完成后回填冲突
        for mod in collected:
            yield {
                'type': 'conflict',
                'name': mod.name,
                'conflicts': mod.conflicts,
                'conflict_details': mod.conflict_details,
                'conflict_hints': mod.conflict_hints,
                'role': mod.role,
                'role_tags': mod.role_tags,
            }

        print(f"[Scan] Stream done: {len(collected)} mods")
        _stream_elapsed = (time.perf_counter() - _t_stream0) * 1000
        _record_scan_perf(
            'stream',
            _stream_elapsed,
            len(collected),
            {
                'first_mod_ms': None if _first_mod_ms is None else round(_first_mod_ms, 1),
                'conflicts': len([m for m in collected if m.conflicts]),
            },
        )
        yield {
            'type': 'done',
            'count': len(collected),
            'cached': False,
            'elapsed_ms': round(_stream_elapsed, 1),
            'first_mod_ms': None if _first_mod_ms is None else round(_first_mod_ms, 1),
        }

    def _parse_vpk_fast(
        self, file_path: Path, addonlist: dict[str, bool],
        is_workshop: bool, workshop_id: Optional[str]
    ) -> Optional[ModInfo]:
        """Parse a single VPK into ModInfo (cached metadata)."""
        try:
            name = file_path.name
            list_key = f'workshop\\{name}' if is_workshop else name
            # 软件里设置过的状态优先（否则游戏/Steam 云改写过 addonlist.txt 后，
            # 界面上的禁用状态会被“反向”改回启用）
            is_enabled = self._resolve_enabled(name, list_key, addonlist)
            stat = file_path.stat()
            
            # Tags
            if is_workshop:
                tags = ['创意工坊 Mod']
                if workshop_id:
                    tags.append(f'ID: {workshop_id}')
            else:
                tags = ['外部 Mod']
            
            # Get cached metadata (fast on subsequent runs)
            # This also warms the manifest cache for conflict detection
            metadata = _get_metadata(file_path)
            
            # ── 分类标签（**多标签**）──
            # 手动优先：用户改过一次就以手动集合为准（可以删掉自动检测出来的类别）；
            # 没设置过则用内容自动检测出的多个标签（见 _get_metadata 的 category_tags）。
            override_tags = get_mod_tags_override(name)
            if override_tags is None:
                legacy = get_mod_category(name)      # 兼容早期版本的「单值手动分类」
                if legacy:
                    override_tags = [legacy]
            if override_tags is not None:
                category_tags = [t for t in override_tags if t in _ALL_CATEGORY_NAMES]
                tags_are_manual = True
            else:
                category_tags = list(metadata.get('category_tags') or [])
                # 兼容：极老缓存里只有单值 category，且必须是**当前**分类名才认
                # （否则「地图 / 材质/皮肤」这类旧分类名会被当成标签继续显示）
                if not category_tags and metadata.get('category') in _ALL_CATEGORY_NAMES:
                    category_tags = [metadata['category']]
                tags_are_manual = False

            # addoninfo 里作者自定义的标签（排除分类名与旧分类名，避免重复/过时）
            extra_tags = [
                t for t in (metadata.get('tags') or [])
                if t not in _ALL_CATEGORY_NAMES and t not in _LEGACY_CATEGORY_NAMES
            ]

            # Merge tags（不改 metadata 本身：它是缓存对象，就地修改会污染缓存）
            for t in extra_tags + category_tags:
                if t not in tags:
                    tags.append(t)
            
            # Display name
            display_name = metadata['display_name'] or (name[:-4] if name.lower().endswith('.vpk') else name)
            
            # 封面优先级：
            #   1) 与 vpk 同名的外部图片（xxx.vpk ↔ xxx.jpg/png/…）—— 本地 Mod 与工坊
            #      都支持（以前只对工坊生效、且只认 .jpg，于是本地同名图片一直不显示）
            #   2) VPK 内部提取出来的封面（已缓存在 _VPK_CACHE_DIR）
            thumbnail_url = metadata.get('thumbnail_url')
            sidecar = _find_sidecar_thumbnail(file_path)
            if sidecar is not None:
                thumbnail_url = f'/api/thumbnail?path={quote(str(sidecar.resolve()))}'
            
            return ModInfo(
                name=name, display_name=display_name,
                path=str(file_path.resolve()),
                size_bytes=stat.st_size, enabled=is_enabled,
                is_workshop=is_workshop, workshop_id=workshop_id,
                last_modified=datetime.fromtimestamp(stat.st_mtime).isoformat(),
                tags=tags, thumbnail_url=thumbnail_url,
                vpk_title=metadata.get('vpk_title'),
                author=metadata.get('author'),
                description=metadata.get('description'),
                version=metadata.get('version'),
                category=(category_tags[0] if category_tags else None),
                tags_manual=tags_are_manual,
            )
        except Exception as e:
            print(f"[VPK] Error {file_path.name}: {e}")
            return None

    def toggle_mod(self, mod_name: str, enable: Optional[bool] = None) -> Optional[ModInfo]:
        if not self._addons_path:
            return None

        # 精确查找（不能再用 glob：mod 名里的 [ ] 会被当成字符类，
        # 导致「点启用没反应」—— 详见 find_mod_file 的说明）
        found = self.find_mod_file(mod_name)
        if not found:
            return None
        file_path, is_workshop = found

        addonlist = self._read_addonlist()
        list_key = f'workshop\\{file_path.name}' if is_workshop else file_path.name
        # 用「界面同一套逻辑」取当前状态，并把值写到文件里真实存在的那个条目上：
        #   - 取反基准与界面显示一致 → 点一下必然切换（不会出现「点了没反应」）
        #   - 兼容 workshop/<id>/<name>.vpk 等写法 → 不会分裂成两条互不相关的记录
        list_key = self._resolve_list_key(addonlist, list_key)
        current = self._resolve_enabled(file_path.name, list_key, addonlist)
        new_enabled = not current if enable is None else enable
        addonlist[list_key] = new_enabled
        self._write_addonlist(addonlist)

        # 把用户的选择持久化为「软件配置」：游戏（或 Steam 云同步）之后改写
        # addonlist.txt 时，软件仍按这里的设置显示，并在启动游戏前写回文件。
        try:
            set_mod_enabled(file_path.name, new_enabled)
            # 记下「有改动还没写回 addonlist.txt」：界面左下角的「应用」按钮会点亮
            set_prefs_dirty(True)
        except Exception as e:
            print(f"[Toggle] Failed to persist state for {file_path.name}: {e}")
        self.invalidate_mod_enabled_cache()
        
        # Invalidate scan cache so next scan_mods() will re-detect conflicts correctly
        global _LAST_SCAN_KEY, _LAST_SCAN_RESULT, _LAST_CONFLICT_KEY
        _LAST_SCAN_KEY = None
        _LAST_SCAN_RESULT = []
        _LAST_CONFLICT_KEY = None
        
        return self._parse_vpk_fast(file_path, addonlist, is_workshop,
                                     file_path.stem if is_workshop else None)

    def set_mod_category(self, mod_name: str, category: Optional[str]) -> Optional[ModInfo]:
        if not self._addons_path:
            return None

        # 同样要精确查找：含 [ ] 的 mod 名用 glob 会匹配不到（分类改不上）
        found = self.find_mod_file(mod_name)
        if not found:
            return None
        file_path, is_workshop = found

        if category:
            set_mod_category(file_path.name, category)
        else:
            set_mod_category(file_path.name, None)
        
        # Invalidate metadata cache for this file so it re-parses with new override
        _VPK_METADATA_CACHE.pop(str(file_path.resolve()), None)
        
        addonlist = self._read_addonlist()
        return self._parse_vpk_fast(file_path, addonlist, is_workshop,
                                     file_path.stem if is_workshop else None)

    def set_mod_tags(self, mod_name: str, tags: Optional[list]) -> Optional[ModInfo]:
        """设置 / 清除某个 Mod 的分类标签（传 None = 恢复「跟随内容自动检测」）。

        支持多标签：传进来的列表就是最终的标签集合（可以只留一个，也可以同时留多个）。
        只接受合法的分类名（见 CATEGORIES），自动去重并保持传入顺序。
        """
        if not self._addons_path:
            return None

        found = self.find_mod_file(mod_name)
        if not found:
            return None
        file_path, is_workshop = found

        try:
            if tags is None:
                set_mod_tags_override(file_path.name, None)
            else:
                cleaned = [str(t).strip() for t in tags if str(t).strip()]
                valid = [t for t in dict.fromkeys(cleaned) if t in _ALL_CATEGORY_NAMES]
                set_mod_tags_override(file_path.name, valid)
        except Exception as e:
            print(f"[Tags] Failed to persist tags for {file_path.name}: {e}")
            return None

        # 扫描结果缓存失效：下次扫描/刷新就带上新标签
        global _LAST_SCAN_KEY, _LAST_SCAN_RESULT, _LAST_CONFLICT_KEY
        _LAST_SCAN_KEY = None
        _LAST_SCAN_RESULT = []
        _LAST_CONFLICT_KEY = None

        addonlist = self._read_addonlist()
        return self._parse_vpk_fast(file_path, addonlist, is_workshop,
                                     file_path.stem if is_workshop else None)

    def delete_mod(self, mod_name: str) -> bool:
        if not self._addons_path:
            return False

        # 精确查找：名字里的 [ ] 会让 glob 匹配失败（表现为「删不掉」）
        found = self.find_mod_file(mod_name)
        if not found:
            return False
        file_path, _ = found
        parent = file_path.parent

        try:
            file_path.unlink()
        except Exception:
            return False

        # Clear caches for this file
        _VPK_MANIFEST_CACHE.pop(str(file_path.resolve()), None)
        _VPK_METADATA_CACHE.pop(str(file_path.resolve()), None)
        self._forget_mod_pref(file_path.name)

        # 连同名封面图一起删掉，避免留下一张孤儿图片
        for ext in ('.jpg', '.jpeg', '.png', '.webp', '.bmp'):
            try:
                sidecar = file_path.with_suffix(ext)
                if sidecar.is_file():
                    sidecar.unlink()
            except Exception:
                pass

        # 创意工坊的 `<id>/` 目录清空后一并移除
        try:
            if parent.name.lower() != 'workshop' and parent.parent.name.lower() == 'workshop':
                if parent.is_dir() and not any(parent.iterdir()):
                    shutil.rmtree(parent, ignore_errors=True)
        except Exception:
            pass

        return True
