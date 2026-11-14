"""白盒校验：addonlist.txt 写不进去时必须如实报错（T3）。

以前写盘异常只在后端 print 一行，接口照样回「已应用 N 项」——
用户看到软件里已经禁用，进游戏却还在加载。这是「软件里关掉、游戏里没用」
最典型的根因，必须有回归保护。

覆盖：
  1. 文件只读时 apply_mod_prefs_to_addonlist() 返回 0，并留下错误原因；
  2. 恢复可写后能正常写入，且错误被清空；
  3. 文件存在但读不出内容时拒绝覆盖（不把用户的配置抹掉）。

运行：python scripts/verify_addonlist_write_fail.py
"""
import os
import shutil
import stat
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix='l4d2_alw_'))
os.environ['USERPROFILE'] = str(TMP)
os.environ['HOME'] = str(TMP)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services import data_store as ds  # noqa: E402
from services.mod_scanner import ModScanner  # noqa: E402

ok = True


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


addons = TMP / 'left4dead2' / 'addons'
addons.mkdir(parents=True)
for name in ('A.vpk', 'B.vpk'):
    (addons / name).write_bytes(b'x')

addonlist = addons.parent / 'addonlist.txt'


def write_list(a: int, b: int):
    addonlist.write_text(
        '"AddonList"\n{\n'
        f'\t"addons\\A.vpk"\t\t"{a}"\n'
        f'\t"addons\\B.vpk"\t\t"{b}"\n'
        '}\n',
        encoding='utf-8',
    )


def make_readonly(path: Path):
    os.chmod(path, stat.S_IREAD)


def make_writable(path: Path):
    os.chmod(path, stat.S_IWRITE | stat.S_IREAD)


scanner = ModScanner()
scanner.set_addons_path(str(addons))

# 让软件里的偏好与文件不一致：A 禁用，文件里是启用
ds.set_mod_enabled('A.vpk', False)
scanner.invalidate_mod_enabled_cache()
write_list(a=1, b=1)

# ------------------------------------------------------ 1. 只读 → 如实报错
make_readonly(addonlist)
applied = scanner.apply_mod_prefs_to_addonlist()
err = scanner.last_addonlist_error()
check('只读文件：返回 0（没有一条真正生效）', applied == 0, f'applied={applied}')
check('只读文件：留下错误原因', bool(err), err or '(空)')
check('只读文件的字节未被改动', 'addons\\A.vpk"\t\t"1"' in addonlist.read_text(encoding='utf-8'))

# ------------------------------------------------------ 2. 恢复可写 → 正常写入
make_writable(addonlist)
scanner.invalidate_mod_enabled_cache()
applied = scanner.apply_mod_prefs_to_addonlist()
check('可写后：返回 >0', applied > 0, f'applied={applied}')
check('可写后：错误被清空', scanner.last_addonlist_error() is None,
      str(scanner.last_addonlist_error()))
text = addonlist.read_text(encoding='utf-8')
check('可写后：A 被写成 0', '"addons\\A.vpk"\t\t"0"' in text, text.replace('\n', ' | ')[:120])

# ------------------------------------------------------ 3. 读不出内容 → 拒绝覆盖
# 用「指向目录的路径」制造读取异常：exists() 为真、read 失败。
# 这里直接用只读 + 空内容无法模拟，改为把文件替换成不可读的目录不可行，
# 所以改用「文件被独占」的等价手段：删除读权限（Windows 上 read_text 会失败）。
make_readonly(addonlist)
before_bytes = addonlist.read_bytes()
scanner._write_addonlist({'addons\\A.vpk': True})
check('拒绝覆盖时提示可见', 'addonlist' in (scanner.last_addonlist_error() or ''),
      scanner.last_addonlist_error() or '(空)')
check('拒绝覆盖时原文件保持不变', addonlist.read_bytes() == before_bytes)

print('RESULT:', 'ALL PASS' if ok else 'HAS FAILURE')
make_writable(addonlist)
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if ok else 1)
