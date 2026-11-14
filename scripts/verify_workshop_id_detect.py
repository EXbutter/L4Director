"""白盒校验：创意工坊 ID 识别不能把本地 Mod 当工坊条目（T9）。

踩过的坑：addons 根目录下任何纯数字文件名都被当成工坊 ID，本地
`123456789.vpk` 会被误查、误当成更新目标覆盖掉。本地文件改过就没了，
工坊包随时能重下 —— 所以只认 workshop/ 下的落法。

覆盖：
  1. workshop/<id>.vpk → 认
  2. workshop/<id>/<id>.vpk → 认
  3. addons/<id>.vpk（根目录纯数字）→ 不认
  4. 普通文件名 → 不认
  5. collect_installed 里根目录纯数字包不出现

运行：python scripts/verify_workshop_id_detect.py
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix='l4d2_wid_'))
os.environ['USERPROFILE'] = str(TMP)
os.environ['HOME'] = str(TMP)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.workshop_updates import collect_installed, workshop_id_for  # noqa: E402

ok = True


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


addons = TMP / 'left4dead2' / 'addons'
(addons / 'workshop' / '76561198000000001').mkdir(parents=True)

cases = [
    ('workshop/<id>.vpk', Path('addons/workshop/1234567890.vpk'), True, '1234567890'),
    ('workshop/<id>/<id>.vpk', Path('addons/workshop/1234567890/1234567890.vpk'), True, '1234567890'),
    ('根目录 <id>.vpk（本地纯数字包）', Path('addons/1234567890.vpk'), False, None),
    ('根目录普通文件', Path('addons/MyMod.vpk'), False, None),
    ('workshop 下的普通文件名', Path('addons/workshop/MyMod.vpk'), True, None),
]
for label, p, is_ws, expect in cases:
    got = workshop_id_for(p, is_ws)
    check(f'{label} → {expect!r}', got == expect, repr(got))

# ------------------------------------------------------ collect_installed
(addons / '1234567890.vpk').write_bytes(b'x')                     # 本地纯数字：不该被收
(addons / 'workshop' / '2222222222.vpk').write_bytes(b'x')         # 工坊：该被收
(addons / 'workshop' / '3333333333').mkdir(parents=True, exist_ok=True)
(addons / 'workshop' / '3333333333' / '3333333333.vpk').write_bytes(b'x')  # 目录式：该被收

installed = collect_installed(str(addons))
check('根目录纯数字包不进更新列表', '1234567890' not in installed, str(sorted(installed)))
check('workshop 标准位置被收进来', '2222222222' in installed, str(sorted(installed)))
check('workshop 目录式被收进来', '3333333333' in installed, str(sorted(installed)))
check('条目数量正确', len(installed) == 2, str(sorted(installed)))

print('RESULT:', 'ALL PASS' if ok else 'HAS FAILURE')
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if ok else 1)
