"""验证「一键补全 addonlist.txt」（隔离环境，不动真实数据）：

1. 只补**缺失**条目，已有条目的启用状态一个都不改；
2. 幂等：再点一次不会重复追加；
3. 工坊条目写成游戏自己的 `workshop\\<id>.vpk`（反斜杠），不是 `workshop/<id>.vpk`；
4. 已有条目里的中文保持 **GBK 字节**（游戏用 ANSI 写文件，写成 UTF-8 游戏就认不出）；
5. addonlist.txt 不存在时按游戏格式新建；
6. 没配 addons 目录时明确报错，而不是假装成功。

跑法：python scripts/verify_addonlist_fill.py
"""
import os
import sys
import tempfile
from pathlib import Path

TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-fill-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
sys.path.insert(0, str(BACKEND_DIR))

from services import mod_scanner  # noqa: E402

REPORT = Path(__file__).resolve().parent / '_verify_addonlist_fill_out.txt'
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


def make_case(name: str):
    root = Path(tempfile.mkdtemp(prefix=f'l4d2-fill-{name}-'))
    addons = root / 'left4dead2' / 'addons'
    (addons / 'workshop').mkdir(parents=True)
    for vpk in ('a.vpk', 'b.vpk'):
        (addons / vpk).write_bytes(b'x')
    (addons / 'workshop' / '123456.vpk').write_bytes(b'x')
    scanner = mod_scanner.ModScanner()
    scanner._addons_path = str(addons)
    return scanner, addons.parent / 'addonlist.txt'


log('=' * 78)
log(' 场景 1：只补缺失，已有条目的启停不动')
log('=' * 78)
scanner, addonlist = make_case('basic')
addonlist.write_text('"AddonList"\n{\n\t"a.vpk"\t\t"0"\n}\n', encoding='utf-8')

res = scanner.fill_addonlist()
check('补了 2 条', res['added'], 2)
check('返回缺失清单', sorted(res['missing']), ['b.vpk', 'workshop\\123456.vpk'])
check('ok=True', res['ok'], True)
check('扫到 3 个本地条目', res['scanned'], 3)

text = addonlist.read_text(encoding='utf-8')
check('a.vpk 仍是禁用', '"a.vpk"\t\t"0"' in text, True)
check('b.vpk 补成启用', '"b.vpk"\t\t"1"' in text, True)
check('工坊条目用反斜杠写法', '"workshop\\123456.vpk"\t\t"1"' in text, True)
check('不会写成正斜杠', '"workshop/123456.vpk"' in text, False)

res2 = scanner.fill_addonlist()
check('再点一次不再追加', res2['added'], 0)
check('幂等后仍然 ok', res2['ok'], True)

log('')
log('=' * 78)
log(' 场景 2：中文条目保持 GBK 字节（游戏用 ANSI 写文件）')
log('=' * 78)
scanner, addonlist = make_case('ansi')
cn_name = '【测试】中文名字.vpk'
(scanner._addons_path and Path(scanner._addons_path) / cn_name).write_bytes(b'x')

# 按游戏的方式写：GBK 字节 + 一个已有的禁用条目
raw = '"AddonList"\n{\n\t"' + cn_name + '"\t\t"0"\n}\n'
addonlist.write_bytes(raw.encode('gbk'))

# 读的时候会解成代理字符；补全只应该追加 b.vpk 等缺失项
before_bytes = addonlist.read_bytes()
res = scanner.fill_addonlist()
after_bytes = addonlist.read_bytes()

check('中文条目也算「已存在」，不会被重复补', cn_name in [m for m in res['missing']], False)
check('只补了缺失的 3 条（a / b / 工坊），没碰已有的中文条目',
      res['added'], 3)   # a.vpk / b.vpk / workshop\123456.vpk
gbk_line = ('\t"' + cn_name + '"\t\t"0"').encode('gbk')
check('原有中文行仍是 GBK 字节', gbk_line in after_bytes, True)
check('没有把它改写成 UTF-8', cn_name.encode('utf-8') in after_bytes, False)
check('原文件的前缀字节没被动过', after_bytes.startswith(before_bytes.split(b'\n')[0]), True)

log('')
log('=' * 78)
log(' 场景 3：addonlist.txt 不存在 → 按游戏格式新建')
log('=' * 78)
scanner, addonlist = make_case('empty')
check('开始确实没有文件', addonlist.exists(), False)
res = scanner.fill_addonlist()
check('新建成功', (res['ok'], res['added']), (True, 3))
text = addonlist.read_text(encoding='utf-8')
check('有 AddonList 头', text.splitlines()[0].strip(), '"AddonList"')
check('花括号包住', (text.splitlines()[1].strip(), text.strip().splitlines()[-1].strip()), ('{', '}'))

log('')
log('=' * 78)
log(' 场景 4：没配 addons 目录')
log('=' * 78)
scanner = mod_scanner.ModScanner()
scanner._addons_path = None
res = scanner.fill_addonlist()
check('明确报错而不是假装成功', (res['ok'], res['added']), (False, 0))
check('错误信息里说清原因', 'addons' in (res['error'] or ''), True)

log('')
log('=' * 78)
log(f' 结果：{"全部通过" if failures == 0 else f"{failures} 项失败"}')
log('=' * 78)

REPORT.write_text('\n'.join(lines), encoding='utf-8')
print(f'REPORT: {"ALL PASS" if failures == 0 else f"{failures} FAILED"}')
sys.exit(1 if failures else 0)
