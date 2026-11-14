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
  /** 0~100，只有填了 API Key 才有（网页路径拿不到评分） */
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
