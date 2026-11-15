import type { ModData } from '../store/useStore';

/**
 * 「替换清单」与「随机混搭」的组合计算。
 *
 * 数据来自后端 `ModData.coverage`（见 backend/services/tagger.py 的 coverage()）：
 * 每个家族记录「这个包替换了清单里的哪几个成员」——
 *
 *     coverage['生还者'] = { hit: 1, total: 8, names: ['Nick'] }   // 一个尼克皮肤
 *     coverage['生还者'] = { hit: 8, total: 8, names: [...8 人] }  // 整套合集
 *
 * 混搭的正确语义（用户口径）：**一个成员只由一个包提供**。尼克有 5 个皮肤包
 * 在库里，混搭就是从这 5 个里随机挑一个；8 个生还者各自随机挑，凑成一套。
 * 所以这里做的是「按成员随机指派提供者」+「保证互不覆盖」，不是「每类挑一个」。
 */

export interface CoverageInfo {
  /** 命中的成员数 */
  hit: number;
  /** 清单总长度（生还者 8、特感 8、物品 4、武器 35） */
  total: number;
  /** 命中的成员名，如 ['Zoey', 'Nick', ...] */
  names: string[];
}

export type CoverageMap = Record<string, CoverageInfo>;

/** 后端 /api/mods/coverage-roster 给的全集 */
export interface RosterFamily {
  key: string;
  total: number;
  names: string[];
}

/** 顺序 = 游戏里最常换的顺序：先看人、再看怪、然后是手里拿的 */
export const FAMILY_ORDER = ['生还者', '特感', '物品', '武器'];

export const FAMILY_KEYS: Record<string, string> = {
  生还者: 'survivor',
  特感: 'special',
  物品: 'item',
  武器: 'weapon',
};

/**
 * 成员在界面上的显示名：**官方英文名**，就是 roster 里的那个键本身
 * （Zoey / Tank / Hunting Rifle）。和创意工坊标题、游戏里的叫法对得上，
 * 不用再经过一道中译；判定也一直用这个英文键。
 *
 * 中文译名只留给 tooltip（见 entityHint），帮不熟型号的人确认一下。
 */
const ENTITY_CN: Record<string, string> = {
  // ── 生还者 ──
  Bill: '比尔',
  Francis: '弗朗西斯',
  Louis: '路易斯',
  Zoey: '佐伊',
  Coach: '教练',
  Ellis: '埃利斯',
  Nick: '尼克',
  Rochelle: '罗谢尔',
  // ── 特感 ──
  Boomer: '胖子',
  Charger: '冲锋',
  Hunter: '猎人',
  Jockey: '骑手',
  Smoker: '烟鬼',
  Spitter: '酸液',
  Tank: '坦克',
  Witch: '女巫',
  // ── 物品 ──
  Medkit: '医疗包',
  'Pain Pills': '止痛药',
  Adrenaline: '肾上腺素',
  Defibrillator: '电击器',
  // ── 武器 ──
  'Grenade Launcher': '榴弹',
  M60: 'M60',
  'Hunting Rifle': '猎枪',
  'Military Sniper': '军狙',
  AWP: 'AWP',
  Scout: 'Scout',
  'AK-47': 'AK-47',
  SG552: 'SG552',
  'Desert Rifle': 'SCAR',
  'M16 Rifle': 'M16',
  'Silenced SMG': '消音 SMG',
  SMG: 'Uzi',
  'Chrome Shotgun': '铬霰弹',
  'SPAS-12': 'SPAS',
  'Auto Shotgun': '连霰',
  'Pump Shotgun': '泵霰',
  Magnum: '马格南',
  Pistol: '手枪',
  Chainsaw: '电锯',
  Katana: '武士刀',
  Machete: '砍刀',
  Crowbar: '撬棍',
  'Fire Axe': '消防斧',
  Shovel: '铲子',
  'Frying Pan': '平底锅',
  'Golf Club': '高尔夫杆',
  'Cricket Bat': '板球棒',
  'Baseball Bat': '棒球棒',
  'Electric Guitar': '电吉他',
  Knife: '小刀',
  Tonfa: '警棍',
  Pitchfork: '草叉',
  'Pipe Bomb': '土制炸弹',
  Molotov: '燃烧瓶',
  'Vomit Jar': '胆汁罐',
};

/** 界面上的成员名：官方英文名（键本身就是英文，原样返回） */
export function entityLabel(name: string): string {
  return name;
}

/** tooltip 里的补充：「英文（中文）」，没有中文译名时只给英文 */
export function entityHint(name: string): string {
  const cn = ENTITY_CN[name];
  return cn ? `${name}（${cn}）` : name;
}

export function familyLabel(family: string): string {
  return family;
}

const SEP = '\u0000';

export function entityKey(family: string, name: string): string {
  return family + SEP + name;
}

