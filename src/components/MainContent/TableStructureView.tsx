import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronUp, ChevronDown, Check, RotateCcw } from 'lucide-react';
import { useConnectionStore } from '../../store/connectionStore';
import { useTableFormStore, loadPersistedFormState } from '../../store/tableFormStore';
import { useUIObjectRegistry } from '../../mcp/ui';
import { TableFormUIObject, generateTableSql } from '../../mcp/ui/adapters/TableFormAdapter';
import type { ToastLevel } from '../Toast';
import { DropdownSelect } from '../common/DropdownSelect';
import type { EditableColumn } from '../../store/tableFormStore';
import { useFieldHighlight } from '../../hooks/useFieldHighlight';
import { useHighlightStore } from '../../store/highlightStore';

const HighlightedField: React.FC<{
  scopeId: string;
  path: string;
  children: (onUserEdit: () => void) => React.ReactNode;
}> = ({ scopeId, path, children }) => {
  const { className, onUserEdit } = useFieldHighlight(scopeId, path);
  return <div className={className}>{children(onUserEdit)}</div>;
};

/** Wraps a <tr> with highlight className — returns className string, not a wrapper div */
function useRowHighlight(scopeId: string, columnName: string) {
  return useFieldHighlight(scopeId, `columns.${columnName}`);
}

const COMMON_TYPES = ['INT', 'BIGINT', 'VARCHAR', 'TEXT', 'BOOLEAN', 'FLOAT', 'DOUBLE', 'DECIMAL', 'DATE', 'DATETIME', 'TIMESTAMP', 'JSON'];

const getTypeOptions = (dataType: string) => {
  const opts = COMMON_TYPES.map(tp => ({ value: tp, label: tp }));
  if (dataType && !COMMON_TYPES.includes(dataType)) {
    opts.push({ value: dataType, label: dataType });
  }
  return opts;
};

function makeId() { return Math.random().toString(36).slice(2); }

const ColumnRow: React.FC<{
  col: EditableColumn;
  idx: number;
  tabId: string;
  visibleCount: number;
  updateColumn: (id: string, updates: Partial<EditableColumn>) => void;
  moveColumn: (id: string, dir: 'up' | 'down') => void;
  setColumns: (updater: EditableColumn[] | ((prev: EditableColumn[]) => EditableColumn[])) => void;
  iconBtn: string;
  iconBtnDanger: string;
}> = ({ col, idx, tabId, visibleCount, updateColumn, moveColumn, setColumns, iconBtn, iconBtnDanger }) => {
  const { className: hlClass, onUserEdit } = useRowHighlight(tabId, col.name);

  return (
    <tr className={`hover:bg-[#1a2639] border-b border-[#1e2d42] group ${col._isNew ? 'bg-green-900/10' : ''} ${hlClass}`}>
      <td className="w-[30px] px-1 py-1.5 border-r border-[#1e2d42] text-[#7a9bb8] bg-[#0d1117] text-center text-xs cursor-default select-none">
        {idx + 1}
      </td>
      <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
          value={col.name}
          onChange={e => { onUserEdit(); updateColumn(col.id, { name: e.target.value }); }}
        />
      </td>
      <td className="px-1.5 py-1 border-r border-[#1e2d42]">
        <DropdownSelect
          value={col.dataType}
          options={getTypeOptions(col.dataType)}
          onChange={v => { onUserEdit(); updateColumn(col.id, { dataType: v }); }}
          className="w-full"
        />
      </td>
      <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
          value={col.length ?? ''}
          onChange={e => { onUserEdit(); updateColumn(col.id, { length: e.target.value }); }}
          placeholder="—"
        />
      </td>
      <td className="px-1.5 py-1 border-r border-[#1e2d42] text-center">
        <input
          type="checkbox"
          checked={col.isNullable ?? true}
          onChange={e => { onUserEdit(); updateColumn(col.id, { isNullable: e.target.checked }); }}
          className="accent-[#009e84]"
        />
      </td>
      <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
          value={col.defaultValue ?? ''}
          onChange={e => { onUserEdit(); updateColumn(col.id, { defaultValue: e.target.value }); }}
          placeholder="—"
        />
      </td>
      <td className="px-1.5 py-1 border-r border-[#1e2d42] text-center">
        <input
          type="checkbox"
          checked={col.isPrimaryKey ?? false}
          onChange={e => { onUserEdit(); updateColumn(col.id, { isPrimaryKey: e.target.checked }); }}
          className="accent-[#3794ff]"
        />
      </td>
      <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
          value={col.extra ?? ''}
          onChange={e => { onUserEdit(); updateColumn(col.id, { extra: e.target.value }); }}
          placeholder="—"
        />
      </td>
      <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
          value={col.comment ?? ''}
          onChange={e => { onUserEdit(); updateColumn(col.id, { comment: e.target.value }); }}
          placeholder="—"
        />
      </td>
      <td className="px-1.5 py-1">
        <div className="flex items-center gap-0.5 justify-center">
          <button
            onClick={() => moveColumn(col.id, 'up')}
            disabled={idx === 0}
            className={iconBtn}
          ><ChevronUp size={12} /></button>
          <button
            onClick={() => moveColumn(col.id, 'down')}
            disabled={idx === visibleCount - 1}
            className={iconBtn}
          ><ChevronDown size={12} /></button>
          <button
            onClick={() => col._isNew
              ? setColumns(prev => prev.filter(c => c.id !== col.id))
              : updateColumn(col.id, { _isDeleted: true })
            }
            className={iconBtnDanger}
          ><Trash2 size={12} /></button>
        </div>
      </td>
    </tr>
  );
};

