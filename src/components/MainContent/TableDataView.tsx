import React, { useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useConnectionStore, useQueryStore } from '../../store';
import { useAppStore } from '../../store/appStore';
import type { QueryResult, ColumnMeta } from '../../types';
import { ChevronLeft, ChevronRight, RefreshCw, Filter, Download, Check, RotateCcw, Plus, ChevronDown, ChevronUp, ChevronsUpDown, Search } from 'lucide-react';
import { ExportDialog } from '../ExportDialog';
import type { ToastLevel } from '../Toast';
import { Tooltip } from '../common/Tooltip';
import { EditableCell } from './EditableCell';
import { RowContextMenu, type ClickTarget } from './RowContextMenu';
import { usePendingChanges, type RowData } from './usePendingChanges';
import { CellEditorModal } from './CellEditorModal';
import { AutoCompleteInput } from './AutoCompleteInput';
import { DropdownSelect } from '../common/DropdownSelect';
import { VirtualTable } from './VirtualTable';
import { NormalTable } from './NormalTable';
import { useVirtualRows } from '../../hooks/useVirtualRows';

// ─── 独立子组件：持有 virtualizer，避免滚动时重渲染整个 TableDataView ─────────
interface TableScrollContainerProps {
  rowCount: number;
  isLoading: boolean;
  hasData: boolean;
  columns: string[];
  thead: React.ReactNode;
  normalThead: React.ReactNode;
  renderRow: (ri: number) => React.ReactNode;
  useVirtual: boolean;
}

