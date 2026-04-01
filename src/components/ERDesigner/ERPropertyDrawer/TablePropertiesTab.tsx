import { useState, useEffect } from 'react';
import { useErDesignerStore } from '@/store/erDesignerStore';

const PRESET_COLORS = ['var(--accent)', '#5eb2f7', '#f59e0b', '#f43f5e', '#a855f7', '#4ade80'];

interface TablePropertiesTabProps {
  tableId: number;
}

export default function TablePropertiesTab({ tableId }: TablePropertiesTabProps) {
  const { tables, updateTable } = useErDesignerStore();
  const table = tables.find(t => t.id === tableId);

  const [name, setName] = useState(table?.name ?? '');
  const [comment, setComment] = useState(table?.comment ?? '');

  useEffect(() => {
    if (table) {
      setName(table.name);
      setComment(table.comment ?? '');
    }
  }, [table?.id, table?.name, table?.comment]);

  if (!table) return null;

  const saveName = () => {
    if (name.trim() && name !== table.name) updateTable(table.id, { name: name.trim() });
  };
  const saveComment = () => {
    updateTable(table.id, { comment: comment || null });
  };

  return (
    <div className="p-3 space-y-4">
      <div>
        <label className="text-[11px] text-[var(--foreground-subtle)] block mb-1">表名</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={saveName}
          className="w-full bg-[var(--background-elevated)] border border-[var(--border-strong)] rounded px-2 py-1 text-[13px] text-[var(--foreground)] focus:border-[var(--accent)] outline-none"
        />
      </div>
      <div>
        <label className="text-[11px] text-[var(--foreground-subtle)] block mb-1">注释</label>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          onBlur={saveComment}
          rows={3}
          className="w-full bg-[var(--background-elevated)] border border-[var(--border-strong)] rounded px-2 py-1 text-[13px] text-[var(--foreground)] focus:border-[var(--accent)] outline-none resize-none"
        />
      </div>
      <div>
        <label className="text-[11px] text-[var(--foreground-subtle)] block mb-1">颜色</label>
        <div className="flex gap-2 items-center">
          {PRESET_COLORS.map(c => (
            <button
              key={c}
              onClick={() => updateTable(table.id, { color: c })}
              className={`w-5 h-5 rounded-full border-2 transition-all ${
                table.color === c ? 'border-white scale-110' : 'border-transparent hover:scale-110'
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
          <button
            onClick={() => updateTable(table.id, { color: null })}
            className={`px-2 py-0.5 text-[11px] rounded ${
              !table.color ? 'text-[var(--accent)] bg-[var(--accent-subtle)]' : 'text-[var(--foreground-subtle)] hover:text-[var(--foreground-muted)]'
            }`}
          >
            无
          </button>
        </div>
      </div>
    </div>
  );
}
