"""验证「我的 Mod」里的**自定义标签**（隔离环境，不动真实数据）：

1. **标签池**：新建/去重/删除，纯用户数据（存 data.json 顶层，不混进内置词表）；
2. **给 Mod 打自定义标签**：能写进 tags_override，并出现在 ModInfo.tags 里且 tags_manual=True；
3. **删标签的连带清理**：从所有 Mod 身上摘掉；只挂着自定义标签的 Mod **回落自动检测**
   （否则它会变成「什么分类都没有」，在按类型筛选时整卡消失）；
4. **内置标签不被污染**：删自定义标签不能动 CATEGORIES / FINE_TAGS，也不能误删同名内置标签；
5. **API 校验**：空名 / 超长 / 与内置标签重名 / 「ID: 」前缀 / 来源标签；
6. **缓存失效**：标签池变了之后，下一次扫描要能看到新标签（all_tag_names 不能是常量快照）。

跑法：python scripts/verify_custom_tags.py
"""
import os
import sys
import tempfile
from pathlib import Path

TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-custom-tags-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from services import data_store as ds  # noqa: E402
import bench_scan  # noqa: E402

# bench_scan 在 import 时会把 HOME 指向它自己的临时目录；这里改回来，
# 保证 mod_scanner / data_store 用同一个（临时）缓存目录
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

import main as backend_main  # noqa: E402
from services import mod_scanner  # noqa: E402
from fastapi import HTTPException  # noqa: E402

REPORT = Path(__file__).resolve().parent / '_verify_custom_tags_out.txt'
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


ROOT = Path(tempfile.mkdtemp(prefix='l4d2-custom-tags-'))
ADDONS = ROOT / 'left4dead2' / 'addons'
ADDONS.mkdir(parents=True)


def make_vpk(name: str, files: dict):
    bench_scan.write_vpk(ADDONS / name, files)


# A：武器模型 + 贴图 → 自动检测出「武器 / 皮肤」；B：只带一个音效（不足以判音效）→「杂项」
make_vpk('A.vpk', {
    'models/weapons/v_rifle.mdl': b'x',
    'materials/models/weapons/v_rifle.vmt': b'x',
    'materials/models/weapons/v_rifle.vtf': b'x',
})
make_vpk('B.vpk', {
    'sound/weapons/rifle_fire.wav': b'x',
})

scanner = backend_main.scanner
scanner._addons_path = str(ADDONS)
scanner.invalidate_mod_enabled_cache()

log('=' * 78)
log(' 场景 1：标签池（新建 / 去重 / 删除）')
log('=' * 78)
check('初始为空', ds.get_custom_tags(), [])
check('新建「最爱」', ds.add_custom_tag('最爱'), ['最爱'])
check('再建一个', ds.add_custom_tag('待测试'), ['最爱', '待测试'])
check('重复新建不改池子', ds.add_custom_tag('最爱'), ['最爱', '待测试'])
check('空白名不写盘', ds.add_custom_tag('   '), ['最爱', '待测试'])
check('all_tag_names 里能看到新标签', '最爱' in mod_scanner.all_tag_names(), True)
check('内置判定不含自定义标签', mod_scanner.is_builtin_tag('最爱'), False)
check('内置判定仍认「武器」', mod_scanner.is_builtin_tag('武器'), True)

log('')
log('=' * 78)
log(' 场景 2：给 Mod 打自定义标签')
log('=' * 78)
mods = {m.name: m for m in scanner.scan_mods()}
log('  A 自动检测: ' + ', '.join(mods['A.vpk'].tags))
check('A 手动前不是 manual', mods['A.vpk'].tags_manual, False)

res = scanner.set_mod_tags('A.vpk', ['武器', '最爱'])
check('自定义标签没被当成非法值过滤掉', '最爱' in res.tags, True)
check('内置标签同时保留', '武器' in res.tags, True)
check('转为手动标记', res.tags_manual, True)

res = scanner.set_mod_tags('A.vpk', ['最爱'])
check('只留自定义标签也行', res.tags.count('最爱'), 1)
check('自定义标签不重复', res.tags.count('最爱') == 1, True)

# 收藏标签（卡片右下角的爱心）：内置，不需要先建池子就能打上
res = scanner.set_mod_tags('A.vpk', ['武器', mod_scanner.FAVORITE_TAG])
check('收藏标签可以直接打上（不用先进池子）', mod_scanner.FAVORITE_TAG in res.tags, True)
check('收藏标签和普通标签共存', '武器' in res.tags, True)

# 复原成「只有自定义标签」：场景 3 要用这个状态验证「删完回落自动检测」
scanner.set_mod_tags('A.vpk', ['最爱'])

# 只挂自定义标签的 Mod：删标签后必须回落自动检测。
# 注意 tags 里总带着来源标签（「外部 Mod」/「创意工坊 Mod」），那不是 override 的一部分，
# 断言时要先摘掉，否则会把来源标签误当成「没被删干净」。
res = scanner.set_mod_tags('B.vpk', ['待测试'])
check('B 只挂一个自定义标签', [t for t in res.tags if t != '外部 Mod'], ['待测试'])
check('B 是手动状态', res.tags_manual, True)

