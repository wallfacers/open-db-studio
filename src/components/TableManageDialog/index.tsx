import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { useEscClose } from '../../hooks/useEscClose';
import { useConnectionStore } from '../../store/connectionStore';
import type { ToastLevel } from '../Toast';

interface EditableColumn {
  id: string;
  name: string;
  dataType: string;
  length: string;
  isNullable: boolean;
  defaultValue: string;
  isPrimaryKey: boolean;
  extra: string;
  _originalName?: string;
  _isNew?: boolean;
  _isDeleted?: boolean;
}

const COMMON_TYPES = ['INT', 'BIGINT', 'VARCHAR', 'TEXT', 'BOOLEAN', 'FLOAT', 'DOUBLE', 'DECIMAL', 'DATE', 'DATETIME', 'TIMESTAMP', 'JSON'];

function generateSql(
  tableName: string,
  original: EditableColumn[],
  edited: EditableColumn[],
  driver: string,
  isNew: boolean
): string {
  const isPostgres = driver === 'postgres' || driver === 'postgresql';
  const q = (name: string) => isPostgres ? `"${name}"` : `\`${name}\``;

  const colDef = (col: EditableColumn) => {
    const type = col.length ? `${col.dataType}(${col.length})` : col.dataType;
    const nullable = col.isNullable ? 'NULL' : 'NOT NULL';
    const def = col.defaultValue ? `DEFAULT ${col.defaultValue}` : '';
    const extra = col.extra && !isPostgres ? col.extra.toUpperCase() : '';
    return [q(col.name), type, nullable, def, extra].filter(Boolean).join(' ');
  };

  if (isNew) {
    const activeCols = edited.filter(c => !c._isDeleted);
    const pkCols = activeCols.filter(c => c.isPrimaryKey).map(c => q(c.name));
    const lines = activeCols.map(c => `  ${colDef(c)}`);
    if (pkCols.length > 0) lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
    return `CREATE TABLE ${q(tableName)} (\n${lines.join(',\n')}\n);`;
  }

  const tbl = q(tableName);
  const statements: string[] = [];
  const existingEdited = edited.filter(c => !c._isNew && !c._isDeleted);
  const orderChanged = !isPostgres && existingEdited.some((c, i) => {
    if (i === 0) return false;
    const prevOrigIdx = original.findIndex(o => o.name === (existingEdited[i - 1]._originalName ?? existingEdited[i - 1].name));
    const currOrigIdx = original.findIndex(o => o.name === (c._originalName ?? c.name));
    return prevOrigIdx > currOrigIdx; // 前一列在原始顺序中比当前列靠后，说明发生了重排
  });

  for (const col of edited) {
    if (col._isDeleted && !col._isNew) {
      statements.push(`ALTER TABLE ${tbl} DROP COLUMN ${q(col._originalName ?? col.name)};`);
    } else if (col._isNew && !col._isDeleted) {
      statements.push(`ALTER TABLE ${tbl} ADD COLUMN ${colDef(col)};`);
    } else if (!col._isNew && !col._isDeleted) {
      const orig = original.find(o => o.name === (col._originalName ?? col.name));
      if (!orig) continue;
      const changed = orig.name !== col.name
        || orig.dataType !== col.dataType
        || orig.length !== col.length
        || orig.isNullable !== col.isNullable
        || orig.defaultValue !== col.defaultValue
        || orig.extra !== col.extra
        || (orderChanged && !isPostgres);
      if (changed) {
        if (isPostgres) {
          if (orig.dataType !== col.dataType || orig.length !== col.length) {
            const type = col.length ? `${col.dataType}(${col.length})` : col.dataType;
            statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name)} TYPE ${type};`);
          }
          if (orig.isNullable !== col.isNullable) {
            statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name)} ${col.isNullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
          }
          if (orig.defaultValue !== col.defaultValue) {
            statements.push(col.defaultValue
              ? `ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name)} SET DEFAULT ${col.defaultValue};`
              : `ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name)} DROP DEFAULT;`
            );
          }
        } else {
          const activeEdited = edited.filter(c => !c._isDeleted);
          const idx = activeEdited.indexOf(col);
          const after = idx <= 0 ? 'FIRST' : `AFTER ${q(activeEdited[idx - 1].name)}`;
          statements.push(`ALTER TABLE ${tbl} MODIFY COLUMN ${colDef(col)} ${after};`);
        }
      }
    }
  }

  // 主键变化
  const origPks = original.filter(c => c.isPrimaryKey).map(c => q(c.name));
  const newPks = edited.filter(c => c.isPrimaryKey && !c._isDeleted).map(c => q(c.name));
  const pkChanged = JSON.stringify([...origPks].sort()) !== JSON.stringify([...newPks].sort());
  if (pkChanged) {
    if (isPostgres) {
      statements.push(`ALTER TABLE ${tbl} DROP CONSTRAINT IF EXISTS ${tbl}_pkey;`);
      if (newPks.length > 0) statements.push(`ALTER TABLE ${tbl} ADD PRIMARY KEY (${newPks.join(', ')});`);
    } else {
      statements.push(`ALTER TABLE ${tbl} DROP PRIMARY KEY;`);
      if (newPks.length > 0) statements.push(`ALTER TABLE ${tbl} ADD PRIMARY KEY (${newPks.join(', ')});`);
    }
  }

  return statements.length > 0 ? statements.join('\n') : '-- 无变更';
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

function makeId() { return Math.random().toString(36).slice(2); }

export const TableManageDialog: React.FC<Props> = ({
  connectionId, tableName, database, schema, onClose, onSuccess, showToast
}) => {
  const { t } = useTranslation();
  const [columns, setColumns] = useState<EditableColumn[]>([]);
  const [originalColumns, setOriginalColumns] = useState<EditableColumn[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(false);

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
    }>('get_table_detail', {
      connectionId, database: database ?? null, schema: schema ?? null, table: tableName
    }).then(detail => {
      const cols: EditableColumn[] = detail.columns.map(c => ({
        id: makeId(),
        name: c.name,
        dataType: c.data_type.toUpperCase().split('(')[0],
        length: c.data_type.match(/\((\d+)\)/)?.[1] ?? '',
        isNullable: c.is_nullable,
        defaultValue: c.column_default ?? '',
        isPrimaryKey: c.is_primary_key,
        extra: c.extra ?? '',
        _originalName: c.name,
      }));
      setColumns(cols);
      setOriginalColumns(cols.map(c => ({ ...c })));
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

  const previewSql = generateSql(tableName ?? 'new_table', originalColumns, columns, driver, !tableName);

  const handleExecute = async () => {
    if (previewSql.startsWith('-- ')) return;
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
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const visibleColumns = columns.filter(c => !c._isDeleted);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[800px] max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[#1e2d42]">
          <span className="text-[#c8daea] text-sm font-medium">
            {tableName ? t('tableManage.editTable', { table: tableName }) : t('tableManage.createTable')}
          </span>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]"><X size={16} /></button>
        </div>

        <div className="overflow-auto flex-1 p-4">
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
                  <th className="w-[70px]"></th>
                </tr>
              </thead>
              <tbody>
                {visibleColumns.map((col, idx) => (
                  <tr key={col.id} className="border-b border-[#1a2639] hover:bg-[#1a2639]/40">
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                        value={col.name}
                        onChange={e => updateColumn(col.id, { name: e.target.value })}
                      />
                    </td>
                    <td className="py-1 px-2">
                      <select
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                        value={col.dataType}
                        onChange={e => updateColumn(col.id, { dataType: e.target.value })}
                      >
                        {COMMON_TYPES.map(tp => <option key={tp} value={tp}>{tp}</option>)}
                        {!COMMON_TYPES.includes(col.dataType) && <option value={col.dataType}>{col.dataType}</option>}
                      </select>
                    </td>
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                        value={col.length}
                        onChange={e => updateColumn(col.id, { length: e.target.value })}
                        placeholder="—"
                      />
                    </td>
                    <td className="py-1 px-2 text-center">
                      <input
                        type="checkbox"
                        checked={col.isNullable}
                        onChange={e => updateColumn(col.id, { isNullable: e.target.checked })}
                        className="accent-[#009e84]"
                      />
                    </td>
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                        value={col.defaultValue}
                        onChange={e => updateColumn(col.id, { defaultValue: e.target.value })}
                        placeholder="—"
                      />
                    </td>
                    <td className="py-1 px-2 text-center">
                      <input
                        type="checkbox"
                        checked={col.isPrimaryKey}
                        onChange={e => updateColumn(col.id, { isPrimaryKey: e.target.checked })}
                        className="accent-[#3794ff]"
                      />
                    </td>
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                        value={col.extra}
                        onChange={e => updateColumn(col.id, { extra: e.target.value })}
                        placeholder="—"
                      />
                    </td>
                    <td className="py-1 px-2">
                      <div className="flex items-center gap-0.5 justify-center">
                        <button
                          onClick={() => moveColumn(col.id, 'up')}
                          disabled={idx === 0}
                          className="text-[#7a9bb8] hover:text-[#c8daea] disabled:opacity-30 p-0.5"
                        ><ChevronUp size={12} /></button>
                        <button
                          onClick={() => moveColumn(col.id, 'down')}
                          disabled={idx === visibleColumns.length - 1}
                          className="text-[#7a9bb8] hover:text-[#c8daea] disabled:opacity-30 p-0.5"
                        ><ChevronDown size={12} /></button>
                        <button
                          onClick={() => col._isNew
                            ? setColumns(prev => prev.filter(c => c.id !== col.id))
                            : updateColumn(col.id, { _isDeleted: true })
                          }
                          className="text-red-500/70 hover:text-red-400 p-0.5"
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
            className="mt-2 flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#009e84] px-2 py-1"
          >
            <Plus size={13} />
            {t('tableManage.addColumn')}
          </button>
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
            disabled={isLoading || previewSql.startsWith('-- ') || isLoadingData}
            className="px-3 py-1.5 bg-[#3794ff] text-[#c8daea] hover:bg-[#2b7cdb] rounded text-xs disabled:opacity-50"
          >
            {isLoading
              ? t('common.executing')
              : tableName ? t('tableManage.executeAlter') : t('tableManage.executeCreate')}
          </button>
        </div>
      </div>
    </div>
  );
};
