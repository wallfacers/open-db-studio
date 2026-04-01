import React, { useState, useRef, useEffect } from 'react';
import { Maximize2 } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';

interface EditableCellProps {
  value: string | number | boolean | null;
  pendingValue?: string | null;  // undefined = 未修改
  isDeleted?: boolean;
  isCloned?: boolean;
  onCommit: (newValue: string | null) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onOpenEditor?: () => void;
  style?: React.CSSProperties;
}

export const EditableCell: React.FC<EditableCellProps> = ({
  value,
  pendingValue,
  isDeleted,
  isCloned,
  onCommit,
  onContextMenu,
  onOpenEditor,
  style,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const displayValue = pendingValue !== undefined ? pendingValue : value;
  const isModified = pendingValue !== undefined;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = () => {
    if (isDeleted) return;
    setDraft(displayValue === null ? '' : String(displayValue));
    setEditing(true);
  };

  const confirm = () => {
    setEditing(false);
    const newValue = draft === '' && displayValue === null ? null : draft;
    const oldValue = displayValue === null ? null : String(displayValue);
    if (newValue === oldValue) return;
    onCommit(newValue);
  };

  const cancel = () => setEditing(false);

  const baseCellClass = [
    'px-3 py-1.5 text-left text-[var(--foreground-default)] border-r border-b border-[var(--border-default)] relative overflow-hidden',
    isDeleted ? 'line-through text-[var(--error)]/60' : '',
    isCloned ? 'text-[var(--success)]' : '',
    isModified && !isDeleted ? 'bg-[var(--warning-subtle)]' : '',
  ].filter(Boolean).join(' ');

  if (editing) {
    return (
      <td className="border-r border-b border-[var(--border-default)] p-0 relative overflow-hidden" style={{ outline: '1px solid var(--border-focus)', outlineOffset: '-1px', ...style }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={confirm}
          onKeyDown={e => {
            if (e.key === 'Enter') confirm();
            if (e.key === 'Escape') cancel();
          }}
          className="w-full h-full px-3 py-1.5 bg-[var(--background-hover)] text-[var(--foreground-default)] outline-none text-xs"
          style={{ minWidth: '120px', display: 'block' }}
        />
      </td>
    );
  }

  return (
    <td
      className={`${baseCellClass} group`}
      onDoubleClick={startEdit}
      onContextMenu={onContextMenu}
      style={style}
    >
      <Tooltip
        content={displayValue === null ? undefined : String(displayValue)}
        className="block w-full min-w-0"
      >
        <div className="truncate">
          {displayValue === null
            ? <span className="text-[var(--foreground-muted)]">NULL</span>
            : String(displayValue)}
        </div>
      </Tooltip>
      {onOpenEditor && !isDeleted && (
        <button
          className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-0.5 hover:bg-[var(--background-hover)] rounded text-[var(--foreground-muted)] hover:text-[var(--border-focus)] transition-opacity"
          onClick={e => { e.stopPropagation(); onOpenEditor(); }}
          onMouseDown={e => e.preventDefault()}
        >
          <Maximize2 size={10} />
        </button>
      )}
    </td>
  );
};
