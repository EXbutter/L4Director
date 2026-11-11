# -*- coding: utf-8 -*-
"""标签分类器评测：拿人工标注的对照表给 tagger 打分。

评分口径（两条，分开看）：
  A. 标注集   —— 只算人工写过标签的 Mod，比「标签集合」是否完全相同。
                 这是分类精度的硬指标。
  B. 全量 57  —— 未标注的按用户说明「没标的就是没问题的」，
                 以旧自动标签为准；只比「主标签」（卡片上排第一的那个）。

用法：
  python scripts/tag_calibrate.py           # 打分 + 差异清单
  python scripts/tag_calibrate.py -v        # 附带每个 Mod 的文件构成
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'scripts'))

from services import tagger  # noqa: E402
from tag_probe import load_ground_truth, resolve, read_manifest  # noqa: E402


def lazy_reader(path: Path):
    """按需打开 VPK，供 tagger 判断「纯脚本 Mod 是否其实是音效包」。"""
    state: dict = {}

    def read(name: str) -> bytes:
        if 'v' not in state:
            import vpk as vpk_lib  # type: ignore
            state['v'] = vpk_lib.VPK(str(Path(path).resolve()), read_header_only=False)
        fp = state['v'].get_file(name)
        return fp.read() if fp else b''

    return read


def parse_tags(s: str) -> list[str]:
    return [t.strip() for t in s.replace('/', ',').split(',') if t.strip()]


def main():
    verbose = '-v' in sys.argv
    rows = load_ground_truth()

    exact_hit = exact_total = 0
    tp = fp = fn = 0
    primary_hit = primary_total = 0
    per_tag: dict[str, list[int]] = {}
    set_misses = []
    primary_misses = []

    print(f'{"ident":<22}{"期望":<20}{"新判定":<22} 结果')
    print('-' * 82)

    for r in rows:
        path = resolve(r['ident'])
        if not path:
            print(f'{r["ident"]:<22}{"-":<20}{"MISSING FILE":<22} ⚠')
            continue
        files, _status = read_manifest(path)
        tags, degraded = tagger.classify(files, vpk_path=path, reader=lazy_reader(path))
        got = set(tags)
        got_primary = tags[0] if tags else None

        truth = parse_tags(r['true'])
        annotated = bool(truth)

        # A. 标注集：集合完全相同才算命中
        if annotated:
            exact_total += 1
            if got == set(truth):
                exact_hit += 1
                mark = '✓'
            else:
                mark = '✗'
                set_misses.append((r['ident'], r['title'], truth, tags))
            for t in truth:
                d = per_tag.setdefault(t, [0, 0, 0])
                if t in got:
                    d[0] += 1
                else:
                    d[2] += 1
            for t in got - set(truth):
                per_tag.setdefault(t, [0, 0, 0])[1] += 1
            tp += len(set(truth) & got)
            fp += len(got - set(truth))
            fn += len(set(truth) - got)
            expect_primary = truth[0]
        else:
            # 未标注 = 旧标签没问题，只要求主标签一致
            expect_primary = r['auto'] if r['auto'] not in ('', '-') else None
            mark = '·'

        # B. 全量主标签
        if expect_primary:
            primary_total += 1
            if got_primary == expect_primary:
                primary_hit += 1
            else:
                primary_misses.append((r['ident'], r['title'], expect_primary, tags, annotated))
                if mark == '·':
                    mark = '≠'

        print(f'{r["ident"]:<22}{(r["true"] or "(未标)"):<20}{",".join(tags):<22} {mark}'
              + ('  [降级]' if degraded else ''))
        if verbose:
            f = tagger._features_from_paths(files)
            print('    ', {k: v for k, v in f.items() if v})

    print('-' * 82)
    print('A. 标注集（标签集合完全一致）')
    print(f'   命中 {exact_hit}/{exact_total} = {exact_hit / max(exact_total, 1):.1%}')
    p = tp / max(tp + fp, 1)
    rc = tp / max(tp + fn, 1)
    f1 = 2 * p * rc / max(p + rc, 1e-9)
    print(f'   标签级  P={p:.1%}  R={rc:.1%}  F1={f1:.1%}   (tp={tp} fp={fp} fn={fn})')
    print('B. 全量 57（主标签一致；未标注以旧标签为准）')
    print(f'   命中 {primary_hit}/{primary_total} = {primary_hit / max(primary_total, 1):.1%}')

    if per_tag:
        print('\n分类别：')
        for t, (hit, ex, miss) in sorted(per_tag.items(), key=lambda kv: (-kv[1][0], kv[0])):
            print(f'  {t:<6} 命中 {hit}/{hit + miss}  多标 {ex}')

    if set_misses:
        print('\n集合差异（标注集）：')
        for ident, title, truth, got in set_misses:
            print(f'  {ident:<22}{title[:22]:<24}期望 {"/".join(truth)}  →  实得 {"/".join(got)}')

    if primary_misses:
        print('\n主标签差异（全量）：')
        for ident, title, exp, got, annotated in primary_misses:
            kind = '标注' if annotated else '未标'
            print(f'  [{kind}] {ident:<22}{title[:20]:<22}期望 {exp}  →  实得 {"/".join(got)}')


if __name__ == '__main__':
    main()
