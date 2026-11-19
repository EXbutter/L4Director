"""冲突引擎的五档判定。

口径（docs-internal/07 领域与数据规格）：hard / script 才进 `conflicts`（界面红点），
copy / entry / soft 只进提示。任何一档判错，用户就会看到「装了一堆红点」或
「真冲突却没有提示」。
"""
from services.conflict_engine import (
    ENTRY_FILES,
    OfficialIndex,
    SEVERITY_COPY,
    SEVERITY_ENTRY,
    SEVERITY_HARD,
    SEVERITY_SCRIPT,
    SEVERITY_SOFT,
    analyze,
    detect_role,
    is_campaign_pack,
    is_relevant_path,
    role_tags,
    severity_of,
    summarize,
)

MODEL = 'materials/models/weapons/w_rifle.vmt'


def official_with(path: str, crc: int = 111, size: int = 100) -> OfficialIndex:
    return OfficialIndex({path: (crc, size)})


def test_双方都改过官方资源且内容不同_判硬冲突():
    mods = {
        'A': {MODEL: (222, 100)},
        'B': {MODEL: (333, 100)},
    }
    reports = analyze(mods, official_with(MODEL))

    assert [c.severity for c in reports['A'].conflicts] == [SEVERITY_HARD]
    assert reports['A'].conflicts[0].other == 'B'
    # 反向也要有一条，否则界面只有一方飘红
    assert reports['B'].conflicts[0].other == 'A'
    assert summarize(reports)['hard_pairs'] == 1


def test_改了同一条资源的同一份内容_不算冲突():
    """两个包带了逐字节相同的文件 = 无害覆盖（常见于同系列皮肤）。"""
    mods = {
        'A': {MODEL: (222, 100)},
        'B': {MODEL: (222, 100)},
    }
    reports = analyze(mods, official_with(MODEL))
    assert reports['A'].conflicts == []
    assert reports['B'].conflicts == []


def test_私有路径重名只算提示():
    private = 'materials/models/private/shared_texture.vmt'
    mods = {'A': {private: (1, 10)}, 'B': {private: (2, 10)}}
    reports = analyze(mods, frozenset())

    assert reports['A'].conflicts == []
    assert reports['A'].overlaps[0].severity == SEVERITY_SOFT


def test_脚本重名单独成档():
    script = 'scripts/vscripts/coop.nut'
    mods = {'A': {script: (11, 10)}, 'B': {script: (22, 10)}}
    reports = analyze(mods, frozenset())

    assert reports['A'].conflicts[0].severity == SEVERITY_SCRIPT


def test_单实例入口文件降级为提示():
    entry = sorted(ENTRY_FILES)[0]
    mods = {'A': {entry: (11, 10)}, 'B': {entry: (22, 10)}}
    reports = analyze(mods, frozenset())

    assert reports['A'].conflicts == []
    assert reports['A'].entries[0].severity == SEVERITY_ENTRY


def test_携带官方原版副本的一方不算持有者_记单向下手提示():
    """A 改过资源、B 带的是官方原版：B 赢了只是「没装」，不该算互斥。"""
    mods = {
        'A': {MODEL: (222, 100)},
        'B': {MODEL: (111, 100)},   # 与官方 CRC/长度一致
    }
    reports = analyze(mods, official_with(MODEL))

    assert reports['A'].conflicts == []
    assert reports['A'].copies[0].severity == SEVERITY_COPY
    assert reports['A'].copies[0].pristine_of == 'B'
    assert reports['A'].pristine_count == 0
    assert reports['B'].pristine_count == 1


def test_纯界面包不产生冲突():
    """vgui/resource 路径不参与逐路径判定（改由 _ui_overlaps 单独收敛成提示）。"""
    hud = {f'materials/vgui/hud_{i}.vmt': (i, 10) for i in range(10)}
    mods = {'HUD': hud, 'B': {MODEL: (333, 100)}}

    reports = analyze(mods, official_with(MODEL))
    assert reports['HUD'].conflicts == []
    assert reports['B'].conflicts == []


def test_带_HUD_的混合包不再被整包跳过():
    """「皮肤 + HUD 头像」是常见组合：不能因为 UI 占比高就把模型冲突一起吞掉。"""
    hud = {f'materials/vgui/hud_{i}.vmt': (i, 10) for i in range(10)}
    hud[MODEL] = (222, 100)
    mods = {'HUD': hud, 'B': {MODEL: (333, 100)}}

    reports = analyze(mods, official_with(MODEL))
    assert reports['HUD'].conflicts[0].other == 'B'
    assert reports['HUD'].conflicts[0].kind == 'material'   # 这条测试里 MODEL 是 .vmt
    # 但界面那批同名文件不该进红点（它们走 hints 的 ui 档）
    assert all(c.kind != 'ui' for c in reports['HUD'].conflicts)


def test_元数据与_UI_资源不参与判定():
    assert not is_relevant_path('addoninfo.txt')
    assert not is_relevant_path('addonimage.jpg')
    assert not is_relevant_path('materials/vgui/scoreboard.vmt')
    assert is_relevant_path(MODEL)


def test_严重度判定顺序():
    assert severity_of(sorted(ENTRY_FILES)[0], frozenset()) == SEVERITY_ENTRY
    assert severity_of('scripts/vscripts/x.nut', frozenset()) == SEVERITY_SCRIPT
    assert severity_of(MODEL, OfficialIndex({MODEL: (1, 1)})) == SEVERITY_HARD
    assert severity_of('materials/private/x.vmt', frozenset()) == SEVERITY_SOFT


def test_角色识别():
    campaign = {f'maps/l4d_c{i}.bsp': (i, 10) for i in range(2)}
    assert is_campaign_pack(campaign)
    assert detect_role(campaign) == 'campaign'

    # 大材质包里顺手塞一张测试地图，不能被当成地图包
    big_material = {f'materials/m/f{i}.vmt': (i, 10) for i in range(300)}
    big_material['maps/test.bsp'] = (1, 10)
    assert not is_campaign_pack(big_material)
    assert detect_role(big_material) == 'art'

    script = {f'scripts/vscripts/s{i}.nut': (i, 10) for i in range(5)}
    assert detect_role(script) == 'script'

    hud = {f'materials/vgui/u{i}.vmt': (i, 10) for i in range(10)}
    assert detect_role(hud) == 'hud'
    assert role_tags({**campaign, **script}) == ['地图', '脚本']


def test_三份以上持有者按对拆开():
    mods = {
        'A': {MODEL: (1, 10)},
        'B': {MODEL: (2, 10)},
        'C': {MODEL: (3, 10)},
    }
    reports = analyze(mods, official_with(MODEL))

    pairs = {tuple(sorted((name, c.other))) for name, rep in reports.items() for c in rep.conflicts}
    assert pairs == {('A', 'B'), ('A', 'C'), ('B', 'C')}
    assert summarize(reports)['hard_pairs'] == 3