const TableScrollContainer = React.memo(({
  rowCount, isLoading, hasData, columns, thead, normalThead, renderRow, useVirtual,
}: TableScrollContainerProps) => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualRows(rowCount, scrollRef);

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto relative">
      {!hasData && (
        <div className="absolute inset-0 flex items-center justify-center text-[#7a9bb8] text-sm transition-opacity duration-200"
          style={{ opacity: isLoading ? 0.5 : 1 }}>
          {isLoading ? t('tableDataView.loading') : t('tableDataView.noData')}
        </div>
      )}
      {hasData && (
        <>
          <div
            className="absolute inset-0 bg-[#080d12]/40 z-10 pointer-events-none transition-opacity duration-200"
            style={{ opacity: isLoading ? 1 : 0, visibility: isLoading ? 'visible' : 'hidden' }}
          />
          {useVirtual ? (
            <VirtualTable
              columns={columns}
              rowVirtualizer={rowVirtualizer}
              thead={thead}
              renderRow={renderRow}
            />
          ) : (
            <NormalTable
              columns={columns}
              rowCount={rowCount}
              thead={normalThead}
              renderRow={renderRow}
            />
          )}
        </>
      )}
    </div>
  );
});

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
  const tablePageSizeLimit = useAppStore((s) => s.tablePageSizeLimit);
  const initTablePageSizeLimit = useAppStore((s) => s.initTablePageSizeLimit);

  // 订阅外部刷新信号（如截断表后触发）
  const tabId = `table_${activeConnectionId}_${dbName}_${schema ?? ''}_${tableName}`;
  const externalRefreshSignal = useQueryStore(s => s.tableRefreshSignals[tabId] ?? 0);

  const [data, setData] = useState<QueryResult | null>(null);
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [pkColumn, setPkColumn] = useState<string>('id');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [totalRows, setTotalRows] = useState(0);
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

  // 虚拟滚动行数（已移入 TableScrollContainer，此处仅做数量计算传递）
  const virtualRowCount = data ? data.rows.length + pending.clonedRows.length : 0;

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  // 请求序号：每次发起查询时递增，用于丢弃过期响应，防止竞争条件覆盖最新结果
  const requestIdRef = useRef(0);
  // columns ref：避免 columns state 变化导致 loadData 重建进而触发二次请求
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const loadData = useCallback(async () => {
    if (!activeConnectionId || !tableName) return;
    const reqId = ++requestIdRef.current;
    setIsLoading(true);
    try {
      const resp = await invoke<{ data: QueryResult; total_rows: number }>('get_table_data', {
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
          filter_data_type: columnsRef.current.find(c => c.name === filterField)?.data_type || null,
          sort_column: sortCol,
          sort_direction: sortDir,
        }
      });
      if (reqId !== requestIdRef.current) return;
      startTransition(() => {
        setData(resp.data);
        setTotalRows(resp.total_rows);
      });
    } catch (e) {
      if (reqId !== requestIdRef.current) return;
      showToastRef.current(String(e), 'error');
    } finally {
      if (reqId === requestIdRef.current) setIsLoading(false);
    }
  }, [activeConnectionId, dbName, tableName, schema, page, pageSize, refreshKey, externalRefreshSignal, filterField, filterOp, filterValue, sortCol, sortDir]);

  useEffect(() => {
    if (!activeConnectionId || !tableName) return;
    setFilterField('');
    setFilterOp('=');
    setFilterValue('');
    setSortCol(null);
    setSortDir(null);
    setTotalRows(0);
    invoke<{ columns: ColumnMeta[] }>('get_table_detail', {
      connectionId: activeConnectionId, database: dbName || null, schema: schema || null, table: tableName
    })
      .then(detail => {
        setColumns(detail.columns);
        const pk = detail.columns.find((c: ColumnMeta) => c.is_primary_key);
        if (pk) setPkColumn(pk.name);
      })
      .catch(() => {});
  }, [activeConnectionId, tableName]);

  useEffect(() => { initTablePageSizeLimit(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pageSize > tablePageSizeLimit) {
      setPageSize(tablePageSizeLimit);
      setPage(1);
    }
  }, [tablePageSizeLimit]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const getPendingValue = useCallback((rowIdx: number, colIdx: number) => {
    const edit = pending.edits.find(e => e.rowIdx === rowIdx && e.colIdx === colIdx);
    return edit ? edit.newValue : undefined;
  }, [pending.edits]);

  const isRowDeleted = useCallback((rowIdx: number) => pending.deletedRowIdxs.includes(rowIdx), [pending.deletedRowIdxs]);

  const handleContextMenu = useCallback((e: React.MouseEvent, rowIdx: number, colIdx: number, target: ClickTarget) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, rowIdx, colIdx, target });
  }, []);

  const openCellEditor = useCallback((rowIdx: number, colIdx: number) => {
    if (!data) return;
    const edit = pending.edits.find(e => e.rowIdx === rowIdx && e.colIdx === colIdx);
    const rawVal = data.rows[rowIdx][colIdx];
    const value = edit ? edit.newValue : (rawVal === null ? null : String(rawVal));
    const columnName = data.columns[colIdx] ?? '';
    setCellEditor({ rowIdx, colIdx, value, columnName });
  }, [data, pending.edits]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(totalRows / pageSize)), [totalRows, pageSize]);

  // 页码下拉选项，上限 500 防止大表渲染卡顿
  const pageOptions = useMemo(() =>
    Array.from({ length: Math.min(totalPages, 500) }, (_, i) => ({
      value: String(i + 1),
      label: String(i + 1),
    })),
  [totalPages]);

  const PAGE_SIZE_OPTIONS = useMemo(() =>
    [100, 500, 1000, 2000, 3000, 5000]
      .filter(s => s <= tablePageSizeLimit)
      .map(s => ({ value: String(s), label: String(s) })),
  [tablePageSizeLimit]);

  const handlePageSizeChange = (v: string) => {
    setPage(1);
    setPageSize(Number(v));
  };

  const rowBgClass = useCallback((rowIdx: number) => {
    if (pending.deletedRowIdxs.includes(rowIdx)) return 'bg-red-900/20';
    if (pending.edits.some(e => e.rowIdx === rowIdx)) return 'bg-yellow-900/20';
    return '';
  }, [pending.edits, pending.deletedRowIdxs]);

  // ─── 稳定化 renderRow，确保滚动期间不重建行内容 ─────────────────────────────
  const renderRow = useCallback((ri: number) => {
    if (!data) return null;
    // 克隆行（绿色）
    if (ri >= data.rows.length) {
      const cloneIdx = ri - data.rows.length;
      const row = pending.clonedRows[cloneIdx];
      if (!row) return null;
      return (
        <>
          <td style={{ flex: '0 0 40px', minWidth: '40px' }} className="px-2 py-1.5 border-r border-b border-[#1e2d42] text-green-400 text-center text-xs select-none">
            <Tooltip content={t('tableDataView.deleteRowMenuItem')} className="contents">
              <button
                onClick={() => removeClonedRow(cloneIdx)}
                className="text-red-400 hover:text-red-300 leading-none"
              >×</button>
            </Tooltip>
          </td>
          {row.map((cell, ji) => (
            <td key={ji} style={{ flex: '1 0 150px' }} className="px-3 py-1.5 text-green-400 border-r border-b border-[#1e2d42] truncate">
              {cell === null ? <span className="text-[#7a9bb8]">NULL</span> : String(cell)}
            </td>
          ))}
        </>
      );
    }
    // 普通数据行
    const row = data.rows[ri];
    return (
      <>
        <td
          style={{ flex: '0 0 40px', minWidth: '40px' }}
          className={`px-2 py-1.5 border-r border-b border-[#1e2d42] text-[#7a9bb8] text-center text-xs cursor-default select-none ${rowBgClass(ri)}`}
          onContextMenu={e => handleContextMenu(e, ri, -1, 'row')}
        >
          {(page - 1) * pageSize + ri + 1}
        </td>
        {row.map((cell, ci) => (
          <EditableCell
            key={ci}
            value={cell}
            pendingValue={getPendingValue(ri, ci)}
            isDeleted={isRowDeleted(ri)}
            onCommit={newVal => editCell(ri, ci, newVal)}
            onContextMenu={e => handleContextMenu(e, ri, ci, 'cell')}
            onOpenEditor={() => openCellEditor(ri, ci)}
            style={{ flex: '1 0 150px' }}
          />
        ))}
      </>
    );
  }, [data, page, pageSize, pending, rowBgClass, getPendingValue, isRowDeleted, editCell, removeClonedRow, handleContextMenu, openCellEditor, t]);

  // ─── 稳定化 thead，仅排序状态/列变化时重建 ────────────────────────────────
  const colSortButtons = useCallback((col: string) => (
    <div className="flex items-center justify-between gap-1 w-full">
      <span className="truncate">{col}</span>
      <Tooltip content={
        sortCol === col && sortDir === 'ASC' ? t('tableDataView.sortDesc')
        : sortCol === col && sortDir === 'DESC' ? t('tableDataView.sortAsc')
        : t('tableDataView.sortAsc')
      }>
        <button
          className={`flex-shrink-0 leading-none transition-colors ${
            sortCol === col ? 'text-[#00c9a7]' : 'text-[#3a5a7a] hover:text-[#7a9bb8]'
          }`}
          onClick={() => {
            if (sortCol !== col) { setSortCol(col); setSortDir('ASC'); }
            else if (sortDir === 'ASC') { setSortDir('DESC'); }
            else { setSortCol(null); setSortDir(null); }
          }}
        >
          {sortCol === col && sortDir === 'ASC' ? <ChevronUp size={11}/> :
           sortCol === col && sortDir === 'DESC' ? <ChevronDown size={11}/> :
           <ChevronsUpDown size={11}/>}
        </button>
      </Tooltip>
    </div>
  ), [sortCol, sortDir, setSortCol, setSortDir, t]);

  // flex 布局版（VirtualTable 使用）
  const thead = useMemo(() => data ? (
    <tr style={{ display: 'flex', borderBottom: '1px solid #1e2d42' }}>
      <th style={{ flex: '0 0 40px', minWidth: '40px' }} className="px-2 py-1.5 border-r border-[#1e2d42] text-[#7a9bb8] font-normal">
        {t('tableDataView.serialNo')}
      </th>
      {data.columns.map(col => (
        <th key={col} style={{ flex: '1 0 150px' }} className="px-3 py-1.5 border-r border-[#1e2d42] text-[#c8daea] font-normal group/th overflow-hidden">
          {colSortButtons(col)}
        </th>
      ))}
    </tr>
  ) : null, [data?.columns, colSortButtons, t]);

  // 标准表格布局版（NormalTable 使用，列宽由浏览器自动计算）
  const normalThead = useMemo(() => data ? (
    <tr>
      <th className="w-10 px-2 py-1.5 border-b border-r border-[#1e2d42] text-[#7a9bb8] font-normal text-center">
        {t('tableDataView.serialNo')}
      </th>
      {data.columns.map(col => (
        <th key={col} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal group/th">
          {colSortButtons(col)}
        </th>
      ))}
    </tr>
  ) : null, [data?.columns, colSortButtons, t]);

  const hasData = !!(data && (data.rows.length > 0 || pending.clonedRows.length > 0));

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
          <DropdownSelect
            value={String(page)}
            options={pageOptions}
            onChange={v => setPage(Number(v))}
            plain
          />
          <span className="text-[#7a9bb8]">/ {totalPages}</span>
          <Tooltip content={t('tableDataView.nextPage')}>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30"
            ><ChevronRight size={14}/></button>
          </Tooltip>
          <Tooltip content={t('tableDataView.lastPage')}>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(totalPages)}
              className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30"
            >&gt;|</button>
          </Tooltip>
          <DropdownSelect
            value={String(pageSize)}
            options={PAGE_SIZE_OPTIONS}
            onChange={handlePageSizeChange}
            plain
          />
          <span className="text-[#7a9bb8]">{t('tableDataView.rowsPerPage')}</span>
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

      {/* Table — 滚动/虚拟化由 TableScrollContainer 独立管理，不触发整组件重渲染 */}
      <TableScrollContainer
        rowCount={virtualRowCount}
        isLoading={isLoading}
        hasData={hasData}
        columns={data?.columns ?? []}
        thead={thead}
        normalThead={normalThead}
        renderRow={renderRow}
        useVirtual={pageSize === 5000}
      />

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
