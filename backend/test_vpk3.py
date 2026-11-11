"""Test VPK library API properly."""
import sys
sys.path.insert(0, '.')
import json
from pathlib import Path
import vpk as vpk_lib

# Try to get the addons path from config
config_path = Path.home() / '.l4d2-manager' / 'config.json'
addons_path = None

if config_path.exists():
    data = json.loads(config_path.read_text(encoding='utf-8'))
    addons_path = data.get('addons_path')
    print(f"Config addons path: {addons_path}")

if not addons_path:
    # Fallback: check common paths
    candidates = [
        r"C:\Program Files (x86)\Steam\steamapps\common\Left 4 Dead 2\left4dead2\addons",
        r"C:\Program Files\Steam\steamapps\common\Left 4 Dead 2\left4dead2\addons",
        r"D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2\addons",
    ]
    for p in candidates:
        if Path(p).exists():
            addons_path = p
            print(f"Found addons at: {addons_path}")
            break

if not addons_path or not Path(addons_path).exists():
    print("NO ADDONS PATH FOUND")
    sys.exit(0)

p = Path(addons_path)
vpk_files = list(p.glob("*.vpk"))
print(f"Found {len(vpk_files)} VPK files in {addons_path}")

if not vpk_files:
    # Try workshop
    workshop = p / 'workshop'
    vpk_files = list(workshop.glob("*.vpk"))
    print(f"Found {len(vpk_files)} workshop VPK files")
    if not vpk_files:
        for d in workshop.iterdir():
            if d.is_dir():
                vpk_files = list(d.glob("*.vpk"))
                if vpk_files:
                    print(f"Found VPK in workshop subdir: {d.name}")
                    break

if not vpk_files:
    print("NO VPK FILES FOUND ANYWHERE")
    sys.exit(0)

f = vpk_files[0]
print(f"\nTesting: {f.name}")
print(f"Full path: {f.resolve()}")

try:
    v = vpk_lib.VPK(str(f.resolve()), read_header_only=False)
    
    # Check what's available
    attrs = [a for a in dir(v) if not a.startswith('_')]
    print(f"\nVPK object attributes: {attrs}")
    
    # Check tree
    print(f"\nHas tree: {hasattr(v, 'tree')}")
    if hasattr(v, 'tree') and v.tree:
        print(f"  type: {type(v.tree)}")
        if isinstance(v.tree, dict):
            print(f"  keys: {list(v.tree.keys())[:5]}")
        else:
            print(f"  value: {str(v.tree)[:200]}")
    
    # Check manifest
    print(f"\nHas manifest: {hasattr(v, 'manifest')}")
    if hasattr(v, 'manifest') and v.manifest:
        lines = v.manifest.split('\n')
        print(f"  lines: {len(lines)}")
        for l in lines[:10]:
            print(f"    {l}")
        print(f"  Total unique paths: {len(set(lines))}")
    
    # Extract paths from manifest for categorization
    if hasattr(v, 'manifest') and isinstance(v.manifest, str):
        all_files = set()
        for line in v.manifest.split('\n'):
            entry = line.strip()
            if entry:
                all_files.add(entry.lower().replace('\\', '/'))
        print(f"\nCategorization ready: {len(all_files)} files loaded")
        
        # Quick category detection
        categories = {
            '地图': ['maps/', '.bsp'],
            '武器/道具': ['scripts/vscripts/', 'models/weapons/', 'materials/weapons/', 'sound/weapons/', 'items/'],
            '角色模型': ['models/survivors/', 'models/infected/', 'materials/models/survivors/', 'materials/models/infected/'],
            '材质/皮肤': ['materials/', 'overlays/'],
            '音效': ['sound/'],
            '脚本/插件': ['scripts/', 'vscripts/', '.nut'],
            'UI/界面': ['resource/', 'materials/vgui/', 'materials/hud/'],
            '字体': ['materials/letterbox/', 'materials/tff/'],
        }
        for cat, pats in categories.items():
            score = 0
            for p in pats:
                for f in all_files:
                    if p.lower() in f:
                        score += 1
            if score > 0:
                print(f"  {cat}: score={score}")
    
    # Check iterating
    print(f"\nCan iterate: {hasattr(v, '__iter__')}")
    try:
        count = 0
        for x in v:
            count += 1
            if count == 1:
                print(f"  First item type: {type(x)}, value: {str(x)[:200]}")
        print(f"  Total items via iteration: {count}")
    except Exception as e:
        print(f"  Iteration error: {e}")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
