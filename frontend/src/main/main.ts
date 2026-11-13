import { app, BrowserWindow, ipcMain, dialog, shell, session, Menu, MenuItem } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { createZip, ZipEntry } from './zip';
import { importDroppedVpks } from './vpkImport';
import { initUpdater, getUpdateState, getUpdaterLogPath } from './updater';

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;

// ============ 启动性能计时（加载速度基准 / 排障） ============
// 记录 Electron 主进程从启动到各关键里程碑的耗时，写入
// userData/startup-perf.json（保留最近 20 次），并随「导出日志」一起打包。
// 环境变量 L4DIRECTOR_PERF_OUT 可指定输出文件（供 scripts/bench-startup.mjs 使用）。
const processStartTime = Date.now() - process.uptime() * 1000;
const startupMarks: Record<string, number> = {};
const rendererPerf: Record<string, Record<string, any>> = {};
const PERF_HISTORY_LIMIT = 20;

/** 记录一个启动里程碑（距进程启动的毫秒数），重复调用只记第一次 */
function markStartup(name: string): number {
  const existing = startupMarks[name];
  if (existing !== undefined) return existing;
  const ms = Math.round(Date.now() - processStartTime);
  startupMarks[name] = ms;
  console.log(`[Perf] ${name}: ${ms} ms`);
  return ms;
}

/** 汇总当前这次启动的性能数据 */
function buildStartupPerf(): Record<string, any> {
  return {
    generated_at: new Date().toISOString(),
    app_version: app.getVersion(),
    packaged: app.isPackaged,
    process_started_at: new Date(processStartTime).toISOString(),
    port: activeBackendPort,
    milestones_ms: { ...startupMarks },
    renderer: { ...rendererPerf },
  };
}

function getPerfFilePath(): string {
  return process.env.L4DIRECTOR_PERF_OUT || path.join(app.getPath('userData'), 'startup-perf.json');
}

/** 读取已落盘的历史（不存在或损坏时返回 null） */
function readPerfHistory(): { last: Record<string, any>; history: Record<string, any>[] } | null {
  try {
    const raw = fs.readFileSync(getPerfFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.history)) return parsed;
  } catch {}
  return null;
}

/** 落盘：把本次启动的数据追加进历史（同一进程内重复调用只更新最后一条） */
function persistStartupPerf(): void {
  try {
    if (Object.keys(startupMarks).length === 0 && Object.keys(rendererPerf).length === 0) return;
    const current = buildStartupPerf();
    let history = readPerfHistory()?.history ?? [];
    const last = history[history.length - 1];
    if (last && last.process_started_at === current.process_started_at) {
      history[history.length - 1] = current;
    } else {
      history.push(current);
    }
    if (history.length > PERF_HISTORY_LIMIT) history = history.slice(-PERF_HISTORY_LIMIT);
    const file = getPerfFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ last: current, history }, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Perf] Failed to persist startup perf:', e);
  }
}

/**
 * 基准测试模式：设置 L4DIRECTOR_BENCH_AUTOQUIT（毫秒）后，
 * 在指定里程碑到达（默认 scan-done，可用 L4DIRECTOR_BENCH_QUIT_ON=shell 改为渲染完成即退出）
 * 后自动退出，便于 bench-startup.mjs 反复测量。
 */
function maybeBenchAutoQuit(event: string): void {
  const autoQuit = process.env.L4DIRECTOR_BENCH_AUTOQUIT;
  if (!autoQuit) return;
  const quitOn = process.env.L4DIRECTOR_BENCH_QUIT_ON === 'shell' ? 'renderer-ready' : 'scan-done';
  if (event !== quitOn) return;
  const delay = Number(autoQuit);
  console.log(`[Perf] Bench auto-quit in ${Number.isFinite(delay) ? delay : 500} ms (on ${event})`);
  setTimeout(() => {
    persistStartupPerf();
    app.quit();
  }, Number.isFinite(delay) ? delay : 500);
}
// ========================================

// 后端实际监听端口：默认 8288。若该端口被其他程序占用，会自动改用备用端口，
// 并通过 'backend:info' 事件通知渲染进程切换 API 地址。
let activeBackendPort = 8288;

// ============ GPU 硬件加速设置 ============
function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig(): Record<string, any> {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (e) {
    console.error('[Config] Failed to load config:', e);
  }
  return {};
}

function saveConfig(config: Record<string, any>): void {
  try {
    const configPath = getConfigPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Config] Failed to save config:', e);
  }
}

// 在 app ready 之前加载 GPU 加速配置
const config = loadConfig();
const gpuAccelerationDisabled = config.gpuAccelerationDisabled === true;

