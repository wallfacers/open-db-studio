import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Clock, Check, AlertCircle, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryStore } from '../../store/queryStore';
import type { QueryHistory } from '../../types';

interface QueryHistoryPickerProps {
  connectionId: number | null;
  onSelect: (entry: QueryHistory) => void;
  onClose: () => void;
}

export const QueryHistoryPicker: React.FC<QueryHistoryPickerProps> = ({
  connectionId,
  onSelect,
  onClose,
}) => {
  const { t } = useTranslation();
  const { queryHistory, loadHistory } = useQueryStore();
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (connectionId) {
      loadHistory(connectionId);
    }
  }, [connectionId, loadHistory]);

  const filtered = queryHistory.filter((h) => {
    if (!search) return true;
    return h.sql.toLowerCase().includes(search.toLowerCase());
  }).slice(0, 50); // 限制显示数量

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[activeIndex]) {
          onSelect(filtered[activeIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [filtered, activeIndex, onSelect, onClose]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  if (!connectionId) {
    return (
      <div className="absolute bottom-full mb-1 left-0 right-0 z-30 bg-background-panel border border-border-strong rounded-lg shadow-lg p-3">
        <p className="text-[12px] text-foreground-muted text-center">
          {t('assistant.queryHistory.noConnection', { defaultValue: '请先选择数据库连接' })}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="absolute bottom-full mb-1 left-0 right-0 z-30 bg-background-panel border border-border-strong rounded-lg shadow-lg overflow-hidden max-h-64 flex flex-col"
    >
      {/* 搜索栏 */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border-default">
        <Search size={12} className="text-foreground-ghost flex-shrink-0" />
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setActiveIndex(0); }}
          placeholder={t('assistant.queryHistory.searchPlaceholder', { defaultValue: '搜索历史查询...' })}
          className="flex-1 bg-transparent text-[12px] text-foreground-default outline-none placeholder:text-foreground-ghost"
          autoFocus
        />
        <button onClick={onClose} className="text-foreground-ghost hover:text-foreground-muted transition-colors">
          <X size={12} />
        </button>
      </div>

      {/* 查询列表 */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-foreground-ghost">
            {t('assistant.queryHistory.empty', { defaultValue: '暂无查询历史' })}
          </div>
        ) : (
          filtered.map((entry, i) => (
            <button
              key={entry.id}
              onClick={() => onSelect(entry)}
              onMouseEnter={() => setActiveIndex(i)}
              className={`w-full text-left px-2.5 py-1.5 border-b border-border-default transition-colors ${
                i === activeIndex ? 'bg-background-hover' : 'hover:bg-background-elevated'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                {entry.error_msg ? (
                  <AlertCircle size={10} className="text-error flex-shrink-0" />
                ) : (
                  <Check size={10} className="text-accent flex-shrink-0" />
                )}
                <span className="text-[10px] text-foreground-ghost flex items-center gap-1">
                  <Clock size={9} />
                  {formatTime(entry.executed_at)}
                </span>
                {entry.duration_ms != null && (
                  <span className="text-[10px] text-foreground-ghost">{entry.duration_ms}ms</span>
                )}
                {entry.row_count != null && !entry.error_msg && (
                  <span className="text-[10px] text-foreground-ghost">{entry.row_count} rows</span>
                )}
              </div>
              <div className="text-[11px] font-mono text-foreground-default truncate">
                {entry.sql.slice(0, 120)}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
