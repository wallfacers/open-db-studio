// src/components/DatabaseManager/CreateDatabaseDialog.tsx
import React, { useState } from 'react';
import { X, Database } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { DropdownSelect } from '../common/DropdownSelect';

interface Props {
  connectionId: number;
  driver: string;  // 'mysql' | 'postgres' | 'sqlite'
  onClose: () => void;
  onSuccess: (dbName: string, switchTo: boolean) => void;
}

export const CreateDatabaseDialog: React.FC<Props> = ({
  connectionId,
  driver,
  onClose,
  onSuccess,
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [charset, setCharset] = useState('utf8mb4');
  const [collation, setCollation] = useState('utf8mb4_unicode_ci');
  const [pgEncoding, setPgEncoding] = useState('UTF8');
  const [defaultSchema, setDefaultSchema] = useState('public');
  const [switchAfterCreate, setSwitchAfterCreate] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) {
      setError(t('createDatabase.dbNameRequired'));
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      await invoke('create_database', {
        connectionId,
        name: name.trim(),
        options: {
          charset: driver === 'mysql' ? charset : null,
          collation: driver === 'mysql' ? collation : null,
          encoding: driver === 'postgres' ? pgEncoding : null,
          default_schema: driver === 'postgres' ? defaultSchema : null,
          tablespace: null,
        },
      });
      onSuccess(name.trim(), switchAfterCreate);
      onClose();
    } catch (e: any) {
      setError(e?.toString() ?? '创建失败');
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass = 'w-full bg-background-hover border border-border-strong rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-border-focus';
  const labelClass = 'block text-xs text-foreground-muted mb-1';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-background-panel border border-border-strong rounded-lg w-[400px] p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Database size={14} className="text-accent" />
            <h3 className="text-foreground font-semibold">{t('createDatabase.title')}</h3>
          </div>
          <button onClick={onClose} className="text-foreground-muted hover:text-foreground-default transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className={labelClass}>
              {t('createDatabase.dbName')} <span className="text-error">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder={t('createDatabase.dbNamePlaceholder')}
              className={inputClass}
              autoFocus
            />
          </div>

          {driver === 'mysql' && (
            <>
              <div>
                <label className={labelClass}>{t('createDatabase.charset')}</label>
                <DropdownSelect
                  value={charset}
                  options={[
                    { value: 'utf8mb4', label: 'UTF-8 (utf8mb4，推荐)' },
                    { value: 'utf8', label: 'UTF-8 (utf8)' },
                    { value: 'latin1', label: 'Latin1' },
                    { value: 'gbk', label: 'GBK' },
                  ]}
                  onChange={setCharset}
                  className="w-full"
                />
              </div>
              <div>
                <label className={labelClass}>{t('createDatabase.collation')}</label>
                <DropdownSelect
                  value={collation}
                  options={[
                    { value: 'utf8mb4_unicode_ci', label: 'utf8mb4_unicode_ci（推荐）' },
                    { value: 'utf8mb4_general_ci', label: 'utf8mb4_general_ci' },
                    { value: 'utf8mb4_0900_ai_ci', label: 'utf8mb4_0900_ai_ci' },
                  ]}
                  onChange={setCollation}
                  className="w-full"
                />
              </div>
            </>
          )}

          {driver === 'postgres' && (
            <>
              <div>
                <label className={labelClass}>{t('createDatabase.encoding')}</label>
                <DropdownSelect
                  value={pgEncoding}
                  options={[
                    { value: 'UTF8', label: 'UTF-8（推荐）' },
                    { value: 'SQL_ASCII', label: 'SQL_ASCII' },
                    { value: 'LATIN1', label: 'LATIN1' },
                    { value: 'GBK', label: 'GBK' },
                  ]}
                  onChange={setPgEncoding}
                  className="w-full"
                />
              </div>
              <div>
                <label className={labelClass}>{t('createDatabase.defaultSchema')}</label>
                <input
                  value={defaultSchema}
                  onChange={(e) => setDefaultSchema(e.target.value)}
                  placeholder="public"
                  className={inputClass}
                />
              </div>
            </>
          )}

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={switchAfterCreate}
              onChange={(e) => setSwitchAfterCreate(e.target.checked)}
              className="accent-accent"
            />
            <span className="text-sm text-foreground">{t('createDatabase.switchAfterCreate')}</span>
          </label>

          {error && (
            <div className="text-sm text-error bg-error-subtle px-3 py-1.5 rounded border border-error/30">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-background-hover hover:bg-border-strong text-foreground rounded transition-colors duration-200"
          >
            {t('createDatabase.cancel')}
          </button>
          <button
            onClick={handleCreate}
            disabled={isLoading || !name.trim()}
            className="px-3 py-1.5 text-sm bg-accent hover:bg-accent-hover text-foreground rounded disabled:opacity-50 transition-colors duration-200"
          >
            {isLoading ? t('createDatabase.creating') : t('createDatabase.create')}
          </button>
        </div>
      </div>
    </div>
  );
};
