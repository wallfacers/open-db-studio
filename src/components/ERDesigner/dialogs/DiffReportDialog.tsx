import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertTriangle, Trash2, RefreshCw } from 'lucide-react';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { BaseModal } from '../../common/BaseModal';
import type { DiffResult, TableDiff, TableModDiff, ColumnModDiff, IndexDiff } from '../../../types';

export interface DiffReportDialogProps {
  visible: boolean;
  projectId: number;
  connectionInfo: { name: string; database: string } | null;
  onClose: () => void;
  onSyncToDb: (diff: DiffResult) => void;
  onSyncFromDb: (selectedChanges: SelectedChange[]) => void;
  onFullSync: () => void;
}

export type ChangeType = 'added_table' | 'removed_table' | 'modified_table';

export interface SelectedChange {
  type: ChangeType;
  table: string;
  column?: string;
  index?: string;
  changeData?: unknown;
}

interface ChangeItemProps {
  checked: boolean;
  onCheck: (checked: boolean) => void;
  icon: React.ReactNode;
  label: string;
  detail?: string;
}

const ChangeItem: React.FC<ChangeItemProps> = ({ checked, onCheck, icon, label, detail }) => (
  <label className="flex items-start gap-2 cursor-pointer hover:bg-border-default px-2 py-1 rounded transition-colors duration-150">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheck(e.target.checked)}
      className="accent-accent w-3 h-3 mt-0.5 flex-shrink-0"
    />
    <span className="text-foreground-muted flex-shrink-0">{icon}</span>
    <div className="flex-1 min-w-0">
      <div className="text-xs text-foreground-default truncate">{label}</div>
      {detail && <div className="text-xs text-foreground-muted truncate">{detail}</div>}
    </div>
  </label>
);

