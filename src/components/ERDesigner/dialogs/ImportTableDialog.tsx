import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import type { TableMeta } from '../../../types';
import { BaseModal } from '../../common/BaseModal';
import { Database } from 'lucide-react';

export interface ImportTableDialogProps {
  visible: boolean;
  projectId: number;
  connectionId: number | null;
  databaseName: string | null;
  onClose: () => void;
  onImported: () => void;
}

interface TableWithColumns extends TableMeta {
  columnCount?: number;
}

export const ImportTableDialog: React.FC<ImportTableDialogProps> = ({
  visible,
  projectId,
  connectionId,
  databaseName,
  onClose,
  onImported,
}) => {
  const { t } = useTranslation();
  const syncFromDatabase = useErDesignerStore((s) => s.syncFromDatabase);

  const [tables, setTables] = useState<TableWithColumns[]>([]);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [error, setError] = useState('');
  const [allSelected, setAllSelected] = useState(false);

  // 加载表列表
  useEffect(() => {
    const loadTables = async () => {
      if (!visible || !connectionId) {
        setTables([]);
        return;
      }

      setLoadingTables(true);
      setError('');
      try {
        const result = await invoke<TableMeta[]>('get_tables', { connectionId });
        setTables(result.map(t => ({ ...t, columnCount: undefined })));
      } catch (e) {
        setError(`${t('erDesigner.loadTablesFailed')}: ${String(e)}`);
        setTables([]);
      } finally {
        setLoadingTables(false);
      }
    };
    loadTables();
  }, [visible, connectionId]);

  // 搜索过滤
  const filteredTables = tables.filter(t =>
    t.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // 全选/取消全选
  const toggleSelectAll = () => {
    const newAllSelected = !allSelected;
    setAllSelected(newAllSelected);
    if (newAllSelected) {
      setSelectedTables(new Set(filteredTables.map(t => t.name)));
    } else {
      setSelectedTables(new Set());
    }
  };

  // 切换单个表选择
  const toggleTable = (tableName: string) => {
    setSelectedTables(prev => {
      const next = new Set(prev);
      if (next.has(tableName)) {
        next.delete(tableName);
      } else {
        next.add(tableName);
      }
      return next;
    });
  };

  // 获取表的列数
  const getColumnCountText = (table: TableWithColumns): string => {
    if (table.columnCount) {
      return `${t('erDesigner.columnCount', { count: table.columnCount })}`;
    }
    return '';
  };

  const handleImport = async () => {
    if (selectedTables.size === 0) {
      setError(t('erDesigner.selectAtLeastOne'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      await syncFromDatabase(projectId, Array.from(selectedTables));
      onImported();
      handleClose();
    } catch (e) {
      setError(`${t('erDesigner.importFailed')}: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setSearchTerm('');
    setSelectedTables(new Set());
    setAllSelected(false);
    setError('');
    onClose();
  };

  if (!visible) return null;

  // 未绑定连接时显示提示
  if (!connectionId || !databaseName) {
    return (
      <BaseModal
        title={t('erDesigner.importTableTitle')}
        onClose={handleClose}
        width={560}
        footerButtons={[
          {
            label: t('common.cancel'),
            onClick: handleClose,
            variant: 'secondary',
          },
        ]}
      >
        <div className="flex flex-col items-center justify-center py-8 gap-4">
          <Database size={48} className="text-foreground-muted" />
          <div className="text-sm text-foreground-default text-center max-w-xs">
            {t('erDesigner.noConnectionForImport')}
          </div>
        </div>
      </BaseModal>
    );
  }

  return (
    <BaseModal
      title={t('erDesigner.importTableTitle')}
      onClose={handleClose}
      width={560}
      footerButtons={[
        {
          label: t('common.cancel'),
          onClick: handleClose,
          variant: 'secondary',
        },
        {
          label: t('erDesigner.importBtn'),
          onClick: handleImport,
          variant: 'primary',
          loading,
          disabled: selectedTables.size === 0 || loading,
        },
      ]}
      footerHint={t('erDesigner.selectedCount', { count: selectedTables.size })}
    >
      <div className="flex flex-col gap-4">
        {/* 搜索框 */}
        <div className="relative">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('erDesigner.searchTablePlaceholder')}
            className="w-full bg-background-hover border border-border-strong rounded px-3 py-2 text-xs text-foreground-default placeholder:text-foreground-muted focus:outline-none focus:border-accent transition-colors"
          />
        </div>

        {/* 全选操作 */}
        <div className="flex items-center justify-between border-b border-border-default pb-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected && filteredTables.length > 0}
              onChange={toggleSelectAll}
              disabled={filteredTables.length === 0}
              className="accent-accent w-4 h-4"
            />
            <span className="text-xs text-foreground-default">
              {allSelected ? t('erDesigner.deselectAll') : t('erDesigner.selectAll')}
            </span>
          </label>
          <span className="text-xs text-foreground-muted">
            {t('erDesigner.tableCount', { count: filteredTables.length })}
          </span>
        </div>

        {/* 表列表 */}
        <div className="overflow-y-auto max-h-80 border border-border-strong rounded">
          {loadingTables ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-xs text-foreground-muted">{t('common.loading')}</div>
            </div>
          ) : filteredTables.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-xs text-foreground-muted">
                {searchTerm ? t('erDesigner.noTablesFound') : t('erDesigner.noTablesInDb')}
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border-default">
              {filteredTables.map(table => {
                const isSelected = selectedTables.has(table.name);
                return (
                  <label
                    key={table.name}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors
                      ${isSelected ? 'bg-accent/10' : 'hover:bg-background-elevated'}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleTable(table.name)}
                      className="accent-accent w-4 h-4"
                    />
                    <span className="text-xs text-foreground-default flex-1 truncate">
                      {table.name}
                    </span>
                    {getColumnCountText(table) && (
                      <span className="text-xs text-foreground-muted">
                        {getColumnCountText(table)}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="text-xs text-error bg-error-subtle px-3 py-2 rounded border border-error/30">
            {error}
          </div>
        )}
      </div>
    </BaseModal>
  );
};
