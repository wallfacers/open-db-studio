// src/components/ImportExport/FieldMapper.tsx
import React from 'react';
import { ArrowRight } from 'lucide-react';

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

  const updateMapping = (sourceColumn: string, targetColumn: string | null) => {
    onChange(
      mappings.map((m) =>
        m.sourceColumn === sourceColumn ? { ...m, targetColumn } : m
      )
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={autoMatch}
          className="px-2 py-1 text-xs text-[#3794ff] border border-[#3794ff]/50 rounded hover:bg-[#1a4a8a] transition-colors"
        >
          自动匹配列名
        </button>
        <button
          onClick={clearAll}
          className="px-2 py-1 text-xs text-[#7a9bb8] border border-[#253347] rounded hover:bg-[#1a2639] transition-colors"
        >
          清空映射
        </button>
        <span className="text-xs text-[#7a9bb8] ml-auto">
          已映射: {mappings.filter((m) => m.targetColumn).length}/{sourceColumns.length}
        </span>
      </div>

      {/* Header */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 px-1 py-1 text-[10px] text-[#4a6a8a] border-b border-[#1e2d42]">
        <div>源文件列</div>
        <div className="w-6" />
        <div>目标表列</div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1 mt-1">
        {mappings.map((m) => (
          <div
            key={m.sourceColumn}
            className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center"
          >
            <div className="px-2 py-1 bg-[#1a2639] border border-[#253347] rounded text-xs text-[#c8daea] truncate">
              {m.sourceColumn}
            </div>
            <ArrowRight size={12} className="text-[#253347]" />
            <select
              value={m.targetColumn ?? ''}
              onChange={(e) => updateMapping(m.sourceColumn, e.target.value || null)}
              className="px-2 py-1 bg-[#1a2639] border border-[#253347] rounded text-xs text-[#c8daea] outline-none"
            >
              <option value="">（不映射）</option>
              {targetColumns.map((tc) => (
                <option key={tc.name} value={tc.name}>
                  {tc.name} ({tc.type}{tc.isPk ? ', PK' : ''})
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
};
