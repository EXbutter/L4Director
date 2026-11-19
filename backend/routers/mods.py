"""Mod 域路由：列表 / 流式扫描、启停、标签与显示名、addonlist 双向同步、覆盖率看板。"""

import hashlib
import os
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

import app_state
from services.data_store import (
    add_custom_tag,
    get_custom_tags,
    get_mod_display_name,
    get_prefs_dirty,
    remove_custom_tag,
    set_mod_display_name,
    set_pending_game_reapply,
)
from services.game_process import (
    game_is_running_cached,
    mark_pending_reapply_if_game_running,
)
from services.mod_scanner import (
    invalidate_scan_cache,
    invalidate_sidecar_cache,
    is_builtin_tag,
)

router = APIRouter()

@router.get("/api/mods")
def list_mods():
    """获取所有 Mod 列表"""
    mods = app_state.scanner.scan_mods()
    return {
        "count": len(mods),
        "mods": [vars(m) for m in mods]
    }


@router.post("/api/mods/refresh-covers")
def refresh_covers():
    """清掉「同名封面图」的查找缓存。

    拖放导入时会把与 .vpk 同名的封面图片一起复制进 addons 目录。
    `_find_sidecar_thumbnail` 为了少 stat 几次带了 3 秒 TTL，导入后立刻
    重新扫描时会命中「之前没有封面」的旧结果，卡片要等一会儿才出图。
    导入成功后由渲染进程调用这个接口，下次扫描就能立刻识别新图片。
    """
    invalidate_sidecar_cache()
    return {"ok": True}


