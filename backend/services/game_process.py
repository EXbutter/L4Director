"""游戏进程检测：探活（tasklist）+ 2 秒缓存 + 「退出后以软件设置为准重新写回」。

从 main.py 抽出来，因为三个域都要用它：mods（启停时判断游戏是否在跑）、
packs（整包启用）、game（状态查询与启动）。放在 router 里会变成 router 互相 import。
"""
import os
import subprocess
import threading
import time
from typing import Optional

from app_state import scanner
from services.data_store import get_pending_game_reapply, set_pending_game_reapply

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


def detect_game_process() -> tuple[bool, Optional[int]]:
    """检测 L4D2 进程是否在运行，返回 (是否运行, PID)。

    注意：tasklist 的输出会随系统语言变化（中文系统是「信息: 没有运行的任务匹配指定标准」），
    所以这里只判断输出里有没有出现进程名（纯 ASCII，不受代码页影响），而不是去匹配提示语。
    """
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


def recent_status() -> dict:
    """读缓存快照（不触发探活）。返回 {'time','running','pid'} 的副本。"""
    with _game_status_lock:
        return dict(_game_status_cache)


def is_cache_fresh(snapshot: Optional[dict] = None) -> bool:
    """快照是否还在 2 秒 TTL 内（launch_game 用它判断「已经在跑」）。"""
    snap = snapshot if snapshot is not None else recent_status()
    return (time.time() - snap.get("time", 0.0)) < _GAME_STATUS_CACHE_TTL


def game_is_running_cached() -> bool:
    """游戏是否在运行（复用 2 秒缓存，避免每次启停都额外拉一次 tasklist）。

    缓存命中时只碰一次内存，不持锁做子进程调用 —— 这条会被每一次 Mod 启停调到。
    """
    with _game_status_lock:
        if time.time() - _game_status_cache["time"] < _GAME_STATUS_CACHE_TTL:
            return bool(_game_status_cache["running"])
    with _game_probe_lock:
        with _game_status_lock:
            if time.time() - _game_status_cache["time"] < _GAME_STATUS_CACHE_TTL:
                return bool(_game_status_cache["running"])
        running, pid = detect_game_process()
        with _game_status_lock:
            _game_status_cache.update({"time": time.time(), "running": running, "pid": pid})
        return running


def mark_pending_reapply_if_game_running():
    """游戏运行期间改启停 → 打个标记，游戏退出后以软件设置为准重新写回文件。"""
    try:
        if game_is_running_cached():
            set_pending_game_reapply(True)
    except Exception as e:
        print(f"[GameStatus] Failed to mark pending reapply: {e}")


def reapply_prefs_after_game_exit() -> Optional[int]:
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


def query_status() -> dict:
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
        # _game_status_lock，而每次 Mod 启停都会走 game_is_running_cached ——
        # 表现就是「点开关要愣好几秒」。现在锁只保护那几行内存赋值。
        # _game_probe_lock 只负责「同一时刻只有一个线程在拉 tasklist」，不阻塞读缓存。
        with _game_probe_lock:
            with _game_status_lock:
                still_fresh = time.time() - _game_status_cache["time"] < _GAME_STATUS_CACHE_TTL
            if not still_fresh:
                running, pid = detect_game_process()
                if not running:
                    # 游戏不在运行：只要还留着「运行期间改过设置」的标记就纠正一次。
                    # 这样既覆盖「游戏退出时软件正开着」的情况，也覆盖「软件没开着、
                    # 游戏退出把旧状态写回了文件」的情况（标记会保留到下次启动软件）。
                    reapplied = reapply_prefs_after_game_exit()
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
