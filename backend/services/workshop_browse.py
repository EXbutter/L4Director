"""创意工坊浏览 / 搜索。

两条数据路径，对外是同一个接口：

  1) **HTML 路径（默认，零配置）**
     `steamcommunity.com/workshop/browse/` 只负责回答「这一页有哪 30 个 ID」，
     大小/更新时间/订阅/标签/封面一律回源到免 key 的 `GetPublishedFileDetails`。
     这样即使 Steam 改版换掉卡片结构，只要「a > img」还在，解析器就还能活。

  2) **API 路径（设置里填了 Steam Web API Key 才走）**
     `IPublishedFileService/QueryFiles`：100 条/次、带评分、能拿精确总数、
     `cursor` 深翻页。国内蒸汽平台端点实测 100 条约 1.0s。

几个实测踩过的坑，写在这里免得以后重犯：

* QueryFiles 的数组参数**必须**用 `requiredtags[0]=...`。写成 `requiredtags=Sounds`
  不会报错，参数被**静默忽略**，返回的还是全站 7 万条 —— 表现为「筛选点了没反应」。
* 标签值必须是工坊内部名且**复数**：`Sounds` 有 8 万条，`Sound` 是 0 条，同样不报错。
* `creator_appid` 不传会得到 22.7 万条（混进大量 SFM 上传的艺术图），
  传 `creator_appid=550` 才是 7.2 万条真正的 L4D2 工坊条目。
* `numperpage` 上限就是 100，传 200 也只回 100。
* HTML 列表里每个条目出现**两次**（封面链接 + 标题链接），
  只认「链接内直接跟 img」的那次才恰好 30 条。

API Key 只存在用户数据目录 `~/.l4d2-manager/config.json`，**而且是加密的**：
Windows 下用 DPAPI（`CryptProtectData`）以当前用户凭据加密，密文只能被同一个
Windows 账户解密 —— 别的程序读到文件、云盘同步走了文件、或者用户把 config.json
贴到 issue 里，都拿不到 key。旧版本留下的明文字段会在第一次读取时自动迁移。

其它几条不变：不进仓库、不上传、日志和接口里只出现指纹（首 4 末 4 位）。
Steam 使用条款明确要求 key 保密且不得分享给第三方，所以它只能由用户自己填，
绝不能内置进发行包。
"""

from __future__ import annotations

import base64
import ctypes
import gzip
import json
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from .workshop_downloader import fetch_details

# ---------------------------------------------------------------- 常量

APP_ID = 550
# 国内优先：实测 100 条 1.0s，国际站 1.5s 起且抖动大
API_ENDPOINTS = ("api.steamchina.com", "api.steampowered.com")
QUERY_FILES_PATH = "/IPublishedFileService/QueryFiles/v1/"
# 详情页专用：只有 GetDetails 支持 includeadditionalpreviews / includechildren，
# 下载解析用的 ISteamRemoteStorage/GetPublishedFileDetails 这两样都不返回。
DETAILS_PATH = "/IPublishedFileService/GetDetails/v1/"
HTML_BROWSE_URL = "https://steamcommunity.com/workshop/browse/"
HTML_DETAIL_URL = "https://steamcommunity.com/sharedfiles/filedetails/"

HTML_PAGE_SIZE = 30          # 网页恒定 30 条/页，numperpage 参数无效
API_PAGE_SIZE = 100          # 服务端硬上限就是 100
HTML_MIN_INTERVAL = 1.2      # 两次抓网页之间的最小间隔，避免被限流
CACHE_TTL = 480.0            # 8 分钟
CACHE_MAX = 60

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

_CONFIG_DIR = Path.home() / '.l4d2-manager'
_CONFIG_PATH = _CONFIG_DIR / 'config.json'

_SSL_CTX = ssl.create_default_context()
# 国内端点解析到国内 IP，塞进境外代理只会白等一轮超时，所以显式空 ProxyHandler
_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPSHandler(context=_SSL_CTX),
)

_lock = threading.RLock()


class WorkshopError(Exception):
    """给界面看的错误：message 必须是一句用户能照做的话。"""


# ---------------------------------------------------------------- 排序

