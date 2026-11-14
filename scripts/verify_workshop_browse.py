"""白盒校验：创意工坊浏览器（v1.3.1 / T1-T9）。

全部离线跑，不联网。重点覆盖本次实测踩到的两个「静默失败」：

  A. `requiredtags=Sounds` 这种标量写法会被 Steam **静默忽略**（返回全站 7 万条，
     不报错）。必须用 `requiredtags[0]=Sounds` —— 这是最难排查的那类 bug，
     用户只会看到「筛选点了没反应」。
  B. 浏览页里每个条目出现两次（封面链接 + 标题链接），直接数 `filedetails/?id=`
     会得到 60 个，看起来像「一页 60 条」。只认「链接内直接跟 img」才恰好 30 条。

除此之外还校验：字段归一化、缓存命中、已下载标记、key 掩码与拒收、
错误提示必须给出可执行动作。

运行：python scripts/verify_workshop_browse.py
"""
import json
import os
import re
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix='l4d2_wb_'))
os.environ['USERPROFILE'] = str(TMP)
os.environ['HOME'] = str(TMP)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services import workshop_browse as wb  # noqa: E402

ok = True
failed: list[str] = []


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
        failed.append(label)
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


# 把配置路径指到临时目录，绝不碰用户真实的 config.json
wb._CONFIG_DIR = TMP / '.l4d2-manager'
wb._CONFIG_PATH = wb._CONFIG_DIR / 'config.json'
wb._CONFIG_DIR.mkdir(parents=True, exist_ok=True)

print('=' * 78)
print('A. 浏览页解析：条目重复计数与顺序')
print('=' * 78)

# 真实结构：每个条目一个封面链接（内含 img）+ 一个标题链接（无 img）
CARD = ('<div class="workshopItem"><a href="https://steamcommunity.com/sharedfiles/'
        'filedetails/?id={id}"><img src="https://cdn/{id}.jpg" alt=""></a>'
        '<a class="ti" href="https://steamcommunity.com/sharedfiles/filedetails/?id={id}">'
        '<div class="workshopItemTitle">标题 {id}</div></a></div>')
html = ''.join(CARD.format(id=i) for i in (111, 222, 333))
ids = wb.parse_html_ids(html)
check('3 个条目解析出 3 个 ID（不是 6 个）', len(ids) == 3, f'实际 {len(ids)}')
check('顺序与页面一致', ids == ['111', '222', '333'], str(ids))
check('重复 ID 去重', wb.parse_html_ids(CARD.format(id=1) * 3) == ['1'])

real_fixture = Path(__file__).resolve().parents[1] / '.tmp_preview' / 'dump_browse.html'
if real_fixture.exists():
    real = wb.parse_html_ids(real_fixture.read_text(encoding='utf-8', errors='replace'))
    check('真实页面抓出 30 个 ID', len(real) == 30, f'实际 {len(real)}')
else:
    print('[SKIP] 没有真实页面 fixture（.tmp_preview/dump_browse.html）')

check('空页面返回空列表', wb.parse_html_ids('') == [])

print()
print('=' * 78)
print('B. 标签参数：必须是数组形式（标量会被静默忽略）')
print('=' * 78)

captured: dict = {}


def fake_query(host, path, params, timeout=20.0):
    captured['params'] = dict(params)
    captured['host'] = host
    # 与真实接口一致：外层包一个 response
    return {'response': {'publishedfiledetails': [], 'total': 0, 'next_cursor': ''}}


orig_get_json = wb._http_get_json
wb._http_get_json = fake_query
try:
    wb._query_files('A' * 32, page_size=100, cursor='',
                    filters={'sort': 'trend', 'tags': ['Sounds', 'Weapons'], 'match_all': True})
    p = captured['params']
    check('存在 requiredtags[0]', 'requiredtags[0]' in p, str(list(p)))
    check('存在 requiredtags[1]', 'requiredtags[1]' in p)
    check('不存在标量 requiredtags（会被忽略）', 'requiredtags' not in p)
    check('match_all_tags=true 已传', p.get('match_all_tags') == 'true')
    check('creator_appid=550（否则混进 15 万张 SFM 艺术图）', str(p.get('creator_appid')) == '550', str(p.get('creator_appid')))
    check('numperpage 不超过 100', int(p.get('numperpage', 0)) <= 100)
    check('首屏 cursor 用 *', p.get('cursor') == '*')

    # 关键词搜索必须切到文本相关性排序，否则第 2 页顺序会打架
    wb._query_files('A' * 32, page_size=100, cursor='',
                    filters={'sort': 'trend', 'q': '坦克'})
    check('带关键词时 query_type 改为 12', str(captured['params'].get('query_type')) == '12', str(captured['params'].get('query_type')))

    wb._query_files('A' * 32, page_size=100, cursor='CUR',
                    filters={'sort': 'trend', 'q': '坦克'})
    check('第 2 页仍保持文本排序', str(captured['params'].get('query_type')) == '12', str(captured['params'].get('query_type')))
    check('cursor 原样传回', captured['params'].get('cursor') == 'CUR')

    # 非法标签要被丢掉，不能原样发出去
    wb._query_files('A' * 32, page_size=100, cursor='',
                    filters={'sort': 'trend', 'tags': ['搞不懂的标签', 'Sounds']})
    p2 = captured['params']
    check('非法标签被过滤', 'requiredtags[1]' not in p2 and p2.get('requiredtags[0]') == 'Sounds')
