/**
 * 应用自动更新（electron-updater + GitHub Releases）。
 *
 * 分工：
 *   - 主进程：唯一碰网络和文件的地方。检查、下载、安装都由它做，
 *     状态通过 `update:status` 推给渲染进程；渲染进程只能「请求动作」。
 *   - 渲染进程：显示进度、让用户点按钮，不持有任何更新逻辑。
 *
 * 几个刻意的取舍：
 *   - `autoDownload = false`。85 MB 的包不该在用户不知情时下载，改成用户点
 *     「下载更新」才走；下载过程有进度、可取消。
 *   - 便携版（portable target）没有安装目录，electron-updater 无从替换文件，
 *     直接标记为不支持并给出手动下载入口，而不是让用户点了没反应。
 *   - 检查加 20 秒超时。GitHub 在国内经常连不上，electron 的 net 不设超时的话
 *     界面会一直停在「检查中…」，看起来像卡死。
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import { CancellationToken } from 'builder-util-runtime';
import * as path from 'path';
import * as fs from 'fs';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'unsupported';

export interface UpdateState {
  phase: UpdatePhase;
  /** 当前安装的版本 */
  currentVersion: string;
  /** 远端可用的版本（没有发现更新时为空串） */
  version: string;
  releaseDate: string;
  /** 已去掉 HTML 标签的更新说明，供界面直接显示 */
  releaseNotes: string;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  error: string;
  /** 上次检查完成的时间戳（秒） */
  checkedAt: number;
  /** 发现的新版本正是用户「跳过」的那个（自动检查时界面不打扰） */
  skipped: boolean;
  /** 是否具备自动更新能力（打包安装版 = true；开发模式 / 便携版 = false） */
  supported: boolean;
  /** 不支持时给用户看的原因 */
  supportHint: string;
  portable: boolean;
}

const RELEASES_URL = 'https://github.com/EXbutter/L4Director/releases';
const CHECK_TIMEOUT_MS = 20_000;
const STARTUP_CHECK_DELAY_MS = 15_000;
const REPEAT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROGRESS_THROTTLE_MS = 120;

/** 便携版：electron-builder 的 portable target 会注入这个环境变量 */
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
/** 打包安装版才有自动更新的前提；开发模式只在放了 dev-app-update.yml 时才跑 */
const IS_PACKAGED = app.isPackaged;

let supported = true;
let supportHint = '';
if (IS_PORTABLE) {
  supported = false;
  supportHint = '当前是便携版，没有安装目录可替换。请到 Release 页面下载新版。';
} else if (!IS_PACKAGED) {
  // 开发模式默认不跑更新（没有 app-update.yml），除非显式放了 dev-app-update.yml 做联调
  const devConfig = path.join(app.getAppPath(), 'dev-app-update.yml');
  supported = fs.existsSync(devConfig);
  supportHint = supported
    ? '开发模式：当前使用 dev-app-update.yml 指向的测试更新源。'
    : '开发模式不执行自动更新，只有打包后的安装版才能用。';
}

let state: UpdateState = {
  phase: supported ? 'idle' : 'unsupported',
  currentVersion: app.getVersion(),
  version: '',
  releaseDate: '',
  releaseNotes: '',
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: '',
  checkedAt: 0,
  skipped: false,
  supported,
  supportHint,
  portable: IS_PORTABLE,
};

let inited = false;
/** 下载令牌：用户点「取消下载」时 cancel()，正在跑的 downloadUpdate 会抛 CancellationError */
let downloadToken: CancellationToken | null = null;
let downloading = false;
let installing = false;
/** 用户主动点的检查忽略「跳过此版本」，自动检查才尊重它 */
let manualCheck = false;

// ---------------------------------------------------------------- 持久化

function prefsPath(): string {
  return path.join(app.getPath('userData'), 'update-prefs.json');
}

interface UpdatePrefs {
  /** 用户选择跳过的版本号，自动检查不再为它打扰 */
  skippedVersion?: string;
}

function loadPrefs(): UpdatePrefs {
  try {
    const raw = fs.readFileSync(prefsPath(), 'utf-8');
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') return p as UpdatePrefs;
  } catch {}
  return {};
}

