import React, { useState, useRef, useEffect } from 'react';

interface EditableCellProps {
  value: string | number | boolean | null;
  pendingValue?: string | null;  // undefined = 未修改
  isDeleted?: boolean;
  isCloned?: boolean;
  onCommit: (newValue: string | null) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export const EditableCell: React.FC<EditableCellProps> = ({
  value,
  pendingValue,
  isDeleted,
  isCloned,
  onCommit,
  onContextMenu,
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
    onCommit(draft === '' && displayValue === null ? null : draft);
  };

  const cancel = () => setEditing(false);

  const cellClass = [
    'px-3 py-1.5 text-[#c8daea] border-r border-[#1e2d42] max-w-[300px] truncate relative',
    isDeleted ? 'line-through text-red-400/60' : '',
    isCloned ? 'text-green-400' : '',
    isModified && !isDeleted ? 'bg-yellow-900/20' : '',
  ].filter(Boolean).join(' ');

  if (editing) {
    return (
      <td className={cellClass} onContextMenu={onContextMenu}>
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={confirm}
          onKeyDown={e => {
            if (e.key === 'Enter') confirm();
            if (e.key === 'Escape') cancel();
          }}
          className="w-[calc(100%-4px)] h-[calc(100%-4px)] bg-[#1a2639] text-[#c8daea] border border-[#3a7bd5] rounded px-1 outline-none text-xs"
        />
      </td>
    );
  }

  return (
    <td className={cellClass} onDoubleClick={startEdit} onContextMenu={onContextMenu}>
      {displayValue === null
        ? <span className="text-[#7a9bb8] italic">NULL</span>
        : String(displayValue)}
    </td>
  );
};
