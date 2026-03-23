import React from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';

interface VirtualTableProps {
  columns: string[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  renderRow: (rowIndex: number) => React.ReactNode;
  thead: React.ReactNode;
}

export const VirtualTable: React.FC<VirtualTableProps> = ({
  columns,
  rowVirtualizer,
  renderRow,
  thead,
}) => {
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <table
      style={{ tableLayout: 'fixed', width: '100%', borderCollapse: 'collapse' }}
      className="text-left whitespace-nowrap text-xs"
    >
      <colgroup>
        <col style={{ width: '40px' }} />
        {columns.map((col) => (
          <col key={col} style={{ width: '150px' }} />
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
            className="border-b border-[#1e2d42]"
          >
            {renderRow(vRow.index)}
          </tr>
        ))}
      </tbody>
    </table>
  );
};
