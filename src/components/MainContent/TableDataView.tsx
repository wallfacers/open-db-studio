import React, { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useConnectionStore } from '../../store';
import type { QueryResult, ColumnMeta } from '../../types';
import { ChevronLeft, ChevronRight, RefreshCw, Filter, Download, Check, RotateCcw, Plus, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { ExportDialog } from '../ExportDialog';
import type { ToastLevel } from '../Toast';
import { Tooltip } from '../common/Tooltip';
import { EditableCell } from './EditableCell';
import { RowContextMenu, type ClickTarget } from './RowContextMenu';
import { usePendingChanges, type RowData } from './usePendingChanges';
import { CellEditorModal } from './CellEditorModal';
import { AutoCompleteInput } from './AutoCompleteInput';
import { DropdownSelect } from '../common/DropdownSelect';

interface TableDataViewProps {
  tableName: string;
  dbName: string;
  connectionId?: number;
  schema?: string;
  showToast: (msg: string, level?: ToastLevel) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  rowIdx: number;
  colIdx: number;
  target: ClickTarget;
}

export const TableDataView: React.FC<TableDataViewProps> = ({
  tableName, dbName, connectionId: propConnectionId, schema, showToast
}) => {
  const { t } = useTranslation();
  const { activeConnectionId: storeConnectionId } = useConnectionStore();
  const activeConnectionId = propConnectionId ?? storeConnectionId;

  const [data, setData] = useState<QueryResult | null>(null);
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [pkColumn, setPkColumn] = useState<string>('id');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(100);
  const [whereClause, setWhereClause] = useState('');
  const [orderClause, setOrderClause] = useState('');
  // 已应用的条件（只有点击搜索时才更新）
  const [appliedWhere, setAppliedWhere] = useState('');
  const [appliedOrder, setAppliedOrder] = useState('');
  // 用于强制刷新的 key（解决条件不变时多次点击无反应的问题）
  const [refreshKey, setRefreshKey] = useState(0);
  // 使用 ref 存储最新条件值，解决 setState 异步导致 loadData 使用旧值的问题
  const appliedWhereRef = useRef('');
  const appliedOrderRef = useRef('');
  // 追踪输入框最新值（onChange 立即同步，绕过 React state 异步问题）
  const latestWhereRef = useRef('');
  const latestOrderRef = useRef('');
  const [isLoading, setIsLoading] = useState(false);
  const [showExport, setShowExport] = useState(false);
  // 可视化查询行状态
  const [filterField, setFilterField] = useState('');
  const [filterOp, setFilterOp] = useState('=');
  const [filterValue, setFilterValue] = useState('');
  // 列头排序状态
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC' | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [cellEditor, setCellEditor] = useState<{ rowIdx: number; colIdx: number; value: string | null; columnName: string } | null>(null);

  const { pending, editCell, cloneRow, addEmptyRow, removeClonedRow, markDelete, unmarkDelete, discard, hasPending, totalCount } = usePendingChanges();

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const loadData = useCallback(async () => {
    if (!activeConnectionId || !tableName) return;
    setIsLoading(true);
    try {
      const result = await invoke<QueryResult>('get_table_data', {
        params: {
          connection_id: activeConnectionId,
          database: dbName || null,
          table: tableName,
          schema: schema || null,
          page,
          page_size: pageSize,
          where_clause: appliedWhereRef.current || null,
          order_clause: appliedOrderRef.current || null,
          filter_column: filterField || null,
          filter_operator: filterOp || null,
          filter_value: (['IS NULL', 'IS NOT NULL'].includes(filterOp)) ? null : (filterValue || null),
          filter_data_type: columns.find(c => c.name === filterField)?.data_type || null,
          sort_column: sortCol,
          sort_direction: sortDir,
        }
      });
      setData(result);
    } catch (e) {
      showToastRef.current(String(e), 'error');
    } finally {
      setIsLoading(false);
    }
  }, [activeConnectionId, dbName, tableName, schema, page, pageSize, refreshKey, filterField, filterOp, filterValue, sortCol, sortDir, columns]);

  useEffect(() => {
    if (!activeConnectionId || !tableName) return;
    setFilterField('');
    setFilterOp('=');
    setFilterValue('');
    setSortCol(null);
    setSortDir(null);
    invoke<{ columns: ColumnMeta[] }>('get_table_detail', {
      connectionId: activeConnectionId, database: dbName || null, table: tableName
    })
      .then(detail => {
        setColumns(detail.columns);
        const pk = detail.columns.find((c: ColumnMeta) => c.is_primary_key);
        if (pk) setPkColumn(pk.name);
      })
      .catch(() => {});
  }, [activeConnectionId, tableName]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSearch = () => {
    appliedWhereRef.current = latestWhereRef.current;
    appliedOrderRef.current = latestOrderRef.current;
    setAppliedWhere(latestWhereRef.current);
    setAppliedOrder(latestOrderRef.current);
    setPage(1);
    setRefreshKey(k => k + 1);
  };

  const handleCommit = async () => {
    if (!activeConnectionId || !data) return;
    setIsCommitting(true);
    try {
      // 1. DELETE
      for (const rowIdx of pending.deletedRowIdxs) {
        const pkColIdx = data.columns.indexOf(pkColumn);
        const pkValue = pkColIdx >= 0 ? String(data.rows[rowIdx][pkColIdx] ?? '') : '';
        await invoke('delete_row', {
          connectionId: activeConnectionId,
          database: dbName || null,
          table: tableName,
          schema: schema || null,
          pkColumn,
          pkValue,
        });
      }
      // 2. UPDATE（按行分组，逐列调用 update_row）
      const editsByRow = new Map<number, typeof pending.edits>();
      for (const edit of pending.edits) {
        if (!editsByRow.has(edit.rowIdx)) editsByRow.set(edit.rowIdx, []);
        editsByRow.get(edit.rowIdx)!.push(edit);
      }
      for (const [rowIdx, edits] of editsByRow.entries()) {
        if (pending.deletedRowIdxs.includes(rowIdx)) continue;
        const pkColIdx = data.columns.indexOf(pkColumn);
        const pkValue = pkColIdx >= 0 ? String(data.rows[rowIdx][pkColIdx] ?? '') : '';
        for (const edit of edits) {
          await invoke('update_row', {
            connectionId: activeConnectionId,
            database: dbName || null,
            table: tableName,
            schema: schema || null,
            pkColumn,
            pkValue,
            column: data.columns[edit.colIdx],
            newValue: edit.newValue ?? '',
          });
        }
      }
      // 3. INSERT（克隆行）
      for (const rowData of pending.clonedRows) {
        await invoke('insert_row', {
          connectionId: activeConnectionId,
          database: dbName || null,
          table: tableName,
          schema: schema || null,
          columns: data.columns,
          values: rowData.map(v => v === null ? null : String(v)),
        });
      }
      discard();
      showToastRef.current(t('tableDataView.commitSuccess'), 'success');
      loadData();
    } catch (e) {
      showToastRef.current(`${t('tableDataView.commitFailed')}: ${String(e)}`, 'error');
    } finally {
      setIsCommitting(false);
    }
  };

  const getPendingValue = (rowIdx: number, colIdx: number) => {
    const edit = pending.edits.find(e => e.rowIdx === rowIdx && e.colIdx === colIdx);
    return edit ? edit.newValue : undefined;
  };

  const isRowDeleted = (rowIdx: number) => pending.deletedRowIdxs.includes(rowIdx);

  const handleContextMenu = (e: React.MouseEvent, rowIdx: number, colIdx: number, target: ClickTarget) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, rowIdx, colIdx, target });
  };

  const openCellEditor = (rowIdx: number, colIdx: number) => {
    if (!data) return;
    const currentVal = getPendingValue(rowIdx, colIdx);
    const rawVal = data.rows[rowIdx][colIdx];
    const value = currentVal !== undefined ? currentVal : (rawVal === null ? null : String(rawVal));
    const columnName = data.columns[colIdx] ?? '';
    setCellEditor({ rowIdx, colIdx, value, columnName });
  };

  const rowBgClass = (rowIdx: number) => {
    if (isRowDeleted(rowIdx)) return 'bg-red-900/20';
    const hasEdits = pending.edits.some(e => e.rowIdx === rowIdx);
    if (hasEdits) return 'bg-yellow-900/20';
    return '';
  };

  return (
    <div className="flex-1 flex flex-col bg-[#080d12] overflow-hidden min-h-0">
      {/* Toolbar */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42] bg-[#080d12] text-xs">
        <div className="flex items-center space-x-2 text-[#7a9bb8]">
          <Tooltip content={t('tableDataView.firstPage')}>
            <button disabled={page <= 1} onClick={() => setPage(1)} className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30">|&lt;</button>
          </Tooltip>
          <Tooltip content={t('tableDataView.prevPage')}>
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30"><ChevronLeft size={14}/></button>
          </Tooltip>
          <span className="text-[#c8daea]">{page}</span>
          <Tooltip content={t('tableDataView.nextPage')}>
            <button
              disabled={!data || data.rows.length < pageSize}
              onClick={() => setPage(p => p + 1)}
              className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30"
            ><ChevronRight size={14}/></button>
          </Tooltip>
          <span className="text-[#7a9bb8]">{pageSize} {t('tableDataView.rowsPerPage')}</span>
          <Tooltip content={t('tableDataView.refreshData')}>
            <button onClick={handleSearch} className="p-1 hover:bg-[#1a2639] rounded">
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''}/>
            </button>
          </Tooltip>
        </div>

        <div className="flex items-center gap-2 text-[#7a9bb8]">
          {hasPending && (
            <>
              <Tooltip content={t('tableDataView.commit')}>
                <button
                  onClick={handleCommit}
                  disabled={isCommitting}
                  className="flex items-center gap-1 px-2 py-1 bg-[#00a98f] hover:bg-[#00c9a7] text-white rounded disabled:opacity-50 text-xs"
                >
                  <Check size={12}/>
                  {t('tableDataView.commitWithCount', { count: totalCount })}
                </button>
              </Tooltip>
              <Tooltip content={t('tableDataView.discardChanges')}>
                <button
                  onClick={discard}
                  className="flex items-center gap-1 px-2 py-1 hover:bg-[#1a2639] rounded text-xs"
                >
                  <RotateCcw size={12}/>
                  {t('tableDataView.discardChanges')}
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip content={t('tableDataView.addRow')}>
            <button
              onClick={() => data && addEmptyRow(data.columns.length)}
              disabled={!data}
              className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30"
            >
              <Plus size={14}/>
            </button>
          </Tooltip>
          <Tooltip content={t('export.exportData')}>
            <button onClick={() => setShowExport(true)} className="p-1 hover:bg-[#1a2639] rounded">
              <Download size={14}/>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* FilterRow — 可视化查询行 */}
      <div className="h-8 flex items-center px-3 border-b border-[#1e2d42] bg-[#080d12] text-xs gap-2">
        <Filter size={12} className="text-[#7a9bb8] flex-shrink-0"/>
        <DropdownSelect
          value={filterField}
          options={columns.map(c => ({ value: c.name, label: c.name }))}
          placeholder={t('tableDataView.filterSelectField')}
          onChange={(v) => {
            setFilterField(v);
            if (!v) { setFilterOp('='); setFilterValue(''); }
          }}
          className="w-36"
        />
        <DropdownSelect
          value={filterOp}
          options={[
            { value: '=', label: '=' },
            { value: '!=', label: '!=' },
            { value: '>', label: '>' },
            { value: '<', label: '<' },
            { value: '>=', label: '>=' },
            { value: '<=', label: '<=' },
            { value: 'LIKE', label: 'LIKE' },
            { value: 'IS NULL', label: 'IS NULL' },
            { value: 'IS NOT NULL', label: 'IS NOT NULL' },
          ]}
          onChange={setFilterOp}
          className="w-28"
        />
        {!['IS NULL', 'IS NOT NULL'].includes(filterOp) && (
          <input
            className="bg-transparent outline-none text-[#c8daea] flex-1 min-w-0"
            placeholder={filterOp === 'LIKE'
              ? t('tableDataView.filterValueLikePlaceholder')
              : t('tableDataView.filterValuePlaceholder')}
            value={filterValue}
            onChange={e => setFilterValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
        )}
        <Tooltip content={t('tableDataView.search')}>
          <button
            onClick={handleSearch}
            className="p-1 hover:bg-[#1a2639] rounded text-[#7a9bb8] hover:text-[#00c9a7] transition-colors flex-shrink-0"
          >
            <Search size={14}/>
          </button>
        </Tooltip>
      </div>

      {/* Filter Bar */}
      <div className="h-8 flex items-center px-3 border-b border-[#1e2d42] bg-[#080d12] text-xs gap-3">
        <Filter size={12} className="text-[#7a9bb8]"/>
        <span className="text-[#7a9bb8]">WHERE</span>
        <AutoCompleteInput
          value={whereClause}
          onChange={(v) => { latestWhereRef.current = v; setWhereClause(v); }}
          onSearch={handleSearch}
          placeholder={t('tableDataView.enterCondition')}
          columns={columns.map(c => c.name)}
        />
        <span className="text-[#7a9bb8]">ORDER BY</span>
        <AutoCompleteInput
          value={orderClause}
          onChange={(v) => { latestOrderRef.current = v; setOrderClause(v); }}
          onSearch={handleSearch}
          placeholder={t('tableDataView.enterOrder')}
          columns={columns.map(c => c.name)}
        />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto relative">
        {isLoading && !data && (
          <div className="absolute inset-0 flex items-center justify-center text-[#7a9bb8] text-sm">{t('tableDataView.loading')}</div>
        )}
        {!isLoading && (!data || data.rows.length === 0) && (
          <div className="absolute inset-0 flex items-center justify-center text-[#7a9bb8] text-sm">{t('tableDataView.noData')}</div>
        )}
        {data && data.rows.length > 0 && (
          <>
          {isLoading && <div className="absolute inset-0 bg-[#080d12]/40 z-10 pointer-events-none" />}
          <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
            <thead className="sticky top-0 bg-[#0d1117] z-10">
              <tr>
                <th className="w-10 px-2 py-1.5 border-b border-r border-[#1e2d42] text-[#7a9bb8] font-normal">{t('tableDataView.serialNo')}</th>
                {data.columns.map(col => (
                  <th key={col} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">
                    <div className="flex items-center justify-between gap-1 w-full">
                      <span>{col}</span>
                      <div className="flex items-center gap-0 flex-shrink-0">
                        <Tooltip content={t('tableDataView.sortAsc')}>
                          <button
                            className={`leading-none p-0 hover:opacity-100 transition-colors ${
                              sortCol === col && sortDir === 'ASC' ? 'text-[#00c9a7]' : 'text-[#3a5a7a] hover:text-[#7a9bb8]'
                            }`}
                            onClick={() => {
                              if (sortCol === col && sortDir === 'ASC') {
                                setSortCol(null); setSortDir(null);
                              } else {
                                setSortCol(col); setSortDir('ASC');
                              }
                            }}
                          >
                            <ChevronUp size={10}/>
                          </button>
                        </Tooltip>
                        <Tooltip content={t('tableDataView.sortDesc')}>
                          <button
                            className={`leading-none p-0 hover:opacity-100 transition-colors ${
                              sortCol === col && sortDir === 'DESC' ? 'text-[#00c9a7]' : 'text-[#3a5a7a] hover:text-[#7a9bb8]'
                            }`}
                            onClick={() => {
                              if (sortCol === col && sortDir === 'DESC') {
                                setSortCol(null); setSortDir(null);
                              } else {
                                setSortCol(col); setSortDir('DESC');
                              }
                            }}
                          >
                            <ChevronDown size={10}/>
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, ri) => (
                <tr
                  key={ri}
                  className={`hover:bg-[#1a2639] border-b border-[#1e2d42] group ${rowBgClass(ri)}`}
                >
                  {/* 行号列 */}
                  <td
                    className="px-2 py-1.5 border-r border-[#1e2d42] text-[#7a9bb8] bg-[#0d1117] text-center text-xs cursor-default select-none"
                    onContextMenu={e => handleContextMenu(e, ri, -1, 'row')}
                  >
                    {(page - 1) * pageSize + ri + 1}
                  </td>
                  {/* 数据单元格 */}
                  {row.map((cell, ci) => (
                    <EditableCell
                      key={ci}
                      value={cell}
                      pendingValue={getPendingValue(ri, ci)}
                      isDeleted={isRowDeleted(ri)}
                      onCommit={newVal => editCell(ri, ci, newVal)}
                      onContextMenu={e => handleContextMenu(e, ri, ci, 'cell')}
                      onOpenEditor={() => openCellEditor(ri, ci)}
                    />
                  ))}
                </tr>
              ))}
              {/* 克隆的新行（绿色） */}
              {pending.clonedRows.map((row, ci) => (
                <tr key={`cloned-${ci}`} className="border-b border-[#1e2d42] bg-green-900/20 group">
                  <td className="px-2 py-1.5 border-r border-[#1e2d42] text-green-400 bg-[#0d1117] text-center text-xs select-none">
                    <button
                      onClick={() => removeClonedRow(ci)}
                      className="text-red-400 hover:text-red-300 leading-none"
                      title={t('tableDataView.deleteRowMenuItem')}
                    >×</button>
                  </td>
                  {row.map((cell, ji) => (
                    <td key={ji} className="px-3 py-1.5 text-green-400 border-r border-[#1e2d42] max-w-[300px] truncate">
                      {cell === null ? <span className="text-[#7a9bb8]">NULL</span> : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </div>

      {/* Status Bar */}
      <div className="flex-shrink-0 h-7 flex items-center px-3 border-t border-[#1e2d42] bg-[#080d12] text-[#7a9bb8] text-xs">
        {data && <span>{data.row_count} {t('tableDataView.row')} · {data.duration_ms}ms</span>}
      </div>

      {/* Context Menu */}
      {contextMenu && data && (
        <RowContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu.target}
          rowData={data.rows[contextMenu.rowIdx] as RowData}
          columns={data.columns}
          colIdx={contextMenu.colIdx}
          pkColumn={pkColumn}
          tableName={tableName}
          onClose={() => setContextMenu(null)}
          onSetNull={() => editCell(contextMenu.rowIdx, contextMenu.colIdx, null)}
          onCloneRow={() => cloneRow(data.rows[contextMenu.rowIdx] as RowData)}
          onDeleteRow={() => {
            if (isRowDeleted(contextMenu.rowIdx)) {
              unmarkDelete(contextMenu.rowIdx);
            } else {
              markDelete(contextMenu.rowIdx);
            }
          }}
          onOpenEditor={contextMenu.colIdx >= 0 ? () => openCellEditor(contextMenu.rowIdx, contextMenu.colIdx) : undefined}
          showToast={showToast}
        />
      )}

      {cellEditor && (
        <CellEditorModal
          value={cellEditor.value}
          columnName={cellEditor.columnName}
          onConfirm={newVal => editCell(cellEditor.rowIdx, cellEditor.colIdx, newVal)}
          onClose={() => setCellEditor(null)}
        />
      )}

      {showExport && activeConnectionId && (
        <ExportDialog
          connectionId={activeConnectionId}
          database={dbName || undefined}
          tableName={tableName}
          schema={schema}
          onClose={() => setShowExport(false)}
          showToast={showToast}
        />
      )}
    </div>
  );
};
