"""L4D2 Mod Manager - Backend API"""
import os
import sys

# 确保 backend 目录在 sys.path 中（嵌入式 Python 默认不会添加当前目录）
_backend_dir = os.path.dirname(os.path.abspath(__file__))
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)
    print(f"[Startup] Added backend dir to sys.path: {_backend_dir}")

# Fix Unicode encoding for Windows console (GBK can't handle emoji/special chars)
# 注意是 GB18030（不是 GB18032）：GB18030 是 Windows 中文环境的完整字符集，
# 之前写错的这个名字永远匹配不上，等于这段兜底从来没生效过。
if sys.stdout.encoding and sys.stdout.encoding.upper() in ('GBK', 'GB2312', 'GB18030'):
    sys.stdout.reconfigure(errors='replace')  # type: ignore
if sys.stderr.encoding and sys.stderr.encoding.upper() in ('GBK', 'GB2312', 'GB18030'):
    sys.stderr.reconfigure(errors='replace')  # type: ignore
import argparse
import hashlib
import re
import threading
import time
import urllib.request
import urllib.parse
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
import io
import base64
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, FileResponse, StreamingResponse
from services.mod_scanner import (
    ModScanner, _CACHE_DIR, get_last_scan_perf, invalidate_sidecar_cache,
    cache_stats, cache_gc,
    is_builtin_tag, invalidate_scan_cache,
)
from services.data_store import (
    get_packs, add_pack, delete_pack, rename_pack,
    add_mod_to_pack, remove_mod_from_pack,
    add_mods_to_pack, remove_mods_from_pack,
    get_mod_display_name, set_mod_display_name,
    get_scan_manifest,
    get_pending_game_reapply, set_pending_game_reapply,
    get_prefs_dirty, set_prefs_dirty,
    get_last_recovery,
    get_custom_tags, add_custom_tag, remove_custom_tag,
)
from services.workshop_downloader import (
    get_manager as get_download_manager,
    default_outdir as download_default_outdir,
    outdir_hint as download_outdir_hint,
    fetch_bytes as download_fetch_bytes,
)

@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    """应用启动钩子（lifespan）：跑一次启动期校正逻辑。

    放在 lifespan 里而不是模块顶层，是为了保证「服务真正开始接收请求之前」完成，
    同时避免依赖已废弃的 @app.on_event。

    当前只做一件事：校正上一次会话遗留的「有改动还没应用」标记（见下方函数说明）。
    """
    _reconcile_prefs_dirty_flag()
    # 自动检查工坊更新：开关打开且距上次检查超过设定间隔时，延后几秒在后台跑
    # （让首次 Mod 扫描先用上磁盘，别和 VPK 解析抢资源）。
    try:
        from services.workshop_updates import get_service as _get_wsu
        _get_wsu().maybe_auto_check(scanner.get_addons_path() or "")
    except Exception as _e:
        print(f"[WsUpdate] auto check not started: {_e}")
    yield


# 版本号统一由 Electron 主进程通过 L4DIRECTOR_APP_VERSION 传入。
# 这里的默认值只在「直接 python main.py 跑后端」时用到，但必须是**唯一一份** ——
# 以前 FastAPI 与 /api/health 各写一个默认值（1.1.0 / 1.2.0），两边长期不一致，
# 排查线上问题时没法确认对面到底是哪个版本。
_DEFAULT_APP_VERSION = "1.3.4"
APP_VERSION = os.environ.get("L4DIRECTOR_APP_VERSION", _DEFAULT_APP_VERSION)


app = FastAPI(
    title="L4D2 Mod Manager API",
    version=APP_VERSION,
    description="Left 4 Dead 2 Mod Manager Backend",
    lifespan=_app_lifespan,
)

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global scanner instance
scanner = ModScanner()


def _reconcile_prefs_dirty_flag():
    """启动时校正上一次会话遗留的「有改动还没应用」标记。

    prefs_dirty 会持久化在 data.json：用户「改了 Mod 启停 → 没点『应用』就退出」后，
    下次启动左下角的「应用」按钮会一直是亮着的，看起来像是软件一启动就有未应用的改动。
    而实际上 toggle 早已把状态写进了 addonlist.txt，属于假提醒。

    这里按 addonlist.txt 的**实际内容**核对一次：已经一致就熄灯。
    游戏正在运行时保留标记（文件写了但游戏还没重读，确实需要提醒用户）。
    """
    try:
        if not get_prefs_dirty():
            return
        if _game_is_running_cached():
            return
        if scanner.prefs_in_sync_with_addonlist():
            set_prefs_dirty(False)
            print("[Prefs] Cleared stale 'unapplied' flag: addonlist.txt already in sync")
    except Exception as e:
        print(f"[Prefs] Startup reconcile skipped: {e}")


# In-memory store for Steam auth state
_steam_auth_state: dict = {
    "authenticated": False,
    "user": None,
}

# ── Steam 联网信息的缓存 ──────────────────────────────────────────────
# steamcommunity / steamstatic 在很多网络环境（含国内）根本无法访问，
# 每次启动都会把请求卡满超时。这里统一：
#   * 超时压到 3 秒；
#   * 成功结果缓存 10 分钟、失败结果缓存 60 秒（避免每个 <img> / 每次启动都重试）；
#   * 所有端点都跑在线程池（见各路由的 def），因此即使仍然超时也不会阻塞其它接口。
_STEAM_NET_TIMEOUT = 3.0
_STEAM_CACHE_TTL = 600.0
_STEAM_FAIL_TTL = 60.0
_steam_cache_lock = threading.Lock()
# steam_id -> (时间戳, 头像地址)；头像地址为空表示上次失败
_steam_profile_cache: dict[str, tuple[float, str]] = {}
# 头像 URL -> (时间戳, 图片字节, content_type)；字节为空表示上次失败
_steam_avatar_cache: dict[str, tuple[float, bytes, str]] = {}


@app.get("/api/health")
def health_check():
    """健康检查接口"""
    return {"status": "ok", "version": APP_VERSION}


@app.get("/api/status")
def get_status():
    """获取管理器状态"""
    mods = scanner.scan_mods()
    addons_path = scanner.get_addons_path()
    return {
        "game_detected": addons_path is not None,
        "mod_count": len(mods),
        "workshop_count": len([m for m in mods if m.is_workshop]),
        "game_path": addons_path,
        "addons_configured": addons_path is not None,
        # 最近一次扫描的性能数据（耗时/吞吐线索），便于前端展示与排障
        "last_scan_perf": get_last_scan_perf(),
        # 配置文件曾经损坏、已被隔离留档时带上记录，界面据此提示用户去备份里找回
        "data_recovery": get_last_recovery(),
    }


@app.get("/api/mods")
def list_mods():
    """获取所有 Mod 列表"""
    mods = scanner.scan_mods()
    return {
        "count": len(mods),
        "mods": [vars(m) for m in mods]
    }


@app.post("/api/mods/refresh-covers")
def refresh_covers():
    """清掉「同名封面图」的查找缓存。

    拖放导入时会把与 .vpk 同名的封面图片一起复制进 addons 目录。
    `_find_sidecar_thumbnail` 为了少 stat 几次带了 3 秒 TTL，导入后立刻
    重新扫描时会命中「之前没有封面」的旧结果，卡片要等一会儿才出图。
    导入成功后由渲染进程调用这个接口，下次扫描就能立刻识别新图片。
    """
    invalidate_sidecar_cache()
    return {"ok": True}


@app.get("/api/mods/stream")
def stream_mods():
    """流式返回 Mod 列表（NDJSON）：每解析完一个就推送一行，前端可边收边显示，
    冷启动/首次扫描时无需等待全部解析完成。"""
    import json as _json

    def gen():
        try:
            for evt in scanner.stream_mods():
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
@app.get("/api/mods/addonlist-changes")
def get_addonlist_changes():
    """检测游戏内（或 Steam 云）改动过的 Mod 启停，返回待用户确认的变更列表。

    游戏里「附加内容 → 完成」会把游戏内的启停状态写入 addonlist.txt，
    这里照常检测、由用户决定「同步 / 忽略」。
    游戏退出时若软件里有更新过的设置，后端会先自动以软件设置为准写回文件
    （见 _reapply_prefs_after_game_exit），所以不会出现「拿游戏内存里的旧状态覆盖
    软件设置，还回头问用户」的情况。
    """
    changes = scanner.get_pending_addonlist_changes()
    return {"pending": len(changes) > 0, "count": len(changes), "changes": changes}


@app.post("/api/mods/apply-prefs")
def apply_mod_prefs_endpoint():
    """「应用到游戏」：把软件里记录的 Mod 启停状态写入 addonlist.txt。

    L4D2 会在这些时机重新读取该文件：
      * 启动时加载完创意工坊订阅之后；
      * 进入「附加内容（Add-ons）」菜单、以及在该菜单里点「完成」时。
    所以游戏**运行中**也能生效：点完这个按钮后，在游戏里进一次「附加内容」菜单即可；
    游戏没运行时，下次启动游戏就是最新状态。
    """
    if not scanner.get_addons_path():
        raise HTTPException(status_code=400, detail="请先配置 Addons 目录")

    count = scanner.apply_mod_prefs_to_addonlist()
    # count == 0 有两种可能：本来就没有需要写的条目，或者写失败了。
    # 后者必须报出来 —— 否则用户点完「应用」看到成功，进游戏发现设置没变。
    write_error = scanner.last_addonlist_error()
    if write_error and count == 0:
        raise HTTPException(
            status_code=500,
            detail=f"设置已保存在软件里，但写入 addonlist.txt 失败：{write_error}",
        )
    game_running = _game_is_running_cached()
    if not game_running:
        # 游戏没在运行：文件就是最终状态，不需要再纠正
        set_pending_game_reapply(False)
    # 游戏运行中则**保留**标记：游戏内存里可能还持有旧状态，退出时会把旧状态写回文件，
    # 留着标记能让后端在游戏退出后再自动纠正一次（见 _reapply_prefs_after_game_exit）
    return {"status": "ok", "count": count, "game_running": game_running}


