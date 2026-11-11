"""Test if regex fix works for 3602422852"""
import re
from pathlib import Path

base = r'D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2\addons\workshop'
fp = Path(base) / '3602422852.vpk'
raw = fp.read_bytes()

text = raw.decode('utf-8', errors='replace')

# The new pattern - must match "addontitle" "Some Title"
pattern = r'"addontitle"[ \t\x00]*"([^"]+)"'
match = re.search(pattern, text, re.IGNORECASE)
print('Test 1 - quoted:', bool(match))
if match:
    print(f'  Title: {match.group(1)}')
else:
    idx = text.lower().find('addontitle')
    print(f'  Raw context: {repr(text[idx:idx+60])}')
    print(f'  Note: \\t between quotes = {repr(text[idx:idx+30])}')

# Also test the unquoted pattern
pattern2 = r'addontitle[ \t\x00]*"([^"]+)"'
match2 = re.search(pattern2, text, re.IGNORECASE)
print(f'Test 2 - unquoted:', bool(match2))
if match2:
    print(f'  Title: {match2.group(1)}')
