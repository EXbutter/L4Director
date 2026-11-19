"""闪退风险判定 + 冲突类型分类。

核心结论（来自 10GB 真实样本）：**冲突严不严重和会不会崩是两件事**。
  * 两个包整份替换同一个模型（.mdl/.vtx/.vvd 都带齐）→ hard 冲突，但谁赢都是成套的，不崩
  * A 只带 .mdl、B 只带 .vtx（两者甚至没有一条相同路径）→ 最终磁盘上是 A 的网格 +
    B 的顶点数据，引擎加载该模型时崩。样本里 74 组，全部是「包只打了半个模型」造成的
"""
import pytest

from services.conflict_engine import (
    KIND_LABELS,
    OfficialIndex,
    RISK_HIGH,
    RISK_LOW,
    RISK_MEDIUM,
    analyze,
    bundle_of,
    classify_path,
    dominant_kind,
    path_facts,
)

MODEL = 'models/w_models/weapons/w_m60'


def official_all(*paths: str) -> OfficialIndex:
    return OfficialIndex({p: (1, 1) for p in paths})


def test_模型文件集被拆散_判高风险且不需要路径冲突():
    """A 带 .mdl/.vvd、B 只带 .vtx —— 两者没有一条相同路径，但装在一起就会崩。"""
    mods = {
        'a.vpk': {f'{MODEL}.mdl': (11, 100), f'{MODEL}.vvd': (12, 200)},
        'b.vpk': {f'{MODEL}.vtx': (13, 300)},
    }
    reports = analyze(mods, official_all(f'{MODEL}.mdl'), labels={'a.vpk': 'A', 'b.vpk': 'B'})

    assert reports['a.vpk'].crash_risk == RISK_HIGH
    assert reports['b.vpk'].crash_risk == RISK_HIGH
    assert reports['a.vpk'].crash_with == 'b.vpk'
    assert 'A' in reports['a.vpk'].crash_reason and 'B' in reports['a.vpk'].crash_reason
    assert f'{MODEL}.vtx' in reports['a.vpk'].crash_files
    # 没有路径冲突，但风险照样要报出来
    assert reports['a.vpk'].conflicts == []


def test_两边都带整套模型_只算互相覆盖不判闪退():
    mods = {
        'a.vpk': {f'{MODEL}.mdl': (11, 100), f'{MODEL}.vtx': (12, 200), f'{MODEL}.vvd': (13, 300)},
        'b.vpk': {f'{MODEL}.mdl': (21, 110), f'{MODEL}.vtx': (22, 210), f'{MODEL}.vvd': (23, 310)},
    }
    reports = analyze(mods, official_all(
        f'{MODEL}.mdl', f'{MODEL}.vtx', f'{MODEL}.vvd',
    ))

    # 三条路径都撞、且都在官方名单里 → 合成一个 hard 条目、count=3
    assert len(reports['a.vpk'].conflicts) == 1
    assert reports['a.vpk'].conflicts[0].count == 3
    assert reports['a.vpk'].crash_risk == RISK_LOW
    assert reports['a.vpk'].crash_reason == ''


def test_只差_phy_判中风险():
    base = {f'{MODEL}.mdl': (11, 100), f'{MODEL}.vtx': (12, 200), f'{MODEL}.vvd': (13, 300)}
    mods = {
        'a.vpk': dict(base, **{f'{MODEL}.phy': (14, 400)}),
        'b.vpk': {k: (v[0] + 5, v[1]) for k, v in base.items()},
    }
    reports = analyze(mods, official_all(f'{MODEL}.mdl'))
    assert reports['a.vpk'].crash_risk == RISK_MEDIUM
    assert 'phy' in reports['a.vpk'].crash_reason


