"""Unified data storage service - stores mod metadata, packs, and settings in a single JSON file.
Zero external dependencies, uses Python standard library only."""

import json
import threading
import time
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field, asdict, fields
from datetime import datetime


_CACHE_DIR = Path.home() / '.l4d2-manager'
_DATA_FILE = _CACHE_DIR / 'data.json'

# File lock for thread safety
_file_lock = threading.Lock()

# In-memory cache (avoids disk reads on every call)
_cache: Optional[dict] = None
_cache_timestamp: float = 0
_CACHE_TTL = 2.0  # seconds before re-reading from disk


@dataclass
class ModMeta:
    """Per-mod metadata stored persistently."""
    display_name: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    last_updated: Optional[str] = None
    # 用户在软件里手动设置的启用状态（None = 没设置过，跟随 addonlist.txt）。
    # 游戏（或 Steam 云同步）会改写 addonlist.txt，把软件里的禁用设置覆盖掉，
    # 所以软件需要自己持久化一份权威状态，并在启动游戏前写回文件。
    enabled: Optional[bool] = None
    # 用户手动设置的分类标签（None = 没设置过，跟随内容自动检测）。
    # 一旦设置过就以它为准：既能删掉自动检测出来的标签，也能一次加多个。
    tags_override: Optional[list[str]] = None


@dataclass
class PackData:
    """整合包数据"""
    id: str
    name: str
    mod_ids: list[str] = field(default_factory=list)  # 存储文件路径 hash 而非文件名
    created_at: str = ""
    updated_at: str = ""


@dataclass
class AppSettings:
    """应用设置"""
    addons_path: Optional[str] = None
    theme: str = "dark"
    background: Optional[dict] = None
    show_mascot: bool = True


@dataclass
class ScanManifest:
    """扫描清单 - 用于增量扫描"""
    files: dict[str, float] = field(default_factory=dict)  # filename -> mtime
    last_scan: Optional[str] = None


@dataclass
class AppData:
    """顶层数据容器"""
    version: int = 2  # data format version
    mod_metas: dict[str, dict] = field(default_factory=dict)  # mod_name -> ModMeta dict
    packs: list[dict] = field(default_factory=list)  # list of PackData dicts
    settings: dict = field(default_factory=dict)  # AppSettings dict
    scan_manifest: dict = field(default_factory=dict)  # ScanManifest dict
    # 「软件最后一次写 addonlist.txt」的内容指纹（见 mod_scanner._collect_addonlist_changes）。
    # 指纹对不上 = 文件被外部（游戏 / Steam 云 / 手动编辑）改过 → 由界面弹窗询问用户是否同步。
    # 放在顶层而不是 settings 里：get_settings() 用 AppSettings(**settings) 构造，
    # 多出来的键会让它抛 TypeError。
    addonlist_state: dict = field(default_factory=dict)
    # 「游戏运行期间用户在软件里改过 Mod 启停」的标记。
    # 游戏（Add-ons 菜单）在退出时会把**它内存里认为的**启停状态写回 addonlist.txt，
    # 把用户在软件里刚做的设置覆盖掉 —— 用户反馈的「全部禁用后还有几十个 Mod 是启用、
    # 刷新又弹『检测到游戏内已启用』」就是这么来的（见 main._reapply_prefs_after_game_exit）。
    # 有该标记时，后端在检测到游戏进程退出后会以软件设置为准重新写回文件。
    pending_game_reapply: dict = field(default_factory=dict)
    # 「软件里的启停设置还没写回 addonlist.txt」的标记：改动 Mod 后置位、点「应用」后清除。
    # 界面上的「应用」按钮据此点亮，提醒用户还有改动没同步给游戏。
    prefs_dirty: bool = False


def _get_default_data() -> dict:
    return asdict(AppData())


