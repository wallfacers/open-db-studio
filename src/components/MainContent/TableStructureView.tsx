import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronUp, ChevronDown, Check, RotateCcw } from 'lucide-react';
import { useConnectionStore } from '../../store/connectionStore';
import { useTableFormStore, loadPersistedFormState } from '../../store/tableFormStore';
import type { EditableColumn, TableFormIndex, TableFormForeignKey } from '../../store/tableFormStore';
import { useUIObjectRegistry } from '../../mcp/ui';
import { TableFormUIObject, generateTableSql } from '../../mcp/ui/adapters/TableFormAdapter';
import type { ToastLevel } from '../Toast';
import { DropdownSelect } from '../common/DropdownSelect';
import { useFieldHighlight } from '../../hooks/useFieldHighlight';
import { useHighlightStore } from '../../store/highlightStore';
import IndexEditor from '../ERDesigner/shared/IndexEditor';
import type { ErIndex } from '@/types';
import {
  makeIdMap,
  tableFormColumnsToErColumns,
  tableFormIndexesToErIndexes,
  indexMetaToTableFormIndex,
} from './tableFormIndexAdapter';
import { makeId } from '../../utils/makeId';

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

const FK_ACTION_OPTIONS = [
  { value: 'NO ACTION', label: 'NO ACTION' },
  { value: 'CASCADE', label: 'CASCADE' },
  { value: 'SET NULL', label: 'SET NULL' },
  { value: 'RESTRICT', label: 'RESTRICT' },
  { value: 'SET DEFAULT', label: 'SET DEFAULT' },
];

const getTypeOptions = (dataType: string) => {
  const opts = COMMON_TYPES.map(tp => ({ value: tp, label: tp }));
  if (dataType && !COMMON_TYPES.includes(dataType)) {
    opts.push({ value: dataType, label: dataType });
  }
  return opts;
};

