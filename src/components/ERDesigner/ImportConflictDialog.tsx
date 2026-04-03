import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConflictAction, ConflictResolution } from '../../types';

interface ImportConflictDialogProps {
  open: boolean;
  conflictTables: string[];
  onConfirm: (resolutions: ConflictResolution[]) => void;
  onCancel: () => void;
}

const ACTION_OPTIONS: { value: ConflictAction; labelKey: string }[] = [
  { value: 'skip', labelKey: 'erDesigner.importConflictSkip' },
  { value: 'overwrite', labelKey: 'erDesigner.importConflictOverwrite' },
  { value: 'rename', labelKey: 'erDesigner.importConflictRename' },
];

export const ImportConflictDialog: React.FC<ImportConflictDialogProps> = ({
  open,
  conflictTables,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [actions, setActions] = useState<Record<string, ConflictAction>>(() => {
    const init: Record<string, ConflictAction> = {};
    for (const name of conflictTables) {
      init[name] = 'rename';
    }
    return init;
  });

  // Bulk action: apply same action to all
  const [bulkAction, setBulkAction] = useState<ConflictAction | ''>('');

  if (!open) return null;

  const handleBulkChange = (action: ConflictAction) => {
    setBulkAction(action);
    const next: Record<string, ConflictAction> = {};
    for (const name of conflictTables) {
      next[name] = action;
    }
    setActions(next);
  };

  const handleConfirm = () => {
    const resolutions: ConflictResolution[] = conflictTables.map((name) => ({
      table_name: name,
      action: actions[name] || 'rename',
    }));
    onConfirm(resolutions);
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40">
      <div className="bg-background-base border border-border-default rounded-lg shadow-xl w-[520px] max-h-[70vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border-default">
          <h3 className="text-sm font-medium text-foreground-default">
            {t('erDesigner.importConflictTitle') || '导入冲突处理'}
          </h3>
          <p className="text-xs text-foreground-muted mt-1">
            {t('erDesigner.importConflictDesc') ||
              '以下表名与当前项目已有表重复，请选择处理方式：'}
          </p>
        </div>

        {/* Bulk action */}
        <div className="px-4 py-2 border-b border-border-default flex items-center gap-2">
          <span className="text-xs text-foreground-muted">
            {t('erDesigner.importConflictBulk') || '全部设为：'}
          </span>
          {ACTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleBulkChange(opt.value)}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                bulkAction === opt.value
                  ? 'bg-accent text-white border-accent'
                  : 'border-border-default text-foreground-default hover:bg-background-hover'
              }`}
            >
              {t(opt.labelKey) || opt.value}
            </button>
          ))}
        </div>

        {/* Table list */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {conflictTables.map((tableName) => (
            <div
              key={tableName}
              className="flex items-center justify-between py-1.5 border-b border-border-default last:border-0"
            >
              <span className="text-xs text-foreground-default font-mono truncate max-w-[200px]">
                {tableName}
              </span>
              <div className="flex items-center gap-1">
                {ACTION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      setActions((prev) => ({ ...prev, [tableName]: opt.value }));
                      setBulkAction('');
                    }}
                    className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                      actions[tableName] === opt.value
                        ? 'bg-accent text-white border-accent'
                        : 'border-border-default text-foreground-muted hover:bg-background-hover'
                    }`}
                  >
                    {t(opt.labelKey) || opt.value}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border-default flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-foreground-muted hover:bg-background-hover rounded border border-border-default transition-colors"
          >
            {t('common.cancel') || '取消'}
          </button>
          <button
            onClick={handleConfirm}
            className="px-3 py-1.5 text-xs text-white bg-accent hover:bg-accent/90 rounded transition-colors"
          >
            {t('erDesigner.importConfirm') || '确认导入'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportConflictDialog;
