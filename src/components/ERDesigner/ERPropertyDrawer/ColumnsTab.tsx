import { useState, useEffect } from 'react';
import { Plus, ChevronRight, ChevronDown } from 'lucide-react';
import { useErDesignerStore } from '@/store/erDesignerStore';
import ColumnPropertyEditor from '../shared/ColumnPropertyEditor';
import type { DialectName } from '../shared/dataTypes';

interface ColumnsTabProps {
  tableId: number;
}

export default function ColumnsTab({ tableId }: ColumnsTabProps) {
  const { columns, addColumn, updateColumn, deleteColumn, drawerFocusColumnId, boundDialect } = useErDesignerStore();
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (drawerFocusColumnId != null) {
      setExpandedIds(prev => new Set(prev).add(drawerFocusColumnId));
      requestAnimationFrame(() => {
        const el = document.getElementById(`drawer-col-${drawerFocusColumnId}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      useErDesignerStore.setState({ drawerFocusColumnId: null });
    }
  }, [drawerFocusColumnId]);

  const cols = columns[tableId] ?? [];
  const toggleExpand = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div className="p-2">
      {cols.map(col => (
        <div key={col.id} id={`drawer-col-${col.id}`}>
          <div className="flex items-center">
            <button onClick={() => toggleExpand(col.id)} className="p-0.5 text-[var(--foreground-subtle)] hover:text-[var(--foreground-muted)]">
              {expandedIds.has(col.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            <div className="flex-1 min-w-0">
              <ColumnPropertyEditor
                column={col}
                tableId={tableId}
                dialect={boundDialect as DialectName | null}
                mode="compact"
                onUpdate={updateColumn}
                onDelete={deleteColumn}
                visibleColumns={{ defaultValue: false, comment: false, unique: false }}
              />
            </div>
          </div>
          {expandedIds.has(col.id) && (
            <div className="ml-4 mb-2 p-2 bg-[var(--background-base)] rounded border border-[var(--border-default)]">
              <ColumnPropertyEditor
                column={col}
                tableId={tableId}
                dialect={boundDialect as DialectName | null}
                mode="full"
                onUpdate={updateColumn}
              />
            </div>
          )}
        </div>
      ))}
      <button
        onClick={() => addColumn(tableId, {
          name: `column_${cols.length + 1}`,
          data_type: 'VARCHAR',
          nullable: true,
          default_value: null,
          is_primary_key: false,
          is_auto_increment: false,
          comment: null,
          length: null,
          scale: null,
          is_unique: false,
          unsigned: false,
          charset: null,
          collation: null,
          on_update: null,
          enum_values: null,
          sort_order: cols.length,
        })}
        className="mt-2 w-full py-1 text-[12px] text-[var(--foreground-subtle)] hover:text-[var(--accent)] hover:bg-[var(--background-hover)] rounded transition-colors flex items-center justify-center gap-1"
      >
        <Plus size={12} /> 添加列
      </button>
    </div>
  );
}
