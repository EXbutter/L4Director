"""Test VPK library API - simple"""
import sys
sys.path.insert(0, '.')
import vpk as v
from pathlib import Path

p = Path(r"C:\Program Files (x86)\Steam\steamapps\common\Left 4 Dead 2\left4dead2\addons")
vpk_files = list(p.glob("*.vpk"))
if not vpk_files:
    print("NO FILES")
    sys.exit(0)

print(f"Testing: {vpk_files[0].name}")
try:
    f = v.VPK(str(vpk_files[0].resolve()), read_header_only=False)
    print(f"dir: {[a for a in dir(f) if not a.startswith('_')]}")
    
    # Check if has keys/__iter__
    try:
        for x in f:
            print(f"ITEM: {x}")
            break
    except Exception as e:
        print(f"ITER: {e}")
    
    # Try importing the internal structure
    print(f"HAS INDEX: {hasattr(f, 'index')}")
    
    # Look at the module itself
    import vpk
    print(f"\nVPK module features:")
    print(f"  __file__: {vpk.__file__}")
    
except Exception as e:
    print(f"ERROR: {e}")