@router.get("/api/mods/stream")
def stream_mods():
    """流式返回 Mod 列表（NDJSON）：每解析完一个就推送一行，前端可边收边显示，
    冷启动/首次扫描时无需等待全部解析完成。"""
    import json as _json

    def gen():
        try:
            for evt in app_state.scanner.stream_mods():
                yield _json.dumps(evt, ensure_ascii=False, default=str) + "\n"
        except Exception as e:
            print(f"[Scan] Stream error: {e}")
            yield _json.dumps({"type": "error", "detail": str(e)}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# ── 游戏内启停改动的「询问式同步」 ───────────────────────────────────────
# 游戏退出时会把 Add-ons 菜单里的启停状态写回 addonlist.txt。软件用「内容指纹」
# 判断这个文件是否被自己以外的东西改过（详见 mod_scanner._collect_addonlist_changes），
# 但**不**自动采纳 —— 由界面弹窗询问用户「是否同步」，避免把 Steam 云同步回来的
# 旧配置悄悄盖掉用户在软件里的设置。


@router.get("/api/mods/addonlist-changes")
def get_addonlist_changes():
    """检测游戏内（或 Steam 云）改动过的 Mod 启停，返回待用户确认的变更列表。

    游戏里「附加内容 → 完成」会把游戏内的启停状态写入 addonlist.txt，
    这里照常检测、由用户决定「同步 / 忽略」。
    游戏退出时若软件里有更新过的设置，后端会先自动以软件设置为准写回文件
    （见 _reapply_prefs_after_game_exit），所以不会出现「拿游戏内存里的旧状态覆盖
    软件设置，还回头问用户」的情况。
    """
    changes = app_state.scanner.get_pending_addonlist_changes()
    return {"pending": len(changes) > 0, "count": len(changes), "changes": changes}


@router.post("/api/mods/apply-prefs")
def apply_mod_prefs_endpoint():
    """「应用到游戏」：把软件里记录的 Mod 启停状态写入 addonlist.txt。

    L4D2 会在这些时机重新读取该文件：
      * 启动时加载完创意工坊订阅之后；
      * 进入「附加内容（Add-ons）」菜单、以及在该菜单里点「完成」时。
    所以游戏**运行中**也能生效：点完这个按钮后，在游戏里进一次「附加内容」菜单即可；
    游戏没运行时，下次启动游戏就是最新状态。
    """
    if not app_state.scanner.get_addons_path():
        raise HTTPException(status_code=400, detail="请先配置 Addons 目录")

    count = app_state.scanner.apply_mod_prefs_to_addonlist()
    # count == 0 有两种可能：本来就没有需要写的条目，或者写失败了。
    # 后者必须报出来 —— 否则用户点完「应用」看到成功，进游戏发现设置没变。
    write_error = app_state.scanner.last_addonlist_error()
    if write_error and count == 0:
        raise HTTPException(
            status_code=500,
            detail=f"设置已保存在软件里，但写入 addonlist.txt 失败：{write_error}",
        )
    game_running = game_is_running_cached()
    if not game_running:
        # 游戏没在运行：文件就是最终状态，不需要再纠正
        set_pending_game_reapply(False)
    # 游戏运行中则**保留**标记：游戏内存里可能还持有旧状态，退出时会把旧状态写回文件，
    # 留着标记能让后端在游戏退出后再自动纠正一次（见 _reapply_prefs_after_game_exit）
    return {"status": "ok", "count": count, "game_running": game_running}


@router.post("/api/mods/addonlist-changes/apply")
def apply_addonlist_changes():
    """用户点「同步」：把游戏里的启停改动写进软件记录。"""
    count = app_state.scanner.apply_addonlist_changes()
    return {"status": "ok", "count": count}


@router.post("/api/mods/addonlist-changes/dismiss")
def dismiss_addonlist_changes():
    """用户点「忽略」：不动软件记录（启动游戏时仍以软件里的设置为准），不再重复提示。"""
    count = app_state.scanner.dismiss_addonlist_changes()
    return {"status": "ok", "count": count}


@router.post("/api/mods/{mod_name}/toggle")
def toggle_mod(mod_name: str, path: Optional[str] = None):
    """切换 Mod 启用/禁用状态。

    `path` 可选：addons 根目录与 workshop 下可能各有一份同名 vpk（同一个 Mod
    既订阅了工坊、又被手动拖进来）。只按文件名查找永远命中根目录那一份，
    传了路径才能精确作用到用户点的那一条。
    """
    from urllib.parse import unquote
    mod_name = unquote(mod_name)

    result = app_state.scanner.toggle_mod(mod_name, path_hint=unquote(path) if path else None)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"在 addons 目录里找不到「{mod_name}」对应的 vpk 文件（可能已被移动、改名或删除）",
        )
    # 游戏正在运行时改的启停只是「写进文件」，游戏内存里仍是旧状态，
    # 退出时会把旧状态写回、覆盖掉这次改动；标记一下，等游戏退出后自动重新应用。
    mark_pending_reapply_if_game_running()
    payload = vars(result)
    # addonlist.txt 没写成（只读 / 被占用）：卡片的勾选已经在软件里生效，
    # 但游戏读到的还是旧文件 —— 必须如实告诉界面，别让它显示成完全成功。
    write_error = app_state.scanner.last_addonlist_error()
    if write_error:
        payload['addonlist_write_error'] = write_error
    return payload


@router.post("/api/mods/addoninfo")
def add_addoninfo(data: dict):
    """给本地 Mod 的 VPK 补一份 addoninfo.txt（用户点卡片上的提示时调用）。

    没有这个文件的包不会被游戏列为「附加内容」，addonlist.txt 里写 "0" 也会被
    游戏改回 "1" —— 也就是软件里关掉、游戏里照样加载。补上之后才真正可控。
    注意：这会重写 vpk 文件（内部先写临时包、逐条目校验、最后原子替换）。
    """
    from urllib.parse import unquote
    name = unquote(str(data.get("name") or ""))
    path = data.get("path")
    if not name:
        raise HTTPException(status_code=400, detail="缺少 Mod 名称")
    try:
        return app_state.scanner.add_addoninfo(name, path_hint=unquote(path) if path else None)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        # 重建失败/拒绝改写（非 ASCII 路径、包已被占用等）：原文件没动过，如实告知
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/api/mods/{mod_name}")
def delete_mod(mod_name: str, path: Optional[str] = None):
    """删除 Mod 文件（`path` 用于在同名副本之间精确指定删哪一个）"""
    from urllib.parse import unquote
    mod_name = unquote(mod_name)

    success = app_state.scanner.delete_mod(mod_name, path_hint=unquote(path) if path else None)
    if not success:
        raise HTTPException(status_code=404, detail=f"Mod '{mod_name}' not found or could not be deleted")
    return {"status": "deleted", "mod_name": mod_name}


