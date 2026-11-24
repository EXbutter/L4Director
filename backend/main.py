"""L4D2 Mod Manager - Backend API

重构后 main.py 只负责「应用装配 + 启动」，不再内联任何 HTTP 路由：

- 业务逻辑：``services/``
- HTTP 边界（按域拆分）：``routers/*.py``
- 进程级共享状态（scanner / 版本号 / Steam 登录态 / service 访问器）：``app_state.py``
- 应用工厂：``create_app()``（测试与生产共用同一套装配）

以前这里是 2000 多行的单体，69 条路由直接挂在模块级 ``app`` 上；拆成 routers 后
``create_app()`` 成为唯一装配入口，生产用 ``app = create_app()`` 装配一份，测试也调它。
"""
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
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import app_state
# 全局唯一的扫描器实例：lifespan / 启动校正与各 router 共用同一份（见 app_state 注释）。
# 以前 main 里又 `scanner = ModScanner()` new 了第二个实例，拆出 routers 后会造成
# 「路由读 app_state.scanner、启动逻辑读 main.scanner」两份缓存各自漂移，故统一到这里。
from app_state import scanner
from services.data_store import get_prefs_dirty, set_prefs_dirty
from services.game_process import game_is_running_cached

# 版本号统一由 Electron 主进程通过 L4DIRECTOR_APP_VERSION 传入。
# 默认值只在「直接 python main.py 跑后端」时用到，且必须**唯一一份**（复用 app_state，
# 避免 FastAPI 与 /api/health 两处默认值长期不一致）。
_DEFAULT_APP_VERSION = app_state._DEFAULT_APP_VERSION
APP_VERSION = app_state.APP_VERSION


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


def create_app() -> FastAPI:
    """构造一个已装配全部域路由的 FastAPI 应用。

    这是重构后**唯一**的应用装配入口：每个 routers/*.py 只负责一个域的 HTTP 边界，
    业务逻辑在 services/ 下，进程级共享状态集中在 app_state。此函数把 9 个域路由
    装到同一个 app，并挂上同样的 CORS 与 lifespan。

    测试用 ``create_app()`` 得到干净的 app（配合 monkeypatch 替换 app_state.scanner）；
    生产由 ``app = create_app()`` 装配一份。
    """
    from routers import (
        auth as auth_router,
        download as download_router,
        game as game_router,
        media as media_router,
        mods as mods_router,
        packs as packs_router,
        settings as settings_router,
        system as system_router,
        workshop as workshop_router,
    )

    _app = FastAPI(
        title="L4D2 Mod Manager API",
        version=APP_VERSION,
        description="Left 4 Dead 2 Mod Manager Backend",
        lifespan=_app_lifespan,
    )
    _app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for _mod in (
        auth_router, download_router, game_router, media_router, mods_router,
        packs_router, settings_router, system_router, workshop_router,
    ):
        _app.include_router(_mod.router)
    return _app


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
        if game_is_running_cached():
            return
        if scanner.prefs_in_sync_with_addonlist():
            set_prefs_dirty(False)
            print("[Prefs] Cleared stale 'unapplied' flag: addonlist.txt already in sync")
    except Exception as e:
        print(f"[Prefs] Startup reconcile skipped: {e}")


# 生产应用：唯一装配入口（69 条路由全部来自 routers/*.py）
app = create_app()


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

    # 后台定时自动备份 addonlist.txt（开关 / 间隔 / 保留数量由「设置 → Addonlist 备份」控制）。
    # 放在 main() 而不是 create_app()：测试只调 create_app()，不应因定时器凭空产生备份。
    scanner.start_addonlist_backup_scheduler()

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
