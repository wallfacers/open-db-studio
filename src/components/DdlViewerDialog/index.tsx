import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X, Copy, Check } from 'lucide-react';
import { useEscClose } from '../../hooks/useEscClose';

interface Props {
  connectionId: number;
  tableName: string;
  database?: string;
  schema?: string;
  onClose: () => void;
}

export const DdlViewerDialog: React.FC<Props> = ({
  connectionId, tableName, database, schema, onClose
}) => {
  const { t } = useTranslation();
  const [ddl, setDdl] = useState('');
  const [copied, setCopied] = useState(false);

  useEscClose(onClose);

  useEffect(() => {
    invoke<string>('get_table_ddl', {
      connectionId,
      table: tableName,
      database: database ?? null,
      schema: schema ?? null,
    }).then(setDdl).catch(() => setDdl('-- Failed to load DDL'));
  }, [connectionId, tableName, database, schema]);

  const handleCopy = () => {
    navigator.clipboard.writeText(ddl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[640px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[#1e2d42]">
          <span className="text-[#c8daea] text-sm font-medium">
            {t('ddlViewer.title')} — {tableName}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] bg-[#1a2639] rounded"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? t('ddlViewer.copied') : t('ddlViewer.copy')}
            </button>
            <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]">
              <X size={16} />
            </button>
          </div>
        </div>
        <textarea
          readOnly
          className="flex-1 m-4 bg-[#0d1520] border border-[#1e2d42] rounded p-3 font-mono text-xs text-[#c8daea] outline-none resize-none min-h-[300px]"
          value={ddl}
          spellCheck={false}
        />
      </div>
    </div>
  );
};
