import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import type { ModData } from '../store/useStore';
import { confirmDialog } from './ConfirmDialog';
import { showToast } from './Toast';
import './UnreadableNotice.scss';

/** 只用于提示条：坏包通常很小，精确到 KB 比「0.0 MB」有诊断价值 */
function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 字节';
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 「解析失败的 VPK」提示条。
 *
 * 背景：坏包以前在扫描阶段被 `return None` 直接丢掉，用户在列表里翻不到，
 * 只会觉得"我明明装了、软件里根本没有"。现在的分工是：
 *   - 列表里**不出现**（它读不出内容，没有标签 / 分类 / 冲突 / 封面，
 *     混在正常 Mod 里只会让人以为多了个能用的包，也污染「全部」计数）；
 *   - 这条提示把「哪个文件、多大、为什么读不出、怎么处理」一次说清楚，
 *     并给出「打开所在目录」「删除文件」两个出口 —— 否则文件被列表藏起来后，
 *     用户在软件里就再也够不到它了。
 *
 * 为什么不做成 toast：toast 3.5 秒就消失，而"这个包坏了"是需要用户动手
 * 处理的状态；贴列表下方常驻，修好之前一直在。
 */
export function UnreadableNotice({ mods }: { mods: ModData[] }) {
  const deleteMod = useStore((s) => s.deleteMod);
  const [dismissed, setDismissed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // 坏包集合变了（新坏了一个 / 修好了一个）就把「已收起」复位：
  // 列表里已经看不到这些文件了，提示条是唯一的出口，收起后不该永远不再出现。
  const setKey = mods.map((m) => m.path || m.name).sort().join('|');
  useEffect(() => {
    setDismissed(false);
  }, [setKey]);

  if (mods.length === 0 || dismissed) return null;

  const openFolder = async (mod: ModData) => {
    if (!mod.path) {
      showToast('这个包没有可定位的文件路径，请在 addons 目录里手动查找', 'warning');
      return;
    }
    // 用文件路径（不是目录）：在资源管理器里直接选中这个 vpk，比打开一个
    // 几百个文件的目录好找得多。
    let ok = false;
    try {
      ok = (await window.electronAPI?.showItemInFolder?.(mod.path)) ?? false;
    } catch {
      ok = false;
    }
    if (ok) return;

    // 兜底：主进程 / preload 是旧产物时这个 IPC 不存在（`?.` 会静默吞掉），
    // 表现为「点了没反应」。退化成打开所在文件夹，至少不让按钮变哑巴。
    const dir = mod.path.replace(/[\\/][^\\/]+$/, '');
    try {
      if (window.electronAPI?.openExternal) {
        await window.electronAPI.openExternal(`file:///${dir.replace(/\\/g, '/')}`);
        return;
      }
    } catch {
      /* 落到下面的提示 */
    }
    showToast('无法调用资源管理器，请手动定位到 addons 目录', 'warning');
  };

  const remove = async (mod: ModData) => {
    const key = mod.path || mod.name;
    const ok = await confirmDialog({
      title: '删除这个无法解析的文件？',
      description: (
        <>
          「{mod.name}」读不出内容，删除后文件会从磁盘上移除，软件无法恢复。
          如果是创意工坊的包，删除后也可以在 Steam 里重新订阅下载。
        </>
      ),
      detail: mod.path,
      confirmText: '删除文件',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyKey(key);
    try {
      await deleteMod(mod.name, mod.path);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="unreadable-notice" role="alert">
      <div className="unreadable-notice__head">
        <span className="unreadable-notice__icon" aria-hidden="true">!</span>
        <span className="unreadable-notice__title">
          {mods.length === 1
            ? '1 个 VPK 解析失败，已从列表隐藏'
            : `${mods.length} 个 VPK 解析失败，已从列表隐藏`}
        </span>
        <button
          className="unreadable-notice__close"
          onClick={() => setDismissed(true)}
          title="收起这条提示（文件仍在磁盘上，下次扫描出新的坏包时会再次提示）"
          aria-label="收起提示"
        >
          ×
        </button>
      </div>

      <ul className="unreadable-notice__list">
        {mods.map((mod) => {
          const key = mod.path || mod.name;
          const busy = busyKey === key;
          return (
            <li key={key} className="unreadable-notice__item">
              <div className="unreadable-notice__line">
                <span className="unreadable-notice__file" title={mod.path || mod.name}>
                  {mod.name}
                </span>
                <span className="unreadable-notice__size">{formatBytes(mod.size_bytes)}</span>
                <span className="unreadable-notice__reason">
                  解析失败，错误原因：{mod.unreadable_reason || '未知错误'}
                </span>
                <button
                  className="unreadable-notice__btn"
                  onClick={() => void openFolder(mod)}
                  disabled={!mod.path || busy}
                >
                  打开所在目录
                </button>
                <button
                  className="unreadable-notice__btn unreadable-notice__btn--danger"
                  onClick={() => void remove(mod)}
                  disabled={busy}
                >
                  {busy ? '删除中…' : '删除文件'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="unreadable-notice__help">
        <strong>如何处理：</strong>
        <ol>
          <li>
            先看上面标出的大小。0 字节、或者明显比同类包小很多，说明下载或复制
            没走完 —— 直接点「删除文件」，再重新下载。
          </li>
          <li>
            创意工坊的包：删掉后在 Steam 里重新订阅，等它下载完再刷新。
            半路取消订阅、Steam 云同步中断都会留下残缺文件。
          </li>
          <li>
            本地包：重新从压缩包解压一份。最常见的原因是直接把 .zip / .rar
            改成了 .vpk，或者解压过程中被打断。
          </li>
          <li>
            处理完点工具栏的刷新。文件修好后它会自动回到 Mod 列表，
            不需要重启软件。
          </li>
        </ol>
        <span className="unreadable-notice__hint">
          如果文件确认完好、软件仍读不出，多半是非标准封装的 VPK：
          把上面这条文件名和错误原因一起反馈即可。
        </span>
      </div>
    </section>
  );
}