@app.post("/api/mods/addonlist-changes/apply")
def apply_addonlist_changes():
    """用户点「同步」：把游戏里的启停改动写进软件记录。"""
    count = scanner.apply_addonlist_changes()
    return {"status": "ok", "count": count}


@app.post("/api/mods/addonlist-changes/dismiss")
def dismiss_addonlist_changes():
    """用户点「忽略」：不动软件记录（启动游戏时仍以软件里的设置为准），不再重复提示。"""
    count = scanner.dismiss_addonlist_changes()
    return {"status": "ok", "count": count}


@app.post("/api/mods/{mod_name}/toggle")
def toggle_mod(mod_name: str, path: Optional[str] = None):
    """切换 Mod 启用/禁用状态。

    `path` 可选：addons 根目录与 workshop 下可能各有一份同名 vpk（同一个 Mod
    既订阅了工坊、又被手动拖进来）。只按文件名查找永远命中根目录那一份，
    传了路径才能精确作用到用户点的那一条。
    """
    from urllib.parse import unquote
    mod_name = unquote(mod_name)

    result = scanner.toggle_mod(mod_name, path_hint=unquote(path) if path else None)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"在 addons 目录里找不到「{mod_name}」对应的 vpk 文件（可能已被移动、改名或删除）",
        )
    # 游戏正在运行时改的启停只是「写进文件」，游戏内存里仍是旧状态，
    # 退出时会把旧状态写回、覆盖掉这次改动；标记一下，等游戏退出后自动重新应用。
    _mark_pending_reapply_if_game_running()
    payload = vars(result)
    # addonlist.txt 没写成（只读 / 被占用）：卡片的勾选已经在软件里生效，
    # 但游戏读到的还是旧文件 —— 必须如实告诉界面，别让它显示成完全成功。
    write_error = scanner.last_addonlist_error()
    if write_error:
        payload['addonlist_write_error'] = write_error
    return payload


@app.post("/api/mods/addoninfo")
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
        return scanner.add_addoninfo(name, path_hint=unquote(path) if path else None)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        # 重建失败/拒绝改写（非 ASCII 路径、包已被占用等）：原文件没动过，如实告知
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/mods/{mod_name}")
def delete_mod(mod_name: str, path: Optional[str] = None):
    """删除 Mod 文件（`path` 用于在同名副本之间精确指定删哪一个）"""
    from urllib.parse import unquote
    mod_name = unquote(mod_name)

    success = scanner.delete_mod(mod_name, path_hint=unquote(path) if path else None)
    if not success:
        raise HTTPException(status_code=404, detail=f"Mod '{mod_name}' not found or could not be deleted")
    return {"status": "deleted", "mod_name": mod_name}


@app.post("/api/mods/{mod_name}/category")
def set_mod_category(mod_name: str, data: dict):
    """手动设置 Mod 的分类"""
    from urllib.parse import unquote
    mod_name = unquote(mod_name)
    
    category = data.get("category")  # can be None to clear override
    
    # Validate category if provided
    valid_categories = ['地图', '武器/道具', '角色模型', '材质/皮肤', '音效', '脚本/插件', 'UI/界面', '字体']
    if category and category not in valid_categories:
        raise HTTPException(status_code=400, detail=f"无效的分类: {category}，有效分类: {', '.join(valid_categories)}")
    
    result = scanner.set_mod_category(mod_name, category)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Mod '{mod_name}' not found")
    return {
        "status": "ok",
        "category": result.category,
        "mod": vars(result)
    }


@app.get("/api/settings")
def get_settings():
    """获取当前设置"""
    return {
        "addons_path": scanner.get_addons_path(),
    }


@app.get("/api/cache/stats")
def get_cache_stats():
    """本地缓存体积（封面 / 索引 / 元数据 / 清单），供设置页显示。"""
    return cache_stats()


@app.post("/api/cache/gc")
def run_cache_gc():
    """清理孤儿缓存：只删「对应 VPK 已经不存在」的那些文件。

    不传任何参数 —— addons 路径从当前配置取，枚举不到 VPK 时后端会拒绝执行，
    不会出现「路径填错一次，缓存被清空」的情况。
    清理后前端会重新拉一次 Mod 列表，避免界面上留着已经被删掉的封面名。
    """
    result = cache_gc(scanner.get_addons_path())
    if result.get('ok'):
        print(f"[Cache] GC removed {result['removed_files']} files, "
              f"freed {result['freed_bytes']} bytes")
    else:
        print(f"[Cache] GC skipped: {result.get('reason')}")
    return result


def _count_vpks(addons_dir: Path) -> int:
    """数一下目录里有多少个 VPK（含 workshop 两层）。用来说明「这个目录到底对不对」。"""
    total = 0
    try:
        total += sum(1 for _ in addons_dir.glob('*.vpk'))
        ws = addons_dir / 'workshop'
        if ws.is_dir():
            total += sum(1 for _ in ws.rglob('*.vpk'))
    except OSError:
        pass
    return total


@app.post("/api/settings/addons-path")
def set_addons_path(data: dict):
    """设置 addons 路径"""
    path = data.get("path", "")
    
    if not path:
        raise HTTPException(status_code=400, detail="Path is required")
    
    normalized_path = os.path.normpath(path.strip())
    print(f"[SetPath] Original: '{path}' -> Normalized: '{normalized_path}'")
    print(f"[SetPath] Exists: {os.path.exists(normalized_path)}")
    print(f"[SetPath] Is dir: {os.path.isdir(normalized_path)}")
    
    success = scanner.set_addons_path(normalized_path)
    if not success:
        raise HTTPException(status_code=400, detail=f"Invalid path: {normalized_path}")

    # 首次配置路径时补一次工坊更新检查：启动时的自动检查因为当时还没有路径而跳过了
    try:
        _wsu().maybe_auto_check(normalized_path)
    except Exception as _e:
        print(f"[WsUpdate] auto check after path set failed: {_e}")

    # 带回 VPK 数量：路径合法但一个包都没有时（选错层级、选了空目录），
    # 界面要能说「已保存，但这个目录里没有 Mod」，而不是干巴巴的「已保存 ✓」。
    return {
        "status": "ok",
        "addons_path": normalized_path,
        "vpk_count": _count_vpks(Path(normalized_path)),
    }


@app.post("/api/settings/auto-detect")
def auto_detect_path():
    """自动检测 addons 路径"""
    path = scanner.auto_detect_addons_path()
    if path:
        return {"status": "ok", "addons_path": path, "vpk_count": _count_vpks(Path(path))}
    raise HTTPException(
        status_code=404,
        detail="没找到《求生之路 2》的 addons 目录，请在下面手动选择一次",
    )


# ── 游戏进程检测 ──────────────────────────────────────────────────────
# 「启动游戏」按钮需要知道游戏是否真的跑起来了（正在启动 → 游戏中）。
# 这里用 tasklist 查询 left4dead2.exe；结果缓存 2 秒，避免前端轮询时反复拉起子进程。
_GAME_PROCESS_NAME = "left4dead2.exe"
_GAME_STATUS_CACHE_TTL = 2.0
_game_status_cache: dict = {"time": 0.0, "running": False, "pid": None}
_game_status_lock = threading.Lock()
# 只用于「同一时刻只有一个线程在拉 tasklist」，不保护状态；
# 状态由 _game_status_lock 保护（两者顺序固定：先 probe 后 status，不会互等）。
_game_probe_lock = threading.Lock()


