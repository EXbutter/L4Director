"""Check if addoninfo can be extracted from raw binary for broken VPKs"""
import os

base = r'D:\SteamLibrary\steamapps\common\Left 4 Dead 2\left4dead2\addons\workshop'

for name in ['3241463227.vpk', '3602422852.vpk']:
    fp = os.path.join(base, name)
    with open(fp, 'rb') as f:
        raw = f.read()
    
    text = raw.decode('utf-8', errors='replace')
    low = text.lower()
    
    idx = low.find('addoninfo')
    if idx >= 0:
        print(f'=== {name} raw addoninfo ===')
        print(text[idx:idx+600])
        print()
    else:
        # Search for 'addontitle' or 'title' patterns
        for pattern in ['addontitle', 'addonname', 'addonauthor']:
            idx2 = low.find(pattern)
            if idx2 >= 0:
                print(f'{name}: Found "{pattern}" at {idx2}')
                print(text[idx2:idx2+200])
                print()
                break
        else:
            print(f'{name}: NO addoninfo-like patterns found')
            print(f'First 300 chars: {text[:300]}')
            print()
