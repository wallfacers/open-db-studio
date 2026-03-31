import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Key, Zap, MoreVertical, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import type { ErColumn } from '@/types';
import { DropdownSelect } from '@/components/common/DropdownSelect';
import TypeLengthDisplay from './TypeLengthDisplay';
import CompatibilityWarning from './CompatibilityWarning';
import { findTypeDef, type DialectName } from './dataTypes';

interface ColumnPropertyEditorProps {
  column: ErColumn;
  tableId: number;
  dialect: DialectName | null;
  mode: 'compact' | 'full';
  onUpdate: (id: number, updates: Partial<ErColumn>) => void;
  onDelete?: (id: number, tableId: number) => void;
  onOpenDrawer?: (tableId: number, columnId: number) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  visibleColumns?: { defaultValue: boolean; comment: boolean; unique: boolean };
}

// ─── Compact Mode ───────────────────────────────────────────────────────────

function CompactRow({
  column, tableId, dialect, onUpdate, onDelete, onOpenDrawer, onMoveUp, onMoveDown, visibleColumns,
}: ColumnPropertyEditorProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(column.name);
  const [isEditingDefault, setIsEditingDefault] = useState(false);
  const [editDefault, setEditDefault] = useState(column.default_value ?? '');
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  const nameRef = useRef<HTMLInputElement>(null);
  const defaultRef = useRef<HTMLInputElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const vis = visibleColumns ?? { defaultValue: true, comment: true, unique: true };

  useEffect(() => {
    if (isEditingName && nameRef.current) nameRef.current.focus();
  }, [isEditingName]);

  useEffect(() => {
    if (isEditingDefault && defaultRef.current) defaultRef.current.focus();
  }, [isEditingDefault]);

  useEffect(() => { setEditName(column.name); }, [column.name]);
  useEffect(() => { setEditDefault(column.default_value ?? ''); }, [column.default_value]);

  useLayoutEffect(() => {
    if (showMenu && menuTriggerRef.current) {
      const rect = menuTriggerRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.left - 100 });
    }
  }, [showMenu]);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || menuTriggerRef.current?.contains(target)) return;
      setShowMenu(false);
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler, true), 10);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler, true); };
  }, [showMenu]);

  const handleNameSave = () => {
    setIsEditingName(false);
    if (editName.trim() && editName !== column.name) {
      onUpdate(column.id, { name: editName.trim() });
    } else {
      setEditName(column.name);
    }
  };

  const handleDefaultSave = () => {
    setIsEditingDefault(false);
    const val = editDefault.trim() || null;
    if (val !== column.default_value) {
      onUpdate(column.id, { default_value: val });
    }
  };

  return (
    <div className="flex items-center gap-1 px-2 h-[24px] hover:bg-[#1a2639] transition-colors group text-[13px] text-[#b5cfe8]">
      {/* PK icon */}
      <button
        type="button"
        className={`shrink-0 p-0.5 rounded-sm cursor-pointer outline-none ${column.is_primary_key ? 'text-[#f59e0b]' : 'text-gray-600 hover:text-gray-400'}`}
        onClick={() => onUpdate(column.id, { is_primary_key: !column.is_primary_key })}
        title={column.is_primary_key ? 'Primary Key' : 'Set as PK'}
      >
        <Key size={12} />
      </button>

      {/* AI icon */}
      {column.is_primary_key && (
        <button
          type="button"
          className={`shrink-0 p-0.5 rounded-sm cursor-pointer outline-none ${column.is_auto_increment ? 'text-[#00c9a7]' : 'text-gray-600 hover:text-gray-400'}`}
          onClick={() => onUpdate(column.id, { is_auto_increment: !column.is_auto_increment })}
          title={column.is_auto_increment ? 'Auto Increment' : 'Set Auto Increment'}
        >
          <Zap size={12} />
        </button>
      )}

      {/* Field name */}
      {isEditingName ? (
        <input
          ref={nameRef}
          className="bg-[#151d28] text-[#b5cfe8] text-[13px] px-1 rounded outline-none border border-[#00c9a7] w-[80px] h-[18px] leading-[16px]"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleNameSave}
          onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
        />
      ) : (
        <span
          className="truncate w-[80px] cursor-text hover:bg-[#253347] px-1 py-0.5 -mx-0.5 rounded text-[13px]"
          onDoubleClick={() => setIsEditingName(true)}
          title={column.name}
        >
          {column.name}
        </span>
      )}

      {/* Type + length */}
      <div className="shrink-0">
        <TypeLengthDisplay column={column} dialect={dialect} mode="edit" onChange={(u) => onUpdate(column.id, u)} />
      </div>

      {/* Compatibility warning */}
      <CompatibilityWarning typeName={column.data_type} dialect={dialect} />

      {/* NN checkbox */}
      <label className="flex items-center gap-0.5 shrink-0 cursor-pointer text-[11px] text-[#7a9bb8]" title="NOT NULL">
        <input
          type="checkbox"
          className="accent-[#00c9a7] w-3 h-3 cursor-pointer"
          checked={!column.nullable}
          onChange={() => onUpdate(column.id, { nullable: !column.nullable })}
        />
        <span>NN</span>
      </label>

      {/* UQ checkbox */}
      {vis.unique && (
        <label className="flex items-center gap-0.5 shrink-0 cursor-pointer text-[11px] text-[#7a9bb8]" title="UNIQUE">
          <input
            type="checkbox"
            className="accent-[#00c9a7] w-3 h-3 cursor-pointer"
            checked={column.is_unique}
            onChange={() => onUpdate(column.id, { is_unique: !column.is_unique })}
          />
          <span>UQ</span>
        </label>
      )}

      {/* Default value */}
      {vis.defaultValue && (
        isEditingDefault ? (
          <input
            ref={defaultRef}
            className="bg-[#151d28] text-[#b5cfe8] text-[12px] px-1 rounded outline-none border border-[#00c9a7] w-[60px] h-[18px] leading-[16px]"
            value={editDefault}
            onChange={(e) => setEditDefault(e.target.value)}
            onBlur={handleDefaultSave}
            onKeyDown={(e) => e.key === 'Enter' && handleDefaultSave()}
            placeholder="默认值"
          />
        ) : (
          <span
            className="truncate w-[60px] text-[12px] text-[#7a9bb8] cursor-text hover:bg-[#253347] px-1 py-0.5 rounded"
            onDoubleClick={() => setIsEditingDefault(true)}
            title={column.default_value ?? '默认值'}
          >
            {column.default_value || '-'}
          </span>
        )
      )}

      {/* Comment icon */}
      {vis.comment && (
        <button
          type="button"
          className={`shrink-0 p-0.5 rounded-sm cursor-pointer outline-none ${column.comment ? 'text-[#00c9a7]' : 'text-gray-600 hover:text-gray-400'}`}
          title={column.comment || '添加注释'}
          onClick={() => onOpenDrawer?.(tableId, column.id)}
        >
          <MessageSquare size={11} />
        </button>
      )}

      {/* More menu */}
      <button
        ref={menuTriggerRef}
        type="button"
        className="shrink-0 p-0.5 rounded-sm cursor-pointer outline-none text-gray-600 hover:text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => setShowMenu(!showMenu)}
      >
        <MoreVertical size={12} />
      </button>

      {showMenu && createPortal(
        <div
          ref={menuRef}
          className="fixed bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg z-[200] py-1 min-w-[120px]"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          {onDelete && (
            <div
              className="px-3 py-1.5 text-xs cursor-pointer text-[#c8daea] hover:bg-[#1e2d42] hover:text-red-400"
              onClick={() => { onDelete(column.id, tableId); setShowMenu(false); }}
            >
              删除
            </div>
          )}
          {onMoveUp && (
            <div
              className="px-3 py-1.5 text-xs cursor-pointer text-[#c8daea] hover:bg-[#1e2d42] hover:text-[#00c9a7]"
              onClick={() => { onMoveUp(); setShowMenu(false); }}
            >
              上移
            </div>
          )}
          {onMoveDown && (
            <div
              className="px-3 py-1.5 text-xs cursor-pointer text-[#c8daea] hover:bg-[#1e2d42] hover:text-[#00c9a7]"
              onClick={() => { onMoveDown(); setShowMenu(false); }}
            >
              下移
            </div>
          )}
          {onOpenDrawer && (
            <div
              className="px-3 py-1.5 text-xs cursor-pointer text-[#c8daea] hover:bg-[#1e2d42] hover:text-[#00c9a7]"
              onClick={() => { onOpenDrawer(tableId, column.id); setShowMenu(false); }}
            >
              在抽屉中编辑
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Full Mode ──────────────────────────────────────────────────────────────

const CHARSET_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'utf8', label: 'utf8' },
  { value: 'utf8mb4', label: 'utf8mb4' },
  { value: 'latin1', label: 'latin1' },
  { value: 'ascii', label: 'ascii' },
];

const COLLATION_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'utf8mb4_general_ci', label: 'utf8mb4_general_ci' },
  { value: 'utf8mb4_unicode_ci', label: 'utf8mb4_unicode_ci' },
  { value: 'utf8_general_ci', label: 'utf8_general_ci' },
  { value: 'latin1_swedish_ci', label: 'latin1_swedish_ci' },
];

