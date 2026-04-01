import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryStore, useConnectionStore } from '../../store';

export function QueryHistory() {
  const { t } = useTranslation();
  const { queryHistory, loadHistory, setSql, activeTabId } = useQueryStore();
  const { activeConnectionId } = useConnectionStore();

  useEffect(() => {
    if (activeConnectionId) loadHistory(activeConnectionId);
  }, [activeConnectionId]);

  if (!activeConnectionId) {
    return <div className="p-4 text-[var(--foreground-muted)] text-sm">{t('queryHistory.selectConnectionFirst')}</div>;
  }

  return (
    <div className="h-full overflow-auto">
      {queryHistory.length === 0 ? (
        <div className="p-4 text-[var(--foreground-muted)] text-sm">{t('queryHistory.noQueryHistory')}</div>
      ) : (
        queryHistory.map((h) => (
          <div
            key={h.id}
            className="px-3 py-2 border-b border-[var(--border-default)] hover:bg-[var(--background-hover)] cursor-pointer"
            onClick={() => setSql(activeTabId, h.sql)}
          >
            <div className="font-mono text-xs text-[var(--foreground-default)] truncate">{h.sql}</div>
            <div className="flex gap-2 mt-1 text-xs text-[var(--foreground-muted)]">
              <span>{h.executed_at.slice(0, 19).replace('T', ' ')}</span>
              {h.duration_ms !== null && <span>{h.duration_ms}ms</span>}
              {h.row_count !== null && <span>{h.row_count} {t('queryHistory.rows')}</span>}
              {h.error_msg && <span className="text-red-400 truncate">{h.error_msg}</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
