import React, { useState } from 'react';
import { X, ChevronLeft, Database } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { useEscClose } from '../../hooks/useEscClose';

interface BackupWizardProps {
  connectionId: number;
  database: string;
  driver: 'mysql' | 'postgresql';
  onClose: () => void;
}

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

export const BackupWizard: React.FC<BackupWizardProps> = ({
  connectionId,
  database,
  driver,
  onClose,
}) => {
  const { t } = useTranslation();
  useEscClose(onClose);

  const [step, setStep] = useState(1);
  const [includeSchema, setIncludeSchema] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [compress, setCompress] = useState(false);
  const [customFormat, setCustomFormat] = useState(false);

  const getExt = () => (driver === 'postgresql' && customFormat) ? '.dump' : '.sql';

  const [fileName, setFileName] = useState(() => `${database}_${formatTimestamp()}`);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputClass = 'w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const handleStart = async () => {
    setError(null);
    const outputDir = await openDialog({ directory: true, title: '选择备份目录' });
    if (!outputDir || Array.isArray(outputDir)) return;

    const outputPath = `${outputDir}/${fileName}${getExt()}`;
    setIsLoading(true);
    try {
      await invoke('backup_database', {
        params: {
          connection_id: connectionId,
          database,
          output_path: outputPath,
          include_schema: includeSchema,
          include_data: includeData,
          compress,
          custom_format: customFormat,
        },
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[480px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#253347]">
          <h3 className="text-white font-semibold">{t('backupWizard.title')}</h3>
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              {[1, 2].map((n) => (
                <div
                  key={n}
                  className={`w-2 h-2 rounded-full ${
                    n === step ? 'bg-[#009e84]' : n < step ? 'bg-[#00c9a7]' : 'bg-[#253347]'
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-gray-400">{t('backupWizard.step', { current: step, total: 2 })}</span>
            <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 min-h-[260px]">
          {step === 1 && (
            <div className="space-y-4">
              {/* 备份方式 */}
              <div>
                <label className={labelClass}>{t('backupWizard.backupMethod')}</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked readOnly className="accent-[#009e84]" />
                  <span className="text-sm text-white">{t('backupWizard.logicalBackup')}</span>
                </label>
              </div>

              {/* 选项 */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeSchema}
                    onChange={e => setIncludeSchema(e.target.checked)}
                    className="accent-[#009e84]"
                  />
                  <span className="text-sm text-white">{t('backupWizard.includeSchema')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeData}
                    onChange={e => setIncludeData(e.target.checked)}
                    className="accent-[#009e84]"
                  />
                  <span className="text-sm text-white">{t('backupWizard.includeData')}</span>
                </label>
                {driver === 'mysql' && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={compress}
                      onChange={e => setCompress(e.target.checked)}
                      className="accent-[#009e84]"
                    />
                    <span className="text-sm text-white">{t('backupWizard.compress')}</span>
                  </label>
                )}
                {driver === 'postgresql' && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={customFormat}
                      onChange={e => setCustomFormat(e.target.checked)}
                      className="accent-[#009e84]"
                    />
                    <span className="text-sm text-white">{t('backupWizard.customFormat')}</span>
                  </label>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              {/* 文件名输入 */}
              <div>
                <label className={labelClass}>{t('exportWizard.fileName')}</label>
                <div className="flex gap-2 items-center">
                  <input
                    value={fileName}
                    onChange={e => setFileName(e.target.value)}
                    className={`${inputClass} flex-1`}
                  />
                  <span className="text-sm text-gray-400 flex-shrink-0">{getExt()}</span>
                </div>
              </div>

              {/* 摘要 */}
              <div className="p-3 bg-[#1a2639] rounded border border-[#253347] text-sm text-gray-400 space-y-1">
                <div>{t('backupWizard.summaryDb', { db: database })}</div>
                <div>{t('backupWizard.summaryDriver', { driver: driver === 'mysql' ? 'MySQL' : 'PostgreSQL' })}</div>
                <div>{t('backupWizard.summaryMethod', { method: t('backupWizard.logicalBackup') })}</div>
              </div>

              {error && (
                <div className="text-sm text-red-400 bg-red-400/10 px-3 py-1.5 rounded border border-red-400/30">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#253347]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-[#1a2639] hover:bg-[#253347] text-white rounded transition-colors"
          >
            {t('backupWizard.cancel')}
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-[#1a2639] hover:bg-[#253347] border border-[#253347] rounded transition-colors"
              >
                <ChevronLeft size={14} /> {t('backupWizard.prev')}
              </button>
            )}
            {step < 2 ? (
              <button
                onClick={() => setStep(2)}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded transition-colors"
              >
                {t('backupWizard.next')}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={isLoading}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded transition-colors disabled:opacity-50"
              >
                <Database size={14} />
                {isLoading ? t('backupWizard.backing') : t('backupWizard.startBackup')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
