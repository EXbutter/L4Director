"""白盒校验：密钥卫生（v1.3.1 / S1-S14）。

Steam Web API Key 是账号级凭证：泄漏一次就可能被别人刷爆配额、甚至导致 key 被
封禁；而它一旦出现在 issue 截图、日志文件、或者被人 sync 走的 config.json 里，
用户是感知不到的。这份断言盯住四个出口：

  落盘  —— 只能是 DPAPI 密文，旧明文自动迁移
  日志  —— 只出现指纹，任何报文先过 redact
  接口  —— 永不回传原文，只回掩码与存储方式
  仓库  —— 源码/文档里不许有真实形态的 key

运行：python scripts/verify_secret_hygiene.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = Path(tempfile.mkdtemp(prefix='l4d2_sec_'))
os.environ['USERPROFILE'] = str(TMP)
os.environ['HOME'] = str(TMP)
os.environ.pop('L4DIRECTOR_STEAM_KEY', None)

sys.path.insert(0, str(ROOT / 'backend'))

from services import workshop_browse as wb  # noqa: E402

wb._CONFIG_DIR = TMP / '.l4d2-manager'
wb._CONFIG_PATH = wb._CONFIG_DIR / 'config.json'

# 全项目统一使用的假 key。真 key 不许出现在任何源码/文档里，连 31 位残片都不许。
FAKE = '0123456789ABCDEF0123456789ABCDEF'
MASKED = '0123…CDEF'

ok = True
failed: list[str] = []


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
        failed.append(label)
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


def src(rel: str) -> str:
    return (ROOT / rel).read_text(encoding='utf-8', errors='replace')


def cfg_text() -> str:
    return wb._CONFIG_PATH.read_text(encoding='utf-8') if wb._CONFIG_PATH.exists() else ''


def cfg_json() -> dict:
    return json.loads(cfg_text() or '{}')


print()
print('=' * 78)
print('S1. 存储：只能密文落盘')
print('=' * 78)

check('DPAPI 可用（Windows 上才谈得上加密）', wb.dpapi_available(), f'os.name={os.name}')

if wb.dpapi_available():
    sealed = wb._seal(FAKE)
    check('加密产物带 dpapi:v1: 前缀', sealed.startswith('dpapi:v1:'), sealed[:14])
    check('解密能还原', wb._unseal(sealed) == FAKE)
    check('密文里不含明文', FAKE not in sealed)
    check('篡改密文解得空串（不抛异常）', wb._unseal(sealed[:-6] + 'AAAAAA') == '')
    check('非本程序的熵无法解（换熵即失败）',
          wb._unseal('dpapi:v1:' + 'AAAA') == '')

    wb.set_api_key(FAKE)
    text = cfg_text()
    check('写盘后文件里没有明文', FAKE not in text)
    check('写盘后没有 steam_api_key 明文字段', 'steam_api_key' not in cfg_json() or
          not cfg_json().get('steam_api_key'))
    check('写盘后存在加密字段', str(cfg_json().get('steam_api_key_enc', '')).startswith('dpapi:v1:'))
    check('能原样读回', wb.get_api_key() == FAKE)
    check('status 报告 storage=dpapi', wb.key_status()['storage'] == 'dpapi')
    check('status 报告可解密', wb.key_status()['readable'] is True)
else:
    print('[SKIP] 非 Windows，跳过 DPAPI 相关断言')


print()
print('=' * 78)
print('S2. 旧明文自动迁移')
print('=' * 78)

wb._CONFIG_PATH.write_text(
    json.dumps({'addons_path': 'D:/fake/addons', 'steam_api_key': FAKE}),
    encoding='utf-8')
check('迁移前确实是明文', FAKE in cfg_text())
check('读取时能拿到 key', wb.get_api_key() == FAKE)
after = cfg_json()
check('迁移后文件里没有明文', FAKE not in cfg_text())
check('迁移后明文字段被删除', 'steam_api_key' not in after)
check('迁移后其它字段保留', after.get('addons_path') == 'D:/fake/addons')
check('迁移后仍能读回', wb.get_api_key() == FAKE)


print()
print('=' * 78)
print('S3. 清除与不可解密')
print('=' * 78)

wb.set_api_key(FAKE)
state = wb.set_api_key('')
check('清除后 configured=False', state['configured'] is False)
check('清除后两个字段都不留', 'steam_api_key' not in cfg_json() and
      'steam_api_key_enc' not in cfg_json())
check('清除后读回为空', wb.get_api_key() == '')

# 密文解不开（换 Windows 账户 / 换机器 / 文件损坏）
wb._CONFIG_PATH.write_text(json.dumps({'steam_api_key_enc': 'dpapi:v1:bm90LWEtcmVhbC1ibG9i'}),
                           encoding='utf-8')
st = wb.key_status()
check('解不开时 configured=False', st['configured'] is False)
check('解不开时 readable=False（界面要提示重填）', st['readable'] is False)
check('解不开时不抛异常、静默降级到网页模式', wb.get_api_key() == '')


print()
print('=' * 78)
print('S4. 掩码与脱敏')
print('=' * 78)

check('掩码是首 4 末 4', wb.mask_key(FAKE) == MASKED)
check('掩码不含中段', FAKE[4:28] not in wb.mask_key(FAKE))
check('空 key 掩码为空', wb.mask_key('') == '')
check('redact 把 32 位十六进制打成 ****', wb.redact(f'key={FAKE}') == 'key=****')
check('redact 不动普通文本', wb.redact('HTTP 401 Unauthorized') == 'HTTP 401 Unauthorized')
check('redact 处理 None 不炸', wb.redact('') == '')


print()
print('=' * 78)
print('S5. 接口：只回掩码与存储方式')
print('=' * 78)

wb.set_api_key(FAKE)
status = wb.key_status()
check('key_status 不含原文', FAKE not in json.dumps(status, ensure_ascii=False))
check('key_status 只带掩码', status['masked'] == MASKED)
check('key_status 没有 key/secret 字段',
      not any(k in status for k in ('key', 'steam_api_key', 'secret')))
meta = wb.meta()
check('meta 不含原文', FAKE not in json.dumps(meta, ensure_ascii=False))
check('meta 只带掩码', meta.get('key_masked') == MASKED)

main_py = src('backend/main.py')
check('GET /api/settings/steam-key 返回的是 key_status()',
      'def get_steam_key' in main_py and '_wb().key_status()' in main_py)
check('错误出口都过 redact', main_py.count('_wb().redact(str(e))') >= 4,
      f'count={main_py.count("_wb().redact(str(e))")}')

wb_py = src('backend/services/workshop_browse.py')
check('_query_files 的 errs 只拼主机名/异常类型，不拼 URL',
      "errs.append(f'{host}：{type(e).__name__}')" in wb_py)
check('_query_files 最终 raise 前过 redact',
      "raise WorkshopError(redact(" in wb_py)
check('不存在把 key 打进 print 的语句',
      not re.search(r'print\([^\n]*\{key\}', wb_py))


print()
print('=' * 78)
print('S6. 环境变量通道')
print('=' * 78)

wb.set_api_key('')
wb._CONFIG_PATH.unlink(missing_ok=True)   # 前面几节留下了文件，这里要从「干净磁盘」验证
os.environ['L4DIRECTOR_STEAM_KEY'] = FAKE
check('环境变量优先', wb.get_api_key() == FAKE)
check('环境变量场景 storage=env', wb.key_status()['storage'] == 'env')
check('环境变量场景 from_env=True', wb.key_status()['from_env'] is True)
check('环境变量路径完全不碰磁盘', not wb._CONFIG_PATH.exists())
os.environ['L4DIRECTOR_STEAM_KEY'] = 'not-a-key'
check('格式不对的环境变量被忽略', wb.get_api_key() == '')
os.environ.pop('L4DIRECTOR_STEAM_KEY', None)


print()
print('=' * 78)
print('S7. 仓库卫生')
print('=' * 78)

gitignore = src('.gitignore')
for pat in ('*.key', 'steam_api_key*', '.tmp_preview/', 'frontend/public/thankyou.png'):
    check(f'.gitignore 含 {pat}', pat in gitignore)

# frontend/public/ 会被 vite 原样复制进 dist/renderer，而 electron-builder 的 files
# 是 dist/**/* —— 换句话说，放进 public 的图片会进 app.asar，随安装包公开发布。
# 个人收款码曾经就这样漏出去一次。真需要放图片时（例如应用内赞助页），先说明理由
# 再改这条断言，别直接删。
public_dir = ROOT / 'frontend' / 'public'
IMAGE_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'}
stray = sorted(p.name for p in public_dir.rglob('*')
               if p.is_file() and p.suffix.lower() in IMAGE_EXT) if public_dir.exists() else []
check('frontend/public 下没有图片（会随安装包公开）', not stray, ', '.join(stray[:5]))

# 只看「key 形态的赋值」：md5/CRC 校验值也是 32 位十六进制，全量扫会误报
SUSPECT = re.compile(r'(?:steam_api_key|api_key|apikey|\.key)[\'"]?\s*[=:]\s*[\'"]([0-9A-Fa-f]{32})[\'"]')
try:
    tracked = subprocess.run(['git', 'ls-files'], cwd=str(ROOT), capture_output=True,
                             text=True, timeout=30).stdout.splitlines()
except Exception as e:  # 没装 git 时不该让整份校验挂掉
    tracked = []
    print(f'[SKIP] git ls-files 不可用：{type(e).__name__}')

hits = []
for rel in tracked:
    if not rel.lower().endswith(('.py', '.ts', '.tsx', '.js', '.json', '.md', '.yml', '.yaml')):
        continue
    if rel.startswith(('frontend/node_modules', 'frontend/out', 'frontend/release')):
        continue
    try:
        text = (ROOT / rel).read_text(encoding='utf-8', errors='replace')
    except OSError:
        continue
    for m in SUSPECT.finditer(text):
        if m.group(1).upper() != FAKE:
            hits.append(f'{rel}:{m.group(1)[:6]}…')
check('仓库里没有真实形态的 key', not hits, '; '.join(hits[:4]))

settings_tsx = src('frontend/src/renderer/components/SettingsPage.tsx')
# key 只活在组件 state 里：刷新页面就该重新粘，绝不进 localStorage
bad_lines = [ln.strip() for ln in settings_tsx.splitlines()
             if 'localStorage' in ln and 'key' in ln.lower()]
check('前端不把 key 写进 localStorage', not bad_lines, '; '.join(bad_lines[:2]))
check('key 输入框是 password 型', 'type="password"' in settings_tsx)
check('输入框关闭自动填充', 'autoComplete="off"' in settings_tsx)


print()
print('=' * 78)
print(f'结果：{"全部通过" if ok else "有失败项"}（{"、".join(failed) if failed else "无"}）')
print('=' * 78)
sys.exit(0 if ok else 1)