# value -> (显示名, API query_type, HTML browsesort, 是否必须 key)
#
# 「最近更新」是 API 独有的排序（QueryFiles 的 RankedByLastUpdatedDate），
# 网页那四种 browsesort 里没有对应项，所以没 key 时这一项要置灰而不是悄悄降级
# —— 悄悄换成「最新发布」会让用户以为排序坏了。
SORTS: dict[str, tuple[str, int, str, bool]] = {
    'trend':   ('趋势',   3,  'trend',         False),
    'new':     ('最新发布', 1,  'mostrecent',    False),
    'updated': ('最近更新', 21, '',             True),
    'top':     ('评分最高', 0,  'toprated',      False),
    'subs':    ('订阅最多', 9,  'mostsubscribed', False),
}


# ---------------------------------------------------------------- 标签词表

# 实测翻 6 页 600 条样本统计出来的真实标签（网页筛选器只暴露其中一部分）。
# 按语义分组，前端照这个结构渲染。
TAG_GROUPS: list[dict[str, Any]] = [
    {
        'id': 'type', 'label': '类型',
        'tags': ['Campaigns', 'Weapons', 'Items', 'Sounds', 'Scripts', 'UI',
                 'Models', 'Textures', 'Miscellaneous', 'Mutations'],
    },
    {
        'id': 'survivor', 'label': '角色',
        'tags': ['Survivors', 'Bill', 'Coach', 'Ellis', 'Francis',
                 'Louis', 'Nick', 'Rochelle', 'Zoey'],
    },
    {
        'id': 'infected', 'label': '特殊感染者',
        'tags': ['Special Infected', 'Boomer', 'Charger', 'Hunter', 'Jockey',
                 'Smoker', 'Spitter', 'Tank', 'Witch', 'Common Infected'],
    },
    {
        'id': 'weapon', 'label': '武器',
        'tags': ['Rifle', 'Shotgun', 'SMG', 'Sniper', 'Pistol', 'Melee',
                 'Throwable', 'M60', 'Grenade Launcher'],
    },
    {
        'id': 'mode', 'label': '模式',
        'tags': ['Co-op', 'Versus', 'Survival', 'Scavenge', 'Realism',
                 'Realism Versus', 'Single Player'],
    },
]

# 标签中文名：只给界面上出现的那些，查不到就原样显示英文
TAG_LABELS: dict[str, str] = {
    'Campaigns': '战役地图', 'Weapons': '武器', 'Items': '物品',
    'Sounds': '音效', 'Scripts': '脚本', 'UI': '界面',
    'Models': '模型', 'Textures': '贴图', 'Miscellaneous': '杂项',
    'Mutations': '突变模式',
    'Survivors': '幸存者', 'Special Infected': '特感', 'Common Infected': '普通感染者',
    'Bill': '比尔', 'Coach': '教练', 'Ellis': '埃利斯', 'Francis': '弗朗西斯',
    'Louis': '路易斯', 'Nick': '尼克', 'Rochelle': '萝榭尔', 'Zoey': '佐伊',
    'Boomer': 'Boomer', 'Charger': 'Charger', 'Hunter': 'Hunter', 'Jockey': 'Jockey',
    'Smoker': 'Smoker', 'Spitter': 'Spitter', 'Tank': 'Tank', 'Witch': 'Witch',
    'Rifle': '步枪', 'Shotgun': '霰弹枪', 'SMG': '冲锋枪', 'Sniper': '狙击枪',
    'Pistol': '手枪', 'Melee': '近战', 'Throwable': '投掷物',
    'M60': 'M60', 'Grenade Launcher': '榴弹发射器',
    'Co-op': '战役', 'Versus': '对抗', 'Survival': '生存', 'Scavenge': '清道夫',
    'Realism': '写实', 'Realism Versus': '写实对抗', 'Single Player': '单人',
}

VALID_TAGS = {t for g in TAG_GROUPS for t in g['tags']}


# ---------------------------------------------------------------- 缓存

_cache: 'OrderedDict[str, tuple[float, Any]]' = OrderedDict()
_last_html_fetch = 0.0


def _cache_get(key: str):
    with _lock:
        hit = _cache.get(key)
        if not hit:
            return None
        ts, payload = hit
        if time.time() - ts > CACHE_TTL:
            _cache.pop(key, None)
            return None
        _cache.move_to_end(key)
        return payload


def _cache_put(key: str, payload):
    with _lock:
        _cache[key] = (time.time(), payload)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)


def clear_cache():
    with _lock:
        _cache.clear()


# ---------------------------------------------------------------- API Key

