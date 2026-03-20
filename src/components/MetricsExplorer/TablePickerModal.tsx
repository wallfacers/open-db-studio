import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface TableWithColumnCount {
  name: string;
  column_count: number;
}

interface TablePickerModalProps {
  connectionId: number;
  database?: string;
  schema?: string;
  onConfirm: (tableNames: string[], goToTasks: boolean) => void;
  onClose: () => void;
}

export function TablePickerModal({
  connectionId,
  database,
  schema,
  onConfirm,
  onClose,
}: TablePickerModalProps) {
  const { t } = useTranslation();
  const [tables, setTables] = useState<TableWithColumnCount[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [goToTasks, setGoToTasks] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    invoke<TableWithColumnCount[]>('list_tables_with_column_count', {
      connectionId,
      database,
      schema,
    })
      .then((result) => {
        setTables(result);
        setSelected(new Set(result.map((t) => t.name)));
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg || t('metricsExplorer.metricTab.loadFailed'));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [connectionId, database, schema]);

  const toggleRow = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(tables.map((t) => t.name)));
  const clearAll = () => setSelected(new Set());

  const scopeLabel = [database, schema].filter(Boolean).join(' > ');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-[#0d1117] border border-[#2a3f5a] rounded-lg shadow-2xl flex flex-col"
        style={{ width: '100%', maxWidth: 480 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a3f5a]">
          <span className="text-sm font-medium text-[#c8daea]">{t('metricsExplorer.tablePicker.title')}</span>
          <button
            className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* Scope label */}
        {scopeLabel && (
          <div className="px-4 pt-3 pb-1 text-xs text-[#7a9bb8]">{scopeLabel}</div>
        )}

        {/* Table list */}
        <div className="flex-1 overflow-y-auto px-2 py-1" style={{ maxHeight: 320 }}>
          {loading && (
            <div className="py-6 text-center text-sm text-[#7a9bb8]">{t('metricsExplorer.loading')}</div>
          )}
          {!loading && error && (
            <div className="py-4 px-3 text-sm text-red-400">{error}</div>
          )}
          {!loading && !error && tables.length === 0 && (
            <div className="py-6 text-center text-sm text-[#7a9bb8]">{t('metricsExplorer.tablePicker.noTables')}</div>
          )}
          {!loading && !error && tables.map((table) => {
            const isChecked = selected.has(table.name);
            return (
              <div
                key={table.name}
                className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-[#1a2639] select-none"
                onClick={() => toggleRow(table.name)}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleRow(table.name)}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-shrink-0 cursor-pointer accent-[#00c9a7]"
                />
                <span className="flex-1 text-sm text-[#c8daea] truncate">{table.name}</span>
                <span className="text-xs text-[#7a9bb8] flex-shrink-0">
                  ({t('metricsExplorer.tablePicker.columns', { count: table.column_count })})
                </span>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="border-t border-[#2a3f5a] px-4 py-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#7a9bb8]">{t('metricsExplorer.tablePicker.selected', { count: selected.size })}</span>
              <button
                className="text-xs text-[#7a9bb8] hover:text-[#00c9a7] transition-colors"
                onClick={selectAll}
              >
                {t('metricsExplorer.tablePicker.selectAll')}
              </button>
              <button
                className="text-xs text-[#7a9bb8] hover:text-[#00c9a7] transition-colors"
                onClick={clearAll}
              >
                {t('metricsExplorer.tablePicker.deselectAll')}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 rounded text-xs bg-[#1a2a3a] text-[#7a9bb8] hover:bg-[#2a3a4a] transition-colors"
                onClick={onClose}
              >
                {t('common.cancel')}
              </button>
              <button
                className="px-3 py-1.5 rounded text-xs bg-[#00c9a7] text-black hover:bg-[#00b090] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={selected.size === 0}
                onClick={() => onConfirm(Array.from(selected), goToTasks)}
              >
                {t('metricsExplorer.tablePicker.startGenerate')}
              </button>
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer self-end">
            <input
              type="checkbox"
              checked={goToTasks}
              onChange={(e) => setGoToTasks(e.target.checked)}
              className="accent-[#00c9a7] cursor-pointer"
            />
            <span className="text-xs text-[#7a9bb8]">{t('metricsExplorer.tablePicker.goToTasks')}</span>
          </label>
        </div>
      </div>
    </div>
  );
}
