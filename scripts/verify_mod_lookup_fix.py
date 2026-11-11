"""验证 mod 文件查找修复：含 `[ ]` 的名字也能被正确定位。

背景：`toggle_mod` / `set_mod_category` / `delete_mod` / 导出接口原来都用
`glob(f'*{mod_name}*')` 找文件，而玩家 mod 名里大量出现方括号
（`[武器]SCAR.vpk`、`(F)Props REmastered [ 4k  Full HD ].vpk`）。
Python 的 glob 会把 `[ ]` 当字符类解释 → 永远匹配不到真实文件 →
表现为「有几个 mod 无法启用 / 禁用无效 / 分类设置不上 / 删不掉 / 导不出」。

本脚本在一个临时 addons 目录里复现并验证修复（纯查找，不修改任何配置）。
"""
import glob
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'backend'))

from services import mod_scanner as ms  # noqa: E402

# 保护：验证过程绝不改动用户的真实配置（set_addons_path 会写 data.json）
ms.set_addons_path = lambda *args, **kwargs: None  # type: ignore[assignment]

NAMES = [
    '[武器]SCAR.vpk',
    '(F)Props REmastered [ 4k  Full HD ].vpk',
    '[2]Admin Menu 2.0.vpk',
    '(F)[VScripts] Library of Utils.vpk',
    '血量显示mod修正增强版.vpk',          # 中文名（不应受影响）
    '(F)Ladder Animation Fix.vpk',       # 对照组：无特殊字符
]

tmp = Path(tempfile.mkdtemp(prefix='l4d2-lookup-'))
addons = tmp / 'addons'
addons.mkdir()
(tmp / 'addonlist.txt').write_text('"AddonList"\n{\n}\n', encoding='utf-8')
for n in NAMES:
    (addons / n).write_bytes(b'PK\x03\x04fake')

# 创意工坊结构也放一个，验证 workshop / workshop/<id>/ 分支
ws = addons / 'workshop'
ws.mkdir()
(ws / '[武器]m16.vpk').write_bytes(b'PK\x03\x04fake')
item = ws / '1234567890'
item.mkdir()
(item / '[武器]pumpshot.vpk').write_bytes(b'PK\x03\x04fake')

scanner = ms.ModScanner()
scanner._addons_path = str(addons)

print(f'{"mod 名":<44} {"旧 glob":<12} {"find_mod_file":<34} 结果')
print('-' * 118)

ok = 0
total = 0
for n in NAMES + ['[武器]m16.vpk', '[武器]pumpshot.vpk']:
    total += 1
    old = bool(glob.glob(str(addons / f'*{n}*'))) or bool(glob.glob(str(ws / f'*{n}*')))
    hit = scanner.find_mod_file(n)
    if hit:
        ok += 1
    where = '根目录' if hit and not hit[1] else ('workshop' if hit else '-')
    if hit and '[武器]m16' in n:
        where = 'workshop'
    if hit and '[武器]pumpshot' in n:
        where = 'workshop/<id>'
    print(f'{n:<44} {"命中" if old else "匹配失败":<12} {(hit[0].name if hit else "未找到"):<34} {where}')

print('-' * 118)
print(f'find_mod_file 命中 {ok} / {total}')

# 兼容写法：mod- 前缀 / 缺扩展名 / 带目录 / 大小写不同
print('\n=== 历史写法兼容性 ===')
variants = [
    'mod-[武器]SCAR',
    '[武器]SCAR',
    'mod-[武器]SCAR.vpk',
    'workshop/[武器]m16.vpk',
    '[武器]M16.VPK',
]
for v in variants:
    hit = scanner.find_mod_file(v)
    print(f'  {v:<32} -> {hit[0].name if hit else "未找到"}')

shutil.rmtree(tmp, ignore_errors=True)
