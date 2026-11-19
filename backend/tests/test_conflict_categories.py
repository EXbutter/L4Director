"""按资源类别验证：人物 / 武器 / 界面。

三类在引擎里走的是**不同路径**，不能只测「有冲突」：

  人物、武器  → 模型文件集（.mdl/.vtx/.vvd）覆盖官方路径 → hard + 闪退风险判定
  界面        → 原先被 `is_relevant_path` 整体排除（HUD 包互相覆盖是常态），
                现在单独收敛成「界面重叠」一档：soft、kind=ui、只提示不进红点
"""
import pytest

from services.conflict_engine import (
    KIND_LABELS,
    OfficialIndex,
    RISK_HIGH,
    RISK_LOW,
    SEVERITY_HARD,
    SEVERITY_SOFT,
    analyze,
)

# 人物：Nick 的第三人称模型
NICK = 'models/survivors/survivor_nick'
# 武器：M60 的世界模型 + 视角模型
M60 = 'models/w_models/weapons/w_m60'
V_M60 = 'models/v_models/v_m60'

SURVIVOR_CORE = {f'{NICK}.mdl': (11, 100), f'{NICK}.vtx': (12, 200), f'{NICK}.vvd': (13, 300)}


def official_all(*paths: str) -> OfficialIndex:
    return OfficialIndex({p: (1, 1) for p in paths})


def test_人物皮肤_整套替换判硬冲突且不报闪退():
    other = {k: (v[0] + 1000, v[1]) for k, v in SURVIVOR_CORE.items()}
    reports = analyze(
        {'nick_a.vpk': dict(SURVIVOR_CORE), 'nick_b.vpk': other},
        official_all(*SURVIVOR_CORE),
        labels={'nick_a.vpk': 'Nick A', 'nick_b.vpk': 'Nick B'},
    )

    entry = reports['nick_a.vpk'].conflicts[0]
    assert entry.severity == SEVERITY_HARD
    assert entry.kind == 'model'
    assert KIND_LABELS[entry.kind] == '模型'
    assert entry.count == 3
    assert entry.risk == RISK_LOW                 # 两边都成套，谁赢都不崩
    assert entry.advice['action'] == 'keep_one'
    assert all(p.startswith('models/survivors/') for p in entry.files)


def test_人物皮肤_只带一半模型会闪退():
    reports = analyze(
        {'nick_a.vpk': {f'{NICK}.mdl': (11, 100)}, 'nick_b.vpk': {f'{NICK}.vtx': (12, 200)}},
        official_all(f'{NICK}.mdl'),
    )
    assert reports['nick_a.vpk'].crash_risk == RISK_HIGH
    assert reports['nick_a.vpk'].crash_with == 'nick_b.vpk'


def test_武器皮肤_世界模型与视角模型都算模型类():
    files_a = {f'{M60}.mdl': (21, 100), f'{V_M60}.mdl': (22, 100), f'{V_M60}.vtx': (23, 200)}
    files_b = {k: (v[0] + 50, v[1]) for k, v in files_a.items()}
    reports = analyze(
        {'m60_a.vpk': files_a, 'm60_b.vpk': files_b},
        official_all(*files_a),
    )
    entry = reports['m60_a.vpk'].conflicts[0]
    assert entry.kind == 'model'
    assert entry.count == 3
    assert {p.split('/')[1] for p in entry.files} == {'w_models', 'v_models'}


def test_界面重叠_单独成档且不进红点():
    """两个 HUD 包改同一批面板：提示「谁生效看加载顺序」，但不能算硬冲突。"""
    ui = {f'materials/vgui/hud/panel_{i}.vtf': (30 + i, 10) for i in range(4)}
    ui_b = {k: (v[0] + 100, v[1]) for k, v in ui.items()}
    mods = {
        'hud_a.vpk': dict(ui, **{'addoninfo.txt': (1, 1)}),
        'hud_b.vpk': dict(ui_b, **{'addoninfo.txt': (2, 1)}),
    }
    reports = analyze(mods, frozenset())

    a = reports['hud_a.vpk']
    assert a.conflicts == []                       # 不进红点
    ui_entries = [c for c in a.overlaps if c.kind == 'ui']
    assert len(ui_entries) == 1
    entry = ui_entries[0]
    assert entry.severity == SEVERITY_SOFT
    assert entry.count == 4
    assert entry.other == 'hud_b.vpk'
    assert entry.risk == RISK_LOW
    assert entry.advice['action'] == 'ignore'
    assert '界面' in entry.advice['text']
    assert all(p.startswith('materials/vgui/') for p in entry.files)


def test_界面重叠_共同文件太少不报():
    """只共用 2 个图标多半是顺手打包，报出来只是噪音。"""
    ui = {f'materials/vgui/hud/icon_{i}.vtf': (40 + i, 10) for i in range(2)}
    mods = {
        'a.vpk': dict(ui),
        'b.vpk': {k: (v[0] + 100, v[1]) for k, v in ui.items()},
    }
    reports = analyze(mods, frozenset())
    assert [c for c in reports['a.vpk'].overlaps if c.kind == 'ui'] == []


def test_界面重叠_内容相同不报():
    """逐字节相同 = 无害覆盖（同一个 HUD 模板被两个包各自打包了一份）。"""
    ui = {f'materials/vgui/hud/panel_{i}.vtf': (50 + i, 10) for i in range(4)}
    reports = analyze({'a.vpk': dict(ui), 'b.vpk': dict(ui)}, frozenset())
    assert [c for c in reports['a.vpk'].overlaps if c.kind == 'ui'] == []


def test_人物皮肤改的_HUD_头像也进界面重叠():
    """真实场景：尼克皮肤除了改模型，还会替换尼克在 HUD 上的头像。"""
    avatar = {f'materials/vgui/s_panel_{i}.vtf': (60 + i, 10) for i in range(3)}
    files_a = dict(SURVIVOR_CORE, **avatar)
    files_b = {k: (v[0] + 500, v[1]) for k, v in SURVIVOR_CORE.items()}
    files_b.update({k: (v[0] + 500, v[1]) for k, v in avatar.items()})

    reports = analyze(
        {'nick_a.vpk': files_a, 'nick_b.vpk': files_b},
        official_all(*SURVIVOR_CORE),
    )
    a = reports['nick_a.vpk']
    assert a.conflicts[0].kind == 'model'                 # 模型照常判硬冲突
    ui_entries = [c for c in a.overlaps if c.kind == 'ui']
    assert len(ui_entries) == 1
    assert ui_entries[0].count == 3
    assert all('s_panel' in p for p in ui_entries[0].files)
