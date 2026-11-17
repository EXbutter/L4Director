"""Steam 账号的工坊订阅 ↔ 本地 addons 对账（只读，**不写订阅**）。

为什么只读：`ISteamRemoteStorage/SubscribePublishedFile` 要的是用户级 OAuth token，
用 API Key 调用是 403（实测过）。第三方独立应用没有申请这个 token 的入口 ——
Steam OpenID 只返回 steamid，不返回任何令牌。所以订阅/取消订阅只能由用户
在 Steam 客户端完成，这里只负责「告诉界面差了什么」。

读订阅有一个必踩的坑：必须走 `api.steampowered.com`。
中国区端点 `api.steamchina.com` 对这个接口返回 **0 条而且不报错**，
照它显示就是「你一个订阅都没有」——比报错更难查，而且会误导同步逻辑把本地文件全删了。
"""

import threading
import time
from pathlib import Path
from typing import Optional

from . import workshop_browse as wb

SUBSCRIPTIONS_PATH = "/IPublishedFileService/GetUserFiles/v1/"
APP_ID = "550"
MAX_PAGES = 10          # 100 条/页，够 1000 个订阅；再多也没人翻得动
PAGE_SIZE = 100
CACHE_TTL = 300.0       # 首次 4~6 秒（含翻页），5 分钟内不重复打接口

# 国际站优先。两个都试、取「条数更多」的那份：中国区端点会返回空数组。
_HOSTS = ("api.steampowered.com", "api.steamchina.com")

_cache: dict[str, tuple[float, list[dict], int]] = {}
_lock = threading.Lock()


class SubscriptionError(RuntimeError):
    """拿不到订阅列表（没 key / 没有本地账号 / 网络不通）。"""


def _num(v, cast=int):
    try:
        return cast(v)
    except (TypeError, ValueError):
        return 0


def _fetch_page(host: str, key: str, steamid: str, page: int) -> tuple[int, list[dict]]:
    params = {
        'key': key,
        'steamid': steamid,
        'appid': APP_ID,
        'type': 'mysubscriptions',
        'numperpage': str(PAGE_SIZE),
        'page': str(page),
        'return_short_description': 'false',
    }
    data = wb._http_get_json(host, SUBSCRIPTIONS_PATH, params, timeout=25)
    resp = data.get('response') or {}
    return _num(resp.get('total')), (resp.get('publishedfiledetails') or [])


def fetch_subscriptions(key: str, steamid: str) -> tuple[list[dict], int]:
    """把该账号的订阅全部取回来（分页，不带缓存）。

    两台主机都试、取「条数更多」的那份：steamchina 对这个接口返回空数组，
    但 total 也可能是 0 —— 空结果不算数，除非两边都空。
    """
    best_items: list[dict] = []
    best_total = 0
    last_error: Optional[Exception] = None

    for host in _HOSTS:
        items: list[dict] = []
        total = 0
        try:
            total, chunk = _fetch_page(host, key, steamid, 1)
            items.extend(chunk)
            page = 2
            while len(items) < total and chunk and page <= MAX_PAGES:
                _, chunk = _fetch_page(host, key, steamid, page)
                if not chunk:
                    break
                items.extend(chunk)
                page += 1
        except Exception as e:            # noqa: BLE001 —— 换另一台主机继续
            last_error = e
            continue

        if len(items) > len(best_items):
            best_items, best_total = items, max(total, len(items))
        # 国际站已经拿到非空且数量与 total 相符 → 不必再问中国站（省一次 4 秒）
        if best_items and len(best_items) >= best_total:
            break

    if not best_items and last_error is not None:
        raise SubscriptionError(wb.redact(f'读订阅列表失败：{type(last_error).__name__}'))
    return best_items, best_total


def subscriptions(steamid: str) -> tuple[list[dict], int]:
    """带 5 分钟缓存的订阅列表。"""
    with _lock:
        hit = _cache.get(steamid)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1], hit[2]

    key = wb.get_api_key()
    if not key:
        raise SubscriptionError('读取 Steam 订阅需要先填 Steam API Key（设置 → Steam API Key）')

    items, total = fetch_subscriptions(key, str(steamid))
    with _lock:
        _cache[steamid] = (time.time(), items, total)
    return items, total


def clear_cache() -> None:
    """订阅缓存作废（用户点「重新检查」时用）。"""
    with _lock:
        _cache.clear()


def local_workshop_files(addons_path: Optional[str]) -> dict[str, Path]:
    """本地 `addons/workshop` 下的工坊文件：id → vpk 路径。

    只认 `<纯数字>.vpk`。目录形式的（老版本解包出来的）不参与对账 ——
    同步会删文件，宁可漏删，也不能让一个认错路径把整目录删了。
    """
    out: dict[str, Path] = {}
    if not addons_path:
        return out
    ws = Path(addons_path) / 'workshop'
    if not ws.is_dir():
        return out
    try:
        for p in ws.glob('*.vpk'):
            if p.is_file() and p.stem.isdigit():
                out[p.stem] = p
    except OSError:
        pass
    return out


def diff(steamid: str, addons_path: Optional[str]) -> dict:
    """拉订阅列表 + 扫本地，算出差异（只读，不动任何文件）。

    - `to_download`：订阅了但本地没有 → 界面拿去排下载队列；
    - `to_delete`  ：本地有但订阅列表里没有（取消订阅 / 被作者隐藏）→ 可以删掉。

    `to_download` 按订阅时间倒序：用户刚在 Steam 里点的那几个通常最先想下。
    """
    items, total = subscriptions(str(steamid))
    local = local_workshop_files(addons_path)

    subs: dict[str, dict] = {}
    for raw in items:
        wid = str(raw.get('publishedfileid') or '')
        if not wid:
            continue
        subs[wid] = {
            'id': wid,
            'title': (raw.get('title') or '').strip(),
            'size': _num(raw.get('file_size')),
            'preview_url': raw.get('preview_url') or '',
            'subscribed_at': _num(raw.get('time_subscribed')),
        }

    to_download = [v for k, v in subs.items() if k not in local]
    to_download.sort(key=lambda x: (-x['subscribed_at'], x['title'].lower()))

    to_delete = []
    for wid, path in local.items():
        if wid in subs:
            continue
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        to_delete.append({'id': wid, 'name': path.name, 'size': size, 'path': str(path)})
    to_delete.sort(key=lambda x: x['id'])

    return {
        'steam_id': str(steamid),
        'total_subscribed': total or len(subs),
        'total_local': len(local),
        'in_sync': len(subs.keys() & local.keys()),
        'to_download': to_download,
        'to_delete': to_delete,
    }
