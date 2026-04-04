import { useState, useEffect } from 'react';
import { useErDesignerStore } from '@/store/erDesignerStore';
import { CONSTRAINT_METHOD_LABELS } from '../shared/constraintConstants';
import { resolveConstraintMethod } from '../shared/resolveConstraint';

const PRESET_COLORS = ['var(--accent)', 'var(--info)', 'var(--warning)', 'var(--error)', 'var(--node-alias)', 'var(--success)'];

interface TablePropertiesTabProps {
  tableId: number;
}

export default function TablePropertiesTab({ tableId }: TablePropertiesTabProps) {
  const { tables, updateTable, projects, activeProjectId } = useErDesignerStore();
  const table = tables.find(t => t.id === tableId);
  const project = projects.find(p => p.id === activeProjectId);
  const effectiveMethod = resolveConstraintMethod(null, table, project);

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
        <label className="text-[11px] text-foreground-subtle block mb-1">表名</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={saveName}
          className="w-full bg-background-elevated border border-border-strong rounded px-2 py-1 text-[13px] text-foreground focus:border-accent outline-none"
        />
      </div>
      <div>
        <label className="text-[11px] text-foreground-subtle block mb-1">注释</label>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          onBlur={saveComment}
          rows={3}
          className="w-full bg-background-elevated border border-border-strong rounded px-2 py-1 text-[13px] text-foreground focus:border-accent outline-none resize-none"
        />
      </div>
      <div>
        <label className="text-[11px] text-foreground-subtle block mb-1">颜色</label>
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
            className={`px-2 py-0.5 text-[11px] rounded transition-colors duration-200 ${
              !table.color ? 'text-accent bg-accent-subtle' : 'text-foreground-subtle hover:text-foreground-muted'
            }`}
          >
            无
          </button>
        </div>
      </div>
      {/* 约束方式摘要 */}
      <div className="mt-3 pt-3 border-t border-border-strong">
        <div className="text-[11px] text-foreground-muted mb-1">默认约束方式</div>
        <div className="flex items-center gap-2">
          <span className="text-[12px]">
            {CONSTRAINT_METHOD_LABELS[effectiveMethod] ?? effectiveMethod}
          </span>
          {table.constraint_method
            ? <span className="text-[10px] text-warning">已覆盖</span>
            : <span className="text-[10px] text-foreground-muted">继承项目默认</span>
          }
        </div>
        <div className="text-[10px] text-foreground-muted mt-0.5">
          在"关系"标签页可按表或按关系单独配置
        </div>
      </div>
    </div>
  );
}
