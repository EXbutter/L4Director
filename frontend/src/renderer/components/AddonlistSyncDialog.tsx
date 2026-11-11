import { useStore } from '../store/useStore';

/** 弹窗里最多逐条列出的变更数量（其余只显示汇总，避免弹窗被撑爆） */
const MAX_LISTED = 8;

/**
 * 「检测到游戏内已更改，是否同步」询问弹窗。
 *
 * 游戏退出时会把 Add-ons 菜单里的启停状态写回 addonlist.txt；后端用内容指纹发现
 * 文件被软件以外的程序改过，但**不会**自动采纳 —— 由这里询问用户：
 *   * 同步：按游戏里的状态更新软件记录；
 *   * 忽略：保持软件里的设置（下次启动游戏时会以软件为准）。
 *
 * 这样既解决了「游戏里改的启停同步不回软件」，又不会让 Steam 云同步回来的旧配置
 * 悄悄盖掉用户在软件里的设置。
 */
export function AddonlistSyncDialog() {
  const pending = useStore((s) => s.pendingAddonlistChanges);
  const mods = useStore((s) => s.mods);
  const getModDisplayName = useStore((s) => s.getModDisplayName);
  const applyChanges = useStore((s) => s.applyAddonlistChanges);
  const dismissChanges = useStore((s) => s.dismissAddonlistChanges);

  if (pending.length === 0) return null;

  // 变更很多（例如整个整合包在游戏里被关掉）时只列前几项，避免弹窗被撑爆
  const listed = pending.slice(0, MAX_LISTED);
  const rest = pending.length - listed.length;

  const displayNameOf = (name: string) => {
    const custom = getModDisplayName(name);
    if (custom) return custom;
    const mod = mods.find((m) => m.name === name);
    return mod?.display_name || name;
  };

  return (
    <div className="modal-overlay" onClick={dismissChanges}>
      <div className="modal-content modal-content--wide" onClick={(e) => e.stopPropagation()}>
        <h3>检测到游戏内已更改，是否同步？</h3>
        <p className="modal-delete-text">
          游戏里（Add-ons 菜单）修改了 <strong>{pending.length}</strong> 个 Mod 的启用状态：
        </p>

        <div className="addonlist-sync-list">
          {listed.map((change) => (
            <div className="addonlist-sync-item" key={change.name}>
              <span className="addonlist-sync-item__name" title={change.name}>
                {displayNameOf(change.name)}
              </span>
              <span className="addonlist-sync-item__state">
                {change.previous ? '启用' : '禁用'} → <strong>{change.enabled ? '启用' : '禁用'}</strong>
              </span>
            </div>
          ))}
          {rest > 0 && <div className="addonlist-sync-more">…以及另外 {rest} 个 Mod</div>}
        </div>

        <p className="addonlist-sync-hint">
          「同步」会按游戏里的状态更新软件；「忽略」则保持软件里的设置，
          并把软件里的状态写回 addonlist.txt（游戏里也会跟着变回软件的状态）。
        </p>

        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={dismissChanges}>
            忽略
          </button>
          <button className="modal-btn modal-btn-primary" onClick={applyChanges}>
            同步
          </button>
        </div>
      </div>
    </div>
  );
}
