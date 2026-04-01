// src/components/ImportExport/ExportWizard.tsx
import React, { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, Download } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { TableSelector, TableInfo } from './TableSelector';
import { useTaskStore } from '../../store';
import { useEscClose } from '../../hooks/useEscClose';
import { DropdownSelect } from '../common/DropdownSelect';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store/appStore';

export type ExportScope = 'current_table' | 'multi_table' | 'database';
export type ExportFormat = 'csv' | 'json' | 'sql';

interface ExportWizardProps {
  /** 右键触发时的初始表名（可选） */
  defaultTable?: string;
  connectionId: number;
  database?: string;
  schema?: string;
  initialScope?: ExportScope;  // 新增
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
  fileName: string;  // 新增
}

export const ExportWizard: React.FC<ExportWizardProps> = ({
  defaultTable,
  connectionId,
  database = '',
  schema = '',
  initialScope,   // 新增
  onClose,
}) => {
  const { setVisible: setTaskCenterVisible } = useTaskStore();
  const { t } = useTranslation();
  useEscClose(onClose);
  const [step, setStep] = useState(1);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>(
    defaultTable ? [defaultTable] : []
  );
  const [step1, setStep1] = useState<Step1State>({
    scope: initialScope ?? (defaultTable ? 'current_table' : 'multi_table'),
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
    fileName: '',   // 新增
  });
  const [isLoading, setIsLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [userEditedFileName, setUserEditedFileName] = useState(false);

  const formatTimestamp = (): string => {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');
  };

  // 数据库/Schema 下拉列表
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);

  // 当 scope 切换到非单表时加载数据库列表
  useEffect(() => {
    if (step1.scope === 'current_table') return;
    invoke<string[]>('list_databases', { connectionId })
      .then(setDatabases)
      .catch(console.error);
  }, [step1.scope, connectionId]);

  // 当选中数据库变化时加载 schema 列表
  useEffect(() => {
    if (!step1.database || step1.scope === 'current_table') {
      setSchemas([]);
      return;
    }
    invoke<string[]>('list_schemas', { connectionId, database: step1.database })
      .then(setSchemas)
      .catch(() => setSchemas([]));
  }, [step1.database, step1.scope, connectionId]);

  // Step 2: 加载表列表（multi_table 和 database scope 都要加载）
  useEffect(() => {
    if (step === 2 && step1.scope !== 'current_table') {
      setIsLoading(true);
      invoke<{ name: string; row_count: number | null; size: string | null }[]>('list_tables_with_stats', {
        connectionId: step1.connectionId,
        database: step1.database,
        schema: step1.schema || undefined,
      })
        .then((stats) => {
          const tableList: TableInfo[] = stats.map((s) => ({
            name: s.name,
            rowCount: s.row_count ?? undefined,
            size: s.size ?? undefined,
          }));
          setTables(tableList);
          // database scope: 自动全选所有表
          if (step1.scope === 'database') {
            setSelectedTables(stats.map((s) => s.name));
          }
        })
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }
  }, [step, step1]);

  // 文件名自动生成
  useEffect(() => {
    if (userEditedFileName) return;
    const ts = formatTimestamp();
    let name = '';
    if (step1.scope === 'current_table') {
      name = `${defaultTable ?? 'export'}_${ts}`;
    } else if (step1.scope === 'multi_table') {
      name = step1.schema
        ? `${step1.database}_${step1.schema}_${ts}`
        : `${step1.database}_${ts}`;
    } else {
      name = `${step1.database || 'database'}_${ts}`;
    }
    setOptions(o => ({ ...o, fileName: name }));
  }, [step1.scope, step1.database, step1.schema, defaultTable, userEditedFileName]);

  const handleScopeChange = (scope: ExportScope) => {
    setStep1(s => ({ ...s, scope }));
    setUserEditedFileName(false);
  };

  const handleStart = async () => {
    if (isLoading) return;
    setIsLoading(true);
    setExportError(null);
    try {
      const outputDir = await openDialog({
        directory: true,
        title: t('exportWizard.selectOutputDir'),
      });
      if (!outputDir || Array.isArray(outputDir)) return;

      const tablesToExport =
        step1.scope === 'database'
          ? []
          : step1.scope === 'current_table' && defaultTable
          ? [defaultTable]
          : selectedTables;

      // 写入操作上下文快照
      useAppStore.getState().setLastOperationContext({
        type: 'export',
        connectionId: step1.connectionId,
        database: step1.database || undefined,
        schema: step1.schema || undefined,
      });
      await invoke('export_tables', {
        params: {
          connection_id: step1.connectionId,
          database: step1.database || null,
          schema: step1.schema || null,
          tables: tablesToExport,
          format: options.format,
          output_dir: outputDir,
          file_name: options.fileName,
          export_all: step1.scope === 'database',
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
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  };

  const canGoNext = () => {
    if (step === 2) return selectedTables.length > 0;
    return true;
  };

  const totalSteps = step1.scope === 'database' ? 2 : 3;

  const goNext = () => {
    if (step1.scope === 'database' && step === 1) {
      setStep(3);
    } else {
      setStep(s => s + 1);
    }
  };

  const goPrev = () => {
    if (step1.scope === 'database' && step === 3) {
      setStep(1);
    } else {
      setStep(s => s - 1);
    }
  };

  const displayStep = step1.scope === 'database' && step === 3 ? 2 : step;

  const inputClass = 'w-full bg-[var(--background-hover)] border border-[var(--border-strong)] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[var(--background-panel)] border border-[var(--border-strong)] rounded-lg w-[560px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-strong)]">
          <h3 className="text-white font-semibold">{t('exportWizard.title')}</h3>
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              {Array.from({ length: totalSteps }, (_, i) => i + 1).map((n) => (
                <div
                  key={n}
                  className={`w-2 h-2 rounded-full ${
                    n === displayStep ? 'bg-[#009e84]' : n < displayStep ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]'
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-gray-400">
              {t('exportWizard.step', { current: displayStep, total: totalSteps })}
            </span>
            <button onClick={onClose} className="text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 min-h-[300px]">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-2">{t('exportWizard.scope')}</label>
                {(['current_table', 'multi_table', 'database'] as ExportScope[]).map((scope) => (
                  <label key={scope} className="flex items-center gap-2 py-1 cursor-pointer">
                    <input
                      type="radio"
                      name="scope"
                      value={scope}
                      checked={step1.scope === scope}
                      onChange={() => handleScopeChange(scope)}
                      className="accent-[#009e84]"
                      disabled={scope === 'current_table' && !defaultTable}
                    />
                    <span className={`text-sm ${scope === 'current_table' && !defaultTable ? 'text-gray-600' : 'text-white'}`}>
                      {scope === 'current_table'
                        ? (defaultTable ? t('exportWizard.scopeCurrentTable', { table: defaultTable }) : t('exportWizard.scopeCurrentTableDisabled'))
                        : scope === 'multi_table' ? t('exportWizard.scopeMultiTable') : t('exportWizard.scopeDatabase')}
                    </span>
                  </label>
                ))}
              </div>

              {step1.scope !== 'current_table' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>{t('exportWizard.database')}</label>
                    <DropdownSelect
                      value={step1.database}
                      placeholder={t('exportWizard.selectDatabase')}
                      options={databases.map((d) => ({ value: d, label: d }))}
                      onChange={(v) => setStep1((s) => ({ ...s, database: v, schema: '' }))}
                      className="w-full"
                    />
                  </div>
                  {schemas.length > 0 && (
                    <div>
                      <label className={labelClass}>{t('exportWizard.schema')}</label>
                      <DropdownSelect
                        value={step1.schema}
                        placeholder={t('exportWizard.selectSchema')}
                        options={schemas.map((s) => ({ value: s, label: s }))}
                        onChange={(v) => setStep1((s) => ({ ...s, schema: v }))}
                        className="w-full"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="h-[300px] flex flex-col">
              {isLoading ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                  {t('exportWizard.loadingTables')}
                </div>
              ) : step1.scope === 'current_table' ? (
                <div className="text-sm text-white py-4">
                  {t('exportWizard.willExportTable')}<span className="text-[#009e84] font-medium">{defaultTable}</span>
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
              {/* 文件名输入 */}
              <div>
                <label className={labelClass}>{t('exportWizard.fileName')}</label>
                <div className="flex gap-2 items-center">
                  <input
                    value={options.fileName}
                    onChange={e => {
                      setOptions(o => ({ ...o, fileName: e.target.value }));
                      setUserEditedFileName(true);
                    }}
                    placeholder={t('exportWizard.fileNamePlaceholder')}
                    className={`${inputClass} flex-1`}
                  />
                  <span className="text-sm text-gray-400 flex-shrink-0">
                    {(step1.scope === 'current_table')
                      ? `.${options.format}`
                      : '.zip'}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>{t('exportWizard.format')}</label>
                  <DropdownSelect
                    value={options.format}
                    options={[
                      { value: 'csv', label: 'CSV' },
                      { value: 'json', label: 'JSON' },
                      { value: 'sql', label: 'SQL' },
                    ]}
                    onChange={(v) => setOptions((o) => ({ ...o, format: v as ExportFormat }))}
                    className="w-full"
                  />
                </div>
                {options.format === 'csv' && (
                  <div>
                    <label className={labelClass}>{t('exportWizard.encoding')}</label>
                    <DropdownSelect
                      value={options.encoding}
                      options={[
                        { value: 'UTF-8', label: 'UTF-8' },
                        { value: 'GBK', label: 'GBK' },
                      ]}
                      onChange={(v) => setOptions((o) => ({ ...o, encoding: v as 'UTF-8' | 'GBK' }))}
                      className="w-full"
                    />
                  </div>
                )}
              </div>
              <div className="space-y-2">
                {options.format === 'csv' && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={options.includeHeader}
                      onChange={(e) => setOptions((o) => ({ ...o, includeHeader: e.target.checked }))}
                      className="accent-[#009e84]"
                    />
                    <span className="text-sm text-white">{t('exportWizard.includeHeader')}</span>
                  </label>
                )}
                {options.format === 'sql' && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={options.includeDdl}
                      onChange={(e) => setOptions((o) => ({ ...o, includeDdl: e.target.checked }))}
                      className="accent-[#009e84]"
                    />
                    <span className="text-sm text-white">{t('exportWizard.includeDdl')}</span>
                  </label>
                )}
              </div>
              {selectedTables.length === 1 && (
                <div>
                  <label className={labelClass}>{t('exportWizard.whereClause')}</label>
                  <input
                    value={options.whereClause}
                    onChange={(e) => setOptions((o) => ({ ...o, whereClause: e.target.value }))}
                    placeholder={t('exportWizard.whereClausePlaceholder')}
                    className={`${inputClass} font-mono`}
                  />
                </div>
              )}
              <div className="p-3 bg-[var(--background-hover)] rounded border border-[var(--border-strong)] text-sm text-gray-400">
                <div>{t('exportWizard.summaryTableCount', { count: step1.scope === 'current_table' ? 1 : selectedTables.length })}</div>
                <div>{t('exportWizard.summaryFormat', { format: options.format.toUpperCase() })}</div>
                <div>
                  {t('exportWizard.summaryFile', {
                    name: options.fileName,
                    ext: step1.scope === 'current_table' ? `.${options.format}` : '.zip',
                  })}
                </div>
              </div>
              {exportError && (
                <div className="text-sm text-red-400 bg-red-400/10 px-3 py-1.5 rounded border border-red-400/30">
                  {t('exportWizard.exportFailed', { error: exportError })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[var(--border-strong)]">
          <button onClick={onClose} className="px-3 py-1.5 text-sm bg-[var(--background-hover)] hover:bg-[var(--border-strong)] text-white rounded transition-colors">
            {t('exportWizard.cancel')}
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                onClick={goPrev}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-[var(--background-hover)] hover:bg-[var(--border-strong)] border border-[var(--border-strong)] rounded transition-colors"
              >
                <ChevronLeft size={14} /> {t('exportWizard.prev')}
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={goNext}
                disabled={!canGoNext()}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded transition-colors disabled:opacity-50"
              >
                {t('exportWizard.next')} <ChevronRight size={14} />
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={isLoading}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded transition-colors disabled:opacity-50"
              >
                <Download size={14} /> {t('exportWizard.startExport')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
