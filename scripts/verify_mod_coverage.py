"""校验「整套替换识别」与混搭的前提数据（tagger.coverage）。

为什么值得单独一份脚本：这套判定直接决定「一键混搭」推给用户哪个包，
而它踩过的坑都很隐蔽 ——
  1. 公共动画库（xdr 那类：只有 .mdl + .ani、零材质）会把 8 个角色名全命中，
     看起来像「全员生还者」，实际换上之后人物不变、只有动作变；
  2. 角色皮肤普遍自带 HUD 贴图（s_panel_zoey.vtf），拿 HUD 贴图当材质证据
     会让一堆 UI Mod 混进候选；
  3. 自定义目录（materials/<作者>/<角色>/）在国内作者的作品里极常见，
     按标准路径卡材质会把真替换包全漏掉；
  4. 地图自带几百份素材，算覆盖率会把「整套生还者」判给一张地图。

断言全部是纯函数调用，不碰真实 addons 目录、不写用户数据。
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
sys.path.insert(0, str(BACKEND_DIR))

from services import tagger  # noqa: E402

failures = 0


def check(label: str, actual, expected):
    global failures
    ok = actual == expected
    if not ok:
        failures += 1
    print(f"[{'PASS' if ok else 'FAIL'}] {label}: {actual!r}（期望 {expected!r}）")


def cov(paths):
    tags, degraded, coverage = tagger.classify_full(paths)
    return tags, degraded, coverage


# ── 1. 八人全换：标准路径 ─────────────────────────────────────────
SURVIVORS = [
    'models/survivors/survivor_teenangst.mdl',   # Zoey
    'models/survivors/survivor_namvet.mdl',      # Bill
    'models/survivors/survivor_biker.mdl',       # Francis
    'models/survivors/survivor_manager.mdl',     # Louis
    'models/survivors/survivor_coach.mdl',       # Coach
    'models/survivors/survivor_mechanic.mdl',    # Ellis
    'models/survivors/survivor_gambler.mdl',     # Nick
    'models/survivors/survivor_producer.mdl',    # Rochelle
]
full_paths = SURVIVORS + [f'materials/models/survivors/s{i}/body.vtf' for i in range(8)]
tags, _deg, c = cov(full_paths)
check('八人全换 → 生还者 8/8', c.get('生还者', {}).get('hit'), 8)
check('八人全换 → 清单长度 8', c.get('生还者', {}).get('total'), 8)

# ── 2. 公共动画库：只有 mdl + ani、零材质 → 不能算覆盖 ──────────────
anim_lib = [
    'models/xdreanims/zoey_slot_008.mdl',
    'models/xdreanims/nick_slot_008.mdl',
    'models/xdreanims/coach_slot_008.mdl',
    'models/xdreanims/ellis_slot_008.mdl',
    'models/xdreanims/zoey_slot_008.ani',
    'models/xdreanims/nick_slot_008.ani',
]
_tags, _deg, c = cov(anim_lib)
check('动画库（无材质）不产生覆盖', c, {})

# ── 3. HUD 贴图不算材质证据 ──────────────────────────────────────
hud_only = [
    'models/survivors/survivor_teenangst.mdl',
    'models/survivors/survivor_namvet.mdl',
    'materials/vgui/s_panel_teenangst.vtf',
    'materials/vgui/s_panel_namvet.vtf',
]
_tags, _deg, c = cov(hud_only)
check('只有 HUD 贴图不算整套替换', c, {})

# ── 4. 自定义目录的替换包也要认（materials/<作者>/<角色>/） ─────────
custom_hit = [
    'models/meng/nell/nell.mdl',
    'models/survivors/survivor_producer.mdl',
    'materials/meng/1/2/nell/body.vmt',
]
_tags, _deg, c = cov(custom_hit)
check('自定义目录替换包被识别', '生还者' in c, True)

# ── 5. 特感：只算 8 种特殊感染者，Common Infected 不算 ────────────
infected = [
    'models/infected/hulk.mdl',     # Tank
    'models/infected/boomer.mdl',   # Boomer
    'models/infected/smoker.mdl',   # Smoker
    'materials/models/infected/boomer/boomer.vtf',
]
_tags, _deg, c = cov(infected)
check('三名特感 → 3/8', (c.get('特感', {}).get('hit'), c.get('特感', {}).get('total')), (3, 8))

common_only = [
    'models/infected/common_male_riot.mdl',
    'materials/models/infected/common/common_body.vtf',
    'sound/infected/common/common_attack1.wav',
]
_tags, _deg, c = cov(common_only)
check('只有普通感染者 → 不算特感整套', '特感' in c, False)

# ── 6. 武器：同一路径只归一款，且套装清单是 35 件 ──────────────────
weapons = [
    'models/v_models/v_rifle_ak47.mdl',
    'materials/models/v_models/rifle_ak47.vtf',
    'models/v_models/v_rifle_m16.mdl',
    'materials/models/v_models/rifle_m16.vtf',
]
_tags, _deg, c = cov(weapons)
check('两把枪 → 2/35', (c.get('武器', {}).get('hit'), c.get('武器', {}).get('total')), (2, 35))

# ── 7. 战役：地图一律不算覆盖（自带的武器/角色素材会污染判定） ──────
campaign = ['maps/c1m1.bsp', 'maps/c1m2.bsp'] + weapons
_tags, _deg, c = cov(campaign)
check('地图不产生覆盖', c, {})

# ── 8. 降级路径（解析失败）不给覆盖：连文件名都拿不到就不该编 ───────
check('空清单 → 空覆盖', tagger.classify_full([])[2], {})

# ── 9. 混淆保护：细分标签仍然最多 2 个，覆盖清单才是完整集 ─────────
fine = [t for t in tags if t in tagger.FINE_TAG_NAMES]
check('细分标签不超过 2 个', len(fine) <= 2, True)

print()
if failures:
    print(f'结果：{failures} 项失败')
    sys.exit(1)
print('结果：全部通过')
