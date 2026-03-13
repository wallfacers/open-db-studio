// src/components/ImportExport/ImportWizard.tsx
import React, { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, Upload } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FieldMapper, ColumnMapping } from './FieldMapper';
import { useTaskStore } from '../../store';

type FileType = 'csv' | 'json' | 'excel' | 'sql';
type ErrorStrategy = 'stop_on_error' | 'skip_and_continue';

interface ImportWizardProps {
  connectionId: number;
  database?: string;
  schema?: string;
  defaultTable?: string;
  onClose: () => void;
}

interface ColumnInfo {
  name: string;
  type: string;
  isPk: boolean;
  nullable: boolean;
}

export const ImportWizard: React.FC<ImportWizardProps> = ({
  connectionId,
  database = '',
  schema = '',
  defaultTable = '',
  onClose,
}) => {
  const { setVisible: setTaskCenterVisible } = useTaskStore();
  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Step 1 state
  const [fileType, setFileType] = useState<FileType>('csv');
  const [filePath, setFilePath] = useState('');
  const [preview, setPreview] = useState<string[]>([]);
  const [sourceColumns, setSourceColumns] = useState<string[]>([]);

  // Step 2 state
  const [targetTable, setTargetTable] = useState(defaultTable);
  const [targetColumns, setTargetColumns] = useState<ColumnInfo[]>([]);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [availableTables, setAvailableTables] = useState<string[]>([]);

  // Step 3 state
  const [errorStrategy, setErrorStrategy] = useState<ErrorStrategy>('skip_and_continue');

  const handleSelectFile = async () => {
    const selected = await openDialog({
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
        { name: 'SQL', extensions: ['sql'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (selected && typeof selected === 'string') {
      setFilePath(selected);
      try {
        const result = await invoke<{ columns: string[]; preview_rows: string[] }>(
          'preview_import_file',
          { filePath: selected, fileType }
        );
        setSourceColumns(result.columns);
        setPreview(result.preview_rows);
      } catch (e) {
        console.error('Preview failed:', e);
      }
    }
  };

  // 加载目标表列表
  useEffect(() => {
    if (step === 2) {
      invoke<string[]>('list_objects', {
        connectionId,
        database,
        schema: schema || undefined,
        category: 'tables',
      })
        .then(setAvailableTables)
        .catch(console.error);
    }
  }, [step, connectionId, database, schema]);

  // 当目标表变化时加载列信息
  useEffect(() => {
    if (targetTable && step === 2) {
      invoke<{ columns: ColumnInfo[] }>('get_table_columns_for_import', {
        connectionId,
        database: database || null,
        schema: schema || null,
        table: targetTable,
      })
        .then((info) => {
          setTargetColumns(info.columns);
          setMappings(
            sourceColumns.map((src) => ({
              sourceColumn: src,
              targetColumn:
                info.columns.find(
                  (c) => c.name.toLowerCase() === src.toLowerCase()
                )?.name ?? null,
            }))
          );
        })
        .catch(console.error);
    }
  }, [targetTable, step, sourceColumns, connectionId, database, schema]);

  const handleStart = async () => {
    if (isLoading) return;
    setIsLoading(true);
    setImportError(null);
    const fieldMapping: Record<string, string> = {};
    mappings.forEach((m) => {
      if (m.targetColumn) fieldMapping[m.sourceColumn] = m.targetColumn;
    });

    try {
      await invoke('import_to_table', {
        params: {
          connection_id: connectionId,
          database: database || null,
          schema: schema || null,
          table: targetTable,
          file_path: filePath,
          file_type: fileType,
          field_mapping: fieldMapping,
          error_strategy: errorStrategy === 'stop_on_error' ? 'StopOnError' : 'SkipAndContinue',
        },
      });
      setTaskCenterVisible(true);
      onClose();
    } catch (e) {
      console.error('Import failed:', e);
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  };

  const mappedCount = mappings.filter((m) => m.targetColumn).length;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#0d1520] border border-[#1e2d42] rounded-lg w-[600px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e2d42]">
          <h3 className="text-sm text-[#e8f4ff] font-medium">导入数据</h3>
          <div className="flex items-center gap-3">
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
        <div className="p-4 min-h-[320px]">
          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-1">文件类型</label>
                <select
                  value={fileType}
                  onChange={(e) => setFileType(e.target.value as FileType)}
                  className="bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                >
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                  <option value="excel">Excel (.xlsx)</option>
                  <option value="sql">SQL Dump</option>
                </select>
              </div>
              <div
                onClick={handleSelectFile}
                className="border-2 border-dashed border-[#253347] rounded-lg p-6 flex flex-col items-center gap-2 cursor-pointer hover:border-[#3794ff]/50 transition-colors"
              >
                <Upload size={24} className="text-[#7a9bb8]" />
                <span className="text-sm text-[#c8daea]">
                  {filePath ? filePath.split(/[/\\]/).pop() : '点击选择文件'}
                </span>
                <span className="text-xs text-[#7a9bb8]">或拖放到此处</span>
              </div>
              {preview.length > 0 && (
                <div>
                  <div className="text-xs text-[#7a9bb8] mb-1">预览 (前5行):</div>
                  <div className="bg-[#0d1117] rounded p-2 font-mono text-xs text-[#00c9a7] max-h-28 overflow-y-auto">
                    {preview.map((line, i) => <div key={i}>{line}</div>)}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="h-[320px] flex flex-col space-y-3">
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-1">目标表</label>
                <select
                  value={targetTable}
                  onChange={(e) => setTargetTable(e.target.value)}
                  className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                >
                  <option value="">选择目标表...</option>
                  {availableTables.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              {targetTable && sourceColumns.length > 0 && (
                <div className="flex-1 overflow-hidden">
                  <FieldMapper
                    sourceColumns={sourceColumns}
                    targetColumns={targetColumns}
                    mappings={mappings}
                    onChange={setMappings}
                  />
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div className="p-3 bg-[#111922] rounded border border-[#1e2d42] text-xs space-y-1">
                <div className="text-[#7a9bb8]">导入摘要:</div>
                <div className="text-[#c8daea]">源文件: {filePath.split(/[/\\]/).pop()}</div>
                <div className="text-[#c8daea]">目标表: {targetTable}</div>
                <div className="text-[#c8daea]">映射字段: {mappedCount}/{sourceColumns.length}</div>
              </div>
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-2">错误处理:</label>
                {(['stop_on_error', 'skip_and_continue'] as ErrorStrategy[]).map((s) => (
                  <label key={s} className="flex items-center gap-2 py-1 cursor-pointer">
                    <input
                      type="radio"
                      name="errorStrategy"
                      value={s}
                      checked={errorStrategy === s}
                      onChange={() => setErrorStrategy(s)}
                      className="accent-[#3794ff]"
                    />
                    <span className="text-sm text-[#c8daea]">
                      {s === 'stop_on_error' ? '遇错停止' : '跳过错误行继续'}
                    </span>
                  </label>
                ))}
              </div>
              {importError && (
                <div className="text-xs text-[#f44747] bg-[#f44747]/10 px-2 py-1.5 rounded border border-[#f44747]/30">
                  导入失败：{importError}
                </div>
              )}
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
                disabled={
                  (step === 1 && !filePath) ||
                  (step === 2 && (!targetTable || mappedCount === 0))
                }
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#1a4a8a] text-[#3794ff] border border-[#3794ff]/50 rounded hover:bg-[#1e5a9a] transition-colors disabled:opacity-40"
              >
                下一步 <ChevronRight size={12} />
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={isLoading}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#3794ff] text-white rounded hover:bg-[#4aa4ff] transition-colors disabled:opacity-40"
              >
                <Upload size={12} /> {isLoading ? '导入中...' : '开始导入'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
