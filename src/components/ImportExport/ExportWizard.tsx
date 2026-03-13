// src/components/ImportExport/ExportWizard.tsx
import React, { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, Download } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { TableSelector, TableInfo } from './TableSelector';
import { useTaskStore } from '../../store';

export type ExportScope = 'current_table' | 'multi_table' | 'database';
export type ExportFormat = 'csv' | 'json' | 'sql';

interface ExportWizardProps {
  /** 右键触发时的初始表名（可选） */
  defaultTable?: string;
  connectionId: number;
  database?: string;
  schema?: string;
  onClose: () => void;
}

interface Step1State {
  scope: ExportScope;
  connectionId: number;
  database: string;
  schema: string;
}

interface Step3Options {
  format: ExportFormat;
  includeHeader: boolean;
  includeDdl: boolean;
  whereClause: string;
  encoding: 'UTF-8' | 'GBK';
  delimiter: string;
}

export const ExportWizard: React.FC<ExportWizardProps> = ({
  defaultTable,
  connectionId,
  database = '',
  schema = '',
  onClose,
}) => {
  const { setVisible: setTaskCenterVisible } = useTaskStore();
  const [step, setStep] = useState(1);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>(
    defaultTable ? [defaultTable] : []
  );
  const [step1, setStep1] = useState<Step1State>({
    scope: defaultTable ? 'current_table' : 'multi_table',
    connectionId,
    database,
    schema,
  });
  const [options, setOptions] = useState<Step3Options>({
    format: 'csv',
    includeHeader: true,
    includeDdl: true,
    whereClause: '',
    encoding: 'UTF-8',
    delimiter: ',',
  });
  const [isLoading, setIsLoading] = useState(false);

  // Step 2: 加载表列表（multi_table 和 database scope 都要加载）
  useEffect(() => {
    if (step === 2 && step1.scope !== 'current_table') {
      setIsLoading(true);
      invoke<string[]>('list_objects', {
        connectionId: step1.connectionId,
        database: step1.database,
        schema: step1.schema || undefined,
        category: 'tables',
      })
        .then((names) => {
          const tableList = names.map((name) => ({ name }));
          setTables(tableList);
          // database scope: 自动全选所有表
          if (step1.scope === 'database') {
            setSelectedTables(names);
          }
        })
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }
  }, [step, step1]);

  const handleStart = async () => {
    const outputDir = await openDialog({
      directory: true,
      title: '选择导出目录',
    });
    if (!outputDir) return;

    // database scope：导出所有已加载的表（selectedTables 在 step 2 已被全选）
    const tablesToExport =
      step1.scope === 'current_table' && defaultTable
        ? [defaultTable]
        : selectedTables; // multi_table 和 database scope 都用 selectedTables

    try {
      await invoke('export_tables', {
        params: {
          connection_id: step1.connectionId,
          database: step1.database || null,
          schema: step1.schema || null,
          tables: tablesToExport,
          format: options.format,
          output_dir: outputDir as string,
          options: {
            include_header: options.includeHeader,
            include_ddl: options.includeDdl,
            where_clause: options.whereClause || null,
            encoding: options.encoding,
            delimiter: options.delimiter,
          },
        },
      });
      setTaskCenterVisible(true);
      onClose();
    } catch (e) {
      console.error('Export failed:', e);
    }
  };

  const canGoNext = () => {
    if (step === 2) return selectedTables.length > 0;
    return true;
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#0d1520] border border-[#1e2d42] rounded-lg w-[560px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e2d42]">
          <h3 className="text-sm text-[#e8f4ff] font-medium">导出数据</h3>
          <div className="flex items-center gap-3">
            {/* Step indicator */}
            <div className="flex gap-1.5">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className={`w-2 h-2 rounded-full ${
                    n === step ? 'bg-[#3794ff]' : n < step ? 'bg-[#00c9a7]' : 'bg-[#253347]'
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-[#7a9bb8]">步骤 {step}/3</span>
            <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 min-h-[300px]">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-2">导出范围</label>
                {(['current_table', 'multi_table', 'database'] as ExportScope[]).map((scope) => (
                  <label key={scope} className="flex items-center gap-2 py-1 cursor-pointer">
                    <input
                      type="radio"
                      name="scope"
                      value={scope}
                      checked={step1.scope === scope}
                      onChange={() => setStep1((s) => ({ ...s, scope }))}
                      className="accent-[#3794ff]"
                      disabled={scope === 'current_table' && !defaultTable}
                    />
                    <span className={`text-sm ${scope === 'current_table' && !defaultTable ? 'text-[#4a6a8a]' : 'text-[#c8daea]'}`}>
                      {scope === 'current_table' ? `当前表${defaultTable ? `（${defaultTable}）` : ''}` :
                       scope === 'multi_table' ? '多表选择' : '整个数据库'}
                    </span>
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#7a9bb8] mb-1">数据库</label>
                  <input
                    value={step1.database}
                    onChange={(e) => setStep1((s) => ({ ...s, database: e.target.value }))}
                    className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                    placeholder="数据库名"
                  />
                </div>
                {schema !== undefined && (
                  <div>
                    <label className="block text-xs text-[#7a9bb8] mb-1">Schema</label>
                    <input
                      value={step1.schema}
                      onChange={(e) => setStep1((s) => ({ ...s, schema: e.target.value }))}
                      className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                      placeholder="schema 名（PG）"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="h-[300px] flex flex-col">
              {isLoading ? (
                <div className="flex-1 flex items-center justify-center text-[#7a9bb8] text-sm">
                  加载表列表...
                </div>
              ) : step1.scope === 'current_table' ? (
                <div className="text-sm text-[#c8daea] py-4">
                  将导出表：<span className="text-[#3794ff] font-medium">{defaultTable}</span>
                </div>
              ) : (
                <TableSelector
                  tables={tables}
                  selected={selectedTables}
                  onChange={setSelectedTables}
                />
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#7a9bb8] mb-1">格式</label>
                  <select
                    value={options.format}
                    onChange={(e) => setOptions((o) => ({ ...o, format: e.target.value as ExportFormat }))}
                    className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                  >
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                    <option value="sql">SQL</option>
                  </select>
                </div>
                {options.format === 'csv' && (
                  <div>
                    <label className="block text-xs text-[#7a9bb8] mb-1">编码</label>
                    <select
                      value={options.encoding}
                      onChange={(e) => setOptions((o) => ({ ...o, encoding: e.target.value as 'UTF-8' | 'GBK' }))}
                      className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                    >
                      <option value="UTF-8">UTF-8</option>
                      <option value="GBK">GBK</option>
                    </select>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={options.includeHeader}
                    onChange={(e) => setOptions((o) => ({ ...o, includeHeader: e.target.checked }))}
                    className="accent-[#3794ff]"
                  />
                  <span className="text-xs text-[#c8daea]">包含表头（CSV）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={options.includeDdl}
                    onChange={(e) => setOptions((o) => ({ ...o, includeDdl: e.target.checked }))}
                    className="accent-[#3794ff]"
                  />
                  <span className="text-xs text-[#c8daea]">包含 DDL（SQL 格式）</span>
                </label>
              </div>
              {selectedTables.length === 1 && (
                <div>
                  <label className="block text-xs text-[#7a9bb8] mb-1">
                    WHERE 条件（可选，单表时生效）
                  </label>
                  <input
                    value={options.whereClause}
                    onChange={(e) => setOptions((o) => ({ ...o, whereClause: e.target.value }))}
                    placeholder="例如: id > 100"
                    className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none font-mono"
                  />
                </div>
              )}
              <div className="p-3 bg-[#111922] rounded border border-[#1e2d42] text-xs text-[#7a9bb8]">
                <div>导出表数: {step1.scope === 'current_table' ? 1 : selectedTables.length}</div>
                <div>格式: {options.format.toUpperCase()}</div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[#1e2d42]">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea]">
            取消
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs text-[#7a9bb8] border border-[#253347] rounded hover:bg-[#1a2639] transition-colors"
              >
                <ChevronLeft size={12} /> 上一步
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canGoNext()}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#1a4a8a] text-[#3794ff] border border-[#3794ff]/50 rounded hover:bg-[#1e5a9a] transition-colors disabled:opacity-40"
              >
                下一步 <ChevronRight size={12} />
              </button>
            ) : (
              <button
                onClick={handleStart}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#1a4a8a] text-[#3794ff] border border-[#3794ff]/50 rounded hover:bg-[#1e5a9a] transition-colors"
              >
                <Download size={12} /> 开始导出
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
