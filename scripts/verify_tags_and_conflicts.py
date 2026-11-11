"""验证本次改动的核心逻辑（隔离环境，不动真实数据）：

1. 分类改为新 11 类（战役 / 杂项 / 音效 / 武器 / 被感染者 / 突变模式 / 生还者 / 物品 / 脚本 / 游戏界面 / 皮肤）；
2. **多标签**：按 VPK 内容可以同时命中多个分类；
3. **手动标签**：右键改标签 = 完整覆盖自动检测；传 None 恢复自动检测；
4. **冲突过滤**：`materials/vgui/` 这类「无感覆盖」不再算冲突，核心资源（models/ 等）仍然算；
5. **「应用」脏标记**：改启停后 dirty=True，应用后 dirty=False。
"""
import os
import sys
import tempfile
from pathlib import Path

TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-tags-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
sys.path.insert(0, str(BACKEND_DIR))

from services import data_store as ds  # noqa: E402
import bench_scan  # noqa: E402

# bench_scan 在 import 时会把 HOME 指向它自己的临时目录；这里改回来，
# 保证 mod_scanner / data_store 用同一个（临时）缓存目录
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

import main as backend_main  # noqa: E402

REPORT = Path(__file__).resolve().parent / '_verify_tags_conflicts_out.txt'
lines = []
failures = 0


def log(text=''):
    lines.append(text)
    print(text.encode('ascii', 'replace').decode('ascii'))


def check(label, actual, expected):
    global failures
    ok = actual == expected
    if not ok:
        failures += 1
    lines.append(f"  [{'OK  ' if ok else 'FAIL'}] {label}: {actual!r}（期望 {expected!r}）")
    print(f"  [{'OK' if ok else 'FAIL'}] {label}")


ROOT = Path(tempfile.mkdtemp(prefix='l4d2-tags-'))
ADDONS = ROOT / 'left4dead2' / 'addons'
ADDONS.mkdir(parents=True)


def make_vpk(name: str, files: dict):
    bench_scan.write_vpk(ADDONS / name, files)


# A：武器模型 + 武器贴图 + 若干通用材质 →「武器」+「皮肤」（材质类命中 4 个）
make_vpk('A.vpk', {
    'models/weapons/v_rifle.mdl': b'x',
    'materials/models/weapons/v_rifle.vmt': b'x',
    'materials/models/weapons/v_rifle.vtf': b'x',
    'materials/props/aaa.vtf': b'x',
    'materials/props/bbb.vtf': b'x',
})
# B：只带**一个**音效文件（用户反馈：这类 Mod 以前拿不到「音效」标签）
make_vpk('B.vpk', {
    'sound/weapons/rifle_fire.wav': b'x',
})
# C：界面资源（命中 3 个 → 达标「游戏界面」；只有 1 个材质不该被判成「皮肤」）
make_vpk('C.vpk', {
    'resource/ui/hud/scoreboard.res': b'x',
    'resource/ui/hud/hud_main.res': b'x',
    'materials/vgui/hud/scoreboard_bg.vtf': b'x',
})
# D：与 A 共享同一个核心文件（models/… → **应该**算冲突）
make_vpk('D.vpk', {
    'models/weapons/v_rifle.mdl': b'x',
})
# E：只和 C 共享 materials/vgui/ 下的界面图标（无感覆盖 → **不该**算冲突）
make_vpk('E.vpk', {
    'materials/vgui/hud/scoreboard_bg.vtf': b'x',
    'materials/vgui/icon_extras.vtf': b'x',
})

scanner = backend_main.scanner
scanner._addons_path = str(ADDONS)
scanner.invalidate_mod_enabled_cache()

log('=' * 78)
log(' 场景 1：自动分类（多标签）')
log('=' * 78)
mods = {m.name: m for m in scanner.scan_mods()}
log('  A: ' + ', '.join(mods['A.vpk'].tags))
log('  B: ' + ', '.join(mods['B.vpk'].tags))
log('  C: ' + ', '.join(mods['C.vpk'].tags))
check('A 命中「武器」', '武器' in mods['A.vpk'].tags, True)
check('A 命中「皮肤」（材质命中够多）', '皮肤' in mods['A.vpk'].tags, True)
check('B 只带 1 个音效文件也算「音效」', '音效' in mods['B.vpk'].tags, True)
check('C 命中「游戏界面」', '游戏界面' in mods['C.vpk'].tags, True)
check('C 的 1 个材质不该被判成「皮肤」（宽泛分类要求更高）', '皮肤' in mods['C.vpk'].tags, False)
check('未自动打「杂项」', '杂项' in mods['A.vpk'].tags, False)
check('A 未手动标记', mods['A.vpk'].tags_manual, False)
check('不会出现旧分类名', any(t in ('地图', '材质/皮肤', 'UI/界面') for t in mods['A.vpk'].tags), False)

log('')
log('=' * 78)
log(' 场景 2：手动标签（完整覆盖 + 恢复自动检测）')
log('=' * 78)
res = scanner.set_mod_tags('A.vpk', ['战役', '物品', '不存在的分类'])
check('只保留合法分类并按传入顺序', res.tags[-2:], ['战役', '物品'])
check('手动标记为 true', res.tags_manual, True)
check('自动检测出来的「武器」已被替换掉', '武器' in res.tags, False)
res = scanner.set_mod_tags('A.vpk', ['战役', '物品', '武器'])
check('可以再加一个（多标签叠加）', [t for t in res.tags if t in ('战役', '物品', '武器')], ['战役', '物品', '武器'])
res = scanner.set_mod_tags('A.vpk', None)
check('恢复自动检测后 tags_manual=false', res.tags_manual, False)
check('恢复后「武器」回来', '武器' in res.tags, True)
check('恢复后手动加的「战役」没了', '战役' in res.tags, False)

log('')
log('=' * 78)
log(' 场景 3：冲突过滤（核心资源算、无感资源不算）')
log('=' * 78)
mods = {m.name: m for m in scanner.scan_mods()}
check('A 与 D 共享 models/ 文件 → 互相算冲突', 'D.vpk' in mods['A.vpk'].conflicts, True)
check('D 侧也标了 A', 'A.vpk' in mods['D.vpk'].conflicts, True)
check('C 与 E 只共享 materials/vgui/ → 不算冲突', mods['C.vpk'].conflicts, [])
check('E 侧也没有冲突', mods['E.vpk'].conflicts, [])

log('')
log('=' * 78)
log(' 场景 4：「应用」脏标记（改启停 → 亮；应用 → 灭）')
log('=' * 78)
ds.set_prefs_dirty(False)
scanner.toggle_mod('B.vpk', enable=False)
check('禁用 B 之后 dirty=true（按钮点亮）', ds.get_prefs_dirty(), True)
scanner.apply_mod_prefs_to_addonlist()
check('应用之后 dirty=false（按钮熄灭）', ds.get_prefs_dirty(), False)

log('')
log('=' * 78)
log(f' 结果：{"全部通过" if failures == 0 else f"{failures} 项失败"}')
log('=' * 78)

REPORT.write_text('\n'.join(lines), encoding='utf-8')
print(f'REPORT: {"ALL PASS" if failures == 0 else f"{failures} FAILED"}')
sys.exit(1 if failures else 0)