if (gpuAccelerationDisabled) {
  app.disableHardwareAcceleration();
  console.log('[GPU] Hardware acceleration disabled via config');
} else {
  console.log('[GPU] Hardware acceleration enabled (default)');
}
// ========================================

// ============ 界面缩放（解决「字体太小/发虚」） ============
// 用户反馈界面文字偏小、发虚。这里用 Chromium 自己的缩放（webContents.setZoomFactor）：
// 它会让页面按缩放后的设备像素**重新光栅化**（不是把已有位图拉大），
// 因此字与图标都会更清楚，比单独调大字号更有效。
// 默认 110%，用户可在「设置 → 界面缩放」里调。
const UI_SCALE_MIN = 0.8;
const UI_SCALE_MAX = 2.0;
const DEFAULT_UI_SCALE = 1.1;

function normalizeUiScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_UI_SCALE;
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n));
  return Math.round(clamped * 100) / 100;
}

/** 当前生效的界面缩放（读配置文件，缺省 110%） */
function currentUiScale(): number {
  return normalizeUiScale(loadConfig().uiScale ?? DEFAULT_UI_SCALE);
}
// ========================================

// ============ 窗口底色（不透明窗口） ============
// 不透明窗口的边缘颜色：与渲染进程的 --bg-primary-solid 对应，
// 主题切换时由渲染进程通过 ui:setWindowTheme 同步，避免窗口边框与界面主题“撞色”。
// 启动时先按上次保存的主题设置，避免先亮后暗（或反之）闪一下。
const WINDOW_BG_COLORS: Record<'light' | 'dark', string> = {
  light: '#eef4fb',
  dark: '#0d1b2a',
};
// ========================================

// 渲染进程上报的性能里程碑（首屏渲染完成 / 首个 Mod 出现 / 扫描完成）
// 渲染进程的 performance.now() 是「距导航开始」的毫秒数，据此换算成「距进程启动」
ipcMain.on('perf:mark', (_event, name: string, payload?: Record<string, any>) => {
  if (typeof name !== 'string' || !name) return;
  const data = payload || {};
  const now = Date.now();
  const elapsed = typeof data.elapsed === 'number' ? data.elapsed : null;
  // 里程碑时刻 = 现在（IPC 延迟可忽略）；renderer_elapsed 是渲染进程自己的 performance.now()
  // renderer_nav_start = 渲染进程时间轴的起点（页面导航开始）相对进程启动的偏移
  rendererPerf[name] = {
    since_process_start_ms: Math.round(now - processStartTime),
    renderer_elapsed_ms: elapsed,
    renderer_nav_start_ms: elapsed === null ? null : Math.round(now - processStartTime - elapsed),
    ...data,
  };
  console.log(
    `[Perf] renderer:${name} = ${rendererPerf[name].since_process_start_ms} ms` +
      (elapsed === null ? '' : ` (renderer ${elapsed} ms)`)
  );
  if (name === 'renderer-ready' || name === 'scan-done') persistStartupPerf();
  maybeBenchAutoQuit(name);
});

ipcMain.handle('perf:get', () => buildStartupPerf());

/**
 * 抓取当前窗口画面（主题切换交叉淡入用）。
 * 返回 JPEG data URL（体积远小于 PNG，几百 KB 级），失败返回 null（渲染进程会退回瞬时切换）。
 */
ipcMain.handle('theme:captureSnapshot', async () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const image = await mainWindow.webContents.capturePage();
    if (image.isEmpty()) return null;
    return `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`;
  } catch (e) {
    console.error('[Theme] capture snapshot failed:', e);
    return null;
  }
});

