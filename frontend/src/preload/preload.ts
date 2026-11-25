import { contextBridge, ipcRenderer } from 'electron';

/** 拖放导入结果：除了复制成功的数量，还带回封面图与重复检测的明细 */
export interface ImportVpkResult {
  success: boolean;
  count: number;
  skipped: number;
  /** 一并复制进 addons 的封面图数量 */
  covers: number;
  /** 内容相同（改过名的同一个 Mod），已跳过 */
  duplicates: string[];
  /** 同名但内容不同，未覆盖 */
  conflicts: string[];
  /** addons 里原本就存在的重复组（每组两个文件名） */
  existingDuplicates: string[][];
  error?: string;
}

/** 整合包 ZIP 导入结果（与主进程 src/main/packImport.ts 的 PackImportZipResult 对应） */
export interface PackImportZipResult {
  ok: boolean;
  /** 复用拖放导入得到的结果（复制数 / 重复 / 同名冲突等） */
  importResult?: ImportVpkResult;
  /** 建包用的成员名：导入后确实存在于 addons 根目录的 vpk 原名 */
  members: string[];
  error?: string;
}

/** 自动更新状态（字段与主进程 src/main/updater.ts 的 UpdateState 一一对应） */export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error' | 'unsupported';
  currentVersion: string;
  version: string;
  releaseDate: string;
  releaseNotes: string;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  error: string;
  checkedAt: number;
  skipped: boolean;
  supported: boolean;
  supportHint: string;
  portable: boolean;
  /** 本次实际使用的更新源（空串 = 还没检查过） */
  source: 'github' | 'gitee' | '';
  /** 用户选择的更新源偏好（auto = 国内优先 Gitee、失败回落 GitHub） */
  preferSource: 'auto' | 'github' | 'gitee';
}

