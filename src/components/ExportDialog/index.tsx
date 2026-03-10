import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface Props {
  connectionId: number;
  tableName: string;
  onClose: () => void;
  showToast: (msg: string) => void;
}

export const ExportDialog: React.FC<Props> = ({ connectionId, tableName, onClose, showToast }) => {
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
          table: tableName,
          format,
          where_clause: whereClause || null,
          output_path: path,
        }
      });
      showToast(t('export.success', { path }));
      onClose();
    } catch (e) {
      showToast(String(e));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg w-96 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm text-[#d4d4d4] font-medium">{t('export.title', { table: tableName })}</h3>
          <button onClick={onClose} className="text-[#858585] hover:text-[#d4d4d4]"><X size={16}/></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-[#858585] mb-1 block">{t('export.format')}</label>
            <div className="flex gap-2">
              {(['csv', 'json', 'sql'] as const).map(f => (
                <button key={f} onClick={() => setFormat(f)}
                  className={`px-3 py-1 text-xs rounded ${format === f ? 'bg-[#3794ff] text-white' : 'bg-[#2b2b2b] text-[#858585]'}`}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-[#858585] mb-1 block">WHERE ({t('export.optional')})</label>
            <input
              className="w-full bg-[#141414] border border-[#2b2b2b] rounded px-2 py-1.5 text-xs text-[#d4d4d4] outline-none"
              placeholder="id > 100"
              value={whereClause}
              onChange={e => setWhereClause(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 bg-[#2b2b2b] text-[#858585] text-xs rounded">{t('common.cancel')}</button>
          <button onClick={handleExport} disabled={isExporting}
            className="px-3 py-1.5 bg-[#3794ff] text-white text-xs rounded disabled:opacity-50">
            {isExporting ? t('export.exporting') : t('export.export')}
          </button>
        </div>
      </div>
    </div>
  );
};
