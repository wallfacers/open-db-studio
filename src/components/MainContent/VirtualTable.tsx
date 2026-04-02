import React from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';

interface VirtualTableProps {
  columns: string[];
  colWidths: number[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  renderRow: (rowIndex: number) => React.ReactNode;
  thead: React.ReactNode;
}

const ROW_NUM_WIDTH = 40;

export const VirtualTable: React.FC<VirtualTableProps> = ({
  columns,
  colWidths,
  rowVirtualizer,
  renderRow,
  thead,
}) => {
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const totalWidth = ROW_NUM_WIDTH + (colWidths.length > 0
    ? colWidths.reduce((s, w) => s + w, 0)
    : columns.length * 150);

  return (
    <table
      style={{ width: '100%', minWidth: `${totalWidth}px` }}
      className="text-left whitespace-nowrap text-xs"
    >
      <thead className="sticky top-0 bg-background-base z-10" style={{ display: 'block' }}>
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
              overflow: 'hidden',
            }}
            className="hover:bg-background-hover transition-colors duration-150"
          >
            {renderRow(vRow.index)}
          </tr>
        ))}
      </tbody>
    </table>
  );
};