@router.post("/api/mods/{mod_name}/category")
def set_mod_category(mod_name: str, data: dict):
    """手动设置 Mod 的分类"""
    from urllib.parse import unquote
    mod_name = unquote(mod_name)
    
    category = data.get("category")  # can be None to clear override
    
    # Validate category if provided
    valid_categories = ['地图', '武器/道具', '角色模型', '材质/皮肤', '音效', '脚本/插件', 'UI/界面', '字体']
    if category and category not in valid_categories:
        raise HTTPException(status_code=400, detail=f"无效的分类: {category}，有效分类: {', '.join(valid_categories)}")
    
    result = app_state.scanner.set_mod_category(mod_name, category)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Mod '{mod_name}' not found")
    return {
        "status": "ok",
        "category": result.category,
        "mod": vars(result)
    }


# ===== 一键混搭 =====


@router.get("/api/mods/coverage-roster")
def get_coverage_roster():
    """「替换清单」的完整名册：生还者 8 / 特感 8 / 物品 4 / 武器 35。

    界面要画出「当前搭配覆盖了谁、还差谁」，就必须知道**全集** ——
    只靠 Mod 自己的 coverage 只能知道它替换了哪几个，缺的那几个名字
    只有这里能给出（清单定义在 tagger.COVERAGE_ROSTER，单一来源）。
    """
    from services import tagger

    return {
        "families": [
            {
                "key": fam,
                "total": len(tagger.COVERAGE_ROSTER[fam]),
                "names": list(tagger.COVERAGE_ROSTER[fam]),
            }
            for fam in tagger.COVERAGE_FAMILIES
        ]
    }


@router.post("/api/mods/mix/apply")
def apply_mod_mix(data: dict):
    """一键混搭：同一批里「这套启用、这些同类关掉」。

    和整合包批量启停同源（scanner.set_mods_states），区别只在于一批里
    允许两个方向 —— 混搭必然要同时干这两件事：选中的那套开，被顶下去的
    同类关。分两次调用也能实现，但会写两遍 addonlist.txt，中途失败就留下
    一个「一半开一半没关」的组合，那正是混搭最不该出现的状态。
    """
    if not app_state.scanner.get_addons_path():
        raise HTTPException(status_code=400, detail="请先配置 Addons 目录")

    states: dict[str, bool] = {}
    for name in (data.get("enable") or []):
        if isinstance(name, str) and name.strip():
            states[name.strip()] = True
    for name in (data.get("disable") or []):
        if isinstance(name, str) and name.strip():
            # 同一批里既启用又禁用时以「启用」为准（前端已经算过互斥，这里只是兜底）
            states.setdefault(name.strip(), False)

    if not states:
        raise HTTPException(status_code=400, detail="这套混搭里没有可应用的 Mod")

    result = app_state.scanner.set_mods_states(states)
    # 同整合包：游戏运行中的改动会被退出时写回的内存状态覆盖，标记一下
    mark_pending_reapply_if_game_running()
    return {
        "status": "ok",
        "changed": result.get("changed", 0),
        "missing": result.get("missing", []),
        "updated": result.get("updated", {}),
        # addonlist.txt 没写成：软件里已经是新状态，但游戏读到的还是旧文件
        "write_error": result.get("write_error"),
    }


# ===== Mod 显示名称 API =====


@router.post("/api/mods/{mod_name}/display-name")
def set_mod_display_name_api(mod_name: str, data: dict):
    """设置 Mod 显示名称"""
    from urllib.parse import unquote
    mod_name = unquote(mod_name)
    display_name = data.get("display_name")  # None to clear
    set_mod_display_name(mod_name, display_name)
    return {"status": "ok", "display_name": display_name}