// Type definitions for exposed API
interface ElectronAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  onMaximized: (callback: (isMaximized: boolean) => void) => void;
  selectFolder: () => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;
  /** 在资源管理器里定位文件（坏包提示条的「打开所在目录」） */
  showItemInFolder: (filePath: string) => Promise<boolean>;
  /** 导入 addonlist 备份：弹出打开文件对话框并读取内容（base64） */
  openAddonlistFile: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; contentBase64?: string; error?: string }>;
  /** 导出 addonlist 备份：弹出另存为对话框并写入内容（base64） */
  saveAddonlistFile: (contentBase64: string, defaultName: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  setProxy: (host: string, port: string) => Promise<boolean>;
  getGpuAccelerationStatus: () => Promise<{ gpuAccelerationDisabled: boolean }>;
  setGpuAcceleration: (disabled: boolean) => Promise<{ success: boolean; error?: string }>;
  /** 界面缩放（字号大小）：读取主进程当前生效的 zoom factor */
  getUiScale: () => Promise<{ scale: number }>;
  /** 界面缩放（字号大小）：设置并持久化（立即生效，无需重启） */
  setUiScale: (scale: number) => Promise<{ success: boolean; scale: number; error?: string }>;
  /** 同步窗口底色（不透明窗口，跟随日间/夜间主题） */
  setWindowTheme: (theme: 'light' | 'dark') => Promise<{ success: boolean; theme: string; error?: string }>;
  clearWorkshopCookies: () => Promise<boolean>;
  showContextMenu: (options: any) => Promise<void>;
  onContextMenuClick: (callback: (result: { action: string; modName: string }) => void) => void;
  importDroppedVpks: (filePaths: string[], addonsPath: string) => Promise<ImportVpkResult>;
  /** 弹出文件选择框挑一个整合包 ZIP，返回路径（取消时 canceled=true） */
  pickPackZip: () => Promise<{ canceled: boolean; path?: string }>;
  /** 导入整合包 ZIP：主进程解压+落盘，返回导入结果与建包成员 */
  importPackZip: (zipPath: string, addonsPath: string) => Promise<PackImportZipResult>;
  onBackendReady: (callback: () => void) => void;
  onBackendInfo: (callback: (info: { port: number }) => void) => void;
  /** 主动查询后端实际端口（避免 push 通知在挂载前丢失） */
  getBackendPort: () => Promise<number>;
  exportLogs: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  restartBackend: () => Promise<{ ok: boolean; error?: string }>;
  /** 上报启动性能里程碑（首屏渲染完成 / 首个 Mod 出现 / 扫描完成），用于加载速度排障 */
  reportPerf: (name: string, payload?: Record<string, any>) => void;
  /** 抓取当前窗口画面（主题切换交叉淡入用），返回 JPEG data URL；失败返回 null */
  captureThemeSnapshot: () => Promise<string | null>;
  // ---- 自动更新 ----
  /** 当前更新状态（渲染进程挂载时先取一次，之后靠 onUpdateStatus 推送） */
  getUpdateState: () => Promise<UpdateState>;
  checkForUpdates: (manual?: boolean) => Promise<UpdateState>;
  downloadUpdate: () => Promise<UpdateState>;
  cancelUpdateDownload: () => Promise<UpdateState>;
  installUpdate: () => Promise<boolean>;
  skipUpdateVersion: (version?: string) => Promise<UpdateState>;
  openReleasesPage: () => Promise<void>;
  /** 切换更新源偏好（auto = 国内优先 Gitee、失败回落 GitHub） */
  setUpdateSource: (source: 'auto' | 'github' | 'gitee') => Promise<UpdateState>;
  onUpdateStatus: (callback: (state: UpdateState) => void) => void;
}

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  onMaximized: (callback: (isMaximized: boolean) => void) => {
    ipcRenderer.on('window:maximized', (_event, isMaximized) => {
      callback(isMaximized);
    });
  },
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  openAddonlistFile: () => ipcRenderer.invoke('addonlist:openFile'),
  saveAddonlistFile: (contentBase64: string, defaultName: string) =>
    ipcRenderer.invoke('addonlist:saveFile', contentBase64, defaultName),
  setProxy: (host: string, port: string) => ipcRenderer.invoke('proxy:set', host, port),
  // GPU 硬件加速
  getGpuAccelerationStatus: () => ipcRenderer.invoke('gpu:getStatus'),
  setGpuAcceleration: (disabled: boolean) => ipcRenderer.invoke('gpu:setAcceleration', disabled),
  // 界面缩放（字号大小 / 整体缩放）
  getUiScale: () => ipcRenderer.invoke('ui:getScale'),
  setUiScale: (scale: number) => ipcRenderer.invoke('ui:setScale', scale),
  // 窗口底色（不透明窗口，跟随日间/夜间主题）
  setWindowTheme: (theme: 'light' | 'dark') => ipcRenderer.invoke('ui:setWindowTheme', theme),
  // 清除 workshop 内置浏览器的 cookie
  clearWorkshopCookies: () => ipcRenderer.invoke('session:clearWorkshopCookies'),
  // 原生右键菜单（操作系统渲染，不受窗口裁剪）
  showContextMenu: (options: any) => ipcRenderer.invoke('menu:showContextMenu', options),
  onContextMenuClick: (callback: (result: { action: string; modName: string }) => void) => {
    ipcRenderer.on('menu:itemClicked', (_event, result) => callback(result));
  },
  importDroppedVpks: (filePaths: string[], addonsPath: string) =>
    ipcRenderer.invoke('file:importDroppedVpks', filePaths, addonsPath),
  pickPackZip: () => ipcRenderer.invoke('packs:pickZip'),
  importPackZip: (zipPath: string, addonsPath: string) =>
    ipcRenderer.invoke('packs:importZip', zipPath, addonsPath),
  // 监听后端就绪事件
  onBackendReady: (callback: () => void) => {
    ipcRenderer.on('backend:ready', () => callback());
  },
  // 监听后端实际使用的端口（8288 被占用时可能改用备用端口）
  onBackendInfo: (callback: (info: { port: number }) => void) => {
    ipcRenderer.on('backend:info', (_event, info: { port: number }) => callback(info));
  },
  getBackendPort: () => ipcRenderer.invoke('backend:getPort'),
  // 由主进程本地导出日志（不依赖后端进程是否存活）
  exportLogs: () => ipcRenderer.invoke('logs:export'),
  // 请求主进程重新启动后端
  restartBackend: () => ipcRenderer.invoke('backend:restart'),
  // 抓取当前窗口画面（用于主题切换的交叉淡入，返回 JPEG data URL；失败返回 null）
  captureThemeSnapshot: () => ipcRenderer.invoke('theme:captureSnapshot'),
  // 上报启动性能里程碑（主进程会写入 startup-perf.json 并随导出日志打包）
  reportPerf: (name: string, payload?: Record<string, any>) =>
    ipcRenderer.send('perf:mark', name, payload),
  // ---- 自动更新 ----
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  cancelUpdateDownload: () => ipcRenderer.invoke('update:cancel'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  skipUpdateVersion: (version?: string) => ipcRenderer.invoke('update:skip', version),
  openReleasesPage: () => ipcRenderer.invoke('update:openReleases'),
  setUpdateSource: (source: 'auto' | 'github' | 'gitee') =>
    ipcRenderer.invoke('update:setSource', source),
  onUpdateStatus: (callback: (state: UpdateState) => void) => {
    ipcRenderer.on('update:status', (_event, state: UpdateState) => callback(state));
  },
});