export const DiffReportDialog: React.FC<DiffReportDialogProps> = ({
  visible,
  projectId,
  connectionInfo,
  onClose,
  onSyncToDb,
  onSyncFromDb,
  onFullSync,
}) => {
  const { t } = useTranslation();
  const diffWithDatabase = useErDesignerStore((s) => s.diffWithDatabase);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [isFullSyncing, setIsFullSyncing] = useState(false);
  const [selectedChanges, setSelectedChanges] = useState<Set<string>>(new Set());

  // 获取差异
  useEffect(() => {
    if (visible && projectId) {
      setLoading(true);
      diffWithDatabase(projectId)
        .then((result) => {
          setDiffResult(result);
          // 默认全选
          const allKeys = generateChangeKeys(result);
          setSelectedChanges(new Set(allKeys));
        })
        .catch((err) => {
          console.error('Failed to diff with database:', err);
          setDiffResult(null);
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [visible, projectId, diffWithDatabase]);

  // 生成变更项的唯一键
  const generateChangeKeys = useMemo(() => {
    return (diff: DiffResult): string[] => {
      const keys: string[] = [];

      // 新增表
      diff.added_tables.forEach((t) => {
        keys.push(`added_table:${t.table_name}`);
      });

      // 删除表
      diff.removed_tables.forEach((t) => {
        keys.push(`removed_table:${t.table_name}`);
      });

      // 修改表
      diff.modified_tables.forEach((t) => {
        // 新增列
        t.added_columns.forEach((c) => {
          keys.push(`added_column:${t.table_name}:${c.name}`);
        });
        // 删除列
        t.removed_columns.forEach((c) => {
          keys.push(`removed_column:${t.table_name}:${c.name}`);
        });
        // 修改列
        t.modified_columns.forEach((c) => {
          keys.push(`modified_column:${t.table_name}:${c.name}`);
        });
        // 新增索引
        t.added_indexes.forEach((i) => {
          keys.push(`added_index:${t.table_name}:${i.name}`);
        });
        // 删除索引
        t.removed_indexes.forEach((i) => {
          keys.push(`removed_index:${t.table_name}:${i.name}`);
        });
      });

      return keys;
    };
  }, []);

  // 处理勾选
  const handleCheck = (key: string, checked: boolean) => {
    setSelectedChanges((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  // 获取选中的变更项（按类型分组）
  const getSelectedChangesByType = useMemo(() => {
    if (!diffResult) return { toDb: [], fromDb: [] as SelectedChange[] };

    const toDb: SelectedChange[] = [];
    const fromDb: SelectedChange[] = [];

    // 新增表 -> 执行到数据库
    diffResult.added_tables.forEach((t) => {
      const key = `added_table:${t.table_name}`;
      if (selectedChanges.has(key)) {
        toDb.push({ type: 'added_table', table: t.table_name, changeData: t });
      }
    });

    // 修改表 -> 执行到数据库
    diffResult.modified_tables.forEach((t) => {
      t.added_columns.forEach((c) => {
        const key = `added_column:${t.table_name}:${c.name}`;
        if (selectedChanges.has(key)) {
          toDb.push({ type: 'modified_table', table: t.table_name, column: c.name, changeData: c });
        }
      });
      t.removed_columns.forEach((c) => {
        const key = `removed_column:${t.table_name}:${c.name}`;
        if (selectedChanges.has(key)) {
          toDb.push({ type: 'modified_table', table: t.table_name, column: c.name, changeData: c });
        }
      });
      t.modified_columns.forEach((c) => {
        const key = `modified_column:${t.table_name}:${c.name}`;
        if (selectedChanges.has(key)) {
          toDb.push({ type: 'modified_table', table: t.table_name, column: c.name, changeData: c });
        }
      });
      t.added_indexes.forEach((i) => {
        const key = `added_index:${t.table_name}:${i.name}`;
        if (selectedChanges.has(key)) {
          toDb.push({ type: 'modified_table', table: t.table_name, index: i.name, changeData: i });
        }
      });
      t.removed_indexes.forEach((i) => {
        const key = `removed_index:${t.table_name}:${i.name}`;
        if (selectedChanges.has(key)) {
          toDb.push({ type: 'modified_table', table: t.table_name, index: i.name, changeData: i });
        }
      });
    });

    // 数据库→ER:
    // 1. removed_tables (DB 有但 ER 无) → 导入到 ER
    diffResult.removed_tables.forEach((t) => {
      const key = `removed_table:${t.table_name}`;
      if (selectedChanges.has(key)) {
        fromDb.push({ type: 'removed_table', table: t.table_name, changeData: t });
      }
    });
    // 2. modified_tables (有差异的表) → 只要任意子项被勾选，就把整张表加入同步列表
    diffResult.modified_tables.forEach((t) => {
      const tableKeys = [
        ...t.added_columns.map(c => `added_column:${t.table_name}:${c.name}`),
        ...t.removed_columns.map(c => `removed_column:${t.table_name}:${c.name}`),
        ...t.modified_columns.map(c => `modified_column:${t.table_name}:${c.name}`),
        ...t.added_indexes.map(i => `added_index:${t.table_name}:${i.name}`),
        ...t.removed_indexes.map(i => `removed_index:${t.table_name}:${i.name}`),
      ];
      if (tableKeys.some(k => selectedChanges.has(k))) {
        fromDb.push({ type: 'modified_table', table: t.table_name, changeData: t });
      }
    });

    return { toDb, fromDb };
  }, [diffResult, selectedChanges]);

  const { toDb, fromDb } = getSelectedChangesByType;

  const handleSyncToDb = () => {
    if (!diffResult) return;
    const payload: DiffResult = {
      added_tables: diffResult.added_tables.filter((t) =>
        selectedChanges.has(`added_table:${t.table_name}`)
      ),
      removed_tables: [],
      modified_tables: diffResult.modified_tables
        .map((t) => ({
          ...t,
          added_columns: t.added_columns.filter((c) =>
            selectedChanges.has(`added_column:${t.table_name}:${c.name}`)
          ),
          removed_columns: t.removed_columns.filter((c) =>
            selectedChanges.has(`removed_column:${t.table_name}:${c.name}`)
          ),
          modified_columns: t.modified_columns.filter((c) =>
            selectedChanges.has(`modified_column:${t.table_name}:${c.name}`)
          ),
          added_indexes: t.added_indexes.filter((i) =>
            selectedChanges.has(`added_index:${t.table_name}:${i.name}`)
          ),
          removed_indexes: t.removed_indexes.filter((i) =>
            selectedChanges.has(`removed_index:${t.table_name}:${i.name}`)
          ),
        }))
        .filter(
          (t) =>
            t.added_columns.length > 0 ||
            t.removed_columns.length > 0 ||
            t.modified_columns.length > 0 ||
            t.added_indexes.length > 0 ||
            t.removed_indexes.length > 0
        ),
    };
    onSyncToDb(payload);
    onClose();
  };

  const handleSyncFromDb = () => {
    onSyncFromDb(fromDb);
    onClose();
  };

  const handleFullSync = async () => {
    setIsFullSyncing(true);
    try {
      await onFullSync();
      onClose();
    } finally {
      setIsFullSyncing(false);
    }
  };

  if (!visible) return null;

  return (
    <BaseModal
      title={t('erDesigner.diffTitle')}
      onClose={onClose}
      width={600}
      footerButtons={[
        {
          label: t('erDesigner.syncFromDb'),
          onClick: handleSyncFromDb,
          variant: 'secondary',
          disabled: loading || fromDb.length === 0,
        },
        {
          label: t('erDesigner.syncToDb'),
          onClick: handleSyncToDb,
          variant: 'primary',
          disabled: loading || toDb.length === 0,
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        {/* 连接信息 */}
        {connectionInfo && (
          <div className="text-xs text-foreground-muted">
            {`${t('erDesigner.erVsDb')} ${connectionInfo.name} / ${connectionInfo.database}`}
          </div>
        )}

        {loading ? (
          <div className="text-center py-8 text-xs text-foreground-muted">{t('erDesigner.loadingDiff')}</div>
        ) : !diffResult ? (
          <div className="text-center py-8 text-xs text-foreground-muted">{t('erDesigner.diffFailed')}</div>
        ) : (
          <div className="flex flex-col gap-4 max-h-96 overflow-y-auto">
            {/* 新增（仅 ER 图有） */}
            {diffResult.added_tables.length > 0 && (
              <div>
                <div className="flex items-center gap-2 text-xs text-accent mb-2">
                  <CheckCircle2 size={14} />
                  <span>{t('erDesigner.addedSection')}</span>
                </div>
                <div className="space-y-1">
                  {diffResult.added_tables.map((table) => {
                    const key = `added_table:${table.table_name}`;
                    return (
                      <ChangeItem
                        key={key}
                        checked={selectedChanges.has(key)}
                        onCheck={(checked) => handleCheck(key, checked)}
                        icon={<CheckCircle2 size={12} />}
                        label={`${t('erDesigner.tableLabel')} ${table.table_name} (${table.columns.length}${t('erDesigner.columnLabel')})`}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {/* 变更 */}
            {diffResult.modified_tables.length > 0 && (
              <div>
                <div className="flex items-center gap-2 text-xs text-warning mb-2">
                  <AlertTriangle size={14} />
                  <span>{t('erDesigner.modifiedSection')}</span>
                </div>
                <div className="space-y-1">
                  {diffResult.modified_tables.map((table) => (
                    <div key={table.table_name} className="pl-2 border-l border-border-strong">
                      <div className="text-xs text-foreground-default mb-1">{table.table_name}</div>
                      <div className="pl-3 space-y-1">
                        {/* 新增列 */}
                        {table.added_columns.map((col) => {
                          const key = `added_column:${table.table_name}:${col.name}`;
                          return (
                            <ChangeItem
                              key={key}
                              checked={selectedChanges.has(key)}
                              onCheck={(checked) => handleCheck(key, checked)}
                              icon={<CheckCircle2 size={12} />}
                              label={`${t('erDesigner.columnLabel')} ${col.name} ${col.data_type}`}
                              detail={t('erDesigner.addedLabel')}
                            />
                          );
                        })}
                        {/* 删除列 */}
                        {table.removed_columns.map((col) => {
                          const key = `removed_column:${table.table_name}:${col.name}`;
                          return (
                            <ChangeItem
                              key={key}
                              checked={selectedChanges.has(key)}
                              onCheck={(checked) => handleCheck(key, checked)}
                              icon={<Trash2 size={12} />}
                              label={`${t('erDesigner.columnLabel')} ${col.name} ${col.data_type}`}
                              detail={t('erDesigner.removedLabel')}
                            />
                          );
                        })}
                        {/* 修改列 */}
                        {table.modified_columns.map((col) => {
                          const key = `modified_column:${table.table_name}:${col.name}`;
                          const typeInfo = col.type_changed
                            ? `${col.er_type}→${col.db_type}`
                            : col.nullable_changed
                            ? (col.er_nullable ? 'NOT NULL' : 'NULL') + '→' + (col.db_nullable ? 'NULL' : 'NOT NULL')
                            : '';
                          return (
                            <ChangeItem
                              key={key}
                              checked={selectedChanges.has(key)}
                              onCheck={(checked) => handleCheck(key, checked)}
                              icon={<AlertTriangle size={12} />}
                              label={`${t('erDesigner.columnLabel')} ${table.table_name}.${col.name}`}
                              detail={typeInfo}
                            />
                          );
                        })}
                        {/* 新增索引 */}
                        {table.added_indexes.map((idx) => {
                          const key = `added_index:${table.table_name}:${idx.name}`;
                          return (
                            <ChangeItem
                              key={key}
                              checked={selectedChanges.has(key)}
                              onCheck={(checked) => handleCheck(key, checked)}
                              icon={<CheckCircle2 size={12} />}
                              label={`${t('erDesigner.indexLabel')} ${idx.name}`}
                              detail={`${idx.index_type} (${idx.columns.join(', ')})`}
                            />
                          );
                        })}
                        {/* 删除索引 */}
                        {table.removed_indexes.map((idx) => {
                          const key = `removed_index:${table.table_name}:${idx.name}`;
                          return (
                            <ChangeItem
                              key={key}
                              checked={selectedChanges.has(key)}
                              onCheck={(checked) => handleCheck(key, checked)}
                              icon={<Trash2 size={12} />}
                              label={`${t('erDesigner.indexLabel')} ${idx.name}`}
                              detail={`${idx.index_type} (${idx.columns.join(', ')})`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 删除（仅数据库有） */}
            {diffResult.removed_tables.length > 0 && (
              <div>
                <div className="flex items-center gap-2 text-xs text-error mb-2">
                  <Trash2 size={14} />
                  <span>{t('erDesigner.removedSection')}</span>
                </div>
                <div className="space-y-1">
                  {diffResult.removed_tables.map((table) => {
                    const key = `removed_table:${table.table_name}`;
                    return (
                      <ChangeItem
                        key={key}
                        checked={selectedChanges.has(key)}
                        onCheck={(checked) => handleCheck(key, checked)}
                        icon={<Trash2 size={12} />}
                        label={`${t('erDesigner.columnLabel')} ${table.table_name}.${table.columns[0]?.name || ''}`}
                        detail={`${table.columns[0]?.data_type || 'TEXT'}`}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {/* 无差异 */}
            {diffResult.added_tables.length === 0 &&
              diffResult.removed_tables.length === 0 &&
              diffResult.modified_tables.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <div className="text-xs text-accent">{t('erDesigner.noDiff')}</div>
                  <button
                    onClick={handleFullSync}
                    disabled={isFullSyncing}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border-strong text-foreground-muted hover:text-foreground-default hover:bg-background-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <RefreshCw size={12} className={isFullSyncing ? 'animate-spin' : ''} />
                    <span>{isFullSyncing ? '刷新中...' : t('erDesigner.fullRefreshFromDb')}</span>
                  </button>
                </div>
              )}
          </div>
        )}
      </div>
    </BaseModal>
  );
};
