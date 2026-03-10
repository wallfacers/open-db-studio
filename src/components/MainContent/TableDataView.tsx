import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useConnectionStore } from '../../store';
import type { QueryResult, ColumnMeta } from '../../types';
import { ChevronLeft, ChevronRight, RefreshCw, Filter } from 'lucide-react';

interface TableDataViewProps {
  tableName: string;
  dbName: string;
  showToast: (msg: string) => void;
}

export const TableDataView: React.FC<TableDataViewProps> = ({ tableName, showToast }) => {
  const { t } = useTranslation();
  const { activeConnectionId } = useConnectionStore();
  const [data, setData] = useState<QueryResult | null>(null);
  // _columns is kept to derive pkColumn; not rendered directly
  const [_columns, setColumns] = useState<ColumnMeta[]>([]);
  const [pkColumn, setPkColumn] = useState<string>('id');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(100);
  const [total, setTotal] = useState(0);
  const [whereClause, setWhereClause] = useState('');
  const [orderClause, setOrderClause] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [editingCell, setEditingCell] = useState<{row: number; col: string; value: string} | null>(null);

  const loadData = useCallback(async () => {
    if (!activeConnectionId || !tableName) return;
    setIsLoading(true);
    try {
      const result = await invoke<QueryResult>('get_table_data', {
        params: {
          connection_id: activeConnectionId,
          table: tableName,
          page,
          page_size: pageSize,
          where_clause: whereClause || null,
          order_clause: orderClause || null,
        }
      });
      setData(result);
      setTotal(result.row_count);
    } catch (e) {
      showToast(String(e));
    } finally {
      setIsLoading(false);
    }
  }, [activeConnectionId, tableName, page, pageSize, whereClause, orderClause, showToast]);

  useEffect(() => {
    if (!activeConnectionId || !tableName) return;
    invoke<{ columns: ColumnMeta[] }>('get_table_detail', { connectionId: activeConnectionId, table: tableName })
      .then(detail => {
        setColumns(detail.columns);
        const pk = detail.columns.find(c => c.is_primary_key);
        if (pk) setPkColumn(pk.name);
      })
      .catch(() => {});
  }, [activeConnectionId, tableName]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleCellDoubleClick = (rowIdx: number, colName: string, currentValue: string) => {
    setEditingCell({ row: rowIdx, col: colName, value: currentValue });
  };

  const handleCellSave = async () => {
    if (!editingCell || !activeConnectionId || !data) return;
    const pkColIdx = data.columns.indexOf(pkColumn);
    const pkValue = pkColIdx >= 0 ? String(data.rows[editingCell.row][pkColIdx] ?? '') : '';
    try {
      await invoke('update_row', {
        connectionId: activeConnectionId,
        table: tableName,
        pkColumn,
        pkValue,
        column: editingCell.col,
        newValue: editingCell.value,
      });
      showToast(t('tableDataView.updateSuccess'));
      setEditingCell(null);
      loadData();
    } catch (e) {
      showToast(String(e));
    }
  };

  const handleDeleteRow = async (rowIdx: number) => {
    if (!activeConnectionId || !data) return;
    const pkColIdx = data.columns.indexOf(pkColumn);
    const pkValue = pkColIdx >= 0 ? String(data.rows[rowIdx][pkColIdx] ?? '') : '';
    if (!window.confirm(t('tableDataView.confirmDelete'))) return;
    try {
      await invoke('delete_row', { connectionId: activeConnectionId, table: tableName, pkColumn, pkValue });
      showToast(t('tableDataView.deleteSuccess'));
      loadData();
    } catch (e) {
      showToast(String(e));
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-[#1e1e1e] h-full">
      {/* Toolbar */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] text-xs">
        <div className="flex items-center space-x-2 text-[#858585]">
          <button disabled={page <= 1} onClick={() => setPage(1)} className="p-1 hover:bg-[#2b2b2b] rounded disabled:opacity-30">|&lt;</button>
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="p-1 hover:bg-[#2b2b2b] rounded disabled:opacity-30"><ChevronLeft size={14}/></button>
          <span className="text-[#d4d4d4]">{page}</span>
          <button onClick={() => setPage(p => p + 1)} className="p-1 hover:bg-[#2b2b2b] rounded"><ChevronRight size={14}/></button>
          <span className="text-[#858585]">{t('tableDataView.total')} {total}</span>
          <button onClick={loadData} className="p-1 hover:bg-[#2b2b2b] rounded" title={t('tableDataView.refreshData')}><RefreshCw size={14}/></button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="h-8 flex items-center px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] text-xs gap-3">
        <Filter size={12} className="text-[#858585]"/>
        <span className="text-[#858585]">WHERE</span>
        <input
          className="bg-transparent outline-none text-[#d4d4d4] flex-1"
          placeholder={t('tableDataView.enterCondition')}
          value={whereClause}
          onChange={e => setWhereClause(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loadData()}
        />
        <span className="text-[#858585]">ORDER BY</span>
        <input
          className="bg-transparent outline-none text-[#d4d4d4] flex-1"
          placeholder={t('tableDataView.enterOrder')}
          value={orderClause}
          onChange={e => setOrderClause(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loadData()}
        />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-4 text-[#858585] text-sm">{t('tableDataView.loading')}</div>
        ) : !data ? (
          <div className="p-4 text-[#858585] text-sm">{t('tableDataView.noData')}</div>
        ) : (
          <table className="w-full text-left border-collapse whitespace-nowrap text-[13px]">
            <thead className="sticky top-0 bg-[#252526] z-10">
              <tr>
                <th className="w-10 px-2 py-1.5 border-b border-r border-[#2b2b2b] text-[#858585] font-normal">#</th>
                {data.columns.map(col => (
                  <th key={col} className="px-3 py-1.5 border-b border-r border-[#2b2b2b] text-[#d4d4d4] font-normal">{col}</th>
                ))}
                <th className="w-16 px-2 py-1.5 border-b border-[#2b2b2b] text-[#858585] font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, ri) => (
                <tr key={ri} className="hover:bg-[#2a2d2e] border-b border-[#2b2b2b] group">
                  <td className="px-2 py-1.5 border-r border-[#2b2b2b] text-[#858585] bg-[#252526] text-center text-xs">{(page - 1) * pageSize + ri + 1}</td>
                  {row.map((cell, ci) => {
                    const colName = data.columns[ci];
                    const isEditing = editingCell?.row === ri && editingCell?.col === colName;
                    return (
                      <td
                        key={ci}
                        className="px-3 py-1.5 text-[#d4d4d4] border-r border-[#2b2b2b] max-w-[300px]"
                        onDoubleClick={() => handleCellDoubleClick(ri, colName, cell === null ? '' : String(cell))}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            className="bg-[#2b2b2b] text-[#d4d4d4] outline-none border border-[#3794ff] rounded px-1 w-full"
                            value={editingCell.value}
                            onChange={e => setEditingCell({ ...editingCell, value: e.target.value })}
                            onKeyDown={e => { if (e.key === 'Enter') handleCellSave(); if (e.key === 'Escape') setEditingCell(null); }}
                            onBlur={handleCellSave}
                          />
                        ) : (
                          <span className="truncate block">{cell === null ? <span className="text-[#858585] italic">NULL</span> : String(cell)}</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleDeleteRow(ri)}
                      className="text-red-400 hover:text-red-300 text-xs px-1"
                      title={t('tableDataView.deleteRow')}
                    >✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Status Bar */}
      <div className="h-7 flex items-center px-3 border-t border-[#2b2b2b] bg-[#181818] text-[#858585] text-xs">
        {data && <span>{data.row_count} {t('tableDataView.row')} · {data.duration_ms}ms</span>}
      </div>
    </div>
  );
};