# 明文字段只用于「读旧配置」，新写入一律走加密字段。
_KEY_FIELD = 'steam_api_key'
_KEY_ENC_FIELD = 'steam_api_key_enc'
_KEY_ENV = 'L4DIRECTOR_STEAM_KEY'
_ENC_PREFIX = 'dpapi:v1:'
# 附加熵：即使同一账户下别的程序也调 CryptProtectData，密文也不能互换取用
_KEY_ENTROPY = b'L4Director/steam_api_key/v1'
_HEX32 = re.compile(r'[0-9A-Fa-f]{32}')


class _DataBlob(ctypes.Structure):
    """DPAPI 的 DATA_BLOB。pbData 是 LocalAlloc 出来的，用完必须 LocalFree。"""
    _fields_ = [
        ('cbData', ctypes.c_uint32),
        ('pbData', ctypes.POINTER(ctypes.c_char)),
    ]


def dpapi_available() -> bool:
    return os.name == 'nt'


def _dpapi(protect: bool, data: bytes) -> bytes:
    """调 Windows DPAPI。加密/解密的参数结构相同，只是函数不同。"""
    if not dpapi_available():
        raise OSError('当前平台没有 DPAPI')
    crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    fn.restype = ctypes.c_int
    CRYPTPROTECT_UI_FORBIDDEN = 0x1   # 后台服务里绝不能弹凭据框

    in_buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _DataBlob(len(data), ctypes.cast(in_buf, ctypes.POINTER(ctypes.c_char)))
    ent_buf = ctypes.create_string_buffer(_KEY_ENTROPY, len(_KEY_ENTROPY))
    blob_ent = _DataBlob(len(_KEY_ENTROPY), ctypes.cast(ent_buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DataBlob()

    ok = fn(ctypes.byref(blob_in), None, ctypes.byref(blob_ent), None, None,
            CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out))
    if not ok:
        raise OSError(ctypes.get_last_error(), 'DPAPI 调用失败')
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(blob_out.pbData, ctypes.c_void_p))


def _seal(plain: str) -> str:
    """加密成可直接写进 JSON 的字符串。平台不支持时返回空串。"""
    if not dpapi_available():
        return ''
    try:
        return _ENC_PREFIX + base64.b64encode(_dpapi(True, plain.encode('utf-8'))).decode('ascii')
    except OSError as e:
        print(f"[Workshop] 加密 key 失败，本次不落盘：{e}")
        return ''


def _unseal(sealed: str) -> str:
    """解不开就返回空串 —— 换 Windows 账户 / 换机器 / 文件损坏都会走到这。"""
    if not sealed.startswith(_ENC_PREFIX):
        return ''
    try:
        raw = base64.b64decode(sealed[len(_ENC_PREFIX):].encode('ascii'), validate=True)
        return _dpapi(False, raw).decode('utf-8', 'strict')
    except Exception:
        return ''


def redact(text: str) -> str:
    """把任何 32 位十六进制串打成 ****。错误信息、日志出口统一过它。"""
    return _HEX32.sub('****', text or '')


def _read_config() -> dict:
    if not _CONFIG_PATH.exists():
        return {}
    try:
        data = json.loads(_CONFIG_PATH.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"[Workshop] 读取 {_CONFIG_PATH} 失败（将忽略其中的设置）：{type(e).__name__}: {e}")
        return {}


def _write_config(patch: dict, drop: tuple[str, ...] = ()):
    """只改指定键，其余原样保留；原子写，避免半个 JSON 把 addons 路径也带走。

    drop 用于真正删掉某个键 —— 只在值置空不够的场景用（比如要把旧明文 key 抹掉，
    而不是留下一个空字符串继续躺在文件里）。
    """
    data = _read_config()
    data.update(patch)
    for k in drop:
        data.pop(k, None)
    data['updated_at'] = datetime.now().isoformat()
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    tmp = _CONFIG_PATH.with_name(_CONFIG_PATH.name + '.tmp')
    try:
        with open(tmp, 'w', encoding='utf-8') as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        tmp.replace(_CONFIG_PATH)
        # 文件的机密性靠 DPAPI（密文），这里 chmod 只是尽量收紧只读位。
        # Windows 上 chmod 改不了 ACL，别指望它挡住同账户的其它程序。
        try:
            os.chmod(_CONFIG_PATH, 0o600)
        except OSError:
            pass
    except OSError as e:
        print(f"[Workshop] 写入 {_CONFIG_PATH} 失败：{e}")
        try:
            tmp.unlink()
        except OSError:
            pass


