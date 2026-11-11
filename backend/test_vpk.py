"""Test script to explore VPK library API"""
import sys
sys.path.insert(0, '.')
import vpk as vpk_lib
from pathlib import Path

# Find a real VPK file
addons = Path(r"C:\Program Files (x86)\Steam\steamapps\common\Left 4 Dead 2\left4dead2\addons")
vpk_files = list(addons.glob("*.vpk"))

if not vpk_files:
    print("No VPK files found in addons directory!")
    sys.exit(0)

vpk_path = vpk_files[0]
print(f"Testing with: {vpk_path.name}")

try:
    v = vpk_lib.VPK(str(vpk_path.resolve()), read_header_only=False)
    
    # Try all possible ways to get file list
    print(f"\n=== dir(v) ===")
    for attr in dir(v):
        if not attr.startswith('_'):
            print(f"  {attr}")
    
    # Try iterating over v directly
    print(f"\n=== Iterating over v ===")
    try:
        count = 0
        for item in v:
            print(f"  {type(item)}: {item}")
            count += 1
            if count > 5:
                print("  ... (truncated)")
                break
    except Exception as e:
        print(f"  Error: {e}")
    
    # Try getting files list
    print(f"\n=== Has files attribute? ===")
    print(f"  hasattr(v, 'files'): {hasattr(v, 'files')}")
    if hasattr(v, 'files'):
        print(f"  type(v.files): {type(v.files)}")
        if isinstance(v.files, (list, set, tuple)):
            print(f"  len(v.files): {len(v.files)}")
            for f in list(v.files)[:5]:
                print(f"    {f}")
    
    # Try manifest
    print(f"\n=== Has manifest attribute? ===")
    print(f"  hasattr(v, 'manifest'): {hasattr(v, 'manifest')}")
    if hasattr(v, 'manifest') and v.manifest:
        lines = v.manifest.split('\n')
        print(f"  lines count: {len(lines)}")
        for line in lines[:10]:
            print(f"    {line!r}")
    
    # Try get_file
    print(f"\n=== Try get_file('addoninfo.txt') ===")
    try:
        fp = v.get_file('addoninfo.txt')
        if fp:
            print(f"  Found! type: {type(fp)}")
            data = fp.read()
            print(f"  Content length: {len(data)}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # List all file names
    print(f"\n=== Listing all get_file names ===")
    for name in _VPK_COVER_NAMES:
        try:
            fp = v.get_file(name)
            print(f"  {name}: {'FOUND' if fp else 'NOT FOUND'}")
        except:
            print(f"  {name}: ERROR")
    
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
