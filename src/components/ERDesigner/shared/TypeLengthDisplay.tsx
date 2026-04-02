import React, { useMemo } from 'react';
import type { ErColumn } from '@/types';
import { DropdownSelect } from '@/components/common/DropdownSelect';
import { getTypeOptions, findTypeDef, formatTypeDisplay, type DialectName } from './dataTypes';

interface TypeLengthDisplayProps {
  column: ErColumn;
  dialect: DialectName | null;
  mode: 'display' | 'edit';
  onChange: (updates: Partial<ErColumn>) => void;
}

export default function TypeLengthDisplay({ column, dialect, mode, onChange }: TypeLengthDisplayProps) {
  const typeOptions = useMemo(() => {
    return getTypeOptions(dialect).map(t => ({ value: t.value, label: t.label }));
  }, [dialect]);

  if (mode === 'display') {
    return (
      <span className="text-[13px] text-foreground-muted truncate">
        {formatTypeDisplay(column)}
      </span>
    );
  }

  const typeDef = findTypeDef(column.data_type, dialect);

  const handleTypeChange = (value: string) => {
    const newDef = findTypeDef(value, dialect);
    const updates: Partial<ErColumn> = { data_type: value };
    if (newDef) {
      updates.length = newDef.defaultLength;
      updates.scale = newDef.defaultScale;
    } else {
      updates.length = null;
      updates.scale = null;
    }
    onChange(updates);
  };

  return (
    <div className="flex items-center gap-1">
      <DropdownSelect
        value={column.data_type}
        options={typeOptions}
        onChange={handleTypeChange}
        className="w-[90px]"
        plain
      />

      {typeDef?.hasLength && (
        <input
          type="number"
          className="w-[48px] h-[20px] bg-background-elevated border border-border-strong rounded text-foreground text-[12px] px-1 outline-none focus:border-accent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          value={column.length ?? ''}
          placeholder="长度"
          onChange={(e) => {
            const v = e.target.value;
            onChange({ length: v === '' ? null : parseInt(v, 10) });
          }}
        />
      )}

      {typeDef?.hasScale && (
        <input
          type="number"
          className="w-[40px] h-[20px] bg-background-elevated border border-border-strong rounded text-foreground text-[12px] px-1 outline-none focus:border-accent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          value={column.scale ?? ''}
          placeholder="精度"
          onChange={(e) => {
            const v = e.target.value;
            onChange({ scale: v === '' ? null : parseInt(v, 10) });
          }}
        />
      )}

      {typeDef?.hasEnumValues && (
        <button
          type="button"
          className="text-[11px] text-accent hover:text-[#00e6be] cursor-pointer whitespace-nowrap transition-colors duration-200"
          title="编辑值列表"
        >
          编辑值列表...
        </button>
      )}
    </div>
  );
}