function createWindow() {
  // 窗口改为**不透明**（不再用 transparent）：
  //   * 透明窗口会强制 Chromium 走灰度抗锯齿，中文小字发虚（Windows 下拿不到 ClearType）；
  //   * 透明窗口为了画「窗口外阴影」必须在四周留白，最大化时那圈留白就成了透明缝隙，
  //     看起来像「内容不在窗口里 / 显示的边框和实际窗口边界不统一」。
  // 不透明窗口下内容边界 = 窗口边界，文字恢复亚像素渲染；圆角交给系统（Win11）。
  const windowTheme: 'light' | 'dark' = loadConfig().windowTheme === 'dark' ? 'dark' : 'light';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    transparent: false,
    backgroundColor: WINDOW_BG_COLORS[windowTheme],
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      webSecurity: false,
    },
    show: false,
  });
  markStartup('window-created');

  // 应用界面缩放：必须在 loadURL/loadFile 之前设置，首屏就按缩放后的像素渲染
  // （放在加载之后设置会看到一次「先小后大」的跳变）
  mainWindow.webContents.setZoomFactor(currentUiScale());

  // 允许拖放文件到窗口（默认 Electron 禁止外部文件拖放）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow drag and drop of files
    if (url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  // 确保 webContents 允许文件拖放
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: 'deny' };
  });

  // 启用文件拖放支持
  // Note: Electron 在 contextIsolation 下默认阻止拖放文件，
  // 我们需要在 webContents 上明确允许
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  // 窗口居中并渐入显示
  mainWindow.center();
  mainWindow.once('ready-to-show', () => {
    markStartup('window-shown');
    mainWindow?.show();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    markStartup('renderer-loaded');
  });

  // 开发模式加载 Vite 开发服务器
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  // 开发模式不再自动打开 DevTools（会拖慢启动）；需要时按 F12 手动切换
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // 窗口控制 IPC
  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('window:close', () => {
    mainWindow?.close();
  });

  // 打开外部链接（用于 Steam 登录）
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  // 文件夹选择对话框
  ipcMain.handle('dialog:selectFolder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择 Left 4 Dead 2 addons 文件夹',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // 设置代理
  ipcMain.handle('proxy:set', async (_event, host: string, port: string) => {
    try {
      const proxyRules = host && port ? `http=${host}:${port};https=${host}:${port}` : '';
      // Apply to the default session (for main window) and the workshop partition
      const s = session.fromPartition('persist:steamworkshop');
      if (proxyRules) {
        await s.setProxy({ proxyRules, proxyBypassRules: '127.0.0.1;localhost;192.168.*;10.*;172.16.*' });
        console.log(`[Proxy] Set proxy: ${proxyRules}`);
      } else {
        await s.setProxy({ proxyRules: '' });
        console.log('[Proxy] Cleared proxy');
      }
      return true;
    } catch (e) {
      console.error('[Proxy] Error:', e);
      return false;
    }
  });

  // ============ GPU 加速设置 IPC ============
  ipcMain.handle('gpu:getStatus', async () => {
    return { gpuAccelerationDisabled: loadConfig().gpuAccelerationDisabled === true };
  });

  ipcMain.handle('gpu:setAcceleration', async (_event, disabled: boolean) => {
    try {
      const currentConfig = loadConfig();
      currentConfig.gpuAccelerationDisabled = disabled;
      saveConfig(currentConfig);
      console.log(`[GPU] Hardware acceleration config set to: ${disabled ? 'disabled' : 'enabled'}`);
      return { success: true };
    } catch (e) {
      console.error('[GPU] Failed to set acceleration:', e);
      return { success: false, error: String(e) };
    }
  });
  // ========================================

  // ============ 界面缩放 IPC ============
  ipcMain.handle('ui:getScale', async () => ({ scale: currentUiScale() }));

  ipcMain.handle('ui:setScale', async (_event, scale: number) => {
    try {
      const next = normalizeUiScale(scale);
      const cfg = loadConfig();
      cfg.uiScale = next;
      saveConfig(cfg);
      mainWindow?.webContents.setZoomFactor(next);
      console.log(`[UI] Zoom factor set to ${next}`);
      return { success: true, scale: next };
    } catch (e: any) {
      console.error('[UI] Failed to set zoom factor:', e);
      return { success: false, scale: currentUiScale(), error: e?.message || String(e) };
    }
  });
  // ========================================

  // ============ 窗口底色（不透明窗口，跟随主题）============
  ipcMain.handle('ui:setWindowTheme', async (_event, theme: string) => {
    try {
      const next: 'light' | 'dark' = theme === 'light' ? 'light' : 'dark';
      mainWindow?.setBackgroundColor(WINDOW_BG_COLORS[next]);
      const cfg = loadConfig();
      cfg.windowTheme = next;
      saveConfig(cfg);
      console.log(`[UI] Window background color set to ${WINDOW_BG_COLORS[next]} (${next})`);
      return { success: true, theme: next };
    } catch (e: any) {
      console.error('[UI] Failed to set window background color:', e);
      return { success: false, theme: 'dark', error: e?.message || String(e) };
    }
  });
  // ========================================

  // ============ 清除 webview session cookie ============
  ipcMain.handle('session:clearWorkshopCookies', async () => {
    try {
      const s = session.fromPartition('persist:steamworkshop');
      await s.clearStorageData({
        storages: ['cookies', 'localstorage'],
      });
      console.log('[Session] Cleared workshop session cookies');
      return true;
    } catch (e) {
      console.error('[Session] Failed to clear cookies:', e);
      return false;
    }
  });
  // ========================================

  // ============ 拖放导入 .vpk 文件 IPC ============
  // 实现在 vpkImport.ts：复制 vpk 的同时带上同名封面图，并按内容哈希拦掉重复 Mod。
  ipcMain.handle('file:importDroppedVpks', async (_event, filePaths: string[], addonsPath: string) => {
    return importDroppedVpks(filePaths, addonsPath);
  });
  // ========================================

  // ============ 原生右键菜单 IPC ============
  ipcMain.handle('menu:showContextMenu', async (_event, options: {
    x: number;
    y: number;
    modName: string;
    items: Array<{
      label: string;
      type?: string;
      click?: string;
      submenu?: Array<{ label: string; type?: string; click?: string }>;
    }>;
  }) => {
    if (!mainWindow) return;

    const buildMenu = (items: typeof options.items): Menu => {
      const menu = new Menu();
      for (const item of items) {
        if (item.type === 'separator') {
          menu.append(new MenuItem({ type: 'separator' }));
        } else if (item.submenu && item.submenu.length > 0) {
          const subMenu = new Menu();
          for (const sub of item.submenu) {
            if (sub.type === 'separator') {
              subMenu.append(new MenuItem({ type: 'separator' }));
            } else {
              subMenu.append(new MenuItem({
                label: sub.label,
                click: () => {
                  if (sub.click && mainWindow) {
                    mainWindow.webContents.send('menu:itemClicked', {
                      action: sub.click,
                      modName: options.modName,
                    });
                  }
                },
              }));
            }
          }
          menu.append(new MenuItem({
            label: item.label,
            submenu: subMenu,
          }));
        } else {
          menu.append(new MenuItem({
            label: item.label,
            click: () => {
              if (item.click && mainWindow) {
                mainWindow.webContents.send('menu:itemClicked', {
                  action: item.click,
                  modName: options.modName,
                });
              }
            },
          }));
        }
      }
      return menu;
    };

    const menu = buildMenu(options.items);
    // 界面缩放（zoom factor）会把页面的 CSS 像素放大：渲染进程传来的是 CSS 坐标，
    // 而原生菜单用的是窗口 DIP 坐标，必须乘上 zoom factor，
    // 否则菜单会跑到鼠标左上方，缩放越大偏得越多。
    const zoom = mainWindow.webContents.getZoomFactor() || 1;
    menu.popup({
      window: mainWindow,
      x: Math.round(options.x * zoom),
      y: Math.round(options.y * zoom),
    });
  });
  // ========================================

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized', false);
  });
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('net') as typeof import('net');
    const server = net.createServer();
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

