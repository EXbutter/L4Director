/// <reference types="vite/client" />

/** 由 vite.config.ts 的 define 在构建时注入（值来自 package.json 的 version） */
declare const __APP_VERSION__: string;

declare module '*.scss' {
  const content: Record<string, string>;
  export default content;
}

declare module '*.ogg' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

/** 自动更新状态（与主进程 src/main/updater.ts 的 UpdateState 对应） */
interface UpdateStatePayload {
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
}

interface Window {
  electronAPI: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    onMaximized: (callback: (isMaximized: boolean) => void) => void;
    selectFolder: () => Promise<string | null>;
    openExternal: (url: string) => Promise<void>;
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
    importDroppedVpks: (filePaths: string[], addonsPath: string) => Promise<{
      success: boolean;
      count: number;
      skipped: number;
      /** 一并复制进 addons 的封面图数量 */
      covers: number;
      /** 内容相同（改过名的同一个 Mod），已跳过 */
      duplicates: string[];
      /** 每个被跳过的重复项对应哪份已安装副本（用来区分是跟工坊还是外部 Mod 重复） */
      duplicateSources?: { file: string; target: string; workshop: boolean }[];
      /** 同名但内容不同，未覆盖 */
      conflicts: string[];
      /** addons 里原本就存在的重复组（每组两个文件名） */
      existingDuplicates: string[][];
      error?: string;
    }>;
    onBackendInfo: (callback: (info: { port: number }) => void) => void;
    /** 主动查询后端实际端口（push 通知可能在挂载前就发出去了） */
    getBackendPort: () => Promise<number>;
    exportLogs: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
    restartBackend: () => Promise<{ ok: boolean; error?: string }>;
    reportPerf: (name: string, payload?: Record<string, any>) => void;
    captureThemeSnapshot: () => Promise<string | null>;
    // ---- 自动更新 ----
    getUpdateState: () => Promise<UpdateStatePayload>;
    checkForUpdates: () => Promise<UpdateStatePayload>;
    downloadUpdate: () => Promise<UpdateStatePayload>;
    cancelUpdateDownload: () => Promise<UpdateStatePayload>;
    installUpdate: () => Promise<boolean>;
    skipUpdateVersion: (version?: string) => Promise<UpdateStatePayload>;
    openReleasesPage: () => Promise<void>;
    onUpdateStatus: (callback: (state: UpdateStatePayload) => void) => void;
  };
}
