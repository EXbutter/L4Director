import { useEffect, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, getApiBase } from '../store/useStore';
import { FONT_PRESETS } from '../utils/uiFont';
import { ACCENT_PRESETS } from '../utils/themeColor';
import { IS_BETA } from '../utils/appVersion';
import { UpdateSection } from './UpdateSection';
import { markBackgroundOptimized, optimizeBackgroundImage } from '../utils/backgroundImage';
import {
  cardAnimationEnabled,
  setCardAnimationEnabled,
  systemReducedMotion,
} from '../utils/animationPreference';
import { showToast } from './Toast';
// 与 MyModsPage / PacksPage 保持一致：.content-area 的布局（flex:1 + height:100%）定义在这里，
// 少了它设置页的容器无法撑满主区域，会出现“顶部栏与底部之间一条真空空隙、内容显示不全”的问题
import './ContentArea.scss';
import './SettingsPage.scss';

/**
 * 官方基准（游戏本体 `pak01_dir.vpk`）的可用性，来自 `/api/status` 的 `official_baseline`。
 *
 * 为什么设置页要关心它：`hard` 冲突要求「同一路径 + 内容指纹不同 + 路径在官方名单里」。
 * 拿不到名单时后端会把所有路径当成私有路径，`hard` 整片降级成 `soft`（只进
 * `conflict_hints`），**不报错** —— 用户只会觉得「软件不认冲突了」。所以这里把
 * 「为什么没有基准」如实显示出来。
 */
interface OfficialBaseline {
  available: boolean;
  /** addons_not_configured / pak_not_found / parse_failed；可用时为空串 */
  reason?: string;
  /** 给用户看的一句话（含可复制的路径） */
  message?: string;
  path?: string | null;
  entries?: number;
}

/** 无级滑杆的数值展示：去掉多余的小数位（8 -> 8，8.5 -> 8.5） */
function formatStepless(value: number): string {
  return Number(value.toFixed(1)).toString();
}

/** 无级滑杆取值：吸附到 0.1 精度，避免浮点误差写进本地存储 */
function readStepless(e: ChangeEvent<HTMLInputElement>): number {
  return Math.round(Number(e.target.value) * 10) / 10;
}

/** 缓存体积：不到 1MB 用 KB，免得显示成 0.0 MB */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * 界面缩放的可选档位（1 = 100%）。
 * 默认 110%：字太小/发虚时用户往往只想「大一点」，但一步到位放太大又显得拥挤。
 */
const UI_SCALE_OPTIONS = [1, 1.1, 1.2, 1.3, 1.5];