export function keyFamily(key: string): string {
  const i = key.indexOf(SEP);
  return i < 0 ? '' : key.slice(0, i);
}

export function keyEntity(key: string): string {
  const i = key.indexOf(SEP);
  return i < 0 ? key : key.slice(i + 1);
}

// ────────────────────────────── 基础查询 ──────────────────────────────

export function coverageOf(mod: ModData, family: string): CoverageInfo | null {
  const c = mod.coverage?.[family];
  if (!c || !c.hit) return null;
  return c;
}

/** 这个 Mod 替换的全部成员（entityKey 列表） */
export function coveredEntities(mod: ModData): string[] {
  const out: string[] = [];
  for (const family of Object.keys(mod.coverage || {})) {
    const info = mod.coverage![family];
    for (const name of info?.names || []) out.push(entityKey(family, name));
  }
  return out;
}

export function isFullSet(mod: ModData, family: string): boolean {
  const c = coverageOf(mod, family);
  return !!c && c.hit >= c.total && c.total > 0;
}

export function coverageRatio(mod: ModData, family: string): number {
  const c = coverageOf(mod, family);
  return c && c.total > 0 ? c.hit / c.total : 0;
}

export function coveredFamilies(mod: ModData): string[] {
  return FAMILY_ORDER.filter((f) => coverageOf(mod, f));
}

/** 卡片上要展示的覆盖标记：按覆盖率降序，最多 2 个（多了会把标签行挤爆） */
export function coverageBadges(
  mod: ModData,
  limit = 2,
): { family: string; info: CoverageInfo }[] {
  return coveredFamilies(mod)
    .map((family) => ({ family, info: coverageOf(mod, family)! }))
    .sort((a, b) => b.info.hit / b.info.total - a.info.hit / a.info.total)
    .slice(0, limit);
}

export function hasFullSet(mod: ModData): boolean {
  return coveredFamilies(mod).some((f) => isFullSet(mod, f));
}

export function coverageText(info: CoverageInfo): string {
  return `${info.hit}/${info.total}`;
}

export function coverageTooltip(family: string, info: CoverageInfo): string {
  const full = info.hit >= info.total;
  return `${family} ${info.hit}/${info.total}${full ? '（整套替换）' : ''}\n`
    + info.names.map(entityHint).join('、');
}

/** entityKey → 覆盖它的全部 Mod（同一成员常常有七八个皮肤） */
export type CoverIndex = Map<string, ModData[]>;

export function buildCoverIndex(mods: ModData[]): CoverIndex {
  const index: CoverIndex = new Map();
  for (const mod of mods) {
    if (mod.unreadable) continue;
    for (const key of coveredEntities(mod)) {
      const list = index.get(key);
      if (list) list.push(mod);
      else index.set(key, [mod]);
    }
  }
  return index;
}

// ────────────────────────────── 随机混搭 ──────────────────────────────

function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export interface MixOptions {
  /** 参与混搭的家族（生还者 / 特感 / 物品 / 武器） */
  families: string[];
  /**
   * 只补缺口：已经启用着的包先钉住，只为「现在没人换」的成员随机挑。
   * 这样点一下不会把已经搭好的组合拆散。
   */
  gapOnly?: boolean;
  /** 注入随机源（测试用），默认 Math.random */
  rand?: () => number;
}

export interface MixRoll {
  /** entityKey → 由哪个包提供（含 gapOnly 时被钉住的已启用包） */
  assignment: Map<string, ModData>;
  /** entityKey → 全部候选（含没选上的），界面显示「N 个可选」、换一个都用它 */
  candidates: CoverIndex;
  /** 本次随机选中、需要启用的包（已去重） */
  chosen: ModData[];
  /** 没有任何候选的成员（库里就没有替换它的包） */
  missing: string[];
  /** gapOnly 时被钉住的已启用包（这些本来就在生效，不算「要启用」） */
  lockedNames: Set<string>;
}

/**
 * 滚一套混搭：每个成员随机挑一个提供者，且任意两个选中包不覆盖同一个成员。
 *
 * 为什么需要「不覆盖同一个成员」：两个包都换 Nick 时装上去只会互相盖文件，
 * 谁赢取决于加载顺序。所以挑下一个包之前要先把已被占用的成员排除掉。
 *
 * 三处细节，都是踩过之后才加的：
 *  1. **先排「候选最少」的成员**（候选数相同则随机）：只有一个包能换的
 *     Hunting Rifle 要是排在后面，它唯一的候选很可能已经被别的成员占用
 *     （那个包同时换猎枪和泵动霰弹），于是明明库里有包却报缺口。
 *  2. **前瞻**：给某个成员挑包时，如果某个候选会让「另一个还没安排的成员
 *     变得没有候选」，就优先避开它（没有安全候选时照旧随机）。
 *  3. **合集降权**：一个包覆盖的成员越多，被抽中的概率越低（权重 1/覆盖数）。
 *     混搭要的是「8 个人来自 8 个不同的包」，合集包（8 人 + 21 把枪那种）
 *     只该在没人单独覆盖某个成员时兜底；权重不设 0，因为它确实是合法候选。
 */