def get_api_key() -> str:
    """取 key。顺序：环境变量 → 加密字段 → 旧明文字段（并顺手迁移）。

    环境变量优先级最高，方便高级用户完全不落盘；代价是它在进程环境里，
    同账户的其它进程能读到，所以只在用户显式设置时才走这条路。
    """
    env = str(os.environ.get(_KEY_ENV) or '').strip()
    if env and _looks_like_key(env):
        return env

    cfg = _read_config()
    sealed = str(cfg.get(_KEY_ENC_FIELD) or '').strip()
    if sealed:
        key = _unseal(sealed)
        return key if _looks_like_key(key) else ''

    # 旧版本留下的明文：读到就迁移成密文，并把明文字段删掉
    legacy = str(cfg.get(_KEY_FIELD) or '').strip()
    if _looks_like_key(legacy):
        sealed = _seal(legacy)
        if sealed:
            _write_config({_KEY_ENC_FIELD: sealed}, drop=(_KEY_FIELD,))
            print(f"[Workshop] 已把明文 API Key 迁移为 DPAPI 加密存储（{mask_key(legacy)}）")
        return legacy
    return ''


def _looks_like_key(key: str) -> bool:
    return bool(re.fullmatch(r'[0-9A-Fa-f]{32}', key or ''))


def mask_key(key: str) -> str:
    """只回指纹。日志、接口返回一律用它，别把 key 完整吐出去。"""
    if not key:
        return ''
    return f"{key[:4]}…{key[-4:]}" if len(key) > 8 else '…'


def key_storage() -> str:
    """key 现在以什么形式存在：env / dpapi / plaintext / none。"""
    env = str(os.environ.get(_KEY_ENV) or '').strip()
    if env and _looks_like_key(env):
        return 'env'
    cfg = _read_config()
    if str(cfg.get(_KEY_ENC_FIELD) or '').strip().startswith(_ENC_PREFIX):
        return 'dpapi'
    if _looks_like_key(str(cfg.get(_KEY_FIELD) or '').strip()):
        return 'plaintext'
    return 'none'


def set_api_key(key: str) -> dict:
    """保存或清除 key。空字符串 = 清除。落盘一律走加密字段。"""
    key = (key or '').strip()
    if not key:
        _write_config({}, drop=(_KEY_FIELD, _KEY_ENC_FIELD))
        clear_cache()
        return {'configured': False, 'masked': '', 'storage': key_storage()}
    if not _looks_like_key(key):
        raise WorkshopError(
            'Key 格式不对：应该是 32 位十六进制字符（0-9、A-F），'
            '别把前面的「密钥:」一起粘进来')

    sealed = _seal(key)
    if sealed:
        # 加密成功：写密文 + 删掉可能存在的明文，文件里不会再有可读的 key
        _write_config({_KEY_ENC_FIELD: sealed}, drop=(_KEY_FIELD,))
    else:
        # 只在 DPAPI 不可用的平台（非 Windows 开发环境）才退化为明文
        _write_config({_KEY_FIELD: key}, drop=(_KEY_ENC_FIELD,))
    clear_cache()
    return {'configured': True, 'masked': mask_key(key), 'storage': key_storage()}


def key_status() -> dict:
    """给界面看的完整状态。永远不含 key 原文。

    `readable=False` 表示密文存在但解不开（换了 Windows 账户或换机器）——
    这种情况必须让用户知道，否则界面显示「未配置」而他明明填过。
    """
    env = str(os.environ.get(_KEY_ENV) or '').strip()
    cfg = _read_config()
    sealed = str(cfg.get(_KEY_ENC_FIELD) or '').strip()
    key = get_api_key()
    return {
        'configured': bool(key),
        'masked': mask_key(key),
        'storage': key_storage(),
        'readable': bool(key) or not sealed,
        'from_env': bool(env) and _looks_like_key(env),
    }


# ---------------------------------------------------------------- HTTP

def _http_get_json(host: str, path: str, params: dict, timeout: float = 20.0) -> dict:
    url = f"https://{host}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Accept': 'application/json',
    })
    with _OPENER.open(req, timeout=timeout) as r:
        raw = r.read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return json.loads(raw.decode('utf-8', 'replace'))