interface TableStructureViewProps {
  tabId: string;
  connectionId: number;
  tableName?: string;
  database?: string;
  schema?: string;
  onSuccess: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}

export const TableStructureView: React.FC<TableStructureViewProps> = ({
  tabId, connectionId, tableName, database, schema, onSuccess, showToast
}) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(false);

  // SQL Preview panel resizable height
  const [previewHeight, setPreviewHeight] = useState(140);
  const [isPreviewResizing, setIsPreviewResizing] = useState(false);
  const previewResizeRef = useRef<{ startY: number; startH: number } | null>(null);

  const handlePreviewResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = previewHeight;
    previewResizeRef.current = { startY, startH };
    setIsPreviewResizing(true);

    const onMove = (ev: MouseEvent) => {
      if (!previewResizeRef.current) return;
      const delta = previewResizeRef.current.startY - ev.clientY;
      setPreviewHeight(Math.max(80, Math.min(400, previewResizeRef.current.startH + delta)));
    };
    const onUp = () => {
      previewResizeRef.current = null;
      setIsPreviewResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [previewHeight]);

  const { connections } = useConnectionStore();
  const driver = connections.find(c => c.id === connectionId)?.driver ?? 'mysql';

  // Zustand store for form state (accessible by AI via UIObject)
  const formState = useTableFormStore(s => s.forms[tabId])
  const { initForm, setForm, removeForm } = useTableFormStore()

  const columns = formState?.columns ?? []
  const originalColumns = formState?.originalColumns ?? []
  const newTableName = formState?.tableName ?? ''

  const setColumns = useCallback((updater: EditableColumn[] | ((prev: EditableColumn[]) => EditableColumn[])) => {
    useTableFormStore.getState().patchForm(tabId, s => ({
      ...s,
      columns: typeof updater === 'function' ? updater(s.columns as EditableColumn[]) : updater,
    }))
  }, [tabId])

  const setNewTableName = useCallback((name: string) => {
    useTableFormStore.getState().patchForm(tabId, s => ({ ...s, tableName: name }))
  }, [tabId])

  // Register UIObject for AI access
  const uiObject = useMemo(
    () => formState ? new TableFormUIObject(tabId, connectionId, database ?? '') : null,
    [tabId, connectionId, database, formState != null]
  )
  useUIObjectRegistry(uiObject)

  // Initialize form state on mount, cleanup on unmount
  useEffect(() => {
    if (!tableName) {
      // New table mode — try to restore persisted form state first
      loadPersistedFormState(tabId).then(persisted => {
        if (persisted) {
          initForm(tabId, persisted)
        } else {
          // No persisted state — start with a default id column
          const initCols: EditableColumn[] = [{
            id: makeId(), name: 'id', dataType: 'INT', length: '', isNullable: false,
            defaultValue: '', isPrimaryKey: true, extra: 'auto_increment', comment: '', _isNew: true,
          }];
          initForm(tabId, {
            tableName: '',
            engine: 'InnoDB', charset: 'utf8mb4', comment: '',
            columns: initCols, originalColumns: [], indexes: [], foreignKeys: [], isNewTable: true,
          })
        }
      })
      return;
    }
    setIsLoadingData(true);
    invoke<{
      name: string;
      columns: Array<{
        name: string; data_type: string; is_nullable: boolean;
        column_default: string | null; is_primary_key: boolean; extra: string | null;
        comment: string | null;
      }>;
    }>('get_table_detail', {
      connectionId, database: database ?? null, schema: schema ?? null, table: tableName
    }).then(detail => {
      const cols: EditableColumn[] = detail.columns.map(c => ({
        id: makeId(),
        name: c.name,
        dataType: c.data_type.toUpperCase().split('(')[0],
        length: c.data_type.match(/\(([^)]+)\)/)?.[1] ?? '',
        isNullable: c.is_nullable,
        defaultValue: c.column_default ?? '',
        isPrimaryKey: c.is_primary_key,
        extra: c.extra ?? '',
        comment: c.comment ?? '',
        _originalName: c.name,
      }));
      initForm(tabId, {
        tableName: tableName,
        engine: 'InnoDB', charset: 'utf8mb4', comment: '',
        columns: cols, originalColumns: cols.map(c => ({ ...c })), indexes: [], foreignKeys: [], isNewTable: false,
      })
    }).catch(e => {
      showToast(`${t('tableManage.loadFailed')}: ${String(e)}`, 'error');
    }).finally(() => setIsLoadingData(false));

    return () => {
      removeForm(tabId);
      useHighlightStore.getState().clearAll(tabId);
    }
  }, [tableName, connectionId, database, schema, tabId]);

  const updateColumn = useCallback((id: string, patch: Partial<EditableColumn>) => {
    setColumns(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  }, []);

  const addColumn = useCallback(() => {
    setColumns(prev => [...prev, {
      id: makeId(), name: 'new_column', dataType: 'VARCHAR', length: '255',
      isNullable: true, defaultValue: '', isPrimaryKey: false, extra: '', comment: '', _isNew: true,
    }]);
  }, []);

  const moveColumn = useCallback((id: string, dir: 'up' | 'down') => {
    setColumns(prev => {
      const active = prev.filter(c => !c._isDeleted);
      const idx = active.findIndex(c => c.id === id);
      if (dir === 'up' && idx <= 0) return prev;
      if (dir === 'down' && idx >= active.length - 1) return prev;
      const newActive = [...active];
      const swap = dir === 'up' ? idx - 1 : idx + 1;
      [newActive[idx], newActive[swap]] = [newActive[swap], newActive[idx]];
      const deleted = prev.filter(c => c._isDeleted);
      return [...newActive, ...deleted];
    });
  }, []);

  const handleDiscard = () => {
    if (!tableName) {
      const initCols: EditableColumn[] = [{
        id: makeId(), name: 'id', dataType: 'INT', length: '', isNullable: false,
        defaultValue: '', isPrimaryKey: true, extra: 'auto_increment', comment: '', _isNew: true,
      }];
      setColumns(initCols);
      setNewTableName('');
    } else {
      setColumns(originalColumns.map(c => ({ ...c } as EditableColumn)));
    }
  };

  const visibleColumns = columns.filter(c => !c._isDeleted);
  const effectiveTableName = tableName ?? newTableName;
  const previewSql = useMemo(() => effectiveTableName.trim()
    ? generateTableSql({
        tableName: effectiveTableName,
        engine: 'InnoDB', charset: 'utf8mb4', comment: '',
        columns, originalColumns: tableName ? originalColumns : undefined,
        indexes: [], foreignKeys: [], isNewTable: !tableName,
      }, driver)
    : '-- 请先填写表名',
    [effectiveTableName, columns, originalColumns, tableName, driver]);

  const hasChanges = !previewSql.startsWith('-- ');

  const handleExecute = async () => {
    if (!hasChanges) return;
    if (visibleColumns.some(c => !c.name.trim())) {
      showToast(t('tableManage.columnNameRequired'), 'error');
      return;
    }
    setIsLoading(true);
    try {
      await invoke('execute_query', {
        connectionId, sql: previewSql,
        database: database ?? null, schema: schema ?? null,
      });
      showToast(tableName ? t('tableManage.alterSuccess') : t('tableManage.createSuccess'), 'success');
      onSuccess();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const iconBtn = 'p-0.5 hover:bg-[#243a55] rounded text-[#7a9bb8] hover:text-[#c8daea] transition-colors disabled:opacity-30 disabled:cursor-not-allowed';
  const iconBtnDanger = 'p-0.5 hover:bg-[#243a55] rounded text-red-500/70 hover:text-red-400 transition-colors';

  const connectionName = connections.find(c => c.id === connectionId)?.name ?? `conn_${connectionId}`;

  return (
    <div className="flex-1 flex flex-col bg-[#080d12] overflow-hidden min-h-0">
      {/* Context info bar */}
      <div className="h-8 flex items-center px-3 border-b border-[#1e2d42] bg-[#0a1018] text-xs flex-shrink-0 gap-1.5 text-[#7a9bb8]">
        <span className="text-[#009e84]">{connectionName}</span>
        {database && (<><span className="text-[#3a4f6a]">/</span><span>{database}</span></>)}
        {schema && (<><span className="text-[#3a4f6a]">/</span><span>{schema}</span></>)}
        {tableName && (<><span className="text-[#3a4f6a]">/</span><span className="text-[#c8daea]">{tableName}</span></>)}
      </div>
      {/* Toolbar */}
      {!tableName && (
        <div className="h-10 flex items-center px-3 border-b border-[#1e2d42] bg-[#080d12] text-xs flex-shrink-0">
          <HighlightedField scopeId={tabId} path="tableName">
            {(onUserEdit) => (
              <input
                className="bg-[#0d1520] border border-[#2a3f5a] rounded px-2 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84] w-40"
                placeholder={t('tableManage.tableName') + '...'}
                value={newTableName}
                onChange={e => { onUserEdit(); setNewTableName(e.target.value); }}
              />
            )}
          </HighlightedField>
        </div>
      )}

      {/* Column Table */}
      <div className="flex-1 overflow-auto">
        {isLoadingData ? (
          <div className="p-4 text-[#7a9bb8] text-sm">{t('tableDataView.loading')}</div>
        ) : (
          <table className="w-full text-left border-collapse whitespace-nowrap text-xs table-fixed">
            <thead className="sticky top-0 bg-[#0d1117] z-10">
              <tr>
                <th className="w-10 px-2 py-1.5 border-b border-r border-[#1e2d42] text-[#7a9bb8] font-normal text-center">{t('tableDataView.serialNo')}</th>
                <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal w-[160px]">{t('tableManage.columnName')}</th>
                <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal w-[130px]">{t('tableManage.dataType')}</th>
                <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal w-[80px]">{t('tableManage.length')}</th>
                <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal text-center w-[70px]">{t('tableManage.nullable')}</th>
                <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal w-[120px]">{t('tableManage.defaultValue')}</th>
                <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal text-center w-[50px]">PK</th>
                <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal w-[110px]">{t('tableManage.extra')}</th>
                <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal w-[180px]">{t('tableManage.comment')}</th>
                <th className="px-3 py-1.5 border-b border-[#1e2d42] text-[#7a9bb8] font-normal text-center w-[70px]">{t('tableManage.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleColumns.map((col, idx) => (
                <ColumnRow
                  key={col.id}
                  col={col}
                  idx={idx}
                  tabId={tabId}
                  visibleCount={visibleColumns.length}
                  updateColumn={updateColumn}
                  moveColumn={moveColumn}
                  setColumns={setColumns}
                  iconBtn={iconBtn}
                  iconBtnDanger={iconBtnDanger}
                />
              ))}
            </tbody>
          </table>
        )}
        <button
          onClick={addColumn}
          className="m-2 flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#009e84] px-2 py-1"
        >
          <Plus size={13} />
          {t('tableManage.addColumn')}
        </button>
      </div>

      {/* Resize Handle */}
      <div
        className="flex-shrink-0 h-[4.5px] cursor-row-resize hover:bg-[#00c9a7] z-10 transition-colors border-t border-[#1e2d42]"
        style={isPreviewResizing ? { backgroundColor: '#00c9a7' } : undefined}
        onMouseDown={handlePreviewResizeStart}
      />

      {/* SQL Preview + Actions */}
      <div
        className="flex-shrink-0 flex flex-col px-3 py-2 bg-[#080d12]"
        style={{ height: previewHeight, transition: isPreviewResizing ? 'none' : 'height 150ms ease' }}
      >
        <div className="text-xs text-[#7a9bb8] mb-1">
          {tableName ? t('tableManage.alterPreview') : t('tableManage.createPreview')}
        </div>
        <textarea
          readOnly
          className="w-full flex-1 min-h-0 bg-[#0d1520] border border-[#1e2d42] rounded p-2 font-mono text-xs text-[#c8daea] outline-none resize-none"
          value={previewSql}
          spellCheck={false}
        />
        <div className="flex items-center justify-end gap-2 mt-2">
          {hasChanges && (
            <button
              onClick={handleDiscard}
              className="flex items-center gap-1 px-2 py-1 hover:bg-[#1a2639] rounded text-xs text-[#7a9bb8] hover:text-[#c8daea]"
            >
              <RotateCcw size={12} />
              {t('tableDataView.discardChanges')}
            </button>
          )}
          <button
            onClick={handleExecute}
            disabled={isLoading || !hasChanges || isLoadingData}
            className="flex items-center gap-1 px-2 py-1 bg-[#00c9a7] hover:bg-[#00a98f] text-white rounded text-xs disabled:opacity-50"
          >
            <Check size={12} />
            {isLoading
              ? t('common.executing')
              : tableName ? t('tableManage.executeAlter') : t('tableManage.executeCreate')}
          </button>
        </div>
      </div>
    </div>
  );
};
