import React, { useState } from 'react';
import { useConnectionStore } from '../../store';
import type { CreateConnectionRequest } from '../../types';

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
      setTestResult('✓ 连接成功');
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

  const inputClass = 'w-full bg-[#2a2a2a] border border-[#3a3a3a] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#0078d4]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e1e] border border-[#3a3a3a] rounded-lg w-[480px] p-6">
        <h2 className="text-white font-semibold mb-4">{isEdit ? '编辑连接' : '新建连接'}</h2>

        <div className="space-y-3">
          <div>
            <label className={labelClass}>连接名称 *</label>
            <input className={inputClass} value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="我的 MySQL 数据库" />
          </div>

          <div>
            <label className={labelClass}>数据库类型</label>
            <select className={inputClass} value={form.driver}
              onChange={(e) => handleDriverChange(e.target.value)}>
              {DRIVERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelClass}>主机</label>
              <input className={inputClass} value={form.host ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
            </div>
            <div>
              <label className={labelClass}>端口</label>
              <input className={inputClass} type="number" value={form.port ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))} />
            </div>
          </div>

          <div>
            <label className={labelClass}>数据库名</label>
            <input className={inputClass} value={form.database_name ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, database_name: e.target.value }))} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>用户名</label>
              <input className={inputClass} value={form.username ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
            </div>
            <div>
              <label className={labelClass}>密码</label>
              <input className={inputClass} type="password" value={form.password ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder={isEdit ? '留空则不修改密码' : ''} />
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
            className="px-3 py-1.5 text-sm bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white rounded disabled:opacity-50">
            {testing ? '测试中...' : '测试连接'}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-3 py-1.5 text-sm bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white rounded">
              取消
            </button>
            <button onClick={handleSave} disabled={saving || !form.name.trim()}
              className="px-3 py-1.5 text-sm bg-[#0078d4] hover:bg-[#006bc2] text-white rounded disabled:opacity-50">
              {saving ? '保存中...' : isEdit ? '保存修改' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
