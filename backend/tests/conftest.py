"""pytest 公共夹具。

**顺序很关键**：`services/data_store.py` 与 `services/mod_scanner.py` 在 import 时就把
`Path.home() / '.l4d2-manager'` 算成模块常量（`_DATA_FILE` / `_CACHE_DIR`）。所以必须
在任何 backend 模块被 import 之前把 HOME 指到临时目录 —— 否则跑一次测试就会拿
测试数据覆盖用户真实的合辑、标签与扫扫清单。

这也是 conftest.py 放在 backend/tests 而不是仓库根的原因：pytest 会先 import 它，
再 import 同目录下的 test_*.py。
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

# ── 必须在导入项目模块之前完成（见模块 docstring）─────────────────────────
_TEST_HOME = Path(tempfile.mkdtemp(prefix='l4director-tests-'))
os.environ['HOME'] = str(_TEST_HOME)
os.environ['USERPROFILE'] = str(_TEST_HOME)

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import pytest  # noqa: E402

from support import vpkbuild  # noqa: E402


@pytest.fixture(scope='session', autouse=True)
def _test_home_cleanup():
    """整个会话结束后删掉临时 HOME（里面是 data.json / 各种缓存）。"""
    yield
    shutil.rmtree(_TEST_HOME, ignore_errors=True)


@pytest.fixture(autouse=True)
def _fresh_store(monkeypatch):
    """每个用例都从「干净磁盘 + 空缓存」开始。

    不清缓存的话，上一个用例写进 data.json 的 mod 偏好会渗到下一个用例，
    表现为「单独跑过、一起跑挂」。
    """
    from services import data_store as ds
    from services import mod_scanner as ms

    ds._cache = None
    ds._cache_timestamp = 0.0
    ds._read_only_reason = None
    ds._last_recovery = None
    for path in (
        ds._DATA_FILE,
        ds._DATA_FILE.with_name(ds._DATA_FILE.name + '.bak'),
    ):
        path.unlink(missing_ok=True)
    for path in ds._CACHE_DIR.glob('data.json.corrupt-*'):
        path.unlink(missing_ok=True)

    ms.invalidate_scan_cache()
    ms._VPK_METADATA_CACHE.clear()
    ms._VPK_MANIFEST_CACHE.clear()
    ms._VPK_INDEX_CACHE.clear()
    ms.invalidate_sidecar_cache()

    # 每个用例一份独立的 addons 目录，避免 Mod 互相看见
    yield


@pytest.fixture
def addons_dir(tmp_path: Path) -> Path:
    """一个空的 addons 目录（含 workshop 子目录）。"""
    d = tmp_path / 'left4dead2' / 'addons'
    (d / 'workshop').mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture
def make_mod(addons_dir: Path):
    """工厂：make_mod('a.vpk', entries=4) 生成一个合成 Mod。"""
    def _make(filename: str, **kwargs) -> Path:
        return vpkbuild.make_mod(addons_dir, filename, **kwargs)
    return _make


@pytest.fixture
def scanner(addons_dir: Path):
    """指向临时 addons 目录的扫描器（不碰用户真实配置）。"""
    from services.mod_scanner import ModScanner

    s = ModScanner()
    s.set_addons_path(str(addons_dir))
    s.invalidate_mod_enabled_cache()
    return s


@pytest.fixture
def client(scanner, monkeypatch):
    """走真实路由的 TestClient（不跑 lifespan，避免启动时自动检查工坊更新）。

    路由里的 scanner 是通过 `app_state.scanner` 取的模块属性，所以这里替换
    app_state 上的实例就能让所有端点都用临时库。
    """
    import app_state
    import main as backend_main
    from fastapi.testclient import TestClient

    monkeypatch.setattr(app_state, 'scanner', scanner)
    app = backend_main.create_app()
    return TestClient(app)
