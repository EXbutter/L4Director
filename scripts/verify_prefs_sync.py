"""校验 prefs_in_sync_with_addonlist：模拟「改了启停但没点应用就退出」的场景。"""
import os, sys, json, tempfile, shutil
from pathlib import Path

tmp = Path(tempfile.mkdtemp(prefix='l4d2test_'))
os.environ['USERPROFILE'] = str(tmp)
os.environ['HOME'] = str(tmp)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services import data_store as ds
from services.mod_scanner import ModScanner

# 伪造一个 addons 目录 + addonlist.txt
addons = tmp / 'left4dead2' / 'addons'
addons.mkdir(parents=True)
for name in ('A.vpk', 'B.vpk'):
    (addons / name).write_bytes(b'x')
ls = addons.parent / 'addonlist.txt'

def write_list(a=True, b=True):
    ls.write_text(
        '"AddonList"\n{\n'
        f'\t"addons\\A.vpk"\t\t"{1 if a else 0}"\n'
        f'\t"addons\\B.vpk"\t\t"{1 if b else 0}"\n'
        '}\n',
        encoding='utf-8',
    )

scanner = ModScanner()
scanner.set_addons_path(str(addons))

ok = True
def check(label, expect):
    global ok
    got = scanner.prefs_in_sync_with_addonlist()
    flag = 'PASS' if got == expect else 'FAIL'
    if got != expect:
        ok = False
    print(f'[{flag}] {label}: sync={got} (expect {expect})')

# 1. 没有任何偏好 → 视为一致
check('无偏好记录', True)

# 2. 偏好与文件一致（A 禁用、文件里也是 0）
ds.set_mod_enabled('A.vpk', False)
write_list(a=False, b=True)
scanner.invalidate_mod_enabled_cache()
check('偏好=文件（A 禁用）', True)

# 3. 偏好与文件不一致（软件里禁用，文件里仍启用）→ 不算一致
write_list(a=True, b=True)
scanner.invalidate_mod_enabled_cache()
check('偏好=禁用但文件=启用', False)

# 4. 文件里缺少该条目且偏好为禁用 → 不算一致
ls.write_text('"AddonList"\n{\n\t"addons\\B.vpk"\t\t"1"\n}\n', encoding='utf-8')
scanner.invalidate_mod_enabled_cache()
check('文件缺条目 + 偏好禁用', False)

# 5. 已删除的 mod 不应影响判定
ds.set_mod_enabled('Gone.vpk', False)
write_list(a=False, b=True)
scanner.invalidate_mod_enabled_cache()
check('偏好里有已删除的 mod', True)

print('RESULT:', 'ALL PASS' if ok else 'HAS FAILURE')
shutil.rmtree(tmp, ignore_errors=True)
sys.exit(0 if ok else 1)
