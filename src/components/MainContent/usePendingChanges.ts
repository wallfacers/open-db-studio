import { useState, useCallback } from 'react';

export type RowData = (string | number | boolean | null)[];

export interface CellEdit {
  rowIdx: number;
  colIdx: number;
  newValue: string | null;
}

// 删除记录：存储 pkValue 而非 rowIdx（rowIdx 在数据刷新后不稳定）
export interface DeleteRecord {
  pkValue: string;
  rowIdx: number; // 仅用于 UI 高亮显示，提交时不依赖此值
}

export interface PendingState {
  edits: CellEdit[];
  clonedRows: RowData[];
  deletedRecords: DeleteRecord[];
}

const EMPTY: PendingState = { edits: [], clonedRows: [], deletedRecords: [] };

export function usePendingChanges() {
  const [pending, setPending] = useState<PendingState>(EMPTY);

  const editCell = useCallback((rowIdx: number, colIdx: number, newValue: string | null) => {
    setPending(prev => {
      const edits = prev.edits.filter(e => !(e.rowIdx === rowIdx && e.colIdx === colIdx));
      return { ...prev, edits: [...edits, { rowIdx, colIdx, newValue }] };
    });
  }, []);

  const cloneRow = useCallback((rowData: RowData) => {
    setPending(prev => ({ ...prev, clonedRows: [...prev.clonedRows, [...rowData]] }));
  }, []);

  const addEmptyRow = useCallback((columnCount: number) => {
    const emptyRow: RowData = new Array(columnCount).fill(null);
    setPending(prev => ({ ...prev, clonedRows: [...prev.clonedRows, emptyRow] }));
  }, []);

  // 标记删除时同时记录 pkValue（稳定标识）
  const markDelete = useCallback((rowIdx: number, pkValue: string) => {
    setPending(prev => {
      if (prev.deletedRecords.some(r => r.pkValue === pkValue)) return prev;
      return { ...prev, deletedRecords: [...prev.deletedRecords, { pkValue, rowIdx }] };
    });
  }, []);

  const unmarkDelete = useCallback((pkValue: string) => {
    setPending(prev => ({
      ...prev,
      deletedRecords: prev.deletedRecords.filter(r => r.pkValue !== pkValue),
    }));
  }, []);

  const removeClonedRow = useCallback((cloneIdx: number) => {
    setPending(prev => ({
      ...prev,
      clonedRows: prev.clonedRows.filter((_, i) => i !== cloneIdx),
    }));
  }, []);

  const discard = useCallback(() => setPending({ edits: [], clonedRows: [], deletedRecords: [] }), []);

  const totalCount =
    pending.edits.length + pending.clonedRows.length + pending.deletedRecords.length;

  const hasPending = totalCount > 0;

  // 辅助函数：根据当前 data 查找某 pkValue 对应的 rowIdx（用于 UI 高亮）
  const findRowIdxByPkValue = useCallback((pkValue: string, rows: RowData[], columns: string[], pkColumn: string) => {
    const pkColIdx = columns.indexOf(pkColumn);
    if (pkColIdx < 0) return -1;
    for (let i = 0; i < rows.length; i++) {
      const rowPk = String(rows[i][pkColIdx] ?? '');
      if (rowPk === pkValue) return i;
    }
    return -1;
  }, []);

  return { pending, editCell, cloneRow, addEmptyRow, removeClonedRow, markDelete, unmarkDelete, discard, hasPending, totalCount, findRowIdxByPkValue };
}
