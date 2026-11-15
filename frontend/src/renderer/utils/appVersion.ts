/**
 * 应用版本信息（构建时由 vite.config.ts 的 define 注入，来源 package.json 的 version）。
 *
 * 这里统一收口，避免各界面分别写死版本号——版本只有 package.json 一处是权威来源。
 */

/** 真实版本号，例如 "1.0.0-beta.1"；极端情况下（没走 Vite define）退化为空串 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

/** 是否为预发布版本（版本号里带 beta / alpha / rc） */
export const IS_BETA: boolean = /-(beta|alpha|rc)/i.test(APP_VERSION);

/** 渠道标记文本，例如 "BETA"；正式版为空串 */
export const CHANNEL_LABEL: string = IS_BETA
  ? (APP_VERSION.match(/-(beta|alpha|rc)/i)?.[1] ?? 'beta').toUpperCase()
  : '';

/** 完整版本文本，例如 "v1.0.0-beta.1"（仅用于调试提示/tooltip，不直接展示） */
export const VERSION_LABEL: string = APP_VERSION ? `v${APP_VERSION}` : '';

/** 去掉预发布后缀的版本号，例如 "1.0.0-beta.1" → "1.0.0" */
const VERSION_CORE: string = APP_VERSION.split(/[-+]/)[0];

/**
 * 界面上展示的版本号：完整三段，例如 "v1.3.2"（预发布再加渠道词，"v1.3.2 beta"）。
 *
 * 以前这里只取「主.次」（显示成 v1.3），理由是补丁号没信息量；但界面、安装包
 * 文件名、更新提示都带三段号，只在侧边栏少一段会让人以为装的是旧版 ——
 * 反馈「软件里看不到 v1.3.2」就是这么来的。
 */
export const VERSION_DISPLAY: string = !APP_VERSION
  ? ''
  : IS_BETA
    ? `v${VERSION_CORE} ${CHANNEL_LABEL.toLowerCase()}`
    : `v${VERSION_CORE}`;
