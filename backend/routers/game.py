"""游戏域路由：进程状态查询（含退出后重新应用设置）与启动。"""
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException

import app_state
from services.game_process import (
    is_cache_fresh,
    query_status,
    recent_status,
)
from services.steam_paths import get_steam_install_path

router = APIRouter()


@router.get("/api/game/status")
def get_game_status():
    """查询 L4D2 是否正在运行（供启动按钮展示「正在启动 / 游戏中」状态）。

    同时承担「游戏退出后把软件设置重新写回 addonlist.txt」的职责：
    游戏退出时会用**它内存里**的启停状态覆盖该文件，把用户运行期间在软件里
    刚做的改动顶掉（用户反馈：全部禁用后仍有 33 个 Mod 是启用、刷新还弹
    「检测到游戏内已启用」）。只要运行期间改过，就在进程消失的这一刻纠正回来。
    """
    return query_status()


@router.post("/api/game/launch")
def launch_game():
    """启动 L4D2 游戏（通过 Steam 协议启动，避免 VAC -insecure 警告）"""
    # 游戏已经在跑：直接返回，避免重复拉起一个实例
    snapshot = recent_status()
    if snapshot["running"] and is_cache_fresh(snapshot):
        return {
            "status": "ok",
            "message": "游戏已经在运行中",
            "method": "already-running",
            "already_running": True,
            "pid": snapshot["pid"],
        }

    addons_path = app_state.scanner.get_addons_path()
    if not addons_path:
        raise HTTPException(status_code=400, detail="请先配置 Addons 目录")

    # 启动前把软件里记录的 mod 启用状态写回 addonlist.txt：
    # 游戏（或 Steam 云同步）会改写该文件，若不同步，用户在软件里的禁用设置
    # 就会在启动游戏后被「反向覆盖」（用户反馈：禁用后启动游戏，再打开软件又变回启用）。
    try:
        app_state.scanner.apply_mod_prefs_to_addonlist()
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
