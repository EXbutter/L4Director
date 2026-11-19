"""Steam 账号域路由：登录 / 登出、状态与头像代理。"""

import base64
import os
import re
import threading
import time
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app_state import _steam_auth_state
from services.steam_paths import get_steam_install_path, read_steam_users

router = APIRouter()

# In-memory store for Steam auth state

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


# ===== Steam Local Authentication =====


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


@router.post("/api/auth/steam/login")
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


@router.get("/api/auth/steam/avatar")
def steam_avatar():
    """Proxy Steam avatar image（内存缓存 + 短超时；失败返回 1×1 透明像素）"""

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


@router.get("/api/auth/steam/status")
def steam_status():
    """Check current Steam authentication status"""
    return {
        "authenticated": _steam_auth_state["authenticated"],
        "user": _steam_auth_state["user"],
    }


@router.post("/api/auth/steam/logout")
def steam_logout():
    """Logout Steam session"""
    _steam_auth_state["authenticated"] = False
    _steam_auth_state["user"] = None
    return {"status": "ok"}
