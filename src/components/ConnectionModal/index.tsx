import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConnectionStore } from '../../store';
import type { CreateConnectionRequest } from '../../types';
import { PasswordInput } from '../common/PasswordInput';

const DRIVERS = [
  { value: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { value: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'oracle', label: 'Oracle', defaultPort: 1521 },
  { value: 'sqlserver', label: 'SQL Server', defaultPort: 1433 },
];

interface Props {
  onClose: () => void;
  connection?: import('../../types').Connection;
}

export function ConnectionModal({ onClose, connection }: Props) {
  const { t } = useTranslation();
  const { createConnection, testConnection, updateConnection } = useConnectionStore();
  const isEdit = !!connection;
  const [form, setForm] = useState<CreateConnectionRequest>({
    name: connection?.name ?? '',
    driver: connection?.driver ?? 'mysql',
    host: connection?.host ?? 'localhost',
    port: connection?.port ?? 3306,
    database_name: connection?.database_name ?? '',
    username: connection?.username ?? '',
    password: '',
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleDriverChange = (driver: string) => {
    const d = DRIVERS.find((x) => x.value === driver);
    setForm((f) => ({ ...f, driver, port: d?.defaultPort ?? f.port }));
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
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[480px] p-6">
        <h2 className="text-white font-semibold mb-4">{isEdit ? t('connectionModal.editConnection') : t('connectionModal.newConnection')}</h2>

        <div className="space-y-3">
          <div>
            <label className={labelClass}>{t('connectionModal.connectionName')}</label>
            <input className={inputClass} value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t('connectionModal.namePlaceholder')} />
          </div>

          <div>
            <label className={labelClass}>{t('connectionModal.dbType')}</label>
            <select className={inputClass} value={form.driver}
              onChange={(e) => handleDriverChange(e.target.value)}>
              {DRIVERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelClass}>{t('connectionModal.host')}</label>
              <input className={inputClass} value={form.host ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
            </div>
            <div>
              <label className={labelClass}>{t('connectionModal.port')}</label>
              <input className={inputClass} type="number" value={form.port ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))} />
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
              />
            </div>
          </div>
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
