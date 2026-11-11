import vpk
import os

base = r'D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2\addons\workshop'

# Check 2511559062 - has wsbkwd-notes.txt
v = vpk.VPK(os.path.join(base, '2511559062.vpk'), read_header_only=False)
data = v.get_file('wsbkwd-notes.txt').read()
print('2511559062 notes:', data.decode('utf-8-sig', errors='replace')[:300])
print()

# Check 213445426 addoninfo.tx more
v2 = vpk.VPK(os.path.join(base, '213445426.vpk'), read_header_only=False)
data2 = v2.get_file('addoninfo.tx').read()
print('213445426 addoninfo:', data2.decode('utf-8-sig', errors='replace')[:300])
print()

# Check 2976424431
v3 = vpk.VPK(os.path.join(base, '2976424431.vpk'), read_header_only=False)
for f in v3:
    print('2976424431 file:', f)
print()

# Check 3241463227 - raw binary
fp = os.path.join(base, '3241463227.vpk')
with open(fp, 'rb') as f:
    raw = f.read()
print('3241463227 first 100 bytes hex:', raw[:100].hex())
try:
    text = raw.decode('utf-8-sig', errors='replace')
    print('3241463227 text:', text[:200])
except:
    print('3241463227 cannot decode')
print()

# Check 3602422852
fp2 = os.path.join(base, '3602422852.vpk')
with open(fp2, 'rb') as f:
    raw2 = f.read()
print('3602422852 first 100 bytes hex:', raw2[:100].hex())
try:
    text2 = raw2.decode('utf-8-sig', errors='replace')
    print('3602422852 text:', text2[:200])
except:
    print('3602422852 cannot decode')
print()

# Check 2582265366 - no text files at all
v4 = vpk.VPK(os.path.join(base, '2582265366.vpk'), read_header_only=False)
for f in v4:
    print('2582265366 file:', f)
print()

# Check 2931108260
v5 = vpk.VPK(os.path.join(base, '2931108260.vpk'), read_header_only=False)
for f in v5:
    print('2931108260 file:', f)
print()

# Check 3322300698
v6 = vpk.VPK(os.path.join(base, '3322300698.vpk'), read_header_only=False)
for f in v6:
    print('3322300698 file:', f)
print()

# Check 3397536679
v7 = vpk.VPK(os.path.join(base, '3397536679.vpk'), read_header_only=False)
for f in v7:
    print('3397536679 file:', f)
print()

# Check 2993585957
v8 = vpk.VPK(os.path.join(base, '2993585957.vpk'), read_header_only=False)
for f in v8:
    print('2993585957 file:', f)
