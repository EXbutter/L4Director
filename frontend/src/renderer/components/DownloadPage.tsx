import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBase } from '../store/useStore';
import './ContentArea.scss';
import './DownloadPage.scss';

interface DlJob {
  wid: string;
  title: string;
  size: number;
  preview: string;
  state: 'pending' | 'running' | 'done' | 'skip' | 'fail' | 'cancel';
  pct: number;
  done: number;
  nseg: number;
  speed: number;
  eta: string;
  error: string;
  exists: boolean;
}

interface DlSnapshot {
  running: boolean;
  outdir: string;
  hint: string;
  threads: number;
  force: boolean;
  jobs: DlJob[];
  logs: string[];
  summary: { total: number; done: number; failed: number; overall_pct: number; speed: number };
}

const STATE_TEXT: Record<string, string> = {
  pending: '等待中',
  running: '下载中',
  done: '已完成',
  skip: '已存在',
  fail: '失败',
  cancel: '已取消',
};

function fmtSize(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB'];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(x) : x.toFixed(1)}${units[i]}`;
}

function fmtSpeed(n: number): string {
  return n > 0 ? `${(n / 1048576).toFixed(2)}MB/s` : '';
}

export function DownloadPage() {
  const api = getApiBase();

  const [snap, setSnap] = useState<DlSnapshot | null>(null);
  const [text, setText] = useState('');
  const [outdir, setOutdir] = useState('');
  const [threads, setThreads] = useState(24);
  const [force, setForce] = useState(false);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  // 输出目录/线程只需在首次拿到快照时同步一次，之后由用户输入决定
  const initedRef = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  // 轮询回调里要读最新的 running 状态，用 ref 兜住（避免把 snap 塞进 deps 反复重建定时器）
  const snapRef = useRef<DlSnapshot | null>(null);

  const applySnapshot = useCallback((s: DlSnapshot) => {
    setSnap(s);
    if (!initedRef.current) {
      initedRef.current = true;
      setOutdir(s.outdir || '');
      setThreads(s.threads || 24);
      setForce(Boolean(s.force));
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${api}/api/download/state`);
      if (res.ok) applySnapshot(await res.json());
    } catch {
      /* 后端未就绪时静默，下一次轮询会补上 */
    }
  }, [api, applySnapshot]);

  // 轮询：下载中 500ms 一次，空闲时 2s 一次（本地请求，开销可忽略）
  useEffect(() => {
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      await refresh();
      if (stopped) return;
      timer = window.setTimeout(tick, snapRef.current?.running ? 500 : 2000);
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  // tick 里要读最新的 running 状态（见上面的 snapRef）
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [snap?.logs.length]);

  const toast = (kind: 'ok' | 'err', t: string) => {
    setMsg({ kind, text: t });
    window.setTimeout(() => setMsg((m) => (m && m.text === t ? null : m)), 4000);
  };

  const addTargets = async () => {
    const raw = text.trim();
    if (!raw || adding) return;
    setAdding(true);
    try {
      const res = await fetch(`${api}/api/download/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: raw }),
      });
      const data = await res.json();
      if (data.error) {
        toast('err', data.error);
      } else {
        const n = (data.added || []).length;
        const ignored = (data.ignored || []).length;
        toast('ok', `已添加 ${n} 项${ignored ? `，${ignored} 项无效或已存在` : ''}`);
        setText('');
      }
      await refresh();
    } catch (e) {
      toast('err', `解析失败：${(e as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  const start = async () => {
    try {
      const res = await fetch(`${api}/api/download/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outdir, threads, force }),
      });
      const data = await res.json();
      if (!data.ok) toast('err', data.error || '启动失败');
      await refresh();
    } catch (e) {
      toast('err', `启动失败：${(e as Error).message}`);
    }
  };

  const stop = async () => {
    try {
      await fetch(`${api}/api/download/stop`, { method: 'POST' });
      toast('ok', '正在停止…已下好的分段会保留');
      await refresh();
    } catch {
      /* ignore */
    }
  };

  const clearQueue = async () => {
    await fetch(`${api}/api/download/clear`, { method: 'POST' });
    setSelected([]);
    await refresh();
  };

  const removeSelected = async () => {
    if (!selected.length) return;
    await fetch(`${api}/api/download/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wids: selected }),
    });
    setSelected([]);
    await refresh();
  };

  const openDir = async () => {
    const res = await fetch(`${api}/api/download/open-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: outdir }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast('err', d.detail || '打开目录失败');
    }
  };

  const chooseDir = async () => {
    const picked = await (window as any).electronAPI?.selectFolder?.();
    if (picked) setOutdir(picked);
  };

  const toggleSelect = (wid: string) => {
    setSelected((prev) => (prev.includes(wid) ? prev.filter((x) => x !== wid) : [...prev, wid]));
  };

  const jobs = snap?.jobs ?? [];
  const summary = snap?.summary;
  const running = Boolean(snap?.running);
  const pendingCount = jobs.filter((j) => j.state === 'pending' || j.state === 'fail' || j.state === 'cancel').length;

  const overallText = useMemo(() => {
    if (!summary || summary.total === 0) return '队列为空';
    return `${summary.done}/${summary.total} 完成${summary.failed ? ` · ${summary.failed} 失败` : ''}`;
  }, [summary]);

  return (
    <div className="content-area dl-page">
      <div className="page-header">
        <h1>创意工坊下载</h1>
        <p>粘贴工坊链接或 ID，直接从 Steam CDN 多线程下载并校验 SHA1，落成游戏可直接加载的 .vpk</p>
      </div>

      {/* 输入区 */}
      <section className="dl-card dl-input">
        <div className="dl-input__head">
          <span className="dl-card__title">添加下载</span>
          <span className="dl-input__hint">每行一个链接或 ID，支持创意工坊合集（自动展开）</span>
        </div>
        <div className="dl-input__body">
          <textarea
            className="dl-textarea"
            value={text}
            placeholder={'https://steamcommunity.com/sharedfiles/filedetails/?id=3825195494\n3825198598'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void addTargets();
              }
            }}
            spellCheck={false}
          />
          <button className="dl-btn dl-btn--primary" onClick={addTargets} disabled={adding || !text.trim()}>
            {adding ? '解析中…' : '添加到队列'}
          </button>
        </div>
      </section>

      {/* 队列 */}
      <section className="dl-card dl-queue">
        <div className="dl-queue__head">
          <span className="dl-card__title">下载队列</span>
          <span className="dl-queue__count">{jobs.length} 项 · {overallText}</span>
          <div className="dl-queue__actions">
            {selected.length > 0 && (
              <button className="dl-btn dl-btn--ghost" onClick={removeSelected}>
                移除选中 {selected.length}
              </button>
            )}
            <button className="dl-btn dl-btn--ghost" onClick={clearQueue} disabled={running || jobs.length === 0}>
              清空
            </button>
          </div>
        </div>

        <div className="dl-queue__body">
          {jobs.length === 0 ? (
            <div className="dl-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <h3>队列还是空的</h3>
              <p>把创意工坊的链接或 ID 粘到上面，点「添加到队列」</p>
            </div>
          ) : (
            jobs.map((job) => {
              const pct = job.state === 'done' || job.state === 'skip' ? 100 : Math.max(0, job.pct || 0);
              const isSel = selected.includes(job.wid);
              return (
                <div
                  key={job.wid}
                  className={`dl-row ${isSel ? 'dl-row--selected' : ''}`}
                  onClick={() => !running && toggleSelect(job.wid)}
                >
                  <div className="dl-row__thumb">
                    {job.preview ? (
                      <img
                        src={`${api}/api/download/thumbnail?wid=${job.wid}&url=${encodeURIComponent(job.preview)}`}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                        }}
                      />
                    ) : (
                      <span className="dl-row__thumb-empty" />
                    )}
                  </div>

                  <div className="dl-row__info">
                    <div className="dl-row__title" title={job.title}>
                      {job.title}
                    </div>
                    <div className="dl-row__meta">
                      <span className="dl-row__id">{job.wid}</span>
                      <span>{fmtSize(job.size)}</span>
                      {job.state === 'running' && job.speed > 0 && <span>{fmtSpeed(job.speed)}</span>}
                      {job.state === 'running' && job.eta && <span>剩 {job.eta}</span>}
                      {job.error && <span className="dl-row__error">{job.error}</span>}
                    </div>
                    <div className="dl-progress">
                      <div
                        className={`dl-progress__bar dl-progress__bar--${job.state}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>

                  <div className={`dl-row__state dl-row__state--${job.state}`}>
                    {STATE_TEXT[job.state] || job.state}
                    {job.state === 'running' && job.nseg > 1 && (
                      <span className="dl-row__seg">
                        {job.done}/{job.nseg}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* 日志 */}
      <section className="dl-card dl-log">
        <div className="dl-log__head">
          <span className="dl-card__title">日志</span>
        </div>
        <div className="dl-log__body" ref={logRef}>
          {(snap?.logs ?? []).length === 0 ? (
            <div className="dl-log__empty">暂无日志</div>
          ) : (
            (snap?.logs ?? []).map((line, i) => (
              <div key={i} className="dl-log__line">
                {line}
              </div>
            ))
          )}
        </div>
      </section>

      {/* 底部操作栏 */}
      <div className="dl-footer">
        <div className="dl-footer__dir">
          <label>输出目录</label>
          <div className="dl-footer__dir-row">
            <input
              className="dl-input-text"
              value={outdir}
              onChange={(e) => setOutdir(e.target.value)}
              spellCheck={false}
              placeholder="选择或输入目录"
            />
            <button className="dl-btn dl-btn--ghost" onClick={chooseDir}>
              选择…
            </button>
            <button className="dl-btn dl-btn--ghost" onClick={openDir}>
              打开
            </button>
          </div>
        </div>

        <div className="dl-footer__opts">
          <label>线程</label>
          <input
            className="dl-input-num"
            type="number"
            min={1}
            max={64}
            value={threads}
            onChange={(e) => setThreads(Math.max(1, Math.min(64, Number(e.target.value) || 1)))}
          />
          <label className="dl-check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            已存在也重下
          </label>
        </div>

        <div className="dl-footer__actions">
          {running ? (
            <button className="dl-btn dl-btn--danger" onClick={stop}>
              停止
            </button>
          ) : (
            <button
              className="dl-btn dl-btn--primary dl-btn--lg"
              onClick={start}
              disabled={pendingCount === 0}
            >
              开始下载{pendingCount > 0 ? ` (${pendingCount})` : ''}
            </button>
          )}
        </div>
      </div>

      {snap?.hint && <div className="dl-hint">{snap.hint}</div>}

      {msg && <div className={`dl-toast dl-toast--${msg.kind}`}>{msg.text}</div>}
    </div>
  );
}
