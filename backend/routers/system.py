"""系统域路由：健康检查、总览状态、日志导出、本地缓存统计与回收。"""

import io
import json
import os
import sys
import urllib.parse
import urllib.request
import zipfile

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse

import app_state
from app_state import APP_VERSION, BACKEND_DIR
from services.data_store import get_last_recovery
from services.mod_scanner import (
    _CACHE_DIR,
    cache_gc,
    cache_stats,
    get_last_scan_perf,
    official_baseline_status,
)

router = APIRouter()

@router.get("/api/health")
def health_check():
    """健康检查接口"""
    return {"status": "ok", "version": APP_VERSION}


@router.get("/api/status")
def get_status():
    """获取管理器状态"""
    mods = app_state.scanner.scan_mods()
    addons_path = app_state.scanner.get_addons_path()
    return {
        "game_detected": addons_path is not None,
        "mod_count": len(mods),
        "workshop_count": len([m for m in mods if m.is_workshop]),
        "game_path": addons_path,
        "addons_configured": addons_path is not None,
        # 官方基准（游戏本体 pak01_dir.vpk）是否可用。拿不到时冲突判定会静默降级：
        # hard 冲突整片变 soft、只进 conflict_hints，界面上看起来就是「红点全没了」。
        # 这里如实带出去，设置页据此提示「冲突判定已降级」，而不是让用户以为软件不认冲突了。
        "official_baseline": official_baseline_status(addons_path),
        # 最近一次扫描的性能数据（耗时/吞吐线索），便于前端展示与排障
        "last_scan_perf": get_last_scan_perf(),
        # 配置文件曾经损坏、已被隔离留档时带上记录，界面据此提示用户去备份里找回
        "data_recovery": get_last_recovery(),
    }


@router.get("/api/cache/stats")
def get_cache_stats():
    """本地缓存体积（封面 / 索引 / 元数据 / 清单），供设置页显示。"""
    return cache_stats()


@router.post("/api/cache/gc")
def run_cache_gc():
    """清理孤儿缓存：只删「对应 VPK 已经不存在」的那些文件。

    不传任何参数 —— addons 路径从当前配置取，枚举不到 VPK 时后端会拒绝执行，
    不会出现「路径填错一次，缓存被清空」的情况。
    清理后前端会重新拉一次 Mod 列表，避免界面上留着已经被删掉的封面名。
    """
    result = cache_gc(app_state.scanner.get_addons_path())
    if result.get('ok'):
        print(f"[Cache] GC removed {result['removed_files']} files, "
              f"freed {result['freed_bytes']} bytes")
    else:
        print(f"[Cache] GC skipped: {result.get('reason')}")
    return result


@router.get("/api/logs/export")
def export_logs():
    """导出日志和系统信息为 ZIP 文件，方便用户向开发者提交 bug"""
    import platform
    from datetime import datetime

    addons_path = app_state.scanner.get_addons_path()

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
        log_path = os.path.join(BACKEND_DIR, "backend_output.log")
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
            debug_path = os.path.join(BACKEND_DIR, debug_file)
            if os.path.exists(debug_path):
                try:
                    with open(debug_path, "r", encoding="utf-8", errors="replace") as f:
                        zf.writestr(debug_file, f.read())
                except Exception as e:
                    zf.writestr(debug_file, f"[Error reading: {e}]")

        # 4. Mod 信息快照（不包含文件本身，仅元数据）
        try:
            mods = app_state.scanner.scan_mods()
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
                json.dumps(app_state.scanner.diagnose_mod_states(), ensure_ascii=False, indent=2, default=str),
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