export function rollMix(mods: ModData[], roster: RosterFamily[], opts: MixOptions): MixRoll {
  const famSet = new Set(opts.families);
  const rand = opts.rand ?? Math.random;
  const usable = mods.filter((m) => !m.unreadable);
  const index = buildCoverIndex(usable);

  const assignment = new Map<string, ModData>();
  const lockedNames = new Set<string>();
  const chosen: ModData[] = [];
  const chosenNames = new Set<string>();

  if (opts.gapOnly) {
    for (const mod of usable) {
      if (!mod.enabled) continue;
      let touched = false;
      for (const key of coveredEntities(mod)) {
        if (!famSet.has(keyFamily(key))) continue;
        if (!assignment.has(key)) {
          assignment.set(key, mod);
          touched = true;
        }
      }
      if (touched) lockedNames.add(mod.name);
    }
  }

  // 本次要安排的成员（按家族顺序收集，稍后按「候选数」重排）
  const all: string[] = [];
  for (const fam of roster) {
    if (!famSet.has(fam.key)) continue;
    for (const name of fam.names) {
      const key = entityKey(fam.key, name);
      if (!assignment.has(key)) all.push(key);
    }
  }

  /** 当前状态下能合法提供 key 的包：没被选过、且不和已安排的成员撞车 */
  const legalFor = (key: string): ModData[] => {
    const out: ModData[] = [];
    for (const mod of index.get(key) || []) {
      if (chosenNames.has(mod.name) || lockedNames.has(mod.name)) continue;
      if (coveredEntities(mod).every((k) => !assignment.has(k))) out.push(mod);
    }
    return out;
  };

  /** 挑了 candidate 之后，会不会有别的成员因此一个候选都不剩 */
  const orphansOthers = (candidate: ModData, keys: string[]): boolean => {
    const sim = new Map(assignment);
    for (const k of coveredEntities(candidate)) {
      if (famSet.has(keyFamily(k))) sim.set(k, candidate);
    }
    const simChosen = new Set(chosenNames).add(candidate.name);
    for (const key of keys) {
      if (sim.has(key)) continue;
      const alive = (index.get(key) || []).some((mod) => {
        if (simChosen.has(mod.name) || lockedNames.has(mod.name)) return false;
        return coveredEntities(mod).every((k) => !sim.has(k));
      });
      if (!alive) return true;
    }
    return false;
  };

  // 候选最少的先安排：它们最没有退路（同数量内保持随机顺序）
  const initialPool = new Map(all.map((k) => [k, (index.get(k) || []).length]));
  const order = shuffle([...all], rand).sort(
    (a, b) => (initialPool.get(a) || 0) - (initialPool.get(b) || 0),
  );

  const pickOne = (pool: ModData[]): ModData => {
    // 合集降权：覆盖 8 个成员的包权重 1/8
    const weights = pool.map((m) => {
      const n = coveredEntities(m).filter((k) => famSet.has(keyFamily(k))).length;
      return 1 / Math.max(1, n);
    });
    const total = weights.reduce((s, w) => s + w, 0);
    let r = rand() * total;
    for (let i = 0; i < pool.length; i += 1) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  };

  const missing: string[] = [];
  for (let i = 0; i < order.length; i += 1) {
    const key = order[i];
    if (assignment.has(key)) continue; // 被同批里更早选中的合集整片覆盖了

    const legal = legalFor(key);
    if (legal.length === 0) {
      missing.push(key);
      continue;
    }

    const rest = order.slice(i + 1).filter((k) => !assignment.has(k));
    const safe = legal.filter((m) => !orphansOthers(m, rest));
    const pick = pickOne(safe.length > 0 ? safe : legal);

    for (const k of coveredEntities(pick)) {
      if (famSet.has(keyFamily(k)) && !assignment.has(k)) assignment.set(k, pick);
    }
    chosen.push(pick);
    chosenNames.add(pick.name);
  }

  return { assignment, candidates: index, chosen, missing, lockedNames };
}

export interface MixPlan {
  /** 需要启用的包（本来已启用的不算） */
  enable: string[];
  /** 需要禁用的包：与选中的包撞了同一个成员 */
  disable: string[];
  /** 每条禁用记录撞在哪个成员上，界面据此解释「为什么关它」 */
  conflicts: { mod: string; modLabel: string; entity: string; with: string }[];
  /** 选中的包顺带替换、但不在本次混搭类别里的资源（提示「它还会换别的东西」） */
  spill: { mod: string; label: string; families: string[] }[];
}

