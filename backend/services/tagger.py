# -*- coding: utf-8 -*-
"""Mod 标签分类器（按人工标注校准）。

设计要点（全部来自 57 个真实 Mod 的标注对照）：

1. **皮肤是修饰标签，不是主分类**。玩家标「武器/皮肤」「生还者/皮肤」——
   皮肤 表示「改的是外观贴图/模型」，真正的主分类是它替换了谁。
   所以 皮肤 永远排在目标类别之后，且只在有视觉资源时出现。
2. **战役独占**。带 ≥2 个 .bsp 的 Mod 只给「战役」：Baka 这类地图自带
   几百个贴图和十几首音效，按命中文件数排序会让「皮肤/音效」压过「战役」，
   这正是旧版把地图判成皮肤的原因。
3. **音效要压过贴图才算音效**。武器包普遍带 7~11 个开火音效（占比可达 45%），
   不加约束就会把 CS:GO 武器皮肤误判成音效包。
4. **公共动画库单独成类**。同时含生还者 + 被感染者动画、且没有任何贴图的，
   是给别的 Mod 打底的动画库（如 xdReanimsBase），标「脚本」而不是角色皮肤。
5. **解析失败的 VPK 也要有标签**。创意工坊里有 VPK 头损坏、文件名非 UTF-8
   的情况，旧版直接给「-」。这里退化为字节流关键词扫描，仍能判出类别。
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

# 标签词表（顺序 = 同级时的展示优先级）
# 规则版本：改动判定逻辑后 +1，会让 vpk 元数据磁盘缓存自动失效重算
RULES_VERSION = 7

TAG_ORDER = [
    '战役', '被感染者', '生还者', '武器', '物品',
    '游戏界面', '音效', '脚本', '突变模式', '皮肤', '杂项',
]

# 目标类（「皮肤」挂在它们后面）
TARGET_TAGS = ('被感染者', '生还者', '武器', '物品')

_IMG_EXT = {'vtf', 'vmt', 'mdl', 'vvd', 'vtx', 'pcf', 'vpcf'}
_TEX_EXT = {'vtf', 'vmt'}          # 只有贴图才算「皮肤」——.mdl 可能是公用动画
_SND_EXT = {'wav', 'mp3', 'ogg'}

# 角色替换包普遍带第一人称手臂模型（models/weapons/arms/v_arms_*），
# 那是角色的手，不是武器皮肤，不能算「武器」。
_ARM_MARK = ('/arms/', 'v_arms', '_arms')

# 标准 mod 必备的脚本文本，任何贴图/HUD 包都会带，不能当成「脚本类 mod」证据
_SCRIPT_BOILERPLATE = {
    'scripts/mod_textures.txt', 'scripts/hudanimations.txt', 'scripts/hudlayout.res',
}

# 自定义模型包常把角色放在私有目录（models/xdreanims/zoey_slot_031.mdl），
# 不按标准 models/survivors 摆放，用角色代号兜底识别。
_SURVIVOR_HINTS = (
    'zoey', 'louis', 'francis', 'bill', 'coach', 'ellis', 'rochelle', 'nick',
    'biker', 'namvet', 'manager', 'producer', 'mechanic', 'gambler', 'teengirl',
)
_INFECTED_HINTS = (
    'hulk', 'tank', 'boomer', 'smoker', 'jockey', 'charger', 'spitter', 'witch',
    'hunter', 'infected',
)


# ── 二级细分标签 ─────────────────────────────────────────────────
# 与创意工坊的标签树对齐：生还者 / 被感染者 / 武器 / 物品 往下再分一层。
# 细分一律用**官方英文名**：工坊里的 Mod 标题、模型文件名都是英文，
# 「步枪」这种归类词既不精确也没法跟游戏里对上（M16 / AK-47 / SG552 都是步枪，
# 但玩家找的是具体那把），所以直接给到具体武器。
# 只在对应的大类成立时才附带（「皮肤」类 Mod 不会平白多出一个「Tank」），
# 且细分标签永远排在大类之后 —— 卡片上先看到「武器」再看到「AK-47」。
FINE_TAGS: dict[str, list[str]] = {
    '生还者': ['Zoey', 'Nick', 'Bill', 'Francis', 'Louis', 'Coach', 'Ellis', 'Rochelle'],
    '被感染者': ['Tank', 'Witch', 'Boomer', 'Smoker', 'Hunter', 'Charger',
                 'Jockey', 'Spitter', 'Common Infected'],
    '武器': [
        # 主武器
        'M16 Rifle', 'AK-47', 'Desert Rifle', 'SG552',
        'SMG', 'Silenced SMG',
        'Pump Shotgun', 'Chrome Shotgun', 'Auto Shotgun', 'SPAS-12',
        'Hunting Rifle', 'Military Sniper', 'AWP', 'Scout',
        'M60', 'Grenade Launcher',
        # 手枪
        'Pistol', 'Magnum',
        # 近战
        'Chainsaw', 'Katana', 'Machete', 'Crowbar', 'Fire Axe', 'Shovel',
        'Frying Pan', 'Golf Club', 'Cricket Bat', 'Baseball Bat',
        'Electric Guitar', 'Knife', 'Tonfa', 'Pitchfork',
        # 投掷物
        'Pipe Bomb', 'Molotov', 'Vomit Jar',
    ],
    '物品': ['Medkit', 'Pain Pills', 'Adrenaline', 'Defibrillator'],
}
FINE_TAG_NAMES = {t for tags in FINE_TAGS.values() for t in tags}
# 大类 → 细分标签（反查，前端也用同一份层级）
FINE_PARENT = {t: parent for parent, tags in FINE_TAGS.items() for t in tags}

# L4D2 的内部代号比英文名更常见：比尔是 namvet、佐伊是 teenangst、
# 路易斯是 manager…… 工坊里的模型几乎都叫 survivor_namvet.mdl。
_SURVIVOR_FINE = {
    'Bill': ('bill', 'namvet'),
    'Francis': ('francis', 'biker'),
    'Louis': ('louis', 'manager'),
    'Zoey': ('zoey', 'teenangst'),
    'Coach': ('coach',),
    'Ellis': ('ellis', 'mechanic'),
    'Nick': ('nick', 'gambler'),
    'Rochelle': ('rochelle', 'producer'),
}

_INFECTED_FINE = {
    'Common Infected': ('common infected', 'common'),
    'Boomer': ('boomer',),
    'Charger': ('charger',),
    'Hunter': ('hunter',),
    'Jockey': ('jockey',),
    'Smoker': ('smoker',),
    'Spitter': ('spitter',),
    'Tank': ('hulk', 'tank'),
    'Witch': ('witch',),
}

# 武器：**同一路径只认第一个命中的规则**，否则 rifle_m60 会同时被打成
# M16 Rifle + M60、hunting_rifle 会同时被打成 Hunting Rifle + M16 Rifle。
# 所以把更长的名字（grenade launcher / hunting rifle / rifle desert）排在
# 通用词（rifle / shotgun / smg）前面，命中即 break。
_WEAPON_FINE_RULES = [
    ('Grenade Launcher', ('grenade launcher', 'grenadelauncher')),
    ('M60', ('m60',)),
    ('Hunting Rifle', ('hunting rifle', 'huntingrifle')),
    ('Military Sniper', ('military sniper', 'sniper military', 'military')),
    ('AWP', ('awp',)),
    ('Scout', ('scout',)),
    ('AK-47', ('ak47', 'ak 47', 'ak-47')),
    ('SG552', ('sg552', 'sg 552')),
    ('Desert Rifle', ('desert rifle', 'rifle desert', 'scar')),
    ('M16 Rifle', ('m16',)),
    ('Silenced SMG', ('silenced smg', 'smg silenced', 'mac 10', 'mac10', 'silenced')),
    ('SMG', ('uzi',)),
    ('Chrome Shotgun', ('chrome shotgun', 'shotgun chrome')),
    ('SPAS-12', ('spas', 'combat shotgun')),
    ('Auto Shotgun', ('autoshotgun', 'auto shotgun')),
    ('Pump Shotgun', ('pumpshotgun', 'pump shotgun')),
    ('Magnum', ('magnum', 'desert eagle')),
    # pistola 是 L4D1 沿用下来的手枪模型名（v_pistola / v_dual_pistola）
    ('Pistol', ('pistol', 'pistola')),
    ('Chainsaw', ('chainsaw',)),
    ('Katana', ('katana',)),
    ('Machete', ('machete', 'kukri')),
    ('Crowbar', ('crowbar',)),
    ('Fire Axe', ('fireaxe', 'fire axe')),
    ('Shovel', ('shovel',)),
    ('Frying Pan', ('frying pan', 'fryingpan')),
    ('Golf Club', ('golf club', 'golfclub')),
    ('Cricket Bat', ('cricket bat', 'cricketbat')),
    ('Baseball Bat', ('baseball bat', 'baseballbat', 'baseball')),
    ('Electric Guitar', ('electric guitar', 'guitar')),
    ('Knife', ('knife',)),
    ('Tonfa', ('tonfa', 'nightstick')),
    ('Pitchfork', ('pitchfork',)),
    ('Pipe Bomb', ('pipe bomb', 'pipebomb')),
    ('Molotov', ('molotov',)),
    ('Vomit Jar', ('vomit jar', 'vomitjar', 'bile jar', 'bilejar')),
]

# 兜底规则：只有整个包里**一个具体型号都没认出来**时才用。
# 否则武器包普遍带的 sound/weapons/rifle/、materials/.../shotgun/ 这类
# 通用目录会把标签带偏 —— 一个 SPAS-12 皮肤包不该多出一个 Pump Shotgun。
_WEAPON_FALLBACK_RULES = [
    ('Pump Shotgun', ('shotgun',)),
    ('M16 Rifle', ('rifle',)),
    ('SMG', ('smg',)),
]

_ITEM_FINE_RULES = [
    ('Defibrillator', ('defib',)),
    ('Adrenaline', ('adrenaline', 'adrenalin')),
    ('Pain Pills', ('pills', 'pain pill', 'painpills')),
    ('Medkit', ('medkit', 'med kit', 'firstaidkit', 'first aid kit', 'firstaid',
                'first aid', 'healthkit', 'health kit')),
]

# 生还者/被感染者只在模型与贴图里认名字：HUD 里的 s_panel_coach.vtf 也很像，
# 但那属于界面 Mod，不该给它贴「教练」。
_FINE_SCOPE_MODEL = ('models/', 'materials/models/')
_FINE_SCOPE_SOUND = ('sound/player/survivor/', 'sound/survivor/', 'sound/infected/',
                     'sound/npc/', 'sound/weapons/')


def _norm_path(p: str) -> str:
    """把路径拍平成「前后带空格的小写词组」，方便按整词/整词组匹配。"""
    return ' ' + re.sub(r'[^a-z0-9]+', ' ', p).strip() + ' '


def _hit(norm: str, tokens: set[str], keys) -> bool:
    return any((k in tokens) if ' ' not in k else (k in norm) for k in keys)


# ── 特征提取 ─────────────────────────────────────────────────────

_TOKEN_RE = re.compile(r'[^a-z0-9]+')


def _tokens(path: str) -> set[str]:
    name = path.rsplit('/', 1)[-1].rsplit('.', 1)[0]
    return {t for t in _TOKEN_RE.split(name) if t}


def _features_from_paths(paths) -> Counter:
    f: Counter = Counter()
    for raw in paths:
        p = raw.lower().replace('\\', '/')
        if not p:
            continue
        f['n'] += 1
        ext = p.rsplit('.', 1)[-1] if '.' in p else ''
        if ext in _IMG_EXT:
            f['img'] += 1
        if ext in _TEX_EXT:
            f['tex'] += 1
        if ext in _SND_EXT:
            f['snd_ext'] += 1

        # ── 地图 ──
        if p.startswith('maps/'):
            if ext == 'bsp':
                f['bsp'] += 1
            elif ext == 'nav':
                f['nav'] += 1
        if p.startswith('missions/'):
            f['mission'] += 1

        # ── 目标家族：先看标准目录 ──
        is_arm = any(m in p for m in _ARM_MARK)
        if p.startswith(('models/v_models/', 'models/w_models/', 'models/weapons/')) and not is_arm:
            f['weapon'] += 1
        if p.startswith(('materials/models/weapons/', 'materials/models/v_models/',
                         'materials/models/w_models/')) and not is_arm:
            f['weapon_mat'] += 1
        if 'models/survivors/' in p or 'materials/models/survivors/' in p:
            f['survivor'] += 1
        if 'models/infected/' in p or 'materials/models/infected/' in p:
            f['infected'] += 1
        if p.startswith(('models/items/', 'models/props')):
            f['item'] += 1
        if p.startswith('materials/models/items/'):
            f['item_mat'] += 1

        # ── 私有目录兜底：按角色/武器代号识别（只看 models/ 下的文件，
        #    否则 HUD 里的 s_panel_coach.vtf 会被当成「教练皮肤」） ──
        if p.startswith('models/') and ext in ('mdl', 'vvd', 'vtx'):
            toks = _tokens(p)
            if not is_arm:
                if toks & set(_SURVIVOR_HINTS):
                    f['survivor'] += 1
                if toks & set(_INFECTED_HINTS):
                    f['infected'] += 1

        # ── 界面 ──
        if p.startswith(('materials/vgui/', 'resource/', 'materials/hud/')):
            f['ui'] += 1

        # ── 音效 ──
        if p.startswith('sound/') and ext in _SND_EXT:
            f['sound'] += 1

        # ── 脚本 ──
        if ext == 'nut':
            f['nut'] += 1
        if p.startswith('scripts/') and ext in ('txt', 'cfg', 'res') and p not in _SCRIPT_BOILERPLATE:
            f['script_cfg'] += 1
        if 'closecaption' in p or 'subtitle' in p:
            f['script_cfg'] += 1
        if p.startswith('scripts/mutations/') or ('mutation' in p and p.startswith('scripts/')):
            f['mutation'] += 1
        if ext == 'ani':
            f['ani'] += 1
    return f


_KEYWORD_RULES = [
    ('bsp', (b'maps/', b'.bsp'), True),
    ('weapon', (b'models/v_models', b'models/w_models', b'materials/models/weapons'), False),
    ('survivor', (b'models/survivors', b'materials/models/survivors'), False),
    ('infected', (b'models/infected', b'materials/models/infected'), False),
    ('ui', (b'materials/vgui', b'/resource/'), False),
    ('sound', (b'sound/',), False),
    ('script', (b'scripts/', b'.nut'), False),
    ('img', (b'materials/', b'models/'), False),
]


def features_from_bytes(path: Path, limit: int = 24 << 20) -> Counter:
    """VPK 解析失败时：直接在字节流里找路径关键词，退化成布尔证据。"""
    f: Counter = Counter()
    f['raw'] = 1
    try:
        with open(path, 'rb') as fh:
            data = fh.read(limit)
    except Exception:
        return f
    low = data.lower()
    for key, needles, _flag in _KEYWORD_RULES:
        if any(nd in low for nd in needles):
            f[key] = 1
    # 降级模式下 maps/ 太容易撞见（贴图路径里也可能出现），只认 .bsp 才判地图
    f['bsp'] = 1 if b'.bsp' in low else 0
    f['img'] = 1 if b'materials/' in low or b'models/' in low else 0
    f['tex'] = 1 if b'materials/' in low else 0
    return f


# ── 判定 ─────────────────────────────────────────────────────────

def _decide(f: Counter) -> list[str]:
    n = f['n'] or 1
    raw = bool(f['raw'])

    bsp = f['bsp']
    is_campaign = bsp >= 2 or (bsp >= 1 and bsp / n >= 0.01)
    if raw and bsp:
        is_campaign = True

    ui_ratio = f['ui'] / n
    has_ui = f['ui'] >= 1 and ui_ratio >= 0.25

    targets: list[str] = []
    if f['weapon'] or f['weapon_mat']:
        targets.append('武器')
    if f['survivor']:
        targets.append('生还者')
    if f['infected']:
        targets.append('被感染者')
    # 「物品」以前只数 models/items 与 models/props，可真实的医疗包/药丸皮肤
    # 大部分文件是 materials/models/items/… 的贴图，永远凑不够门槛 —— 于是
    # 物品类 Mod 一直被当成「皮肤」。这里把道具贴图也算作证据，并把阈值
    # 改成「至少 2 个道具文件 + 占比 30%」，仍然要求内容主体确实是道具。
    item_evidence = f['item'] + f['item_mat']
    if not targets and item_evidence >= 2 and item_evidence / n >= 0.3:
        targets.append('物品')

    visual = f['img'] > 0
    # 音效要「量压过贴图」：武器/角色包普遍自带 7~11 个音效（占比可达 46%），
    # 只按占比判会把它们误判成音效包，所以同时要求 音效数 ≥ 2×贴图数。
    sound = f['sound'] >= 3 and f['sound'] / n >= 0.52 and f['sound'] >= 2 * f['tex']
    if raw and not targets and f['sound'] and not f['img']:
        sound = True
    has_script = f['nut'] > 0 or f['script_cfg'] > 0 or f['ani'] > 0
    # 降级判定（解析失败）时，字节流里的 scripts/ 太容易误命中——
    # 只有整体上没有任何美术资源时才认它是脚本 mod。
    if raw and f['script'] and not targets and not f['tex']:
        has_script = True

    # 1) 战役独占：地图自带的贴图/音效不算这个 Mod 的类别
    if is_campaign:
        return ['战役']

    # 2) 公共动画库：覆盖多个角色家族且一张贴图都没有 → 是给别的 Mod 打底的脚本库
    if len(targets) >= 2 and not f['tex']:
        return ['脚本']

    # 3) 纯界面 Mod
    if has_ui and not targets:
        return ['游戏界面'] + (['脚本'] if has_script else [])

    # 4) 音效主导（比重压过贴图）
    if sound and not targets:
        return ['音效'] + (['脚本'] if has_script else [])

    tags: list[str] = []
    if sound and targets:
        # 音效 Mod 顺手换了几张贴图 —— 音效仍然是主类别
        tags.append('音效')
    tags.extend(targets)
    if visual and (targets or not sound):
        tags.append('皮肤')
    if sound and '音效' not in tags:
        tags.append('音效')
    if has_script:
        tags.append('脚本')
    if f['mutation']:
        tags.append('突变模式')

    if not tags:
        if has_script:
            return ['脚本']
        if visual:
            return ['皮肤']
        return ['杂项']
    # 去重保序，最多 3 个：标签是给人扫一眼用的，堆 4 个反而没重点
    out: list[str] = []
    for t in tags:
        if t not in out:
            out.append(t)
    return out[:3]


def fine_tags(paths, coarse: list[str]) -> list[str]:
    """按已命中大类推导细分标签（大类顺序 → 命中次数降序）。

    只在对应大类成立时才算：一个只改贴图的「武器皮肤」不会因为包里
    顺带一个 v_arms 就被贴上「步枪」。
    """
    fams = [c for c in coarse if c in FINE_TAGS]
    if not fams:
        return []

    survivors: Counter = Counter()
    infected: Counter = Counter()
    weapons: Counter = Counter()
    weapon_fallback: Counter = Counter()
    items: Counter = Counter()
    want_survivor = '生还者' in fams
    want_infected = '被感染者' in fams
    want_weapon = '武器' in fams
    want_item = '物品' in fams

    for raw in paths:
        p = raw.lower().replace('\\', '/')
        if not p:
            continue
        ext = p.rsplit('.', 1)[-1] if '.' in p else ''
        norm = _norm_path(p)
        toks = set(norm.split())

        # ── 角色：只在模型/贴图/音效里认，HUD 的 s_panel_coach.vtf 不算 ──
        if (want_survivor or want_infected) and (ext in _IMG_EXT or ext == 'ani') \
                and (p.startswith(_FINE_SCOPE_MODEL) or p.startswith(_FINE_SCOPE_SOUND)):
            if want_survivor:
                for tag, keys in _SURVIVOR_FINE.items():
                    if _hit(norm, toks, keys):
                        survivors[tag] += 1
            if want_infected:
                for tag, keys in _INFECTED_FINE.items():
                    if _hit(norm, toks, keys):
                        infected[tag] += 1

        # ── 武器：同一条路径只归一类，避免 rifle_m60 同时被打成两款枪 ──
        if want_weapon and not any(m in p for m in _ARM_MARK) and p.startswith(
            ('models/', 'materials/', 'sound/weapons/', 'scripts/weapons/', 'particles/')
        ):
            for tag, keys in _WEAPON_FINE_RULES:
                if _hit(norm, toks, keys):
                    weapons[tag] += 1
                    break
            else:
                for tag, keys in _WEAPON_FALLBACK_RULES:
                    if _hit(norm, toks, keys):
                        weapon_fallback[tag] += 1
                        break

        # ── 道具 ──
        if want_item:
            for tag, keys in _ITEM_FINE_RULES:
                if _hit(norm, toks, keys):
                    items[tag] += 1
                    break

    # 兜底规则只在整包都认不出具体型号时启用：通用目录（sound/weapons/shotgun）
    # 不能把已经确定的型号稀释成「Pump Shotgun + 别的」
    out: list[str] = []
    for fam in fams:
        if fam == '生还者':
            # ≥4 个角色 = 公用动画库或整包合集（gestures_teenangst / anim_namvet…），
            # 给它贴具体角色反而是误导，只保留「生还者」大类
            if len(survivors) < 4:
                out.extend(t for t, _ in survivors.most_common(2))
        elif fam == '被感染者':
            # Common Infected 几乎每个带 common 音效的包都会命中，
            # 只在没有识别出具体特殊感染者时才拿它兜底
            picked = [t for t, _ in infected.most_common() if t != 'Common Infected'][:2]
            if not picked and infected.get('Common Infected'):
                picked = ['Common Infected']
            out.extend(picked)
        elif fam == '武器':
            picked = weapons or weapon_fallback
            # ≥6 种不同武器 = 武器合集（CS:GO 武器包那种），挑两个型号出来
            # 反而以偏概全 —— 只保留「武器」大类，让用户自己点进去看。
            if len(picked) < 6:
                out.extend(t for t, _ in picked.most_common(2))
        elif fam == '物品':
            out.extend(t for t, _ in items.most_common(2))
    return list(dict.fromkeys(out))



# 有的 Mod 一个资源文件都不带，全靠 .nut 脚本在跑（典型：爆头音效包）。
# 这种情况只能看脚本内容 —— 调用了音效 API 就算音效 Mod。
_SOUND_API_RE = re.compile(
    rb'(PrecacheSound|EmitSoundOnClient|EmitSoundOn\b|EmitAmbientSoundOn|'
    rb'StopSoundOn|PlaySoundEx|soundcode)',
)
_PROBE_MAX_FILES = 6
_PROBE_MAX_BYTES = 96 << 10
# 实测：真正的音效脚本有 57 处调用；普通脚本 Mod 顶多 3 处（顺手播个提示音），
# 阈值取 8 能干净分开，避免把「会响一下」的功能脚本误判成音效包。
_PROBE_MIN_HITS = 8


def script_sounds(reader, paths) -> bool:
    """在脚本 Mod 的 .nut 里找音效 API 调用（要足够密集才算音效包）。"""
    hits = 0
    probed = 0
    for p in paths:
        if not p.endswith('.nut'):
            continue
        if probed >= _PROBE_MAX_FILES:
            break
        probed += 1
        try:
            data = reader(p)
        except Exception:
            continue
        if not isinstance(data, (bytes, bytearray)):
            continue
        hits += len(_SOUND_API_RE.findall(bytes(data[:_PROBE_MAX_BYTES])))
        if hits >= _PROBE_MIN_HITS:
            return True
    return False


# VPK 头损坏时，目录里的完整路径字符串往往还在（只是没法按 VPK 规范解析），
# 直接从字节流里把「materials/.../xxx.vtf」这类完整路径捞出来，比纯关键词准得多。
_PATH_RE = re.compile(
    rb'((?:materials|models|sound|scripts|maps|missions|resource|particles|scenes)/'
    rb'[\w \-\.\(\)\[\]#@!$&+=,;`^]{1,120}?\.'
    rb'(?:vmt|vtf|mdl|vvd|vtx|phy|ani|wav|mp3|ogg|nut|txt|res|bsp|pcf|vpcf|vcd))',
    re.IGNORECASE,
)


def extract_paths(path: Path, limit: int = 32 << 20) -> list[str]:
    try:
        with open(path, 'rb') as fh:
            data = fh.read(limit)
    except Exception:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for m in _PATH_RE.finditer(data):
        try:
            cand = m.group(1).decode('ascii', 'ignore').lower().strip()
        except Exception:
            continue
        if cand and cand not in seen:
            seen.add(cand)
            out.append(cand)
    return out


def classify(paths=None, vpk_path: Path | None = None,
             reader=None) -> tuple[list[str], bool]:
    """返回 (标签列表, 是否为降级判定)。

    paths 为空且给了 vpk_path 时会退化为字节流扫描。
    reader 可选，形如 `reader(内部路径) -> bytes`：只有「什么资源都不带、
    光靠 .nut 脚本干活」的 Mod 才会用到 —— 通过脚本里调用的音效 API
    判断它其实是个音效 Mod（例：爆头音效包）。
    """
    paths = [p for p in (paths or []) if isinstance(p, str) and p.strip()]
    if paths:
        feature = _features_from_paths(paths)
        tags = _decide(feature)
        if reader and tags == ['脚本'] and script_sounds(reader, paths):
            return ['音效', '脚本'], False
        # 细分标签挂在大类后面：卡片上永远先看到「武器」再看到「霰弹枪」
        fine = fine_tags(paths, tags)
        return (tags + fine) if fine else tags, False
    if vpk_path and Path(vpk_path).exists():
        vpk_path = Path(vpk_path)
        salvaged = extract_paths(vpk_path)
        if len(salvaged) >= 3:
            return _decide(_features_from_paths(salvaged)), True
        return _decide(features_from_bytes(vpk_path)), True
    return ['杂项'], True


def primary(tags: list[str]) -> str:
    return tags[0] if tags else '杂项'


def sort_tags(tags: list[str]) -> list[str]:
    return sorted(tags, key=lambda t: (TAG_ORDER.index(t) if t in TAG_ORDER else 99))
