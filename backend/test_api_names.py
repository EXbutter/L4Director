import urllib.request
import json

resp = urllib.request.urlopen('http://127.0.0.1:8288/api/mods')
raw_data = json.loads(resp.read())

# API returns {"mods": [...]} or just [...]
if isinstance(raw_data, dict) and 'mods' in raw_data:
    data = raw_data['mods']
else:
    data = raw_data if isinstance(raw_data, list) else []

names_to_check = ['213445426','2511559062','2582265366','2931108260','2976424431','2993585957','3241463227','3322300698','3397536679','3602422852']

print('=== 修复后名称测试 ===')
for m in data:
    name = m['name']
    for c in names_to_check:
        if c in name:
            title = m.get('vpk_title') or '(无)'
            print(f'  {name:25s} -> {m["display_name"]:30s}   vpk_title={title}')
            break

print()
print('=== 所有 workshop mod 名称概况 ===')
ws = [m for m in data if m['is_workshop']]
has_name = sum(1 for m in ws if m.get('vpk_title'))
no_name = sum(1 for m in ws if not m.get('vpk_title'))
print(f'  有名称: {has_name}, 无名称: {no_name}')

print()
if no_name > 0:
    print('=== 无名称的 mod 列表 ===')
    for m in ws:
        if not m.get('vpk_title'):
            print(f'  {m["name"]:25s} display_name={m["display_name"]}')
