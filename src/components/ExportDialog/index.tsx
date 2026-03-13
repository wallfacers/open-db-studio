import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { ToastLevel } from '../Toast';

interface Props {
  connectionId: number;
  database?: string;
  tableName: string;
  schema?: string;
  onClose: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}

export const ExportDialog: React.FC<Props> = ({ connectionId, database, tableName, schema, onClose, showToast }) => {
  const { t } = useTranslation();
  const [format, setFormat] = useState<'csv' | 'json' | 'sql'>('csv');
  const [whereClause, setWhereClause] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    const path = await save({
      defaultPath: `${tableName}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;

    setIsExporting(true);
    try {
      await invoke('export_table_data', {
        params: {
          connection_id: connectionId,
          database: database || null,
          table: tableName,
          schema: schema || null,
          format,
          where_clause: whereClause || null,
          output_path: path,
        }
      });
      showToast(t('export.success', { path }), 'success');
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-96 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold">{t('export.title', { table: tableName })}</h3>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"><X size={16}/></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">{t('export.format')}</label>
            <div className="flex gap-2">
              {(['csv', 'json', 'sql'] as const).map(f => (
                <button key={f} onClick={() => setFormat(f)}
                  className={`px-3 py-1.5 text-sm rounded ${format === f ? 'bg-[#009e84] text-white' : 'bg-[#1a2639] hover:bg-[#253347] text-white'}`}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">WHERE ({t('export.optional')})</label>
            <input
              className="w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]"
              placeholder="id > 100"
              value={whereClause}
              onChange={e => setWhereClause(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 text-sm bg-[#1a2639] hover:bg-[#253347] text-white rounded">{t('common.cancel')}</button>
          <button onClick={handleExport} disabled={isExporting}
            className="px-3 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded disabled:opacity-50">
            {isExporting ? t('export.exporting') : t('export.export')}
          </button>
        </div>
      </div>
    </div>
  );
};