def _http_get_html(url: str, timeout: float = 20.0) -> str:
    """抓网页。全局限速 ≥1.2s/次：这个页面没有任何官方配额，靠自觉。"""
    global _last_html_fetch
    with _lock:
        wait = HTML_MIN_INTERVAL - (time.time() - _last_html_fetch)
    if wait > 0:
        time.sleep(min(wait, HTML_MIN_INTERVAL))
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip',
    })
    with _OPENER.open(req, timeout=timeout) as r:
        raw = r.read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    with _lock:
        _last_html_fetch = time.time()
    return raw.decode('utf-8', 'replace')


_ITEM_LINK = re.compile(r'filedetails/\?id=(\d+)"[^>]*>\s*<img', re.I)


def parse_html_ids(html: str) -> list[str]:
    """从浏览页拿这一页的 30 个 ID，保持页面顺序。

    每个条目在 HTML 里出现两次（封面链接 + 标题链接），
    只认「链接标签内直接跟 <img>」的那次，否则会得到 60 个 ID。
    """
    ids: list[str] = []
    for m in _ITEM_LINK.finditer(html or ''):
        pid = m.group(1)
        if pid not in ids:
            ids.append(pid)
    return ids


# ---------------------------------------------------------------- 归一化

def _num(v, cast=int):
    try:
        return cast(v)
    except (TypeError, ValueError):
        return 0


def _normalize(raw: dict) -> dict:
    """工坊条目 → 前端卡片/抽屉要的形状。两条路径最后都落到这里。"""
    tags = []
    for t in (raw.get('tags') or []):
        name = t.get('tag') if isinstance(t, dict) else str(t)
        if name:
            tags.append({'name': name, 'label': TAG_LABELS.get(name, name)})

    vote = raw.get('vote_data')
    score = None
    votes_up = votes_down = 0
    if isinstance(vote, dict):
        if vote.get('score') is not None:
            score = round(float(vote['score']) * 100, 1)
        votes_up = _num(vote.get('votes_up'))
        votes_down = _num(vote.get('votes_down'))

    desc = raw.get('short_description') or raw.get('description') or ''

    return {
        'id': str(raw.get('publishedfileid') or ''),
        'title': (raw.get('title') or '').strip(),
        'preview_url': raw.get('preview_url') or '',
        'size': _num(raw.get('file_size')),
        'created_at': _num(raw.get('time_created')),
        'updated_at': _num(raw.get('time_updated')),
        'subscriptions': _num(raw.get('subscriptions')),
        'lifetime_subscriptions': _num(raw.get('lifetime_subscriptions')),
        'views': _num(raw.get('views')),
        'favorited': _num(raw.get('favorited')),
        'tags': tags,
        'description': desc,
        'filename': raw.get('filename') or '',
        'banned': bool(raw.get('banned')),
        'score': score,
        'votes_up': votes_up,
        'votes_down': votes_down,
        'result': _num(raw.get('result')),
    }


# ---------------------------------------------------------------- QueryFiles

def _query_files(key: str, *, page_size: int, cursor: str, filters: dict) -> tuple[dict, str]:
    """按 key 调 QueryFiles，两条线都试。返回 (response, 用到的 host)。"""
    sort = filters['sort']
    query_type = SORTS[sort][1]

    params: dict[str, Any] = {
        'key': key,
        'appid': APP_ID,
        # 不传会混进 SFM 上传的艺术图（22.7 万条 vs 7.2 万条）
        'creator_appid': APP_ID,
        'query_type': query_type,
        'numperpage': page_size,
        'return_tags': 'true',
        'return_previews': 'true',
        'return_short_description': 'true',
        'return_vote_data': 'true',
    }
    if cursor:
        params['cursor'] = cursor
    else:
        params['cursor'] = '*'

    tags = [t for t in (filters.get('tags') or []) if t in VALID_TAGS]
    for i, tag in enumerate(tags):
        # 必须用 [i] 形式；标量形式会被静默忽略
        params[f'requiredtags[{i}]'] = tag
    if tags and filters.get('match_all'):
        params['match_all_tags'] = 'true'

    excluded = [t for t in (filters.get('excluded_tags') or []) if t in VALID_TAGS]
    for i, tag in enumerate(excluded):
        params[f'excludedtags[{i}]'] = tag

    text = (filters.get('q') or '').strip()
    if text:
        params['search_text'] = text
        # 有关键词就一律按文本相关性排序。翻页时也不能回退成 sort 的排序，
        # 否则第 2 页会用「趋势」去重排同一批搜索结果，两页顺序打架、还会重复出血。
        params['query_type'] = 12

    days = _num(filters.get('days'))
    if days and sort == 'trend':
        params['days'] = 7 if days <= 7 else 30

    errs: list[str] = []
    for host in API_ENDPOINTS:
        try:
            data = _http_get_json(host, QUERY_FILES_PATH, params)
            resp = data.get('response') or {}
            if resp.get('publishedfiledetails') is not None or resp.get('total') is not None:
                return resp, host
            errs.append(f'{host}：返回里没有 publishedfiledetails')
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise WorkshopError(
                    'Steam 说这个 API Key 无效或已过期。到 steamcommunity.com/dev/apikey '
                    '重新复制一次（重新注册会让旧 key 立刻失效）')
            errs.append(f'{host}：HTTP {e.code}')
        except Exception as e:
            errs.append(f'{host}：{type(e).__name__}')

    # errs 里只放主机名和异常类型名，不放完整 URL（URL 的 query 里带 key）；
    # 出口再过一遍 redact，防止将来有人往这里塞原始异常文本。
    raise WorkshopError(redact('搜索接口连不上：' + '；'.join(errs[-2:])))