function FullForm({ column, tableId, dialect, onUpdate }: ColumnPropertyEditorProps) {
  const [collapsed, setCollapsed] = useState(false);
  const typeDef = findTypeDef(column.data_type, dialect);

  const inputClass = 'w-full bg-[#151d28] border border-[#2a3f5a] rounded text-[#b5cfe8] text-[13px] px-2 py-1 outline-none focus:border-[#00c9a7]';
  const labelClass = 'text-[11px] text-[#7a9bb8] mb-0.5';

  if (collapsed) {
    return (
      <div className="border border-[#2a3f5a] rounded px-3 py-1.5 flex items-center justify-between">
        <span className="text-[13px] text-[#b5cfe8]">{column.name}</span>
        <button
          type="button"
          className="text-[#7a9bb8] hover:text-[#b5cfe8] cursor-pointer outline-none"
          onClick={() => setCollapsed(false)}
        >
          <ChevronDown size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="border border-[#2a3f5a] rounded p-3 space-y-2">
      {/* Header with collapse */}
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-[#b5cfe8] font-medium">{column.name}</span>
        <button
          type="button"
          className="text-[#7a9bb8] hover:text-[#b5cfe8] cursor-pointer outline-none"
          onClick={() => setCollapsed(true)}
        >
          <ChevronUp size={14} />
        </button>
      </div>

      {/* Field name */}
      <div>
        <div className={labelClass}>字段名</div>
        <input
          className={inputClass}
          value={column.name}
          onChange={(e) => onUpdate(column.id, { name: e.target.value })}
        />
      </div>

      {/* Type + length */}
      <div>
        <div className={labelClass}>类型</div>
        <TypeLengthDisplay column={column} dialect={dialect} mode="edit" onChange={(u) => onUpdate(column.id, u)} />
        <CompatibilityWarning typeName={column.data_type} dialect={dialect} />
      </div>

      {/* Checkboxes row */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1 text-[12px] text-[#b5cfe8] cursor-pointer">
          <input
            type="checkbox"
            className="accent-[#00c9a7] w-3.5 h-3.5 cursor-pointer"
            checked={!column.nullable}
            onChange={() => onUpdate(column.id, { nullable: !column.nullable })}
          />
          NOT NULL
        </label>
        <label className="flex items-center gap-1 text-[12px] text-[#b5cfe8] cursor-pointer">
          <input
            type="checkbox"
            className="accent-[#00c9a7] w-3.5 h-3.5 cursor-pointer"
            checked={column.is_unique}
            onChange={() => onUpdate(column.id, { is_unique: !column.is_unique })}
          />
          UNIQUE
        </label>
        {typeDef?.hasUnsigned && (
          <label className="flex items-center gap-1 text-[12px] text-[#b5cfe8] cursor-pointer">
            <input
              type="checkbox"
              className="accent-[#00c9a7] w-3.5 h-3.5 cursor-pointer"
              checked={column.unsigned}
              onChange={() => onUpdate(column.id, { unsigned: !column.unsigned })}
            />
            UNSIGNED
          </label>
        )}
      </div>

      {/* Default value */}
      <div>
        <div className={labelClass}>默认值</div>
        <input
          className={inputClass}
          value={column.default_value ?? ''}
          onChange={(e) => onUpdate(column.id, { default_value: e.target.value || null })}
          placeholder="NULL"
        />
      </div>

      {/* ENUM values editor */}
      {typeDef?.hasEnumValues && (
        <div>
          <div className={labelClass}>ENUM / SET 值 (每行一个)</div>
          <textarea
            className={`${inputClass} min-h-[60px] resize-y`}
            value={(column.enum_values ?? []).join('\n')}
            onChange={(e) => {
              const vals = e.target.value.split('\n').filter(v => v.trim() !== '');
              onUpdate(column.id, { enum_values: vals.length > 0 ? vals : null });
            }}
            placeholder="value1&#10;value2&#10;value3"
          />
        </div>
      )}

      {/* Charset & Collation */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className={labelClass}>字符集</div>
          <DropdownSelect
            value={column.charset ?? ''}
            options={CHARSET_OPTIONS}
            onChange={(v) => onUpdate(column.id, { charset: v || null })}
            placeholder="默认"
          />
        </div>
        <div>
          <div className={labelClass}>排序规则</div>
          <DropdownSelect
            value={column.collation ?? ''}
            options={COLLATION_OPTIONS}
            onChange={(v) => onUpdate(column.id, { collation: v || null })}
            placeholder="默认"
          />
        </div>
      </div>

      {/* ON UPDATE */}
      <div>
        <div className={labelClass}>ON UPDATE</div>
        <input
          className={inputClass}
          value={column.on_update ?? ''}
          onChange={(e) => onUpdate(column.id, { on_update: e.target.value || null })}
          placeholder="例如 CURRENT_TIMESTAMP"
        />
      </div>

      {/* Comment */}
      <div>
        <div className={labelClass}>注释</div>
        <textarea
          className={`${inputClass} min-h-[40px] resize-y`}
          value={column.comment ?? ''}
          onChange={(e) => onUpdate(column.id, { comment: e.target.value || null })}
          placeholder="字段注释..."
        />
      </div>
    </div>
  );
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export default function ColumnPropertyEditor(props: ColumnPropertyEditorProps) {
  if (props.mode === 'compact') {
    return <CompactRow {...props} />;
  }
  return <FullForm {...props} />;
}
