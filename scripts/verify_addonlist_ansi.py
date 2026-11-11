"""复现 / 验证：游戏用 ANSI(GBK) 写入的中文条目能不能被正确匹配并改掉。

背景
----
日志（L4Director_logs_20260927_221453）里 130 个 Mod 中有 84 个名字含中文。
L4D2 写 addonlist.txt 用的是**系统 ANSI 代码页**（简中系统 = CP936/GBK），
而软件读文件时按 UTF-8 + surrogateescape 解析 → 中文条目变成「代理对」字符串，
与磁盘上的 UTF-8 文件名再也对不上。

后果：
  1. 软件以为这个 Mod「在 addonlist.txt 里没有条目」（于是按自己的记录显示状态）；
  2. 用户在软件里禁用后，`_write_addonlist` 找不到那一行 → 新追加一条 UTF-8 名字的
     条目，而游戏仍在读它自己写的那条 GBK 条目（值还是 1）
     → **软件里显示「禁用」，游戏里其实还是启用** ← 用户反馈的问题。

本脚本在临时目录里复现并验证：GBK 条目必须能被匹配到，并**原地改成 0**（不新增重复条目）。
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-ansi-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import data_store as ds  # noqa: E402
from services import mod_scanner as ms  # noqa: E402

ROOT = Path(tempfile.mkdtemp(prefix='l4d2-ansi-'))
ADDONS = ROOT / 'left4dead2' / 'addons'
ADDONS.mkdir(parents=True)
ADDONLIST = ROOT / 'left4dead2' / 'addonlist.txt'

CN = '血量显示MOD.vpk'
CN2 = '[武器]SCAR.vpk'
EN = 'plain_mod.vpk'
NEW_CN = '新加的字体mod.vpk'      # 文件里没有条目 → 写入时必须按 ANSI 编码新增
for n in (CN, CN2, EN, NEW_CN):
    (ADDONS / n).write_bytes(b'PK\x03\x04fake')

# 游戏写出来的样子：中文条目按 GBK 编码；纯 ASCII 条目两种编码一样
lines = ['"AddonList"', '{']
for key in (EN, CN, CN2):
    lines.append(f'\t"{key}"\t\t"1"')
lines.append('}')
ADDONLIST.write_bytes(('\n'.join(lines) + '\n').encode('gbk'))

scanner = ms.ModScanner()
scanner._addons_path = str(ADDONS)
scanner.invalidate_mod_enabled_cache()

results: list[tuple[bool, str]] = []


def check(desc: str, actual, expected):
    ok = actual == expected
    results.append((ok, desc))
    print(f'  [{"PASS" if ok else "FAIL"}] {desc}  (实际={actual!r} 期望={expected!r})')


def entry_values() -> dict:
    """直接按 GBK 解码读原始文件，模拟「游戏自己看到的条目」。"""
    text = ADDONLIST.read_bytes().decode('gbk', errors='surrogateescape')
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('"') and line.count('"') >= 3:
            parts = line.split('"')
            out.setdefault(parts[1], []).append(parts[3])
    return out


print('=' * 78)
print(' 场景 1：GBK 中文条目应能被软件读到（当前实现会读成代理对 → 匹配不上）')
print('=' * 78)
addonlist = scanner._read_addonlist()
print(f'  软件读到的条目数: {len(addonlist)}')
for k, v in addonlist.items():
    print(f'    {k!r} = {v}')
check('文件里有 3 条条目', len(addonlist), 3)

print('\n' + '=' * 78)
print(' 场景 2：软件里禁用中文名 Mod → 应把游戏写的那条 GBK 条目改成 0')
print('=' * 78)
scanner.toggle_mod(CN, enable=False)
values = entry_values()
print(f'  游戏视角的条目: {values}')
check('游戏视角：血量显示MOD.vpk = 0', values.get(CN), ['0'])
check('游戏视角：条目没有被复制成两条', len(values.get(CN) or []), 1)

print('\n' + '=' * 78)
print(' 场景 3：含方括号 + 中文的 Mod 同样要能改到')
print('=' * 78)
scanner.toggle_mod(CN2, enable=False)
values = entry_values()
check('[武器]SCAR.vpk = 0', values.get(CN2), ['0'])

print('\n' + '=' * 78)
print(' 场景 4：重新扫描后，界面状态应与游戏一致（禁用）')
print('=' * 78)
scanner.scan_mods()
check('软件记录里 血量显示MOD=禁用', ds.get_mod_enabled(CN), False)
check('游戏视角：血量显示MOD 仍是 0', entry_values().get(CN), ['0'])

print('\n' + '=' * 78)
print(' 场景 5：文件里没有条目的中文 Mod → 新增条目也要按 ANSI 编码写（游戏才读得懂）')
print('=' * 78)
scanner.toggle_mod(NEW_CN, enable=False)
check('游戏视角：新增条目名是正常中文', entry_values().get(NEW_CN), ['0'])
check('文件里没有出现 UTF-8 乱码条目',
      [k for k in entry_values() if '\ufffd' in k], [])

print('\n' + '=' * 78)
print(' 场景 6：对账诊断能报出「软件显示禁用、文件里却是 1」的不一致')
print('=' * 78)
# 模拟旧版本留下的不一致：文件里 A=1，但软件记录是禁用
entries = entry_values()
entries[CN] = ['1']
lines = ['"AddonList"', '{']
for key, values in entries.items():
    for v in values:
        lines.append(f'\t"{key}"\t\t"{v}"')
lines.append('}')
ADDONLIST.write_bytes(('\n'.join(lines) + '\n').encode('gbk'))
scanner.invalidate_mod_enabled_cache()
diag = scanner.diagnose_mod_states()
suspicious = {s['name']: s for s in diag['suspicious']}
print(f"  addonlist_uses_ansi={diag['addonlist_uses_ansi']} 可疑条目={diag['suspicious_count']}")
check('诊断标记出 CN 不一致', CN in suspicious, True)
check('诊断给出 pref=禁用 / 文件=启用 / 界面=禁用',
      (suspicious.get(CN) or {}).get('pref'),
      False)
check('诊断里 file_value=True（游戏侧启用）',
      (suspicious.get(CN) or {}).get('file_value'), True)

print('\n' + '=' * 78)
failed = [d for ok, d in results if not ok]
print(f' 结果：{len(results) - len(failed)} / {len(results)} 项通过')
for d in failed:
    print(f'   - 未通过：{d}')
print('=' * 78)

shutil.rmtree(ROOT, ignore_errors=True)
shutil.rmtree(TEMP_HOME, ignore_errors=True)

raise SystemExit(1 if failed else 0)
