import { useRef, useState, useCallback } from 'react';
import { useStore } from '../store/useStore';
// 与其它页面一致：.content-area 的布局由 ContentArea.scss 提供（否则容器撑不满主区域，webview 高度会塌陷）
import './ContentArea.scss';

// Declare webview type for Electron
declare global {
  interface HTMLWebViewElement extends HTMLElement {
    src: string;
    reload: () => void;
    canGoBack: () => boolean;
    canGoForward: () => boolean;
    goBack: () => void;
    goForward: () => void;
    addEventListener: (event: string, callback: (...args: any[]) => void) => void;
    removeEventListener: (event: string, callback: (...args: any[]) => void) => void;
  }
  interface HTMLElementTagNameMap {
    'webview': HTMLWebViewElement;
  }
}

export function WorkshopPage() {
  const { steamUser } = useStore();
  const [navUrl, setNavUrl] = useState('https://steamcommunity.com/app/550/workshop/');
  const [addressInput, setAddressInput] = useState(navUrl);
  const [isLoading, setIsLoading] = useState(false);

  const handleNavigate = () => {
    let url = addressInput.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    setNavUrl(url);
    setAddressInput(url);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNavigate();
    }
  };

  const handleRefresh = () => {
    const webview = document.querySelector('webview');
    if (webview) webview.reload();
  };

  const handleGoBack = () => {
    const webview = document.querySelector('webview');
    if (webview && webview.canGoBack()) webview.goBack();
  };

  const handleGoForward = () => {
    const webview = document.querySelector('webview');
    if (webview && webview.canGoForward()) webview.goForward();
  };

  const handleOpenInBrowser = useCallback(() => {
    // Use Electron IPC to open in default browser
    const url = navUrl;
    // Try the exposed API from preload
    try {
      (window as any).openExternal?.(url);
    } catch {
      window.open(url, '_blank');
    }
  }, [navUrl]);

  return (
    <div className="content-area" style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-color)',
        background: 'var(--bg-primary-solid)',
        flexShrink: 0,
      }}>
        {/* Login indicator + open in browser */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginRight: '4px',
          flexShrink: 0,
        }}>
          {steamUser && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12px',
              color: 'var(--text-secondary)',
            }}>
              <img
                src={`/api/auth/steam/avatar?t=${Date.now()}`}
                alt=""
                style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover' }}
              />
              <span style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{steamUser.nickname}</span>
            </div>
          )}
          <button
            onClick={handleOpenInBrowser}
            title="在浏览器中打开（使用已登录的账号）"
            style={{
              border: '1px solid var(--border-color)',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--accent-text)',
              padding: '4px 8px',
              borderRadius: '6px',
              fontSize: '12px',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--font-family)',
            }}
          >
            在浏览器打开 ↗
          </button>
        </div>

        {/* Nav buttons */}
        <button
          onClick={handleGoBack}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          onClick={handleGoForward}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          onClick={handleRefresh}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </button>

        {/* Address bar */}
        <div style={{ flex: 1, display: 'flex', gap: '6px' }}>
          <input
            type="text"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              flex: 1,
              padding: '6px 12px',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              background: 'var(--bg-card-hover)',
              color: 'var(--text-primary)',
              fontSize: '13px',
              outline: 'none',
              fontFamily: 'var(--font-family)',
            }}
            placeholder="输入网址..."
          />
          <button
            onClick={handleNavigate}
            style={{
              padding: '6px 12px',
              border: 'none',
              borderRadius: '8px',
              background: 'var(--accent)',
              color: 'var(--on-accent)',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              fontFamily: 'var(--font-family)',
            }}
          >
            前往
          </button>
        </div>

        {isLoading && (
          <div className="workshop-spinner" />
        )}
      </div>

      {/* Browser area - always show webview} */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <webview
          id="workshop-webview"
          src={navUrl}
          partition="persist:steamworkshop"
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      </div>
    </div>
  );
}
