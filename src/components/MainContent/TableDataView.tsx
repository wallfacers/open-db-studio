import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useConnectionStore } from '../../store';
import type { QueryResult, ColumnMeta } from '../../types';
import { ChevronLeft, ChevronRight, RefreshCw, Filter, Download, Check, RotateCcw } from 'lucide-react';
import { ExportDialog } from '../ExportDialog';
import type { ToastLevel } from '../Toast';
import { Tooltip } from '../common/Tooltip';
import { EditableCell } from './EditableCell';
import { RowContextMenu, type ClickTarget } from './RowContextMenu';
import { usePendingChanges, type RowData } from './usePendingChanges';

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
  const [_columns, setColumns] = useState<ColumnMeta[]>([]);
  const [pkColumn, setPkColumn] = useState<string>('id');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(100);
  const [whereClause, setWhereClause] = useState('');
  const [orderClause, setOrderClause] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);

  const { pending, editCell, cloneRow, markDelete, unmarkDelete, discard, hasPending, totalCount } = usePendingChanges();

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
          where_clause: whereClause || null,
          order_clause: orderClause || null,
        }
      });
      setData(result);
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setIsLoading(false);
    }
  }, [activeConnectionId, tableName, page, pageSize, whereClause, orderClause, showToast]);

  useEffect(() => {
    if (!activeConnectionId || !tableName) return;
    invoke<{ columns: ColumnMeta[] }>('get_table_detail', {
      connectionId: activeConnectionId, database: dbName || null, table: tableName
    })
      .then(detail => {
        setColumns(detail.columns);
        const pk = detail.columns.find(c => c.is_primary_key);
        if (pk) setPkColumn(pk.name);
      })
      .catch(() => {});
  }, [activeConnectionId, tableName]);

  useEffect(() => { loadData(); }, [loadData]);

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
      showToast(t('tableDataView.commitSuccess'), 'success');
      loadData();
    } catch (e) {
      showToast(`${t('tableDataView.commitFailed')}: ${String(e)}`, 'error');
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

  const rowBgClass = (rowIdx: number) => {
    if (isRowDeleted(rowIdx)) return 'bg-red-900/20';
    const hasEdits = pending.edits.some(e => e.rowIdx === rowIdx);
    if (hasEdits) return 'bg-yellow-900/20';
    return '';
  };

  return (
    <div className="flex-1 flex flex-col bg-[#080d12] h-full">
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
            <button onClick={loadData} className="p-1 hover:bg-[#1a2639] rounded"><RefreshCw size={14}/></button>
          </Tooltip>
        </div>

        <div className="flex items-center gap-2 text-[#7a9bb8]">
          {hasPending && (
            <>
              <Tooltip content={t('tableDataView.commit')}>
                <button
                  onClick={handleCommit}
                  disabled={isCommitting}
                  className="flex items-center gap-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 text-xs"
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
          <Tooltip content={t('export.exportData')}>
            <button onClick={() => setShowExport(true)} className="p-1 hover:bg-[#1a2639] rounded">
              <Download size={14}/>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="h-8 flex items-center px-3 border-b border-[#1e2d42] bg-[#080d12] text-xs gap-3">
        <Filter size={12} className="text-[#7a9bb8]"/>
        <span className="text-[#7a9bb8]">WHERE</span>
        <input
          className="bg-transparent outline-none text-[#c8daea] flex-1"
          placeholder={t('tableDataView.enterCondition')}
          value={whereClause}
          onChange={e => setWhereClause(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { if (page !== 1) setPage(1); else loadData(); } }}
        />
        <span className="text-[#7a9bb8]">ORDER BY</span>
        <input
          className="bg-transparent outline-none text-[#c8daea] flex-1"
          placeholder={t('tableDataView.enterOrder')}
          value={orderClause}
          onChange={e => setOrderClause(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { if (page !== 1) setPage(1); else loadData(); } }}
        />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-4 text-[#7a9bb8] text-sm">{t('tableDataView.loading')}</div>
        ) : !data ? (
          <div className="p-4 text-[#7a9bb8] text-sm">{t('tableDataView.noData')}</div>
        ) : (
          <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
            <thead className="sticky top-0 bg-[#0d1117] z-10">
              <tr>
                <th className="w-10 px-2 py-1.5 border-b border-r border-[#1e2d42] text-[#7a9bb8] font-normal">#</th>
                {data.columns.map(col => (
                  <th key={col} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">{col}</th>
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
                    />
                  ))}
                </tr>
              ))}
              {/* 克隆的新行（绿色） */}
              {pending.clonedRows.map((row, ci) => (
                <tr key={`cloned-${ci}`} className="border-b border-[#1e2d42] bg-green-900/20">
                  <td className="px-2 py-1.5 border-r border-[#1e2d42] text-green-400 bg-[#0d1117] text-center text-xs">+</td>
                  {row.map((cell, ji) => (
                    <td key={ji} className="px-3 py-1.5 text-green-400 border-r border-[#1e2d42] max-w-[300px] truncate">
                      {cell === null ? <span className="italic text-green-400/60">NULL</span> : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Status Bar */}
      <div className="h-7 flex items-center px-3 border-t border-[#1e2d42] bg-[#080d12] text-[#7a9bb8] text-xs">
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
          onPaste={text => editCell(contextMenu.rowIdx, contextMenu.colIdx, text)}
          showToast={showToast}
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
