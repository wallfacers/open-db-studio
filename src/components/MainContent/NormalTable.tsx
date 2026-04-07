import React from 'react';

interface NormalTableProps {
  columns: string[];
  rowCount: number;
  renderRow: (rowIndex: number) => React.ReactNode;
  thead: React.ReactNode;
}

export const NormalTable: React.FC<NormalTableProps> = ({
  columns,
  rowCount,
  renderRow,
  thead,
}) => (
  <table
    style={{ width: 'max-content', minWidth: '100%' }}
    className="text-left border-collapse whitespace-nowrap text-xs"
  >
    <thead className="sticky top-0 bg-background-base z-10">
      {thead}
    </thead>
    <tbody>
      {Array.from({ length: rowCount }, (_, i) => (
        <tr key={i} className="hover:bg-background-hover transition-colors duration-150">
          {renderRow(i)}
        </tr>
      ))}
    </tbody>
  </table>
);
