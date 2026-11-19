"""创意工坊域路由：浏览、详情、订阅差异、更新检查与应用。"""

import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

import app_state
from app_state import _steam_auth_state, download_manager, subs, wb, wsu
from services.mod_scanner import invalidate_scan_cache
from services.steam_paths import read_steam_users

router = APIRouter()

# ── 创意工坊更新检查 ──────────────────────────────────────────────────
# 查 Steam 的 time_updated，和本地基线比对，判断已安装的工坊 Mod 有没有新版；
# 更新时直接走下载器覆盖原文件（不依赖 Steam 客户端）。


@router.get("/api/workshop-updates")
def workshop_updates_state():
    """当前「哪些工坊 Mod 有新版本」+ 检查/更新进度（纯本地计算，可随时轮询）。"""
    return wsu().snapshot(app_state.scanner.get_addons_path() or "")


@router.post("/api/workshop-updates/check")
def workshop_updates_check():
    """后台起一次检查（联网查 Steam），立刻返回。"""
    path = app_state.scanner.get_addons_path()
    if not path:
        raise HTTPException(status_code=400, detail="Addons 路径未配置")
    result = wsu().start_check(path)
    if not result.get("ok"):
        raise HTTPException(status_code=409, detail=result.get("error") or "检查失败")
    return result


@router.post("/api/workshop-updates/cancel")
def workshop_updates_cancel():
    """停止正在进行的检查。已查到的结果照常保留，不用等整轮跑完。"""
    result = wsu().cancel_check()
    if not result.get("ok"):
        raise HTTPException(status_code=409, detail=result.get("error") or "取消失败")
    return result


@router.post("/api/workshop-updates/apply")
def workshop_updates_apply(payload: dict):
    """更新指定条目（重新下载并覆盖本地 vpk）。payload: {ids: [...]} 或 {all: true}。"""
    path = app_state.scanner.get_addons_path()
    if not path:
        raise HTTPException(status_code=400, detail="Addons 路径未配置")
    p = payload or {}
    ids = p.get("ids")
    if p.get("all"):
        snap = wsu().snapshot(path)
        ids = [i["workshop_id"] for i in snap["items"] if i["update_available"]]
    result = wsu().start_apply(ids or [], path)
    if not result.get("ok"):
        raise HTTPException(status_code=409, detail=result.get("error") or "更新失败")
    return result


@router.post("/api/workshop-updates/apply/cancel")
def workshop_updates_apply_cancel():
    """停止正在进行的更新。

    已下载完成的包保留（它们本来就是新版本），当前这个在下一个分块边界退出，
    不会留下半个 vpk —— download_one 的取消路径会丢弃临时文件。
    """
    result = wsu().cancel_apply()
    if not result.get("ok"):
        raise HTTPException(status_code=409, detail=result.get("error") or "取消失败")
    return result


# ── 创意工坊浏览器（自写，不再依赖内嵌网页）──────────────────────────────
# 两条数据路径由 services/workshop_browse.py 内部决定：
#   * 没填 Steam API Key → 抓工坊网页拿 ID，再用免 key 的详情接口补字段（30 条/页）
#   * 填了 key          → QueryFiles，100 条/页、带评分、有精确总数
# 界面不关心走哪条，只按返回里的 source/page_size 显示。


@router.get("/api/workshop/meta")
def workshop_meta():
    """筛选项、排序项、当前是否配了 key（前端首次渲染用）。"""
    return wb().meta()


@router.get("/api/workshop/browse")
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
        return wb().browse(filters, page, app_state.scanner.get_addons_path())
    except wb().WorkshopError as e:
        # 400 + 一句能照做的话：前端直接把 detail 显示在列表位置，不弹裸异常
        # redact 是最后一道闸：错误文本里绝不允许出现完整 key
        raise HTTPException(status_code=400, detail=wb().redact(str(e)))


@router.get("/api/workshop/item/{wid}")
def workshop_item(wid: str):
    """单个条目的完整详情：完整描述 + 图集（多图）+ 依赖项。

    抽屉打开时才调。带 addons 路径是为了给依赖项标「已下载 / 未下载」。
    """
    try:
        return wb().item_detail(wid, app_state.scanner.get_addons_path())
    except wb().WorkshopError as e:
        raise HTTPException(status_code=400, detail=wb().redact(str(e)))


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


@router.get("/api/workshop/subscription-diff")
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
        subs().clear_cache()
    try:
        return subs().diff(steam_id, app_state.scanner.get_addons_path())
    except subs().SubscriptionError as e:
        raise HTTPException(status_code=400, detail=wb().redact(str(e)))


@router.post("/api/workshop/subscriptions/sync")
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
        res = download_manager().add_targets("\n".join(dl_ids))
        added = len(res.get("added") or [])
        ignored = len(res.get("ignored") or [])

    deleted = 0
    failed: list[dict] = []
    if rm_ids:
        addons = app_state.scanner.get_addons_path()
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
                ok = app_state.scanner.delete_mod(target.name, path_hint=str(target))
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


@router.post("/api/workshop-updates/settings")
def workshop_updates_settings(payload: dict):
    """自动检查开关与检查间隔（小时）。"""
    p = payload or {}
    return wsu().save_settings(p.get("auto_check"), p.get("interval_hours"))
