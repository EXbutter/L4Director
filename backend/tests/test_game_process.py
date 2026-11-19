"""游戏进程检测：缓存语义、退出后重新应用、pending 标记。

这些逻辑原来在 main.py 里，靠 `main._game_status_cache` 这种模块属性做状态；
拆到 services 之后行为必须完全一致 —— 启停一次 Mod 都会走到这条路径，
它一旦多拉起一次 tasklist（最长 6 秒），界面就会「点开关要愣好几秒」。
"""
import pytest


@pytest.fixture
def gp():
    from services import game_process
    game_process._game_status_cache.update({'time': 0.0, 'running': False, 'pid': None})
    return game_process


def test_两秒缓存内不重复探活(gp, monkeypatch):
    probes = []

    def fake_detect():
        probes.append(1)
        return True, 4321

    monkeypatch.setattr(gp, 'detect_game_process', fake_detect)

    assert gp.game_is_running_cached() is True
    assert gp.game_is_running_cached() is True
    assert gp.game_is_running_cached() is True
    assert len(probes) == 1, '缓存命中时不该再次拉起 tasklist'


def test_缓存过期后会重新探活(gp, monkeypatch):
    probes = []
    monkeypatch.setattr(gp, 'detect_game_process', lambda: (probes.append(1), (True, 1))[1])

    gp.game_is_running_cached()
    gp._game_status_cache['time'] = 0.0     # 手动让缓存过期
    gp.game_is_running_cached()
    assert len(probes) == 2


def test_查询状态返回稳定结构(gp, monkeypatch):
    monkeypatch.setattr(gp, 'detect_game_process', lambda: (True, 777))

    status = gp.query_status()
    assert status['running'] is True
    assert status['pid'] == 777
    assert status['process'] == 'left4dead2.exe'
    assert status['pending_reapply'] is False
    assert 'checked_at' in status


def test_游戏运行中改启停会留下待重应用标记(gp, monkeypatch):
    from services import data_store as ds

    monkeypatch.setattr(gp, 'detect_game_process', lambda: (True, 888))
    gp._game_status_cache['time'] = 0.0

    gp.mark_pending_reapply_if_game_running()
    assert ds.get_pending_game_reapply() is True


def test_游戏没运行时不留标记(gp, monkeypatch):
    from services import data_store as ds

    monkeypatch.setattr(gp, 'detect_game_process', lambda: (False, None))
    gp._game_status_cache['time'] = 0.0

    gp.mark_pending_reapply_if_game_running()
    assert ds.get_pending_game_reapply() is False


def test_没有标记时退出钩子什么都不做(gp, monkeypatch):
    from services import game_process

    called = []
    monkeypatch.setattr(game_process.scanner, 'apply_mod_prefs_to_addonlist', lambda: called.append(1))
    assert gp.reapply_prefs_after_game_exit() is None
    assert called == []


def test_有标记时退出钩子按软件设置重写(gp, monkeypatch):
    from services import data_store as ds
    from services import game_process

    ds.set_pending_game_reapply(True)
    monkeypatch.setattr(game_process.scanner, 'apply_mod_prefs_to_addonlist', lambda: 12)

    assert gp.reapply_prefs_after_game_exit() == 12
    # 标记消费掉：下次游戏退出不能再悄悄覆盖用户在游戏里的改动
    assert ds.get_pending_game_reapply() is False


def test_查询状态时若发现游戏已退出则自动纠正(gp, monkeypatch):
    from services import data_store as ds
    from services import game_process

    ds.set_pending_game_reapply(True)
    monkeypatch.setattr(game_process.scanner, 'apply_mod_prefs_to_addonlist', lambda: 5)
    monkeypatch.setattr(gp, 'detect_game_process', lambda: (False, None))
    gp._game_status_cache['time'] = 0.0

    status = gp.query_status()
    assert status['running'] is False
    assert status['reapplied'] == 5


def test_快照新鲜度判断(gp):
    gp._game_status_cache.update({'time': gp.time.time(), 'running': True, 'pid': 1})
    assert gp.is_cache_fresh() is True

    gp._game_status_cache.update({'time': 0.0, 'running': True, 'pid': 1})
    assert gp.is_cache_fresh() is False