def _detect_game_process() -> tuple[bool, Optional[int]]:
    """检测 L4D2 进程是否在运行，返回 (是否运行, PID)。

    注意：tasklist 的输出会随系统语言变化（中文系统是「信息: 没有运行的任务匹配指定标准」），
    所以这里只判断输出里有没有出现进程名（纯 ASCII，不受代码页影响），而不是去匹配提示语。
    """
    import subprocess

    try:
        if os.name == "nt":
            completed = subprocess.run(
                ["tasklist", "/FI", f"IMAGENAME eq {_GAME_PROCESS_NAME}", "/FO", "CSV", "/NH"],
                capture_output=True,
                timeout=6,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            out = (completed.stdout or b"").decode("utf-8", errors="replace")
            if _GAME_PROCESS_NAME.lower() not in out.lower():
                return False, None
            # CSV 行形如："left4dead2.exe","1234","Console","1","1,234 K"
            line = next(
                (l for l in out.splitlines() if _GAME_PROCESS_NAME.lower() in l.lower()),
                "",
            )
            cells = [c.strip().strip('"') for c in line.strip().split('","')]
            pid = int(cells[1]) if len(cells) > 1 and cells[1].isdigit() else None
            return True, pid

        # 非 Windows 兜底（本项目主要面向 Windows，这里只是让接口不至于报错）
        completed = subprocess.run(
            ["pgrep", "-f", _GAME_PROCESS_NAME],
            capture_output=True,
            timeout=6,
        )
        out = (completed.stdout or b"").decode("utf-8", errors="replace").strip()
        if not out:
            return False, None
        first = out.splitlines()[0].strip()
        return True, int(first) if first.isdigit() else None
    except Exception as e:
        # 检测失败时按「未运行」处理，不要抛错卡住前端轮询
        print(f"[GameStatus] Failed to detect process: {e}")
        return False, None


@app.get("/api/game/status")
def get_game_status():
    """查询 L4D2 是否正在运行（供启动按钮展示「正在启动 / 游戏中」状态）。

    同时承担「游戏退出后把软件设置重新写回 addonlist.txt」的职责：
    游戏退出时会用**它内存里**的启停状态覆盖该文件，把用户运行期间在软件里
    刚做的改动顶掉（用户反馈：全部禁用后仍有 33 个 Mod 是启用、刷新还弹
    「检测到游戏内已启用」）。只要运行期间改过，就在进程消失的这一刻纠正回来。
    """
    now = time.time()
    reapplied: Optional[int] = None
    with _game_status_lock:
        cached = now - _game_status_cache["time"] < _GAME_STATUS_CACHE_TTL
    if not cached:
        # ⚠️ 子进程调用与写盘都在锁外做。
        # 以前整段（tasklist 最长 6 秒 + 重写 addonlist.txt + 写 data.json）都握着
        # _game_status_lock，而每次 Mod 启停都会走 _game_is_running_cached ——
        # 表现就是「点开关要愣好几秒」。现在锁只保护那几行内存赋值。
        # _game_probe_lock 只负责「同一时刻只有一个线程在拉 tasklist」，不阻塞读缓存。
        with _game_probe_lock:
            with _game_status_lock:
                still_fresh = time.time() - _game_status_cache["time"] < _GAME_STATUS_CACHE_TTL
            if not still_fresh:
                running, pid = _detect_game_process()
                if not running:
                    # 游戏不在运行：只要还留着「运行期间改过设置」的标记就纠正一次。
                    # 这样既覆盖「游戏退出时软件正开着」的情况，也覆盖「软件没开着、
                    # 游戏退出把旧状态写回了文件」的情况（标记会保留到下次启动软件）。
                    reapplied = _reapply_prefs_after_game_exit()
                with _game_status_lock:
                    _game_status_cache.update({"time": time.time(), "running": running, "pid": pid})
    with _game_status_lock:
        snapshot = dict(_game_status_cache)
    response = {
        "running": snapshot["running"],
        "pid": snapshot["pid"],
        "process": _GAME_PROCESS_NAME,
        "checked_at": snapshot["time"],
    }
    if reapplied is not None:
        # 仅在「刚检测到游戏退出并做了纠正」的那一次响应里带上，供界面提示
        response["reapplied"] = reapplied
    # 游戏运行期间用户在软件里改过启停（标记尚未被消费）→ 界面据此提示
    # 「改动会在退出游戏后自动应用」。
    # 这是引擎的物理限制：L4D2 启动时就把 Add-ons 列表读进了内存，运行期间改
    # addonlist.txt 不会影响它，游戏还会把自己内存里的状态写回文件（覆盖软件设置）。
    response["pending_reapply"] = get_pending_game_reapply()
    return response


def _game_is_running_cached() -> bool:
    """游戏是否在运行（复用上面的 2 秒缓存，避免每次启停都额外拉一次 tasklist）。

    缓存命中时只碰一次内存，不持锁做子进程调用 —— 这条会被每一次 Mod 启停调到。
    """
    with _game_status_lock:
        if time.time() - _game_status_cache["time"] < _GAME_STATUS_CACHE_TTL:
            return bool(_game_status_cache["running"])
    with _game_probe_lock:
        with _game_status_lock:
            if time.time() - _game_status_cache["time"] < _GAME_STATUS_CACHE_TTL:
                return bool(_game_status_cache["running"])
        running, pid = _detect_game_process()
        with _game_status_lock:
            _game_status_cache.update({"time": time.time(), "running": running, "pid": pid})
        return running


def _mark_pending_reapply_if_game_running():
    """游戏运行期间改启停 → 打个标记，游戏退出后以软件设置为准重新写回文件。"""
    try:
        if _game_is_running_cached():
            set_pending_game_reapply(True)
    except Exception as e:
        print(f"[GameStatus] Failed to mark pending reapply: {e}")


def _reapply_prefs_after_game_exit() -> Optional[int]:
    """把软件里记录的启停状态重新写回 addonlist.txt（游戏不在运行时才调用）。

    只在「游戏运行期间用户在软件里改过启停」时执行（见 pending_game_reapply 标记），
    否则仍然交给「检测到游戏内已更改，是否同步」的弹窗由用户决定 —— 用户在游戏
    Add-ons 菜单里的改动不会被悄悄吞掉。
    写回后文件内容与软件设置一致、指纹同步推进，因此不会再弹同步询问，
    用户在软件里禁用的 Mod 会真正保持禁用。
    """
    try:
        if not get_pending_game_reapply():
            return None
        set_pending_game_reapply(False)
        count = scanner.apply_mod_prefs_to_addonlist()
        print(f"[GameExit] Re-applied {count} mod state(s) from app settings after game exit")
        return count
    except Exception as e:
        print(f"[GameExit] Failed to re-apply mod states after game exit: {e}")
        return None


@app.post("/api/game/launch")
def launch_game():
    """启动 L4D2 游戏（通过 Steam 协议启动，避免 VAC -insecure 警告）"""
    import subprocess

    # 游戏已经在跑：直接返回，避免重复拉起一个实例
    with _game_status_lock:
        if _game_status_cache["running"] and time.time() - _game_status_cache["time"] < _GAME_STATUS_CACHE_TTL:
            return {
                "status": "ok",
                "message": "游戏已经在运行中",
                "method": "already-running",
                "already_running": True,
                "pid": _game_status_cache["pid"],
            }

    addons_path = scanner.get_addons_path()
    if not addons_path:
        raise HTTPException(status_code=400, detail="请先配置 Addons 目录")

    # 启动前把软件里记录的 mod 启用状态写回 addonlist.txt：
    # 游戏（或 Steam 云同步）会改写该文件，若不同步，用户在软件里的禁用设置
    # 就会在启动游戏后被「反向覆盖」（用户反馈：禁用后启动游戏，再打开软件又变回启用）。
    try:
        scanner.apply_mod_prefs_to_addonlist()
    except Exception as e:
        print(f"[Launch] Failed to apply mod states to addonlist.txt: {e}")

    # 方法1：通过 Steam 协议启动（推荐，避免 VAC -insecure 警告）
    try:
        # 先检查 Steam 是否安装
        steam_path = get_steam_install_path()
        if steam_path and (steam_path / "Steam.exe").exists():
            steam_exe = str(steam_path / "Steam.exe")
            # 使用 steam://rungameid/550 来启动 L4D2（550 是 L4D2 的 AppID）
            subprocess.Popen(
                [steam_exe, "-applaunch", "550"],
                cwd=str(steam_path),
                shell=False
            )
            print(f"[Launch] Starting L4D2 via Steam: {steam_exe} -applaunch 550")
            return {"status": "ok", "message": "游戏已通过 Steam 启动", "method": "steam"}
    except Exception as e:
        print(f"[Launch] Steam launch failed, trying direct: {e}")

    # 方法2：直接启动 exe（兜底方案）
    game_root = Path(addons_path).parent.parent
    exe_path = game_root / "left4dead2.exe"

    if not exe_path.exists():
        exe_path = game_root.parent / "Left 4 Dead 2.exe"

    if not exe_path.exists():
        raise HTTPException(status_code=404, detail=f"未找到游戏可执行文件: {exe_path}")

    try:
        subprocess.Popen(
            [str(exe_path)],
            cwd=str(game_root.parent),
            shell=True
        )
        print(f"[Launch] Starting L4D2 directly: {exe_path}")
        return {"status": "ok", "message": "游戏已直接启动（可能无法连接 VAC 服务器）", "method": "direct"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"启动游戏失败: {str(e)}")


@app.get("/api/logs/export")
def export_logs():
    """导出日志和系统信息为 ZIP 文件，方便用户向开发者提交 bug"""
    import zipfile
    import platform
    import json
    from datetime import datetime

    addons_path = scanner.get_addons_path()

    # 收集系统信息
    # 版本号由 Electron 主进程通过环境变量传入（避免这里写死后与 package.json 不一致）
    app_version = os.environ.get("L4DIRECTOR_APP_VERSION", "unknown")
    system_info = {
        "app_version": app_version,
        "os": platform.platform(),
        "os_version": platform.version(),
        "python_version": sys.version,
        "machine": platform.machine(),
        "processor": platform.processor(),
        "timestamp": datetime.now().isoformat(),
        "addons_configured": addons_path is not None,
        "addons_path": addons_path,
    }

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        # 1. 系统信息
        zf.writestr("system_info.json", json.dumps(system_info, ensure_ascii=False, indent=2, default=str))

        # 2. 后端输出日志
        log_path = os.path.join(_backend_dir, "backend_output.log")
        if os.path.exists(log_path):
            try:
                with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                    log_data = f.read()
                zf.writestr("backend_output.log", log_data)
            except Exception as e:
                zf.writestr("backend_output.log", f"[Error reading log: {e}]")
        else:
            zf.writestr("backend_output.log", "[No backend_output.log found]")

        # 3. VPK 调试日志（如果有）
        for debug_file in ["vpk_debug.txt", "vpk_debug3.txt"]:
            debug_path = os.path.join(_backend_dir, debug_file)
            if os.path.exists(debug_path):
                try:
                    with open(debug_path, "r", encoding="utf-8", errors="replace") as f:
                        zf.writestr(debug_file, f.read())
                except Exception as e:
                    zf.writestr(debug_file, f"[Error reading: {e}]")

        # 4. Mod 信息快照（不包含文件本身，仅元数据）
        try:
            mods = scanner.scan_mods()
            mods_snapshot = []
            for m in mods:
                mods_snapshot.append({
                    "name": m.name,
                    "display_name": m.display_name,
                    "size_bytes": m.size_bytes,
                    "enabled": m.enabled,
                    "is_workshop": m.is_workshop,
                    "workshop_id": m.workshop_id,
                    "author": m.author,
                    "version": m.version,
                    "category": m.category,
                    "tags": m.tags,
                    "vpk_title": m.vpk_title,
                    "conflicts": m.conflicts,
                })
            zf.writestr(
                "mods_snapshot.json",
                json.dumps(mods_snapshot, ensure_ascii=False, indent=2, default=str)
            )
        except Exception as e:
            zf.writestr("mods_snapshot.json", f"[Error scanning mods: {e}]")

        # 5. Mod 状态对账（排查「软件里禁用了，游戏里其实没禁用」这类问题）：
        #    逐条给出软件记录、addonlist.txt 里的真实条目值，并把不一致/可疑的挑出来。
        try:
            zf.writestr(
                "mod_state.json",
                json.dumps(scanner.diagnose_mod_states(), ensure_ascii=False, indent=2, default=str),
            )
        except Exception as e:
            zf.writestr("mod_state.json", f"[Error collecting mod state: {e}]")

        # 6. 扫描性能数据（加载速度排障用：首次/缓存扫描耗时、首个 Mod 出现时间）
        try:
            zf.writestr(
                "scan_perf.json",
                json.dumps(
                    {
                        "last_scan_perf": get_last_scan_perf(),
                        "addons_path": addons_path,
                        "cache_dir": str(_CACHE_DIR),
                    },
                    ensure_ascii=False,
                    indent=2,
                    default=str,
                ),
            )
        except Exception as e:
            zf.writestr("scan_perf.json", f"[Error collecting scan perf: {e}]")

    buffer.seek(0)
    encoded_filename = urllib.parse.quote(f"L4Director_logs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip", safe='')

    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
        }
    )