def _read_data_raw() -> dict:
    """Read raw data from disk."""
    global _cache, _cache_timestamp

    now = time.time()
    if _cache is not None and (now - _cache_timestamp) < _CACHE_TTL:
        return _cache

    if _DATA_FILE.exists():
        try:
            data = json.loads(_DATA_FILE.read_text(encoding='utf-8'))
            # Version migration if needed
            if data.get('version', 0) < 2:
                data = _migrate_v1_to_v2(data)
            _cache = data
            _cache_timestamp = now
            return data
        except (json.JSONDecodeError, OSError):
            pass

    # File doesn't exist or corrupt
    default = _get_default_data()
    _cache = default
    _cache_timestamp = now
    return default


def _write_data_raw(data: dict):
    """Write data to disk atomically."""
    global _cache, _cache_timestamp

    _DATA_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Atomic write: write to temp file, then rename
    tmp_file = _DATA_FILE.with_suffix('.tmp')
    tmp_file.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, default=str),
        encoding='utf-8'
    )
    tmp_file.replace(_DATA_FILE)

    _cache = data
    _cache_timestamp = time.time()


def _migrate_v1_to_v2(data: dict) -> dict:
    """Migrate from v1 format to v2."""
    new_data = _get_default_data()

    # Migrate mod categories from old file
    old_categories_file = _CACHE_DIR / 'mod_categories.json'
    if old_categories_file.exists():
        try:
            old_cats = json.loads(old_categories_file.read_text(encoding='utf-8'))
            for mod_name, cat in old_cats.items():
                if mod_name not in new_data['mod_metas']:
                    new_data['mod_metas'][mod_name] = {}
                new_data['mod_metas'][mod_name]['category'] = cat
                new_data['mod_metas'][mod_name]['last_updated'] = datetime.now().isoformat()
        except:
            pass

    # Migrate old config
    old_config = _CACHE_DIR / 'config.json'
    if old_config.exists():
        try:
            old_cfg = json.loads(old_config.read_text(encoding='utf-8'))
            if old_cfg.get('addons_path'):
                new_data['settings']['addons_path'] = old_cfg['addons_path']
        except:
            pass

    new_data['version'] = 2
    return new_data


# ===== Public API =====

def get_mod_meta(mod_name: str) -> ModMeta:
    """Get metadata for a specific mod."""
    with _file_lock:
        data = _read_data_raw()
        raw = data['mod_metas'].get(mod_name, {})
        return ModMeta(**raw)


def set_mod_meta(mod_name: str, meta: ModMeta):
    """Set metadata for a specific mod."""
    with _file_lock:
        data = _read_data_raw()
        meta.last_updated = datetime.now().isoformat()
        data['mod_metas'][mod_name] = asdict(meta)
        _write_data_raw(data)


def get_all_mod_metas() -> dict[str, ModMeta]:
    """Get all mod metadata."""
    with _file_lock:
        data = _read_data_raw()
        result = {}
        for name, raw in data['mod_metas'].items():
            result[name] = ModMeta(**raw)
        return result


def get_mod_category(mod_name: str) -> Optional[str]:
    """Get category override for a mod."""
    meta = get_mod_meta(mod_name)
    return meta.category


def set_mod_category(mod_name: str, category: Optional[str]):
    """Set category override for a mod."""
    meta = get_mod_meta(mod_name)
    meta.category = category
    set_mod_meta(mod_name, meta)


def get_mod_tags_override(mod_name: str) -> Optional[list[str]]:
    """用户手动设置的分类标签（None = 没设置过，跟随内容自动检测）。"""
    tags = get_mod_meta(mod_name).tags_override
    return list(tags) if tags is not None else None


def set_mod_tags_override(mod_name: str, tags: Optional[list[str]]):
    """设置 / 清除某个 Mod 的手动分类标签（传 None 表示恢复「跟随自动检测」）。"""
    meta = get_mod_meta(mod_name)
    meta.tags_override = list(tags) if tags is not None else None
    set_mod_meta(mod_name, meta)


