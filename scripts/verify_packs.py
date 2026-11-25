"""验证整合包（Packs）v1.3.6 的完整链路。

在**临时 HOME + 临时 addons 目录**里跑（不碰用户真实的 `~/.l4d2-manager` 与游戏目录），
用 FastAPI TestClient 走真实路由，覆盖：

  1. 建包 & GET/POST 返回字段齐全（disabled_members / description / cover_mod）
  2. PUT 整体替换成员（保序去重）
  3. 快照写入（disabled_members / description / cover_mod）并能读回
  4. POST /apply 按 disabled_members 精确恢复每个成员的启停
  5. POST /apply + disable_others 关掉包外已启用的 Mod，并在 outside_disabled 回报
  6. 移除成员后其 disabled 引用被自动清理（不残留幽灵引用）
  7. PackData 容忍未知键（旧版回滚不会崩），HTTP 侧也不 500

用法：
    python scripts/verify_packs.py
    python scripts/run_all_verify.py packs
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

# ── 必须在 import 后端模块之前重定向 HOME（模块级路径在 import 时求值）──
TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-packs-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
TESTS_DIR = BACKEND_DIR / 'tests'
for p in (str(BACKEND_DIR), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from fastapi.testclient import TestClient  # noqa: E402

import app_state  # noqa: E402
import main as backend_main  # noqa: E402
import services.data_store as ds  # noqa: E402
from services.data_store import PackData  # noqa: E402
from services.mod_scanner import ModScanner  # noqa: E402
from support import vpkbuild  # noqa: E402


# ── 临时工作区 ─────────────────────────────────────────────────────────────
ROOT = Path(tempfile.mkdtemp(prefix='l4d2-packs-'))
GAME_DIR = ROOT / 'left4dead2'
ADDONS_DIR = GAME_DIR / 'addons'
ADDONS_DIR.mkdir(parents=True)

for name in ('a.vpk', 'b.vpk', 'c.vpk'):
    vpkbuild.make_mod(ADDONS_DIR, name, title=name[:-4].upper())


scanner = ModScanner()
scanner.set_addons_path(str(ADDONS_DIR))
scanner.invalidate_mod_enabled_cache()

app_state.scanner = scanner
app = backend_main.create_app()
client = TestClient(app)


results: list[tuple[bool, str]] = []


def check(desc: str, actual, expected):
    ok = actual == expected
    results.append((ok, desc))
    print(f'  [{"PASS" if ok else "FAIL"}] {desc}  (实际={actual!r} 期望={expected!r})')


def check_true(desc: str, cond):
    check(desc, bool(cond), True)


def section(title: str):
    print('\n' + '=' * 78)
    print(f' {title}')
    print('=' * 78)


# ──────────────────────────────────────────────────────────────────────────
section('场景 1：建包 & 返回字段齐全')
created = client.post('/api/packs', json={'name': '射击包', 'mod_ids': ['a.vpk', 'b.vpk']})
check('POST /api/packs 状态码 = 200', created.status_code, 200)
pack = created.json()['pack']
pack_id = pack['id']
check('mod_ids = [a.vpk, b.vpk]', pack['mod_ids'], ['a.vpk', 'b.vpk'])
check('disabled_members 默认 = []', pack['disabled_members'], [])
check('description 默认 = ""', pack['description'], '')
check('cover_mod 默认 = None', pack['cover_mod'], None)

listed = client.get('/api/packs').json()
check('GET /api/packs count = 1', listed['count'], 1)
first = listed['packs'][0]
check_true('GET 返回含 disabled_members/description/cover_mod',
           {'disabled_members', 'description', 'cover_mod', 'mod_ids'} <= set(first))


# ──────────────────────────────────────────────────────────────────────────
section('场景 2：PUT 整体替换成员（保序去重）')
replaced = client.put(f'/api/packs/{pack_id}', json={
    'mod_ids': ['b.vpk', 'a.vpk', 'b.vpk', '', 'c.vpk'],
})
check('替换后状态码 = 200', replaced.status_code, 200)
check('去重保序 = [b.vpk, a.vpk, c.vpk]',
      replaced.json()['pack']['mod_ids'], ['b.vpk', 'a.vpk', 'c.vpk'])


# ──────────────────────────────────────────────────────────────────────────
section('场景 3：快照写入（disabled_members / description / cover_mod）能读回')
snap = client.put(f'/api/packs/{pack_id}', json={
    'disabled_members': ['b.vpk', 'c.vpk'],
    'description': '近战/冷兵器场景',
    'cover_mod': 'a.vpk',
})
check('快照状态码 = 200', snap.status_code, 200)
snap_pack = snap.json()['pack']
check('disabled_members = [b.vpk, c.vpk]', snap_pack['disabled_members'], ['b.vpk', 'c.vpk'])
check('description 写回', snap_pack['description'], '近战/冷兵器场景')
check('cover_mod = a.vpk', snap_pack['cover_mod'], 'a.vpk')

# GET 再读一遍确认落盘
got = client.get('/api/packs').json()['packs'][0]
check('GET disabled_members 一致', got['disabled_members'], ['b.vpk', 'c.vpk'])
check('GET description 一致', got['description'], '近战/冷兵器场景')
check('GET cover_mod 一致', got['cover_mod'], 'a.vpk')


# ──────────────────────────────────────────────────────────────────────────
section('场景 4：apply 按 disabled_members 精确恢复启停')
apply1 = client.post(f'/api/packs/{pack_id}/apply', json={})
check('apply 状态码 = 200', apply1.status_code, 200)
body = apply1.json()
check('enable_map：a 开 / b 关 / c 关', body['enable_map'],
      {'b.vpk': False, 'a.vpk': True, 'c.vpk': False})
check('missing = []', body['missing'], [])
check('outside_disabled = []', body['outside_disabled'], [])
# 真实写进了 addonlist.txt
states = scanner._read_addonlist()
check('addonlist: a.vpk = True', states.get('a.vpk'), True)
check('addonlist: b.vpk = False', states.get('b.vpk'), False)
check('addonlist: c.vpk = False', states.get('c.vpk'), False)


# ──────────────────────────────────────────────────────────────────────────
section('场景 5：apply + disable_others 关掉包外已启用的 Mod')
# 新开一个只含 a 的包，并把 b、c 手动打开（模拟上一个场景残留）
pack2_id = client.post('/api/packs', json={'name': '精简包', 'mod_ids': ['a.vpk']}).json()['pack']['id']
scanner.set_mods_states({'b.vpk': True, 'c.vpk': True})
check('准备：b 已启用', scanner._read_addonlist().get('b.vpk'), True)
check('准备：c 已启用', scanner._read_addonlist().get('c.vpk'), True)

apply2 = client.post(f'/api/packs/{pack2_id}/apply', json={'disable_others': True}).json()
check('包内 a 仍启用', apply2['enable_map'].get('a.vpk'), True)
check('包外 b 被关', apply2['enable_map'].get('b.vpk'), False)
check('包外 c 被关', apply2['enable_map'].get('c.vpk'), False)
check_true('outside_disabled 含 b.vpk', 'b.vpk' in apply2['outside_disabled'])
check_true('outside_disabled 含 c.vpk', 'c.vpk' in apply2['outside_disabled'])
check('addonlist 中 b 已禁用', scanner._read_addonlist().get('b.vpk'), False)


# ──────────────────────────────────────────────────────────────────────────
section('场景 6：移除成员后 disabled 引用被自动清理')
# pack1 现在成员 [b,a,c]，disabled [b,c]；移除 b 后应从 disabled 里消失
cleaned = client.put(f'/api/packs/{pack_id}', json={'remove_mods': ['b.vpk']}).json()['pack']
check('移除 b 后 mod_ids = [a.vpk, c.vpk]', cleaned['mod_ids'], ['a.vpk', 'c.vpk'])
check('移除 b 后 disabled_members = [c.vpk]', cleaned['disabled_members'], ['c.vpk'])


# ──────────────────────────────────────────────────────────────────────────
section('场景 7：PackData 容忍未知键（旧版回滚不崩，HTTP 也不 500）')
raw = {'id': 'weird', 'name': '未来包', 'mod_ids': ['a.vpk'],
       'created_at': 't0', 'updated_at': 't1',
       'unknown_future_key': {'nested': 1}, 'another_unknown': 42}
parsed = PackData.from_dict(raw)
check('from_dict 过滤未知键后 id 正常', parsed.id, 'weird')
check('from_dict 未知键未被挂上', hasattr(parsed, 'unknown_future_key'), False)
check('from_dict 缺省新字段 = []', parsed.disabled_members, [])

# 直接往 data.json 塞一个带未知键的 pack，HTTP 侧应能读出来而不是 500
data = ds._read_data_raw()
data['packs'].append(dict(raw))
ds._write_data_raw(data)
ds._cache = None
ds._cache_timestamp = 0.0
after = client.get('/api/packs')
check('带未知键的包 GET 状态码 = 200', after.status_code, 200)
names = {p['name'] for p in after.json()['packs']}
check_true('带未知键的包出现在列表里', '未来包' in names)


# ──────────────────────────────────────────────────────────────────────────
section('结果')
failed = [d for ok, d in results if not ok]
print(f'  {len(results) - len(failed)} / {len(results)} 项通过')
for d in failed:
    print(f'   - 未通过：{d}')

# ── 清理临时产物 ──
shutil.rmtree(ROOT, ignore_errors=True)
shutil.rmtree(TEMP_HOME, ignore_errors=True)

raise SystemExit(1 if failed else 0)