finally:
    wb._http_get_json = orig_get_json

print()
print('=' * 78)
print('C. 标签词表一致性')
print('=' * 78)
check('Sounds 在白名单里', 'Sounds' in wb.VALID_TAGS)
check('单数 Sound 不在白名单（Steam 侧返回 0 条但不报错）', 'Sound' not in wb.VALID_TAGS)
check('Special Infected 带空格也在白名单', 'Special Infected' in wb.VALID_TAGS)
missing = [t for g in wb.TAG_GROUPS for t in g['tags'] if t not in wb.TAG_LABELS]
check('每个标签都有中文名', not missing, str(missing))
check('5 个分组都不为空', all(g['tags'] for g in wb.TAG_GROUPS))

print()
print('=' * 78)
print('D. 字段归一化')
print('=' * 78)

raw_api = {
    'publishedfileid': '3838979643', 'title': ' 测试 Mod ', 'file_size': 642300171,
    'time_created': 1794581076, 'time_updated': 1794587727,
    'subscriptions': 397, 'lifetime_subscriptions': 553, 'views': 1327, 'favorited': 179,
    'preview_url': 'https://images/x.jpg', 'banned': False, 'result': 1,
    'tags': [{'tag': 'UI', 'display_name': 'UI'}, {'tag': 'Sounds', 'display_name': 'Sounds'}],
    'short_description': '简介', 'vote_data': {'score': 0.6369863, 'votes_up': 43, 'votes_down': 3},
    'filename': 'content.vpk',
}
n = wb._normalize(raw_api)
check('ID 转字符串', n['id'] == '3838979643')
check('标题去两端空格', n['title'] == '测试 Mod')
check('标签转 name/label 且带中文', n['tags'][1] == {'name': 'Sounds', 'label': '音效'}, str(n['tags']))
check('评分从 0~1 转成 0~100 并保留一位', n['score'] == 63.7, str(n['score']))
check('赞踩数保留', (n['votes_up'], n['votes_down']) == (43, 3))
check('大小/订阅/浏览直通', (n['size'], n['subscriptions'], n['views']) == (642300171, 397, 1327))
check('缺 short_description 时回落 description', wb._normalize({'description': '长描述'})['description'] == '长描述')
check('缺 vote_data 时评分为 None', wb._normalize({'publishedfileid': '1'})['score'] is None)
check('缺字段不抛异常（脏数据兜底）', wb._normalize({})['size'] == 0)

print()
print('=' * 78)
print('E. Key 的存取、掩码与拒收')
print('=' * 78)
check('掩码不泄漏全文', wb.mask_key('0123456789ABCDEF0123456789ABCDEF') == '0123…CDEF')
check('空 key 掩码为空', wb.mask_key('') == '')
check('32 位十六进制通过', wb._looks_like_key('0123456789ABCDEF0123456789ABCDEF'))
check('带「密钥:」前缀被拒', not wb._looks_like_key('密钥: 0123456789ABCDEF0123456789ABCDEF'))
check('31 位被拒', not wb._looks_like_key('0123456789ABCDEF0123456789ABCDE'))
check('含非十六进制字符被拒', not wb._looks_like_key('ZZZZ0123456789ABCDEF0123456789ABCDEF'))

wb.set_api_key('0123456789ABCDEF0123456789ABCDEF')
check('保存后状态为已配置', wb.key_status()['configured'])
check('保存后 get_api_key 能读回', wb.get_api_key() == '0123456789ABCDEF0123456789ABCDEF')
saved = json.loads(wb._CONFIG_PATH.read_text(encoding='utf-8'))
# v1.3.1 起 key 一律 DPAPI 加密落盘（见 verify_secret_hygiene.py 的详细断言）
if wb.dpapi_available():
    check('写盘后走加密字段', str(saved.get('steam_api_key_enc', '')).startswith('dpapi:v1:'))
    check('写盘后文件里没有明文',
          '0123456789ABCDEF0123456789ABCDEF' not in wb._CONFIG_PATH.read_text(encoding='utf-8'))
else:
    check('非 Windows 平台退化为明文字段', saved.get('steam_api_key', '').startswith('0123'))

# 模拟"另一个模块保存 addons 路径"：不能把 key 冲掉
before = wb.get_api_key()
data = json.loads(wb._CONFIG_PATH.read_text(encoding='utf-8'))
data['addons_path'] = 'D:/fake/addons'
wb._CONFIG_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
check('改 addons 路径后 key 仍在', wb.get_api_key() == before)

