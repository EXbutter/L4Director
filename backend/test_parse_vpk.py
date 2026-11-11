"""Test VPK addoninfo parsing for specific VPK files"""
import sys
import os
import re

# Add backend dir to path
_backend_dir = os.path.dirname(os.path.abspath(__file__))
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

ADDONS_PATH = r"D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2\addons"

def find_vpk(partial_name):
    """Search for VPK files matching partial name"""
    results = []
    for root, dirs, files in os.walk(ADDONS_PATH):
        for f in files:
            if partial_name in f and f.lower().endswith('.vpk'):
                results.append(os.path.join(root, f))
    return results

def decode_with_fallback(data):
    """Try all encodings"""
    for enc in ['utf-8-sig', 'utf-8', 'utf-16-le', 'utf-16', 'shift-jis', 'gbk', 'latin-1']:
        try:
            text = data.decode(enc, errors='replace')
            if any(c.isalpha() for c in text[:200]):
                return enc, text
        except:
            continue
    return 'utf-8', data.decode('utf-8', errors='replace')

def analyze_vpk(vpk_path):
    """Analyze a VPK file's addoninfo.txt"""
    print(f"\n{'='*60}")
    print(f"Analyzing: {os.path.basename(vpk_path)}")
    print(f"Full path: {vpk_path}")
    print(f"{'='*60}")
    
    import vpk as vpk_lib
    
    try:
        v = vpk_lib.VPK(vpk_path, read_header_only=False)
        
        # List all files in VPK
        all_files = []
        try:
            for path_str in v:
                if isinstance(path_str, str) and path_str.strip():
                    all_files.append(path_str)
        except:
            if hasattr(v, 'tree') and isinstance(v.tree, dict):
                all_files = list(v.tree.keys())
        
        print(f"\nTotal files in VPK: {len(all_files)}")
        print(f"Files (first 30):")
        for f in sorted(all_files)[:30]:
            print(f"  - {f}")
        
        if len(all_files) > 30:
            print(f"  ... and {len(all_files) - 30} more")
        
        # Check for addoninfo.txt - try all known filenames
        addoninfo_found = False
        
        # First, show all files that contain 'addoninfo' or are .txt files in root
        print(f"\nAll .txt files in VPK:")
        txt_files = [f for f in all_files if f.lower().endswith('.txt')]
        for tf in txt_files:
            print(f"  - {tf}")
        
        # Try to get addoninfo.txt directly (catch errors per attempt)
        for f in all_files:
            if 'addoninfo' in f.lower() and f.lower().endswith('.txt'):
                try:
                    fp = v.get_file(f)
                    data = fp.read()
                    print(f"\n--- Found: {f} ---")
                    print(f"Raw bytes (first 200): {data[:200]}")
                    
                    enc, text = decode_with_fallback(data)
                    print(f"Decoded with: {enc}")
                    print(f"Full text:\n{text[:2000]}")
                    print(f"--- end ---")
                    addoninfo_found = True
                    break
                except Exception as e:
                    print(f"  ⚠ Failed to read {f}: {e}")
        
        if not addoninfo_found:
            print("\n⚠ No addoninfo.txt found in VPK!")
        
        if not addoninfo_found:
            print("\n⚠ No addoninfo.txt found in VPK!")
            print("Checking for other text files:")
            txt_files = [f for f in all_files if f.lower().endswith('.txt')]
            for tf in txt_files[:5]:
                print(f"  Text file found: {tf}")
    
    except Exception as e:
        print(f"\nERROR reading VPK: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    vpks_to_check = ['3579965083', '3640373934']
    
    for vpk_id in vpks_to_check:
        found = find_vpk(vpk_id)
        if found:
            for fp in found:
                analyze_vpk(fp)
        else:
            print(f"\n❌ VPK with '{vpk_id}' not found under {ADDONS_PATH}")
