/**
 * 自动更新状态（渲染进程侧）。
 *
 * 真正的检查/下载/安装全在主进程（src/main/updater.ts），这里只做两件事：
 *   1. 订阅主进程推来的状态，供界面渲染；
 *   2. 把「发现了新版本 / 下载完了 / 检查失败」翻译成 toast。
 *
 * 为什么单独一个 store 而不是塞进 useStore：更新是纯应用级状态，和 Mod 数据
 * 没有关系，塞进去会让那个已经很长的 store 再长一截，还会牵连无关组件重渲染。
 */

import { create } from 'zustand';
import { showToast } from '../components/Toast';

/** 全局类型，见 src/renderer/types.d.ts */
type UpdateInfo = UpdateStatePayload;

interface UpdateStore {
  info: UpdateInfo | null;
  /** 已经弹过「发现新版本」的版本号，避免同一次发现重复打扰 */
  notifiedVersion: string;
  /** 最近一次检查是不是用户点的（决定「已是最新」要不要弹提示） */
  lastCheckManual: boolean;
  init: () => void;
  check: () => Promise<void>;
  download: () => Promise<void>;
  cancel: () => Promise<void>;
  install: () => Promise<void>;
  skip: () => Promise<void>;
  openReleases: () => void;
}

const api = () => (typeof window !== 'undefined' ? window.electronAPI : undefined);

let inited = false;

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  info: null,
  notifiedVersion: '',
  lastCheckManual: false,

  init: () => {
    if (inited) return;
    const a = api();
    if (!a?.onUpdateStatus) return; // 浏览器里跑（vite dev 非 Electron）时静默跳过
    inited = true;

    a.onUpdateStatus((next) => {
      const prev = get().info;
      set({ info: next });

      const manual = get().lastCheckManual;
      const becameAvailable =
        next.phase === 'available' &&
        !!next.version &&
        next.version !== get().notifiedVersion &&
        !next.skipped &&
        // 下载失败回退到 available 时不要再报一次「发现新版本」
        prev?.phase !== 'downloading' &&
        prev?.phase !== 'downloaded';
      if (becameAvailable) {
        set({ notifiedVersion: next.version });
        showToast(`发现新版本 v${next.version}，可在「设置 → 关于」里更新`, 'info');
      }

      if (next.phase === 'downloaded' && prev?.phase !== 'downloaded') {
        showToast('更新已下载完成，重启应用即可安装', 'success');
      }
      if (next.phase === 'up-to-date' && manual) {
        showToast('已是最新版本', 'success');
      }
      if (next.phase === 'error' && manual && next.error) {
        showToast(`检查更新失败：${next.error}`, 'error');
      }
      if (next.phase === 'up-to-date') set({ lastCheckManual: false });
      if (next.phase === 'error' || next.phase === 'available') set({ lastCheckManual: false });
    });

    // 先取一次当前状态：主进程可能在渲染进程挂载前就已经检查完了
    void a.getUpdateState().then((s) => {
      if (s) set({ info: s });
    });
  },

  check: async () => {
    const a = api();
    if (!a?.checkForUpdates) return;
    set({ lastCheckManual: true });
    const s = await a.checkForUpdates();
    if (s) set({ info: s });
  },

  download: async () => {
    const a = api();
    if (!a?.downloadUpdate) return;
    const s = await a.downloadUpdate();
    if (s) set({ info: s });
  },

  cancel: async () => {
    const a = api();
    if (!a?.cancelUpdateDownload) return;
    const s = await a.cancelUpdateDownload();
    if (s) set({ info: s });
  },

  install: async () => {
    const a = api();
    if (!a?.installUpdate) return;
    const ok = await a.installUpdate();
    if (!ok) showToast('当前没有已下载的更新', 'warning');
  },

  skip: async () => {
    const a = api();
    if (!a?.skipUpdateVersion) return;
    const s = await a.skipUpdateVersion();
    if (s) set({ info: s });
    showToast('已跳过这个版本，下次有更新再提醒', 'info');
  },

  openReleases: () => {
    void api()?.openReleasesPage();
  },
}));

/** 供界面判断「有新版本待处理」：侧边栏小圆点、设置页高亮都用它 */
export function hasPendingUpdate(info: UpdateInfo | null): boolean {
  if (!info || !info.supported || info.skipped) return false;
  return info.phase === 'available' || info.phase === 'downloading' || info.phase === 'downloaded';
}
