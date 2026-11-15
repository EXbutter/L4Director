/** 创意工坊浏览用到的类型与展示工具。 */

export interface WorkshopTag {
  name: string;
  label: string;
}

export interface WorkshopItem {
  id: string;
  title: string;
  preview_url: string;
  size: number;
  created_at: number;
  updated_at: number;
  subscriptions: number;
  lifetime_subscriptions: number;
  views: number;
  favorited: number;
  tags: WorkshopTag[];
  description: string;
  filename: string;
  banned: boolean;
  /** 0~100，只有填了 API Key 才有（网页路径拿不到评分）；现在只作 tooltip 里的补充信息 */
  score: number | null;
  votes_up: number;
  votes_down: number;
  downloaded: boolean;
}

export interface WorkshopSort {
  id: string;
  label: string;
  requires_key: boolean;
}

export interface WorkshopTagGroup {
  id: string;
  label: string;
  tags: WorkshopTag[];
}

export interface WorkshopMeta {
  sorts: WorkshopSort[];
  tag_groups: WorkshopTagGroup[];
  has_key: boolean;
  key_masked: string;
  page_size: number;
  source: 'api' | 'html';
}

export interface WorkshopBrowseResult {
  source: 'api' | 'html';
  source_host: string;
  items: WorkshopItem[];
  total: number;
  page_size: number;
  next: string;
  has_more: boolean;
  note: string;
  cached: boolean;
}

export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  const mb = bytes / 1048576;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatCount(n: number): string {
  if (!n || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 10000).toFixed(1)}万`;
}

export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  const d = new Date(unixSeconds * 1000);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 好评数（绝对条数），不是好评率。
 *
 * 为什么弃用好评率：工坊里绝大多数条目都挤在 50%~60% 这十个百分点里，
 * 卡片上写 55% / 51% 根本分不出好坏，还要用户自己反推「到底有几个人投过票」。
 * 直接给条数，口碑的分量和样本量一次说清。
 *
 * 拿不到就是 0：投票数据只有填了 API Key 的 QueryFiles 才带（网页路径走的
 * 是 ISteamRemoteStorage/GetPublishedFileDetails，压根没有 vote_data 字段）。
 */
export function voteCount(item: WorkshopItem): number {
  return item.votes_up > 0 ? item.votes_up : 0;
}

/**
 * 累计下载量 = Steam 的 `lifetime_subscriptions`（累计订阅过的人数，含后来退订的）。
 *
 * 工坊没有真正的「下载次数」字段，这是唯一能量出基数的那个。当前订阅数
 * （`subscriptions`）只算还订着的人，老 Mod 的这两个数能差好几倍。
 * 网页路径拿不到 lifetime 字段，这里返回 0 让调用方整块不渲染 ——
 * 不能退回当前订阅数，否则同一个「下载量」在两页里是两个数。
 */
export function downloadCount(item: WorkshopItem): number {
  return item.lifetime_subscriptions > 0 ? item.lifetime_subscriptions : 0;
}

/** 好评数的悬浮提示：好评率降级到这里，原来能看到的信息一条都不丢 */
export function voteTooltip(item: WorkshopItem): string {
  const parts = [`好评 ${item.votes_up}`, `差评 ${item.votes_down}`];
  if (item.score !== null) parts.push(`好评率 ${Math.round(item.score)}%`);
  return parts.join(' · ');
}

/** 下载量的悬浮提示：顺手把「当前订阅」也带上，两个数一起看才不会误读 */
export function downloadTooltip(item: WorkshopItem): string {
  const life = downloadCount(item);
  return `累计下载 ${life} 次（含已退订）· 当前订阅 ${item.subscriptions}`;
}

/**
 * 把工坊的 BBCode 描述转成纯文本。
 *
 * 原作者写描述用的是 BBCode（[h1]、[b]、[url=…]），以前这里直接塞进 <div>，
 * 结果是满屏方括号标签，而且 [img] 里的地址会变成一大串看不懂的 URL。
 */
export function cleanDescription(raw: string): string {
  if (!raw) return '';
  let text = raw;
  // [img]…[/img]、[video]…[/video] 整段丢掉：抽屉里不内嵌外链资源
  text = text.replace(/\[img\][\s\S]*?\[\/img\]/gi, '');
  text = text.replace(/\[video\][\s\S]*?\[\/video\]/gi, '');
  // 只有开标签没闭标签的 [img] 、[previewyoutube=…] 之类，连同后面的地址一起吃掉
  text = text.replace(/\[(img|previewyoutube|video)\b[^\]]*\][\s\S]*?(?=\n|$)/gi, '');
  // [url=xxx]文字[/url] → 文字；[url]xxx[/url] → xxx
  text = text.replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1');
  text = text.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1');
  // 其余成对标签直接去掉标签本体，保留内容
  text = text.replace(/\[\/?[a-z0-9*]+(=[^\]]*)?\]/gi, '');
  // 裸的图片直链：很多作者直接把 CDN 地址写成正文，不去掉就是一屏乱码
  // （形如 https://images.steamusercontent.com/ugc/123/ABC…）
  text = text.replace(/https?:\/\/(?:images?|cdn)\.steamusercontent\.com\/\S+/gi, '');
  text = text.replace(/https?:\/\/\S+\.(?:png|jpe?g|webp|gif|bmp|mp4)\b\S*/gi, '');
  // 剩下的其它超长链接（>72 字符）压成域名，避免把描述撑爆
  text = text.replace(/https?:\/\/\S{72,}/gi, (m) => {
    try { return new URL(m).host; } catch { return ''; }
  });
  // 清掉因上面删除而留下的空行与行尾空格
  text = text.split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n');
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 封面统一走本地代理：既命中磁盘缓存，也避免渲染进程直接访问外网 CDN。
 *
 * 关于 `w`/`h`：后端支持让 Steam 图床先缩放（省流量），但**默认不要传**。
 * 实测图床的缩放是服务端实时计算：同一张图原图走边缘缓存 0.2 秒，加了
 * `imw/imh` 反而要 3~12 秒（动图还要重新编码）。所以卡片一律取原图，
 * 尺寸问题交给 `ThumbImage` 在本地用 `createImageBitmap` 降采样解决 ——
 * 又快又不吃显存。
 */
export function thumbnailUrl(
  api: string,
  id: string,
  previewUrl: string,
  w?: number,
  h?: number,
): string {
  const size = w && h ? `&w=${w}&h=${h}` : '';
  return `${api}/api/download/thumbnail?wid=${encodeURIComponent(id)}&url=${encodeURIComponent(previewUrl || '')}${size}`;
}
