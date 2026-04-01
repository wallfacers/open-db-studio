// src/components/ImportExport/TableSelector.tsx
import React, { useState, useMemo, useRef, useEffect } from 'react';
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
  const headerCheckboxRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => tables.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())),
    [tables, search]
  );

  const selectedInFiltered = filtered.filter((t) => selected.includes(t.name)).length;
  const allSelected = filtered.length > 0 && selectedInFiltered === filtered.length;
  const someSelected = selectedInFiltered > 0 && !allSelected;

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const toggleTable = (name: string) => {
    onChange(
      selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]
    );
  };

  const toggleAll = () => {
    if (allSelected) {
      onChange(selected.filter((n) => !filtered.some((t) => t.name === n)));
    } else {
      const newNames = filtered.map((t) => t.name);
      onChange([...selected.filter((n) => !newNames.includes(n)), ...newNames]);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* 搜索栏 */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 flex items-center gap-1.5 bg-[var(--background-hover)] border border-[var(--border-strong)] rounded px-3 py-1.5">
          <Search size={13} className="text-gray-400 flex-shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tableSelector.searchPlaceholder')}
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-600 outline-none"
          />
        </div>
      </div>

      {/* 表格 */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
          <thead className="sticky top-0 bg-[var(--background-base)] z-10">
            <tr>
              <th className="w-8 px-2 py-1.5 border-b border-r border-[var(--border-default)] text-[var(--foreground-muted)] font-normal">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="accent-[#009e84] cursor-pointer"
                  title={allSelected ? t('tableSelector.deselectAll') : t('tableSelector.selectAll')}
                />
              </th>
              <th className="px-3 py-1.5 border-b border-r border-[var(--border-default)] text-[var(--foreground-default)] font-normal">{t('tableSelector.colName')}</th>
              <th className="w-28 px-3 py-1.5 border-b border-r border-[var(--border-default)] text-[var(--foreground-default)] font-normal text-right">{t('tableSelector.colRows')}</th>
              <th className="w-24 px-3 py-1.5 border-b border-[var(--border-default)] text-[var(--foreground-default)] font-normal text-right">{t('tableSelector.colSize')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr
                key={t.name}
                onClick={() => toggleTable(t.name)}
                className={`border-b border-[var(--border-default)] cursor-pointer hover:bg-[var(--background-hover)] ${selected.includes(t.name) ? 'bg-[#0f1e30]' : ''}`}
              >
                <td className="px-2 py-1.5 border-r border-[var(--border-default)]">
                  <input
                    type="checkbox"
                    checked={selected.includes(t.name)}
                    onChange={() => toggleTable(t.name)}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-[#009e84]"
                  />
                </td>
                <td className="px-3 py-1.5 border-r border-[var(--border-default)] text-white max-w-[200px] truncate">{t.name}</td>
                <td className="px-3 py-1.5 border-r border-[var(--border-default)] text-[var(--foreground-muted)] text-right">
                  {t.rowCount ? t.rowCount.toLocaleString() : '-'}
                </td>
                <td className="px-3 py-1.5 text-[var(--foreground-muted)] text-right">{t.size ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-sm text-gray-400 mt-2 pt-2 border-t border-[var(--border-strong)]">
        {t('tableSelector.selectedCount', { selected: selected.length, total: tables.length })}
      </div>
    </div>
  );
};
