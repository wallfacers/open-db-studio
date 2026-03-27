import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronUp, ChevronDown, Check, RotateCcw } from 'lucide-react';
import { useConnectionStore } from '../../store/connectionStore';
import type { ToastLevel } from '../Toast';
import { DropdownSelect } from '../common/DropdownSelect';

interface EditableColumn {
  id: string;
  name: string;
  dataType: string;
  length: string;
  isNullable: boolean;
  defaultValue: string;
  isPrimaryKey: boolean;
  extra: string;
  comment: string;
  _originalName?: string;
  _isNew?: boolean;
  _isDeleted?: boolean;
}

const COMMON_TYPES = ['INT', 'BIGINT', 'VARCHAR', 'TEXT', 'BOOLEAN', 'FLOAT', 'DOUBLE', 'DECIMAL', 'DATE', 'DATETIME', 'TIMESTAMP', 'JSON'];

const getTypeOptions = (dataType: string) => {
  const opts = COMMON_TYPES.map(tp => ({ value: tp, label: tp }));
  if (dataType && !COMMON_TYPES.includes(dataType)) {
    opts.push({ value: dataType, label: dataType });
  }
  return opts;
};

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
    const comment = col.comment && !isPostgres ? `COMMENT '${col.comment.replace(/'/g, "\\'")}'` : '';
    return [q(col.name), type, nullable, def, extra, comment].filter(Boolean).join(' ');
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
    return prevOrigIdx > currOrigIdx;
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
        || orig.comment !== col.comment
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
          if (orig.comment !== col.comment) {
            statements.push(col.comment
              ? `COMMENT ON COLUMN ${tbl}.${q(col.name)} IS '${col.comment.replace(/'/g, "''")}';`
              : `COMMENT ON COLUMN ${tbl}.${q(col.name)} IS NULL;`
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

function makeId() { return Math.random().toString(36).slice(2); }

interface TableStructureViewProps {
  connectionId: number;
  tableName?: string;
  database?: string;
  schema?: string;
  initialColumns?: Array<{
    name: string; data_type: string; length?: string;
    is_nullable?: boolean; default_value?: string;
    is_primary_key?: boolean; extra?: string; comment?: string;
  }>;
  initialTableName?: string;
  onSuccess: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}

export const TableStructureView: React.FC<TableStructureViewProps> = ({
  connectionId, tableName, database, schema, initialColumns, initialTableName, onSuccess, showToast
}) => {
  const { t } = useTranslation();
  const [columns, setColumns] = useState<EditableColumn[]>([]);
  const [originalColumns, setOriginalColumns] = useState<EditableColumn[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [newTableName, setNewTableName] = useState(initialTableName || tableName || '');

  const { connections } = useConnectionStore();
  const driver = connections.find(c => c.id === connectionId)?.driver ?? 'mysql';

  useEffect(() => {
    if (!tableName) {
      const initCols: EditableColumn[] = initialColumns && initialColumns.length > 0
        ? initialColumns.map(c => ({
            id: makeId(),
            name: c.name,
            dataType: (c.data_type ?? 'VARCHAR').toUpperCase(),
            length: c.length ?? '',
            isNullable: c.is_nullable ?? true,
            defaultValue: c.default_value ?? '',
            isPrimaryKey: c.is_primary_key ?? false,
            extra: c.extra ?? '',
            comment: c.comment ?? '',
            _isNew: true,
          }))
        : [{
            id: makeId(), name: 'id', dataType: 'INT', length: '', isNullable: false,
            defaultValue: '', isPrimaryKey: true, extra: 'auto_increment', comment: '', _isNew: true,
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
        comment: string | null;
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
        comment: c.comment ?? '',
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
      setColumns(originalColumns.map(c => ({ ...c })));
    }
  };

  const visibleColumns = columns.filter(c => !c._isDeleted);
  const effectiveTableName = tableName ?? newTableName;
  const previewSql = effectiveTableName.trim()
    ? generateSql(effectiveTableName, originalColumns, columns, driver, !tableName)
    : '-- 请先填写表名';

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

  return (
    <div className="flex-1 flex flex-col bg-[#080d12] overflow-hidden min-h-0">
      {/* Toolbar */}
      {!tableName && (
        <div className="h-10 flex items-center px-3 border-b border-[#1e2d42] bg-[#080d12] text-xs flex-shrink-0">
          <input
            className="bg-[#0d1520] border border-[#2a3f5a] rounded px-2 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84] w-40"
            placeholder={t('tableManage.tableName') + '...'}
            value={newTableName}
            onChange={e => setNewTableName(e.target.value)}
          />
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
                <tr key={col.id} className={`hover:bg-[#1a2639] border-b border-[#1e2d42] group ${col._isNew ? 'bg-green-900/10' : ''}`}>
                  <td className="w-[30px] px-1 py-1.5 border-r border-[#1e2d42] text-[#7a9bb8] bg-[#0d1117] text-center text-xs cursor-default select-none">
                    {idx + 1}
                  </td>
                  <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
                    <input
                      className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
                      value={col.name}
                      onChange={e => updateColumn(col.id, { name: e.target.value })}
                    />
                  </td>
                  <td className="px-1.5 py-1 border-r border-[#1e2d42]">
                    <DropdownSelect
                      value={col.dataType}
                      options={getTypeOptions(col.dataType)}
                      onChange={v => updateColumn(col.id, { dataType: v })}
                      className="w-full"
                    />
                  </td>
                  <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
                    <input
                      className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
                      value={col.length}
                      onChange={e => updateColumn(col.id, { length: e.target.value })}
                      placeholder="—"
                    />
                  </td>
                  <td className="px-1.5 py-1 border-r border-[#1e2d42] text-center">
                    <input
                      type="checkbox"
                      checked={col.isNullable}
                      onChange={e => updateColumn(col.id, { isNullable: e.target.checked })}
                      className="accent-[#009e84]"
                    />
                  </td>
                  <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
                    <input
                      className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
                      value={col.defaultValue}
                      onChange={e => updateColumn(col.id, { defaultValue: e.target.value })}
                      placeholder="—"
                    />
                  </td>
                  <td className="px-1.5 py-1 border-r border-[#1e2d42] text-center">
                    <input
                      type="checkbox"
                      checked={col.isPrimaryKey}
                      onChange={e => updateColumn(col.id, { isPrimaryKey: e.target.checked })}
                      className="accent-[#3794ff]"
                    />
                  </td>
                  <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
                    <input
                      className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
                      value={col.extra}
                      onChange={e => updateColumn(col.id, { extra: e.target.value })}
                      placeholder="—"
                    />
                  </td>
                  <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
                    <input
                      className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
                      value={col.comment}
                      onChange={e => updateColumn(col.id, { comment: e.target.value })}
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
                        disabled={idx === visibleColumns.length - 1}
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

      {/* SQL Preview + Actions */}
      <div className="flex-shrink-0 border-t border-[#1e2d42] px-3 py-2 bg-[#080d12]">
        <div className="text-xs text-[#7a9bb8] mb-1">
          {tableName ? t('tableManage.alterPreview') : t('tableManage.createPreview')}
        </div>
        <textarea
          readOnly
          className="w-full bg-[#0d1520] border border-[#1e2d42] rounded p-2 font-mono text-xs text-[#c8daea] outline-none resize-none h-[72px]"
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