thrown = ''
try:
    wb.set_api_key('密钥: 0123456789ABCDEF0123456789ABCDEF')
except wb.WorkshopError as e:
    thrown = str(e)
check('非法 key 抛错且说明格式', '32 位' in thrown, thrown)

wb.set_api_key('')
check('空字符串即清除', not wb.key_status()['configured'])

print()
print('=' * 78)
print('F. 两条路径的 browse（离线桩）')
print('=' * 78)

wb.clear_cache()
fake_html = ''.join(CARD.format(id=i) for i in (101, 202, 303))
fake_details = [
    {'publishedfileid': '303', 'title': '第三个', 'result': 1, 'file_size': 3, 'tags': []},
    {'publishedfileid': '101', 'title': '第一个', 'result': 1, 'file_size': 1, 'tags': []},
    {'publishedfileid': '202', 'title': '第二个', 'result': 1, 'file_size': 2, 'tags': []},
]
orig_html = wb._http_get_html
orig_details = wb.fetch_details
wb._http_get_html = lambda url, timeout=20.0: fake_html
wb.fetch_details = lambda ids: fake_details
try:
    r = wb.browse({'sort': 'trend'}, '', None)
    check('HTML 路径 source=html', r['source'] == 'html')
    check('按网页顺序重排（不是详情接口返回顺序）',
          [it['id'] for it in r['items']] == ['101', '202', '303'],
          str([it['id'] for it in r['items']]))
    check('HTML 路径不编造总数', r['total'] == 0)
    check('不足一页时 has_more=False', r['has_more'] is False)

    r2 = wb.browse({'sort': 'trend'}, '', None)
    check('第二次命中缓存', r2['cached'] is True)

    # 已下载标记：addons/workshop 下的 <id>.vpk
    root = TMP / 'addons'
    (root / 'workshop').mkdir(parents=True, exist_ok=True)
    (root / 'workshop' / '202.vpk').write_bytes(b'x')
    wb.clear_cache()
    r3 = wb.browse({'sort': 'trend'}, '', str(root))
    flags = {it['id']: it['downloaded'] for it in r3['items']}
    check('本地已有的条目标为已下载', flags.get('202') is True and flags.get('101') is False, str(flags))

    # 「最近更新」排序没 key 时必须明确报错，而不是悄悄降级
    wb.clear_cache()
    thrown = ''
    try:
        wb.browse({'sort': 'updated'}, '', None)
    except wb.WorkshopError as e:
        thrown = str(e)
    check('无 key 时「最近更新」明确报错', 'API Key' in thrown, thrown)
finally:
    wb._http_get_html = orig_html
    wb.fetch_details = orig_details

print()
print('=' * 78)
print('G. 错误提示必须可执行')
print('=' * 78)
wb.clear_cache()
orig_html2 = wb._http_get_html


def boom(url, timeout=20.0):
    raise OSError('network down')


wb._http_get_html = boom
thrown = ''
try:
    wb.browse({'sort': 'trend'}, '', None)
except wb.WorkshopError as e:
    thrown = str(e)
finally:
    wb._http_get_html = orig_html2
check('网页连不上时提示加速器或配 key', ('加速器' in thrown) and ('API Key' in thrown), thrown)

wb.clear_cache()
orig_html3 = wb._http_get_html
wb._http_get_html = lambda url, timeout=20.0: '<html><body>结构完全变了</body></html>'
thrown = ''
try:
    wb.browse({'sort': 'trend'}, '', None)
except wb.WorkshopError as e:
    thrown = str(e)
finally:
    wb._http_get_html = orig_html3
check('解析不出条目时说明可能改版', '改版' in thrown, thrown)

thrown = ''
try:
    wb.item_detail('abc')
except wb.WorkshopError as e:
    thrown = str(e)
check('非法 ID 被拒', '纯数字' in thrown, thrown)

print()
print('=' * 78)
print('H. meta 给前端的静态信息')
print('=' * 78)
wb.set_api_key('')
m = wb.meta()
check('无 key 时 source=html', m['source'] == 'html')
check('无 key 时每页 30 条', m['page_size'] == 30)
check('5 种排序都在', len(m['sorts']) == 5)
check('「最近更新」标记需要 key', [s for s in m['sorts'] if s['id'] == 'updated'][0]['requires_key'] is True)
wb.set_api_key('0123456789ABCDEF0123456789ABCDEF')
m2 = wb.meta()
check('有 key 时 source=api 且每页 100', m2['source'] == 'api' and m2['page_size'] == 100)
check('meta 只回掩码', m2['key_masked'] == '0123…CDEF', m2['key_masked'])
check('meta 不含 key 原文', '0123456789ABCDEF0123456789ABCDEF' not in json.dumps(m2, ensure_ascii=False))

print()
print('=' * 78)
print(f'结果：{"全部通过" if ok else "有失败项"}（{"、".join(failed) if failed else "无"}）')
print('=' * 78)
sys.exit(0 if ok else 1)