# 封面图扩展名 → Content-Type。
# 以前这里是 `"image/jpeg" if ext in ('.jpg', '.jpeg') else "image/png"`，
# 于是 webp/bmp/gif 会被标成 image/png（同名封面图支持更多格式后就会踩到）。
_IMAGE_MEDIA_TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.tga': 'image/x-tga',
}


def _image_media_type(path: Path) -> str:
    return _IMAGE_MEDIA_TYPES.get(path.suffix.lower(), 'image/jpeg')


def _allowed_media_roots() -> list[Path]:
    """允许通过缩略图接口读取的根目录。

    这个接口原本直接 `FileResponse(Path(path))`，等于把「读本机任意文件」暴露给了
    渲染进程 —— 只要有人能让它发一个请求（页面注入、恶意 Mod 里的 HTML 封面），
    就能把 `data.json`、`loginusers.vdf` 之类的东西读出来。媒体类型标错不影响内容返回。
    所以除了限定根目录，还要限定扩展名（见 `_is_readable_media`）。
    """
    roots: list[Path] = [_CACHE_DIR]
    addons = scanner.get_addons_path()
    if addons:
        roots.append(Path(addons))
    try:
        outdir = _dl().outdir
        if outdir:
            roots.append(Path(outdir))
    except Exception:
        pass
    return roots


def _is_readable_media(file_path: Path) -> bool:
    """缩略图接口只允许读图片，且必须落在已知目录内。"""
    if file_path.suffix.lower() not in _IMAGE_MEDIA_TYPES:
        return False
    try:
        resolved = file_path.resolve()
    except OSError:
        return False
    for root in _allowed_media_roots():
        try:
            resolved.relative_to(root.resolve())
            return True
        except (ValueError, OSError):
            continue
    return False


@app.get("/api/thumbnail/workshop/{filename}")
def get_workshop_thumbnail(filename: str):
    """获取创意工坊缩略图"""
    addons_path = scanner.get_addons_path()
    if not addons_path:
        raise HTTPException(status_code=404, detail="Addons path not configured")
    if Path(filename).name != filename:
        # 与上面两个接口同一类问题：不允许带目录成分
        raise HTTPException(status_code=400, detail="文件名不合法")
    thumb_path = Path(addons_path) / 'workshop' / filename
    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(str(thumb_path), media_type=_image_media_type(thumb_path))


@app.post("/api/packs/export")
def export_pack(data: dict):
    """导出整合包为 ZIP 文件"""
    import tempfile
    import zipfile
    import json
    
    pack_name = data.get("packName", "整合包")
    mod_names_input = data.get("modNames", [])
    
    if not mod_names_input:
        raise HTTPException(status_code=400, detail="整合包中没有 Mod")
    
    addons_path = scanner.get_addons_path()
    if not addons_path:
        raise HTTPException(status_code=400, detail="请先配置 Addons 目录")
    
    addons_dir = Path(addons_path)
    files_to_add = []  # list of (original_path, archive_name)
    files_missing = []
    
    print(f"[Export] Starting export for pack '{pack_name}' with {len(mod_names_input)} mods")
    
    # Get all scanned mods to map display_name -> actual file
    all_mods = scanner.scan_mods()
    
    for mod_name in mod_names_input:
        found_path = None
        
        # Method 1: 直接按名字拼接（精确路径，不受通配符影响）
        for ext in ['.vpk', '.vpz', '']:
            p = addons_dir / f"{mod_name}{ext}"
            if p.exists() and p.is_file():
                found_path = p
                break
        
        # Method 2: 交给扫描器按名字精确查找（addons 根目录 / workshop / workshop/<id>/）。
        # 不能用 glob：mod 名里的 `[ ]`（例如 `[武器]SCAR.vpk`、`[ 4k  Full HD ]`）
        # 会被 glob 当成字符类，匹配不到真实文件 —— 导出时就会报「找不到文件」。
        if not found_path:
            hit = scanner.find_mod_file(mod_name)
            if hit:
                found_path = hit[0]
        
        # （原先这里还有一段针对 workshop 目录的 glob 查找，
        #   现已由 Method 2 的精确查找覆盖，故移除）
        
        # Method 4: Use mod info from scanner
        if not found_path:
            mod_info = next((m for m in all_mods if m.name == mod_name), None)
            if mod_info and mod_info.path:
                p = Path(mod_info.path)
                if p.exists() and p.is_file():
                    found_path = p
        
        if found_path:
            files_to_add.append(found_path)
            print(f"[Export] Added: {found_path.name}")
        else:
            files_missing.append(mod_name)
            print(f"[Export] Missing: {mod_name}")
    
    if not files_to_add:
        raise HTTPException(status_code=400, detail=f"未找到任何可导出的 Mod 文件")
    
    # Also add companion thumbnail files (.jpg next to .vpk)
    companion_thumbs = []
    for vpk_path in files_to_add:
        thumb_jpg = vpk_path.with_suffix('.jpg')
        thumb_png = vpk_path.with_suffix('.png')
        if thumb_jpg.exists():
            companion_thumbs.append(thumb_jpg)
        elif thumb_png.exists():
            companion_thumbs.append(thumb_png)
    
    print(f"[Export] Found {len(companion_thumbs)} companion thumbnail files")
    
    # Build name map: archive_name -> original_filename
    name_map = {}
    # Reserve _thumb prefix for thumbnails to keep them paired
    for i, file_path in enumerate(files_to_add, 1):
        name_map[f"mod_{i}{file_path.suffix}"] = file_path.name
    for thumb_path in companion_thumbs:
        # Find which mod this thumbnail belongs to by matching stem
        for i, vpk_path in enumerate(files_to_add, 1):
            if vpk_path.stem == thumb_path.stem:
                name_map[f"mod_{i}_thumb{thumb_path.suffix}"] = thumb_path.name
                break
    
    # 同步生成器（不是 async）：压缩是 CPU 密集 + 磁盘读取，交给 FastAPI 的
    # 线程池迭代，不会堵住事件循环。
    def stream_zip():
        # SpooledTemporaryFile：小于 64MB 时只占内存，超过就自动落到临时文件。
        # 以前是 io.BytesIO + zf.writestr(name, f.read()) —— 每个 VPK 整个读进内存，
        # 一个 3GB 的整合包峰值要 6GB（原文件 + zip 各一份），Electron 直接 OOM。
        with tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024) as spool:
            with zipfile.ZipFile(spool, 'w', zipfile.ZIP_DEFLATED) as zf:
                # Write name mapping
                zf.writestr('_name_map.json', json.dumps(name_map, ensure_ascii=False, indent=2))

                # Write each VPK file（zf.write 由 zipfile 自己分块读源文件）
                for i, file_path in enumerate(files_to_add, 1):
                    archive_name = f"mod_{i}{file_path.suffix}"
                    print(f"[Export] Adding {file_path.name} -> {archive_name}")
                    zf.write(file_path, arcname=archive_name)

                # Write companion thumbnails
                for thumb_path in companion_thumbs:
                    archive_thumb_name = None
                    for i, vpk_path in enumerate(files_to_add, 1):
                        if vpk_path.stem == thumb_path.stem:
                            archive_thumb_name = f"mod_{i}_thumb{thumb_path.suffix}"
                            break
                    if archive_thumb_name:
                        zf.write(thumb_path, arcname=archive_thumb_name)

            spool.seek(0)
            while True:
                chunk = spool.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk
    
    encoded_filename = urllib.parse.quote(f"{pack_name}.zip", safe='')
    
    return StreamingResponse(
        stream_zip(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
            "X-Export-Files-Added": str(len(files_to_add)),
            "X-Export-Files-Missing": json.dumps(files_missing),
            "X-Export-Thumbnails": str(len(companion_thumbs)),
        }
    )


# ===== 整合包 CRUD API =====

@app.get("/api/packs")
def list_packs():
    """获取所有整合包"""
    packs = get_packs()
    return {
        "count": len(packs),
        "packs": [{
            "id": p.id,
            "name": p.name,
            "mod_ids": p.mod_ids,
            "created_at": p.created_at,
            "updated_at": p.updated_at,
        } for p in packs]
    }


@app.post("/api/packs")
def create_pack(data: dict):
    """创建新整合包

    `mod_ids` 可选：创建时直接带上成员，供「把已启用的 Mod 一键导入新整合包」使用。
    带成员创建只需要一次读写盘，也不会出现「包建好了但 Mod 没进去」的半成品。
    """
    name = data.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="整合包名称不能为空")
    raw_mods = data.get("mod_ids")
    mod_ids = [str(m) for m in raw_mods] if isinstance(raw_mods, list) else None
    pack = add_pack(name, mod_ids)
    return {
        "status": "ok",
        "pack": {
            "id": pack.id,
            "name": pack.name,
            "mod_ids": pack.mod_ids,
            "created_at": pack.created_at,
            "updated_at": pack.updated_at,
        }
    }


