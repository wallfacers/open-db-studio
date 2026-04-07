import { useState, useEffect } from 'react';
import { Plus, ChevronRight, ChevronDown } from 'lucide-react';
import { useErDesignerStore } from '@/store/erDesignerStore';
import { useToastStore } from '@/store/toastStore';
import { createDefaultColumn } from '../shared/defaultColumn';
import ColumnPropertyEditor from '../shared/ColumnPropertyEditor';
import type { DialectName } from '../shared/dataTypes';

interface ColumnsTabProps {
  tableId: number;
}

export default function ColumnsTab({ tableId }: ColumnsTabProps) {
  const { columns, addColumn, updateColumn, deleteColumn, drawerFocusColumnId, boundDialect } = useErDesignerStore();
  const showError = useToastStore(s => s.showError);
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
            <button onClick={() => toggleExpand(col.id)} className="p-0.5 text-foreground-subtle hover:text-foreground-muted transition-colors duration-200">
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
                onOpenDrawer={() => {
                  if (!expandedIds.has(col.id)) toggleExpand(col.id);
                }}
                visibleColumns={{ defaultValue: false, comment: false, unique: false }}
              />
            </div>
          </div>
          {expandedIds.has(col.id) && (
            <div className="ml-4 mb-2 p-2 bg-background-base rounded border border-border-default">
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
        onClick={async () => {
          try {
            await addColumn(tableId, createDefaultColumn(cols.length));
          } catch (e) {
            console.error('Failed to add column:', e);
            showError(`添加列失败: ${e}`);
          }
        }}
        className="mt-2 w-full py-1 text-[12px] text-foreground-subtle hover:text-accent hover:bg-background-hover rounded transition-colors flex items-center justify-center gap-1"
      >
        <Plus size={12} /> 添加列
      </button>
    </div>
  );
}
