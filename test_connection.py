"""Quick test to verify backend API is working"""
import urllib.request
import json

try:
    req = urllib.request.Request('http://127.0.0.1:8288/api/health')
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read().decode())
        print(f"[OK] Backend health: {data}")
except Exception as e:
    print(f"[FAIL] Backend not responding: {e}")

try:
    req = urllib.request.Request('http://127.0.0.1:8288/api/settings')
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read().decode())
        print(f"[OK] Settings: {data}")
except Exception as e:
    print(f"[FAIL] Settings: {e}")

try:
    req = urllib.request.Request('http://127.0.0.1:8288/api/mods')
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read().decode())
        print(f"[OK] Mods count: {data.get('count', 'error')}")
except Exception as e:
    print(f"[FAIL] Mods: {e}")

print("---")
print("Testing POST set addons path...")
try:
    data = json.dumps({"path": "D:\\SteamLibrary\\steamapps\\common\\Left 4 Dead 2\\left4dead2\\addons"}).encode()
    req = urllib.request.Request('http://127.0.0.1:8288/api/settings/addons-path', data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=5) as resp:
        result = json.loads(resp.read().decode())
        print(f"[OK] Set addons path: {result}")
except Exception as e:
    print(f"[FAIL] Set addons path: {e}")

print("---")
print("Testing POST Steam login...")
try:
    req = urllib.request.Request('http://127.0.0.1:8288/api/auth/steam/login', method='POST')
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read().decode())
        print(f"[OK] Steam login: {data.get('authenticated')} user={data.get('user', {}).get('nickname', 'N/A')}")
except Exception as e:
    print(f"[FAIL] Steam login: {e}")
