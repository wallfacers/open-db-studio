// src/components/ImportExport/TableSelector.tsx
import React, { useState, useMemo } from 'react';
import { Search } from 'lucide-react';

export interface TableInfo {
  name: string;
  rowCount?: number;
  size?: string;
}

interface Props {
  tables: TableInfo[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

export const TableSelector: React.FC<Props> = ({ tables, selected, onChange }) => {
  const [search, setSearch] = useState('');

  const filtered = useMemo(
    () => tables.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())),
    [tables, search]
  );

  const toggleTable = (name: string) => {
    onChange(
      selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]
    );
  };

  const selectAll = () => onChange(filtered.map((t) => t.name));
  const invertSelection = () =>
    onChange(filtered.filter((t) => !selected.includes(t.name)).map((t) => t.name));

  return (
    <div className="flex flex-col h-full">
      {/* 搜索栏 + 全选按钮 */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 flex items-center gap-1.5 bg-[#1a2639] border border-[#253347] rounded px-2 py-1">
          <Search size={12} className="text-[#7a9bb8]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索表名..."
            className="flex-1 bg-transparent text-xs text-[#c8daea] placeholder-[#4a6a8a] outline-none"
          />
        </div>
        <button
          onClick={selectAll}
          className="px-2 py-1 text-xs text-[#7a9bb8] hover:text-[#3794ff] border border-[#253347] rounded transition-colors"
        >
          全选
        </button>
        <button
          onClick={invertSelection}
          className="px-2 py-1 text-xs text-[#7a9bb8] hover:text-[#3794ff] border border-[#253347] rounded transition-colors"
        >
          反选
        </button>
      </div>

      {/* 表头 */}
      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 px-2 py-1 text-[10px] text-[#4a6a8a] border-b border-[#1e2d42]">
        <div className="w-4" />
        <div>表名</div>
        <div className="text-right">行数(估算)</div>
        <div className="text-right">大小</div>
      </div>

      {/* 表列表 */}
      <div className="flex-1 overflow-y-auto">
        {filtered.map((t) => (
          <label
            key={t.name}
            className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 items-center px-2 py-1.5 text-xs cursor-pointer hover:bg-[#1a2639]/50"
          >
            <input
              type="checkbox"
              checked={selected.includes(t.name)}
              onChange={() => toggleTable(t.name)}
              className="accent-[#3794ff]"
            />
            <span className="text-[#c8daea] truncate">{t.name}</span>
            <span className="text-[#7a9bb8] text-right">
              {t.rowCount !== undefined ? t.rowCount.toLocaleString() : '-'}
            </span>
            <span className="text-[#7a9bb8] text-right">{t.size ?? '-'}</span>
          </label>
        ))}
      </div>

      <div className="text-xs text-[#7a9bb8] mt-2 pt-2 border-t border-[#1e2d42]">
        已选: {selected.length} / {tables.length} 个表
      </div>
    </div>
  );
};