@app.delete("/api/packs/{pack_id}")
def delete_pack_api(pack_id: str):
    """删除整合包"""
    success = delete_pack(pack_id)
    if not success:
        raise HTTPException(status_code=404, detail="整合包未找到")
    return {"status": "ok"}


@app.put("/api/packs/{pack_id}")
def update_pack(pack_id: str, data: dict):
    """更新整合包（重命名或修改内容）"""
    # Check rename
    if "name" in data:
        new_name = data["name"].strip()
        if new_name:
            if not rename_pack(pack_id, new_name):
                raise HTTPException(status_code=404, detail="整合包未找到")

    # Check add/remove mods
    # 同时支持单个与批量：批量走 *_mods 数组，只写一次盘（避免逐个请求导致
    # 界面停在「只加进去一部分」的中间状态）
    if isinstance(data.get("add_mods"), list):
        add_mods_to_pack(pack_id, [str(m) for m in data["add_mods"]])
    if isinstance(data.get("remove_mods"), list):
        remove_mods_from_pack(pack_id, [str(m) for m in data["remove_mods"]])
    if "add_mod" in data:
        add_mod_to_pack(pack_id, data["add_mod"])
    if "remove_mod" in data:
        remove_mod_from_pack(pack_id, data["remove_mod"])

    # Return updated pack
    packs = get_packs()
    pack = next((p for p in packs if p.id == pack_id), None)
    if not pack:
        raise HTTPException(status_code=404, detail="整合包未找到")
    return {
        "status": "ok",
        "pack": {
            "id": pack.id,
            "name": pack.name,
            "mod_ids": pack.mod_ids,
            "created_at": pack.created_at,
            "updated_at": pack.updated_at,
        }
    }


# ===== 整合包批量启用/禁用 API =====

@app.post("/api/packs/{pack_id}/toggle")
def toggle_pack(pack_id: str, data: dict):
    """一次性启用/禁用整个整合包里的所有 Mod。

    前端以前是逐个调用 /api/mods/{name}/toggle：后端每个 Mod 都要「读 addonlist
    → 写 addonlist → 重新解析 VPK」，几百个 Mod 的整合包会卡住很久，界面也没有反馈。
    这里合并成一次读写。
    """
    packs = get_packs()
    pack = next((p for p in packs if p.id == pack_id), None)
    if not pack:
        raise HTTPException(status_code=404, detail="整合包未找到")

    # enable 不传（或为 null）表示「切换」：由后端按成员真实状态决定目标方向，
    # 避免前端因为成员名匹配不上而算错方向 —— 表现就是「一键启用/禁用点了没反应」。
    raw_enable = data.get("enable", None)
    enable = None if raw_enable is None else bool(raw_enable)

    if not pack.mod_ids:
        return {"status": "ok", "enable": bool(enable), "changed": 0, "missing": [], "updated": {}}

    result = scanner.set_mods_enabled(list(pack.mod_ids), enable)
    # 同单个启停：游戏运行期间的改动会被游戏退出时写回的内存状态覆盖，
    # 标记一下，等游戏退出后自动以软件设置为准重新写回
    _mark_pending_reapply_if_game_running()
    return {
        "status": "ok",
        "enable": result.get("enable"),
        "changed": result.get("changed", 0),
        "missing": result.get("missing", []),
        # 实际生效的「成员名 -> 启用状态」：前端用它做局部更新，
        # 从而不需要在每次启停后重新扫描一遍全部 Mod
        "updated": result.get("updated", {}),
    }


# ===== 一键混搭 =====

@app.get("/api/mods/coverage-roster")
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


@app.post("/api/mods/mix/apply")
def apply_mod_mix(data: dict):
    """一键混搭：同一批里「这套启用、这些同类关掉」。

    和整合包批量启停同源（scanner.set_mods_states），区别只在于一批里
    允许两个方向 —— 混搭必然要同时干这两件事：选中的那套开，被顶下去的
    同类关。分两次调用也能实现，但会写两遍 addonlist.txt，中途失败就留下
    一个「一半开一半没关」的组合，那正是混搭最不该出现的状态。
    """
    if not scanner.get_addons_path():
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

    result = scanner.set_mods_states(states)
    # 同整合包：游戏运行中的改动会被退出时写回的内存状态覆盖，标记一下
    _mark_pending_reapply_if_game_running()
    return {
        "status": "ok",
        "changed": result.get("changed", 0),
        "missing": result.get("missing", []),
        "updated": result.get("updated", {}),
        # addonlist.txt 没写成：软件里已经是新状态，但游戏读到的还是旧文件
        "write_error": result.get("write_error"),
    }


# ===== Mod 显示名称 API =====

@app.post("/api/mods/{mod_name}/display-name")
def set_mod_display_name_api(mod_name: str, data: dict):
    """设置 Mod 显示名称"""
    from urllib.parse import unquote
    mod_name = unquote(mod_name)
    display_name = data.get("display_name")  # None to clear
    set_mod_display_name(mod_name, display_name)
    return {"status": "ok", "display_name": display_name}


@app.post("/api/mods/{mod_name}/tags")
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

    result = scanner.set_mod_tags(mod_name, tags)
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


@app.get("/api/custom-tags")
def list_custom_tags_api():
    """自定义标签池（按用户创建顺序）。"""
    return {"tags": get_custom_tags()}


@app.post("/api/custom-tags")
def create_custom_tag_api(data: dict):
    """新建一个自定义标签。已存在时幂等返回（不报错，方便前端「输入完直接打勾」）。"""
    name = _validate_custom_tag_name(data.get("name"))
    return {"status": "ok", "name": name, "tags": add_custom_tag(name)}


@app.delete("/api/custom-tags/{name}")
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


@app.get("/api/mods/apply-state")
def get_apply_state():
    """「应用」按钮的状态：是否有改动还没写回 addonlist.txt + 游戏是否在运行。"""
    return {
        "dirty": get_prefs_dirty(),
        "game_running": _game_is_running_cached(),
    }


@app.get("/api/mods/{mod_name}/display-name")
def get_mod_display_name_api(mod_name: str):
    """获取 Mod 显示名称"""
    from urllib.parse import unquote
    mod_name = unquote(mod_name)
    display_name = get_mod_display_name(mod_name)
    return {"display_name": display_name}


# ===== 增量扫描 API =====

@app.get("/api/mods/delta")
def list_mods_delta(since: Optional[str] = None):
    """增量获取 Mod 列表 — 只返回变化的 Mod
    
    支持参数：
    - since: ISO 时间戳，只返回该时间后变化的 Mod
    """
    mods = scanner.scan_mods()
    
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


@app.get("/api/mods/scan-status")
def scan_status():
    """获取扫描状态 — 检查 Mod 文件是否有变更，不用返回全部 Mod。

    这是「软件之外发生的改动」的探测器：前端每隔几秒轮询一次，命中 changed 就
    静默刷新列表，于是「在 Steam 里取消订阅（vpk 被删）」「新订阅的 Mod 下载完成」
    「手动往 addons 里丢 / 删文件」都会自动反映到界面上 —— 不再需要用户手动刷新，
    也不会出现「已经取消订阅，卡片还留在界面上」。

    对比的基线是 data.json 里的 scan_manifest（由 mod_scanner 每次扫描后写入，
    键是相对 addons 目录的 posix 路径，值是 mtime）。
    """
    addons_path = scanner.get_addons_path()
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


# VPK 封面缓存实际存放在 vpk_covers/ 子目录；早期版本曾直接放在 _CACHE_DIR 根目录。
# 两个位置都查一次，既修好「本地 Mod 封面 404」（原先只查根目录 → 全部找不到），
# 也兼容历史缓存文件。
_VPK_COVER_DIR = _CACHE_DIR / 'vpk_covers'


def _resolve_cover_path(cover_name: str) -> Optional[Path]:
    """把 URL 里的封面名解析成磁盘路径（拒绝带目录的非法名，避免路径穿越）。"""
    if not cover_name:
        return None
    try:
        if Path(cover_name).name != cover_name:
            return None
    except Exception:
        return None
    for base in (_VPK_COVER_DIR, _CACHE_DIR):
        p = base / cover_name
        if p.is_file():
            return p
    return None


@app.get("/api/thumbnail")
def get_thumbnail(path: Optional[str] = None, vpk_cover: Optional[str] = None):
    """通过绝对路径获取缩略图，或从 VPK 封面缓存中获取

    缓存策略：缩略图是「文件路径 + mtime」驱动的静态资源，一次会话内不会变。
    加 Cache-Control 让 Chromium 直接命中内存/磁盘缓存，切页回 Mod 列表时
    不再为几十张封面重复发起请求并重新读盘（这是切页卡顿的主要来源之一）。
    """
    # 1 小时：足够覆盖一次使用会话；封面被替换也能自然失效
    cache_headers = {"Cache-Control": "public, max-age=3600"}
    if path:
        file_path = Path(path)
        if not file_path.exists() or not file_path.is_file():
            raise HTTPException(status_code=404, detail="Thumbnail not found")
        if not _is_readable_media(file_path):
            # 不在 addons / 缓存 / 下载目录内，或不是图片扩展名：拒绝
            raise HTTPException(status_code=403, detail="这个路径不允许读取")
        return FileResponse(str(file_path), media_type=_image_media_type(file_path), headers=cache_headers)
    elif vpk_cover:
        cover_path = _resolve_cover_path(vpk_cover)
        if cover_path is None:
            raise HTTPException(status_code=404, detail="VPK cover not found")
        return FileResponse(str(cover_path), media_type=_image_media_type(cover_path), headers=cache_headers)
    else:
        raise HTTPException(status_code=400, detail="Either 'path' or 'vpk_cover' parameter is required")