@router.post("/api/mods/{mod_name}/tags")
def set_mod_tags_api(mod_name: str, data: dict):
    """设置 Mod 的分类标签（多标签）。

    body: ``{"tags": ["武器", "皮肤"]}``；传 ``{"tags": null}`` 表示恢复自动检测。
    """
    from urllib.parse import unquote
    mod_name = unquote(mod_name)

    raw = data.get("tags", None)
    if raw is None:
        tags = None
    elif isinstance(raw, list):
        tags = [str(t) for t in raw]
    else:
        raise HTTPException(status_code=400, detail="tags 必须是数组或 null")

    result = app_state.scanner.set_mod_tags(mod_name, tags)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Mod '{mod_name}' not found")
    mod = vars(result)
    # 标签影响了分类筛选，让前端的分类统计也跟着刷新
    mod['_scan_invalidated'] = True
    return {"status": "ok", "tags": result.tags, "manual": result.tags_manual, "mod": mod}


# ===== 自定义标签 API =====
# 用户自己起的标签（「最爱」「待测试」「某某作者合集」…），和内置分类共用同一套
# 「给 Mod 打标签」的接口（POST /api/mods/{name}/tags），只是标签名先要在池子里注册。


def _validate_custom_tag_name(raw) -> str:
    """校验用户输入的标签名，返回去掉首尾空白后的结果。"""
    name = str(raw if raw is not None else "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="标签名不能为空")
    # 标签会画在卡片上的小圆角块里，太长会把整行标签挤没；16 字够写清楚一个归类了
    if len(name) > 16:
        raise HTTPException(status_code=400, detail="标签名最多 16 个字符")
    if any(ch in name for ch in "\r\n\t"):
        raise HTTPException(status_code=400, detail="标签名不能包含换行或制表符")
    # 「ID: xxx」是创意工坊编号的专用前缀，客户端靠它识别来源
    if name.startswith("ID: "):
        raise HTTPException(status_code=400, detail="「ID: 」是创意工坊编号专用前缀，请换个名字")
    if name in ("外部 Mod", "创意工坊 Mod"):
        raise HTTPException(status_code=400, detail=f"「{name}」是来源标签，请换个名字")
    if is_builtin_tag(name):
        raise HTTPException(status_code=409, detail=f"「{name}」是内置标签，换一个名字吧")
    return name


@router.get("/api/custom-tags")
def list_custom_tags_api():
    """自定义标签池（按用户创建顺序）。"""
    return {"tags": get_custom_tags()}


@router.post("/api/custom-tags")
def create_custom_tag_api(data: dict):
    """新建一个自定义标签。已存在时幂等返回（不报错，方便前端「输入完直接打勾」）。"""
    name = _validate_custom_tag_name(data.get("name"))
    return {"status": "ok", "name": name, "tags": add_custom_tag(name)}


@router.delete("/api/custom-tags/{name}")
def delete_custom_tag_api(name: str):
    """删除标签定义，并把它从所有 Mod 身上摘掉。

    只删得掉**自定义**标签：内置的大类/细分/收藏标签不在池子里，
    也不该被一个删除请求顺手抹掉（data_store 那边同样做了兜底）。
    """
    from urllib.parse import unquote
    name = unquote(name).strip()
    if not name:
        raise HTTPException(status_code=400, detail="标签名不能为空")
    if is_builtin_tag(name) or name in ("外部 Mod", "创意工坊 Mod"):
        raise HTTPException(status_code=400, detail=f"「{name}」是内置标签，不能删除")
    tags, touched = remove_custom_tag(name)
    if touched:
        # 有 Mod 的标签变了 → 作废扫描缓存，否则刷新后卡片上还挂着这个标签
        invalidate_scan_cache()
    return {"status": "ok", "tags": tags, "updated_mods": touched}


@router.get("/api/mods/apply-state")
def get_apply_state():
    """「应用」按钮的状态：是否有改动还没写回 addonlist.txt + 游戏是否在运行。"""
    return {
        "dirty": get_prefs_dirty(),
        "game_running": game_is_running_cached(),
    }


@router.get("/api/mods/{mod_name}/display-name")
def get_mod_display_name_api(mod_name: str):
    """获取 Mod 显示名称"""
    from urllib.parse import unquote
    mod_name = unquote(mod_name)
    display_name = get_mod_display_name(mod_name)
    return {"display_name": display_name}


# ===== 增量扫描 API =====


@router.get("/api/mods/delta")
def list_mods_delta(since: Optional[str] = None):
    """增量获取 Mod 列表 — 只返回变化的 Mod
    
    支持参数：
    - since: ISO 时间戳，只返回该时间后变化的 Mod
    """
    mods = app_state.scanner.scan_mods()
    
    if since:
        try:
            from datetime import datetime
            since_dt = datetime.fromisoformat(since)
            
            # Filter: only mods that have changed since the timestamp
            changed = []
            for m in mods:
                if m.last_modified:
                    try:
                        mod_dt = datetime.fromisoformat(m.last_modified)
                        if mod_dt > since_dt:
                            changed.append(m)
                    except:
                        changed.append(m)
            
            return {
                "delta": True,
                "since": since,
                "count": len(changed),
                "mods": [vars(m) for m in changed],
                "total_count": len(mods),
            }
        except ValueError:
            # Invalid since format, return all
            pass
    
    return {
        "delta": False,
        "count": len(mods),
        "mods": [vars(m) for m in mods]
    }


_SCAN_STATUS_FAST_TTL = 60.0
_scan_status_sig = {'sig': None, 'at': 0.0}
_scan_status_lock = threading.Lock()


def _addons_signature(addons_dir: Path):
    """addons 目录的轻量指纹：(目录 mtime, 顶层 vpk 数, 顶层最大 mtime, 顶层总字节,
    workshop mtime, workshop vpk 数, workshop 最大 mtime, workshop 总字节)。

    用途是**快速负判定**：前端每 5 秒轮询一次 scan-status，而完整比对要 glob 三次
    再给每个 VPK 单独 stat。1000 个包的机器上那是持续的抖动。

    为什么不能只看目录 mtime：目录 mtime 只在「增删条目」时变，**原地改写文件内容
    不会**（下载器覆盖、手动替换同名文件都可能发生在同一秒内）。所以指纹里必须带
    上文件本身的 mtime 与大小，否则会出现「文件确实变了但 scan-status 说没变」。
    Windows 上 os.scandir 返回的 entry 自带 stat 信息，取它不会多一次系统调用。
    """
    def _walk(dir_path: Path, collect_top_vpk: bool):
        """返回 (vpk 数, 最大 mtime, 总字节, [子目录路径])。"""
        count = 0
        newest = 0.0
        total = 0
        subdirs: list[Path] = []
        try:
            with os.scandir(dir_path) as it:
                for entry in it:
                    try:
                        st = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    total += st.st_size
                    newest = max(newest, st.st_mtime)
                    if entry.name.lower().endswith('.vpk'):
                        if collect_top_vpk or entry.is_file(follow_symlinks=False):
                            count += 1
                    elif collect_top_vpk and entry.is_dir(follow_symlinks=False):
                        subdirs.append(Path(entry.path))
        except OSError:
            return None
        return count, newest, total, subdirs

    try:
        dir_stat = addons_dir.stat()
    except OSError:
        return None

    root = _walk(addons_dir, collect_top_vpk=True)
    if root is None:
        return None
    root_count, root_newest, root_total, subdirs = root

    ws_mtime = None
    ws_count = 0
    ws_newest = 0.0
    ws_total = 0
    for sub in subdirs:
        if sub.name.lower() != 'workshop':
            continue
        try:
            ws_mtime = sub.stat().st_mtime
        except OSError:
            continue
        # workshop 下两种落法：workshop/*.vpk 与 workshop/<id>/*.vpk
        ws_root = _walk(sub, collect_top_vpk=True)
        if ws_root:
            ws_count += ws_root[0]
            ws_newest = max(ws_newest, ws_root[1])
            ws_total += ws_root[2]
            for inner in ws_root[3]:
                got = _walk(inner, collect_top_vpk=False)
                if got:
                    ws_count += got[0]
                    ws_newest = max(ws_newest, got[1])
                    ws_total += got[2]

    return (
        dir_stat.st_mtime, root_count, root_newest, root_total,
        ws_mtime, ws_count, ws_newest, ws_total,
    )


def _remember_scan_signature(sig):
    with _scan_status_lock:
        _scan_status_sig['sig'] = sig
        _scan_status_sig['at'] = time.time()


@router.get("/api/mods/scan-status")
def scan_status():
    """获取扫描状态 — 检查 Mod 文件是否有变更，不用返回全部 Mod。

    这是「软件之外发生的改动」的探测器：前端每隔几秒轮询一次，命中 changed 就
    静默刷新列表，于是「在 Steam 里取消订阅（vpk 被删）」「新订阅的 Mod 下载完成」
    「手动往 addons 里丢 / 删文件」都会自动反映到界面上 —— 不再需要用户手动刷新，
    也不会出现「已经取消订阅，卡片还留在界面上」。

    对比的基线是 data.json 里的 scan_manifest（由 mod_scanner 每次扫描后写入，
    键是相对 addons 目录的 posix 路径，值是 mtime）。
    """
    addons_path = app_state.scanner.get_addons_path()
    if not addons_path:
        return {"changed": False, "reason": "not_configured"}

    addons_dir = Path(addons_path)
    if not addons_dir.is_dir():
        # 路径还在配置里，但目录没了（盘没挂上 / 被删 / 改名）。
        # 以前会一路走到"文件全被删光"的比对结果，把界面刷成空列表。
        return {"changed": False, "reason": "addons_missing"}

    from services.data_store import get_scan_manifest
    manifest = get_scan_manifest()
    # 只有"从没扫过"才需要报 changed 逼前端扫一次。
    # 扫过、但目录确实是空的（last_scan 有值且 files 为空）是正常状态，
    # 不能每次都回 changed —— 那会让前端的静默刷新永久空转。
    if not manifest.files and not manifest.last_scan:
        return {"changed": True, "reason": "no_previous_scan"}

    signature = _addons_signature(addons_dir)
    with _scan_status_lock:
        cached_sig = _scan_status_sig['sig']
        cached_at = _scan_status_sig['at']
    if (signature is not None and signature == cached_sig
            and (time.time() - cached_at) < _SCAN_STATUS_FAST_TTL):
        return {"changed": False, "reason": "no_changes"}

    current_files = {}
    
    # Collect all VPK files with their mtimes（键的写法必须与 scan_manifest 完全一致：
    # 根目录用 `name.vpk`，workshop 用 `workshop/...` 的 posix 写法）
    for vpk in addons_dir.glob('*.vpk'):
        try:
            s = vpk.stat()
            current_files[vpk.relative_to(addons_dir).as_posix()] = s.st_mtime
        except:
            pass
    
    workshop_dir = addons_dir / 'workshop'
    if workshop_dir.exists():
        for vpk in workshop_dir.glob('*.vpk'):
            try:
                s = vpk.stat()
                current_files[f"workshop/{vpk.name}"] = s.st_mtime
            except:
                pass
        for item in workshop_dir.iterdir():
            if item.is_dir():
                for vpk in item.glob('*.vpk'):
                    try:
                        s = vpk.stat()
                        current_files[f"workshop/{item.name}/{vpk.name}"] = s.st_mtime
                    except:
                        pass
    
    # Compare with manifest
    old_files = manifest.files
    if current_files == old_files:
        _remember_scan_signature(signature)
        return {"changed": False, "reason": "no_changes"}

    # Compute differences
    added = [k for k in current_files if k not in old_files]
    removed = [k for k in old_files if k not in current_files]
    modified = [k for k in current_files if k in old_files and current_files[k] != old_files[k]]

    _remember_scan_signature(signature)
    return {
        "changed": True,
        "reason": "files_changed",
        "added": added,
        "removed": removed,
        "modified": modified,
    }


@router.post("/api/mods/addonlist/fill")
def fill_addonlist_endpoint():
    """一键补全 addonlist.txt：把本地所有 mod 补进去（只补缺失条目）。

    场景：刚拖进 addons 或刚订阅的包，addonlist.txt 里还没有它 ——
    游戏的「附加内容」列表里看不到，某些机器上还会被当成没装。
    已有的条目一律不动（启停状态、编码写法都保持原样）。
    """
    result = app_state.scanner.fill_addonlist()
    if result.get('ok'):
        # 补进去的都是启用状态 → 让下一次扫描重新读一遍
        invalidate_scan_cache()
    return result
