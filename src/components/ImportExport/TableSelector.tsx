// src/components/ImportExport/TableSelector.tsx
import React, { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
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
        <div className="flex-1 flex items-center gap-1.5 bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5">
          <Search size={13} className="text-gray-400 flex-shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tableSelector.searchPlaceholder')}
          className="flex-1 bg-transparent text-sm text-white placeholder-gray-600 outline-none"
          />
        </div>
        <button
          onClick={selectAll}
          className="px-3 py-1.5 text-sm text-white bg-[#1a2639] hover:bg-[#253347] border border-[#253347] rounded transition-colors"
        >
          {t('tableSelector.selectAll')}
        </button>
        <button
          onClick={invertSelection}
          className="px-3 py-1.5 text-sm text-white bg-[#1a2639] hover:bg-[#253347] border border-[#253347] rounded transition-colors"
        >
          {t('tableSelector.invertSelection')}
        </button>
      </div>

      {/* 表头 */}
      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 px-2 py-1.5 text-xs text-gray-400 border-b border-[#253347]">
        <div className="w-4" />
        <div>{t('tableSelector.colName')}</div>
        <div className="text-right">{t('tableSelector.colRows')}</div>
        <div className="text-right">{t('tableSelector.colSize')}</div>
      </div>

      {/* 表列表 */}
      <div className="flex-1 overflow-y-auto">
        {filtered.map((t) => (
          <label
            key={t.name}
            className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 items-center px-2 py-2 text-sm cursor-pointer hover:bg-[#1a2639]"
          >
            <input
              type="checkbox"
              checked={selected.includes(t.name)}
              onChange={() => toggleTable(t.name)}
              className="accent-[#009e84]"
            />
            <span className="text-white truncate">{t.name}</span>
            <span className="text-gray-400 text-right">
              {t.rowCount !== undefined ? t.rowCount.toLocaleString() : '-'}
            </span>
            <span className="text-gray-400 text-right">{t.size ?? '-'}</span>
          </label>
        ))}
      </div>

      <div className="text-sm text-gray-400 mt-2 pt-2 border-t border-[#253347]">
        {t('tableSelector.selectedCount', { selected: selected.length, total: tables.length })}
      </div>
    </div>
  );
};
