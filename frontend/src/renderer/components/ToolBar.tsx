import { useState, useRef, useEffect } from 'react';
import './ToolBar.scss';

interface SortOption {
  value: string;
  label: string;
}

interface ToolBarProps {
  searchPlaceholder?: string;
  sortOptions: SortOption[];
  defaultSort?: string;
  onSearchChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onRefresh?: () => void;
  /** 当前视图：grid = 卡片墙，list = 单列列表。传了才会显示切换按钮 */
  viewMode?: 'grid' | 'list';
  onViewModeChange?: (mode: 'grid' | 'list') => void;
}

export function ToolBar({
  searchPlaceholder = '搜索...',
  sortOptions,
  defaultSort = '',
  onSearchChange,
  onSortChange,
  onRefresh,
  viewMode,
  onViewModeChange,
}: ToolBarProps) {
  const [searchValue, setSearchValue] = useState('');
  const [sortOpen, setSortOpen] = useState(false);
  const [selectedSort, setSelectedSort] = useState(defaultSort);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedLabel = sortOptions.find((o) => o.value === selectedSort)?.label || sortOptions[0]?.label || '排序';

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearch = (value: string) => {
    setSearchValue(value);
    onSearchChange(value);
  };

  const handleSort = (value: string) => {
    setSelectedSort(value);
    onSortChange(value);
    setSortOpen(false);
  };

  return (
    <div className="toolbar">
      {onRefresh && (
        <button className="toolbar__refresh" onClick={onRefresh} title="刷新">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      )}

      <div className="toolbar__search">
        <svg className="toolbar__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          type="text"
          className="toolbar__search-input"
          placeholder={searchPlaceholder}
          value={searchValue}
          onChange={(e) => handleSearch(e.target.value)}
        />
        {searchValue && (
          <button className="toolbar__search-clear" onClick={() => handleSearch('')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="toolbar__sort" ref={dropdownRef}>
        <button className="toolbar__sort-btn" onClick={() => setSortOpen(!sortOpen)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M6 12h12M10 18h4" />
          </svg>
          <span>{selectedLabel}</span>
          <svg
            className={`toolbar__sort-arrow ${sortOpen ? 'open' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {sortOpen && (
          <div className="toolbar__sort-dropdown">
            {sortOptions.map((option) => (
              <button
                key={option.value}
                className={`toolbar__sort-option ${selectedSort === option.value ? 'active' : ''}`}
                onClick={() => handleSort(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 视图切换：卡片墙 / 单列列表（只有传入 onViewModeChange 的页面才显示） */}
      {onViewModeChange && (
        <div className="toolbar__view" role="group" aria-label="布局方式">
          <button
            type="button"
            className={`toolbar__view-btn ${(viewMode ?? 'grid') === 'grid' ? 'active' : ''}`}
            onClick={() => onViewModeChange('grid')}
            title="卡片视图"
            aria-pressed={(viewMode ?? 'grid') === 'grid'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </button>
          <button
            type="button"
            className={`toolbar__view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => onViewModeChange('list')}
            title="列表视图"
            aria-pressed={viewMode === 'list'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="5" height="5" rx="1" />
              <line x1="11" y1="6.5" x2="21" y2="6.5" strokeLinecap="round" />
              <rect x="3" y="15" width="5" height="5" rx="1" />
              <line x1="11" y1="17.5" x2="21" y2="17.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
