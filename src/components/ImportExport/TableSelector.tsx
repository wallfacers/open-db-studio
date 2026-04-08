// src/components/ImportExport/TableSelector.tsx
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
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

const PAGE_SIZE = 100;

export const TableSelector: React.FC<Props> = ({ tables, selected, onChange }) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const headerCheckboxRef = useRef<HTMLInputElement>(null);

  // 切换数据源时重置
  useEffect(() => {
    setSearch('');
    setPage(1);
  }, [tables]);

  const filtered = useMemo(
    () => tables.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())),
    [tables, search]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  // 确保 page 不超出范围
  const safePage = Math.min(page, totalPages);

  const paginated = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );

  // 全选/半选基于当前页
  const selectedOnPage = paginated.filter((t) => selected.includes(t.name)).length;
  const allSelected = paginated.length > 0 && selectedOnPage === paginated.length;
  const someSelected = selectedOnPage > 0 && !allSelected;

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    setPage(1); // 搜索时重置到第一页
  };

  const toggleTable = (name: string) => {
    onChange(
      selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]
    );
  };

  // 全选/取消全选当前页
  const toggleAll = () => {
    if (allSelected) {
      onChange(selected.filter((n) => !paginated.some((t) => t.name === n)));
    } else {
      const newNames = paginated.map((t) => t.name);
      onChange([...selected.filter((n) => !newNames.includes(n)), ...newNames]);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* 搜索栏 */}
      <div className="flex items-center gap-2 mb-2 flex-shrink-0">
        <div className="flex-1 flex items-center gap-1.5 bg-background-hover border border-border-strong rounded px-3 py-1.5">
          <Search size={13} className="text-foreground-muted flex-shrink-0" />
          <input
            value={search}
            onChange={handleSearchChange}
            placeholder={t('tableSelector.searchPlaceholder')}
            className="flex-1 bg-transparent text-sm text-foreground placeholder-foreground-ghost outline-none"
          />
          {search && (
            <button
              onClick={() => { setSearch(''); setPage(1); }}
              className="text-foreground-muted hover:text-foreground transition-colors text-xs leading-none"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 表格 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
          <thead className="sticky top-0 bg-background-base z-10">
            <tr>
              <th className="w-8 px-2 py-1.5 border-b border-r border-border-default text-foreground-muted font-normal">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="accent-accent cursor-pointer"
                  title={allSelected ? t('tableSelector.deselectAll') : t('tableSelector.selectAll')}
                />
              </th>
              <th className="px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal">{t('tableSelector.colName')}</th>
              <th className="w-28 px-3 py-1.5 border-b border-r border-border-default text-foreground-default font-normal text-right">{t('tableSelector.colRows')}</th>
              <th className="w-24 px-3 py-1.5 border-b border-border-default text-foreground-default font-normal text-right">{t('tableSelector.colSize')}</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map((t) => (
              <tr
                key={t.name}
                onClick={() => toggleTable(t.name)}
                className={`border-b border-border-default cursor-pointer hover:bg-background-hover transition-colors duration-150 ${selected.includes(t.name) ? 'bg-background-active' : ''}`}
              >
                <td className="px-2 py-1.5 border-r border-border-default">
                  <input
                    type="checkbox"
                    checked={selected.includes(t.name)}
                    onChange={() => toggleTable(t.name)}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-accent"
                  />
                </td>
                <td className="px-3 py-1.5 border-r border-border-default text-foreground max-w-[200px] truncate">{t.name}</td>
                <td className="px-3 py-1.5 border-r border-border-default text-foreground-muted text-right">
                  {t.rowCount ? t.rowCount.toLocaleString() : '-'}
                </td>
                <td className="px-3 py-1.5 text-foreground-muted text-right">{t.size ?? '-'}</td>
              </tr>
            ))}
            {paginated.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-foreground-muted text-xs">
                  {t('tableSelector.noResults', { defaultValue: '无匹配结果' })}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 底部：统计 + 分页 */}
      <div className="flex items-center justify-between text-xs text-foreground-muted pt-2 mt-1 border-t border-border-strong flex-shrink-0">
        <span>
          {t('tableSelector.selectedCount', { selected: selected.length, total: tables.length })}
          {search && filtered.length !== tables.length && (
            <span className="ml-1 text-foreground-subtle">
              ({t('tableSelector.filteredCount', { count: filtered.length, defaultValue: `匹配 ${filtered.length}` })})
            </span>
          )}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button
              disabled={safePage === 1}
              onClick={() => setPage(safePage - 1)}
              className="p-0.5 rounded disabled:opacity-30 hover:bg-background-hover transition-colors"
            >
              <ChevronLeft size={13} />
            </button>
            <span className="px-1">
              {t('tableSelector.pageInfo', { page: safePage, total: totalPages, defaultValue: `${safePage} / ${totalPages}` })}
            </span>
            <button
              disabled={safePage === totalPages}
              onClick={() => setPage(safePage + 1)}
              className="p-0.5 rounded disabled:opacity-30 hover:bg-background-hover transition-colors"
            >
              <ChevronRight size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
