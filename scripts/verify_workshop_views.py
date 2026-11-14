"""白盒校验：工坊的「列表模式」与「筛选组展开过渡」。

两件事都属于「改坏了但页面照样能显示」的类型，靠肉眼很难发现，所以写成断言：

1. **列表模式**：新增的排版。风险点是封面绕过 `ThumbImage` 直接 `<img>` ——
   工坊封面里混着几十 MB 的 GIF，绕过就等于把 16 FPS 那次事故重演一遍
   （见 verify_workshop_thumb_perf.py）。另外视图偏好要持久化，否则每次进页面
   都退回网格。

2. **筛选组展开**：之前是 `{isOpen && <div>}` 条件渲染 —— DOM 一挂载就占满高度，
   只有内部淡入，看起来是「啪」一下弹开，收起瞬间消失。改成常驻 DOM +
   `grid-template-rows: 0fr → 1fr` 才有真正的高度插值。这里守住三个容易漏的点：
   子项必须 `min-height: 0`（否则 auto 最小高度压不下去）、收起后要
   `visibility: hidden`（否则 Tab 会走进看不见的标签）、旧的淡入 keyframes 要删
   （两套动画叠加会互相干扰）。

运行：python scripts/verify_workshop_views.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / 'frontend/src/renderer/components'

page = (RENDERER / 'WorkshopPage.tsx').read_text(encoding='utf-8')
row = (RENDERER / 'workshop/WorkshopRow.tsx').read_text(encoding='utf-8')
card = (RENDERER / 'workshop/WorkshopCard.tsx').read_text(encoding='utf-8')
filters = (RENDERER / 'workshop/WorkshopFilters.tsx').read_text(encoding='utf-8')
scss = (RENDERER / 'Workshop.scss').read_text(encoding='utf-8')

ok = True


def check(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
    print(f"[{'PASS' if cond else 'FAIL'}] {label}{(' — ' + extra) if extra else ''}")


# ---------------------------------------------------------------- 1. 视图切换
print('\n== 视图切换（卡片 / 列表）==')
check('WorkshopPage 引入了列表行组件', "from './workshop/WorkshopRow'" in page)
check('视图偏好键为 l4d2-workshop-view', "'l4d2-workshop-view'" in page)
check('键名与「我的 Mod」分开（两页密度偏好互不影响）',
      "'l4d2-mods-view'" not in page)
check('只认 list，其余一律回落 grid',
      "localStorage.getItem('l4d2-workshop-view') === 'list' ? 'list' : 'grid'" in page)
check('切换后写回 localStorage', "localStorage.setItem('l4d2-workshop-view', mode)" in page)
check('读写都在 try 里（隐私模式会抛）', page.count('catch') >= 2)
check('两个按钮都有 aria-pressed', page.count('aria-pressed={viewMode') == 2)
check('按钮有 title 提示', 'title="卡片视图"' in page and 'title="列表视图"' in page)
check('容器按模式切 class', "viewMode === 'list' ? 'wk-list' : 'wk-grid'" in page)
check('容器 key 带 viewMode（切换时重新错峰入场）', "key={viewMode}" in page)
check('加载骨架也分模式', 'wk-skeleton--row' in page)

# ---------------------------------------------------------------- 2. 列表行
print('\n== 列表行组件 ==')
check('导出 WorkshopRow', 'export function WorkshopRow' in row)
check('封面走 ThumbImage 而不是裸 img',
      '<ThumbImage' in row and '<img' not in row)
check('动图只在悬停时播（一屏几十行，同时播会压满主线程）',
      'animation="hover"' in row)
check('惰性启动开（100 行一起转码会把主线程压死）', 'lazy' in row)
check('行内封面采样上限比卡片小一档（192×120）',
      'maxWidth={192}' in row and 'maxHeight={120}' in row)
check('描述先去 BBCode 再截断', 'cleanDescription(' in row and '.slice(0, 160)' in row)
check('整行是 div + role=button（以后要放二级按钮，button 不能套 button）',
      'role="button"' in row and '<button' not in row.split('export function WorkshopRow')[1])
check('键盘 Enter / 空格也能打开', "e.key === 'Enter'" in row and "e.key === ' '" in row)
check('传给行序号用于错峰', 'index = 0' in row and "'--wk-i': index" in row)
check('已下载标记存在', 'wk-row__flag' in row)
check('标签最多 5 个 + 溢出计数', 'slice(0, 5)' in row and 'item.tags.length - 5' in row)

# ---------------------------------------------------------------- 3. 列表样式
print('\n== 列表样式 ==')
check('.wk-list 是单列 flex', '.wk-list {' in scss and 'flex-direction: column' in scss)
check('行入场 0.3s --ease-soft', 'wk-row-in 0.3s var(--ease-soft)' in scss)
check('行错峰 18ms（比卡片的 24ms 密，一屏行更多）',
      'calc(var(--wk-i, 0) * 18ms)' in scss)
check('第 25 行起关掉动画（同卡片的上限）',
      '.wk-list > .wk-row:nth-child(n + 25)' in scss)
check('行封面固定 96×60', 'width: 96px' in scss and 'height: 60px' in scss)
check('封面里 thumb-frame 绝对定位铺满', '> .thumb-frame' in scss and 'inset: 0' in scss)
check('骨架行 72px', '.wk-skeleton--row {' in scss and 'height: 72px' in scss)
check('窄屏隐藏更新时间列', 'span:nth-child(3) { display: none; }' in scss)

# ---------------------------------------------------------------- 4. 展开过渡
print('\n== 筛选组展开过渡 ==')
check('标签组不再条件渲染（常驻 DOM 才能插值高度）',
      '{isOpen && (' not in filters)
check('有 wk-group__body 包裹层', 'className="wk-group__body"' in filters)
check('组头 aria-controls 指向标签组', 'aria-controls={`wk-group-body-${g.id}`}' in filters)
check('.wk-group__body 用 grid 行高过渡',
      'grid-template-rows: 0fr' in scss and '.wk-group.is-open .wk-group__body' in scss)
check('过渡 0.26s --ease-soft（双向）',
      'transition: grid-template-rows 0.26s var(--ease-soft)' in scss)
check('子项 min-height: 0（否则内容会把它撑住，压不下去）',
      '.wk-group__inner {' in scss and 'min-height: 0' in scss)
check('子项 overflow: hidden', '.wk-group__inner {' in scss and 'overflow: hidden' in scss)
check('收起后 visibility: hidden（Tab 不会走进看不见的标签）',
      'visibility: hidden' in scss and '.wk-group.is-open .wk-group__inner' in scss)
check('隐藏延迟到过渡结束（否则最后一帧闪白）',
      'transition: visibility 0s linear 0.26s' in scss)
check('chevron 旋转与高度同参', 'transition: transform 0.26s var(--ease-soft)' in scss)
check('旧的淡入 keyframes 已删除（两套叠加会打架）',
      'wk-group-in' not in scss)

# ---------------------------------------------------------------- 5. 一致性
print('\n== 与网格模式的一致性 ==')
check('两种排版点击都打开详情抽屉',
      'onClick={openDetail}' in page and 'onClick={() => onClick(item)}' in row
      and 'onClick={() => onClick(item)}' in card)
check('网格卡片仍在用 ThumbImage', '<ThumbImage' in card)
check('视图按钮与工具栏同款图标语义（卡片四宫格 / 列表两行）',
      'rect x="3" y="3"' in page and 'rect x="3" y="4"' in page)

print()
print('=' * 78)
print(f'结果：{"全部通过" if ok else "有失败项"}')
print('=' * 78)
sys.exit(0 if ok else 1)
