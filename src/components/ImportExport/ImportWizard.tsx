// src/components/ImportExport/ImportWizard.tsx
import React, { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, Upload } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FieldMapper, ColumnMapping } from './FieldMapper';
import { useTaskStore } from '../../store';
import { useEscClose } from '../../hooks/useEscClose';
import { DropdownSelect } from '../common/DropdownSelect';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store/appStore';

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
  const { t } = useTranslation();
  useEscClose(onClose);
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
      // 写入操作上下文快照
      useAppStore.getState().setLastOperationContext({
        type: 'import',
        connectionId: connectionId,
        database: database || undefined,
        schema: schema || undefined,
      });
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

  const inputClass = 'w-full bg-background-hover border border-border-strong rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-border-focus';
  const labelClass = 'block text-xs text-foreground-muted mb-1';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-background-panel border border-border-strong rounded-lg w-[600px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-strong">
          <h3 className="text-foreground font-semibold">{t('importWizard.title')}</h3>
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className={`w-2 h-2 rounded-full ${
                    n === step ? 'bg-accent' : n < step ? 'bg-accent' : 'bg-border-strong'
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-foreground-muted">{t('importWizard.step', { current: step, total: 3 })}</span>
            <button onClick={onClose} className="text-foreground-muted hover:text-foreground-default transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 min-h-[320px]">
          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className={labelClass}>{t('importWizard.fileType')}</label>
                <DropdownSelect
                  value={fileType}
                  options={[
                    { value: 'csv', label: 'CSV' },
                    { value: 'json', label: 'JSON' },
                    { value: 'excel', label: 'Excel (.xlsx)' },
                    { value: 'sql', label: 'SQL Dump' },
                  ]}
                  onChange={(v) => setFileType(v as FileType)}
                />
              </div>
              <div
                onClick={handleSelectFile}
                className="border-2 border-dashed border-border-strong rounded-lg p-6 flex flex-col items-center gap-2 cursor-pointer hover:border-accent/50 transition-colors"
              >
                <Upload size={24} className="text-foreground-muted" />
                <span className="text-sm text-foreground">
                  {filePath ? filePath.split(/[/\\]/).pop() : t('importWizard.clickToSelectFile')}
                </span>
                <span className="text-xs text-foreground-muted">{t('importWizard.dragAndDrop')}</span>
              </div>
              {preview.length > 0 && (
                <div>
                  <div className={labelClass}>{t('importWizard.preview')}</div>
                  <div className="bg-background-base rounded p-2 font-mono text-xs text-accent max-h-28 overflow-y-auto">
                    {preview.map((line, i) => <div key={i}>{line}</div>)}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="h-[320px] flex flex-col space-y-3">
              <div>
                <label className={labelClass}>{t('importWizard.targetTable')}</label>
                <DropdownSelect
                  value={targetTable}
                  placeholder={t('importWizard.selectTargetTable')}
                  options={availableTables.map((t) => ({ value: t, label: t }))}
                  onChange={setTargetTable}
                  className="w-full"
                />
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
              <div className="p-3 bg-background-hover rounded border border-border-strong text-sm space-y-1">
                <div className="text-foreground-muted">{t('importWizard.summaryTitle')}</div>
                <div className="text-foreground">{t('importWizard.summaryFile', { file: filePath.split(/[/\\]/).pop() })}</div>
                <div className="text-foreground">{t('importWizard.summaryTable', { table: targetTable })}</div>
                <div className="text-foreground">{t('importWizard.summaryMappings', { mapped: mappedCount, total: sourceColumns.length })}</div>
              </div>
              <div>
                <label className="block text-xs text-foreground-muted mb-2">{t('importWizard.errorStrategy')}</label>
                {(['stop_on_error', 'skip_and_continue'] as ErrorStrategy[]).map((s) => (
                  <label key={s} className="flex items-center gap-2 py-1 cursor-pointer">
                    <input
                      type="radio"
                      name="errorStrategy"
                      value={s}
                      checked={errorStrategy === s}
                      onChange={() => setErrorStrategy(s)}
                      className="accent-accent"
                    />
                    <span className="text-sm text-foreground">
                      {s === 'stop_on_error' ? t('importWizard.stopOnError') : t('importWizard.skipAndContinue')}
                    </span>
                  </label>
                ))}
              </div>
              {importError && (
                <div className="text-sm text-error bg-error-subtle px-3 py-1.5 rounded border border-error/30">
                  {t('importWizard.importFailed', { error: importError })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border-strong">
          <button onClick={onClose} className="px-3 py-1.5 text-sm bg-background-hover hover:bg-border-strong text-foreground rounded transition-colors">
            {t('importWizard.cancel')}
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-foreground bg-background-hover hover:bg-border-strong border border-border-strong rounded transition-colors"
              >
                <ChevronLeft size={14} /> {t('importWizard.prev')}
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={
                  (step === 1 && !filePath) ||
                  (step === 2 && (!targetTable || mappedCount === 0))
                }
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-accent hover:bg-accent-hover text-foreground rounded transition-colors disabled:opacity-50"
              >
                {t('importWizard.next')} <ChevronRight size={14} />
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={isLoading}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-accent hover:bg-accent-hover text-foreground rounded transition-colors disabled:opacity-50"
              >
                <Upload size={14} /> {isLoading ? t('importWizard.importing') : t('importWizard.startImport')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
