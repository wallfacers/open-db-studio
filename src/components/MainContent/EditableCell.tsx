import React, { useState, useRef, useEffect } from 'react';
import { Maximize2 } from 'lucide-react';

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
    'px-3 py-1.5 text-left text-[#c8daea] border-r border-[#1e2d42] relative',
    isDeleted ? 'line-through text-red-400/60' : '',
    isCloned ? 'text-green-400' : '',
    isModified && !isDeleted ? 'bg-yellow-900/20' : '',
  ].filter(Boolean).join(' ');

  if (editing) {
    return (
      <td className="border-r border-[#1e2d42] p-0 relative" style={{ outline: '1px solid #3a7bd5', outlineOffset: '-1px', ...style }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={confirm}
          onKeyDown={e => {
            if (e.key === 'Enter') confirm();
            if (e.key === 'Escape') cancel();
          }}
          className="w-full h-full px-3 py-1.5 bg-[#1a2639] text-[#c8daea] outline-none text-xs"
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
      <div
        className="max-w-[300px] truncate"
        title={displayValue === null ? undefined : String(displayValue)}
      >
        {displayValue === null
          ? <span className="text-[#7a9bb8]">NULL</span>
          : String(displayValue)}
      </div>
      {onOpenEditor && !isDeleted && (
        <button
          className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-0.5 hover:bg-[#243a55] rounded text-[#7a9bb8] hover:text-[#3a7bd5] transition-opacity"
          onClick={e => { e.stopPropagation(); onOpenEditor(); }}
          onMouseDown={e => e.preventDefault()}
        >
          <Maximize2 size={10} />
        </button>
      )}
    </td>
  );
};
