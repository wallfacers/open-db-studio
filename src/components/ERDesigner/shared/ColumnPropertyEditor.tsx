import React, { useState, useRef, useEffect } from 'react';
import { Key, Zap, X, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import type { ErColumn } from '@/types';
import { DropdownSelect } from '@/components/common/DropdownSelect';
import { Tooltip } from '@/components/common/Tooltip';
import TypeLengthDisplay from './TypeLengthDisplay';
import CompatibilityWarning from './CompatibilityWarning';
import { findTypeDef, type DialectName } from './dataTypes';

function DebouncedInput({ value, onChange, placeholder, className, onKeyDown }: any) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);

  return (
    <input
      className={className}
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onChange(local); }}
      onKeyDown={onKeyDown}
    />
  );
}

function DebouncedTextarea({ value, onChange, placeholder, className }: any) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);

  return (
    <textarea
      className={className}
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onChange(local); }}
    />
  );
}

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
  const nameRef = useRef<HTMLInputElement>(null);
  const defaultRef = useRef<HTMLInputElement>(null);

  const vis = visibleColumns ?? { defaultValue: true, comment: true, unique: true };

  useEffect(() => {
    if (isEditingName && nameRef.current) nameRef.current.focus();
  }, [isEditingName]);

  useEffect(() => {
    if (isEditingDefault && defaultRef.current) defaultRef.current.focus();
  }, [isEditingDefault]);

  useEffect(() => { setEditName(column.name); }, [column.name]);
  useEffect(() => { setEditDefault(column.default_value ?? ''); }, [column.default_value]);

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
    <div className="flex items-center gap-1.5 px-2 h-[32px] py-1 hover:bg-background-hover transition-colors group text-[13px] text-foreground" style={onOpenDrawer ? { paddingLeft: '60px' } : undefined}>
      {/* PK / AI icons container */}
      <div className="flex items-center shrink-0" style={{ width: 36 }}>
        <Tooltip content={column.is_primary_key ? 'Primary Key' : 'Set as PK'}>
          <button
            type="button"
            className={`shrink-0 w-[16px] h-[16px] flex items-center justify-center rounded-sm cursor-pointer outline-none transition-colors duration-200 ${column.is_primary_key ? 'text-key-primary' : 'text-foreground-ghost hover:text-foreground-muted'}`}
            onClick={() => onUpdate(column.id, { is_primary_key: !column.is_primary_key })}
          >
            <Key size={12} />
          </button>
        </Tooltip>

        <Tooltip content={column.is_auto_increment ? 'Auto Increment' : 'Set Auto Increment'}>
          <button
            type="button"
            className={`shrink-0 w-[16px] h-[16px] flex items-center justify-center rounded-sm cursor-pointer outline-none transition-colors duration-200 ${
              !column.is_primary_key ? 'invisible' : column.is_auto_increment ? 'text-accent' : 'text-foreground-ghost hover:text-foreground-muted'
            }`}
            onClick={() => onUpdate(column.id, { is_auto_increment: !column.is_auto_increment })}
            tabIndex={column.is_primary_key ? 0 : -1}
          >
            <Zap size={12} />
          </button>
        </Tooltip>
      </div>

      {/* Field name */}
      <div className="w-[88px] shrink-0 min-w-0 flex items-center">
        {isEditingName ? (
          <input
            ref={nameRef}
            className="bg-background-elevated text-foreground text-[13px] px-1 py-px leading-[20px] rounded outline-none border border-accent w-full"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleNameSave}
            onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
          />
        ) : (
          <Tooltip content={column.name} className="w-full">
            <span
              className="truncate cursor-text hover:bg-border-strong px-1 py-px leading-[20px] rounded text-[13px] block w-full border border-transparent transition-colors duration-200"
              onDoubleClick={() => setIsEditingName(true)}
            >
              {column.name}
            </span>
          </Tooltip>
        )}
      </div>

      {/* Type + length */}
      <div className="flex-1 min-w-0 flex items-center gap-1">
        <TypeLengthDisplay
          column={column}
          dialect={dialect}
          mode="edit"
          onChange={(u) => onUpdate(column.id, u)}
          onEditEnumValues={() => onOpenDrawer?.(tableId, column.id)}
        />
        <CompatibilityWarning typeName={column.data_type} dialect={dialect} />
      </div>

      {/* NN checkbox */}
      <div className="w-[28px] shrink-0 flex justify-center ml-1.5">
        <label className="flex items-center gap-0.5 shrink-0 cursor-pointer text-[11px] text-foreground-muted" title="NOT NULL">
          <input
            type="checkbox"
            className="accent-accent w-3 h-3 cursor-pointer"
            checked={!column.nullable}
            onChange={() => onUpdate(column.id, { nullable: !column.nullable })}
          />
        </label>
      </div>

      {/* UQ checkbox */}
      {vis.unique && (
        <div className="w-[28px] shrink-0 flex justify-center">
          <label className="flex items-center gap-0.5 shrink-0 cursor-pointer text-[11px] text-foreground-muted" title="UNIQUE">
            <input
              type="checkbox"
              className="accent-accent w-3 h-3 cursor-pointer"
              checked={column.is_unique}
              onChange={() => onUpdate(column.id, { is_unique: !column.is_unique })}
            />
          </label>
        </div>
      )}

      {/* Default value */}
      {vis.defaultValue && (
        <div className="w-[80px] shrink-0 flex items-center">
          {isEditingDefault ? (
            <input
              ref={defaultRef}
              className="bg-background-elevated text-foreground text-[12px] px-1 py-px leading-[20px] rounded outline-none border border-accent w-full"
              value={editDefault}
              onChange={(e) => setEditDefault(e.target.value)}
              onBlur={handleDefaultSave}
              onKeyDown={(e) => e.key === 'Enter' && handleDefaultSave()}
              placeholder="默认值"
            />
          ) : (
            <Tooltip content={column.default_value ?? '默认值'} className="w-full">
              <span
                className="truncate w-full text-[12px] text-foreground-muted cursor-text hover:bg-border-strong px-1 py-px leading-[20px] rounded block border border-transparent transition-colors duration-200"
                onDoubleClick={() => setIsEditingDefault(true)}
              >
                {column.default_value || '-'}
              </span>
            </Tooltip>
          )}
        </div>
      )}

      {/* Comment icon */}
      {vis.comment && (
        <div className="w-[60px] shrink-0 flex items-center justify-center">
          <Tooltip content={column.comment || '添加注释'}>
            <button
              type="button"
              className={`shrink-0 p-0.5 rounded-sm cursor-pointer outline-none transition-colors duration-200 ${column.comment ? 'text-accent' : 'text-foreground-ghost hover:text-foreground-muted'}`}
              onClick={() => onOpenDrawer?.(tableId, column.id)}
            >
              <MessageSquare size={13} />
            </button>
          </Tooltip>
        </div>
      )}

      {/* Delete button */}
      {onDelete && (
        <div className="w-[20px] shrink-0 flex justify-center">
          <button
            type="button"
            className="shrink-0 p-0.5 rounded-sm cursor-pointer outline-none text-foreground-subtle hover:text-error transition-colors"
            onClick={() => onDelete(column.id, tableId)}
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Full Mode ──────────────────────────────────────────────────────────────

const CHARSET_OPTIONS = [
  { value: 'utf8', label: 'utf8' },
  { value: 'utf8mb4', label: 'utf8mb4' },
  { value: 'latin1', label: 'latin1' },
  { value: 'ascii', label: 'ascii' },
];

const COLLATION_OPTIONS = [
  { value: 'utf8mb4_general_ci', label: 'utf8mb4_general_ci' },
  { value: 'utf8mb4_unicode_ci', label: 'utf8mb4_unicode_ci' },
  { value: 'utf8_general_ci', label: 'utf8_general_ci' },
  { value: 'latin1_swedish_ci', label: 'latin1_swedish_ci' },
];

function FullForm({ column, tableId, dialect, onUpdate }: ColumnPropertyEditorProps) {
  const [collapsed, setCollapsed] = useState(false);
  const typeDef = findTypeDef(column.data_type, dialect);

  const inputClass = 'w-full bg-background-elevated border border-border-strong rounded text-foreground text-[13px] px-2 py-1 outline-none focus:border-accent';
  const labelClass = 'text-[11px] text-foreground-muted mb-0.5';

  if (collapsed) {
    return (
      <div className="border border-border-strong rounded px-3 py-1.5 flex items-center justify-between">
        <span className="text-[13px] text-foreground">{column.name}</span>
        <button
          type="button"
          className="text-foreground-muted hover:text-foreground cursor-pointer outline-none transition-colors duration-200"
          onClick={() => setCollapsed(false)}
        >
          <ChevronDown size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="border border-border-strong rounded p-3 space-y-2">
      {/* Header with collapse */}
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-foreground font-medium">{column.name}</span>
        <button
          type="button"
          className="text-foreground-muted hover:text-foreground cursor-pointer outline-none transition-colors duration-200"
          onClick={() => setCollapsed(true)}
        >
          <ChevronUp size={14} />
        </button>
      </div>

      {/* Field name */}
      <div>
        <div className={labelClass}>字段名</div>
        <DebouncedInput
          className={inputClass}
          value={column.name}
          onChange={(val: string) => onUpdate(column.id, { name: val })}
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
        <label className="flex items-center gap-1 text-[12px] text-foreground cursor-pointer">
          <input
            type="checkbox"
            className="accent-accent w-3.5 h-3.5 cursor-pointer"
            checked={!column.nullable}
            onChange={() => onUpdate(column.id, { nullable: !column.nullable })}
          />
          NOT NULL
        </label>
        <label className="flex items-center gap-1 text-[12px] text-foreground cursor-pointer">
          <input
            type="checkbox"
            className="accent-accent w-3.5 h-3.5 cursor-pointer"
            checked={column.is_unique}
            onChange={() => onUpdate(column.id, { is_unique: !column.is_unique })}
          />
          UNIQUE
        </label>
        {typeDef?.hasUnsigned && (
          <label className="flex items-center gap-1 text-[12px] text-foreground cursor-pointer">
            <input
              type="checkbox"
              className="accent-accent w-3.5 h-3.5 cursor-pointer"
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
        <DebouncedInput
          className={inputClass}
          value={column.default_value ?? ''}
          onChange={(val: string) => onUpdate(column.id, { default_value: val || null })}
          placeholder="NULL"
        />
      </div>

      {/* ENUM values editor */}
      {typeDef?.hasEnumValues && (
        <div>
          <div className={labelClass}>ENUM / SET 值 (每行一个)</div>
          <DebouncedTextarea
            className={`${inputClass} min-h-[60px] resize-y`}
            value={(column.enum_values ?? []).join('\n')}
            onChange={(val: string) => {
              const vals = val.split('\n').filter(v => v.trim() !== '');
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
        <DebouncedInput
          className={inputClass}
          value={column.on_update ?? ''}
          onChange={(val: string) => onUpdate(column.id, { on_update: val || null })}
          placeholder="例如 CURRENT_TIMESTAMP"
        />
      </div>

      {/* Comment */}
      <div>
        <div className={labelClass}>注释</div>
        <DebouncedTextarea
          className={`${inputClass} min-h-[40px] resize-y`}
          value={column.comment ?? ''}
          onChange={(val: string) => onUpdate(column.id, { comment: val || null })}
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
