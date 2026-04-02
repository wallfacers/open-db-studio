// src/components/ImportExport/FieldMapper.tsx
import React from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DropdownSelect } from '../common/DropdownSelect';

export interface ColumnMapping {
  sourceColumn: string;
  targetColumn: string | null;  // null 表示不映射
}

interface TargetColumn {
  name: string;
  type: string;
  isPk: boolean;
  nullable: boolean;
}

interface Props {
  sourceColumns: string[];
  targetColumns: TargetColumn[];
  mappings: ColumnMapping[];
  onChange: (mappings: ColumnMapping[]) => void;
}

export const FieldMapper: React.FC<Props> = ({
  sourceColumns,
  targetColumns,
  mappings,
  onChange,
}) => {
  const { t } = useTranslation();
  const autoMatch = () => {
    const newMappings = sourceColumns.map((src) => ({
      sourceColumn: src,
      targetColumn:
        targetColumns.find(
          (t) => t.name.toLowerCase() === src.toLowerCase()
        )?.name ?? null,
    }));
    onChange(newMappings);
  };

  const clearAll = () => {
    onChange(sourceColumns.map((src) => ({ sourceColumn: src, targetColumn: null })));
  };

  const updateMapping = (idx: number, targetColumn: string | null) => {
    onChange(
      mappings.map((m, i) =>
        i === idx ? { ...m, targetColumn } : m
      )
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={autoMatch}
          className="px-3 py-1.5 text-sm text-foreground bg-accent hover:bg-accent-hover rounded transition-colors"
        >
          {t('fieldMapper.autoMatch')}
        </button>
        <button
          onClick={clearAll}
          className="px-3 py-1.5 text-sm text-foreground bg-background-hover hover:bg-border-strong border border-border-strong rounded transition-colors"
        >
          {t('fieldMapper.clearAll')}
        </button>
        <span className="text-sm text-foreground-muted ml-auto">
          {t('fieldMapper.mappedCount', { mapped: mappings.filter((m) => m.targetColumn).length, total: sourceColumns.length })}
        </span>
      </div>

      {/* Header */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 px-1 py-1.5 text-xs text-foreground-muted border-b border-border-strong">
        <div>{t('fieldMapper.sourceColumn')}</div>
        <div className="w-6" />
        <div>{t('fieldMapper.targetColumn')}</div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1.5 mt-1.5">
        {mappings.map((m, idx) => (
          <div
            key={idx}
            className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center"
          >
            <div className="px-3 py-1.5 bg-background-hover border border-border-strong rounded text-sm text-foreground truncate">
              {m.sourceColumn}
            </div>
            <ArrowRight size={14} className="text-foreground-ghost" />
            <DropdownSelect
              value={m.targetColumn ?? ''}
              placeholder={t('fieldMapper.noMapping')}
              options={targetColumns.map((tc) => ({
                value: tc.name,
                label: `${tc.name} (${tc.type}${tc.isPk ? ', PK' : ''})`,
              }))}
              onChange={(v) => updateMapping(idx, v || null)}
              className="flex-1"
            />
          </div>
        ))}
      </div>
    </div>
  );
};
