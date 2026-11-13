/**
 * 「关于」里的自动更新面板。
 *
 * 所有状态都来自主进程（见 src/main/updater.ts），这里只负责把 phase
 * 翻译成一句话 + 一个能点的按钮。设计上刻意保持单行密度：
 * 平时它只是版本行右边一个「检查更新」，只有真的发现新版本时才展开成一块。
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useUpdateStore, hasPendingUpdate } from '../store/useUpdateStore';
import { APP_VERSION, IS_BETA, VERSION_DISPLAY } from '../utils/appVersion';
import './UpdateSection.scss';

function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN');
}

function fmtTime(sec: number): string {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleString('zh-CN');
}

export function UpdateSection() {
  const info = useUpdateStore((s) => s.info);
  const check = useUpdateStore((s) => s.check);
  const download = useUpdateStore((s) => s.download);
  const cancel = useUpdateStore((s) => s.cancel);
  const install = useUpdateStore((s) => s.install);
  const skip = useUpdateStore((s) => s.skip);
  const openReleases = useUpdateStore((s) => s.openReleases);

  const [showNotes, setShowNotes] = useState(false);

  // 新版本换了就收起说明，别让上一次展开的状态留到下一次
  useEffect(() => {
    setShowNotes(false);
  }, [info?.version]);

  const phase = info?.phase ?? 'idle';
  const supported = info?.supported !== false;
  const busy = phase === 'checking' || phase === 'downloading';
  const pending = hasPendingUpdate(info ?? null);

  // ---- 版本行右侧的按钮 ----
  let action: ReactNode = null;
  if (!supported) {
    action = (
      <button className="update-btn update-btn--ghost" onClick={openReleases}>
        前往下载
      </button>
    );
  } else if (phase === 'downloading') {
    action = (
      <button className="update-btn update-btn--ghost" onClick={() => void cancel()}>
        取消下载
      </button>
    );
  } else if (phase === 'downloaded') {
    action = (
      <button className="update-btn update-btn--primary" onClick={() => void install()}>
        重启并安装
      </button>
    );
  } else if (phase === 'available') {
    action = (
      <button className="update-btn update-btn--primary" onClick={() => void download()}>
        下载更新
      </button>
    );
  } else if (phase === 'error') {
    action = (
      <button className="update-btn update-btn--ghost" onClick={() => void check()}>
        重试
      </button>
    );
  } else {
    action = (
      <button className="update-btn update-btn--ghost" onClick={() => void check()} disabled={busy}>
        检查更新
      </button>
    );
  }

  const percent = Math.max(0, Math.min(100, info?.percent ?? 0));

  return (
    <div className={`update-panel${pending ? ' update-panel--pending' : ''}`}>
      <div className="settings-version-row update-panel__head">
        <span className="settings-version-row__label">版本</span>
        <code
          className={`settings-version-row__code${IS_BETA ? ' settings-version-row__code--beta' : ''}`}
          title={APP_VERSION}
        >
          {VERSION_DISPLAY}
        </code>
        <span className="update-panel__spacer" />
        {action}
      </div>

      {/* 状态行：只有「有事发生」的时候才占位置，平时不吵 */}
      {phase === 'checking' && (
        <div className="update-line">
          <span className="update-spinner" />
          正在检查更新…
        </div>
      )}

      {phase === 'available' && (
        <div className="update-line update-line--new">
          发现新版本 <strong>v{info?.version}</strong>
          {fmtDate(info?.releaseDate ?? '') && <span className="update-line__dim"> · {fmtDate(info!.releaseDate)}</span>}
        </div>
      )}

      {phase === 'downloading' && (
        <div className="update-progress">
          <div className="update-progress__bar">
            <div className="update-progress__fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="update-progress__meta">
            <span>下载中 {percent.toFixed(0)}%</span>
            <span className="update-line__dim">
              {fmtBytes(info?.transferred ?? 0)} / {fmtBytes(info?.total ?? 0)}
              {info?.bytesPerSecond ? ` · ${fmtBytes(info.bytesPerSecond)}/s` : ''}
            </span>
          </div>
        </div>
      )}

      {phase === 'downloaded' && (
        <div className="update-line update-line--ok">
          更新已下载完成，重启应用后自动安装（当前跑着游戏也没关系，安装时会等你确认）
        </div>
      )}

      {phase === 'up-to-date' && (
        <div className="update-line update-line__dim">
          {info?.skipped && info?.version ? (
            <>
              已跳过 v{info.version}，这个版本不再提醒
              <button className="update-link" onClick={openReleases}>
                仍要下载
              </button>
            </>
          ) : (
            <>已是最新版本{fmtTime(info?.checkedAt ?? 0) ? ` · 检查于 ${fmtTime(info!.checkedAt)}` : ''}</>
          )}
        </div>
      )}

      {phase === 'error' && (
        <div className="update-line update-line--warn">
          {info?.error}
          <button className="update-link" onClick={openReleases}>
            去 Release 页面手动下载
          </button>
        </div>
      )}

      {!supported && (
        <div className="update-line update-line__dim">
          {info?.supportHint}
          {!info?.supportHint && '当前安装方式不支持自动更新。'}
        </div>
      )}

      {/* 更新说明：默认折叠，长文本不该把设置页撑开 */}
      {phase === 'available' && !!info?.releaseNotes && (
        <div className="update-notes">
          <button className="update-link" onClick={() => setShowNotes((v) => !v)}>
            {showNotes ? '收起更新说明' : '查看更新说明'}
          </button>
          {showNotes && <pre className="update-notes__body">{info!.releaseNotes}</pre>}
        </div>
      )}

      {phase === 'available' && (
        <div className="update-line update-line--actions">
          <button className="update-link update-link--muted" onClick={() => void skip()}>
            跳过这个版本
          </button>
          <span className="update-line__dim">（只会跳过 v{info?.version}，下个版本照常提醒）</span>
        </div>
      )}
    </div>
  );
}
