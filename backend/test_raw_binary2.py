"""Check if 3602422852 has addoninfo in raw binary"""
import re
from pathlib import Path

base = r'D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2\addons\workshop'
fp = Path(base) / '3602422852.vpk'
raw = fp.read_bytes()

# Try utf-8 with replace errors
text = raw.decode('utf-8', errors='replace')

print('=== UTF-8 search ===')
for p in ['addontitle', 'AddonTitle', 'title', 'AddonInfo', 'addonauthor']:
    idx = text.lower().find(p.lower())
    if idx >= 0:
        print(f'Found "{p}" at offset {idx}')
        print(f'  Context: {repr(text[max(0,idx-10):idx+80])}')
    else:
        print(f'"{p}" NOT found')

print()
print('=== Latin-1 search ===')
text2 = raw.decode('latin-1', errors='replace')
for p in ['addontitle', 'AddonTitle', 'title', 'AddonInfo']:
    idx = text2.lower().find(p.lower())
    if idx >= 0:
        print(f'Found "{p}" at offset {idx}')
        print(f'  Context: {repr(text2[max(0,idx-10):idx+80])}')
    else:
        print(f'"{p}" NOT found')

print()
print('=== Search for any file names ending in .nut .vmt .vtf ===')
# The addoninfo might be inside a file that's stored in the binary
# Search for patterns like "materials/" which would indicate file content
for pattern in ['addoninfo', 'workshop', 'mod', 'name', 'description']:
    count = text.lower().count(pattern)
    print(f'  Occurrences of "{pattern}": {count}')
