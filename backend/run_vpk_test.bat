@echo off
chcp 65001 >nul
cd /d "g:\Work\L4D2 Manager\backend"
"g:\Work\L4D2 Manager\.venv\Scripts\python.exe" -c "
import sys
sys.path.insert(0, '.')
import vpk
from pathlib import Path

p = Path(r'C:\Program Files (x86)\Steam\steamapps\common\Left 4 Dead 2\left4dead2\addons')
vpk_files = list(p.glob('*.vpk'))
if not vpk_files:
    print('NO FILES')
    sys.exit(0)

f = vpk_files[0]
print(f'Testing: {f.name}')
try:
    v = vpk.VPK(str(f.resolve()), read_header_only=False)
    # Check tree
    if hasattr(v, 'tree'):
        print(f'Has tree: True, type: {type(v.tree)}')
        if v.tree:
            for k1, v1 in list(v.tree.items())[:3]:
                print(f'  Dir: {k1}')
                if isinstance(v1, dict):
                    for k2, v2 in list(v1.items())[:2]:
                        print(f'    Ext: {k2}, entries count: {len(v2)}')
                        if v2 and hasattr(v2[0], 'filename'):
                            print(f'      Sample: {v2[0].filename}')
    else:
        print('Has tree: False')
        # List non-private attrs
        for attr in dir(v):
            if not attr.startswith('_'):
                print(f'  attr: {attr}')
except Exception as e:
    print(f'Error: {e}')
" > vpk_debug2.txt 2>&1
type vpk_debug2.txt
pause
