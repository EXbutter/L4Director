"""验证「同步 Steam 订阅」的对账逻辑（隔离环境，不联网、不动真实文件）：

1. 三类结果算得对：订阅了本地没有（待下载）／本地有但已取消订阅（待删除）／两边都有；
2. 待下载按「订阅时间倒序」排（刚订的排前面，用户更容易认出来）；
3. 只有 `<纯数字>.vpk` 参与对账 —— 非数字文件名、封面 jpg 一概不理
   （同步会删文件，宁愿漏删也不能认错路径）；
4. 没有 API Key 时明确报错，不能悄悄返回「0 个订阅」；
5. 订阅只信 api.steampowered.com：中国区端点返回空时不采信，且国际站有数据
   就不再问第二家（省一次 4 秒）；国际站失败时才回退；
6. 5 分钟缓存生效。

跑法：python scripts/verify_subscription_sync.py
"""
import os
import sys
import tempfile
from pathlib import Path

TEMP_HOME = Path(tempfile.mkdtemp(prefix='l4d2-subs-home-'))
os.environ['HOME'] = str(TEMP_HOME)
os.environ['USERPROFILE'] = str(TEMP_HOME)

BACKEND_DIR = Path(__file__).resolve().parent.parent / 'backend'
sys.path.insert(0, str(BACKEND_DIR))

from services import workshop_subscriptions as wsub  # noqa: E402

REPORT = Path(__file__).resolve().parent / '_verify_subscription_sync_out.txt'
lines = []
failures = 0


def log(text=''):
    lines.append(text)
    print(text.encode('ascii', 'replace').decode('ascii'))


def check(label, actual, expected):
    global failures
    ok = actual == expected
    if not ok:
        failures += 1
    lines.append(f"  [{'OK  ' if ok else 'FAIL'}] {label}: {actual!r}（期望 {expected!r}）")
    print(f"  [{'OK' if ok else 'FAIL'}] {label}")


SUBS = [
    {'publishedfileid': '111', 'title': '旧订阅', 'file_size': '100', 'time_subscribed': 100},
    {'publishedfileid': '222', 'title': '新订阅', 'file_size': '200', 'time_subscribed': 900},
    {'publishedfileid': '333', 'title': '中间订阅', 'file_size': '300', 'time_subscribed': 500},
]

STEAM_ID = '76561190000000001'

# 保住原始实现：场景 1 会把 fetch_subscriptions 换成假的，场景 3 要还原回来
ORIG_FETCH = wsub.fetch_subscriptions
ORIG_PAGE = wsub._fetch_page

ROOT = Path(tempfile.mkdtemp(prefix='l4d2-subs-'))
ADDONS = ROOT / 'left4dead2' / 'addons'
WS = ADDONS / 'workshop'
WS.mkdir(parents=True)

# 本地：111 在订阅里；444 已取消订阅；另放两个不该被认成工坊条目的文件
for name in ('111.vpk', '444.vpk', 'my-addon.vpk', '111.jpg'):
    (WS / name).write_bytes(b'x' * 32)

log('=' * 78)
log(' 场景 1：三类结果')
log('=' * 78)
wsub.wb.get_api_key = lambda: 'x' * 32
wsub.fetch_subscriptions = lambda key, sid: (list(SUBS), len(SUBS))
wsub.clear_cache()

d = wsub.diff(STEAM_ID, str(ADDONS))
check('Steam 订阅数', d['total_subscribed'], 3)
check('本地工坊条目数（非数字文件名不算）', d['total_local'], 2)
check('两边一致的数量', d['in_sync'], 1)
check('待下载的 ID', [x['id'] for x in d['to_download']], ['222', '333'])
check('待下载按订阅时间倒序', [x['subscribed_at'] for x in d['to_download']], [900, 500])
check('待删除的 ID', [x['id'] for x in d['to_delete']], ['444'])
check('待删除带文件名', d['to_delete'][0]['name'], '444.vpk')
check('待删除带绝对路径', d['to_delete'][0]['path'].endswith('444.vpk'), True)
check('待删除带大小', d['to_delete'][0]['size'], 32)

log('')
log('=' * 78)
log(' 场景 2：没有 API Key')
log('=' * 78)
wsub.wb.get_api_key = lambda: ''
wsub.clear_cache()
try:
    wsub.diff(STEAM_ID, str(ADDONS))
    check('无 key 时应抛错', 'no raise', 'SubscriptionError')
except wsub.SubscriptionError as e:
    check('无 key 时明确报错', 'API Key' in str(e), True)
    check('不会静默返回 0 个订阅', '0 个' in str(e), False)

log('')
log('=' * 78)
log(' 场景 3：只信国际站（中国区端点返回空是已知坑）')
log('=' * 78)
wsub.wb.get_api_key = lambda: 'x' * 32
wsub.fetch_subscriptions = ORIG_FETCH      # 场景 1 的假实现要还原，否则走不到 _fetch_page
wsub.clear_cache()

calls = []


def fake_page(host, key, sid, page):
    calls.append(host)
    if host == 'api.steampowered.com':
        return len(SUBS), (list(SUBS) if page == 1 else [])
    return 0, []          # 复刻实测行为：中国区返回空，但**不报错**


wsub._fetch_page = fake_page
items, total = wsub.fetch_subscriptions('x' * 32, STEAM_ID)
check('拿到国际站的 3 条', len(items), 3)
check('先问国际站', calls[0], 'api.steampowered.com')
check('国际站数据完整 → 不再问中国站', calls.count('api.steamchina.com'), 0)

# 国际站失败时才回退
calls.clear()


def fallback_page(host, key, sid, page):
    calls.append(host)
    if host == 'api.steampowered.com':
        raise TimeoutError('blocked')
    return len(SUBS), (list(SUBS) if page == 1 else [])


wsub._fetch_page = fallback_page
items, total = wsub.fetch_subscriptions('x' * 32, STEAM_ID)
check('国际站失败 → 回退中国站', (len(items), calls[-1]), (3, 'api.steamchina.com'))

log('')
log('=' * 78)
log(' 场景 4：缓存（同一账号第二次不再打接口）')
log('=' * 78)
wsub._fetch_page = fake_page
wsub.clear_cache()
calls.clear()
wsub.subscriptions(STEAM_ID)
before = len(calls)
wsub.subscriptions(STEAM_ID)
check('第二次走缓存', len(calls), before)
wsub.clear_cache()
wsub.subscriptions(STEAM_ID)
check('清缓存后会重新拉', len(calls) > before, True)

log('')
log('=' * 78)
log(f' 结果：{"全部通过" if failures == 0 else f"{failures} 项失败"}')
log('=' * 78)

REPORT.write_text('\n'.join(lines), encoding='utf-8')
print(f'REPORT: {"ALL PASS" if failures == 0 else f"{failures} FAILED"}')
sys.exit(1 if failures else 0)