def test_风险说明只挂在真正涉及该模型的冲突上():
    """同一对包既有模型冲突又有脚本冲突时，脚本那条不能说「模型文件被拆散」。"""
    mods = {
        'a.vpk': {f'{MODEL}.mdl': (11, 100), 'scripts/vscripts/coop.nut': (31, 10)},
        'b.vpk': {f'{MODEL}.mdl': (21, 110), f'{MODEL}.vtx': (22, 200),
                  'scripts/vscripts/coop.nut': (32, 10)},
    }
    reports = analyze(mods, official_all(f'{MODEL}.mdl', 'scripts/vscripts/coop.nut'))
    by_sev = {c.severity: c for c in reports['a.vpk'].conflicts}

    assert by_sev['hard'].risk == RISK_HIGH          # 模型那条
    assert by_sev['script'].risk == RISK_LOW          # 脚本那条
    assert by_sev['script'].reason == ''
    assert by_sev['hard'].kind == 'model'
    assert by_sev['script'].kind == 'script'
    # 单一类型时不回传 kinds（省 payload），只有多类型才有
    assert by_sev['hard'].kinds == {}


def test_冲突条目带类型与文件计数():
    mods = {
        'a.vpk': {
            f'{MODEL}.mdl': (11, 100),
            'materials/models/weapons/w_m60/body.vmt': (41, 10),
            'sound/weapons/m60/fire.wav': (51, 10),
        },
        'b.vpk': {
            f'{MODEL}.mdl': (21, 110),
            'materials/models/weapons/w_m60/body.vmt': (42, 10),
            'sound/weapons/m60/fire.wav': (52, 10),
        },
    }
    report = analyze(mods, official_all(
        f'{MODEL}.mdl',
        'materials/models/weapons/w_m60/body.vmt',
        'sound/weapons/m60/fire.wav',
    ))['a.vpk']
    c = report.conflicts[0]
    assert c.kind == 'model'                 # 主类型按数量：这里是三条不同类型各 1 条
    assert c.kinds == {'model': 1, 'material': 1, 'sound': 1}
    assert sorted(c.files) == sorted([
        f'{MODEL}.mdl',
        'materials/models/weapons/w_m60/body.vmt',
        'sound/weapons/m60/fire.wav',
    ])


@pytest.mark.parametrize('path,expected', [
    ('models/x/y.mdl', 'model'),
    ('materials/models/x/y.vmt', 'material'),
    ('materials/models/x/y.vtf', 'texture'),
    ('sound/weapons/x.wav', 'sound'),
    ('particles/x.pcf', 'particle'),
    ('scripts/vscripts/x.nut', 'script'),
    ('missions/x.txt', 'script'),
    ('maps/x.bsp', 'map'),
    ('materials/vgui/x.vmt', 'ui'),
    ('addoninfo.txt', 'other'),
])
def test_路径类型分类(path, expected):
    assert classify_path(path) == expected
    assert expected in KIND_LABELS


def test_模型文件集归一化():
    assert bundle_of('models/x/y.mdl') == ('models/x/y', 'mdl')
    # DX90 是同一模型的另一套 LOD，必须归到同一个桶
    assert bundle_of('models/x/y.dx90.vtx') == ('models/x/y', 'dx90.vtx')
    assert bundle_of('materials/x/y.vmt') is None
    assert bundle_of('models/x/y.txt') is None


def test_元数据与_UI_资源在判定前就被剔除():
    assert path_facts('addoninfo.txt') == (False, None)
    assert path_facts('materials/vgui/hud.vmt') == (False, None)
    assert path_facts('sound/sound.cache') == (False, None)
    relevant, bundle = path_facts('models/x/y.mdl')
    assert relevant and bundle == ('models/x/y', 'mdl')


def test_主类型取数量最多的那一类():
    kind, kinds = dominant_kind(['models/a.mdl', 'models/b.mdl', 'sound/c.wav'])
    assert kind == 'model'
    assert kinds == {'model': 2, 'sound': 1}


