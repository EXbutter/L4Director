"""白盒校验：解析失败的 VPK 不能从列表里消失（T8）。

以前 _parse_vpk_fast 里任何异常都 return None，这张卡直接从列表里蒸发 ——
用户看到的是「我明明装了，软件里根本没有」，而且连删/禁用都做不到。

覆盖：
  1. 垃圾内容的 .vpk 仍然出现在扫描结果里，带 unreadable=True 和可读原因；
  2. 0 字节的 .vpk 同样可见；
  3. 只有一个坏包（不足 2 个启用 Mod、冲突检测提前退出）时也要标出来；
  4. 坏包的名字/路径/大小仍然正确（卡片能正常渲染与删除）。

运行：python scripts/verify_unreadable_vpk.py
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix='l4d2_ur_'))
os.environ['USERPROFILE'] = str(TMP)
os.environ['HOME'] = str(TMP)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.mod_scanner import ModScanner  # noqa: E402

ok = True


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


addons = TMP / 'left4dead2' / 'addons'
addons.mkdir(parents=True)

# 只有一个坏包：这条最关键 —— 冲突检测在「启用数量 < 2」时会提前 return，
# 旧实现下它会被当成正常空包显示。
(addons / 'ONLY_BROKEN.vpk').write_bytes(b'not a vpk at all')

scanner = ModScanner()
scanner.set_addons_path(str(addons))
mods = scanner.scan_mods()

check('坏包没有被丢掉', len(mods) == 1, f'{len(mods)} 个')
if mods:
    m = mods[0]
    check('名字正确', m.name == 'ONLY_BROKEN.vpk', m.name)
    check('标记为 unreadable', m.unreadable is True)
    check('带可读的失败原因', bool(m.unreadable_reason), str(m.unreadable_reason))
    check('路径指向真实文件', Path(m.path).exists(), m.path)
    check('大小正确', m.size_bytes == len(b'not a vpk at all'), str(m.size_bytes))

# ------------------------------------------------------ 0 字节包
(addons / 'EMPTY.vpk').write_bytes(b'')
mods = scanner.scan_mods()
by_name = {m.name: m for m in mods}
check('0 字节包也在列表里', 'EMPTY.vpk' in by_name, str(sorted(by_name)))
if 'EMPTY.vpk' in by_name:
    check('0 字节包标记为 unreadable', by_name['EMPTY.vpk'].unreadable is True)
    check('0 字节包也有原因', bool(by_name['EMPTY.vpk'].unreadable_reason),
          str(by_name['EMPTY.vpk'].unreadable_reason))

# ------------------------------------------------------ 两个坏包时不会被互相算成冲突
check('坏包之间不产生冲突告警',
      all(not m.conflicts for m in mods),
      str([(m.name, m.conflicts) for m in mods]))

print('RESULT:', 'ALL PASS' if ok else 'HAS FAILURE')
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if ok else 1)
