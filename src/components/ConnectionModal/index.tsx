import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FolderOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { useConnectionStore } from '../../store';
import type { CreateConnectionRequest } from '../../types';
import { PasswordInput } from '../common/PasswordInput';
import { DropdownSelect } from '../common/DropdownSelect';
import { useEscClose } from '../../hooks/useEscClose';

const DRIVERS = [
  { value: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { value: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'oracle', label: 'Oracle', defaultPort: 1521 },
  { value: 'sqlserver', label: 'SQL Server', defaultPort: 1433 },
  { value: 'sqlite', label: 'SQLite', defaultPort: null },
  { value: 'doris', label: 'Apache Doris', defaultPort: 9030 },
  { value: 'clickhouse', label: 'ClickHouse', defaultPort: 8123 },
  { value: 'tidb', label: 'TiDB', defaultPort: 4000 },
];

interface Props {
  onClose: () => void;
  onSuccess?: () => void;
  connection?: import('../../types').Connection;
  defaultGroupId?: number | null;
}

export function ConnectionModal({ onClose, onSuccess, connection, defaultGroupId }: Props) {
  const { t } = useTranslation();
  const { createConnection, testConnection, updateConnection } = useConnectionStore();
  const isEdit = !!connection;

  useEscClose(onClose);
  const [groups, setGroups] = useState<{ id: number; name: string }[]>([]);
  const [form, setForm] = useState<CreateConnectionRequest>({
    name: connection?.name ?? '',
    driver: connection?.driver ?? 'mysql',
    host: connection?.host ?? 'localhost',
    port: connection?.port ?? 3306,
    database_name: connection?.database_name ?? '',
    username: connection?.username ?? '',
    password: '',
    group_id: connection?.group_id ?? defaultGroupId ?? null,
    file_path: connection?.file_path ?? '',
  });

  const isSqlite = form.driver === 'sqlite';

  useEffect(() => {
    invoke<{ id: number; name: string }[]>('list_groups').then(setGroups).catch(() => {});
  }, []);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleDriverChange = (driver: string) => {
    const d = DRIVERS.find((x) => x.value === driver);
    setForm((f) => ({ ...f, driver, port: d?.defaultPort ?? f.port ?? undefined }));
  };

  const handleBrowseFile = async () => {
    const selected = await dialogOpen({
      multiple: false,
      filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'sqlite3', 'db'] }],
    });
    if (selected && typeof selected === 'string') {
      setForm((f) => ({ ...f, file_path: selected }));
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await testConnection(form);
      setTestResult(t('connectionModal.testSuccess'));
    } catch (e) {
      setTestResult(`✗ ${String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (isEdit && connection) {
        await updateConnection(connection.id, form);
      } else {
        await createConnection(form);
      }
      if (onSuccess) {
        onSuccess();
      } else {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[480px] p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-semibold">{isEdit ? t('connectionModal.editConnection') : t('connectionModal.newConnection')}</h2>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"><X size={16} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className={labelClass}>{t('connectionModal.connectionName')}</label>
            <input className={inputClass} value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t('connectionModal.namePlaceholder')} />
          </div>

          <div>
            <label className={labelClass}>{t('connectionModal.dbType')}</label>
            <DropdownSelect
              value={form.driver}
              options={DRIVERS.map(d => ({ value: d.value, label: d.label }))}
              onChange={handleDriverChange}
              className="w-full"
            />
          </div>

          {groups.length > 0 && (
            <div>
              <label className={labelClass}>{t('connectionModal.group')}</label>
              <DropdownSelect
                value={form.group_id != null ? String(form.group_id) : ''}
                options={[
                  { value: '', label: t('connectionModal.noGroup') },
                  ...groups.map(g => ({ value: String(g.id), label: g.name })),
                ]}
                onChange={(v) => setForm(f => ({ ...f, group_id: v ? Number(v) : null }))}
                className="w-full"
              />
            </div>
          )}

          {isSqlite ? (
            <div>
              <label className={labelClass}>{t('connectionModal.filePath')}</label>
              <div className="flex gap-2">
                <input
                  className={`${inputClass} flex-1`}
                  value={form.file_path ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, file_path: e.target.value }))}
                  placeholder={t('connectionModal.filePathPlaceholder')}
                />
                <button
                  type="button"
                  onClick={handleBrowseFile}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#1a2639] border border-[#253347] rounded hover:bg-[#253347] text-[#c8daea] transition-colors whitespace-nowrap"
                >
                  <FolderOpen size={14} />
                  {t('connectionModal.browse')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className={labelClass}>{t('connectionModal.host')}</label>
                  <input className={inputClass} value={form.host ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
                </div>
                <div>
                  <label className={labelClass}>{t('connectionModal.port')}</label>
                  <div className="flex items-stretch w-full border border-[#253347] rounded overflow-hidden focus-within:border-[#009e84] transition-colors">
                    <input
                      type="number"
                      value={form.port ?? ''}
                      onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))}
                      className="flex-1 min-w-0 bg-[#1a2639] px-3 py-1.5 text-sm text-white focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <div className="flex flex-col border-l border-[#253347] bg-[#1a2639]">
                      <button type="button" onClick={() => setForm(f => ({ ...f, port: Math.min(65535, (f.port ?? 0) + 1) }))}
                        className="flex-1 flex items-center justify-center px-1.5 text-[#00c9a7] hover:text-[#29edd0] hover:bg-[#1e2d42] transition-colors border-b border-[#253347]">
                        <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 0L8 5H0Z"/></svg>
                      </button>
                      <button type="button" onClick={() => setForm(f => ({ ...f, port: Math.max(1, (f.port ?? 1) - 1) }))}
                        className="flex-1 flex items-center justify-center px-1.5 text-[#00c9a7] hover:text-[#29edd0] hover:bg-[#1e2d42] transition-colors">
                        <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 5L0 0H8Z"/></svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <label className={labelClass}>{t('connectionModal.dbName')}</label>
                <input className={inputClass} value={form.database_name ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, database_name: e.target.value }))} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>{t('connectionModal.username')}</label>
                  <input className={inputClass} value={form.username ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
                </div>
                <div>
                  <label className={labelClass}>{t('connectionModal.password')}</label>
                  <PasswordInput
                    className={inputClass}
                    value={form.password ?? ''}
                    onChange={(v) => setForm((f) => ({ ...f, password: v }))}
                    placeholder={isEdit ? t('connectionModal.passwordPlaceholder') : ''}
                    onReveal={isEdit && connection ? () => invoke<string>('get_connection_password', { id: connection.id }) : undefined}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {testResult && (
          <p className={`mt-3 text-xs ${testResult.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
            {testResult}
          </p>
        )}

        <div className="flex justify-between mt-5">
          <button onClick={handleTest} disabled={testing}
            className="px-3 py-1.5 text-sm bg-[#1a2639] hover:bg-[#253347] text-white rounded disabled:opacity-50">
            {testing ? t('connectionModal.testing') : t('connectionModal.testConnection')}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-3 py-1.5 text-sm bg-[#1a2639] hover:bg-[#253347] text-white rounded">
              {t('connectionModal.cancel')}
            </button>
            <button onClick={handleSave} disabled={saving || !form.name.trim()}
              className="px-3 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded disabled:opacity-50">
              {saving ? t('connectionModal.saving') : isEdit ? t('connectionModal.saveChanges') : t('connectionModal.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