def get_mod_enabled(mod_name: str) -> Optional[bool]:
    """Get the user-set enabled state for a mod (None = never set by the user)."""
    return get_mod_meta(mod_name).enabled


def set_mod_enabled(mod_name: str, enabled: Optional[bool]):
    """Persist the user-set enabled state for a mod."""
    meta = get_mod_meta(mod_name)
    meta.enabled = enabled
    set_mod_meta(mod_name, meta)


def get_all_mod_enabled() -> dict[str, bool]:
    """Get every mod that has a user-set enabled state (mod_name -> enabled)."""
    result: dict[str, bool] = {}
    for name, meta in get_all_mod_metas().items():
        if meta.enabled is not None:
            result[name] = bool(meta.enabled)
    return result


def set_mods_enabled_bulk(states: dict[str, Optional[bool]]):
    """批量持久化 mod 启用状态（整个整合包一次写盘，而不是逐个 mod 写一次）。

    逐个 set_mod_enabled() 会每个 mod 都读写一遍 data.json，整合包里有几百个 mod 时
    会明显卡顿，甚至因为请求乱序导致界面状态回退。
    """
    if not states:
        return
    with _file_lock:
        data = _read_data_raw()
        now = datetime.now().isoformat()
        for name, enabled in states.items():
            meta = dict(data['mod_metas'].get(name) or {})
            meta['enabled'] = enabled
            meta['last_updated'] = now
            data['mod_metas'][name] = meta
        _write_data_raw(data)


def get_mod_display_name(mod_name: str) -> Optional[str]:
    """Get display name override for a mod."""
    meta = get_mod_meta(mod_name)
    return meta.display_name


def set_mod_display_name(mod_name: str, display_name: Optional[str]):
    """Set display name override for a mod."""
    meta = get_mod_meta(mod_name)
    meta.display_name = display_name
    set_mod_meta(mod_name, meta)


# ===== Pack API =====

def get_packs() -> list[PackData]:
    """Get all packs."""
    with _file_lock:
        data = _read_data_raw()
        return [PackData(**p) for p in data['packs']]


def save_packs(packs: list[PackData]):
    """Save all packs (atomic replace)."""
    with _file_lock:
        data = _read_data_raw()
        data['packs'] = [asdict(p) for p in packs]
        _write_data_raw(data)


def add_pack(name: str) -> PackData:
    """Create a new pack."""
    packs = get_packs()
    now = datetime.now().isoformat()
    new_pack = PackData(
        id=str(int(time.time() * 1000)),
        name=name,
        mod_ids=[],
        created_at=now,
        updated_at=now,
    )
    packs.append(new_pack)
    save_packs(packs)
    return new_pack


def delete_pack(pack_id: str) -> bool:
    """Delete a pack by ID."""
    packs = get_packs()
    filtered = [p for p in packs if p.id != pack_id]
    if len(filtered) == len(packs):
        return False
    save_packs(filtered)
    return True


def rename_pack(pack_id: str, new_name: str) -> bool:
    """Rename a pack."""
    packs = get_packs()
    for p in packs:
        if p.id == pack_id:
            p.name = new_name
            p.updated_at = datetime.now().isoformat()
            save_packs(packs)
            return True
    return False


def add_mod_to_pack(pack_id: str, mod_id: str) -> bool:
    """Add a mod to a pack by mod_id (file path hash)."""
    packs = get_packs()
    for p in packs:
        if p.id == pack_id and mod_id not in p.mod_ids:
            p.mod_ids.append(mod_id)
            p.updated_at = datetime.now().isoformat()
            save_packs(packs)
            return True
    return False


def remove_mod_from_pack(pack_id: str, mod_id: str) -> bool:
    """Remove a mod from a pack."""
    packs = get_packs()
    for p in packs:
        if p.id == pack_id and mod_id in p.mod_ids:
            p.mod_ids = [m for m in p.mod_ids if m != mod_id]
            p.updated_at = datetime.now().isoformat()
            save_packs(packs)
            return True
    return False