# ---------------------------------------------------------------- HTML 路径

def _html_browse(filters: dict, page: int) -> list[str]:
    sort = filters['sort']
    if SORTS[sort][3]:
        raise WorkshopError('「最近更新」排序需要先填 Steam API Key（网页版工坊没有这个排序）')

    params = {
        'appid': APP_ID,
        'section': 'readytouseitems',
        'browsesort': SORTS[sort][2] or 'trend',
        'p': max(1, page),
    }
    tags = [t for t in (filters.get('tags') or []) if t in VALID_TAGS]
    url = HTML_BROWSE_URL + '?' + urllib.parse.urlencode(params)
    for tag in tags:
        url += '&requiredtags%5B%5D=' + urllib.parse.quote(tag)
    if tags and filters.get('match_all'):
        url += '&match_all_tags=1'

    days = _num(filters.get('days'))
    if days and sort == 'trend':
        url += f'&days={7 if days <= 7 else 30}'

    text = (filters.get('q') or '').strip()
    if text:
        url += '&searchtext=' + urllib.parse.quote(text)

    try:
        html = _http_get_html(url)
    except urllib.error.HTTPError as e:
        raise WorkshopError(f'工坊网页返回 HTTP {e.code}，稍后再试或关掉代理重试')
    except Exception as e:
        raise WorkshopError(
            '连不上 steamcommunity.com。这个页面在国内经常需要加速器：'
            '开加速器后再点重试；或者到设置里填一个 Steam API Key，'
            '填了就不再依赖这个网页（还能一次拿 100 条）')

    ids = parse_html_ids(html)
    if not ids and ('没有找到' in html or 'No items' in html):
        return []
    if not ids:
        raise WorkshopError(
            '工坊页面结构好像变了（一条都没解析出来）。这不是你的问题：'
            'Steam 改版了页面。请把这条消息告诉开发者，或先到设置里填 API Key 绕过')
    return ids


# ---------------------------------------------------------------- 对外接口

def _filter_key(filters: dict, page_token: str) -> str:
    return json.dumps({
        'q': (filters.get('q') or '').strip(),
        'tags': sorted(filters.get('tags') or []),
        'ex': sorted(filters.get('excluded_tags') or []),
        'all': bool(filters.get('match_all')),
        'sort': filters.get('sort') or 'trend',
        'days': _num(filters.get('days')),
        'page': page_token,
    }, ensure_ascii=False, sort_keys=True)


def _downloaded_ids(addons_path: Optional[str]) -> set[str]:
    """本地 workshop 目录里已有的工坊 ID（文件名即 ID），用来打「已下载」标。"""
    if not addons_path:
        return set()
    ws = Path(addons_path) / 'workshop'
    if not ws.is_dir():
        return set()
    out: set[str] = set()
    try:
        for p in ws.glob('*.vpk'):
            stem = p.stem
            if stem.isdigit():
                out.add(stem)
        for d in ws.iterdir():
            if d.is_dir() and d.name.isdigit():
                out.add(d.name)
    except OSError:
        pass
    return out


