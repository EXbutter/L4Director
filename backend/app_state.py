"""后端进程级共享状态。

为什么单独一个模块：main.py 拆成 routers/*.py 之后，ModScanner 必须是**同一个实例**
（它持有上次扫描结果、冲突指纹与磁盘缓存句柄），各 router 与 lifespan 不能各自
再 new 一个 —— 否则每进一个页面就少一次缓存命中，扫描耗时直接退化到冷启动水平。

同理，跨域可读的内存状态放这里：Steam 登录态（auth 写入、workshop 读取）、
应用版本号（唯一一份，见下方注释）、后端目录（导出日志时定位日志文件）。

约定：本模块**只放状态与极轻量的取用函数**，不放业务逻辑，避免它变成新的 god module。
"""
import os

from services.mod_scanner import ModScanner

# 后端目录（main.py 所在目录）：导出日志要按它定位 backend_output.log
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

# 版本号统一由 Electron 主进程通过 L4DIRECTOR_APP_VERSION 传入。
# 这里的默认值只在「直接 python main.py 跑后端」时用到，但必须是**唯一一份** ——
# 以前 FastAPI 与 /api/health 各写一个默认值（1.1.0 / 1.2.0），两边长期不一致，
# 排查线上问题时没法确认对面到底是哪个版本。
_DEFAULT_APP_VERSION = "1.3.4"
APP_VERSION = os.environ.get("L4DIRECTOR_APP_VERSION", _DEFAULT_APP_VERSION)

# 全局唯一的扫描器实例
scanner = ModScanner()

# Steam 登录态：auth 域写入，workshop 域读取（用于判断「当前 SteamID」）
_steam_auth_state: dict = {
    "authenticated": False,
    "user": None,
}


# ── 延迟导入的服务访问器 ──────────────────────────────────────────────
# 工坊浏览 / 订阅 / 更新检查 / 下载器这几个 service 顶层会读配置、建线程池，
# 放在模块顶层 import 会让「只想跑一次 /api/health」的场景也付出这份代价；
# 更重要的是拆文件时它们被多个 router 共用，集中在这里才不会各自造一份状态。

def wsu():
    """创意工坊更新检查服务（services.workshop_updates）。"""
    from services.workshop_updates import get_service
    return get_service()


def wb():
    """创意工坊浏览服务模块（services.workshop_browse）。"""
    from services import workshop_browse as _mod
    return _mod


def subs():
    """工坊订阅服务模块（services.workshop_subscriptions）。"""
    from services import workshop_subscriptions as _mod
    return _mod


def download_manager():
    """下载器管理器单例（services.workshop_downloader.get_manager）。"""
    from services.workshop_downloader import get_manager
    return get_manager()
