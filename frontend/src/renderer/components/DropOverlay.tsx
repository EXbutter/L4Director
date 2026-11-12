import { useState, useCallback, useEffect, useRef } from 'react';
import './DropOverlay.scss';
import { showToast } from './Toast';

interface DropOverlayProps {
  addonsPath: string | null;
}

/** 拖放时一并接收的封面图格式（与后端 _SIDECAR_THUMB_EXTS 保持一致） */
const DROP_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];

/** 提示里最多列 3 个文件名，其余用「等」收尾，避免 toast 撑满屏幕 */
function previewNames(names: string[], limit = 3): string {
  const head = names.slice(0, limit).map((n) => n.replace(/\.vpk$/i, ''));
  return names.length > limit ? `${head.join('、')} 等` : head.join('、');
}

export function DropOverlay({ addonsPath }: DropOverlayProps) {
  const [visible, setVisible] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    // 在 dragenter 中，e.dataTransfer.files 是空的（文件还没放下）
    // 所以我们只需要检测到有拖拽动作就显示遮罩层
    setVisible(true);
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setVisible(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setVisible(false);

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    if (!addonsPath) {
      console.warn('[DropOverlay] addonsPath not set - cannot import');
      showToast('请先在设置页面配置 addons 路径', 'warning');
      return;
    }

    // 收集 .vpk、封面图，以及文件夹（交给主进程递归展开）。
    // 以前只收 .vpk，和 vpk 一起拖进来的 xxx.jpg 会被悄悄丢掉，
    // 于是 Mod 卡片一直没有封面 —— 现在图片也一并送过去。
    const filePaths: string[] = [];
    for (const file of files) {
      const filePath = (file as any).path as string | undefined;
      if (!filePath) continue;
      const lower = filePath.toLowerCase();
      if (lower.endsWith('.vpk') || DROP_IMAGE_EXTS.some((ext) => lower.endsWith(ext))) {
        filePaths.push(filePath);
      } else if (!/\.[^\\/]+$/.test(lower)) {
        // 没有扩展名：多半是文件夹，主进程会递归找里面的 vpk 与图片
        filePaths.push(filePath);
      }
    }

    if (filePaths.length === 0) {
      showToast('仅支持 .vpk 文件与封面图片（jpg / png / webp 等）', 'warning');
      return;
    }

    if ((window as any).electronAPI?.importDroppedVpks) {
      try {
        const result = await (window as any).electronAPI.importDroppedVpks(
          filePaths,
          addonsPath
        );
        if (!result.success) {
          showToast(`导入失败：${result.error || '未知错误'}`, 'error');
          return;
        }

        // 1) 成功项
        const done: string[] = [];
        if (result.count > 0) done.push(`导入 ${result.count} 个 Mod`);
        if (result.covers > 0) done.push(`识别 ${result.covers} 张封面`);
        if (done.length > 0) showToast(done.join('，'), 'success');

        // 2) 重复：内容相同的同一个 Mod（可能是改名后重复拖入，也可能与工坊里已订阅的那份相同）
        const dupNames: string[] = result.duplicates || [];
        if (dupNames.length > 0) {
          const wsCount = (result.duplicateSources || []).filter(
            (s: { workshop: boolean }) => s.workshop
          ).length;
          const extra = wsCount > 0 ? `（其中 ${wsCount} 个与创意工坊里的副本内容相同）` : '';
          showToast(`跳过 ${dupNames.length} 个已安装的 Mod${extra}：${previewNames(dupNames)}`, 'info');
        }

        // 3) 同名但内容不同：不动用户已有文件，只提示
        const conflictNames: string[] = result.conflicts || [];
        if (conflictNames.length > 0) {
          showToast(
            `${conflictNames.length} 个同名文件已存在且内容不同，未覆盖：${previewNames(conflictNames)}`,
            'warning'
          );
        }

        // 4) 库里原本就存在的重复
        const groups: string[][] = result.existingDuplicates || [];
        if (groups.length > 0) {
          showToast(`addons 里已有 ${groups.length} 组重复 Mod（内容相同、文件名不同）`, 'warning');
        }

        if (
          done.length === 0 &&
          dupNames.length === 0 &&
          conflictNames.length === 0 &&
          result.skipped > 0
        ) {
          showToast(`${result.skipped} 个文件未导入`, 'info');
        }

        // 复制过封面图时，后端的同名封面查找缓存里可能还留着「没有封面」的旧结论，
        // 先清一次再刷新，卡片才能立刻出图（见 main.py /api/mods/refresh-covers）。
        if (result.count > 0 || result.covers > 0) {
          const { useStore, getApiBase } = await import('../store/useStore');
          if (result.covers > 0) {
            try {
              await fetch(`${getApiBase()}/api/mods/refresh-covers`, { method: 'POST' });
            } catch {
              /* 后端没就绪也不影响导入结果 */
            }
          }
          useStore.getState().refreshAll();
        }
      } catch (err) {
        console.error('[DropOverlay] Import error:', err);
        showToast('导入失败：请检查控制台错误', 'error');
      }
    }
  }, [addonsPath]);

  useEffect(() => {
    window.addEventListener('dragenter', handleDragEnter, false);
    window.addEventListener('dragover', handleDragOver, false);
    window.addEventListener('dragleave', handleDragLeave, false);
    window.addEventListener('drop', handleDrop, false);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter, false);
      window.removeEventListener('dragover', handleDragOver, false);
      window.removeEventListener('dragleave', handleDragLeave, false);
      window.removeEventListener('drop', handleDrop, false);
    };
  }, [handleDragEnter, handleDragOver, handleDragLeave, handleDrop]);

  return (
    <div
      className={`drop-overlay ${visible ? 'drop-overlay--visible' : ''} ${!addonsPath ? 'drop-overlay--warning' : ''}`}
    >
      <svg className="drop-overlay__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
      <div className="drop-overlay__title">拖到到这里一键添加 Mod</div>
      <div className="drop-overlay__subtitle">
        {!addonsPath
          ? '请先在设置页面配置 addons 路径'
          : '松手即可把 .vpk 与同名封面图一起复制到 addons 目录'}
      </div>
      <div className="drop-overlay__badge">
        {!addonsPath ? '路径未配置' : '支持 .vpk + 同名封面图'}
      </div>
    </div>
  );
}