log('')
log('=' * 78)
log(' 场景 3：删标签的连带清理')
log('=' * 78)
remaining, touched = ds.remove_custom_tag('最爱')
check('池子里只剩「待测试」', remaining, ['待测试'])
check('有一个 Mod 被清理（A）', touched, 1)
check('A 的 override 里没有「最爱」了', '最爱' in (ds.get_mod_tags_override('A.vpk') or []), False)

mods = {m.name: m for m in scanner.scan_mods()}
check('A 卡片上不再出现「最爱」', '最爱' in mods['A.vpk'].tags, False)
# A 在场景 2 的最后被设成「只有最爱」，所以删掉它是空集合 → 回落自动检测
check('只挂着自定义标签的 A → 回落自动检测', mods['A.vpk'].tags_manual, False)
check('A 自动检测出的「武器」回来了', '武器' in mods['A.vpk'].tags, True)

remaining, touched = ds.remove_custom_tag('待测试')
check('删完最后一个标签池为空', remaining, [])
mods = {m.name: m for m in scanner.scan_mods()}
check('B 只挂着自定义标签 → 回落自动检测',
      (mods['B.vpk'].tags_manual, '待测试' in mods['B.vpk'].tags), (False, False))
check('B 恢复出自动检测的「杂项」', '杂项' in mods['B.vpk'].tags, True)
check('不会留下空标签的手动记录', ds.get_mod_tags_override('B.vpk'), None)

log('')
log('=' * 78)
log(' 场景 4：内置标签不被污染')
log('=' * 78)
check('CATEGORIES 仍是 11 类', len(mod_scanner.CATEGORIES), 11)
check('「武器」仍是内置标签', mod_scanner.is_builtin_tag('武器'), True)
check('删自定义标签不会影响内置词表', '武器' in mod_scanner.all_tag_names(), True)

FAV = mod_scanner.FAVORITE_TAG
check('收藏标签算内置（自定义池里不能重名）',
      (mod_scanner.is_builtin_tag(FAV), FAV in mod_scanner.all_tag_names()), (True, True))
check('收藏标签不进类型词表（不出现在类型筛选里）', FAV in mod_scanner.CATEGORIES, False)

# 关键回归：删一个「池子里根本没有」的名字，绝不能动别人身上的标签。
# 以前这里会继续遍历所有 Mod 摘引用 —— 一个 DELETE 就能把全库的收藏抹掉。
scanner.set_mod_tags('A.vpk', [FAV, '武器'])
before_tags = list(ds.get_mod_tags_override('A.vpk') or [])
remaining, touched = ds.remove_custom_tag(FAV)
check('删「不在池子里」的标签 → 一个 Mod 都不动', touched, 0)
check('收藏标签还在', ds.get_mod_tags_override('A.vpk'), before_tags)

log('')
log('=' * 78)
log(' 场景 5：API 校验')
log('=' * 78)
check('正常创建', backend_main.create_custom_tag_api({'name': '  收藏  '})['name'], '收藏')
check('重名幂等', backend_main.create_custom_tag_api({'name': '收藏'})['tags'], ['收藏'])


def expect_http(label, body, status, fragment=None):
    global failures
    try:
        backend_main.create_custom_tag_api(body)
    except HTTPException as exc:
        ok = exc.status_code == status and (fragment is None or fragment in str(exc.detail))
        if not ok:
            failures += 1
        lines.append(f"  [{'OK  ' if ok else 'FAIL'}] {label}: {exc.status_code} {exc.detail}")
        print(f"  [{'OK' if ok else 'FAIL'}] {label}")
        return
    failures += 1
    lines.append(f'  [FAIL] {label}: 没有抛 HTTPException')
    print(f'  [FAIL] {label}')


expect_http('空名 → 400', {'name': '   '}, 400, '不能为空')
expect_http('超长（17 字）→ 400', {'name': 'x' * 17}, 400, '最多 16')
expect_http('与内置标签重名 → 409', {'name': '武器'}, 409, '内置标签')
expect_http('与收藏标签重名 → 409', {'name': FAV}, 409, '内置标签')
expect_http('来源标签重名 → 400', {'name': '外部 Mod'}, 400, '来源标签')
expect_http('ID: 前缀 → 400', {'name': 'ID: 123'}, 400, '创意工坊编号')


def expect_delete_http(label, name, status, fragment=None):
    global failures
    try:
        backend_main.delete_custom_tag_api(name)
    except HTTPException as exc:
        ok = exc.status_code == status and (fragment is None or fragment in str(exc.detail))
        if not ok:
            failures += 1
        lines.append(f"  [{'OK  ' if ok else 'FAIL'}] {label}: {exc.status_code} {exc.detail}")
        print(f"  [{'OK' if ok else 'FAIL'}] {label}")
        return
    failures += 1
    lines.append(f'  [FAIL] {label}: 没有抛 HTTPException')
    print(f'  [FAIL] {label}')


expect_delete_http('删收藏标签 → 400（不是自定义标签）', FAV, 400, '不能删除')
expect_delete_http('删内置大类 → 400', '武器', 400, '不能删除')

check('删除返回剩余池', backend_main.delete_custom_tag_api('收藏')['tags'], [])

log('')
log('=' * 78)
log(f' 结果：{"全部通过" if failures == 0 else f"{failures} 项失败"}')
log('=' * 78)

REPORT.write_text('\n'.join(lines), encoding='utf-8')
print(f'REPORT: {"ALL PASS" if failures == 0 else f"{failures} FAILED"}')
sys.exit(1 if failures else 0)