// ===================== 后端日志落盘（用于“无法连接后端”时诊断与导出） =====================
function getBackendLogFile(): string {
  const dir = path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return path.join(dir, 'backend.log');
}

function resetBackendLog(): void {
  try { fs.writeFileSync(getBackendLogFile(), ''); } catch { /* ignore */ }
}

function appendBackendLog(text: string): void {
  try { fs.appendFileSync(getBackendLogFile(), text); } catch { /* ignore */ }
}

/** 把后端实际使用的端口告知渲染进程，便于前端切换 API 地址。 */
function notifyBackendPort(port: number): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend:info', { port });
  }
}

// push 版有竞态：后端在渲染进程挂载出监听器之前就启动完毕时，这条消息会直接丢掉，
// 前端就永远停在默认的 8288（若 8288 被旧版占用，界面会一直读到旧数据）。
// 补一个拉取版：渲染进程挂载时主动问一次当前端口。
ipcMain.handle('backend:getPort', () => activeBackendPort);

/** 单次探测某个端口上的后端是否健康（不轮询）。 */
function probeBackendHealth(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const http = require('http') as typeof import('http');
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

/** 读取文件文本；超过 maxBytes 只保留文件尾部（日志可能很大）。 */
function readTextFileTail(filePath: string, maxBytes = 5 * 1024 * 1024): string | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, Math.max(0, stat.size - maxBytes));
    fs.closeSync(fd);
    return buf.toString('utf-8', 0, read);
  } catch (e) {
    return `[Error reading ${filePath}: ${e}]`;
  }
}