def _normalize_mod_key(name: str) -> str:
    """mod 名归一化：与 mod_scanner._normalize_mod_key 保持一致。

    用于「删除 Mod 时清理整合包」等场景，避免因为历史写法差异
    （`mod-xxx.vpk` / 缺扩展名 / 大小写）漏掉整合包里的残留成员。
    """
    n = str(name or '').strip().replace('\\', '/')
    n = n.rsplit('/', 1)[-1]
    if n.lower().startswith('mod-'):
        n = n[4:]
    if n.lower().endswith('.vpk'):
        n = n[:-4]
    return n.lower()


def add_mods_to_pack(pack_id: str, mod_ids: list[str]) -> bool:
    """批量把多个 mod 加入整合包（只写一次盘）。

    逐条调用 add_mod_to_pack() 会为每个 mod 读写一遍 data.json，并且前端每加一个就
    重新拉取一次整合包列表，响应乱序时界面会停在「只加进去一部分」的中间状态。
    """
    if not mod_ids:
        return False
    with _file_lock:
        data = _read_data_raw()
        changed = False
        for p in data['packs']:
            if p.get('id') != pack_id:
                continue
            ids = list(p.get('mod_ids', []))
            for m in mod_ids:
                if m not in ids:
                    ids.append(m)
                    changed = True
            if changed:
                p['mod_ids'] = ids
                p['updated_at'] = datetime.now().isoformat()
            break
        if changed:
            _write_data_raw(data)
        return changed


def remove_mods_from_pack(pack_id: str, mod_ids: list[str]) -> bool:
    """批量把多个 mod 移出整合包（只写一次盘）。"""
    if not mod_ids:
        return False
    with _file_lock:
        data = _read_data_raw()
        changed = False
        for p in data['packs']:
            if p.get('id') != pack_id:
                continue
            ids = list(p.get('mod_ids', []))
            new_ids = [m for m in ids if m not in mod_ids]
            if len(new_ids) != len(ids):
                p['mod_ids'] = new_ids
                p['updated_at'] = datetime.now().isoformat()
                changed = True
            break
        if changed:
            _write_data_raw(data)
        return changed


def remove_mod_from_all_packs(mod_id: str) -> int:
    """把某个 mod 从所有整合包中移除（删除 Mod 后调用），返回受影响的整合包数。

    否则整合包里会残留已删除的文件名：包卡片上的数量虚高、详情页却一个都匹配不到，
    导出时还会报「文件缺失」。比较时用归一化名字，兼容历史写法差异。
    """
    target = _normalize_mod_key(mod_id)
    with _file_lock:
        data = _read_data_raw()
        affected = 0
        for p in data['packs']:
            ids = list(p.get('mod_ids', []))
            kept = [m for m in ids if _normalize_mod_key(m) != target]
            if len(kept) != len(ids):
                p['mod_ids'] = kept
                p['updated_at'] = datetime.now().isoformat()
                affected += 1
        if affected:
            _write_data_raw(data)
        return affected


# ===== Settings API =====

def get_setting(key: str, default=None):
    """Get a setting value."""
    with _file_lock:
        data = _read_data_raw()
        return data['settings'].get(key, default)


def set_setting(key: str, value):
    """Set a setting value."""
    with _file_lock:
        data = _read_data_raw()
        data['settings'][key] = value
        _write_data_raw(data)


def get_settings() -> AppSettings:
    """Get all settings.

    只取 AppSettings 里确实存在的字段：历史上 backend/test_import.py 会往 settings
    里写入 `test_key` 之类的键，而 `AppSettings(**settings)` 遇到未知键会直接抛
    TypeError（用户环境里 data.json 一旦被污染，这个函数就永远不可用）。
    """
    with _file_lock:
        data = _read_data_raw()
        raw = data.get('settings')
        raw = raw if isinstance(raw, dict) else {}
        known = {f.name for f in fields(AppSettings)}
        return AppSettings(**{k: v for k, v in raw.items() if k in known})