export function SettingsPage() {
  // 只订阅本页真正用到的字段，并用 useShallow 做浅比较：以前这里是 `useStore()`
  // 整店订阅，store 里任何一处变化（Mod 列表、扫描进度、工坊检查、弹窗…）都会把
  // 整个设置页重渲染一遍。设置页本身不便宜（一堆开关 + 背景预览），没必要跟着抖。
  // 注意：selector 每次返回新对象，必须套 useShallow，否则会无限重渲染。
  const {
    addonsPath,
    setAddonsPath,
    autoDetectPath,
    fetchSettings,
    fetchStatus,
    refreshAll,
    status,
    modCount,
    background,
    setBackground,
    showMascot,
    toggleMascot,
    themeTransition,
    toggleThemeTransition,
    accentColor,
    setAccentColor,
    showFps,
    toggleFps,
    uiScale,
    setUiScale,
    fetchUiScale,
    uiFontKey,
    setUiFont,
    gpuAccelerationDisabled,
    gpuAccelerationLoading,
    fetchGpuAccelerationStatus,
    toggleGpuAcceleration,
    exportLogs,
    workshopUpdates,
    checkWorkshopUpdates,
    cancelWorkshopCheck,
    setWorkshopUpdateSettings,
  } = useStore(useShallow((s) => ({
    addonsPath: s.addonsPath,
    setAddonsPath: s.setAddonsPath,
    autoDetectPath: s.autoDetectPath,
    fetchSettings: s.fetchSettings,
    fetchStatus: s.fetchStatus,
    refreshAll: s.refreshAll,
    status: s.status,
    // 只要数量：订阅整个 mods 数组会让「切换任意一个 Mod」都重渲染设置页，
    // 而这里唯一用到它的地方是「当前已检测到 N 个 Mod」。
    modCount: s.mods.length,
    background: s.background,
    setBackground: s.setBackground,
    showMascot: s.showMascot,
    toggleMascot: s.toggleMascot,
    themeTransition: s.themeTransition,
    toggleThemeTransition: s.toggleThemeTransition,
    accentColor: s.accentColor,
    setAccentColor: s.setAccentColor,
    showFps: s.showFps,
    toggleFps: s.toggleFps,
    uiScale: s.uiScale,
    setUiScale: s.setUiScale,
    fetchUiScale: s.fetchUiScale,
    uiFontKey: s.uiFontKey,
    setUiFont: s.setUiFont,
    gpuAccelerationDisabled: s.gpuAccelerationDisabled,
    gpuAccelerationLoading: s.gpuAccelerationLoading,
    fetchGpuAccelerationStatus: s.fetchGpuAccelerationStatus,
    toggleGpuAcceleration: s.toggleGpuAcceleration,
    exportLogs: s.exportLogs,
    workshopUpdates: s.workshopUpdates,
    checkWorkshopUpdates: s.checkWorkshopUpdates,
    cancelWorkshopCheck: s.cancelWorkshopCheck,
    setWorkshopUpdateSettings: s.setWorkshopUpdateSettings,
  })));

  // `/api/status` 新增的字段（本任务只改设置页，不动 store 的类型定义，
  // 所以这里按「可选扩展字段」读，老后端没有它时是 undefined，不会崩）。
  const baseline = (status as { official_baseline?: OfficialBaseline } | null)?.official_baseline;

  const [inputPath, setInputPath] = useState(addonsPath || '');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [bgProcessing, setBgProcessing] = useState(false);
  // 「禁用动图」开关（性能分区）：偏好存在 localStorage 里（见 utils/animationPreference.ts），
  // 没放进 zustand —— 每张卡片的渲染路径都要读它，走 store 会让整个 Mod 列表重渲染
  const [cardAnim, setCardAnim] = useState(cardAnimationEnabled);

  // 本地缓存（封面 / VPK 索引 / 元数据 / 清单）的体积与清理
  const [cacheInfo, setCacheInfo] = useState<{ total_bytes: number; total_files: number } | null>(null);
  const [cacheCleaning, setCacheCleaning] = useState(false);

  const loadCacheStats = async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/cache/stats`);
      if (res.ok) setCacheInfo(await res.json());
    } catch {
      // 统计失败不影响其它设置项；点「清理缓存」时会再报一次明确的原因
    }
  };

  useEffect(() => {
    void loadCacheStats();
  }, []);

  const handleCleanCache = async () => {
    setCacheCleaning(true);
    try {
      const res = await fetch(`${getApiBase()}/api/cache/gc`, { method: 'POST' });
      const data = await res.json();
      if (!data?.ok) {
        showToast(data?.reason || '清理失败，请稍后重试', 'warning');
        return;
      }
      setCacheInfo(data);
      showToast(
        `已清理 ${data.removed_files} 个缓存文件，释放 ${formatBytes(data.freed_bytes)}`,
        'success',
      );
    } catch {
      showToast('清理失败：无法连接到后端服务', 'error');
    } finally {
      setCacheCleaning(false);
    }
  };

  useEffect(() => {
    fetchSettings();
    // 官方基准状态（/api/status.official_baseline）在这里再拉一次：它决定是否显示
    // 「冲突判定已降级」的提示，而用户很可能就是刚从「我的 Mod」页发现问题才进来的。
    // 后端按 pak01 的 mtime 缓存，重复拉只是一次 stat。
    fetchStatus();
    fetchGpuAccelerationStatus();
    // 主进程在窗口创建时就按配置文件设置了 zoom factor：这里同步一次，
    // 保证设置页显示的比例与实际生效的一致（localStorage 只用于首屏兜底）
    fetchUiScale();
  }, []);

  // ── Steam API Key ────────────────────────────────────────────────
  // 只在这里存「是否配置 + 指纹 + 存储方式」，后端从不把 key 原文回传。
  type KeyStorage = 'dpapi' | 'plaintext' | 'env' | 'none';
  const [keyState, setKeyState] = useState<{
    configured: boolean;
    masked: string;
    storage?: KeyStorage;
    readable?: boolean;
  }>({
    configured: false,
    masked: '',
  });
  const [keyInput, setKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState<'idle' | 'testing' | 'saving'>('idle');
  const [keyMsg, setKeyMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadKeyState = async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/settings/steam-key`);
      if (res.ok) setKeyState(await res.json());
    } catch {
      // 读不到不影响页面其它部分；点保存时会再报一次
    }
  };

  useEffect(() => { void loadKeyState(); }, []);

  const keyBody = (key: string) => JSON.stringify({ key });

  const handleTestKey = async () => {
    const key = keyInput.trim();
    if (!key) { setKeyMsg({ kind: 'err', text: '先把 key 粘进来' }); return; }
    setKeyBusy('testing');
    setKeyMsg(null);
    try {
      const res = await fetch(`${getApiBase()}/api/settings/steam-key/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: keyBody(key),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setKeyMsg({ kind: 'err', text: data.detail || '测试失败' });
        return;
      }
      setKeyMsg({
        kind: 'ok',
        text: `可以用：${data.host} 响应 ${data.elapsed_ms}ms，工坊共 ${Number(data.total || 0).toLocaleString()} 个条目`,
      });
    } catch (e) {
      setKeyMsg({ kind: 'err', text: `测试失败：${(e as Error).message}` });
    } finally {
      setKeyBusy('idle');
    }
  };

  const handleSaveKey = async () => {
    const key = keyInput.trim();
    setKeyBusy('saving');
    setKeyMsg(null);
    try {
      const res = await fetch(`${getApiBase()}/api/settings/steam-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: keyBody(key),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setKeyMsg({ kind: 'err', text: data.detail || '保存失败' });
        return;
      }
      setKeyState({
        configured: !!data.configured,
        masked: data.masked || '',
        storage: data.storage,
        readable: true,
      });
      setKeyInput('');
      if (data.configured) {
        showToast('已保存：创意工坊改为走 Steam API（每页 100 条，带好评数 / 下载量）', 'success');
      } else {
        showToast('已清除 API Key，创意工坊回到网页模式', 'info');
      }
    } catch (e) {
      setKeyMsg({ kind: 'err', text: `保存失败：${(e as Error).message}` });
    } finally {
      setKeyBusy('idle');
    }
  };

  useEffect(() => {
    setInputPath(addonsPath || '');
  }, [addonsPath]);

  const handleSave = async () => {
    if (!inputPath.trim()) return;
    setSaveStatus('saving');
    const success = await setAddonsPath(inputPath.trim());
    if (success) {
      setSaveStatus('saved');
      await refreshAll();
      setTimeout(() => setSaveStatus('idle'), 2000);
    } else {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  const handleAutoDetect = async () => {
    setSaveStatus('saving');
    const ok = await autoDetectPath();
    // 以前无论成败都显示「已保存 ✓」：检测失败（没装游戏、装在别的盘）时
    // 用户完全看不出来，只会觉得点了没反应。
    setSaveStatus(ok ? 'saved' : 'error');
    setTimeout(() => setSaveStatus('idle'), ok ? 2000 : 3000);
  };

  const handleBrowse = () => {
    if ((window as any).electronAPI) {
      (window as any).electronAPI.selectFolder().then(async (folder: string | null) => {
        if (!folder) return;
        setInputPath(folder);
        setSaveStatus('saving');
        const success = await setAddonsPath(folder);
        if (success) {
          setSaveStatus('saved');
          await refreshAll();
          setTimeout(() => setSaveStatus('idle'), 2000);
        } else {
          setSaveStatus('error');
          setTimeout(() => setSaveStatus('idle'), 3000);
        }
      });
    }
  };

  const statusText = () => {
    if (saveStatus === 'saving') return '保存中...';
    if (saveStatus === 'saved') return '已保存 ✓';
    if (saveStatus === 'error') return '保存失败';
    return '保存';
  };

  // Background image picker
  // 原图可能几十 MB / 上亿像素，必须先压缩再存，否则全屏模糊会明显卡顿
  const handleSelectBgImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      setBgProcessing(true);
      // 用 blob URL 交给 canvas 解码，避免把大图整个转成 base64 字符串
      const objectUrl = URL.createObjectURL(file);
      try {
        const optimized = await optimizeBackgroundImage(objectUrl, true);
        if (!setBackground({ imagePath: optimized })) {
          showToast('背景图保存失败：图片过大或存储空间不足', 'error');
          return;
        }
        markBackgroundOptimized();
        showToast('背景图已应用（已自动压缩以提升性能）', 'success');
      } catch (err) {
        console.error('[Settings] 背景图处理失败:', err);
        showToast('背景图处理失败，请换一张图片试试', 'error');
      } finally {
        URL.revokeObjectURL(objectUrl);
        setBgProcessing(false);
      }
    };
    input.click();
  };

  const handleRemoveBg = () => {
    setBackground({ imagePath: null });
    markBackgroundOptimized();
  };

  return (
    <div className="content-area">
      <div className="page-content">
        <div className="page-header">
          <h1>设置</h1>
          <p>配置 Mod 管理器的工作路径与偏好</p>
        </div>

        {/* Addons Directory Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>Addons 目录</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              设置 Left 4 Dead 2 的 <code>addons</code> 目录路径，用于扫描和检测 Mod 文件。
              {status?.mod_count !== undefined && (
                <span className="settings-desc-stats">
                  当前已检测到 <strong>{modCount}</strong> 个 Mod
                </span>
              )}
            </p>

            <div className="settings-path-row">
              <input
                type="text"
                className="settings-path-input"
                placeholder="例如: C:\Program Files (x86)\Steam\steamapps\common\Left 4 Dead 2\left4dead2\addons"
                value={inputPath}
                onChange={(e) => setInputPath(e.target.value)}
              />
              <button className="settings-btn settings-btn--secondary" onClick={handleBrowse}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                </svg>
                浏览
              </button>
            </div>

            <div className="settings-actions">
              <button
                className={`settings-btn settings-btn--primary ${saveStatus === 'saving' ? 'loading' : ''}`}
                onClick={handleSave}
                disabled={saveStatus === 'saving' || !inputPath.trim()}
              >
                {statusText()}
              </button>
              <button className="settings-btn settings-btn--ghost" onClick={handleAutoDetect}>
                自动检测
              </button>
            </div>

            {addonsPath && (
              <div className="settings-current">
                <span className="settings-current-label">当前路径：</span>
                <span className="settings-current-path">{addonsPath}</span>
              </div>
            )}

            {/*
              官方基准缺失 = 冲突判定已降级。只在「配了 addons 路径、但拿不到
              pak01_dir.vpk」时显示：没配路径时上面那条路径提示已经说明了原因，
              再叠一句降级只会让人以为软件坏了。
              文案刻意不吓人：说清「现在只能看路径重叠」+「怎么恢复」。
            */}
            {addonsPath && baseline && !baseline.available && (
              <p className="settings-hint settings-hint--warn" style={{ marginTop: 10 }}>
                冲突判定已降级：只能显示路径重叠，无法判定真冲突。
                {baseline.reason === 'pak_not_found' ? (
                  <>
                    {' '}没找到游戏本体的 <code>left4dead2\pak01_dir.vpk</code>
                    {baseline.path ? <>（{baseline.path}）</> : null}
                    —— 通常是把 addons 路径指到了非游戏目录，或游戏本体不完整（验证游戏文件完整性可修复）。
                  </>
                ) : (
                  <>
                    {' '}{baseline.message || '读取 pak01_dir.vpk 失败（文件可能已损坏）'}
                    —— 验证游戏文件完整性后重新扫描即可恢复。
                  </>
                )}
              </p>
            )}
          </div>
        </div>

        {/* Steam API Key Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>Steam API Key（可选）</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              填了它，创意工坊就从「抓网页」切到「官方搜索接口」：每页 <strong>100 条</strong>（原 30 条）、
              带<strong>好评数 / 累计下载量</strong>、能显示<strong>精确结果总数</strong>、支持「最近更新」排序。
              不填也能用，只是每页 30 条、慢一点。
            </p>
            <p className="settings-desc" style={{ marginTop: -4 }}>
              保存时会用 Windows 凭据（DPAPI）加密，<strong>config.json 里只有密文</strong>，
              只有当前 Windows 账户能解开；日志和接口一律只显示指纹（首 4 末 4 位）。
              换电脑或换 Windows 账户后需要重新粘贴一次。
            </p>

            <div className="settings-path-row">
              <input
                type="password"
                className="settings-path-input"
                placeholder={keyState.configured ? `已保存：${keyState.masked}（重新粘贴可替换）` : '粘贴 32 位十六进制 key'}
                value={keyInput}
                onChange={(e) => { setKeyInput(e.target.value); setKeyMsg(null); }}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                className="settings-btn settings-btn--secondary"
                onClick={() => void handleTestKey()}
                disabled={keyBusy !== 'idle' || !keyInput.trim()}
              >
                {keyBusy === 'testing' ? '测试中…' : '测试'}
              </button>
            </div>

            <div className="settings-actions">
              <button
                className="settings-btn settings-btn--primary"
                onClick={() => void handleSaveKey()}
                disabled={keyBusy !== 'idle' || (!keyInput.trim() && !keyState.configured)}
              >
                {keyBusy === 'saving' ? '保存中…' : '保存'}
              </button>
              {keyState.configured && (
                <button
                  className="settings-btn settings-btn--ghost"
                  onClick={() => { setKeyInput(''); void handleSaveKey(); }}
                  disabled={keyBusy !== 'idle'}
                >
                  清除
                </button>
              )}
              <a
                className="settings-btn settings-btn--ghost"
                style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                onClick={() => {
                  const el = window.electronAPI as { openExternal?: (u: string) => Promise<void> } | undefined;
                  void el?.openExternal?.('https://steamcommunity.com/dev/apikey');
                }}
              >
                申请地址 ↗
              </a>
            </div>

            {keyMsg && (
              <div
                className="settings-current"
                style={{
                  color: keyMsg.kind === 'err' ? '#ef4444' : '#10b981',
                  borderColor: keyMsg.kind === 'err' ? 'rgba(239,68,68,.35)' : 'rgba(16,185,129,.35)',
                }}
              >
                <span className="settings-current-label">结果：</span>
                <span style={{ whiteSpace: 'normal' }}>{keyMsg.text}</span>
              </div>
            )}

            {keyState.readable === false && (
              <div
                className="settings-current"
                style={{ color: '#f59e0b', borderColor: 'rgba(245,158,11,.35)' }}
              >
                <span className="settings-current-label">注意：</span>
                <span style={{ whiteSpace: 'normal' }}>
                  配置文件里有加密过的 key，但当前账户解不开（换过 Windows 账户或电脑）。
                  重新粘贴保存一次即可。
                </span>
              </div>
            )}

            {keyState.configured && !keyMsg && (
              <div className="settings-current">
                <span className="settings-current-label">当前：</span>
                <span className="settings-current-path">已配置 {keyState.masked}</span>
                <span
                  style={{
                    marginLeft: 8,
                    whiteSpace: 'normal',
                    color: keyState.storage === 'plaintext' ? '#f59e0b' : 'var(--text-secondary)',
                  }}
                >
                  {keyState.storage === 'dpapi' && '· 已用 Windows 凭据加密，仅当前账户可解密'}
                  {keyState.storage === 'env' && '· 来自环境变量 L4DIRECTOR_STEAM_KEY'}
                  {keyState.storage === 'plaintext' && '· 明文保存在 config.json，重新保存一次即可加密'}
                </span>
              </div>
            )}

            <p className="settings-desc" style={{ marginTop: 10, fontSize: 11.5, opacity: 0.78 }}>
              Key 用 Windows 凭据加密后写在本机 <code>~/.l4d2-manager/config.json</code>，
              文件里只有密文；不会上传、不进仓库、日志与接口里只留指纹。
              申请要求：Steam 账号、在商店消费满 5 美元（受限账号无法使用 Web API）、域名随便填。
              Steam 使用条款要求 key 必须本人保管，所以它只能你自己填，不能随软件分发。
            </p>
          </div>
        </div>

        {/* 界面显示 Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>界面显示</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              觉得字太小、发虚时在这里整体放大。缩放由 Chromium 按放大后的像素重新渲染
              （不是把画面拉大），所以文字与图标是变清晰而不是变糊；对高分辨率屏幕、
              或系统缩放设为 125% 以上的机器效果最明显。
            </p>
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">界面缩放：{Math.round(uiScale * 100)}%</span>
                <span className="settings-toggle-hint">
                  默认 110%。修改后立即生效并记住，无需重启；调到 130%~150% 可明显放大文字。
                </span>
              </div>
              <div className="settings-scale-group">
                {UI_SCALE_OPTIONS.map((scale) => (
                  <button
                    key={scale}
                    className={`settings-scale-btn ${Math.abs(uiScale - scale) < 0.001 ? 'active' : ''}`}
                    onClick={() => setUiScale(scale)}
                  >
                    {Math.round(scale * 100)}%
                  </button>
                ))}
              </div>
            </div>

            {/* 界面字体 */}
            <div className="settings-toggle-row" style={{ marginTop: 12 }}>
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">
                  界面字体：{FONT_PRESETS.find((p) => p.key === uiFontKey)?.label}
                </span>
                <span className="settings-toggle-hint">
                  {FONT_PRESETS.find((p) => p.key === uiFontKey)?.hint}
                </span>
              </div>
              <div className="settings-scale-group">
                {FONT_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    className={`settings-scale-btn ${uiFontKey === preset.key ? 'active' : ''}`}
                    onClick={() => setUiFont(preset.key)}
                    title={preset.hint}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 主题色卡 Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>主题色</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              选一个主色，标题栏、按钮、选中态、卡片描边和背景氛围光会整套跟着换。
              日间/夜间会各自取合适的明度，不用手动调。
            </p>

            <div className="settings-swatches">
              {ACCENT_PRESETS.map((preset) => {
                const active = preset.color === accentColor;
                return (
                  <button
                    key={preset.key}
                    className={`settings-swatch ${active ? 'active' : ''}`}
                    style={{ '--swatch': preset.color } as CSSProperties}
                    onClick={() => setAccentColor(preset.color)}
                    title={`${preset.label} ${preset.color}`}
                  >
                    <span className="settings-swatch__dot" />
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* 创意工坊更新 Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>创意工坊更新</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              通过 Steam 的公开接口查已订阅条目有没有新版，和本地文件比时间即可判断，
              不需要登录，也不需要开着 Steam。发现新版后在「我的 Mod」页会标出「可更新」。
            </p>

            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">
                  {workshopUpdates?.auto_check !== false ? '启动时自动检查：已开启' : '启动时自动检查：已关闭'}
                </span>
                <span className="settings-toggle-hint">
                  打开软件后顺带查一次（后台进行，不影响 Mod 列表加载）；
                  关掉后只能手动点「检查更新」
                </span>
              </div>
              <button
                className={`settings-toggle-switch ${workshopUpdates?.auto_check !== false ? 'active' : ''}`}
                onClick={() => setWorkshopUpdateSettings({ auto_check: workshopUpdates?.auto_check === false })}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            <div className="settings-toggle-row" style={{ marginTop: 12 }}>
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">检查间隔</span>
                <span className="settings-toggle-hint">
                  距上次检查超过这么久才会自动再查，避免每次开软件都发请求
                </span>
              </div>
              <div className="settings-scale-group">
                {[3, 6, 12, 24].map((h) => (
                  <button
                    key={h}
                    className={`settings-scale-btn ${Math.round(workshopUpdates?.interval_hours ?? 6) === h ? 'active' : ''}`}
                    onClick={() => setWorkshopUpdateSettings({ interval_hours: h })}
                  >
                    {h} 小时
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-actions" style={{ marginTop: 12 }}>
              {workshopUpdates?.checking ? (
                // 检查在后台跑，这里给的是「停」而不是禁用：不用等它慢慢超时
                <button
                  className="settings-btn settings-btn--secondary"
                  onClick={cancelWorkshopCheck}
                  title="点一下立刻停止检查，已经查到的结果会保留"
                >
                  取消检查
                  {workshopUpdates.check_progress?.total
                    ? ` ${workshopUpdates.check_progress.stage === 'compare'
                        ? '比对中'
                        : `${workshopUpdates.check_progress.done}/${workshopUpdates.check_progress.total}`}`
                    : ' · 扫描本地中'}
                </button>
              ) : (
                <button
                  className="settings-btn settings-btn--secondary"
                  onClick={checkWorkshopUpdates}
                >
                  立即检查
                </button>
              )}
              <div className="settings-current">
                <span className="settings-current-label">上次检查：</span>
                <span className="settings-current-path">
                  {workshopUpdates?.checked_at
                    ? new Date(workshopUpdates.checked_at * 1000).toLocaleString('zh-CN')
                    : '还没有检查过'}
                  {workshopUpdates && workshopUpdates.update_count > 0
                    ? ` · ${workshopUpdates.update_count} 个可更新`
                    : ''}
                </span>
              </div>
            </div>
            {workshopUpdates?.last_error && !workshopUpdates.checking ? (
              <p className="settings-hint settings-hint--warn" style={{ marginTop: 8 }}>
                上次没查成功：{workshopUpdates.last_error}
              </p>
            ) : null}
          </div>
        </div>

        {/* 性能 Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>性能</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              界面发顿、风扇转得快时先从这里关。这些开关只改变界面的显示方式，
              不会改动任何 Mod 的启停状态，也不影响游戏内的实际加载。
            </p>

            {/* 禁用动图 */}
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">禁用动图</span>
                <span className="settings-toggle-hint">
                  {cardAnim
                    ? '打开后卡片封面只保留一张静态首帧：不再逐帧解码动图、不占额外显存，滚动时的开销降到最低。'
                    : '已禁用：卡片只显示静态首帧，不下载动图、不逐帧解码，也不占显存。'}
                  滚出视口的卡片本来就只有静态图，所以差别只在「正在看的那几张」。
                  {systemReducedMotion() && ' 系统开启了「减少动态效果」，这里默认已打开。'}
                </span>
              </div>
              <button
                className={`settings-toggle-switch ${cardAnim ? '' : 'active'}`}
                onClick={() => {
                  const next = !cardAnim;
                  setCardAnim(next);
                  setCardAnimationEnabled(next);
                }}
                title={cardAnim ? '点击禁用动图' : '点击恢复动图'}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            {/* 本地缓存统计与回收 */}
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">本地缓存</span>
                <span className="settings-toggle-hint">
                  {cacheInfo
                    ? `封面图、VPK 索引与元数据共 ${formatBytes(cacheInfo.total_bytes)}（${cacheInfo.total_files} 个文件）。`
                    : '正在统计占用…'}
                  Mod 被更新或删除后，旧缓存不会再被读到，但也不会自己从磁盘上消失。
                  清理只删「对应 Mod 已经不存在」的那部分，不动任何 Mod 文件与启停状态；
                  还需要的缓存会在下次扫描时重新生成。
                </span>
              </div>
              <button
                className={`settings-btn settings-btn--secondary ${cacheCleaning ? 'loading' : ''}`}
                style={{ flexShrink: 0 }}
                onClick={handleCleanCache}
                disabled={cacheCleaning}
                title="删除已经没有对应 Mod 的缓存文件"
              >
                {cacheCleaning ? '清理中…' : '清理缓存'}
              </button>
            </div>
          </div>
        </div>

        {/* 调试 Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>调试</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              性能与显示相关的诊断选项，遇到卡顿/渲染异常时可以在这里排查。
            </p>

            {/* FPS 显示 */}
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">
                  {showFps ? '标题栏 FPS 显示：已开启' : '标题栏 FPS 显示：已关闭'}
                </span>
                <span className="settings-toggle-hint">
                  在标题栏右侧显示实时帧率（绿 ≥55 / 橙 ≥30 / 红 &lt;30），用于判断界面是否掉帧
                </span>
              </div>
              <button
                className={`settings-toggle-switch ${showFps ? 'active' : ''}`}
                onClick={toggleFps}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            {/* 帧率诊断浮层入口：标题栏只给一个总帧率，想看动图的开销要看浮层 */}
            <div className="settings-gpu-note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span>
                按 <strong>Ctrl + Shift + F</strong> 打开帧率诊断浮层：可看到帧率波动、动图节奏偏差、
                单帧绘制耗时与长帧计数，并直接对照 180fps 对应的 5.56ms 单帧预算。
              </span>
            </div>

            {/* 主题切换过渡 */}
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">
                  {themeTransition ? '主题切换过渡：已开启' : '主题切换过渡：已关闭'}
                </span>
                <span className="settings-toggle-hint">
                  {themeTransition
                    ? '日间/夜间切换有约 0.25 秒的平滑淡入，观感更柔和（绘制开销略高）'
                    : '主题瞬间切换，最省性能（适合低配机器或关闭 GPU 加速时）'}
                </span>
              </div>
              <button
                className={`settings-toggle-switch ${themeTransition ? 'active' : ''}`}
                onClick={toggleThemeTransition}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            <p className="settings-desc" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
              提示：想对比效果可直接点标题栏右上角的主题按钮；觉得切换发顿就把「主题切换过渡」关掉。
            </p>
          </div>
        </div>

        {/* Mascot Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>小春看板娘</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              在应用右下角显示或隐藏小春看板娘图标，支持拖拽到任意位置。
            </p>
            <div className="settings-actions">
              <button
                className={`settings-btn ${showMascot ? 'settings-btn--primary' : 'settings-btn--ghost'}`}
                onClick={toggleMascot}
              >
                {showMascot ? '✓ 显示中' : '隐藏中'}
              </button>
            </div>
          </div>
        </div>

        {/* GPU 硬件加速 Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>GPU 硬件加速</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              控制 Electron 是否使用 GPU 硬件加速渲染界面。禁用 GPU 加速可以解决某些显卡驱动兼容性问题（如黑屏、花屏），
              但可能会增加 CPU 占用并略微降低界面流畅度。
            </p>
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">
                  {gpuAccelerationDisabled ? '已禁用' : '已启用'}
                </span>
                <span className="settings-toggle-hint">
                  {gpuAccelerationDisabled
                    ? '使用 CPU 渲染，兼容性更好，性能较低'
                    : '使用 GPU 渲染，性能更佳，部分显卡可能有兼容性问题'}
                </span>
              </div>
              <button
                className={`settings-toggle-switch ${!gpuAccelerationDisabled ? 'active' : ''}`}
                onClick={toggleGpuAcceleration}
                disabled={gpuAccelerationLoading}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>
            <div className="settings-gpu-note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span>更改此设置需要<strong>重启应用</strong>后才能生效。</span>
            </div>
          </div>
        </div>

        {/* Background Section */}
        <div className="content-section">
          <div className="section-header">
            <h2>背景设置</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              选择一张本地图片作为应用背景，可无级调节毛玻璃模糊、暗化程度与背景透明度
              （透明度越高背景越明显）。较大的图片会自动压缩到合适分辨率后再使用，避免影响性能。
              <br />
              {background.imagePath
                ? '「界面透明度」控制内部窗口（容器底色、侧边栏、内容区、卡片、标题栏）的通透程度：数值越高越透明，100% 时可直接透出底层的背景图。'
                : '选择背景图后，「界面透明度」可让内部窗口（容器底色、侧边栏、内容区、卡片、标题栏）变透，从而直接透出背景图。'}
            </p>

            {/* Preview：与主界面保持一致的图层结构（背景图 + 暗化层 + 整体透明度） */}
            <div className="bg-preview">
              {background.imagePath ? (
                <div
                  className="bg-preview__layer"
                  style={background.opacity < 100 ? { opacity: background.opacity / 100 } : undefined}
                >
                  <div
                    className="bg-preview__image"
                    style={{
                      backgroundImage: `url("${background.imagePath}")`,
                      filter: `blur(${background.blur}px)`,
                    }}
                  />
                  <div
                    className="bg-preview__dim"
                    style={{ opacity: background.dim / 100 }}
                  />
                </div>
              ) : (
                <div className="bg-preview__placeholder">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="M21 15l-4-4-6 6-3-3-5 5" />
                  </svg>
                  <span>未选择背景</span>
                </div>
              )}
            </div>

            {/* Select button */}
            <div className="settings-actions" style={{ marginTop: 12 }}>
              <button
                className="settings-btn settings-btn--primary"
                onClick={handleSelectBgImage}
                disabled={bgProcessing}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                {bgProcessing ? '处理中...' : '选择图片'}
              </button>
              {background.imagePath && (
                <button className="settings-btn settings-btn--ghost danger" onClick={handleRemoveBg}>
                  移除背景
                </button>
              )}
            </div>

            {/* Blur slider（无级） */}
            <div className="bg-slider-group">
              <div className="bg-slider-header">
                <span className="bg-slider-label">毛玻璃模糊</span>
                <span className="bg-slider-value">{formatStepless(background.blur)}px</span>
              </div>
              <input
                type="range"
                className="bg-slider"
                min="0"
                max="20"
                step="0.1"
                value={background.blur}
                onChange={(e) => setBackground({ blur: readStepless(e) })}
              />
              <div className="bg-slider-marks">
                <span>清晰</span>
                <span>模糊</span>
              </div>
            </div>

            {/* Dim slider（无级） */}
            <div className="bg-slider-group">
              <div className="bg-slider-header">
                <span className="bg-slider-label">暗化程度</span>
                <span className="bg-slider-value">{formatStepless(background.dim)}%</span>
              </div>
              <input
                type="range"
                className="bg-slider"
                min="0"
                max="80"
                step="0.1"
                value={background.dim}
                onChange={(e) => setBackground({ dim: readStepless(e) })}
              />
              <div className="bg-slider-marks">
                <span>明亮</span>
                <span>暗</span>
              </div>
            </div>

            {/* Opacity slider（无级）：数值越高，背景越明显 */}
            <div className="bg-slider-group">
              <div className="bg-slider-header">
                <span className="bg-slider-label">背景透明度</span>
                <span className="bg-slider-value">{formatStepless(background.opacity)}%</span>
              </div>
              <input
                type="range"
                className="bg-slider"
                min="0"
                max="100"
                step="0.1"
                value={background.opacity}
                onChange={(e) => setBackground({ opacity: readStepless(e) })}
              />
              <div className="bg-slider-marks">
                <span>隐藏</span>
                <span>越明显</span>
              </div>
            </div>

            {/* UI transparency slider（无级）：数值越高，内部窗口越透（仅毛玻璃模式可用） */}
            <div className={`bg-slider-group${background.imagePath ? '' : ' bg-slider-group--disabled'}`}>
              <div className="bg-slider-header">
                <span className="bg-slider-label">界面透明度</span>
                <span className="bg-slider-value">{formatStepless(background.uiTransparency)}%</span>
              </div>
              <input
                type="range"
                className="bg-slider"
                min="0"
                max="100"
                step="0.1"
                value={background.uiTransparency}
                disabled={!background.imagePath}
                onChange={(e) => setBackground({ uiTransparency: readStepless(e) })}
              />
              <div className="bg-slider-marks">
                <span>实心（默认）</span>
                <span>全通透</span>
              </div>
            </div>
          </div>
        </div>

        {/* 关于 Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>关于</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              L4Director —— Left 4 Dead 2 Mod 管理器
              {IS_BETA && '。当前是预发布版本，功能可能随时调整，遇到问题欢迎导出日志反馈。'}
            </p>
            <UpdateSection />
          </div>
        </div>

        {/* 日志导出 Section */}
        <div className="content-section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <h2>导出日志</h2>
          </div>
          <div className="settings-group">
            <p className="settings-desc">
              当应用出现异常时，可以将运行日志和系统信息导出为 ZIP 文件，发送给开发者以便排查问题。
              导出的数据包括系统信息、后端日志、Mod 元数据快照，<strong>不包含 Mod 文件本身</strong>。
            </p>
            <div className="settings-actions">
              <button className="settings-btn settings-btn--primary" onClick={exportLogs}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                导出日志
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
