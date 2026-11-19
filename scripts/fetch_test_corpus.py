#!/usr/bin/env python3
"""抓一份「按压力面分类」的工坊测试库（默认 10GB），用于冲突检测与性能回归。

为什么要分类，而不是随便凑 10GB
------------------------------
扫描/冲突链路上有四种完全不同的压力，混在一起测不出问题出在哪：

  A_conflict  小体积皮肤/武器替换（几十 MB × 上百个）
              → 包数量、冲突配对、列表渲染。红点与「整套替换」判定都在这里出问题
  B_heavy     单包 ≥300MB 的重资源
              → 磁盘 IO、封面提取、缓存体积、单包解析耗时
  C_dense     材质/音效合集（条目多）
              → VPK 索引缓存、冲突倒排索引的内存与耗时
  D_campaign  战役地图（体积大但按需加载）
              → 验证 is_campaign 排除逻辑：占用统计不能把它们算进常驻内存

阈值与「多少 Mod 该做虚拟化」见 docs-internal/09-性能与测试规格.md。

用法
----
  # 1) 只出计划（不下载），看各档体积是否合理
  python scripts/fetch_test_corpus.py plan --outdir D:\\Sample --budget-gb 10

  # 2) 按计划下载（可中断，重跑会校验 SHA1 后跳过已完成）
  python scripts/fetch_test_corpus.py download --outdir D:\\Sample --threads 8

  # 3) 用这份库跑一次扫描基线（隔离 HOME，不碰真实 data.json）
  python scripts/fetch_test_corpus.py scan --outdir D:\\Sample

下载走的是 App 自己的 CDN 直连通道（services.workshop_downloader），
不经过 Steam 客户端；失败重试与断点续传由它负责。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# 下载是有进度条的（\r 覆盖同一行）：改成行缓冲，重定向到日志文件时才看得到实时进度
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

BACKEND = Path(__file__).resolve().parents[1] / 'backend'
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

GB = 1024 ** 3
MB = 1024 ** 2

# 档位定义：配额（GB）、体积区间（MB）、标签命中规则，见文件头说明
BUCKETS = [
    {
        'key': 'D_campaign', 'quota_gb': 2.0, 'sort': 'subs',
        'tags': ['Campaigns'], 'min_mb': 400, 'max_mb': 4096,
        'why': '战役地图：验证 is_campaign 排除与按需加载',
    },
    {
        'key': 'B_heavy', 'quota_gb': 4.0, 'sort': 'subs',
        'tags': [], 'min_mb': 300, 'max_mb': 4096,
        'why': '重资源：磁盘 IO / 封面提取 / 缓存体积',
    },
    {
        'key': 'C_dense', 'quota_gb': 2.0, 'sort': 'subs',
        'tags': ['Textures', 'Sounds'], 'min_mb': 80, 'max_mb': 400,
        'why': '条目密集：索引缓存与冲突倒排内存',
    },
    {
        'key': 'A_conflict', 'quota_gb': 2.0, 'sort': 'subs',
        'tags': ['Weapons', 'Models', 'Survivors', 'Items'], 'min_mb': 4, 'max_mb': 120,
        'why': '冲突密集：包数量、冲突配对、列表渲染',
        # 同样 2GB，挑小的能凑出两三倍的包 —— 冲突配对/列表渲染吃的就是包数量
        'pick': 'small_first',
    },
]

BUCKET_ORDER = [b['key'] for b in BUCKETS]


# ─────────────────────────────────────────────────────────────── 计划
def collect_pool(target_items: int, log=print) -> list[dict]:
    """翻多组排序/标签，凑出一个够大的候选池（按 id 去重）。"""
    from services import workshop_browse as wb

    pool: dict[str, dict] = {}
    queries: list[dict] = []
    for b in BUCKETS:
        for sort in (b['sort'], 'top', 'trend'):
            queries.append({'tags': b['tags'], 'sort': sort})
        # 单标签再各翻一遍：组合标签是「或」关系，但工坊列表的排序会把某一类压到后面，
        # 分开查才能把「小体积皮肤」这类凑够数量（冲突测试吃的就是包数量）
        for tag in b['tags']:
            for sort in ('subs', 'top'):
                queries.append({'tags': [tag], 'sort': sort})
    # 再加一版「无标签 + 订阅最多」，兜住那些没打类型标签的老包
    queries.append({'tags': [], 'sort': 'subs'})

    for q in queries:
        token = ''
        for _page in range(4):          # 每组最多翻 4 页（API 模式 = 400 条）
            try:
                res = wb.browse({'sort': q['sort'], 'tags': q['tags']}, token)
            except Exception as e:
                log(f"[browse] {q} 失败：{e}")
                break
            for item in res.get('items') or []:
                if not item.get('id') or item.get('banned'):
                    continue
                if int(item.get('size') or 0) <= 0:      # 合集 / DLC / 已下架没有直链
                    continue
                pool.setdefault(item['id'], item)
            token = res.get('next') or ''
            if not token or not res.get('has_more'):
                break
        log(f"[browse] {q['tags'] or '全部'}/{q['sort']} → 池内 {len(pool)} 条")
        if len(pool) >= target_items:
            break
    return list(pool.values())


def classify(item: dict) -> str | None:
    """按体积 + 标签把候选归到某一档；归不进去的丢弃（别用垃圾数据凑数）。"""
    size_mb = int(item.get('size') or 0) / MB
    tags = {t['name'] for t in (item.get('tags') or [])}
    for b in BUCKETS:
        if not (b['min_mb'] <= size_mb <= b['max_mb']):
            continue
        if b['tags'] and not (tags & set(b['tags'])):
            continue
        return b['key']
    return None


def build_plan(outdir: Path, budget_gb: float) -> dict:
    log = print
    # 目标：预算的 3 倍候选量，才有挑选余地（很多包会因体积/标签被过滤）
    pool = collect_pool(target_items=900, log=log)
    log(f"[plan] 候选 {len(pool)} 条，开始按档位分配…")

    by_bucket: dict[str, list[dict]] = {k: [] for k in BUCKET_ORDER}
    for item in pool:
        key = classify(item)
        if key:
            by_bucket[key].append(item)

    bucket_cfg = {b['key']: b for b in BUCKETS}
    for key in by_bucket:
        # 先按订阅数降序：优先拿「真的有人在用」的包，冲突形态更真实
        by_bucket[key].sort(key=lambda x: -int(x.get('subscriptions') or 0))
        if bucket_cfg.get(key, {}).get('pick') == 'small_first':
            # 先留出订阅数最高的一批做候选，再按体积升序取 —— 数量优先，质量不塌
            head = by_bucket[key][:300]
            by_bucket[key] = sorted(head, key=lambda x: int(x.get('size') or 0))

    quota = budget_gb * GB
    # 按档位配额加权（budget_gb 变化时各档等比缩放）
    base_total = sum(b['quota_gb'] for b in BUCKETS)
    picked: list[dict] = []
    taken: set[str] = set()
    for b in BUCKETS:
        share = int(quota * (b['quota_gb'] / base_total))
        used = 0
        for item in by_bucket[b['key']]:
            if used >= share:
                break
            if item['id'] in taken:
                continue
            picked.append({**item, 'bucket': b['key']})
            taken.add(item['id'])
            used += int(item['size'])
        log(f"[plan] {b['key']:<11} 选 {sum(1 for p in picked if p['bucket']==b['key']):>3} 个 / "
            f"{used/GB:.2f} GB（配额 {share/GB:.2f} GB）")

    # 配额没吃满（某档候选不够）就用池子里剩下的按体积补齐，保证总量接近预算
    total = sum(int(p['size']) for p in picked)
    rest = [i for i in pool if i['id'] not in taken]
    rest.sort(key=lambda x: -int(x.get('size') or 0))
    for item in rest:
        if total >= quota * 0.98:
            break
        key = classify(item) or 'Z_extra'
        picked.append({**item, 'bucket': key})
        taken.add(item['id'])
        total += int(item['size'])

    return {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'outdir': str(outdir),
        'budget_gb': budget_gb,
        'total_bytes': total,
        'buckets': {
            b['key']: {
                'why': b['why'],
                'count': sum(1 for p in picked if p['bucket'] == b['key']),
                'bytes': sum(int(p['size']) for p in picked if p['bucket'] == b['key']),
            }
            for b in BUCKETS
        },
        'items': [
            {
                'id': p['id'],
                'title': p.get('title', ''),
                'size': int(p.get('size') or 0),
                'bucket': p['bucket'],
                'subscriptions': int(p.get('subscriptions') or 0),
                'filename': p.get('filename', ''),
            }
            for p in sorted(picked, key=lambda x: (BUCKET_ORDER + ['Z_extra']).index(x['bucket']))
        ],
    }


def phase_plan(args) -> int:
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    plan = build_plan(outdir, args.budget_gb)
    target = outdir / '_corpus_plan.json'
    target.write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding='utf-8')
    print()
    print(f"{'档位':<12}{'数量':>5}{'体积':>10}  压力面")
    for key, info in plan['buckets'].items():
        print(f"{key:<12}{info['count']:>5}{info['bytes']/GB:>9.2f}G  {info['why']}")
    print(f"{'合计':<12}{len(plan['items']):>5}{plan['total_bytes']/GB:>9.2f}G")
    print(f"\n计划已写入 {target}")
    return 0


# ─────────────────────────────────────────────────────────────── 下载
def phase_download(args) -> int:
    from services.workshop_downloader import download_one, fetch_details, fmt_size

    outdir = Path(args.outdir)
    plan_path = outdir / '_corpus_plan.json'
    if not plan_path.exists():
        print(f"缺少计划文件 {plan_path}，先跑 plan")
        return 2
    plan = json.loads(plan_path.read_text(encoding='utf-8'))

    layout_ws = args.layout == 'workshop'
    if layout_ws:
        (outdir / 'workshop').mkdir(parents=True, exist_ok=True)

    manifest_path = outdir / '_corpus_manifest.json'
    manifest = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        except Exception:
            manifest = {}

    budget = plan['total_bytes']
    done_bytes = 0
    started = time.time()
    counts = {'done': 0, 'skip': 0, 'fail': 0}
    last_save = 0.0

    for idx, item in enumerate(plan['items'], start=1):
        wid = item['id']
        dest_dir = (outdir / 'workshop' / wid) if layout_ws else outdir
        dest_dir.mkdir(parents=True, exist_ok=True)

        if done_bytes >= budget:
            print(f"[预算] 已抓 {done_bytes/GB:.2f}G，停止")
            break

        # download_one 需要 file_url/hcontent_file，计划里只存了 id → 补一次详情
        try:
            details = fetch_details([wid])
            detail = details[0] if details else {}
        except Exception as e:
            print(f"[{idx}/{len(plan['items'])}] {wid} 取详情失败：{e}")
            counts['fail'] += 1
            continue
        if not detail:
            counts['fail'] += 1
            continue
        detail.setdefault('title', item['title'])
        detail['file_size'] = detail.get('file_size') or item['size']

        def log(msg, _wid=wid):
            if msg.startswith('[跳过]') or msg.startswith('[失败]'):
                print(f"  {_wid} {msg}")

        def prog(frac, got, total, speed):
            pct = int((frac or 0) * 100)
            print(f"\r  {wid} {pct:3d}%  {fmt_size(got)}/{fmt_size(total)}  {fmt_size(speed)}/s   ",
                  end='', flush=True)

        t0 = time.time()
        try:
            result = download_one(detail, str(dest_dir), threads=args.threads,
                                  force=False, log=log, prog=prog)
        except Exception as e:
            result = 'fail'
            print(f"\n  {wid} 下载异常：{e}")
        elapsed = time.time() - t0

        size = int(detail.get('file_size') or 0)
        if result in ('done', 'skip'):
            done_bytes += size
            counts[result] += 1
            manifest[wid] = {
                'id': wid, 'title': item['title'], 'bucket': item['bucket'],
                'size': size, 'status': result, 'elapsed_s': round(elapsed, 1),
                'path': str(dest_dir / f'{wid}.vpk'),
            }
        else:
            counts['fail'] += 1
            manifest[wid] = {
                'id': wid, 'title': item['title'], 'bucket': item['bucket'],
                'size': size, 'status': 'fail', 'elapsed_s': round(elapsed, 1),
            }
        print(f"\r[{idx}/{len(plan['items'])}] {result:<4} {wid} {fmt_size(size):>9} "
              f"{elapsed:5.1f}s  累计 {done_bytes/GB:5.2f}G / {budget/GB:.2f}G")

        if time.time() - last_save > 10:
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
            last_save = time.time()

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    total_s = time.time() - started
    print()
    print(f"完成 {counts['done']} / 跳过 {counts['skip']} / 失败 {counts['fail']}"
          f"  共 {done_bytes/GB:.2f}G  用时 {total_s/60:.1f} 分钟"
          f"  平均 {fmt_size(done_bytes/max(total_s,1))}/s")
    print(f"清单：{manifest_path}")
    return 0 if counts['fail'] == 0 else 1


# ─────────────────────────────────────────────────────────────── 扫描基线
def _game_root_from_config() -> Path | None:
    """从真实配置（~/.l4d2-manager/config.json）推断游戏根目录。

    为什么不 import data_store：scan 阶段要隔离 HOME，一旦 import 就把路径算死了。
    这里只读一个 json，不碰任何模块级常量。
    """
    cfg = Path.home() / '.l4d2-manager' / 'config.json'
    try:
        addons = json.loads(cfg.read_text(encoding='utf-8')).get('addons_path')
    except Exception:
        return None
    if not addons:
        return None
    root = Path(addons).parent.parent
    return root if (root / 'left4dead2' / 'pak01_dir.vpk').exists() else None


def _resolve_game_root(raw: str | None) -> Path | None:
    """接受 <game> 或 <game>/left4dead2 两种写法，返回含 left4dead2/pak01_dir.vpk 的根。"""
    if not raw:
        return _game_root_from_config()
    root = Path(raw)
    if (root / 'left4dead2' / 'pak01_dir.vpk').exists():
        return root
    if (root / 'pak01_dir.vpk').exists():
        return root.parent
    if (root / 'left4dead2').is_dir():
        return root
    return None


def phase_scan(args) -> int:
    """用这份库跑一次扫描基线。HOME 指到 <outdir>/.scan_home，不碰真实 data.json。"""
    outdir = Path(args.outdir).resolve()
    iso_home = outdir / '.scan_home'
    if os.environ.get('L4D_CORPUS_SCAN') != '1':
        import subprocess

        iso_home.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, HOME=str(iso_home), USERPROFILE=str(iso_home), L4D_CORPUS_SCAN='1')
        cmd = [sys.executable, __file__, 'scan', '--outdir', str(outdir)]
        game_root = _resolve_game_root(args.official_from)
        if game_root:
            cmd += ['--official-from', str(game_root)]
        return subprocess.run(cmd, env=env).returncode

    import tracemalloc

    from services import mod_scanner as ms

    # ⚠ 冲突判定的三档里，hard 需要「路径在官方名单里」。官方名单靠
    # `<addons>/../..` 推游戏根，测试库放在 D://Sample 时推出来是 D://，找不到
    # pak01_dir.vpk → 所有路径都被当成私有 → 全部降级成 soft（只进提示，不进红点）。
    # 这就是「测试库看起来 0 冲突」的根因，所以这里必须显式装上基准。
    game_root = _resolve_game_root(args.official_from)
    if game_root:
        from services.conflict_engine import OfficialIndex

        official = OfficialIndex.from_game(game_root)
        ms._get_official_index = lambda _p: official
        print(f'[official] {game_root} → {len(official.paths)} 条官方路径')
    else:
        print('[official] ⚠ 没找到 pak01_dir.vpk：hard 判定不可用，'
              '下面的「冲突数」只含 script 级，另有大量重叠会落到提示里')

    ms.invalidate_scan_cache()
    ms._VPK_METADATA_CACHE.clear()
    ms._VPK_MANIFEST_CACHE.clear()
    ms._VPK_INDEX_CACHE.clear()

    scanner = ms.ModScanner()
    scanner.set_addons_path(str(outdir))

    tracemalloc.start()
    t0 = time.perf_counter()
    mods = scanner.scan_mods()
    cold_ms = (time.perf_counter() - t0) * 1000
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    t0 = time.perf_counter()
    scanner.scan_mods()
    warm_ms = (time.perf_counter() - t0) * 1000

    total_bytes = sum(int(getattr(m, 'size_bytes', 0) or 0) for m in mods)
    conflicted = [m for m in mods if getattr(m, 'conflicts', None)]
    unreadable = [m for m in mods if getattr(m, 'unreadable', False)]
    campaigns = [m for m in mods if getattr(m, 'role', '') == 'campaign']
    payload = len(json.dumps([vars(m) for m in mods], ensure_ascii=False, default=str))

    print()
    print(f"库         {total_bytes/GB:.2f} GB / {len(mods)} 个 Mod")
    print(f"冷扫描     {cold_ms:.0f} ms     峰值分配 {peak/1048576:.0f} MB")
    print(f"缓存重扫   {warm_ms:.0f} ms")
    hinted = [m for m in mods if getattr(m, 'conflict_hints', None)]
    print(f"冲突       {len(conflicted)} 个包与其它包互斥（hard/script）")
    print(f"提示重叠   {len(hinted)} 个包仅与其它包重叠（copy/entry/soft）")
    print(f"地图包     {len(campaigns)} 个（不应计入常驻内存）")
    print(f"读不出来   {len(unreadable)} 个")
    print(f"JSON 体积  {payload/1024:.0f} KB（{payload/1024/max(len(mods),1):.2f} KB/Mod）")

    perf = ms.get_last_scan_perf()
    print(f"后端统计   {perf}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description='工坊测试库（按压力面分类）')
    sub = parser.add_subparsers(dest='phase', required=True)

    p_plan = sub.add_parser('plan', help='只生成计划，不下载')
    p_plan.add_argument('--outdir', default=r'D:\Sample')
    p_plan.add_argument('--budget-gb', type=float, default=10.0)
    p_plan.set_defaults(func=phase_plan)

    p_dl = sub.add_parser('download', help='按计划批量下载')
    p_dl.add_argument('--outdir', default=r'D:\Sample')
    p_dl.add_argument('--threads', type=int, default=8)
    p_dl.add_argument('--layout', choices=['workshop', 'flat'], default='workshop',
                      help='workshop = workshop/<id>/<id>.vpk（与游戏目录一致）；flat = 平铺')
    p_dl.set_defaults(func=phase_download)

    p_scan = sub.add_parser('scan', help='扫描基线（隔离 HOME）')
    p_scan.add_argument('--outdir', default=r'D:\Sample')
    p_scan.add_argument('--official-from', default=None,
                        help='游戏根目录（含 left4dead2/pak01_dir.vpk）；不传则从真实配置推断')
    p_scan.set_defaults(func=phase_scan)

    args = parser.parse_args()
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