def browse(filters: dict, page_token: str = '', addons_path: Optional[str] = None) -> dict:
    """一页列表。page_token 空 = 第一页；之后把返回的 next 原样传回来。"""
    filters = dict(filters or {})
    filters['sort'] = filters.get('sort') if filters.get('sort') in SORTS else 'trend'
    filters['tags'] = [t for t in (filters.get('tags') or []) if t in VALID_TAGS][:12]
    filters['excluded_tags'] = [t for t in (filters.get('excluded_tags') or []) if t in VALID_TAGS][:12]

    ck = _filter_key(filters, page_token)
    cached = _cache_get(ck)
    if cached is not None:
        payload = dict(cached)
        payload['cached'] = True
        return payload

    key = get_api_key()
    if key:
        cursor = '' if page_token in ('', '0') else page_token
        resp, host = _query_files(key, page_size=API_PAGE_SIZE, cursor=cursor, filters=filters)
        raw_items = resp.get('publishedfiledetails') or []
        items = [_normalize(x) for x in raw_items]
        items = [x for x in items if x['id'] and not x['banned']]
        payload = {
            'source': 'api',
            'source_host': host,
            'items': items,
            'total': _num(resp.get('total')),
            'page_size': API_PAGE_SIZE,
            'next': resp.get('next_cursor') or '',
            'has_more': bool(resp.get('next_cursor')),
            'note': '',
        }
    else:
        page = _num(page_token) or 1
        ids = _html_browse(filters, page)
        items: list[dict] = []
        if ids:
            raw = fetch_details(ids)
            by_id = {str(x.get('publishedfileid')): x for x in raw if isinstance(x, dict)}
            # 必须按网页给出的顺序重排：详情接口不保证顺序
            for pid in ids:
                got = by_id.get(pid)
                if not got:
                    continue
                norm = _normalize(got)
                if norm['id'] and not norm['banned']:
                    items.append(norm)
        payload = {
            'source': 'html',
            'source_host': 'steamcommunity.com',
            'items': items,
            'total': 0,          # 网页不给精确总数，别编一个
            'page_size': HTML_PAGE_SIZE,
            'next': str(page + 1) if len(ids) >= HTML_PAGE_SIZE else '',
            'has_more': len(ids) >= HTML_PAGE_SIZE,
            'note': '列表来自工坊网页，每页 30 条；填 API Key 后每页 100 条并带好评数、累计下载量',
        }

    done = _downloaded_ids(addons_path)
    for it in payload['items']:
        it['downloaded'] = it['id'] in done

    payload['cached'] = False
    _cache_put(ck, payload)
    return payload


def _detail_raw(wid: str) -> Optional[dict]:
    """取单个条目的原始详情。

    有 API Key 走 `IPublishedFileService/GetDetails`：只有它能 `includechildren`
    （依赖）和 `includeadditionalpreviews`（图集）。没配 key 就退回免 key 的
    `GetPublishedFileDetails` —— 拿不到图集和依赖，但标题/描述/封面还在，
    抽屉至少不会空着。
    """
    key = get_api_key()
    if key:
        params = {
            'key': key,
            'publishedfileids[0]': wid,
            'includeadditionalpreviews': 'true',
            'includechildren': 'true',
            'includetags': 'true',
            'includevotes': 'true',
            'short_description': 'true',
        }
        for host in API_ENDPOINTS:
            try:
                data = _http_get_json(host, DETAILS_PATH, params, timeout=15)
                details = (data.get('response') or {}).get('publishedfiledetails') or []
                if details and _num(details[0].get('result')) == 1:
                    return details[0]
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    # key 失效了：换主机也是同样的 401，直接退到免 key 路径
                    break
            except Exception:
                continue

    try:
        got = fetch_details([wid])
    except Exception as e:
        print(f'[Workshop] detail fetch failed: {e}')
        return None
    return got[0] if got else None


def _detail_previews(raw: dict) -> list[str]:
    """图集：封面 + 作者上传的截图，去重后最多 12 张。

    GetDetails 的 `previews[]` 里字段名是 `url`（不是 `preview_url`），
    而免 key 的 `GetPublishedFileDetails` 根本不返回这个数组 ——
    所以封面要单独放第一位，两种情况都至少有一张可看。
    """
    out: list[str] = []
    cover = (raw.get('preview_url') or '').strip()
    if cover:
        out.append(cover)

    for p in (raw.get('previews') or []):
        if not isinstance(p, dict):
            continue
        url = (p.get('url') or p.get('preview_url') or '').strip()
        if url and url not in out:
            out.append(url)
        if len(out) >= 12:
            break
    return out