/** 收集本机日志与诊断信息（不依赖后端进程是否存活）。 */
function collectDiagnostics(): ZipEntry[] {
  const now = new Date();
  const entries: ZipEntry[] = [];
  const projectRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', '..');
  const backendDir = path.join(projectRoot, 'backend');

  const systemInfo: Record<string, any> = {
    app_version: app.getVersion(),
    packaged: app.isPackaged,
    os_type: os.type(),
    os_release: os.release(),
    os_platform: os.platform(),
    os_arch: os.arch(),
    hostname: os.hostname(),
    user_data_dir: app.getPath('userData'),
    resources_dir: app.isPackaged ? process.resourcesPath : undefined,
    backend_port: activeBackendPort,
    timestamp: now.toISOString(),
  };
  entries.push({ name: 'system_info.json', data: JSON.stringify(systemInfo, null, 2) });

  // 主进程捕获的后端 stdout/stderr（后端启动失败时这里会有具体报错）
  const backendLog = getBackendLogFile();
  entries.push({ name: 'backend.log', data: readTextFileTail(backendLog) ?? '[No backend.log]' });

  // 后端目录内的 backend_output.log（由 launch_backend.vbs / 手动运行时生成）
  const backendOutput = path.join(backendDir, 'backend_output.log');
  entries.push({ name: 'backend_output.log', data: readTextFileTail(backendOutput) ?? '[No backend_output.log]' });

  // 开发/启动脚本产生的日志（不存在则忽略）
  for (const devFile of ['debug.log', 'vite.log', 'electron.log']) {
    const fp = path.join(projectRoot, 'frontend', devFile);
    const data = readTextFileTail(fp);
    if (data) entries.push({ name: `frontend/${devFile}`, data });
  }

  // 用户配置
  const cfg = path.join(app.getPath('userData'), 'config.json');
  const cfgData = readTextFileTail(cfg);
  if (cfgData) entries.push({ name: 'config.json', data: cfgData });

  // 自动更新日志（检查/下载卡在哪一步，看这个最快）
  const updaterLog = readTextFileTail(getUpdaterLogPath());
  if (updaterLog) entries.push({ name: 'updater.log', data: updaterLog });
  entries.push({
    name: 'update_state.json',
    data: JSON.stringify(getUpdateState(), null, 2),
  });

  // 启动性能数据（加载速度排障：各里程碑耗时 + 前端首屏/首个 Mod/扫描完成时间）
  try {
    const filePerf = readPerfHistory();
    const perfData = filePerf ?? { last: buildStartupPerf(), history: [] };
    entries.push({ name: 'startup_perf.json', data: JSON.stringify(perfData, null, 2) });
  } catch (e) {
    entries.push({ name: 'startup_perf.json', data: `[Error collecting startup perf: ${e}]` });
  }

  return entries;
}

// 导出日志：完全由主进程本地完成，后端未启动/连不上时也可用
ipcMain.handle('logs:export', async () => {
  try {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const defaultPath = path.join(app.getPath('downloads'), `L4Director_logs_${stamp}.zip`);
    const result = await dialog.showSaveDialog({
      title: '导出日志',
      defaultPath,
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }
    const zip = createZip(collectDiagnostics());
    fs.writeFileSync(result.filePath, zip);
    console.log(`[Logs] Exported diagnostics to ${result.filePath}`);
    return { ok: true, path: result.filePath };
  } catch (e) {
    console.error('[Logs] Export failed:', e);
    return { ok: false, error: String(e) };
  }
});
// =====================================================================================

// 供渲染进程在“无法连接后端”时手动请求重启后端（例如杀毒软件首启拦截后再次尝试）
ipcMain.handle('backend:restart', async () => {
  console.log('[Backend] Restart requested by renderer');
  try {
    if (backendProcess && !backendProcess.killed) {
      backendProcess.kill();
    }
    backendProcess = null;
    // 等待进程退出、端口释放
    await new Promise((r) => setTimeout(r, 800));
    startBackend();
    return { ok: true };
  } catch (e) {
    console.error('[Backend] Restart failed:', e);
    return { ok: false, error: String(e) };
  }
});

/**
 * 冷启动兜底：重启电脑后的第一次启动、或杀毒软件首次扫描内置 Python 时，
 * 后端可能要几十秒才能就绪。此处在后台持续探测，一旦就绪立即通知渲染进程，
 * 用户无需重启软件（旧版本在这里直接放弃，表现为“第一次连不上、再开一次才行”）。
 */
async function keepProbingBackend(
  port: number,
  onReady: () => void,
  totalTimeoutMs = 180000,
  intervalMs = 3000
): Promise<void> {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (await probeBackendHealth(port, 2000)) {
      console.log(`[Backend] Backend became ready after extra probing (port ${port})`);
      onReady();
      return;
    }
  }
  console.warn(`[Backend] Backend still not ready after ${totalTimeoutMs} ms of probing`);
}

