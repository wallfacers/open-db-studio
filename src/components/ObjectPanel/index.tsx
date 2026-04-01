import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useConnectionStore } from '../../store';
import type { ViewMeta, ProcedureMeta, FullSchemaInfo } from '../../types';
import type { ToastLevel } from '../Toast';

interface Props {
  showToast: (msg: string, level?: ToastLevel) => void;
}

export const ObjectPanel: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation();
  const { activeConnectionId } = useConnectionStore();
  const [views, setViews] = useState<ViewMeta[]>([]);
  const [procedures, setProcedures] = useState<ProcedureMeta[]>([]);
  const [selectedView, setSelectedView] = useState<ViewMeta | null>(null);

  useEffect(() => {
    if (!activeConnectionId) return;
    setViews([]);
    setProcedures([]);
    setSelectedView(null);
    invoke<FullSchemaInfo>('get_full_schema', { connectionId: activeConnectionId })
      .then(schema => {
        setViews(schema.views);
        setProcedures(schema.procedures);
      })
      .catch(e => showToast(String(e), 'error'));
  }, [activeConnectionId]);

  if (!activeConnectionId) {
    return (
      <div className="p-4 text-[var(--foreground-muted)] text-xs">
        {t('objectPanel.selectConnection')}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-auto text-xs relative">
      {/* Views Section */}
      <div>
        <div className="px-3 py-2 text-[var(--foreground-muted)] font-medium text-[11px] uppercase tracking-wider flex items-center justify-between">
          <span>{t('objectPanel.views')} ({views.length})</span>
        </div>
        {views.length === 0 ? (
          <div className="px-4 py-1 text-[var(--foreground-ghost)] italic">{t('objectPanel.noViews')}</div>
        ) : (
          views.map(v => (
            <div
              key={v.name}
              className="px-4 py-1.5 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] cursor-pointer flex items-center gap-2"
              onClick={() => setSelectedView(v)}
            >
              <span className="text-[var(--node-table)] text-[10px] font-bold flex-shrink-0">VIEW</span>
              <span className="truncate">{v.name}</span>
            </div>
          ))
        )}
      </div>

      {/* Procedures / Functions Section */}
      <div className="border-t border-[var(--border-default)] mt-1">
        <div className="px-3 py-2 text-[var(--foreground-muted)] font-medium text-[11px] uppercase tracking-wider">
          {t('objectPanel.procedures')} ({procedures.length})
        </div>
        {procedures.length === 0 ? (
          <div className="px-4 py-1 text-[var(--foreground-ghost)] italic">{t('objectPanel.noProcedures')}</div>
        ) : (
          procedures.map(p => (
            <div
              key={`${p.routine_type}-${p.name}`}
              className="px-4 py-1.5 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] cursor-pointer flex items-center gap-2"
            >
              <span className="text-[var(--warning)] text-[10px] font-bold flex-shrink-0">
                {p.routine_type === 'FUNCTION' ? 'FN' : 'PROC'}
              </span>
              <span className="truncate">{p.name}</span>
            </div>
          ))
        )}
      </div>

      {/* View Definition Overlay */}
      {selectedView && (
        <div className="absolute inset-0 bg-[var(--background-base)] flex flex-col z-10">
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-default)]">
            <span className="text-[var(--foreground-default)] text-xs font-medium truncate">{selectedView.name}</span>
            <button
              onClick={() => setSelectedView(null)}
              className="text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] text-xs ml-2 flex-shrink-0"
            >
              ✕
            </button>
          </div>
          <pre className="flex-1 overflow-auto p-3 text-xs text-[var(--foreground-default)] font-mono whitespace-pre-wrap">
            {selectedView.definition ?? t('objectPanel.noDefinition')}
          </pre>
        </div>
      )}
    </div>
  );
};
