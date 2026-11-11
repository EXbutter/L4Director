import { useEffect, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import { useStore } from '../store/useStore';
import { FONT_PRESETS } from '../utils/uiFont';
import { ACCENT_PRESETS } from '../utils/themeColor';
import { APP_VERSION, VERSION_DISPLAY, IS_BETA } from '../utils/appVersion';
import { markBackgroundOptimized, optimizeBackgroundImage } from '../utils/backgroundImage';
import { showToast } from './Toast';
// 与 MyModsPage / PacksPage 保持一致：.content-area 的布局（flex:1 + height:100%）定义在这里，
// 少了它设置页的容器无法撑满主区域，会出现“顶部栏与底部之间一条真空空隙、内容显示不全”的问题
import './ContentArea.scss';
import './SettingsPage.scss';

/** 无级滑杆的数值展示：去掉多余的小数位（8 -> 8，8.5 -> 8.5） */
function formatStepless(value: number): string {
  return Number(value.toFixed(1)).toString();
}

/** 无级滑杆取值：吸附到 0.1 精度，避免浮点误差写进本地存储 */
function readStepless(e: ChangeEvent<HTMLInputElement>): number {
  return Math.round(Number(e.target.value) * 10) / 10;
}

/**
 * 界面缩放的可选档位（1 = 100%）。
 * 默认 110%：字太小/发虚时用户往往只想「大一点」，但一步到位放太大又显得拥挤。
 */
const UI_SCALE_OPTIONS = [1, 1.1, 1.2, 1.3, 1.5];

export function SettingsPage() {
  const {
    addonsPath,
    setAddonsPath,
    autoDetectPath,
    fetchSettings,
    refreshAll,
    status,
    mods,
    loading,
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
  } = useStore();

  const [inputPath, setInputPath] = useState(addonsPath || '');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [bgProcessing, setBgProcessing] = useState(false);

  useEffect(() => {
    fetchSettings();
    fetchGpuAccelerationStatus();
    // 主进程在窗口创建时就按配置文件设置了 zoom factor：这里同步一次，
    // 保证设置页显示的比例与实际生效的一致（localStorage 只用于首屏兜底）
    fetchUiScale();
  }, []);

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
    await autoDetectPath();
    setSaveStatus('saved');
    setTimeout(() => setSaveStatus('idle'), 2000);
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
                  当前已检测到 <strong>{mods.length}</strong> 个 Mod
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
            <div className="settings-version-row">
              <span className="settings-version-row__label">版本</span>
              <code
                className={`settings-version-row__code${IS_BETA ? ' settings-version-row__code--beta' : ''}`}
                title={APP_VERSION}
              >
                {VERSION_DISPLAY}
              </code>
            </div>
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