def _detail_dependencies(raw: dict, downloaded: set[str]) -> list[dict]:
    """工坊的 `children` = 这个 Mod 依赖的前置（合集则是它的成员）。

    返回里只有 publishedfileid，标题要再批量查一次免 key 的详情接口。
    查不到就只显示 ID —— 总比「依赖 1 项，看不出是什么」强。
    """
    ids: list[str] = []
    for c in (raw.get('children') or []):
        if isinstance(c, dict) and c.get('publishedfileid'):
            ids.append(str(c['publishedfileid']))
    ids = list(dict.fromkeys(ids))[:20]
    if not ids:
        return []

    meta: dict[str, dict] = {}
    try:
        for x in fetch_details(ids):
            meta[str(x.get('publishedfileid'))] = x
    except Exception as e:
        print(f'[Workshop] dependency lookup failed: {e}')

    out = []
    for cid in ids:
        m = meta.get(cid) or {}
        out.append({
            'id': cid,
            'title': (m.get('title') or '').strip(),
            'preview_url': m.get('preview_url') or '',
            'size': _num(m.get('file_size')),
            'downloaded': cid in downloaded,
        })
    return out


def item_detail(wid: str, addons_path: Optional[str] = None) -> dict:
    """单个条目的详情：完整描述 + 图集 + 依赖。

    卡片字段够看了，抽屉里额外要三样：多图预览、作者的完整描述、
    以及它依赖哪些前置。后两样只有 GetDetails 给（见 `_detail_raw`）。
    """
    wid = str(wid or '').strip()
    if not wid.isdigit():
        raise WorkshopError('工坊 ID 必须是纯数字')

    downloaded = _downloaded_ids(addons_path)

    ck = f'item:{wid}'
    cached = _cache_get(ck)
    if cached is not None:
        data = dict(cached)
    else:
        raw = _detail_raw(wid)
        if not raw:
            # _detail_raw 已经把 result != 1 的条目过滤掉了，走到这里就是查不到
            raise WorkshopError('这个条目在 Steam 上取不到（可能已下架、被作者隐藏，或 ID 不对）')
        data = _normalize(raw)
        data['previews'] = _detail_previews(raw)
        # 缓存里不存 downloaded：「已下载」会随本地文件增删变化，
        # 存进 8 分钟 TTL 的缓存里会让刚下完的依赖继续显示「未下载」
        data['dependencies'] = _detail_dependencies(raw, set())
        _cache_put(ck, data)

    data['downloaded'] = data['id'] in downloaded
    data['dependencies'] = [
        {**d, 'downloaded': d['id'] in downloaded}
        for d in (data.get('dependencies') or [])
    ]
    return data


def verify_key(key: str) -> dict:
    """拿 1 条试 QueryFiles，返回可用性 + 实测耗时。"""
    key = (key or '').strip()
    if not _looks_like_key(key):
        raise WorkshopError('Key 格式不对：应该是 32 位十六进制字符')
    t0 = time.time()
    resp, host = _query_files(key, page_size=1, cursor='', filters={'sort': 'trend'})
    dt = time.time() - t0
    if resp.get('total') is None and not resp.get('publishedfiledetails'):
        raise WorkshopError('Key 被接受了，但没返回数据，稍后再试')
    return {
        'ok': True,
        'host': host,
        'elapsed_ms': int(dt * 1000),
        'total': _num(resp.get('total')),
        'masked': mask_key(key),
    }


def meta() -> dict:
    """前端渲染筛选项和排序项需要的一切静态信息。"""
    key = get_api_key()
    return {
        'sorts': [
            {'id': sid, 'label': v[0], 'requires_key': v[3]}
            for sid, v in SORTS.items()
        ],
        'tag_groups': [
            {
                'id': g['id'], 'label': g['label'],
                'tags': [{'name': t, 'label': TAG_LABELS.get(t, t)} for t in g['tags']],
            }
            for g in TAG_GROUPS
        ],
        'has_key': bool(key),
        'key_masked': mask_key(key),
        'page_size': API_PAGE_SIZE if key else HTML_PAGE_SIZE,
        'source': 'api' if key else 'html',
    }