def test_建议指名禁用不完整的那一个():
    """只禁用「提供 .vtx 的一方」更糟：剩下的 .mdl 会配官方原版 vtx，照样崩。"""
    mods = {
        'a.vpk': {f'{MODEL}.mdl': (11, 100), f'{MODEL}.vvd': (12, 200)},
        'b.vpk': {f'{MODEL}.vtx': (13, 300)},
    }
    reports = analyze(mods, official_all(f'{MODEL}.mdl'), labels={'a.vpk': 'A', 'b.vpk': 'B'})

    advice_a = reports['a.vpk'].crash_advice
    assert advice_a['action'] == 'disable'
    assert advice_a['target'] == 'a.vpk'          # 缺文件的是 A
    assert 'A' in advice_a['text']

    # 站在 B 的角度看，要禁用的仍然是 A（不是自己）
    assert reports['b.vpk'].crash_advice['target'] == 'a.vpk'


def test_两个都缺配套文件时建议都禁用():
    mods = {
        'a.vpk': {f'{MODEL}.mdl': (11, 100), f'{MODEL}.vtx': (12, 200)},   # 缺 vvd
        'b.vpk': {f'{MODEL}.mdl': (21, 110), f'{MODEL}.vvd': (22, 300)},   # 缺 vtx
    }
    reports = analyze(mods, official_all(f'{MODEL}.mdl'))
    advice = reports['a.vpk'].crash_advice
    assert advice['action'] == 'disable_all'
    assert '都' in advice['text'] or '两个' in advice['text']


def test_成套替换给二选一建议():
    mods = {
        'a.vpk': {f'{MODEL}.mdl': (11, 100), f'{MODEL}.vtx': (12, 200), f'{MODEL}.vvd': (13, 300)},
        'b.vpk': {f'{MODEL}.mdl': (21, 110), f'{MODEL}.vtx': (22, 210), f'{MODEL}.vvd': (23, 310)},
    }
    report = analyze(mods, official_all(f'{MODEL}.mdl', f'{MODEL}.vtx', f'{MODEL}.vvd'))['a.vpk']
    assert report.conflicts[0].advice['action'] == 'keep_one'
    assert report.conflicts[0].advice['target'] == ''


def test_脚本冲突建议只留一个():
    mods = {
        'a.vpk': {'scripts/vscripts/coop.nut': (1, 10)},
        'b.vpk': {'scripts/vscripts/coop.nut': (2, 10)},
    }
    report = analyze(mods, official_all('scripts/vscripts/coop.nut'))['a.vpk']
    advice = report.conflicts[0].advice
    assert advice['action'] == 'keep_one'
    assert advice.get('text', '') == ''      # 通用文案由前端映射，省 payload


def test_原版副本给无需处理():
    mods = {
        'a.vpk': {f'{MODEL}.mdl': (11, 100)},      # 与官方一致 → 原版副本
        'b.vpk': {f'{MODEL}.mdl': (21, 110)},
    }
    report = analyze(mods, OfficialIndex({f'{MODEL}.mdl': (11, 100)}))['a.vpk']
    assert report.copies[0].advice['action'] == 'ignore'


def test_私有路径重叠给无需处理():
    mods = {
        'a.vpk': {'materials/private/x.vmt': (1, 10)},
        'b.vpk': {'materials/private/x.vmt': (2, 10)},
    }
    report = analyze(mods, frozenset())['a.vpk']
    assert report.overlaps[0].advice['action'] == 'ignore'


def test_镜像条目的建议从各自视角生成():
    """同一条冲突在双方的名片里，target 要指向「该怎么处置」而不是恒定对方。"""
    mods = {
        'a.vpk': {f'{MODEL}.mdl': (11, 100)},                  # 缺 vtx/vvd
        'b.vpk': {f'{MODEL}.mdl': (21, 110), f'{MODEL}.vtx': (22, 200)},
    }
    reports = analyze(mods, official_all(f'{MODEL}.mdl', f'{MODEL}.vtx'))
    a_side = reports['a.vpk'].conflicts[0]
    b_side = reports['b.vpk'].conflicts[0]
    assert a_side.advice['target'] == 'a.vpk'
    assert b_side.advice['target'] == 'a.vpk'      # B 视角也是禁用 A
    assert a_side.files == b_side.files
