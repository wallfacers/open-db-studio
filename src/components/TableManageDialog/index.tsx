import React, { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2, ChevronUp, ChevronDown, Sparkles } from 'lucide-react';
import { useEscClose } from '../../hooks/useEscClose';
import { useConnectionStore } from '../../store/connectionStore';
import { generateTableSql } from '../../mcp/ui/adapters/TableFormAdapter';
import type { ToastLevel } from '../Toast';
import { DropdownSelect } from '../common/DropdownSelect';
import type { EditableColumn, TableFormForeignKey, TableFormIndex } from '../../store/tableFormStore';

interface AiColumnDef {
  name: string;
  column_type: string;
  length: number | null;
  nullable: boolean;
  default_value: string | null;
  primary_key: boolean;
  auto_increment: boolean;
  comment: string;
}

interface TableSchemaResult {
  table_name: string;
  columns: AiColumnDef[];
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

function mapAiColumn(col: AiColumnDef, driver: string): EditableColumn {
  const isPostgres = driver === 'postgres' || driver === 'postgresql';
  // PostgreSQL 中 auto_increment 通过 SERIAL 类型表达
  const dataType = (isPostgres && col.auto_increment) ? 'SERIAL' : col.column_type;
  const extra = (!isPostgres && col.auto_increment) ? 'auto_increment' : '';
  return {
    id: makeId(),
    name: col.name,
    dataType,
    length: col.length ? String(col.length) : '',
    isNullable: col.nullable,
    defaultValue: col.default_value ?? '',
    isPrimaryKey: col.primary_key,
    extra,
    _isNew: true,
  };
}

interface Props {
  connectionId: number;
  tableName?: string;
  database?: string;
  schema?: string;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}

export const TableManageDialog: React.FC<Props> = ({
  connectionId, tableName, database, schema, onClose, onSuccess, showToast
}) => {
  const { t } = useTranslation();
  type ActiveTab = 'columns' | 'foreignKeys' | 'indexes'
  const [activeTab, setActiveTab] = useState<ActiveTab>('columns')
  const [foreignKeys, setForeignKeys] = useState<TableFormForeignKey[]>([])
  const [originalForeignKeys, setOriginalForeignKeys] = useState<TableFormForeignKey[]>([])
  const [indexes, setIndexes] = useState<TableFormIndex[]>([])
  const [originalIndexes, setOriginalIndexes] = useState<TableFormIndex[]>([])
  const [columns, setColumns] = useState<EditableColumn[]>([]);
  const [originalColumns, setOriginalColumns] = useState<EditableColumn[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [localTableName, setLocalTableName] = useState('');

  // AI 面板状态
  const [aiPanelOpen, setAiPanelOpen] = useState(true);
  const [aiDescription, setAiDescription] = useState('');
  type AiState = 'idle' | 'loading' | 'error' | 'confirming' | 'filling';
  const [aiState, setAiState] = useState<AiState>('idle');
  const [aiError, setAiError] = useState('');
  const [pendingAiCols, setPendingAiCols] = useState<{
    cols: EditableColumn[];
    count: number;
    existingCount: number;
  } | null>(null);

  // 卸载守卫
  const mountedRef = useRef(true);
  const fillingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fillingRef.current = false;
    };
  }, []);

  const { connections } = useConnectionStore();
  const driver = connections.find(c => c.id === connectionId)?.driver ?? 'mysql';

  useEscClose(onClose);

  useEffect(() => {
    if (!tableName) {
      const initCols: EditableColumn[] = [{
        id: makeId(), name: 'id', dataType: 'INT', length: '', isNullable: false,
        defaultValue: '', isPrimaryKey: true, extra: 'auto_increment', _isNew: true,
      }];
      setColumns(initCols);
      setOriginalColumns([]);
      return;
    }
    setIsLoadingData(true);
    invoke<{
      name: string;
      columns: Array<{
        name: string; data_type: string; is_nullable: boolean;
        column_default: string | null; is_primary_key: boolean; extra: string | null;
      }>;
      foreign_keys: Array<{
        constraint_name: string;
        column: string;
        referenced_table: string;
        referenced_column: string;
      }>;
      indexes: Array<{
        index_name: string;
        is_unique: boolean;
        columns: string[];
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
        _originalName: c.name,
      }));
      setColumns(cols);
      setOriginalColumns(cols.map(c => ({ ...c })));

      const fks: TableFormForeignKey[] = (detail.foreign_keys ?? []).map(fk => ({
        id: makeId(),
        constraintName: fk.constraint_name,
        column: fk.column,
        referencedTable: fk.referenced_table,
        referencedColumn: fk.referenced_column,
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        _originalName: fk.constraint_name,
      }))
      setForeignKeys(fks)
      setOriginalForeignKeys(fks.map(f => ({ ...f })))

      const idxs: TableFormIndex[] = (detail.indexes ?? []).map(idx => ({
        id: makeId(),
        name: idx.index_name,
        type: idx.is_unique ? 'UNIQUE' : 'INDEX',
        columns: JSON.stringify(idx.columns.map(c => ({ name: c, order: 'ASC' }))),
        _originalName: idx.index_name,
      }))
      setIndexes(idxs)
      setOriginalIndexes(idxs.map(i => ({ ...i })))
    }).catch(e => {
      showToast(`${t('tableManage.loadFailed')}: ${String(e)}`, 'error');
    }).finally(() => setIsLoadingData(false));
  }, [tableName, connectionId, database, schema]);

  const updateColumn = useCallback((id: string, patch: Partial<EditableColumn>) => {
    setColumns(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  }, []);

  const addColumn = useCallback(() => {
    setColumns(prev => [...prev, {
      id: makeId(), name: 'new_column', dataType: 'VARCHAR', length: '255',
      isNullable: true, defaultValue: '', isPrimaryKey: false, extra: '', _isNew: true,
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

  const fillColumns = async (newCols: EditableColumn[], mode: 'replace' | 'append') => {
    fillingRef.current = true;
    if (mode === 'replace') setColumns([]);
    for (const col of newCols) {
      if (!fillingRef.current || !mountedRef.current) break;
      await new Promise(r => setTimeout(r, 80));
      if (!mountedRef.current) break;
      setColumns(prev => [...prev, col]);
    }
    fillingRef.current = false;
    if (mountedRef.current) {
      setAiState('idle');
      setAiPanelOpen(false);
    }
  };

  const handleAiGenerate = async () => {
    if (!aiDescription.trim()) return;
    setAiState('loading');
    setAiError('');

    let result: TableSchemaResult;
    try {
      result = await invoke<TableSchemaResult>('ai_generate_table_schema', {
        description: aiDescription,
        connectionId,
      });
    } catch (e) {
      if (!mountedRef.current) return;
      setAiState('error');
      setAiError(String(e));
      return;
    }

    if (!mountedRef.current) return;

    const mappedCols = result.columns.map(c => mapAiColumn(c, driver));
    setLocalTableName(result.table_name);

    const currentVisible = columns.filter(c => !c._isDeleted);
    if (currentVisible.length > 0) {
      setAiState('confirming');
      setPendingAiCols({ cols: mappedCols, count: mappedCols.length, existingCount: currentVisible.length });
    } else {
      setAiState('filling');
      fillColumns(mappedCols, 'replace');
    }
  };

  const isAiBusy = aiState === 'loading' || aiState === 'confirming' || aiState === 'filling';

  const effectiveTableName = tableName ?? (localTableName || 'new_table');
  const previewSql = generateTableSql({
    tableName: effectiveTableName,
    engine: 'InnoDB', charset: 'utf8mb4', comment: '',
    columns, originalColumns: tableName ? originalColumns : undefined,
    indexes, originalIndexes: tableName ? originalIndexes : undefined,
    foreignKeys, originalForeignKeys: tableName ? originalForeignKeys : undefined,
    isNewTable: !tableName,
  }, driver);

  const handleExecute = async () => {
    if (previewSql.startsWith('-- ')) return;
    if (visibleColumns.some(c => !c.name.trim())) {
      showToast(t('tableManage.columnNameRequired'), 'error');
      return;
    }
    const visibleFks = foreignKeys.filter(fk => !fk._isDeleted)
    if (visibleFks.some(fk => !fk.constraintName || !fk.column || !fk.referencedTable || !fk.referencedColumn)) {
      showToast('外键配置不完整，请填写约束名、列名、引用表和引用列', 'error');
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
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const visibleColumns = columns.filter(c => !c._isDeleted);

  const visibleForeignKeys = foreignKeys.filter(fk => !fk._isDeleted)

  const addForeignKey = () => {
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
  }

  const updateForeignKey = (id: string, patch: Partial<TableFormForeignKey>) => {
    setForeignKeys(prev => prev.map(fk => fk.id === id ? { ...fk, ...patch } : fk))
  }

  const handleFkColumnChange = (id: string, col: string) => {
    setForeignKeys(prev => prev.map(fk => {
      if (fk.id !== id) return fk
      const autoName = !fk.constraintName && col
        ? `fk_${effectiveTableName}_${col}`
        : fk.constraintName
      return { ...fk, column: col, constraintName: autoName }
    }))
  }

  const visibleIndexes = indexes.filter(idx => !idx._isDeleted)

  const addIndex = () => {
    setIndexes(prev => [...prev, {
      id: makeId(),
      name: '',
      type: 'INDEX',
      columns: JSON.stringify([{ name: '', order: 'ASC' }]),
      _isNew: true,
    }])
  }

  const updateIndex = (id: string, patch: Partial<TableFormIndex>) => {
    setIndexes(prev => prev.map(idx => idx.id === id ? { ...idx, ...patch } : idx))
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[960px] max-h-[85vh] flex flex-col relative">
        <div className="flex items-center justify-between p-4 border-b border-[#1e2d42]">
          <span className="text-[#c8daea] text-sm font-medium">
            {tableName ? t('tableManage.editTable', { table: tableName }) : t('tableManage.createTable')}
          </span>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]"><X size={16} /></button>
        </div>

        <div className="overflow-auto flex-1 p-4">
          {/* AI 建表面板（仅新建表时显示）*/}
          {!tableName && (
            <div className="mb-3 border border-[#1e2d42] rounded overflow-hidden">
              <button
                className="w-full flex items-center justify-between px-3 py-2 bg-[#0d1520] text-xs text-[#7a9bb8] hover:text-[#c8daea]"
                onClick={() => setAiPanelOpen(v => !v)}
              >
                <span className="flex items-center gap-1.5">
                  <Sparkles size={13} className="text-[#009e84]" />
                  AI 建表
                </span>
                {aiPanelOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>

              {aiPanelOpen && (
                <div className="p-3 bg-[#111922] space-y-2">
                  <textarea
                    className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84] resize-none h-[60px] disabled:opacity-50"
                    placeholder='描述你想要的表，例如："用户表，包含昵称、头像、手机号、注册时间"'
                    value={aiDescription}
                    onChange={e => setAiDescription(e.target.value)}
                    disabled={aiState === 'loading'}
                  />
                  {aiError && (
                    <p className="text-xs text-red-400">{aiError}</p>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={handleAiGenerate}
                      disabled={aiState === 'loading' || !aiDescription.trim()}
                      className="px-3 py-1 bg-[#009e84] text-white rounded text-xs hover:bg-[#007a67] disabled:opacity-50 flex items-center gap-1"
                    >
                      {aiState === 'loading' ? (
                        <><span className="animate-spin inline-block w-3 h-3 border border-white border-t-transparent rounded-full" /> 正在生成...</>
                      ) : '生成字段 →'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 新建表时显示表名输入 */}
          {!tableName && (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs text-[#7a9bb8] whitespace-nowrap">{t('tableManage.tableName')}</span>
              <input
                className="flex-1 bg-[#0d1520] border border-[#2a3f5a] rounded px-2 py-1 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                value={localTableName}
                onChange={e => setLocalTableName(e.target.value)}
                placeholder="e.g. users"
              />
            </div>
          )}

          {/* Tab 导航 */}
          <div className="flex border-b border-[#1e2d42] mb-3">
            {(['columns', 'foreignKeys', 'indexes'] as ActiveTab[]).map(tab => {
              const labels: Record<ActiveTab, string> = { columns: '字段', foreignKeys: '外键', indexes: '索引' }
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-xs transition-colors duration-200 border-b-2 -mb-px ${
                    activeTab === tab
                      ? 'border-[#009e84] text-[#009e84]'
                      : 'border-transparent text-[#7a9bb8] hover:text-[#c8daea]'
                  }`}
                >
                  {labels[tab]}
                </button>
              )
            })}
          </div>

          {activeTab === 'columns' && (
            <>
          {isLoadingData ? (
            <div className="text-center text-xs text-[#7a9bb8] py-8">{t('tableDataView.loading')}</div>
          ) : (
            <table className="w-full text-xs text-[#c8daea] border-collapse">
              <thead>
                <tr className="border-b border-[#1e2d42]">
                  <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[120px]">{t('tableManage.columnName')}</th>
                  <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[110px]">{t('tableManage.dataType')}</th>
                  <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[60px]">{t('tableManage.length')}</th>
                  <th className="text-center py-1.5 px-2 font-medium text-[#7a9bb8] w-[50px]">{t('tableManage.nullable')}</th>
                  <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[100px]">{t('tableManage.defaultValue')}</th>
                  <th className="text-center py-1.5 px-2 font-medium text-[#7a9bb8] w-[40px]">{t('tableManage.primaryKey')}</th>
                  <th className="text-center py-1.5 px-2 font-medium text-[#7a9bb8] w-[80px]">Extra</th>
                  <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[130px]">Comment</th>
                  <th className="w-[70px]"></th>
                </tr>
              </thead>
              <tbody>
                {visibleColumns.map((col, idx) => (
                  <tr key={col.id} className="border-b border-[#1a2639] hover:bg-[#1a2639]/40">
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84] disabled:opacity-50"
                        value={col.name}
                        onChange={e => updateColumn(col.id, { name: e.target.value })}
                        disabled={isAiBusy}
                      />
                    </td>
                    <td className="py-1 px-2">
                      <div className={isAiBusy ? 'pointer-events-none opacity-50' : ''}>
                        <DropdownSelect
                          value={col.dataType}
                          options={getTypeOptions(col.dataType)}
                          onChange={v => updateColumn(col.id, { dataType: v })}
                          className="w-full"
                        />
                      </div>
                    </td>
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84] disabled:opacity-50"
                        value={col.length ?? ''}
                        onChange={e => updateColumn(col.id, { length: e.target.value })}
                        placeholder="—"
                        disabled={isAiBusy}
                      />
                    </td>
                    <td className="py-1 px-2 text-center">
                      <input
                        type="checkbox"
                        checked={col.isNullable}
                        onChange={e => updateColumn(col.id, { isNullable: e.target.checked })}
                        className="accent-[#009e84]"
                        disabled={isAiBusy}
                      />
                    </td>
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84] disabled:opacity-50"
                        value={col.defaultValue ?? ''}
                        onChange={e => updateColumn(col.id, { defaultValue: e.target.value })}
                        placeholder="—"
                        disabled={isAiBusy}
                      />
                    </td>
                    <td className="py-1 px-2 text-center">
                      <input
                        type="checkbox"
                        checked={col.isPrimaryKey}
                        onChange={e => updateColumn(col.id, { isPrimaryKey: e.target.checked })}
                        className="accent-[#3794ff]"
                        disabled={isAiBusy}
                      />
                    </td>
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84] disabled:opacity-50"
                        value={col.extra}
                        onChange={e => updateColumn(col.id, { extra: e.target.value })}
                        placeholder="—"
                        disabled={isAiBusy}
                      />
                    </td>
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84] disabled:opacity-50"
                        value={col.comment ?? ''}
                        onChange={e => updateColumn(col.id, { comment: e.target.value })}
                        placeholder="—"
                        disabled={isAiBusy}
                      />
                    </td>
                    <td className="py-1 px-2">
                      <div className="flex items-center gap-0.5 justify-center">
                        <button
                          onClick={() => moveColumn(col.id, 'up')}
                          disabled={idx === 0 || isAiBusy}
                          className="text-[#7a9bb8] hover:text-[#c8daea] disabled:opacity-30 p-0.5"
                        ><ChevronUp size={12} /></button>
                        <button
                          onClick={() => moveColumn(col.id, 'down')}
                          disabled={idx === visibleColumns.length - 1 || isAiBusy}
                          className="text-[#7a9bb8] hover:text-[#c8daea] disabled:opacity-30 p-0.5"
                        ><ChevronDown size={12} /></button>
                        <button
                          disabled={isAiBusy}
                          onClick={() => !isAiBusy && (col._isNew
                            ? setColumns(prev => prev.filter(c => c.id !== col.id))
                            : updateColumn(col.id, { _isDeleted: true })
                          )}
                          className="text-red-500/70 hover:text-red-400 p-0.5 disabled:opacity-30"
                        ><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button
            onClick={addColumn}
            disabled={isAiBusy}
            className="mt-2 flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#009e84] px-2 py-1 disabled:opacity-40"
          >
            <Plus size={13} />
            {t('tableManage.addColumn')}
          </button>
            </>
          )}

          {activeTab === 'foreignKeys' && (
            <div className="space-y-1">
              {visibleForeignKeys.length === 0 && (
                <div className="text-xs text-[#7a9bb8] py-4 text-center">暂无外键约束</div>
              )}
              {visibleForeignKeys.length > 0 && (
                <table className="w-full text-xs text-[#c8daea] border-collapse">
                  <thead>
                    <tr className="border-b border-[#1e2d42]">
                      <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[180px]">约束名</th>
                      <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[120px]">当前列</th>
                      <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[120px]">引用表</th>
                      <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[100px]">引用列</th>
                      <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[100px]">ON DELETE</th>
                      <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[100px]">ON UPDATE</th>
                      <th className="w-[30px]"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleForeignKeys.map(fk => {
                      const colOptions = visibleColumns.map(c => ({ value: c.name, label: c.name }))
                      const actionOptions = [
                        { value: 'NO ACTION', label: 'NO ACTION' },
                        { value: 'CASCADE', label: 'CASCADE' },
                        { value: 'SET NULL', label: 'SET NULL' },
                        { value: 'RESTRICT', label: 'RESTRICT' },
                        { value: 'SET DEFAULT', label: 'SET DEFAULT' },
                      ]
                      return (
                        <tr key={fk.id} className="border-b border-[#1a2639] hover:bg-[#1a2639]/40">
                          <td className="py-1 px-2">
                            <input
                              className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                              value={fk.constraintName}
                              onChange={e => updateForeignKey(fk.id, { constraintName: e.target.value })}
                              placeholder="fk_table_col"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <DropdownSelect
                              value={fk.column}
                              options={colOptions}
                              placeholder="选择列"
                              onChange={col => handleFkColumnChange(fk.id, col)}
                              className="w-full"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <input
                              className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                              value={fk.referencedTable}
                              onChange={e => updateForeignKey(fk.id, { referencedTable: e.target.value })}
                              placeholder="users"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <input
                              className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                              value={fk.referencedColumn}
                              onChange={e => updateForeignKey(fk.id, { referencedColumn: e.target.value })}
                              placeholder="id"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <DropdownSelect
                              value={fk.onDelete}
                              options={actionOptions}
                              onChange={v => updateForeignKey(fk.id, { onDelete: v })}
                              className="w-full"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <DropdownSelect
                              value={fk.onUpdate}
                              options={actionOptions}
                              onChange={v => updateForeignKey(fk.id, { onUpdate: v })}
                              className="w-full"
                            />
                          </td>
                          <td className="py-1 px-2 text-center">
                            <button
                              onClick={() => fk._isNew
                                ? setForeignKeys(prev => prev.filter(f => f.id !== fk.id))
                                : updateForeignKey(fk.id, { _isDeleted: true })
                              }
                              className="text-red-500/70 hover:text-red-400 p-0.5"
                            >
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
              <button
                onClick={addForeignKey}
                className="mt-2 flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#009e84] px-2 py-1"
              >
                <Plus size={13} />
                添加外键
              </button>
            </div>
          )}

          {activeTab === 'indexes' && (
            <div className="space-y-1">
              {visibleIndexes.length === 0 && (
                <div className="text-xs text-[#7a9bb8] py-4 text-center">暂无索引</div>
              )}
              {visibleIndexes.length > 0 && (
                <table className="w-full text-xs text-[#c8daea] border-collapse">
                  <thead>
                    <tr className="border-b border-[#1e2d42]">
                      <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[200px]">索引名</th>
                      <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[100px]">类型</th>
                      <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8]">列（JSON）</th>
                      <th className="w-[30px]"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleIndexes.map(idx => {
                      const typeOptions = [
                        { value: 'INDEX', label: 'INDEX' },
                        { value: 'UNIQUE', label: 'UNIQUE' },
                        { value: 'FULLTEXT', label: 'FULLTEXT' },
                      ]
                      return (
                        <tr key={idx.id} className="border-b border-[#1a2639] hover:bg-[#1a2639]/40">
                          <td className="py-1 px-2">
                            <input
                              className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                              value={idx.name}
                              onChange={e => updateIndex(idx.id, { name: e.target.value })}
                              placeholder="idx_table_col"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <DropdownSelect
                              value={idx.type}
                              options={typeOptions}
                              onChange={v => updateIndex(idx.id, { type: v as TableFormIndex['type'] })}
                              className="w-full"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <input
                              className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs font-mono text-[#c8daea] outline-none focus:border-[#009e84]"
                              value={idx.columns}
                              onChange={e => updateIndex(idx.id, { columns: e.target.value })}
                              placeholder='[{"name":"col","order":"ASC"}]'
                            />
                          </td>
                          <td className="py-1 px-2 text-center">
                            <button
                              onClick={() => idx._isNew
                                ? setIndexes(prev => prev.filter(i => i.id !== idx.id))
                                : updateIndex(idx.id, { _isDeleted: true })
                              }
                              className="text-red-500/70 hover:text-red-400 p-0.5"
                            >
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
              <button
                onClick={addIndex}
                className="mt-2 flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#009e84] px-2 py-1"
              >
                <Plus size={13} />
                添加索引
              </button>
            </div>
          )}
        </div>

        <div className="px-4 pb-2">
          <div className="text-xs text-[#7a9bb8] mb-1">
            {tableName ? t('tableManage.alterPreview') : t('tableManage.createPreview')}
          </div>
          <textarea
            readOnly
            className="w-full bg-[#0d1520] border border-[#1e2d42] rounded p-2 font-mono text-xs text-[#c8daea] outline-none resize-none h-[80px]"
            value={previewSql}
            spellCheck={false}
          />
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-[#1e2d42]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-[#1a2639] text-[#7a9bb8] hover:text-[#c8daea] rounded text-xs"
          >{t('common.cancel')}</button>
          <button
            onClick={handleExecute}
            disabled={isLoading || previewSql.startsWith('-- ') || isLoadingData || isAiBusy}
            className="px-3 py-1.5 bg-[#3794ff] text-[#c8daea] hover:bg-[#2b7cdb] rounded text-xs disabled:opacity-50"
          >
            {isLoading
              ? t('common.executing')
              : tableName ? t('tableManage.executeAlter') : t('tableManage.executeCreate')}
          </button>
        </div>

        {/* AI 字段应用确认弹窗 */}
        {aiState === 'confirming' && pendingAiCols && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10 rounded-lg">
            <div className="bg-[#111922] border border-[#253347] rounded-lg p-5 w-[320px] space-y-3">
              <p className="text-sm text-[#c8daea] font-medium">应用 AI 生成的字段</p>
              <p className="text-xs text-[#7a9bb8]">
                AI 已生成 {pendingAiCols.count} 个字段，当前表格已有 {pendingAiCols.existingCount} 个字段。
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => {
                    setAiState('filling');
                    fillColumns(pendingAiCols.cols, 'replace');
                    setPendingAiCols(null);
                  }}
                  className="flex-1 px-2 py-1.5 bg-[#3794ff] text-white rounded text-xs hover:bg-[#2b7cdb]"
                >替换现有字段</button>
                <button
                  onClick={() => {
                    setAiState('filling');
                    fillColumns(pendingAiCols.cols, 'append');
                    setPendingAiCols(null);
                  }}
                  className="flex-1 px-2 py-1.5 bg-[#1a2639] text-[#c8daea] rounded text-xs hover:bg-[#253347]"
                >追加到末尾</button>
                <button
                  onClick={() => {
                    setAiState('idle');
                    setPendingAiCols(null);
                  }}
                  className="px-2 py-1.5 text-[#7a9bb8] rounded text-xs hover:text-[#c8daea]"
                >取消</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
