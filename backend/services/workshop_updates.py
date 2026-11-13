"""创意工坊 Mod 更新检查 / 就地更新。

为什么不用 Steam 客户端：L4D2 的工坊条目都由 Steam 下载到
`addons/workshop/<id>.vpk`，但 Steam 只有在「订阅被改动 / 启动游戏」时才拉新版本，
用户平时没有感知。这里直接查 Steam 的公开接口拿条目的 `time_updated`，
和本地文件的「上次对齐基线」比一下就知道有没有新版；要更新时直接走
`workshop_downloader.download_one` 重新下载并覆盖原文件 —— 一条链路，不依赖
登录，也不需要用户在 Steam 里点来点去。

判定口径（重点，避免「一开软件几十个 Mod 全报有更新」）：

* 每个条目第一次被看到时，把基线直接对齐到远端 `time_updated`，
  同时用文件 mtime 粗判一次（`本地时间 + 容差 < 远端时间` 才算过期）。
  这样新装/新订阅的 Mod 不会一上来就被标成可更新。
* 之后只要远端 `time_updated` 超过基线（容差 2 分钟，防时钟漂移），就算有新版本。
* 反向兜底：本地文件 mtime 已经不早于远端更新时间，说明用户刚在别处更新过
  （Steam 自己拉的 / 手动替换的），即使基线还旧也不报 —— 并把基线追平。
* 工坊下架 / 私有化的条目查不到详情，标 `unavailable` 而不是「有更新」。
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Optional

from services import data_store
from services.workshop_downloader import (
    ResolveError,
    download_one,
    fetch_details,
    get_manager as get_download_manager,
)

# ---- 持久化键（都放在 data.json 的 settings 里）----
STATE_KEY = "workshop_update_state"        # 每个条目的基线与上次检查结果
AUTO_KEY = "workshop_auto_check"           # 是否自动检查（默认开）
INTERVAL_KEY = "workshop_check_interval_hours"

DEFAULT_INTERVAL_HOURS = 6
MIN_INTERVAL_HOURS = 1

SLACK = 120          # 秒：mtime 与远端 time_updated 的容差，防时钟漂移/时区误差
BATCH = 100          # 单次 Steam API 最多查询的条目数（接口上限）
# 进度粒度：批次太小会把一次检查拖成一串 TLS 握手，太大则进度只有 0 和 100%。
# 折中成「每个批次最多 100 条，但整体切够 4 段」，88 个 Mod → 22/批，210 个 → 53/批。
PROGRESS_SEGMENTS = 4
UPDATE_THREADS = 16  # 更新下载的分段线程数（比下载页默认 24 稍保守，避免抢满带宽）

# 检查的「不卡死」参数（这几个数值决定了断网时的体感）
BATCH_TIMEOUT = 32       # 单批查询最长等待，超时当作网络卡死直接收尾
CHECK_BUDGET_S = 150     # 整次检查的时间上限，到点无论查到哪都收尾
NET_FAIL_ABORT = 1       # 连续这么多批网络失败就不查了（_api_post 内部已试过所有落路）


# ---------------------------------------------------------------- 条目识别

def _is_wid(text: str) -> bool:
    """像不像一个创意工坊 ID（纯数字，且长度对得上）。"""
    return bool(text) and text.isdigit() and len(text) >= 5


def workshop_id_for(path: Path, is_workshop: bool) -> Optional[str]:
    """从文件路径推断创意工坊 ID。

    L4D2 里工坊文件至少有三种落法，都要认：
      1. `addons/workshop/<id>.vpk`  —— Steam 订阅的标准位置；
      2. `addons/workshop/<id>/<id>.vpk` —— 下载器解包后的目录式写法；
      3. `addons/<id>.vpk` —— 用户把工坊 vpk 直接拖进 addons 根目录。
    文件名是数字就用文件名，否则（目录式）用上级目录名。
    """
    if _is_wid(path.stem):
        return path.stem
    if is_workshop and _is_wid(path.parent.name):
        return path.parent.name
    return None


def collect_installed(addons_path: str) -> dict:
    """枚举磁盘上所有「能认出工坊 ID」的 Mod，按 ID 聚合。

    同一个 ID 可能有多份（addons 根 + workshop 各一份，属于重复安装），
    更新时要把每一份都覆盖掉，否则游戏加载的还是旧的那份。
    """
    out: dict = {}
    if not addons_path:
        return out
    base = Path(addons_path)
    if not base.exists():
        return out

    def add(p: Path, is_ws: bool):
        wid = workshop_id_for(p, is_ws)
        if not wid:
            return
        try:
            st = p.stat()
        except OSError:
            return
        e = out.setdefault(wid, {
            "workshop_id": wid,
            "paths": [],
            "names": [],
            "local_time": 0,
            "local_size": 0,
        })
        e["paths"].append(str(p))
        e["names"].append(p.name)
        e["local_time"] = max(e["local_time"], int(st.st_mtime))
        e["local_size"] = max(e["local_size"], st.st_size)

    try:
        for p in base.glob("*.vpk"):
            if p.is_file():
                add(p, False)
    except OSError:
        pass

    ws = base / "workshop"
    if ws.exists():
        try:
            for p in ws.glob("*.vpk"):
                if p.is_file():
                    add(p, True)
            for d in ws.iterdir():
                if d.is_dir():
                    for p in d.glob("*.vpk"):
                        if p.is_file():
                            add(p, True)
        except OSError:
            pass

    return out


# ---------------------------------------------------------------- 状态存取

def _load_state() -> dict:
    raw = data_store.get_setting(STATE_KEY, None)
    if not isinstance(raw, dict):
        return {"checked_at": 0, "items": {}}
    items = raw.get("items")
    return {
        "checked_at": int(raw.get("checked_at") or 0),
        "items": items if isinstance(items, dict) else {},
    }


def _save_state(checked_at: int, items: dict):
    data_store.set_setting(STATE_KEY, {"checked_at": int(checked_at), "items": items})


# ---------------------------------------------------------------- 服务

class _CheckCancelled(Exception):
    """用户点了取消。单独一个类型，免得和网络错误混在一起提示。"""


class WorkshopUpdateService:
    """检查与更新的单例。所有对外动作都不阻塞请求线程。"""

    def __init__(self):
        self._lock = threading.RLock()
        self._checking = False
        self._last_error = ""
        # 检查进度：前端轮询显示「检查中 3/5」，避免看起来像卡住
        self._cancel = threading.Event()
        self._cancelled = False
        self._check_done = 0
        self._check_total = 0
        self._check_failed = 0
        # 阶段：scan（枚举本地 VPK）→ query（问 Steam）→ compare（比对版本）
        # 一次查询可能不到 1 秒就结束，光有 done/total 前端会看到「0/88 然后完成」，
        # 所以阶段文字得单独暴露出去，让界面在数字之外也有东西可以说。
        self._check_stage = ""
        self._check_started = 0.0
        self._check_batch = 0
        self._check_batches = 0
        # 更新（下载）进度：供前端轮询
        self._running = False
        self._total = 0
        self._done = 0
        self._current = ""
        self._pct = 0.0
        self._errors: list[str] = []
        self._finished_at = 0.0

    # ---------- 设置 ----------
    @staticmethod
    def auto_check_enabled() -> bool:
        v = data_store.get_setting(AUTO_KEY, True)
        return bool(v) if isinstance(v, bool) else True

    @staticmethod
    def interval_hours() -> float:
        v = data_store.get_setting(INTERVAL_KEY, DEFAULT_INTERVAL_HOURS)
        try:
            f = float(v)
        except (TypeError, ValueError):
            f = DEFAULT_INTERVAL_HOURS
        return max(MIN_INTERVAL_HOURS, min(f, 24 * 7))

    def save_settings(self, auto_check: Optional[bool], interval_hours: Optional[float]) -> dict:
        if auto_check is not None:
            data_store.set_setting(AUTO_KEY, bool(auto_check))
        if interval_hours is not None:
            try:
                f = float(interval_hours)
            except (TypeError, ValueError):
                f = DEFAULT_INTERVAL_HOURS
            data_store.set_setting(INTERVAL_KEY, max(MIN_INTERVAL_HOURS, min(f, 24 * 7)))
        return {"auto_check": self.auto_check_enabled(), "interval_hours": self.interval_hours()}

    # ---------- 查询 ----------
    def snapshot(self, addons_path: str) -> dict:
        """给前端的当前状态：已安装条目 + 是否有新版 + 更新进度。

        只做本地计算（glob + stat），不发网络请求，前端可以随时轮询。
        """
        installed = collect_installed(addons_path)
        state = _load_state()
        items = []
        for wid, rec in state["items"].items():
            e = installed.get(wid)
            if not e:
                continue  # 已经删掉/移走的条目不再展示
            remote_time = int(rec.get("remote_time") or 0)
            baseline = int(rec.get("baseline") or 0)
            local_time = int(e.get("local_time") or 0)
            # 基线判定 + 本地比远端新则追平（见模块头的判定口径）
            update_available = bool(
                remote_time and baseline
                and remote_time > baseline + SLACK
                and local_time < remote_time - SLACK
            )
            items.append({
                "workshop_id": wid,
                "name": e["names"][0],
                "paths": e["paths"],
                "title": rec.get("title") or "",
                "remote_time": remote_time,
                "local_time": local_time,
                "local_size": e.get("local_size") or 0,
                "remote_size": int(rec.get("size") or 0),
                "update_available": update_available,
                "unavailable": bool(rec.get("unavailable")),
            })
        items.sort(key=lambda x: x["name"].lower())
        with self._lock:
            return {
                "ok": True,
                "checked_at": state["checked_at"],
                "checking": self._checking,
                "cancelled": self._cancelled,
                "check_progress": {
                    "done": self._check_done,
                    "total": self._check_total,
                    "failed": self._check_failed,
                    "stage": self._check_stage,
                    "started_at": self._check_started,
                    "batch": self._check_batch,
                    "batches": self._check_batches,
                },
                "last_error": self._last_error,
                "auto_check": self.auto_check_enabled(),
                "interval_hours": self.interval_hours(),
                "items": items,
                "update_count": sum(1 for i in items if i["update_available"]),
                "applying": {
                    "running": self._running,
                    "total": self._total,
                    "done": self._done,
                    "current": self._current,
                    "pct": round(self._pct, 1),
                    "errors": list(self._errors),
                    "finished_at": self._finished_at,
                },
            }

    # ---------- 检查更新 ----------
    def _reset_check_progress(self):
        """把检查进度相关字段清干净（进 checked 前后各调一次）。"""
        self._check_done = 0
        self._check_total = 0
        self._check_failed = 0
        self._check_stage = ""
        self._check_started = 0.0
        self._check_batch = 0
        self._check_batches = 0

    def start_check(self, addons_path: str) -> dict:
        """后台起一次检查，立刻返回；前端轮询 snapshot 看进度。

        已经在查的时候不报错，直接挂到正在跑的那一次上（返回 already=True）：
        启动 8 秒后后端会自己查一次，用户这时点「检查更新」不该弹一句「正在检查中」。
        """
        with self._lock:
            if self._checking:
                return {"ok": True, "already": True, "total": self._check_total}
            self._checking = True
            self._cancelled = False
            self._cancel.clear()
            self._reset_check_progress()
            self._check_stage = "scan"
            self._check_started = time.time()
        threading.Thread(target=self._check_worker, args=(addons_path,),
                         daemon=True, name="workshop-update-check").start()
        return {"ok": True}

    def cancel_check(self) -> dict:
        """请求停止正在进行的检查。

        只是置一个标志：正在跑的批次会在几毫秒内退出，已经查到的结果照常落盘，
        用户不用等一次完整的（可能很慢的）检查跑完。
        """
        with self._lock:
            if not self._checking:
                return {"ok": False, "error": "当前没有正在进行的检查"}
            self._cancel.set()
        return {"ok": True}

    def check_now(self, addons_path: str, log=None) -> dict:
        """同步检查（自动检查线程 / 测试用）。"""
        with self._lock:
            if self._checking:
                return {"ok": False, "error": "正在检查中"}
            self._checking = True
            self._cancelled = False
            self._cancel.clear()
            self._reset_check_progress()
            self._check_stage = "scan"
            self._check_started = time.time()
        try:
            return self._check_impl(addons_path, log=log)
        finally:
            with self._lock:
                self._checking = False
                self._check_stage = ""
                self._check_started = 0.0

    def _check_worker(self, addons_path: str):
        try:
            self._check_impl(addons_path)
        except Exception as e:  # 后台线程不能把异常抛给谁，记下来给界面看
            self._last_error = f"{type(e).__name__}: {e}"
            print(f"[WsUpdate] check failed: {self._last_error}")
        finally:
            with self._lock:
                self._checking = False
                self._check_stage = ""
                self._check_started = 0.0

    def _fetch_chunk(self, chunk) -> list:
        """查一批条目，带超时和取消。

        放到独立线程里等，是因为 socket/DNS 有可能整段卡住（加速器关了但 hosts
        残留时尤其明显）。有了这层，检查线程永远能按时收尾，「检查中…」不会
        一直转下去。
        """
        box: dict = {"items": None, "error": None}

        def run():
            try:
                box["items"] = fetch_details(chunk)
            except Exception as e:  # noqa: BLE001 —— 原样带回调用线程判断
                box["error"] = e

        t = threading.Thread(target=run, daemon=True, name="wsapi-batch")
        t.start()
        deadline = time.time() + BATCH_TIMEOUT
        while t.is_alive() and time.time() < deadline:
            if self._cancel.is_set():
                raise _CheckCancelled()
            t.join(0.2)
        if t.is_alive():
            raise ResolveError(f"查询超时（{BATCH_TIMEOUT} 秒没有响应）")
        if box["error"] is not None:
            e = box["error"]
            if isinstance(e, ResolveError):
                raise e
            raise ResolveError(f"调用 Steam API 失败: {type(e).__name__}: {e}")
        return box["items"] or []

    def _check_impl(self, addons_path: str, log=None) -> dict:
        log = log or (lambda _m: None)
        with self._lock:
            self._check_stage = "scan"
        entries = collect_installed(addons_path)
        with self._lock:
            self._check_total = len(entries)
            self._check_done = 0
            self._check_failed = 0
        if not entries:
            _save_state(int(_load_state().get("checked_at") or 0), {})
            self._last_error = ""
            return {"ok": True, "checked": 0, "update_count": 0}

        ids = sorted(entries)
        # 批次大小决定进度有几档：一次问 88 个的话界面上只能看到 0/88 然后一下子完成。
        # 切成 4 段左右，每段又不超过接口上限 100，代价只是多几次请求。
        batch = min(BATCH, max(20, -(-len(ids) // PROGRESS_SEGMENTS)))
        with self._lock:
            self._check_stage = "query"
            self._check_batches = -(-len(ids) // batch)
            self._check_batch = 0
        log(f"[检查] {len(ids)} 个创意工坊 Mod，分 {self._check_batches} 批查询 Steam…")
        remote: dict = {}
        queried: set = set()   # 真正拿到过响应的条目，用来区分「下架」和「没查成」
        failed_batches = 0
        consecutive = 0
        aborted = ""       # 提前收尾的原因：'cancelled' | 'network' | 'budget'
        started = time.time()

        for i in range(0, len(ids), batch):
            if self._cancel.is_set():
                aborted = "cancelled"
                break
            if time.time() - started > CHECK_BUDGET_S:
                aborted = "budget"
                self._last_error = f"检查超时（超过 {CHECK_BUDGET_S} 秒），已保留查到的部分结果"
                log(f"[检查] {self._last_error}")
                break
            chunk = ids[i:i + batch]
            with self._lock:
                self._check_batch = i // batch + 1
            try:
                for it in self._fetch_chunk(chunk):
                    remote[str(it.get("publishedfileid"))] = it
                queried.update(chunk)
                consecutive = 0
            except _CheckCancelled:
                aborted = "cancelled"
                break
            except ResolveError as e:
                # _api_post 内部已经把直连和系统解析都试过了，再换一批也不会好，
                # 断网时立刻收尾，别让用户对着「检查中…」等好几分钟
                failed_batches += 1
                consecutive += 1
                self._last_error = str(e)
                log(f"[检查] 第 {i // batch + 1} 批失败：{e}")
                if consecutive >= NET_FAIL_ABORT:
                    aborted = "network"
                    break
            with self._lock:
                self._check_done = min(i + len(chunk), len(ids))
                self._check_failed = failed_batches
            if i + batch < len(ids):
                time.sleep(0.15)  # 轻微节流，别把公开接口当自家服务器刷

        with self._lock:
            self._check_stage = "compare"

        if aborted == "cancelled":
            with self._lock:
                self._cancelled = True
            self._last_error = ""
            log(f"[检查] 已取消（已查 {len(remote)} 个条目）")
        elif aborted == "network":
            with self._lock:
                self._cancelled = False

        state = _load_state()
        known = state["items"]
        now = int(time.time())
        new_items: dict = {}
        update_count = 0

        for wid in ids:
            e = entries[wid]
            rec = known.get(wid) or {}
            local_time = int(e.get("local_time") or 0)
            r = remote.get(wid)

            if not r:
                # 这批真查到了响应、条目却不在里面：下架 / 私有化，标不可用。
                # 而这批根本没查成（断网、取消、超时）时不能这么标 —— 否则一断网
                # 所有工坊 Mod 会一起变成「已下架」，比查不出来更吓人。
                if wid in queried:
                    if rec:
                        rec = dict(rec)
                        rec["unavailable"] = True
                        new_items[wid] = rec
                elif rec:
                    new_items[wid] = rec
                continue

            remote_time = int(r.get("time_updated") or 0)
            baseline = int(rec.get("baseline") or 0)
            if baseline <= 0:
                # 第一次见：先用本地时间粗判，再把基线对齐到「本地实际拿到的版本」。
                # 只在没过期时对齐到远端 —— 如果本地本来就旧，基线要留旧值，
                # 否则下一次 snapshot 会因为基线已被追平而把「可更新」自己抹掉。
                need = remote_time - local_time > SLACK
                baseline = remote_time if not need else local_time
            else:
                need = remote_time > baseline + SLACK
                if local_time and local_time >= remote_time - SLACK:
                    need = False      # 本地已经比远端新（用户刚更新过）
                if not need:
                    baseline = remote_time

            if need:
                update_count += 1
            new_items[wid] = {
                "title": (r.get("title") or "").strip(),
                "baseline": baseline,
                "remote_time": remote_time,
                "size": int(r.get("file_size") or 0),
                "checked_at": now,
                "unavailable": False,
            }

        # 全部批次都失败时不要把 checked_at 往前推，否则自动检查会被「静默」
        # 跳过一个完整周期，用户很久都发现不了自己其实没连上网。
        checked_at = now if (remote or failed_batches == 0) else int(state.get("checked_at") or 0)
        _save_state(checked_at, new_items)
        # 只有整轮跑完才清错误：中途断网/超时的提示要留着，用户才知道该去查网络
        if remote and not aborted:
            self._last_error = ""
        log(f"[检查] 完成：{update_count} 个可更新（共 {len(ids)} 个工坊 Mod）"
            + ("，中途停止" if aborted else ""))
        return {
            "ok": True,
            "checked": len(ids),
            "update_count": update_count,
            "cancelled": aborted == "cancelled",
            "partial": bool(aborted),
        }

    # ---------- 更新（覆盖下载）----------
    def start_apply(self, wids: list, addons_path: str) -> dict:
        wids = [str(w) for w in (wids or []) if str(w).strip()]
        if not wids:
            return {"ok": False, "error": "没有指定要更新的 Mod"}
        with self._lock:
            if self._running:
                return {"ok": False, "error": "正在更新中，请等当前任务结束"}
            # 下载页可能正在批量下载：两边同时抢带宽只会都变慢，报错让用户先等一边
            try:
                if get_download_manager().running:
                    return {"ok": False, "error": "下载页有任务在运行，请等它结束后再更新"}
            except Exception:
                pass
            self._running = True
            self._total = len(wids)
            self._done = 0
            self._current = ""
            self._pct = 0.0
            self._errors = []
            self._finished_at = 0.0
        threading.Thread(target=self._apply_worker, args=(wids, addons_path),
                         daemon=True, name="workshop-update-apply").start()
        return {"ok": True, "total": len(wids)}

    def _on_prog(self, p: dict):
        with self._lock:
            if p.get("pct") is not None:
                self._pct = float(p["pct"])

    def _apply_worker(self, wids: list, addons_path: str):
        entries = collect_installed(addons_path)
        state = _load_state()
        items_state = dict(state["items"])
        checked_at = int(state.get("checked_at") or 0)
        try:
            details: dict = {}
            for i in range(0, len(wids), BATCH):
                chunk = wids[i:i + BATCH]
                try:
                    for it in fetch_details(chunk):
                        details[str(it.get("publishedfileid"))] = it
                except ResolveError as e:
                    with self._lock:
                        self._errors.append(f"获取条目信息失败：{e}")
                    return

            for wid in wids:
                e = entries.get(wid)
                item = details.get(wid)
                if not e:
                    with self._lock:
                        self._errors.append(f"{wid}: 本地找不到对应文件")
                    continue
                if not item or not item.get("file_url"):
                    with self._lock:
                        self._errors.append(
                            f"{wid}: 该条目没有可下载的文件（可能已下架或属于合集）")
                    continue

                title = (item.get("title") or "").strip() or wid
                with self._lock:
                    self._current = title
                    self._pct = 0.0
                ok_any = False
                for path in e["paths"]:
                    outdir = os.path.dirname(path)
                    try:
                        result = download_one(
                            item, outdir, UPDATE_THREADS, True,
                            log=lambda m: print(f"[WsUpdate] {m}"),
                            prog=self._on_prog,
                            cancel=None,
                        )
                    except Exception as ex:
                        with self._lock:
                            self._errors.append(f"{title}: {type(ex).__name__}: {ex}")
                        continue
                    if result not in ("done", "skip"):
                        with self._lock:
                            self._errors.append(f"{title}: 下载未完成（{result}）")
                        continue
                    # download_one 按 <id>.vpk 命名落盘；若原文件叫别的名字
                    # （工坊目录里偶尔是作者的文件名），覆盖回原位而不是多留一份
                    downloaded = os.path.join(outdir, wid + ".vpk")
                    if os.path.basename(path) != wid + ".vpk" and os.path.exists(downloaded):
                        try:
                            os.replace(downloaded, path)
                        except OSError as ex:
                            with self._lock:
                                self._errors.append(f"{title}: 覆盖原文件失败 {ex}")
                            continue
                    ok_any = True

                if ok_any:
                    # 基线追平到这次拿到的版本，下次检查就不会再报同一个更新
                    items_state[wid] = {
                        "title": title,
                        "baseline": int(item.get("time_updated") or 0),
                        "remote_time": int(item.get("time_updated") or 0),
                        "size": int(item.get("file_size") or 0),
                        "checked_at": int(time.time()),
                        "unavailable": False,
                    }
                with self._lock:
                    self._done += 1
                    self._pct = 0.0
        finally:
            _save_state(checked_at, items_state)
            with self._lock:
                self._running = False
                self._current = ""
                self._finished_at = time.time()

    # ---------- 自动检查 ----------
    def maybe_auto_check(self, addons_path: str, delay: float = 8.0):
        """启动时按「开关 + 间隔」决定要不要跑一次检查。"""
        if not addons_path or not self.auto_check_enabled():
            return
        last = int(_load_state().get("checked_at") or 0)
        if last and (time.time() - last) < self.interval_hours() * 3600:
            return

        def run():
            time.sleep(delay)  # 让首次扫描先跑完，别和 VPK 解析抢 CPU/网络
            try:
                self.check_now(addons_path)
            except Exception as e:
                print(f"[WsUpdate] auto check failed: {type(e).__name__}: {e}")

        threading.Thread(target=run, daemon=True, name="workshop-auto-check").start()


_service: Optional[WorkshopUpdateService] = None
_service_lock = threading.Lock()


def get_service() -> WorkshopUpdateService:
    global _service
    if _service is None:
        with _service_lock:
            if _service is None:
                _service = WorkshopUpdateService()
    return _service
