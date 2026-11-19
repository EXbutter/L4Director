"""Steam 安装路径与本地账号读取。

从 main.py 抽出来：auth 域（登录/头像）与 game 域（通过 Steam 协议启动游戏）
都要用，放 router 里会变成「router 互相 import」。
"""
import os
from pathlib import Path
from typing import Optional


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
            except Exception:
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
    print("[Steam] Steam installation not found in any candidate path")
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
        print("[Steam] loginusers.vdf not found at expected path")
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
