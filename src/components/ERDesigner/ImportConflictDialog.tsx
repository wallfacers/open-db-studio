import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BaseModal } from '../common/BaseModal';
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

const btnClass = (active: boolean, muted = false) =>
  `px-2 py-0.5 text-xs rounded border transition-colors ${
    active
      ? 'bg-accent text-white border-accent'
      : `border-border-default ${muted ? 'text-foreground-muted' : 'text-foreground-default'} hover:bg-background-hover`
  }`;

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
    <BaseModal
      title={t('erDesigner.importConflictTitle') || '导入冲突处理'}
      onClose={onCancel}
      width={520}
      footerButtons={[
        { label: t('common.cancel') || '取消', onClick: onCancel, variant: 'secondary' },
        { label: t('erDesigner.importConfirm') || '确认导入', onClick: handleConfirm, variant: 'primary' },
      ]}
    >
      <p className="text-xs text-foreground-muted mb-3">
        {t('erDesigner.importConflictDesc') ||
          '以下表名与当前项目已有表重复，请选择处理方式：'}
      </p>

      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-foreground-muted">
          {t('erDesigner.importConflictBulk') || '全部设为：'}
        </span>
        {ACTION_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => handleBulkChange(opt.value)}
            className={btnClass(bulkAction === opt.value)}
          >
            {t(opt.labelKey) || opt.value}
          </button>
        ))}
      </div>

      <div className="max-h-[40vh] overflow-y-auto">
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
                  className={btnClass(actions[tableName] === opt.value, true)}
                >
                  {t(opt.labelKey) || opt.value}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </BaseModal>
  );
};

export default ImportConflictDialog;