/**
 * 把「随机结果」算成一次批量启用/禁用。
 *
 * 只关真正撞车的：一个包和选中的某个包覆盖了同一个成员才关，地图 / 音效 /
 * 界面这类压根不在这份清单里的 Mod 一律不动 —— 一键混搭顺手把语音包关了
 * 是最招人烦的行为。
 */
export function planMix(mods: ModData[], roll: MixRoll, families: string[]): MixPlan {
  const famSet = new Set(families);
  const chosenNames = new Set(roll.chosen.map((m) => m.name));
  const coveredByChosen = new Map<string, ModData>();
  for (const mod of roll.chosen) {
    for (const key of coveredEntities(mod)) coveredByChosen.set(key, mod);
  }

  const enable = roll.chosen.filter((m) => !m.enabled).map((m) => m.name);
  const disable: string[] = [];
  const conflicts: MixPlan['conflicts'] = [];

  for (const mod of mods) {
    if (!mod.enabled || mod.unreadable || chosenNames.has(mod.name)) continue;
    if (roll.lockedNames.has(mod.name)) continue;
    const hit = coveredEntities(mod).find((k) => coveredByChosen.has(k));
    if (!hit) continue;
    disable.push(mod.name);
    conflicts.push({
      mod: mod.name,
      modLabel: mod.display_name,
      entity: `${keyFamily(hit)} · ${entityLabel(keyEntity(hit))}`,
      with: coveredByChosen.get(hit)!.display_name,
    });
  }

  // 顺带替换：选中的包覆盖了本次没参与混搭的类别
  const spill: MixPlan['spill'] = [];
  for (const mod of roll.chosen) {
    const outside = coveredFamilies(mod).filter((f) => !famSet.has(f));
    if (outside.length > 0) spill.push({ mod: mod.name, label: mod.display_name, families: outside });
  }

  return { enable, disable, conflicts, spill };
}

/** 一套混搭对每个家族的覆盖数（面板顶部的 8/8 · 6/8 · …） */
export function rollSummary(
  roll: MixRoll,
  roster: RosterFamily[],
  families: string[],
): { key: string; covered: number; total: number }[] {
  const famSet = new Set(families);
  return roster
    .filter((f) => famSet.has(f.key))
    .map((f) => ({
      key: f.key,
      covered: f.names.filter((n) => roll.assignment.has(entityKey(f.key, n))).length,
      total: f.total,
    }));
}

// ────────────────────────── 当前搭配的完整度看板 ──────────────────────────

export interface BoardEntity {
  name: string;
  label: string;
  /** 当前启用着的、覆盖它的包（正常只有一个，多个说明本来就冲突） */
  providers: ModData[];
  /** 库里还有几个包能换它（含已启用的），用于「缺了但能补」的提示 */
  available: number;
}

export interface BoardFamily {
  key: string;
  total: number;
  covered: number;
  entities: BoardEntity[];
}

/**
 * 当前启用组合的覆盖看板：哪些成员已经有包在换、哪些还是原版。
 *
 * 只统计**已启用**的包 —— 看板回答的是「现在进游戏会看到什么」，
 * 不是「库里有什么」。
 */
export function coverageBoard(
  mods: ModData[],
  roster: RosterFamily[],
  index: CoverIndex,
): BoardFamily[] {
  const enabled = mods.filter((m) => m.enabled && !m.unreadable);
  return roster.map((fam) => {
    const entities = fam.names.map((name) => {
      const key = entityKey(fam.key, name);
      const providers = enabled.filter((m) => coverageOf(m, fam.key)?.names.includes(name));
      return {
        name,
        label: entityLabel(name),
        providers,
        available: index.get(key)?.length ?? 0,
      };
    });
    return {
      key: fam.key,
      total: fam.total,
      covered: entities.filter((e) => e.providers.length > 0).length,
      entities,
    };
  });
}

/**
 * 后端没给名册时的兜底：用所有 Mod 的 coverage 拼一个「见过谁」的清单。
 * 只有命中过的成员，所以看不出一共有多少 —— 界面据此提示「清单未加载」。
 */
export function rosterFromMods(mods: ModData[]): RosterFamily[] {
  const acc: Record<string, { names: Set<string>; total: number }> = {};
  for (const mod of mods) {
    for (const family of Object.keys(mod.coverage || {})) {
      const info = mod.coverage![family];
      if (!info) continue;
      const slot = (acc[family] ||= { names: new Set(), total: info.total });
      slot.total = Math.max(slot.total, info.total);
      for (const n of info.names) slot.names.add(n);
    }
  }
  return FAMILY_ORDER.filter((f) => acc[f]).map((f) => ({
    key: f,
    total: acc[f].total,
    names: [...acc[f].names],
  }));
}