function savePrefs(p: UpdatePrefs): void {
  try {
    fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
    fs.writeFileSync(prefsPath(), JSON.stringify(p, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Updater] 保存更新偏好失败:', e);
  }
}

// ---------------------------------------------------------------- 日志

function logFilePath(): string {
  return path.join(app.getPath('userData'), 'updater.log');
}

/** 追加一行更新日志；文件超过 256 KB 就截断重来，避免无限增长 */
function logLine(msg: string, error = false): void {
  const line = `${new Date().toISOString()} [${error ? 'ERR' : 'INF'}] ${msg}\n`;
  if (error) console.error('[Updater]', msg);
  else console.log('[Updater]', msg);
  try {
    const f = logFilePath();
    if (fs.existsSync(f) && fs.statSync(f).size > 256 * 1024) fs.writeFileSync(f, '');
    fs.appendFileSync(f, line, 'utf-8');
  } catch {
    // 日志写不进去不影响更新本身
  }
}

/** 导出日志时带上更新日志，方便判断「检查失败」到底卡在哪一步 */
export function getUpdaterLogPath(): string {
  return logFilePath();
}

// ---------------------------------------------------------------- 状态广播

function emit(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update:status', state);
  }
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  emit();
}

/** 给渲染进程 / IPC 用的只读快照 */
export function getUpdateState(): UpdateState {
  return { ...state };
}

// ---------------------------------------------------------------- 文案

/** 把 electron-updater 的英文错误翻成能照做的中文 */
function friendlyError(err: unknown): string {
  const raw = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/^Error:\s*/i, '');
  const s = raw.toLowerCase();

  if (s.includes('err_connection_refused') || s.includes('econnrefused')) {
    return '连不上更新服务器（连接被拒绝）。可能是代理设置问题，或更新源地址不可用。';
  }
  if (s.includes('err_name_not_resolved') || s.includes('enotfound') || s.includes('getaddrinfo')) {
    return '连不上 GitHub（域名解析失败）。检查网络，或开着代理再试一次。';
  }
  if (s.includes('timeout') || s.includes('timed out') || s.includes('etimedout') ||
      s.includes('err_connection_timed_out') || s.includes('err_connection_reset') ||
      s.includes('econnreset') || s.includes('err_connection_closed') ||
      s.includes('err_internet_disconnected')) {
    return '连不上 GitHub（连接超时或被重置）。国内网络常见，挂代理后重试，或直接到 Release 页面下载。';
  }
  if (s.includes('404') || s.includes('cannot find latest.yml') || s.includes('no published versions')) {
    return '更新源上还没有可用的安装包（latest.yml 缺失）。可能这个版本还没上传完，稍后再试。';
  }
  if (s.includes('app-update.yml') || s.includes('enOENT'.toLowerCase())) {
    return '当前是绿色/开发模式，缺少更新配置。请使用安装版，或到 Release 页面手动下载。';
  }
  if (s.includes('sha512') || s.includes('checksum')) {
    return '下载的安装包校验不通过，可能被网络中间层改过。请重试，或到 Release 页面手动下载。';
  }
  // 兜底：原文截断，别在界面上糊一大段堆栈
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

/** GitHub 的 release notes 是 HTML，清成纯文本给界面用 */
function cleanNotes(info: UpdateInfo): string {
  const raw = info.releaseNotes;
  if (!raw) return '';
  const html = Array.isArray(raw)
    ? raw
        .map((r) => (typeof r === 'string' ? r : r && typeof r === 'object' ? String((r as any).note ?? '') : ''))
        .join('\n')
    : String(raw);
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}

