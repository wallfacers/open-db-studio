import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X, AlertTriangle } from 'lucide-react';
import { useEscClose } from '../../hooks/useEscClose';
import { useConnectionStore } from '../../store/connectionStore';
import type { ToastLevel } from '../Toast';

interface Props {
  connectionId: number;
  tableName: string;
  database?: string;
  schema?: string;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}

export const TruncateConfirmDialog: React.FC<Props> = ({
  connectionId, tableName, database, schema, onClose, onSuccess, showToast
}) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);

  const { connections } = useConnectionStore();
  const driver = connections.find(c => c.id === connectionId)?.driver ?? 'mysql';
  const isPostgres = driver === 'postgres' || driver === 'postgresql';

  useEscClose(onClose);

  const handleTruncate = async () => {
    setIsLoading(true);
    try {
      // 根据 driver 决定 SQL 方言
      const sql = isPostgres
        ? schema
          ? `TRUNCATE TABLE "${schema}"."${tableName}"`
          : `TRUNCATE TABLE "${tableName}"`
        : `TRUNCATE TABLE \`${tableName}\``;
      await invoke('execute_query', {
        connectionId,
        sql,
        database: database ?? null,
        schema: schema ?? null,
      });
      showToast(t('truncateConfirm.success'), 'success');
      onSuccess();
      onClose();
    } catch (e) {
      showToast(`${t('truncateConfirm.error')}: ${String(e)}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-background-panel border border-border-strong rounded-lg w-[420px] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border-default">
          <span className="text-error text-sm font-medium flex items-center gap-2">
            <AlertTriangle size={15} />
            {t('truncateConfirm.title')}
          </span>
          <button onClick={onClose} className="text-foreground-muted hover:text-foreground-default transition-colors duration-200">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          <p className="text-foreground-default text-sm">
            {t('truncateConfirm.warning', { table: tableName })}
          </p>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border-default">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-background-hover text-foreground-muted hover:text-foreground-default rounded text-xs transition-colors duration-200"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleTruncate}
            disabled={isLoading}
            className="px-3 py-1.5 bg-error/80 text-foreground hover:bg-error rounded text-xs disabled:opacity-50 transition-colors duration-200"
          >
            {isLoading ? t('common.executing') : t('truncateConfirm.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};