async function startBackend() {
  // 开发模式: __dirname = frontend/dist/main, 项目根目录 = path.join(__dirname, '../../..')
  // 打包模式: process.resourcesPath = 资源目录(含backend/)
  const projectRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', '..');
  const backendPath = path.join(projectRoot, 'backend', 'main.py');
  const backendDir = path.join(projectRoot, 'backend');

  // 若 8288 上已经有一个“健康的 L4Director 后端”（例如 ld.ps1 已先行启动），直接复用，
  // 避免重复启动造成端口冲突。
  //
  // 但开发模式**不能**复用：用户机器上很可能开着「已安装的旧版」L4Director，
  // 它的后端同样监听 8288 且健康检查通过，复用就会让开发窗口读到旧代码的结果
  // （改了后端却看不到任何变化，非常难排查）。开发模式一律起自己的后端，
  // 8288 被占用时下面的循环会自动换到 8289+。
  const existingHealthy = app.isPackaged && await probeBackendHealth(8288, 1500);
  if (existingHealthy) {
    console.log('[Backend] A healthy L4Director backend is already running on 8288');
    console.log('[Backend] Skipping backend startup, connecting to existing instance');
    activeBackendPort = 8288;
    markStartup('backend-ready');
    notifyBackendPort(activeBackendPort);
    return;
  }

  // 8288 可能被其他程序/残留进程占用（普通用户机器上较常见）。
  // 自动尝试 8288~8299 之间第一个空闲端口；若 8288 空闲则仍使用 8288。
  let port = 8288;
  for (let p = 8288; p <= 8299; p++) {
    if (!(await isPortInUse(p))) {
      port = p;
      break;
    }
  }
  activeBackendPort = port;
  if (port !== 8288) {
    console.warn(`[Backend] Port 8288 is occupied by another program, will use port ${port} instead`);
  } else {
    console.log(`[Backend] Port 8288 is free, will listen on ${port}`);
  }
  
  // 查找可用的 Python 可执行文件路径
  function findPython(): string | null {
    // 0. 检查打包的嵌入式 Python（优先使用）
    const embeddedPython = path.join(projectRoot, 'backend', 'embedded_python', 'python.exe');
    if (fs.existsSync(embeddedPython)) {
      console.log(`[Backend] Found embedded Python: ${embeddedPython}`);
      return embeddedPython;
    }

    // 1. 检查项目虚拟环境（开发模式）
    const venvPython = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venvPython)) {
      console.log(`[Backend] Found venv Python: ${venvPython}`);
      return venvPython;
    }
    
    // 2. 从 Windows 注册表查找 Python 安装路径
    try {
      const { execFileSync } = require('child_process') as typeof import('child_process');
      // 使用 py.exe 的 --list-paths 来获取所有 Python 安装
      const pyOutput = execFileSync('py', ['--list-paths'], { encoding: 'utf8', timeout: 5000 });
      // 输出格式类似:  -3.13         C:\Program Files\Python313\python.exe *
      const lines = pyOutput.split('\n');
      for (const line of lines) {
        const match = line.match(/([A-Z]:\\[^\s]+?python\.exe)/i);
        if (match && fs.existsSync(match[1])) {
          console.log(`[Backend] Found Python via py --list-paths: ${match[1]}`);
          return match[1];
        }
      }
    } catch {
      console.log('[Backend] py --list-paths not available, trying other methods');
    }

    // 3. 从注册表读取 Python 安装路径
    try {
      const { execFileSync } = require('child_process') as typeof import('child_process');
      // 使用 reg query 读取当前用户的 Python 安装
      const regOutput = execFileSync('reg', [
        'query', 'HKCU\\SOFTWARE\\Python\\ContinuumAnalytics\\', '/s', '/v', 'SysExecutable'
      ], { encoding: 'utf8', timeout: 5000 });
      const lines = regOutput.split('\n');
      for (const line of lines) {
        const match = line.match(/([A-Z]:\\[^\s]+?python\.exe)/i);
        if (match && fs.existsSync(match[1])) {
          console.log(`[Backend] Found Python via registry: ${match[1]}`);
          return match[1];
        }
      }
    } catch {
      console.log('[Backend] Registry query failed, trying common paths');
    }

    // 4. 检查常见 Python 安装路径（动态检测常见版本号）
    const commonPaths: string[] = [];
    const programFiles = [
      process.env.PROGRAMFILES || 'C:\\Program Files',
      process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
    ];
    const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local';
    
    // 生成 Python 3.x 的常见路径
    for (const pf of programFiles) {
      for (let v = 13; v >= 8; v--) {
        for (let sub = 0; sub <= 20; sub++) {
          commonPaths.push(`${pf}\\Python3${v}\\python.exe`);
        }
      }
    }
    // 用户目录下安装的 Python
    for (let v = 14; v >= 8; v--) {
      commonPaths.push(`${localAppData}\\Programs\\Python\\Python3${v}\\python.exe`);
      commonPaths.push(`${localAppData}\\Programs\\Python\\Python${v}-32\\python.exe`);
    }
    // Microsoft Store 安装的 Python
    commonPaths.push(`${localAppData}\\Microsoft\\WindowsApps\\python.exe`);
    commonPaths.push(`${localAppData}\\Microsoft\\WindowsApps\\python3.exe`);
    
    for (const pyPath of commonPaths) {
      if (fs.existsSync(pyPath)) {
        console.log(`[Backend] Found system Python: ${pyPath}`);
        return pyPath;
      }
    }
    
    // 5. 尝试通过环境变量 PATH 查找
    const pathEnv = process.env.PATH || '';
    const pathDirs = pathEnv.split(path.delimiter);
    for (const dir of pathDirs) {
      try {
        const pythonExe = path.join(dir, 'python.exe');
        if (fs.existsSync(pythonExe)) {
          console.log(`[Backend] Found PATH Python: ${pythonExe}`);
          return pythonExe;
        }
      } catch {
        // Skip invalid paths
      }
    }
    
    return null;
  }
  
  // 健康检查函数：等待后端就绪
  function waitForBackend(url: string, timeoutMs: number = 15000): Promise<boolean> {
    return new Promise((resolve) => {
      const http = require('http') as typeof import('http');
      const startTime = Date.now();
      
      const check = () => {
        if (Date.now() - startTime > timeoutMs) {
          resolve(false);
          return;
        }
        
        const req = http.get(url, (res) => {
          if (res.statusCode === 200) {
            resolve(true);
          } else {
            setTimeout(check, 500);
          }
        });
        req.on('error', () => {
          setTimeout(check, 500);
        });
        req.setTimeout(2000, () => {
          req.destroy();
          setTimeout(check, 500);
        });
      };
      
      check();
    });
  }
  
  // 弹出对话框告知用户 Python 缺失
  async function showPythonMissingDialog(): Promise<void> {
    const { dialog } = require('electron') as typeof import('electron');
    await dialog.showMessageBox({
      type: 'error',
      title: '无法启动后端服务',
      message: '未检测到 Python 运行环境',
      detail: 'L4Director 需要 Python 来运行后端服务。\n\n' +
        '请选择以下方式之一：\n' +
        '1. 从 https://www.python.org/downloads/ 安装 Python（勾选 "Add Python to PATH"）\n' +
        '2. 使用命令行手动启动后端：\n' +
        '   cd backend && python main.py\n\n' +
        '若问题依旧，可在“设置 - 导出日志”中导出日志后反馈给开发者。',
      buttons: ['知道了'],
    });
  }
  
  // 弹出对话框告知用户后端启动失败
  async function showBackendStartFailedDialog(): Promise<void> {
    const { dialog } = require('electron') as typeof import('electron');
    await dialog.showMessageBox({
      type: 'error',
      title: '后端服务启动失败',
      message: '后端 Python 服务未能正常启动',
      detail: '软件已自动尝试 8288~8299 端口。请检查：\n' +
        '1. 是否被杀毒软件 / Windows Defender 拦截了内置 Python\n' +
        '2. 是否缺少 Visual C++ 运行库\n\n' +
        '启动日志已自动保存，可在“设置 - 导出日志”中导出后反馈给开发者。',
      buttons: ['知道了'],
    });
  }
  
  const pythonExe = findPython();
  
  if (!pythonExe) {
    console.error('[Backend] Could not find any Python installation');
    console.error('[Backend] Please ensure Python is installed or start backend manually:');
    console.error(`[Backend] cd "${backendDir}" && python main.py --port 8288`);
    
    // 显示 Python 缺失对话框（仅在打包模式下，开发模式还是只打印日志）
    if (app.isPackaged) {
      showPythonMissingDialog();
    }
    return;
  }
  
  console.log(`[Backend] Starting Python backend: ${pythonExe}`);

  // 每次启动后端前清空日志，保留本次启动的关键信息
  resetBackendLog();

  backendProcess = spawn(pythonExe, [backendPath, '--port', String(port)], {
    cwd: backendDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 把应用版本传给后端，让它导出的 system_info.json 与 package.json 保持一致
    env: { ...process.env, L4DIRECTOR_APP_VERSION: app.getVersion() },
  });
  markStartup('backend-spawned');

  let backendStarted = false;

  const handleOutput = (data: Buffer, isError: boolean) => {
    const msg = data.toString();
    const stamp = new Date().toISOString();
    appendBackendLog(`[${stamp}] ${isError ? '[ERR]' : '[OUT]'} ${msg}`);
    if (isError) {
      console.error(`[Backend Error] ${msg}`);
    } else {
      console.log(`[Backend] ${msg}`);
    }
    // 检测后端是否已启动（uvicorn 会输出 "Uvicorn running on"）
    if (msg.includes('Uvicorn running on') || msg.includes('Application startup complete')) {
      backendStarted = true;
    }
  };

  if (backendProcess.stdout) {
    backendProcess.stdout.on('data', (data: Buffer) => handleOutput(data, false));
  }

  if (backendProcess.stderr) {
    backendProcess.stderr.on('data', (data: Buffer) => handleOutput(data, true));
  }

  backendProcess.on('error', async (err: Error) => {
    console.error(`[Backend] Failed to start: ${err.message}`);
    appendBackendLog(`[${new Date().toISOString()}] [ERR] Failed to start: ${err.message}\n`);
    if (app.isPackaged) {
      await showBackendStartFailedDialog();
    }
  });

  backendProcess.on('close', async (code: number | null) => {
    console.log(`[Backend] Process exited with code ${code}`);
    if (code !== 0 && code !== null && app.isPackaged && !backendStarted) {
      // 非正常退出且后端未启动成功过 -> 提示用户（日志已保存，可在“设置 - 导出日志”中导出）
      await showBackendStartFailedDialog();
    }
  });

  // 等待后端就绪（最多等 20 秒；较慢的电脑 / 杀毒软件首次扫描可能耗时更久）
  // 就绪后统一走这里：记录里程碑 + 通知渲染进程端口与就绪事件
  const notifyBackendReadyNow = () => {
    markStartup('backend-ready');
    notifyBackendPort(port);
    if (mainWindow) {
      mainWindow.webContents.send('backend:ready', true);
    }
  };

  // 首次等待放宽到 45 秒：冷启动（重启电脑后的第一次 / 杀软首次扫描内置 Python）经常超过 20 秒。
  // 若仍然超时，则转入后台继续探测（最多再等 3 分钟），一旦就绪自动通知渲染进程，
  // 避免出现“第一次连不上，必须重启软件才连上”。
  // 调试/测试可用 L4DIRECTOR_BACKEND_WAIT_MS 覆盖首等时间。
  const envWait = Number(process.env.L4DIRECTOR_BACKEND_WAIT_MS);
  const firstWaitMs = Number.isFinite(envWait) && envWait > 0 ? envWait : 45000;
  const ready = await waitForBackend(`http://127.0.0.1:${port}/api/health`, firstWaitMs);
  if (ready) {
    console.log(`[Backend] Backend is ready on port ${port}!`);
    notifyBackendReadyNow();
  } else {
    console.warn(`[Backend] Backend health check timed out (port ${port}), keep probing in background...`);
    void keepProbingBackend(port, notifyBackendReadyNow);
    if (app.isPackaged && !backendStarted) {
      await showBackendStartFailedDialog();
    }
  }
}