// ---------------------------------------------------------------- 核心动作

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT: 超过 ${Math.round(ms / 1000)} 秒没有响应`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** 检查更新。manual=true 时忽略「已跳过此版本」 */
export async function checkForUpdates(manual = false): Promise<UpdateState> {
  if (!supported) return getUpdateState();
  if (downloading || installing) return getUpdateState();
  if (state.phase === 'checking') return getUpdateState();

  manualCheck = manual;
  if (manual) state = { ...state, skipped: false };
  setState({ phase: 'checking', error: '' });
  logLine(`检查更新（${manual ? '手动' : '自动'}），当前版本 ${state.currentVersion}`);

  try {
    await withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS);
  } catch (e) {
    // 超时之后真实结果还可能回来并覆盖这里，这是可接受的：比起一直「检查中…」，
    // 早点告诉用户「网络不行」更有用。
    if (state.phase === 'checking') {
      const msg = friendlyError(e);
      logLine(`检查失败：${msg}（原始：${e instanceof Error ? e.message : String(e)}）`, true);
      setState({ phase: 'error', error: msg, checkedAt: Math.floor(Date.now() / 1000) });
    }
  }
  return getUpdateState();
}

/** 开始下载（仅在发现了新版本之后有意义） */
export async function downloadUpdate(): Promise<UpdateState> {
  if (!supported || downloading || installing) return getUpdateState();
  if (state.phase !== 'available' && state.phase !== 'error') return getUpdateState();
  if (!state.version) {
    // 冷启动后直接点下载（没先检查过）：先补一次检查
    await checkForUpdates(true);
    if (state.phase !== 'available') return getUpdateState();
  }

  downloading = true;
  downloadToken = new CancellationToken();
  setState({ phase: 'downloading', percent: 0, transferred: 0, total: 0, error: '' });
  logLine(`开始下载 ${state.version}`);

  try {
    await autoUpdater.downloadUpdate(downloadToken);
  } catch (e) {
    const cancelled = (e as any)?.name === 'CancellationError' || downloadToken?.cancelled === true;
    if (cancelled) {
      logLine('下载已取消');
      setState({ phase: 'available', percent: 0, transferred: 0, total: 0 });
    } else {
      const msg = friendlyError(e);
      logLine(`下载失败：${msg}`, true);
      setState({ phase: 'error', error: msg });
    }
  } finally {
    downloading = false;
    downloadToken = null;
  }
  return getUpdateState();
}

/** 取消正在进行的下载 */
export function cancelDownload(): UpdateState {
  if (!downloading || !downloadToken) return getUpdateState();
  logLine('用户请求取消下载');
  try {
    downloadToken.cancel();
  } catch (e) {
    logLine(`取消失败：${String(e)}`, true);
  }
  return getUpdateState();
}

/** 重启并安装已下载的更新 */
export function quitAndInstall(): boolean {
  if (state.phase !== 'downloaded' || installing) return false;
  installing = true;
  logLine('退出并安装更新');
  // 留一拍再退：IPC 的返回值要先回到渲染进程，否则按钮来不及变成「正在重启」
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      installing = false;
      const msg = friendlyError(e);
      logLine(`启动安装失败：${msg}`, true);
      setState({ phase: 'error', error: msg });
      return;
    }
    // quitAndInstall 不保证一定退出（用户可能取消了 UAC 之外的确认），
    // 15 秒后仍在本进程里说明没起来，把按钮还回去，别让界面卡在「正在重启」
    setTimeout(() => {
      if (installing) {
        installing = false;
        setState({ phase: 'downloaded', error: '安装程序没有启动，可以再点一次，或到 Release 页面手动下载。' });
      }
    }, 15_000);
  }, 200);
  return true;
}

/** 跳过某个版本：自动检查不再为它提示，手动检查仍能看到 */
export function skipVersion(version?: string): UpdateState {
  const v = version || state.version;
  if (!v) return getUpdateState();
  const prefs = loadPrefs();
  prefs.skippedVersion = v;
  savePrefs(prefs);
  logLine(`跳过版本 ${v}`);
  setState({ skipped: true, phase: 'up-to-date' });
  return getUpdateState();
}

/** 打开 Release 页面（下载失败或便携版时的兜底出路） */
export function openReleasesPage(): void {
  shell.openExternal(RELEASES_URL);
}

// ---------------------------------------------------------------- 事件接线

function bindEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    setState({ phase: 'checking', error: '' });
  });

  autoUpdater.on('update-available', (info) => {
    const prefs = loadPrefs();
    const skipped = !manualCheck && !!prefs.skippedVersion && prefs.skippedVersion === info.version;
    logLine(`发现新版本 ${info.version}${skipped ? '（用户已跳过）' : ''}`);
    setState({
      // 跳过的版本不再回到 available：否则界面又会展开「发现新版本」，
      // 用户点了跳过等于没跳过。version 仍留着，界面可以显示「已跳过 v1.3.0」。
      phase: skipped ? 'up-to-date' : 'available',
      version: info.version,
      releaseDate: info.releaseDate || '',
      releaseNotes: cleanNotes(info),
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      error: '',
      checkedAt: Math.floor(Date.now() / 1000),
      skipped,
    });
  });

  autoUpdater.on('update-not-available', () => {
    logLine('已是最新版本');
    setState({
      phase: 'up-to-date',
      version: '',
      releaseNotes: '',
      releaseDate: '',
      skipped: false,
      error: '',
      checkedAt: Math.floor(Date.now() / 1000),
      percent: 0,
      transferred: 0,
      total: 0,
    });
  });

  let lastProgressAt = 0;
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    // 下载分片很碎，事件非常密；节流到 ~8 次/秒，够顺滑也不刷爆 IPC
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_THROTTLE_MS && p.percent < 100) return;
    lastProgressAt = now;
    setState({
      phase: 'downloading',
      percent: Math.max(0, Math.min(100, p.percent || 0)),
      transferred: p.transferred || 0,
      total: p.total || 0,
      bytesPerSecond: p.bytesPerSecond || 0,
      error: '',
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    logLine(`下载完成 ${info.version}，等待用户重启安装`);
    setState({
      phase: 'downloaded',
      version: info.version,
      percent: 100,
      transferred: state.total,
      error: '',
    });
  });

  autoUpdater.on('error', (err) => {
    // 下载中取消会走到这里（electron-updater 把 CancellationError 也当 error 发），
    // 那不是故障，别在界面上写成红色错误
    const cancelled = (err as any)?.name === 'CancellationError';
    if (cancelled) {
      logLine('下载已取消（事件）');
      setState({ phase: 'available', percent: 0, transferred: 0, total: 0 });
      return;
    }
    if (downloading) return; // downloadUpdate 的 catch 会统一处理，避免重复提示
    const msg = friendlyError(err);
    logLine(`更新出错：${msg}（原始：${err?.message || err}）`, true);
    setState({ phase: 'error', error: msg, checkedAt: Math.floor(Date.now() / 1000) });
  });
}

// ---------------------------------------------------------------- IPC

export function initUpdater(): void {
  if (inited) return;
  inited = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // 开发模式下 electron-updater 默认拒绝工作（没有 app-update.yml），
  // 联调时靠 dev-app-update.yml 显式打开
  autoUpdater.forceDevUpdateConfig = !IS_PACKAGED && supported;
  // 预发布版本（1.2.0-beta.x）要能看到 beta 发布，正式版只收正式发布
  autoUpdater.allowPrerelease = /-(beta|alpha|rc)/i.test(app.getVersion());
  autoUpdater.logger = {
    info: (m: string) => logLine(String(m)),
    warn: (m: string) => logLine(String(m)),
    error: (m: string) => logLine(String(m), true),
    debug: () => {},
  };

  bindEvents();

  ipcMain.handle('update:getState', () => getUpdateState());
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.handle('update:cancel', () => cancelDownload());
  ipcMain.handle('update:install', () => quitAndInstall());
  ipcMain.handle('update:skip', (_e, version?: string) => skipVersion(version));
  ipcMain.handle('update:openReleases', () => openReleasesPage());

  if (!supported) {
    logLine(`自动更新不可用：${supportHint}`);
    return;
  }

  // 启动后延迟检查：别和首屏、后端启动抢资源，也避免用户刚打开就被弹窗打断
  setTimeout(() => {
    if (state.phase === 'idle') void checkForUpdates(false);
  }, STARTUP_CHECK_DELAY_MS);

  setInterval(() => {
    // 正在下载或已下载待安装时不再重复检查
    if (downloading || installing) return;
    if (state.phase === 'downloaded') return;
    void checkForUpdates(false);
  }, REPEAT_CHECK_INTERVAL_MS);

  logLine(`更新模块就绪，当前版本 ${state.currentVersion}，允许预发布 ${autoUpdater.allowPrerelease}`);
}
