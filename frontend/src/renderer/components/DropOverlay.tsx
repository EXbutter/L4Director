import { useState, useCallback, useEffect, useRef } from 'react';
import './DropOverlay.scss';
import { showToast } from './Toast';

interface DropOverlayProps {
  addonsPath: string | null;
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

    // Extract .vpk file paths (Electron adds .path to File objects)
    const filePaths: string[] = [];
    for (const file of files) {
      const filePath = (file as any).path;
      if (filePath && filePath.toLowerCase().endsWith('.vpk')) {
        filePaths.push(filePath);
      }
    }

    if (filePaths.length === 0) {
      showToast('仅支持 .vpk 格式的 Mod 文件', 'warning');
      return;
    }

    if ((window as any).electronAPI?.importDroppedVpks) {
      try {
        const result = await (window as any).electronAPI.importDroppedVpks(
          filePaths,
          addonsPath
        );
        if (result.success) {
          if (result.count > 0) {
            showToast(`成功导入 ${result.count} 个 Mod${result.skipped > 0 ? `，${result.skipped} 个已存在已跳过` : ''}`, 'success');
          } else if (result.skipped > 0) {
            showToast(`${result.skipped} 个文件已存在，自动跳过`, 'info');
          }
          // Refresh mods list
          if (result.count > 0) {
            const { useStore } = await import('../store/useStore');
            useStore.getState().refreshAll();
          }
        } else {
          showToast(`导入失败：${result.error || '未知错误'}`, 'error');
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
          : '松手即可将 .vpk 文件复制到 addons 目录'}
      </div>
      <div className="drop-overlay__badge">
        {!addonsPath ? '路径未配置' : '仅支持 .vpk 文件'}
      </div>
    </div>
  );
}