// ============ 单实例 ============
// data_store 的写盘锁是进程内 threading.Lock，挡不住第二次启动的进程：
// 两个实例各持一份内存缓存，先后落盘会互相覆盖（A 改完合辑，B 退出时按自己的旧缓存写一遍就抹掉了）。
// 端口也会打架：8288 被先启动的实例占着，后启动的会切到备用端口，于是两个窗口连着两个后端、
// 看到的是两份数据 —— 用户会以为「我的改动丢了」。所以第二个实例把已有窗口拉到前面，然后自己退出。
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    markStartup('app-ready');
    createWindow();

    // 启动后端 Python 服务
    startBackend();

    // 自动更新：挂好 IPC 与事件，内部会延迟 15 秒才做第一次检查，不抢启动资源
    initUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // 退出前落盘启动性能数据（供加载速度排障/基准测试读取）
  // 拿不到单实例锁的那个进程只是来「唤起已有窗口」的，不要往性能历史里塞一条空记录
  if (hasSingleInstanceLock) persistStartupPerf();
  // 结束后端 Python 子进程，避免在系统里残留 python.exe
  // （我们自己 spawn 的才杀；若是复用外部已存在的后端则 backendProcess 为 null）
  if (backendProcess && !backendProcess.killed) {
    console.log('[Backend] Killing backend process on quit');
    backendProcess.kill();
  }
});