# ===== Scan Manifest API =====

def get_scan_manifest() -> ScanManifest:
    """Get the scan manifest for incremental scanning."""
    with _file_lock:
        data = _read_data_raw()
        return ScanManifest(**data.get('scan_manifest', {}))


def save_scan_manifest(manifest: ScanManifest):
    """Save scan manifest."""
    with _file_lock:
        data = _read_data_raw()
        data['scan_manifest'] = asdict(manifest)
        _write_data_raw(data)


# ===== addonlist.txt 指纹（双向同步用） =====

def get_addonlist_state() -> dict:
    """读取「软件最后一次写 addonlist.txt」时记录的指纹信息。

    返回 {} 表示还没有基线（例如老版本升级上来的用户、或还没写过文件）。
    """
    with _file_lock:
        data = _read_data_raw()
        state = data.get('addonlist_state')
        return dict(state) if isinstance(state, dict) else {}


def set_addonlist_state(fingerprint: str, path: Optional[str] = None):
    """记录 addonlist.txt 的内容指纹（软件写入文件后 / 采纳外部改动后调用）。"""
    with _file_lock:
        data = _read_data_raw()
        data['addonlist_state'] = {
            'fingerprint': fingerprint,
            'path': path,
            'updated_at': datetime.now().isoformat(),
        }
        _write_data_raw(data)


# ===== 「游戏退出后需要以软件设置为准重新写回」标记 =====

def _pending_mark_valid(state) -> bool:
    """标记是否存在且未过期（超过 24 小时视为过期，见 get_pending_game_reapply 的说明）。"""
    if not isinstance(state, dict) or not state.get('at'):
        return False
    try:
        at = datetime.fromisoformat(state['at'])
    except Exception:
        return False
    return (datetime.now() - at).total_seconds() < 24 * 3600


def get_pending_game_reapply() -> bool:
    """是否存在「游戏运行期间用户在软件里改过启停、需要以软件设置为准重新写回」的标记。

    标记带时间戳：超过 24 小时视为过期（例如用户改了设置就再没开过游戏，
    不能让它在下一次游戏退出时莫名其妙地吞掉游戏内的改动）。
    """
    with _file_lock:
        data = _read_data_raw()
        return _pending_mark_valid(data.get('pending_game_reapply'))


def set_pending_game_reapply(value: bool):
    """标记 / 清除「以软件设置为准重新写回 addonlist.txt」。"""
    with _file_lock:
        data = _read_data_raw()
        valid = _pending_mark_valid(data.get('pending_game_reapply'))
        # 已经是想要的状态就不写盘：游戏运行期间每次点启停都会走到这里，避免频繁写 data.json；
        # 过期的旧标记则会被下面的写入刷新成新时间戳（否则它会永远失效）。
        if value == valid:
            return
        data['pending_game_reapply'] = (
            {'at': datetime.now().isoformat(), 'reason': 'mod-state-changed-while-game-running'}
            if value else {}
        )
        _write_data_raw(data)


# ===== 「改动还没应用到游戏」标记（界面上的「应用」按钮据此点亮） =====

def get_prefs_dirty() -> bool:
    """软件里的启停设置是否有改动还没写回 addonlist.txt。"""
    with _file_lock:
        data = _read_data_raw()
        return bool(data.get('prefs_dirty'))


def set_prefs_dirty(value: bool):
    """置位 / 清除「有改动还没应用」标记（状态没变时不写盘）。"""
    with _file_lock:
        data = _read_data_raw()
        if bool(data.get('prefs_dirty')) == bool(value):
            return
        data['prefs_dirty'] = bool(value)
        _write_data_raw(data)


def get_addons_path() -> Optional[str]:
    """Get configured addons path from settings."""
    return get_setting('addons_path')


def set_addons_path(path: str):
    """Set addons path in settings."""
    set_setting('addons_path', path)