const ColumnRow: React.FC<{
  col: EditableColumn;
  idx: number;
  tabId: string;
  visibleCount: number;
  isNewTable: boolean;
  updateColumn: (id: string, updates: Partial<EditableColumn>) => void;
  moveColumn: (id: string, dir: 'up' | 'down') => void;
  setColumns: (updater: EditableColumn[] | ((prev: EditableColumn[]) => EditableColumn[])) => void;
  iconBtn: string;
  iconBtnDanger: string;
}> = ({ col, idx, tabId, visibleCount, isNewTable, updateColumn, moveColumn, setColumns, iconBtn, iconBtnDanger }) => {
  const { className: hlClass, onUserEdit } = useRowHighlight(tabId, col.name);

  return (
    <tr className={`hover:bg-background-hover border-b border-border-default group transition-colors duration-150 ${!isNewTable && col._isNew ? 'bg-success-subtle' : ''} ${hlClass}`}>
      <td className="w-10 px-2 py-1.5 border-r border-border-default text-foreground-muted text-center text-xs cursor-default select-none">
        {idx + 1}
      </td>
      <td className="p-0 border-r border-border-default [&:focus-within]:[outline:1px_solid_var(--border-focus)] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-background-hover">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-foreground-default outline-none text-xs block"
          value={col.name}
          onChange={e => { onUserEdit(); updateColumn(col.id, { name: e.target.value }); }}
        />
      </td>
      <td className="px-1 py-px border-r border-border-default">
        <DropdownSelect
          value={col.dataType}
          options={getTypeOptions(col.dataType)}
          onChange={v => { onUserEdit(); updateColumn(col.id, { dataType: v }); }}
          className="w-full"
        />
      </td>
      <td className="p-0 border-r border-border-default [&:focus-within]:[outline:1px_solid_var(--border-focus)] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-background-hover">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-foreground-default outline-none text-xs block"
          value={col.length ?? ''}
          onChange={e => { onUserEdit(); updateColumn(col.id, { length: e.target.value }); }}
          placeholder="—"
        />
      </td>
      <td className="px-1.5 py-px border-r border-border-default text-center">
        <input
          type="checkbox"
          checked={col.isNullable ?? true}
          onChange={e => { onUserEdit(); updateColumn(col.id, { isNullable: e.target.checked }); }}
          className="accent-accent"
        />
      </td>
      <td className="p-0 border-r border-border-default [&:focus-within]:[outline:1px_solid_var(--border-focus)] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-background-hover">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-foreground-default outline-none text-xs block"
          value={col.defaultValue ?? ''}
          onChange={e => { onUserEdit(); updateColumn(col.id, { defaultValue: e.target.value }); }}
          placeholder="—"
        />
      </td>
      <td className="px-1.5 py-px border-r border-border-default text-center">
        <input
          type="checkbox"
          checked={col.isPrimaryKey ?? false}
          onChange={e => { onUserEdit(); updateColumn(col.id, { isPrimaryKey: e.target.checked }); }}
          className="accent-info"
        />
      </td>
      <td className="p-0 border-r border-border-default [&:focus-within]:[outline:1px_solid_var(--border-focus)] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-background-hover">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-foreground-default outline-none text-xs block"
          value={col.extra ?? ''}
          onChange={e => { onUserEdit(); updateColumn(col.id, { extra: e.target.value }); }}
          placeholder="—"
        />
      </td>
      <td className="p-0 border-r border-border-default [&:focus-within]:[outline:1px_solid_var(--border-focus)] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-background-hover">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-foreground-default outline-none text-xs block"
          value={col.comment ?? ''}
          onChange={e => { onUserEdit(); updateColumn(col.id, { comment: e.target.value }); }}
          placeholder="—"
        />
      </td>
      <td className="px-1.5 py-px">
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

// ── Index Editor Wrapper (bridges TableForm types → ErIndex/ErColumn for IndexEditor) ──

const IndexEditorWrapper: React.FC<{
  indexes: TableFormIndex[];
  columns: EditableColumn[];
  tableName: string;
  setIndexes: (updater: (prev: TableFormIndex[]) => TableFormIndex[]) => void;
}> = ({ indexes, columns, tableName, setIndexes }) => {
  const idMap = useMemo(() => makeIdMap(), []);

  const visibleIndexes = useMemo(() => indexes.filter(i => !i._isDeleted), [indexes]);
  const visibleColumns = useMemo(() => columns.filter(c => !c._isDeleted), [columns]);

  const erIndexes = useMemo(
    () => tableFormIndexesToErIndexes(visibleIndexes, idMap),
    [visibleIndexes, idMap],
  );
  const erColumns = useMemo(
    () => tableFormColumnsToErColumns(visibleColumns, idMap),
    [visibleColumns, idMap],
  );

  const handleAdd = useCallback((_tableId: number, partial: Partial<ErIndex>) => {
    const newIdx: TableFormIndex = {
      id: makeId(),
      name: partial.name ?? '',
      type: (partial.type ?? 'INDEX') as TableFormIndex['type'],
      columns: partial.columns ?? '[]',
      _isNew: true,
    };
    setIndexes(prev => [...prev, newIdx]);
  }, [setIndexes]);

  const handleUpdate = useCallback((numId: number, updates: Partial<ErIndex>) => {
    const strId = idMap.toStr(numId);
    setIndexes(prev => prev.map(idx => {
      if (idx.id !== strId) return idx;
      const patch: Partial<TableFormIndex> = {};
      if (updates.name !== undefined) patch.name = updates.name;
      if (updates.type !== undefined) patch.type = updates.type as TableFormIndex['type'];
      if (updates.columns !== undefined) patch.columns = updates.columns;
      return { ...idx, ...patch };
    }));
  }, [setIndexes, idMap]);

  const handleDelete = useCallback((numId: number, _tableId: number) => {
    const strId = idMap.toStr(numId);
    setIndexes(prev => prev.flatMap(idx => {
      if (idx.id !== strId) return [idx];
      return idx._isNew ? [] : [{ ...idx, _isDeleted: true }];
    }));
  }, [setIndexes, idMap]);

  return (
    <div className="p-3">
      <IndexEditor
        indexes={erIndexes}
        columns={erColumns}
        tableId={0}
        tableName={tableName}
        onAdd={handleAdd}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />
    </div>
  );
};

// ── Tab type ──

type StructureTab = 'columns' | 'foreignKeys' | 'indexes';

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
  const [activeTab, setActiveTab] = useState<StructureTab>('columns');

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
  const indexes = formState?.indexes ?? []
  const originalIndexes = formState?.originalIndexes ?? []
  const foreignKeys = formState?.foreignKeys ?? []
  const originalForeignKeys = formState?.originalForeignKeys ?? []
  const newTableName = formState?.tableName ?? ''

  const setColumns = useCallback((updater: EditableColumn[] | ((prev: EditableColumn[]) => EditableColumn[])) => {
    useTableFormStore.getState().patchForm(tabId, s => ({
      ...s,
      columns: typeof updater === 'function' ? updater(s.columns as EditableColumn[]) : updater,
    }))
  }, [tabId])

  const setIndexes = useCallback((updater: TableFormIndex[] | ((prev: TableFormIndex[]) => TableFormIndex[])) => {
    useTableFormStore.getState().patchForm(tabId, s => ({
      ...s,
      indexes: typeof updater === 'function' ? updater(s.indexes) : updater,
    }))
  }, [tabId])

  const setForeignKeys = useCallback((updater: TableFormForeignKey[] | ((prev: TableFormForeignKey[]) => TableFormForeignKey[])) => {
    useTableFormStore.getState().patchForm(tabId, s => ({
      ...s,
      foreignKeys: typeof updater === 'function' ? updater(s.foreignKeys ?? []) : updater,
    }))
  }, [tabId])

  const setNewTableName = useCallback((name: string) => {
    useTableFormStore.getState().patchForm(tabId, s => ({ ...s, tableName: name }))
  }, [tabId])

  // ── Referenced table/column dropdowns ────────────────────────────────────
  const [refTables, setRefTables] = useState<string[]>([])
  const refColumnsCacheRef = useRef<Record<string, string[]>>({})
  const [refColumnsCache, setRefColumnsCache] = useState<Record<string, string[]>>({})

  useEffect(() => {
    invoke<Array<{ name: string }>>('get_tables', { connectionId })
      .then(tables => setRefTables(tables.map(t => t.name)))
      .catch(() => {})
  }, [connectionId])

  const loadRefColumns = useCallback((tblName: string) => {
    if (!tblName || refColumnsCacheRef.current[tblName]) return
    invoke<{ columns: Array<{ name: string }> }>('get_table_detail', {
      connectionId, database: database ?? null, schema: schema ?? null, table: tblName,
    }).then(detail => {
      const cols = detail.columns.map(c => c.name)
      refColumnsCacheRef.current = { ...refColumnsCacheRef.current, [tblName]: cols }
      setRefColumnsCache(prev => ({ ...prev, [tblName]: cols }))
    }).catch(() => {})
  }, [connectionId, database, schema])


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
      indexes: Array<{ index_name: string; is_unique: boolean; columns: string[] }>;
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
      // Filter out PRIMARY key index to avoid duplication with PK checkboxes
      const idxs: TableFormIndex[] = (detail.indexes ?? [])
        .filter(idx => idx.index_name !== 'PRIMARY')
        .map(indexMetaToTableFormIndex);
      initForm(tabId, {
        tableName: tableName,
        engine: 'InnoDB', charset: 'utf8mb4', comment: '',
        columns: cols, originalColumns: cols.map(c => ({ ...c })),
        indexes: idxs, originalIndexes: idxs.map(i => ({ ...i })),
        foreignKeys: [],
        isNewTable: false,
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
    setColumns(prev => {
      const base = 'new_column';
      const existingNames = new Set(prev.map(c => c.name));
      let name = base;
      let i = 1;
      while (existingNames.has(name)) {
        name = `${base}_${i++}`;
      }
      return [...prev, {
        id: makeId(), name, dataType: 'VARCHAR', length: '255',
        isNullable: true, defaultValue: '', isPrimaryKey: false, extra: '', comment: '', _isNew: true,
      }];
    });
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

  const visibleForeignKeys = foreignKeys.filter(fk => !fk._isDeleted)

  const addForeignKey = useCallback(() => {
    setForeignKeys(prev => [...prev, {
      id: makeId(),
      constraintName: '',
      column: '',
      referencedTable: '',
      referencedColumn: '',
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      _isNew: true,
    }])
  }, [setForeignKeys])

  const updateForeignKey = useCallback((id: string, patch: Partial<TableFormForeignKey>) => {
    setForeignKeys(prev => prev.map(fk => fk.id === id ? { ...fk, ...patch } : fk))
  }, [setForeignKeys])

  const handleFkReferencedTableChange = useCallback((id: string, tbl: string) => {
    updateForeignKey(id, { referencedTable: tbl, referencedColumn: '' })
    loadRefColumns(tbl)
  }, [updateForeignKey, loadRefColumns])

  const handleFkColumnChange = useCallback((id: string, col: string) => {
    const tblName = tableName ?? newTableName
    setForeignKeys(prev => prev.map(fk => {
      if (fk.id !== id) return fk
      const autoName = !fk.constraintName && col
        ? `fk_${tblName}_${col}`
        : fk.constraintName
      return { ...fk, column: col, constraintName: autoName }
    }))
  }, [setForeignKeys, tableName, newTableName])

  const handleDiscard = () => {
    if (!tableName) {
      const initCols: EditableColumn[] = [{
        id: makeId(), name: 'id', dataType: 'INT', length: '', isNullable: false,
        defaultValue: '', isPrimaryKey: true, extra: 'auto_increment', comment: '', _isNew: true,
      }];
      setColumns(initCols);
      setIndexes([]);
      setForeignKeys([]);
      setNewTableName('');
    } else {
      setColumns(originalColumns.map(c => ({ ...c } as EditableColumn)));
      setIndexes(originalIndexes.map(i => ({ ...i })));
      setForeignKeys(originalForeignKeys.map(f => ({ ...f })));
    }
  };

  const visibleColumns = columns.filter(c => !c._isDeleted);
  const effectiveTableName = tableName ?? newTableName;
  const previewSql = useMemo(() => {
    if (!effectiveTableName.trim()) return '-- 请先填写表名';
    try {
      return generateTableSql({
        tableName: effectiveTableName,
        engine: 'InnoDB', charset: 'utf8mb4', comment: '',
        columns, originalColumns: tableName ? originalColumns : undefined,
        indexes, originalIndexes: tableName ? originalIndexes : undefined,
        foreignKeys, originalForeignKeys: tableName ? originalForeignKeys : undefined,
        isNewTable: !tableName,
      }, driver);
    } catch {
      return '-- 表单数据不完整，请检查列定义';
    }
  }, [effectiveTableName, columns, originalColumns, indexes, originalIndexes, foreignKeys, originalForeignKeys, tableName, driver]);

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

  const iconBtn = 'p-0.5 hover:bg-background-hover rounded text-foreground-muted hover:text-foreground-default transition-colors disabled:opacity-30 disabled:cursor-not-allowed';
  const iconBtnDanger = 'p-0.5 hover:bg-background-hover rounded text-error/70 hover:text-error transition-colors';

  const connectionName = connections.find(c => c.id === connectionId)?.name ?? `conn_${connectionId}`;

  return (
    <div className="flex-1 flex flex-col bg-background-void overflow-hidden min-h-0">
      {/* Context info bar */}
      <div className="h-8 flex items-center px-3 border-b border-border-default bg-background-deep text-xs flex-shrink-0 gap-1.5 text-foreground-muted">
        <span className="text-accent">{connectionName}</span>
        {database && (<><span className="text-foreground-ghost">/</span><span>{database}</span></>)}
        {schema && (<><span className="text-foreground-ghost">/</span><span>{schema}</span></>)}
        {tableName && (<><span className="text-foreground-ghost">/</span><span className="text-foreground-default">{tableName}</span></>)}
      </div>
      {/* Toolbar */}
      {!tableName && (
        <div className="h-10 flex items-center px-3 border-b border-border-default bg-background-void text-xs flex-shrink-0">
          <HighlightedField scopeId={tabId} path="tableName">
            {(onUserEdit) => (
              <input
                className="bg-background-base border border-border-strong rounded px-2 py-0.5 text-xs text-foreground-default outline-none focus:border-accent w-40"
                placeholder={t('tableManage.tableName') + '...'}
                value={newTableName}
                onChange={e => { onUserEdit(); setNewTableName(e.target.value); }}
              />
            )}
          </HighlightedField>
        </div>
      )}

      {/* Tab Bar */}
      <div className="flex border-b border-border-default flex-shrink-0">
        {(['columns', 'foreignKeys', 'indexes'] as StructureTab[]).map(tab => {
          const label = tab === 'columns' ? t('tableManage.columnsTab') : tab === 'indexes' ? t('tableManage.indexesTab') : '外键'
          return (
            <button
              key={tab}
              className={`px-4 py-1.5 text-xs transition-colors cursor-pointer outline-none ${
                activeTab === tab
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-foreground-muted hover:text-foreground-default'
              }`}
              onClick={() => setActiveTab(tab)}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto">
        {isLoadingData ? (
          <div className="p-4 text-foreground-muted text-sm">{t('tableDataView.loading')}</div>
        ) : activeTab === 'columns' ? (
          <>
            <table className="w-full text-left border-collapse whitespace-nowrap text-xs table-fixed">
              <thead className="sticky top-0 bg-background-base z-10">
                <tr>
                  <th className="w-10 px-2 py-1.5 border-b border-r border-border-default text-foreground-muted font-normal text-center">{t('tableDataView.serialNo')}</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[160px]">{t('tableManage.columnName')}</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[130px]">{t('tableManage.dataType')}</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[80px]">{t('tableManage.length')}</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal text-center w-[70px]">{t('tableManage.nullable')}</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[120px]">{t('tableManage.defaultValue')}</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal text-center w-[50px]">PK</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[110px]">{t('tableManage.extra')}</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[180px]">{t('tableManage.comment')}</th>
                  <th className="px-3 py-1.5 border-b border-border-default text-foreground-muted font-normal text-center w-[70px]">{t('tableManage.actions')}</th>
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
                    isNewTable={!tableName}
                    updateColumn={updateColumn}
                    moveColumn={moveColumn}
                    setColumns={setColumns}
                    iconBtn={iconBtn}
                    iconBtnDanger={iconBtnDanger}
                  />
                ))}
              </tbody>
            </table>
            <button
              onClick={addColumn}
              className="m-2 flex items-center gap-1 text-xs text-foreground-muted hover:text-accent px-2 py-1 transition-colors duration-200"
            >
              <Plus size={13} />
              {t('tableManage.addColumn')}
            </button>
          </>
        ) : activeTab === 'foreignKeys' ? (
          <>
            <table className="w-full text-left border-collapse whitespace-nowrap text-xs table-fixed">
              <thead className="sticky top-0 bg-background-base z-10">
                <tr>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[200px]">约束名</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[150px]">当前列</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[150px]">引用表</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[130px]">引用列</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[120px]">ON DELETE</th>
                  <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal w-[120px]">ON UPDATE</th>
                  <th className="px-3 py-1.5 border-b border-border-default text-foreground-muted font-normal text-center w-[50px]">{t('tableManage.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleForeignKeys.map(fk => {
                  const colOptions = visibleColumns.map(c => ({ value: c.name, label: c.name }))
                  return (
                    <tr key={fk.id} className="hover:bg-background-hover border-b border-border-default group transition-colors duration-150">
                      <td className="p-0 border-r border-border-default [&:focus-within]:[outline:1px_solid_var(--border-focus)] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-background-hover">
                        <input
                          className="w-full h-full px-3 py-1.5 bg-transparent text-foreground-default outline-none text-xs block"
                          value={fk.constraintName}
                          onChange={e => updateForeignKey(fk.id, { constraintName: e.target.value })}
                          placeholder="fk_table_col"
                        />
                      </td>
                      <td className="px-1 py-px border-r border-border-default">
                        <DropdownSelect
                          value={fk.column}
                          options={colOptions}
                          placeholder="选择列"
                          onChange={col => handleFkColumnChange(fk.id, col)}
                          className="w-full"
                        />
                      </td>
                      <td className="px-1 py-px border-r border-border-default">
                        <DropdownSelect
                          value={fk.referencedTable}
                          options={refTables.map(t => ({ value: t, label: t }))}
                          placeholder="选择表"
                          onChange={tbl => handleFkReferencedTableChange(fk.id, tbl)}
                          className="w-full"
                        />
                      </td>
                      <td className="px-1 py-px border-r border-border-default">
                        <DropdownSelect
                          value={fk.referencedColumn}
                          options={(refColumnsCache[fk.referencedTable] ?? []).map(c => ({ value: c, label: c }))}
                          placeholder={fk.referencedTable ? '选择列' : '先选引用表'}
                          onChange={col => updateForeignKey(fk.id, { referencedColumn: col })}
                          className="w-full"
                        />
                      </td>
                      <td className="px-1 py-px border-r border-border-default">
                        <DropdownSelect
                          value={fk.onDelete}
                          options={FK_ACTION_OPTIONS}
                          onChange={v => updateForeignKey(fk.id, { onDelete: v })}
                          className="w-full"
                        />
                      </td>
                      <td className="px-1 py-px border-r border-border-default">
                        <DropdownSelect
                          value={fk.onUpdate}
                          options={FK_ACTION_OPTIONS}
                          onChange={v => updateForeignKey(fk.id, { onUpdate: v })}
                          className="w-full"
                        />
                      </td>
                      <td className="px-1.5 py-px text-center">
                        <button
                          onClick={() => fk._isNew
                            ? setForeignKeys(prev => prev.filter(f => f.id !== fk.id))
                            : updateForeignKey(fk.id, { _isDeleted: true })
                          }
                          className={iconBtnDanger}
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <button
              onClick={addForeignKey}
              className="m-2 flex items-center gap-1 text-xs text-foreground-muted hover:text-accent px-2 py-1 transition-colors duration-200"
            >
              <Plus size={13} />
              添加外键
            </button>
          </>
        ) : (
          <IndexEditorWrapper
            indexes={indexes}
            columns={columns}
            tableName={effectiveTableName}
            setIndexes={setIndexes}
          />
        )}
      </div>

      {/* Resize Handle */}
      <div
        className="flex-shrink-0 h-[4.5px] cursor-row-resize hover:bg-accent z-10 transition-colors border-t border-border-default"
        style={isPreviewResizing ? { backgroundColor: 'var(--accent)' } : undefined}
        onMouseDown={handlePreviewResizeStart}
      />

      {/* SQL Preview + Actions */}
      <div
        className="flex-shrink-0 flex flex-col px-3 py-2 bg-background-void"
        style={{ height: previewHeight, transition: isPreviewResizing ? 'none' : 'height 150ms ease' }}
      >
        <div className="text-xs text-foreground-muted mb-1">
          {tableName ? t('tableManage.alterPreview') : t('tableManage.createPreview')}
        </div>
        <textarea
          readOnly
          className="w-full flex-1 min-h-0 bg-background-base border border-border-default rounded p-2 font-mono text-xs text-foreground-default outline-none resize-none"
          value={previewSql}
          spellCheck={false}
        />
        <div className="flex items-center justify-end gap-2 mt-2">
          {hasChanges && (
            <button
              onClick={handleDiscard}
              className="flex items-center gap-1 px-2 py-1 hover:bg-background-hover rounded text-xs text-foreground-muted hover:text-foreground-default transition-colors duration-200"
            >
              <RotateCcw size={12} />
              {t('tableDataView.discardChanges')}
            </button>
          )}
          <button
            onClick={handleExecute}
            disabled={isLoading || !hasChanges || isLoadingData}
            className="flex items-center gap-1 px-2 py-1 bg-accent hover:bg-accent-hover text-foreground rounded text-xs disabled:opacity-50 transition-colors duration-200"
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
