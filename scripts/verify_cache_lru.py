"""白盒校验：内存缓存有上限（T17）与冲突分级（此前零覆盖）。

两部分：
  A. _BoundedCache —— 1000 个 Mod 时三份缓存曾无上限常驻，能吃几百 MB 到 1 GB；
  B. conflict_engine.analyze 的五档分级（hard / script / copy / entry / soft）
     与「官方原版副本不算持有者」这条核心规则。

运行：python scripts/verify_cache_lru.py
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix='l4d2_lru_'))
os.environ['USERPROFILE'] = str(TMP)
os.environ['HOME'] = str(TMP)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.mod_scanner import (  # noqa: E402
    _BoundedCache, _VPK_INDEX_CACHE, _VPK_MANIFEST_CACHE, _VPK_METADATA_CACHE,
)
from services.conflict_engine import (  # noqa: E402
    OfficialIndex, analyze,
    SEVERITY_HARD, SEVERITY_SCRIPT, SEVERITY_COPY, SEVERITY_ENTRY, SEVERITY_SOFT,
)

ok = True


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


# ============================================================ A. LRU
c = _BoundedCache(3)
for i in range(5):
    c[f'k{i}'] = i

check('超出上限后长度被压回', len(c) == 3, str(len(c)))
check('最旧的两个被淘汰', 'k0' not in c and 'k1' not in c, str(list(c)))
check('最新的三个还在', list(c) == ['k2', 'k3', 'k4'], str(list(c)))

# 访问 k2 把它提到最新
_ = c['k2']
c['k5'] = 5
check('访问过的条目不会被优先淘汰', 'k2' in c, str(list(c)))
check('没被访问的 k3 被淘汰', 'k3' not in c, str(list(c)))

# get 也要刷新顺序
c2 = _BoundedCache(2)
c2['a'] = 1
c2['b'] = 2
_ = c2.get('a')
c2['c'] = 3
check('get() 也刷新 LRU 顺序', 'a' in c2 and 'b' not in c2, str(list(c2)))

check('上限至少为 1（畸形参数不会炸）', _BoundedCache(0).max_entries == 1)

# 三个真实缓存都有上限
for name, cache in (
    ('vpk_index', _VPK_INDEX_CACHE),
    ('vpk_manifest', _VPK_MANIFEST_CACHE),
    ('vpk_metadata', _VPK_METADATA_CACHE),
):
    cap = getattr(cache, 'max_entries', None)
    check(f'{name} 缓存有上限', isinstance(cap, int) and cap > 0, str(cap))

# ============================================================ B. 冲突分级
OFFICIAL_PATH = 'materials/models/weapons/v_rifle/v_rifle.vmt'    # A、B 都改 → hard
COPY_PATH = 'materials/models/weapons/v_pistol/v_pistol.vmt'      # A 改、C 带原版 → copy
SCRIPT_PATH = 'scripts/vscripts/teleport.nut'                     # A、B 重名 → script
ENTRY_PATH = 'scripts/vscripts/director_base_addon.nut'           # F、G → entry
PRIVATE_PATH = 'materials/models/mymod/custom.vmt'                # D、E → soft（不在官方名单）

official = OfficialIndex({
    # 官方指纹 (crc, size)
    OFFICIAL_PATH: (1111, 100),
    COPY_PATH: (3333, 70),
})

mods = {
    # A、B 都改了同一条官方资源，内容不同 → hard；同时脚本重名 → script
    'A.vpk': {OFFICIAL_PATH: (9999, 120), COPY_PATH: (7777, 80), SCRIPT_PATH: (1, 10)},
    'B.vpk': {OFFICIAL_PATH: (8888, 130), SCRIPT_PATH: (2, 11)},
    # C 只带官方原版副本（与 COPY_PATH 完全一致）→ 不构成「修改」
    'C.vpk': {COPY_PATH: (3333, 70)},
    # D、E 只重名一条私有路径 → soft
    'D.vpk': {PRIVATE_PATH: (7777, 60)},
    'E.vpk': {PRIVATE_PATH: (7776, 61)},
    # F、G 各带一份单实例入口文件 → entry
    'F.vpk': {ENTRY_PATH: (5, 5)},
    'G.vpk': {ENTRY_PATH: (6, 6)},
}

reports = analyze(mods, official, skip_hud=True)

# 注意：同一条路径可以同时产生 hard 与 script 两级，所以要按 severity 集合判断
a_sevs = {c.severity for c in reports['A.vpk'].conflicts if c.other == 'B.vpk'}
check('双方都改官方资源 → hard', SEVERITY_HARD in a_sevs, str(a_sevs))
check('脚本重名 → script', SEVERITY_SCRIPT in a_sevs, str(a_sevs))
b_sevs = {c.severity for c in reports['B.vpk'].conflicts if c.other == 'A.vpk'}
check('冲突是双向的', b_sevs == a_sevs, str(b_sevs))

check('官方原版副本不被算成「修改者」',
      not any(c.other == 'C.vpk' for c in reports['C.vpk'].conflicts),
      str([c.other for c in reports['C.vpk'].conflicts]))
check('A 带原版副本的包：copy 级单向覆盖',
      any(c.other == 'C.vpk' for c in reports['A.vpk'].copies),
      str([(c.other, c.severity) for c in reports['A.vpk'].copies]))
check('copy 级记录了「谁是原版」',
      any(c.pristine_of == 'C.vpk' for c in reports['A.vpk'].copies),
      str([(c.other, c.pristine_of) for c in reports['A.vpk'].copies]))
check('copy 不进 conflicts（不报红点）',
      not any(c.severity == SEVERITY_COPY for c in reports['A.vpk'].conflicts),
      str([c.severity for c in reports['A.vpk'].conflicts]))

check('私有路径重名只算 soft',
      all(c.severity == SEVERITY_SOFT for c in reports['D.vpk'].overlaps),
      str([(c.other, c.severity) for c in reports['D.vpk'].overlaps]))
check('soft 不进 conflicts（不报红点）', not reports['D.vpk'].conflicts,
      str(reports['D.vpk'].conflicts))

check('单实例入口文件算 entry',
      any(c.other == 'G.vpk' for c in reports['F.vpk'].entries),
      str([(c.other, c.severity) for c in reports['F.vpk'].entries]))
check('entry 不进 conflicts（只是提示）', not reports['F.vpk'].conflicts,
      str(reports['F.vpk'].conflicts))

check('纯原版副本的包 pristine_count > 0', reports['C.vpk'].pristine_count >= 1,
      str(reports['C.vpk'].pristine_count))

print('RESULT:', 'ALL PASS' if ok else 'HAS FAILURE')
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if ok else 1)
