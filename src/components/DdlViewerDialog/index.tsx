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
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-background-panel border border-border-strong rounded-lg w-[640px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border-default">
          <span className="text-foreground-default text-sm font-medium">
            {t('ddlViewer.title')} — {tableName}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 text-xs text-foreground-muted hover:text-foreground-default bg-background-hover rounded transition-colors duration-200"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? t('ddlViewer.copied') : t('ddlViewer.copy')}
            </button>
            <button onClick={onClose} className="text-foreground-muted hover:text-foreground-default transition-colors duration-200">
              <X size={16} />
            </button>
          </div>
        </div>
        <textarea
          readOnly
          className="flex-1 m-4 bg-background-base border border-border-default rounded p-3 font-mono text-xs text-foreground-default outline-none resize-none min-h-[300px]"
          value={ddl}
          spellCheck={false}
        />
      </div>
    </div>
  );
};