@app.post("/api/thumbnails/batch")
def get_thumbnails_batch(data: dict):
    """批量获取缩略图 — 传入多个 vpk_cover 名称，返回批量数据。
    减少前端大量独立的 HTTP 请求开销。
    """
    cover_names = data.get("covers", [])
    if not cover_names or not isinstance(cover_names, list):
        return {"thumbnails": []}
    
    results = []
    for cover_name in cover_names:
        cover_path = _resolve_cover_path(cover_name)
        if cover_path is not None:
            try:
                data_bytes = cover_path.read_bytes()
                results.append({
                    "name": cover_name,
                    "data_base64": base64.b64encode(data_bytes).decode('ascii'),
                    "media_type": _image_media_type(cover_path),
                })
            except:
                pass
    
    return {"thumbnails": results}


# ===== Steam Local Authentication =====

def get_steam_install_path() -> Optional[Path]:
    """Detect Steam installation path on Windows"""
    # Try reading from registry first (most reliable)
    try:
        import winreg
        for key in [winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER]:
            try:
                handle = winreg.OpenKey(key, r"SOFTWARE\Valve\Steam")
                install_path, _ = winreg.QueryValueEx(handle, "InstallPath")
                winreg.CloseKey(handle)
                p = Path(install_path)
                if p.exists():
                    print(f"[Steam] Found via registry: {p}")
                    return p
            except:
                pass
    except Exception as e:
        print(f"[Steam] Registry check failed: {e}")

    # Fallback: check common paths
    candidates = [
        Path(os.environ.get("PROGRAMFILES(X86)", "C:\\Program Files (x86)")) / "Steam",
        Path(os.environ.get("PROGRAMFILES", "C:\\Program Files")) / "Steam",
        Path("C:\\Program Files (x86)\\Steam"),
        Path("C:\\Program Files\\Steam"),
        Path.home() / "AppData\\Local\\Steam",
    ]
    for path in candidates:
        if (path / "Steam.exe").exists() or (path / "steam.exe").exists():
            print(f"[Steam] Found via path: {path}")
            return path
        print(f"[Steam] Not found at: {path}")
    print(f"[Steam] Steam installation not found in any candidate path")
    return None


def read_steam_users() -> list[dict]:
    """Read Steam login users from local config"""
    steam_path = get_steam_install_path()
    if not steam_path:
        print("[Steam] Cannot read users: Steam install path not found")
        return []

    login_users_path = steam_path / "config" / "loginusers.vdf"  # type: ignore
    print(f"[Steam] Looking for loginusers.vdf at: {login_users_path}")
    print(f"[Steam] File exists: {login_users_path.exists()}")

    if not login_users_path.exists():
        # Fallback: try to scan common Steam library paths
        print(f"[Steam] loginusers.vdf not found at expected path")
        return []

    try:
        content = login_users_path.read_text(encoding="utf-8", errors="ignore")
        users = []

        # Parse VDF format to extract users
        # Pattern: "SteamID" { ... "AccountName" "xxx" "PersonaName" "xxx" ... "MostRecent" "1" ... }
        import re as re2
        user_blocks = re2.findall(r'"(\d+)"\s*\{([^}]+)\}', content)

        for steam_id, block in user_blocks:
            account_name = ""
            persona_name = ""
            most_recent = "0"

            m = re2.search(r'"AccountName"\s*"([^"]+)"', block)
            if m:
                account_name = m.group(1)

            m = re2.search(r'"PersonaName"\s*"([^"]+)"', block)
            if m:
                persona_name = m.group(1)

            m = re2.search(r'"MostRecent"\s*"([^"]+)"', block)
            if m:
                most_recent = m.group(1)

            if steam_id and account_name:
                users.append({
                    "steamId": steam_id,
                    "accountName": account_name,
                    "personaName": persona_name or account_name,
                    "mostRecent": most_recent == "1",
                })

        return users
    except Exception as e:
        print(f"[Steam Auth] Failed to read loginusers.vdf: {e}")
        return []


def _fetch_steam_profile_avatar(steam_id: str) -> str:
    """同步获取 Steam 头像地址（线程安全 + 缓存 + 短超时）。

    失败也会缓存 60 秒：在无法访问 steamcommunity 的网络下，
    避免“每次启动/每张头像 <img>”都白等一次超时。
    """
    now = time.time()
    with _steam_cache_lock:
        cached = _steam_profile_cache.get(steam_id)
    if cached and now - cached[0] < (_STEAM_CACHE_TTL if cached[1] else _STEAM_FAIL_TTL):
        return cached[1]

    avatar_url = ""
    try:
        profile_url = f"https://steamcommunity.com/profiles/{steam_id}/?xml=1"
        req = urllib.request.Request(
            profile_url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        )
        with urllib.request.urlopen(req, timeout=_STEAM_NET_TIMEOUT) as resp:
            xml_data = resp.read().decode("utf-8", errors="ignore")
        # CDATA 格式优先
        avatar_match = re.search(
            r'<avatarMedium>\s*<!\[CDATA\[(.+?)\]\]>\s*</avatarMedium>', xml_data, re.DOTALL
        )
        if not avatar_match:
            avatar_match = re.search(r'<avatarMedium>\s*(https?://[^<]+)\s*</avatarMedium>', xml_data)
        if avatar_match:
            avatar_url = avatar_match.group(1).strip()
    except Exception as e:
        print(f"[Steam Auth] Failed to fetch avatar url (cached as failure for {int(_STEAM_FAIL_TTL)}s): {e}")

    with _steam_cache_lock:
        _steam_profile_cache[steam_id] = (now, avatar_url)
    return avatar_url


def _fetch_steam_avatar_bytes(url: str) -> tuple[bytes, str]:
    """同步下载头像图片（线程安全 + 缓存 + 短超时）；失败返回空字节。"""
    now = time.time()
    with _steam_cache_lock:
        cached = _steam_avatar_cache.get(url)
    if cached and now - cached[0] < (_STEAM_CACHE_TTL if cached[1] else _STEAM_FAIL_TTL):
        return cached[1], cached[2]

    data = b""
    content_type = ""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=_STEAM_NET_TIMEOUT) as resp:
            data = resp.read()
            content_type = resp.headers.get("Content-Type", "image/jpeg")
    except Exception as e:
        print(f"[Steam Auth] Failed to fetch avatar bytes (cached as failure for {int(_STEAM_FAIL_TTL)}s): {e}")

    with _steam_cache_lock:
        _steam_avatar_cache[url] = (now, data, content_type)
    return data, content_type


@app.post("/api/auth/steam/login")
def steam_login():
    """Login with local Steam account - read user info from local installation"""
    users = read_steam_users()

    if not users:
        return {
            "authenticated": False,
            "user": None,
            "error": "未找到本地 Steam 用户，请确认 Steam 已安装并登录",
        }

    # Find the most recent user, or take the first one
    recent_users = [u for u in users if u.get("mostRecent")]
    selected = recent_users[0] if recent_users else users[0]

    steam_id = selected["steamId"]
    nickname = selected.get("personaName") or selected.get("accountName") or "Steam User"

    # Fetch avatar from Steam Community（带缓存与 3 秒超时；失败会被缓存 60 秒）
    avatar_url = _fetch_steam_profile_avatar(steam_id)

    # Ensure avatar URL uses https
    if avatar_url and avatar_url.startswith("http://"):
        avatar_url = avatar_url.replace("http://", "https://", 1)

    # If still no avatar, use a default that definitely loads
    if not avatar_url:
        avatar_url = "https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg"

    _steam_auth_state["authenticated"] = True
    _steam_auth_state["user"] = {
        "steamId": steam_id,
        "nickname": nickname,
        "avatarUrl": avatar_url,
    }

    print(f"[Steam Auth] Local user detected: {nickname} ({steam_id})")
    return {
        "authenticated": True,
        "user": _steam_auth_state["user"],
    }


