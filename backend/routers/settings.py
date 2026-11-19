"""设置域路由：addons 路径、Steam API Key。"""

import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

import app_state
from app_state import wb, wsu

router = APIRouter()

@router.get("/api/settings")
def get_settings():
    """获取当前设置"""
    return {
        "addons_path": app_state.scanner.get_addons_path(),
    }


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


@router.post("/api/settings/addons-path")
def set_addons_path(data: dict):
    """设置 addons 路径"""
    path = data.get("path", "")
    
    if not path:
        raise HTTPException(status_code=400, detail="Path is required")
    
    normalized_path = os.path.normpath(path.strip())
    print(f"[SetPath] Original: '{path}' -> Normalized: '{normalized_path}'")
    print(f"[SetPath] Exists: {os.path.exists(normalized_path)}")
    print(f"[SetPath] Is dir: {os.path.isdir(normalized_path)}")
    
    success = app_state.scanner.set_addons_path(normalized_path)
    if not success:
        raise HTTPException(status_code=400, detail=f"Invalid path: {normalized_path}")

    # 首次配置路径时补一次工坊更新检查：启动时的自动检查因为当时还没有路径而跳过了
    try:
        wsu().maybe_auto_check(normalized_path)
    except Exception as _e:
        print(f"[WsUpdate] auto check after path set failed: {_e}")

    # 带回 VPK 数量：路径合法但一个包都没有时（选错层级、选了空目录），
    # 界面要能说「已保存，但这个目录里没有 Mod」，而不是干巴巴的「已保存 ✓」。
    return {
        "status": "ok",
        "addons_path": normalized_path,
        "vpk_count": _count_vpks(Path(normalized_path)),
    }


@router.post("/api/settings/auto-detect")
def auto_detect_path():
    """自动检测 addons 路径"""
    path = app_state.scanner.auto_detect_addons_path()
    if path:
        return {"status": "ok", "addons_path": path, "vpk_count": _count_vpks(Path(path))}
    raise HTTPException(
        status_code=404,
        detail="没找到《求生之路 2》的 addons 目录，请在下面手动选择一次",
    )


@router.get("/api/settings/steam-key")
def get_steam_key():
    """只返回是否配置 + 指纹，永远不把 key 原样回传给界面。"""
    return wb().key_status()


@router.post("/api/settings/steam-key")
def set_steam_key(payload: dict):
    """保存 key（空字符串 = 清除）。保存前先验一次，避免存进去一个无效 key。"""
    key = ((payload or {}).get("key") or "").strip()
    try:
        if key:
            tested = wb().verify_key(key)
        else:
            tested = None
        state = wb().set_api_key(key)
    except wb().WorkshopError as e:
        raise HTTPException(status_code=400, detail=wb().redact(str(e)))
    wb().clear_cache()
    return {**state, "test": tested}


@router.post("/api/settings/steam-key/test")
def test_steam_key(payload: dict):
    """试一下这把 key 能不能用（不保存）。返回实测耗时，用户能看到「能用且多快」。"""
    key = ((payload or {}).get("key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="先填一个 key 再测试")
    try:
        return wb().verify_key(key)
    except wb().WorkshopError as e:
        raise HTTPException(status_code=400, detail=wb().redact(str(e)))
