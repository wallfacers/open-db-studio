import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import type { ErIndex, ErColumn } from '@/types';
import { DropdownSelect } from '@/components/common/DropdownSelect';
import { Tooltip } from '@/components/common/Tooltip';

interface IndexEditorProps {
  indexes: ErIndex[];
  columns: ErColumn[];
  tableId: number;
  tableName: string;
  onAdd: (tableId: number, index: Partial<ErIndex>) => void;
  onUpdate: (id: number, updates: Partial<ErIndex>) => void;
  onDelete: (id: number, tableId: number) => void;
}

interface IndexColumnEntry {
  name: string;
  order: 'ASC' | 'DESC';
}

const INDEX_TYPE_OPTIONS = [
  { value: 'INDEX', label: 'INDEX' },
  { value: 'UNIQUE', label: 'UNIQUE' },
  { value: 'FULLTEXT', label: 'FULLTEXT' },
];

const TYPE_BADGE_COLORS: Record<string, string> = {
  INDEX: 'bg-[#1e3a5f] text-[#5eadf7]',
  UNIQUE: 'bg-[#2a3319] text-[#a3e635]',
  FULLTEXT: 'bg-[#3a2a19] text-[#f59e0b]',
};

function parseIndexColumns(json: string): IndexColumnEntry[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.map(item => {
        if (typeof item === 'string') return { name: item, order: 'ASC' as const };
        return { name: item.name ?? item, order: item.order ?? 'ASC' };
      });
    }
  } catch { /* ignore */ }
  return [];
}

function stringifyIndexColumns(entries: IndexColumnEntry[]): string {
  return JSON.stringify(entries.map(e => ({ name: e.name, order: e.order })));
}

function IndexRow({
  index, columns, tableId, onUpdate, onDelete,
}: {
  index: ErIndex;
  columns: ErColumn[];
  tableId: number;
  onUpdate: (id: number, updates: Partial<ErIndex>) => void;
  onDelete: (id: number, tableId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const indexColumns = parseIndexColumns(index.columns);
  const colNames = indexColumns.map(c => c.name).join(', ');
  const badgeClass = TYPE_BADGE_COLORS[index.type] ?? TYPE_BADGE_COLORS['INDEX'];

  const toggleColumn = (colName: string) => {
    const existing = indexColumns.find(c => c.name === colName);
    let updated: IndexColumnEntry[];
    if (existing) {
      updated = indexColumns.filter(c => c.name !== colName);
    } else {
      updated = [...indexColumns, { name: colName, order: 'ASC' }];
    }
    onUpdate(index.id, { columns: stringifyIndexColumns(updated) });
  };

  const toggleOrder = (colName: string) => {
    const updated = indexColumns.map(c =>
      c.name === colName ? { ...c, order: (c.order === 'ASC' ? 'DESC' : 'ASC') as 'ASC' | 'DESC' } : c
    );
    onUpdate(index.id, { columns: stringifyIndexColumns(updated) });
  };

  return (
    <div className="border border-[var(--border-strong)] rounded overflow-hidden">
      {/* Collapsed row */}
      <div
        className="flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--background-hover)] cursor-pointer transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronUp size={12} className="text-[var(--foreground-muted)] shrink-0" /> : <ChevronDown size={12} className="text-[var(--foreground-muted)] shrink-0" />}
        <span className="text-[13px] text-[var(--foreground)] truncate flex-1">{index.name}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${badgeClass} shrink-0`}>{index.type}</span>
        <Tooltip content={colNames} className="flex-shrink-0 max-w-[120px]">
          <span className="text-[11px] text-[var(--foreground-muted)] truncate">
            {colNames || '-'}
          </span>
        </Tooltip>
        <Tooltip content="删除索引">
          <button
            type="button"
            className="shrink-0 p-0.5 rounded-sm cursor-pointer outline-none text-[var(--foreground-ghost)] hover:text-[var(--error)] transition-colors"
            onClick={(e) => { e.stopPropagation(); onDelete(index.id, tableId); }}
          >
            <Trash2 size={12} />
          </button>
        </Tooltip>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 py-2 border-t border-[var(--border-strong)] space-y-2 bg-[var(--background-base)]/50">
          {/* Name */}
          <div>
            <div className="text-[11px] text-[var(--foreground-muted)] mb-0.5">索引名</div>
            <input
              className="w-full bg-[var(--background-elevated)] border border-[var(--border-strong)] rounded text-[var(--foreground)] text-[13px] px-2 py-1 outline-none focus:border-[var(--accent)]"
              value={index.name}
              onChange={(e) => onUpdate(index.id, { name: e.target.value })}
            />
          </div>

          {/* Type */}
          <div>
            <div className="text-[11px] text-[var(--foreground-muted)] mb-0.5">类型</div>
            <DropdownSelect
              value={index.type}
              options={INDEX_TYPE_OPTIONS}
              onChange={(v) => onUpdate(index.id, { type: v })}
            />
          </div>

          {/* Column checkboxes with ASC/DESC */}
          <div>
            <div className="text-[11px] text-[var(--foreground-muted)] mb-1">列</div>
            <div className="space-y-1">
              {columns.map(col => {
                const entry = indexColumns.find(c => c.name === col.name);
                const isChecked = !!entry;
                return (
                  <div key={col.id} className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 cursor-pointer flex-1 min-w-0">
                      <input
                        type="checkbox"
                        className="accent-[var(--accent)] w-3.5 h-3.5 cursor-pointer"
                        checked={isChecked}
                        onChange={() => toggleColumn(col.name)}
                      />
                      <span className="text-[12px] text-[var(--foreground)] truncate">{col.name}</span>
                    </label>
                    {isChecked && (
                      <button
                        type="button"
                        className="text-[10px] text-[var(--foreground-muted)] hover:text-[var(--accent)] cursor-pointer outline-none px-1 py-0.5 rounded hover:bg-[var(--border-default)] transition-colors"
                        onClick={() => toggleOrder(col.name)}
                      >
                        {entry!.order}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function IndexEditor({
  indexes, columns, tableId, tableName, onAdd, onUpdate, onDelete,
}: IndexEditorProps) {
  const handleAddIndex = () => {
    const firstCol = columns[0]?.name ?? 'col';
    const name = `idx_${tableName}_${firstCol}`;
    onAdd(tableId, {
      table_id: tableId,
      name,
      type: 'INDEX',
      columns: stringifyIndexColumns([{ name: firstCol, order: 'ASC' }]),
    });
  };

  return (
    <div className="space-y-2">
      {indexes.map(idx => (
        <IndexRow
          key={idx.id}
          index={idx}
          columns={columns}
          tableId={tableId}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}

      <button
        type="button"
        className="w-full flex items-center justify-center gap-1 py-1.5 text-[12px] text-[var(--accent)] hover:bg-[var(--background-hover)] rounded border border-dashed border-[var(--border-strong)] hover:border-[var(--accent)] transition-colors cursor-pointer outline-none"
        onClick={handleAddIndex}
      >
        <Plus size={12} />
        添加索引
      </button>
    </div>
  );
}