@app.get("/api/auth/steam/avatar")
def steam_avatar():
    """Proxy Steam avatar image（内存缓存 + 短超时；失败返回 1×1 透明像素）"""
    from fastapi.responses import Response

    avatar_url = "https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg"
    user = _steam_auth_state.get("user")
    if user and user.get("avatarUrl") and user["avatarUrl"] != "default":
        avatar_url = user["avatarUrl"]

    image_data, content_type = _fetch_steam_avatar_bytes(avatar_url)
    if image_data:
        return Response(content=image_data, media_type=content_type or "image/jpeg")

    # Return a small transparent pixel as fallback to avoid broken image icon
    transparent_pixel = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x0bIDATx\x9cc\x00\x00\x00\x02\x00\x01\xe5\x11\xe4\xf5\x00\x00\x00\x00IEND\xaeB`\x82'
    return Response(content=transparent_pixel, media_type="image/png")


@app.get("/api/auth/steam/status")
def steam_status():
    """Check current Steam authentication status"""
    return {
        "authenticated": _steam_auth_state["authenticated"],
        "user": _steam_auth_state["user"],
    }


@app.post("/api/auth/steam/logout")
def steam_logout():
    """Logout Steam session"""
    _steam_auth_state["authenticated"] = False
    _steam_auth_state["user"] = None
    return {"status": "ok"}


# ===== 创意工坊下载器 API =====
# 功能来自项目根目录的 L4D2创意工坊下载器.pyw：绕过 Steam 客户端，
# 直接从 UGC CDN 多线程分段下载 + SHA1 校验，落成 <工坊ID>.vpk。

_DL_THUMB_DIR = _CACHE_DIR / "dl_thumbs"


def _dl():
    return get_download_manager()


def _image_mime_from_bytes(data: bytes) -> str:
    """按**文件头**判格式，不看扩展名。

    工坊封面统一存成 `<id>.jpg`，但里面经常是 GIF（真的动图）或 PNG。
    以前这里缺 GIF 分支，于是动图被标成 image/jpeg 发出去 —— 浏览器靠嗅探
    还能显示，可 `fetch()` + `createImageBitmap()` 这条路会按 Blob 的 type
    选解码器，标错就直接解不出来，卡片只能回退到原图（于是又开始全速播动图）。
    """
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:2] == b"BM":
        return "image/bmp"
    return "image/jpeg"


def _sniff_file_mime(path: Path) -> str:
    """读文件头判 MIME；读不到就按扩展名兜底。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(16)
    except OSError:
        return _image_media_type(path)
    guessed = _image_mime_from_bytes(head)
    # 全是兜底值（image/jpeg）时也可能真是 jpeg，直接返回即可
    return guessed


# ── 创意工坊更新检查 ──────────────────────────────────────────────────
# 查 Steam 的 time_updated，和本地基线比对，判断已安装的工坊 Mod 有没有新版；
# 更新时直接走下载器覆盖原文件（不依赖 Steam 客户端）。

def _wsu():
    from services.workshop_updates import get_service
    return get_service()


@app.get("/api/workshop-updates")
def workshop_updates_state():
    """当前「哪些工坊 Mod 有新版本」+ 检查/更新进度（纯本地计算，可随时轮询）。"""
    return _wsu().snapshot(scanner.get_addons_path() or "")


@app.post("/api/workshop-updates/check")
def workshop_updates_check():
    """后台起一次检查（联网查 Steam），立刻返回。"""
    path = scanner.get_addons_path()
    if not path:
        raise HTTPException(status_code=400, detail="Addons 路径未配置")
    result = _wsu().start_check(path)
    if not result.get("ok"):
        raise HTTPException(status_code=409, detail=result.get("error") or "检查失败")
    return result


@app.post("/api/workshop-updates/cancel")
def workshop_updates_cancel():
    """停止正在进行的检查。已查到的结果照常保留，不用等整轮跑完。"""
    result = _wsu().cancel_check()
    if not result.get("ok"):
        raise HTTPException(status_code=409, detail=result.get("error") or "取消失败")
    return result


@app.post("/api/workshop-updates/apply")
def workshop_updates_apply(payload: dict):
    """更新指定条目（重新下载并覆盖本地 vpk）。payload: {ids: [...]} 或 {all: true}。"""
    path = scanner.get_addons_path()
    if not path:
        raise HTTPException(status_code=400, detail="Addons 路径未配置")
    p = payload or {}
    ids = p.get("ids")
    if p.get("all"):
        snap = _wsu().snapshot(path)
        ids = [i["workshop_id"] for i in snap["items"] if i["update_available"]]
    result = _wsu().start_apply(ids or [], path)
    if not result.get("ok"):
        raise HTTPException(status_code=409, detail=result.get("error") or "更新失败")
    return result


@app.post("/api/workshop-updates/apply/cancel")
def workshop_updates_apply_cancel():
    """停止正在进行的更新。

    已下载完成的包保留（它们本来就是新版本），当前这个在下一个分块边界退出，
    不会留下半个 vpk —— download_one 的取消路径会丢弃临时文件。
    """
    result = _wsu().cancel_apply()
    if not result.get("ok"):
        raise HTTPException(status_code=409, detail=result.get("error") or "取消失败")
    return result


# ── 创意工坊浏览器（自写，不再依赖内嵌网页）──────────────────────────────
# 两条数据路径由 services/workshop_browse.py 内部决定：
#   * 没填 Steam API Key → 抓工坊网页拿 ID，再用免 key 的详情接口补字段（30 条/页）
#   * 填了 key          → QueryFiles，100 条/页、带评分、有精确总数
# 界面不关心走哪条，只按返回里的 source/page_size 显示。

def _wb():
    from services import workshop_browse as _mod
    return _mod


def _subs():
    from services import workshop_subscriptions as _mod
    return _mod


@app.get("/api/workshop/meta")
def workshop_meta():
    """筛选项、排序项、当前是否配了 key（前端首次渲染用）。"""
    return _wb().meta()


@app.get("/api/workshop/browse")
def workshop_browse(
    q: str = "",
    sort: str = "trend",
    days: int = 0,
    match_all: bool = False,
    page: str = "",
    tags: str = "",
    excluded: str = "",
):
    """一页工坊列表。

    `tags` / `excluded` 用逗号分隔（标签里可能带空格，例如 `Special Infected`，
    所以不用重复 query 参数，直接整体逗号切）。
    `page` 是上一页返回的 `next` 原样传回：API 路径是 cursor 字符串，HTML 路径是页码。
    """
    split = lambda s: [t.strip() for t in (s or "").split(",") if t.strip()]
    filters = {
        "q": q,
        "sort": sort,
        "days": days,
        "match_all": bool(match_all),
        "tags": split(tags),
        "excluded_tags": split(excluded),
    }
    try:
        return _wb().browse(filters, page, scanner.get_addons_path())
    except _wb().WorkshopError as e:
        # 400 + 一句能照做的话：前端直接把 detail 显示在列表位置，不弹裸异常
        # redact 是最后一道闸：错误文本里绝不允许出现完整 key
        raise HTTPException(status_code=400, detail=_wb().redact(str(e)))


@app.get("/api/workshop/item/{wid}")
def workshop_item(wid: str):
    """单个条目的完整详情：完整描述 + 图集（多图）+ 依赖项。

    抽屉打开时才调。带 addons 路径是为了给依赖项标「已下载 / 未下载」。
    """
    try:
        return _wb().item_detail(wid, scanner.get_addons_path())
    except _wb().WorkshopError as e:
        raise HTTPException(status_code=400, detail=_wb().redact(str(e)))


def _current_steam_id() -> Optional[str]:
    """当前 Steam 账号的 64 位 ID。

    优先用界面里「登录」过的那个；没有就回退到本机 loginusers.vdf 里 MostRecent 的账号。
    注意这两个都只是**认人**（不是授权），够用来读自己的订阅，改订阅则做不到。
    """
    user = _steam_auth_state.get("user")
    if isinstance(user, dict) and user.get("steamId"):
        return str(user["steamId"])
    users = read_steam_users()
    recent = [u for u in users if u.get("mostRecent")] or users
    return str(recent[0]["steamId"]) if recent else None


@app.get("/api/workshop/subscription-diff")
def workshop_subscription_diff(refresh: bool = False):
    """对比「Steam 账号订阅」和「本地 workshop 文件」（只读，不动任何文件）。

    返回 to_download（订阅了但本地没有）和 to_delete（本地有但已不在订阅里）。
    """
    steam_id = _current_steam_id()
    if not steam_id:
        raise HTTPException(
            status_code=400,
            detail="找不到 Steam 账号：先用本机 Steam 客户端登录一次，或在设置里填 API Key")
    if refresh:
        _subs().clear_cache()
    try:
        return _subs().diff(steam_id, scanner.get_addons_path())
    except _subs().SubscriptionError as e:
        raise HTTPException(status_code=400, detail=_wb().redact(str(e)))


@app.post("/api/workshop/subscriptions/sync")
def workshop_subscription_sync(payload: dict):
    """按对账结果执行：缺的入下载队列，多出来的删掉。

    只处理传进来的 ID 列表（前端确认过的那批），不在后端重新算一遍 ——
    否则用户看到的是 3 个、真要删的时候可能变成 30 个。
    """
    p = payload or {}
    dl_ids = [str(x) for x in (p.get("download_ids") or []) if str(x).isdigit()]
    rm_ids = [str(x) for x in (p.get("delete_ids") or []) if str(x).isdigit()]

    added = ignored = 0
    if dl_ids:
        res = _dl().add_targets("\n".join(dl_ids))
        added = len(res.get("added") or [])
        ignored = len(res.get("ignored") or [])

    deleted = 0
    failed: list[dict] = []
    if rm_ids:
        addons = scanner.get_addons_path()
        ws = Path(addons) / "workshop" if addons else None
        for sid in rm_ids:
            if not ws:
                failed.append({"id": sid, "error": "没有配置 addons 目录"})
                continue
            target = ws / f"{sid}.vpk"
            if not target.is_file():
                failed.append({"id": sid, "error": "文件已不存在"})
                continue
            try:
                ok = scanner.delete_mod(target.name, path_hint=str(target))
            except Exception as e:                      # noqa: BLE001
                print(f"[SubSync] delete failed for {sid}: {e}")
                ok = False
            if ok:
                deleted += 1
            else:
                failed.append({"id": sid, "error": "删除失败（文件可能正被游戏占用）"})
        if deleted:
            invalidate_scan_cache()

    return {
        "ok": not failed,
        "queued": added,
        "already_queued": ignored,
        "deleted": deleted,
        "failed": failed,
    }


@app.post("/api/mods/addonlist/fill")
def fill_addonlist_endpoint():
    """一键补全 addonlist.txt：把本地所有 mod 补进去（只补缺失条目）。

    场景：刚拖进 addons 或刚订阅的包，addonlist.txt 里还没有它 ——
    游戏的「附加内容」列表里看不到，某些机器上还会被当成没装。
    已有的条目一律不动（启停状态、编码写法都保持原样）。
    """
    result = scanner.fill_addonlist()
    if result.get('ok'):
        # 补进去的都是启用状态 → 让下一次扫描重新读一遍
        invalidate_scan_cache()
    return result


@app.get("/api/settings/steam-key")
def get_steam_key():
    """只返回是否配置 + 指纹，永远不把 key 原样回传给界面。"""
    return _wb().key_status()


@app.post("/api/settings/steam-key")
def set_steam_key(payload: dict):
    """保存 key（空字符串 = 清除）。保存前先验一次，避免存进去一个无效 key。"""
    key = ((payload or {}).get("key") or "").strip()
    try:
        if key:
            tested = _wb().verify_key(key)
        else:
            tested = None
        state = _wb().set_api_key(key)
    except _wb().WorkshopError as e:
        raise HTTPException(status_code=400, detail=_wb().redact(str(e)))
    _wb().clear_cache()
    return {**state, "test": tested}


@app.post("/api/settings/steam-key/test")
def test_steam_key(payload: dict):
    """试一下这把 key 能不能用（不保存）。返回实测耗时，用户能看到「能用且多快」。"""
    key = ((payload or {}).get("key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="先填一个 key 再测试")
    try:
        return _wb().verify_key(key)
    except _wb().WorkshopError as e:
        raise HTTPException(status_code=400, detail=_wb().redact(str(e)))


@app.post("/api/workshop-updates/settings")
def workshop_updates_settings(payload: dict):
    """自动检查开关与检查间隔（小时）。"""
    p = payload or {}
    return _wsu().save_settings(p.get("auto_check"), p.get("interval_hours"))


@app.get("/api/download/state")
def download_state():
    """下载队列 / 进度 / 日志的完整快照（前端轮询用）。"""
    return _dl().snapshot()


@app.get("/api/download/default-dir")
def download_default_dir():
    """推荐输出目录（软件里配置的 addons/workshop）。"""
    mgr = _dl()
    return {
        "outdir": mgr.outdir,
        "detected": download_default_outdir(),
        "hint": download_outdir_hint(mgr.outdir),
    }


@app.post("/api/download/resolve")
def download_resolve(payload: dict):
    """解析粘贴进来的工坊链接/ID，加入下载队列（合集会自动展开）。"""
    text = (payload or {}).get("text", "")
    return _dl().add_targets(text)


@app.post("/api/download/start")
def download_start(payload: dict):
    """开始下载队列里待处理的条目。"""
    p = payload or {}
    return _dl().start(p.get("outdir"), p.get("threads"), p.get("force"))


@app.post("/api/download/stop")
def download_stop():
    """停止下载（已下好的分段会保留，下次自动续传）。"""
    return _dl().stop()


@app.post("/api/download/remove")
def download_remove(payload: dict):
    """从队列里移除若干条目。"""
    wids = [str(w) for w in ((payload or {}).get("wids") or [])]
    _dl().remove(wids)
    return {"ok": True}


@app.post("/api/download/clear")
def download_clear():
    _dl().clear()
    return {"ok": True}


@app.post("/api/download/open-dir")
def download_open_dir(payload: dict = None):
    """在资源管理器里打开输出目录。"""
    target = ((payload or {}).get("path") or _dl().outdir or "").strip()
    if not target or not Path(target).is_dir():
        raise HTTPException(status_code=404, detail="目录不存在")
    try:
        os.startfile(target)  # type: ignore[attr-defined]  # Windows only
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"打开目录失败：{e}")
    return {"ok": True}


_THUMB_CACHE_LIMIT = 256 * 1024 * 1024   # 封面缓存上限，超了按最久未访问淘汰
_THUMB_CACHE_MAX_FILE = 4 * 1024 * 1024  # 单张超过这个大小就不落盘（GIF 动图居多）
_LAST_PRUNE = 0.0                        # 上次扫描缓存的时间戳（节流用）


def _preview_variant_url(url: str, width: int, height: int) -> str:
    """给 Steam 图床地址加上「按尺寸取图」参数。

    L4D2 工坊里有一批封面是几万像素的竖长条 / 二十多 MB 的 GIF 动图，原样抓下来
    既费流量又费显存。Steam 图床支持 `imw/imh/ima/impolicy` 做服务端缩放，
    典型收益：11.8 MB 的 600×600 动图 → 463 KB。

    注意两点：
      * 只有 steamusercontent 这类图床认这些参数，别的域名原样返回；
      * **并非所有文件都生效**（实测有个 24.7 MB 的 GIF 完全无视参数），
        所以客户端仍然必须做本地降采样兜底，参数只是省流量，不是正确性依赖。
    """
    if not url or width <= 0 or height <= 0:
        return url
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if "steamusercontent" not in host and "akamai" not in host:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}imw={width}&imh={height}&ima=fit&impolicy=Letterbox"


def _prune_thumb_cache(limit: int = _THUMB_CACHE_LIMIT) -> None:
    """把封面缓存压到限额以内（按最后访问时间淘汰最旧的）。

    这不是用户数据，是随时可重建的派生缓存；不设上限时实测跑一趟工坊就能
    堆到 500 MB（一张 28 MB 的动图比比皆是）。删不掉的文件（正被读取/占用）
    直接跳过，下次再收。

    每 60 秒最多扫一次：卡片是一张张加载的，每写一张就 glob 一遍目录，
    缓存上万文件时光这一项就够拖慢响应。
    """
    global _LAST_PRUNE
    now = time.time()
    if now - _LAST_PRUNE < 60:
        return
    _LAST_PRUNE = now
    try:
        files = [p for p in _DL_THUMB_DIR.glob("*") if p.is_file()]
    except OSError:
        return
    total = sum(p.stat().st_size for p in files if p.exists())
    if total <= limit:
        return
    files.sort(key=lambda p: p.stat().st_mtime)
    for p in files:
        if total <= limit * 0.8:      # 一次收到 80%，避免每次写盘都触发一轮扫描
            break
        try:
            size = p.stat().st_size
            p.unlink()
            total -= size
        except OSError:
            continue


def _thumb_cache_name(wid: str, url: Optional[str],
                      w: Optional[int], h: Optional[int]) -> str:
    """工坊缩略图在磁盘上的缓存文件名。

    键里**必须**带上这张图 URL 的指纹。以前只用 `wid`，同一个 Mod 的多张截图
    会撞进同一个缓存文件 —— 表现就是详情页图集里每一张都显示成第一张（封面）。
    """
    variant = f"_{w}x{h}" if w and h else ""
    url_tag = hashlib.md5(url.encode('utf-8')).hexdigest()[:12] if url else 'nocover'
    return f"{wid}_{url_tag}{variant}.jpg"


@app.get("/api/download/thumbnail")
def download_thumbnail(wid: str, url: Optional[str] = None,
                       w: Optional[int] = None, h: Optional[int] = None):
    """工坊封面：优先读本地已下载的 <id>.jpg，其次走同一套直连逻辑抓取并缓存。

    `w` / `h` 是**卡片显示尺寸**（不是原图尺寸）：传了就让图床把图缩到这个
    大小再抓，缓存也按尺寸分开存（`<id>_320x180.jpg`）。不传则保持原行为，
    已下载的 Mod 目录里那份封面仍然优先。
    """
    if not wid:
        raise HTTPException(status_code=400, detail="wid is required")
    # 工坊 ID 一定是纯数字。以前直接 f"{wid}.jpg" 拼路径，传 ../../ 就能读到目录外的东西。
    if not re.fullmatch(r'[0-9]{1,20}', wid):
        raise HTTPException(status_code=400, detail="wid 必须是纯数字的创意工坊 ID")

    cache_headers = {"Cache-Control": "public, max-age=86400"}
    local = Path(_dl().outdir) / f"{wid}.jpg"
    # 本地这份是 Steam 客户端下载时附带的**封面**，好坏都得认（用户已经装了这个 Mod）。
    # 但只有「没指定具体图」时才用它：详情页图集里每张图都带着自己的 url，
    # 一旦这里无条件优先返回本地封面，整个图集就会全部显示成封面那一张。
    if not url and not w and not h and local.is_file() and local.stat().st_size > 512:
        return FileResponse(str(local), media_type=_sniff_file_mime(local), headers=cache_headers)

    cached = _DL_THUMB_DIR / _thumb_cache_name(wid, url, w, h)
    if cached.is_file() and cached.stat().st_size > 512:
        try:
            os.utime(cached, None)      # 记一次访问，LRU 淘汰时不会被误杀
        except OSError:
            pass
        return FileResponse(str(cached), media_type=_sniff_file_mime(cached), headers=cache_headers)

    if not url:
        raise HTTPException(status_code=404, detail="no preview")

    data = download_fetch_bytes(_preview_variant_url(url, w or 0, h or 0))
    if not data:
        raise HTTPException(status_code=404, detail="preview fetch failed")
    # 超大封面不落盘：工坊里既有 28 MB 的 GIF，也有 11 MB 的竖长条，缓存它们
    # 等于让磁盘替 CDN 背锅（实测跑几趟就 500 MB）。这些图本来就来自边缘缓存、
    # 重取只要 0.2 秒，不缓存反而更好；常见尺寸（几百 KB）照常缓存。
    if len(data) <= _THUMB_CACHE_MAX_FILE:
        try:
            _DL_THUMB_DIR.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(data)
        except Exception:
            pass
    _prune_thumb_cache()
    return Response(content=data, media_type=_image_mime_from_bytes(data), headers=cache_headers)


def main():
    parser = argparse.ArgumentParser(description="L4D2 Mod Manager Backend")
    parser.add_argument("--port", type=int, default=8288, help="Port to run the server on")
    # 默认仅监听本机回环地址。若需要在局域网内被其他设备访问，可手动指定：
    #   python main.py --host 0.0.0.0
    parser.add_argument(
        "--host", type=str, default="127.0.0.1",
        help="Host/interface to bind. Default '127.0.0.1' (local only). "
             "Use '0.0.0.0' to allow LAN clients to connect."
    )
    args = parser.parse_args()

    # Auto-detect on startup
    detected = scanner.auto_detect_addons_path()
    if detected:
        print(f"[OK] Auto-detected L4D2 addons path: {detected}")
    else:
        print("[WARN] Could not auto-detect addons path. Please configure in Settings.")

    print(f"[Startup] Backend listening on http://{args.host}:{args.port}")

    uvicorn.run(
        "main:app",
        host=args.host,
        port=args.port,
        reload=False,
        log_level="info"
    )


if __name__ == "__main__":
    main()
