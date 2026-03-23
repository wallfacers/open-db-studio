import React from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';

interface VirtualTableProps {
  columns: string[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  renderRow: (rowIndex: number) => React.ReactNode;
  thead: React.ReactNode;
}

const ROW_NUM_WIDTH = 40;
const COL_WIDTH = 150;

export const VirtualTable: React.FC<VirtualTableProps> = ({
  columns,
  rowVirtualizer,
  renderRow,
  thead,
}) => {
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const totalWidth = ROW_NUM_WIDTH + columns.length * COL_WIDTH;

  return (
    <table
      style={{ tableLayout: 'fixed', width: `${totalWidth}px`, minWidth: `${totalWidth}px` }}
      className="text-left whitespace-nowrap text-xs"
    >
      <colgroup>
        <col style={{ width: `${ROW_NUM_WIDTH}px` }} />
        {columns.map((col) => (
          <col key={col} style={{ width: `${COL_WIDTH}px` }} />
        ))}
      </colgroup>

      <thead className="sticky top-0 bg-[#0d1117] z-10">
        {thead}
      </thead>

      <tbody
        style={{
          display: 'block',
          position: 'relative',
          height: `${totalSize}px`,
        }}
      >
        {virtualRows.map((vRow) => (
          <tr
            key={vRow.key}
            style={{
              display: 'flex',
              position: 'absolute',
              top: 0,
              transform: `translateY(${vRow.start}px)`,
              width: '100%',
            }}
            className="hover:bg-[#1a2639]"
          >
            {renderRow(vRow.index)}
          </tr>
        ))}
      </tbody>
    </table>
  );
};
