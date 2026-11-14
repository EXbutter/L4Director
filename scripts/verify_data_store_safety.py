"""白盒校验：data_store 的「不丢数据」保证。

覆盖三件事（v1.3.0 的 T1 / T2）：
  1. data.json 读不出来时进入只读模式，绝不用默认值覆盖原文件；
  2. 写盘失败时缓存作废，不让「内存里改了、磁盘没改」活到下一次请求；
  3. 正常写盘会留下 data.json.bak（上一版），误操作可回滚。

运行：python scripts/verify_data_store_safety.py
"""
import json
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix='l4d2_ds_'))
os.environ['USERPROFILE'] = str(TMP)
os.environ['HOME'] = str(TMP)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services import data_store as ds  # noqa: E402

ok = True


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


def reset():
    """把模块恢复到「干净启动」状态：清缓存、清只读标记、删掉数据文件。"""
    ds._cache = None
    ds._cache_timestamp = 0
    ds._read_only_reason = None
    for p in TMP.rglob('data.json*'):
        try:
            os.chmod(p, 0o666)
        except OSError:
            pass
        try:
            p.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------- 1. 只读模式
reset()
ds.set_mod_meta('A.vpk', ds.ModMeta(display_name='甲', enabled=False))
data_file = ds._DATA_FILE
before = data_file.read_text(encoding='utf-8')
check('基础写入成功', '"display_name": "甲"' in before)


class _BoomPath:
    """把 read_text 换成抛 OSError，模拟「文件被占用 / 权限不足 / 盘掉线」。"""

    def __init__(self, real: Path):
        self._real = real

    def exists(self):
        return True

    def read_text(self, *a, **kw):
        raise PermissionError(13, '另一个程序正在使用此文件', str(self._real))

    def __getattr__(self, item):
        return getattr(self._real, item)

    def __str__(self):
        return str(self._real)


real_path = ds._DATA_FILE
ds._cache = None
ds._cache_timestamp = 0
ds._DATA_FILE = _BoomPath(real_path)

got = ds.get_all_mod_metas()
check('读不出来时返回空表（不是崩溃）', got == {})
check('进入只读模式并带原因', bool(ds.get_read_only_reason()),
      ds.get_read_only_reason() or '(空)')

try:
    ds.set_mod_meta('B.vpk', ds.ModMeta(display_name='乙'))
    check('只读模式下写盘被拒绝', False, '居然写成功了')
except ds.DataStoreReadOnlyError:
    check('只读模式下写盘被拒绝', True)

check('原文件一个字节都没动', real_path.read_text(encoding='utf-8') == before)

ds._DATA_FILE = real_path
ds._read_only_reason = None

# ---------------------------------------------------------------- 2. .bak 备份
reset()
ds.set_mod_meta('A.vpk', ds.ModMeta(display_name='第一版'))
ds.set_mod_meta('A.vpk', ds.ModMeta(display_name='第二版'))

bak = real_path.with_name(real_path.name + '.bak')
check('写盘后留下 .bak', bak.exists())
if bak.exists():
    bak_text = bak.read_text(encoding='utf-8')
    check('.bak 是上一版内容', '第一版' in bak_text, bak_text[:0])
    now_text = real_path.read_text(encoding='utf-8')
    check('当前文件是新内容', '第二版' in now_text)

# ---------------------------------------------------------------- 3. 写盘失败回滚缓存
reset()
ds.set_mod_meta('A.vpk', ds.ModMeta(display_name='原始'))
ds._cache = None
ds._cache_timestamp = 0

orig_write = ds.os.fsync


def _boom_fsync(fd):  # noqa: ARG001
    raise OSError(28, '磁盘空间不足')


ds.os.fsync = _boom_fsync
try:
    ds.set_mod_meta('A.vpk', ds.ModMeta(display_name='改坏了'))
    wrote = True
except OSError:
    wrote = False
finally:
    ds.os.fsync = orig_write

check('写盘失败会抛错（不再静默）', not wrote)
ds._cache = None
ds._cache_timestamp = 0
check('磁盘上仍是原值', ds.get_mod_meta('A.vpk').display_name == '原始',
      str(ds.get_mod_meta('A.vpk').display_name))

# ---------------------------------------------------------------- 4. 损坏隔离仍有效
reset()
ds._CACHE_DIR.mkdir(parents=True, exist_ok=True)
real_path.write_text('{ 这不是 JSON', encoding='utf-8')
ds._cache = None
ds._cache_timestamp = 0
ds.get_all_mod_metas()
corrupt = list(ds._CACHE_DIR.glob('data.json.corrupt-*'))
check('损坏文件被挪成 .corrupt-<时间戳>', len(corrupt) == 1,
      str(corrupt[0].name) if corrupt else '(没有)')
check('隔离后原文件已不在原位', not real_path.exists())

# ---------------------------------------------------------------- 5. 并发写不损坏文件
reset()
errors = []


def worker(i: int):
    try:
        ds.set_mod_meta(f'M{i}.vpk', ds.ModMeta(display_name=f'名字{i}'))
    except Exception as exc:  # noqa: BLE001
        errors.append(exc)


threads = [threading.Thread(target=worker, args=(i,)) for i in range(12)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check('12 线程并发写不抛错', not errors, str(errors[:1]))
try:
    parsed = json.loads(real_path.read_text(encoding='utf-8'))
    check('并发写后文件仍是合法 JSON', isinstance(parsed.get('mod_metas'), dict))
    check('12 条元数据全部落盘', len(parsed['mod_metas']) == 12,
          str(len(parsed['mod_metas'])))
except Exception as exc:  # noqa: BLE001
    check('并发写后文件仍是合法 JSON', False, str(exc))

print('RESULT:', 'ALL PASS' if ok else 'HAS FAILURE')
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if ok else 1)
