/**
 * 战役（地图）Mod 判定 —— 统一入口。
 *
 * 为什么要特意抽出来：
 *   战役地图动辄几百 MB 到 2 GB（Baka 单个就 1.5 GB），但它**只有在玩那张图时**
 *   才会被引擎按需载入，跟「一直挂在内存里的资源包」完全不是一回事。
 *   所以右下角的占用统计必须把它排除，否则数字永远飘红、毫无参考价值。
 *
 * 为什么两个条件都要看：
 *   * `role` 是后端按 VPK 内容判的（含 .bsp → campaign），最可靠；
 *     但它只对**启用中**且能解析的包赋值，禁用包还是默认的 'art'。
 *   * `tags` / `role_tags` 是界面上可见的标签，禁用包也有；
 *     但 `tags` 允许用户手改，可能被改成别的分类。
 *   两者任一命中就认定为战役 —— 占用统计宁可少算一个，也不该把地图的 GB 级体积混进来。
 */
export interface CampaignProbe {
  role?: string | null;
  role_tags?: string[] | null;
  tags?: string[] | null;
}

const CAMPAIGN_LABELS = ['战役', '地图'];

export function isCampaignMod(mod: CampaignProbe | null | undefined): boolean {
  if (!mod) return false;
  if (mod.role === 'campaign') return true;
  for (const key of ['tags', 'role_tags'] as const) {
    const list = mod[key];
    if (Array.isArray(list) && list.some((t) => CAMPAIGN_LABELS.includes(t))) {
      return true;
    }
  }
  return false;
}
