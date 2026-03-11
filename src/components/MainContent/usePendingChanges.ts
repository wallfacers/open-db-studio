import { useState, useCallback } from 'react';

export type RowData = (string | number | boolean | null)[];

export interface CellEdit {
  rowIdx: number;
  colIdx: number;
  newValue: string | null;
}

export interface PendingState {
  edits: CellEdit[];
  clonedRows: RowData[];
  deletedRowIdxs: number[];
}

const EMPTY: PendingState = { edits: [], clonedRows: [], deletedRowIdxs: [] };

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

  const markDelete = useCallback((rowIdx: number) => {
    setPending(prev => {
      if (prev.deletedRowIdxs.includes(rowIdx)) return prev;
      return { ...prev, deletedRowIdxs: [...prev.deletedRowIdxs, rowIdx] };
    });
  }, []);

  const unmarkDelete = useCallback((rowIdx: number) => {
    setPending(prev => ({
      ...prev,
      deletedRowIdxs: prev.deletedRowIdxs.filter(i => i !== rowIdx),
    }));
  }, []);

  const removeClonedRow = useCallback((cloneIdx: number) => {
    setPending(prev => ({
      ...prev,
      clonedRows: prev.clonedRows.filter((_, i) => i !== cloneIdx),
    }));
  }, []);

  const discard = useCallback(() => setPending({ edits: [], clonedRows: [], deletedRowIdxs: [] }), []);

  const totalCount =
    pending.edits.length + pending.clonedRows.length + pending.deletedRowIdxs.length;

  const hasPending = totalCount > 0;

  return { pending, editCell, cloneRow, addEmptyRow, removeClonedRow, markDelete, unmarkDelete, discard, hasPending, totalCount };
}
