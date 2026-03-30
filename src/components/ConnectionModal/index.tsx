import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FolderOpen, Link, ChevronDown, ChevronRight, Shield, Lock } from 'lucide-react';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
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
  { value: 'gaussdb', label: 'GaussDB', defaultPort: 8000 },
  { value: 'db2', label: 'IBM DB2', defaultPort: 50000 },
];

const AUTH_SUPPORT: Record<string, string[]> = {
  mysql: ['password', 'ssl_cert', 'os_native'],
  doris: ['password', 'ssl_cert', 'os_native'],
  tidb: ['password', 'ssl_cert', 'os_native'],
  postgres: ['password', 'ssl_cert', 'os_native'],
  gaussdb: ['password', 'ssl_cert', 'os_native'],
  sqlite: ['os_native'],
  oracle: ['password', 'os_native'],
  sqlserver: ['password', 'ssl_cert', 'os_native'],
  clickhouse: ['password', 'ssl_cert', 'token'],
  db2: ['password', 'os_native'],
};

const SSL_MODES = ['disable', 'prefer', 'require', 'verify_ca', 'verify_full'];

function getDefaultAuthType(driver: string): string {
  const supported = AUTH_SUPPORT[driver] ?? ['password'];
  return supported[0];
}

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
    auth_type: connection?.auth_type ?? getDefaultAuthType(connection?.driver ?? 'mysql'),
    token: '',
    ssl_mode: connection?.ssl_mode ?? '',
    ssl_ca_path: connection?.ssl_ca_path ?? '',
    ssl_cert_path: connection?.ssl_cert_path ?? '',
    ssl_key_path: connection?.ssl_key_path ?? '',
    connect_timeout_secs: connection?.connect_timeout_secs ?? undefined,
    read_timeout_secs: connection?.read_timeout_secs ?? undefined,
    pool_max_connections: connection?.pool_max_connections ?? undefined,
    pool_idle_timeout_secs: connection?.pool_idle_timeout_secs ?? undefined,
  });

  const isSqlite = form.driver === 'sqlite';
  const supportedAuthTypes = AUTH_SUPPORT[form.driver] ?? ['password'];
  const showSslSection = form.auth_type === 'ssl_cert' || (form.ssl_mode != null && form.ssl_mode !== '' && form.ssl_mode !== 'disable');
  const showUsernamePassword = form.auth_type === 'password' || form.auth_type === 'ssl_cert';
  const showTokenField = form.auth_type === 'token';

  type ClipboardConn = {
    _odb: number; driver: string; name?: string; host?: string; port?: number;
    database_name?: string; username?: string; password?: string;
    file_path?: string; extra_params?: string;
  };
  const [clipboardConn, setClipboardConn] = useState<ClipboardConn | null>(null);

  useEffect(() => {
    invoke<{ id: number; name: string }[]>('list_groups').then(setGroups).catch(() => {});
  }, []);

  // 新建模式：mount 时检测剪贴板
  useEffect(() => {
    if (isEdit) return;
    (async () => {
      try {
        const text = await readText();
        const parsed = JSON.parse(text);
        if (
          parsed && typeof parsed === 'object' &&
          parsed._odb === 1 &&
          typeof parsed.driver === 'string' && parsed.driver.length > 0 &&
          DRIVERS.some(d => d.value === parsed.driver)
        ) {
          setClipboardConn(parsed as ClipboardConn);
        }
      } catch {
        // 静默忽略
      }
    })();
  }, []);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleDriverChange = (driver: string) => {
    const d = DRIVERS.find((x) => x.value === driver);
    const supported = AUTH_SUPPORT[driver] ?? ['password'];
    const currentAuthValid = supported.includes(form.auth_type ?? '');
    setForm((f) => ({
      ...f,
      driver,
      port: d?.defaultPort ?? f.port ?? undefined,
      auth_type: currentAuthValid ? f.auth_type : supported[0],
    }));
  };

  const handleAuthTypeChange = (authType: string) => {
    setForm((f) => ({ ...f, auth_type: authType }));
  };

  const handleImportFromClipboard = () => {
    if (!clipboardConn) return;
    const conn = clipboardConn;
    setForm(f => ({
      ...f,
      driver: conn.driver,
      name: conn.name ?? f.name,
      host: conn.host ?? '',
      port: conn.port ?? DRIVERS.find(d => d.value === conn.driver)?.defaultPort ?? undefined,
      database_name: conn.database_name ?? '',
      username: conn.username ?? '',
      password: conn.password ?? '',
      file_path: conn.file_path ?? '',
      extra_params: conn.extra_params ?? '',
    }));
    setClipboardConn(null);
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

  const handleBrowseSslFile = async (field: 'ssl_ca_path' | 'ssl_cert_path' | 'ssl_key_path') => {
    const selected = await dialogOpen({
      multiple: false,
      filters: [{ name: 'Certificate', extensions: ['pem', 'crt', 'key', 'p12'] }],
    });
    if (selected && typeof selected === 'string') {
      setForm((f) => ({ ...f, [field]: selected }));
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // 编辑模式且密码未修改时，直接用已保存连接 ID 测试（避免空密码认证失败）
      if (isEdit && connection?.id && !form.password) {
        await invoke('test_connection_by_id', { connectionId: connection.id });
      } else {
        await testConnection(form);
      }
      setTestResult(t('connectionModal.testSuccess'));
    } catch (e) {
      setTestResult(`✗ ${String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    const driverLabel = DRIVERS.find(d => d.value === form.driver)?.label ?? form.driver;
    const finalForm = form.name.trim()
      ? form
      : { ...form, name: t('connectionModal.defaultName', { driver: driverLabel }) };
    try {
      if (isEdit && connection) {
        await updateConnection(connection.id, finalForm);
      } else {
        await createConnection(finalForm);
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

  const AUTH_TYPE_LABELS: Record<string, string> = {
    password: t('connectionModal.authPassword'),
    ssl_cert: t('connectionModal.authSslCert'),
    os_native: t('connectionModal.authOsNative'),
    token: t('connectionModal.authToken'),
  };

  const inputClass = 'w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';
  const sectionLabelClass = 'flex items-center gap-1.5 text-xs font-medium text-[#7a9bb8] mb-2';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[520px] p-6 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-semibold">{isEdit ? t('connectionModal.editConnection') : t('connectionModal.newConnection')}</h2>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"><X size={16} /></button>
        </div>

        {clipboardConn && (
          <div className="bg-[#0d2137] border border-[#00c9a7]/40 rounded px-3 py-2 flex items-center gap-2 mb-4 text-sm">
            <Link size={14} className="text-[#00c9a7] flex-shrink-0" />
            <span className="text-[#b5cfe8]">{t('connectionModal.importBannerTitle')}（</span>
            <span className="text-[#c8daea] font-medium">
              {clipboardConn.name || t('connectionModal.importBannerUnnamed')} · {DRIVERS.find(d => d.value === clipboardConn.driver)?.label ?? clipboardConn.driver}
            </span>
            <span className="text-[#b5cfe8]">）</span>
            <button
              type="button"
              onClick={handleImportFromClipboard}
              className="text-[#00c9a7] hover:underline cursor-pointer ml-auto"
            >
              {t('connectionModal.importBannerImport')}
            </button>
            <button
              type="button"
              onClick={() => setClipboardConn(null)}
              aria-label={t('connectionModal.importBannerClose')}
              className="text-[#7a9bb8] hover:text-[#c8daea] cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="space-y-3">
          {/* ── Basic Info ── */}
          <div>
            <label className={labelClass}>{t('connectionModal.connectionName')}</label>
            <input className={inputClass} value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t('connectionModal.namePlaceholder', { driver: DRIVERS.find(d => d.value === form.driver)?.label ?? form.driver })} />
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

              {/* ── Auth Type Section ── */}
              <div className="border-t border-[#253347] pt-3 mt-1">
                <div className={sectionLabelClass}>
                  <Shield size={12} />
                  {t('connectionModal.authType')}
                </div>
                <div className="flex flex-wrap gap-3">
                  {supportedAuthTypes.map((authType) => (
                    <label key={authType} className="flex items-center gap-1.5 text-sm text-[#c8daea] cursor-pointer">
                      <input
                        type="radio"
                        name="auth_type"
                        value={authType}
                        checked={form.auth_type === authType}
                        onChange={() => handleAuthTypeChange(authType)}
                        className="accent-[#009e84]"
                      />
                      {AUTH_TYPE_LABELS[authType] ?? authType}
                    </label>
                  ))}
                </div>
              </div>

              {/* Username/Password fields (shown for password & ssl_cert auth) */}
              {showUsernamePassword && (
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
              )}

              {/* Token field (shown for token auth, e.g. ClickHouse) */}
              {showTokenField && (
                <div>
                  <label className={labelClass}>{t('connectionModal.token')}</label>
                  <PasswordInput
                    className={inputClass}
                    value={form.token ?? ''}
                    onChange={(v) => setForm((f) => ({ ...f, token: v }))}
                    placeholder={t('connectionModal.tokenPlaceholder')}
                    onReveal={isEdit && connection ? () => invoke<string>('get_connection_token', { id: connection.id }) : undefined}
                  />
                </div>
              )}

              {/* ── SSL/TLS Section ── */}
              {showSslSection && (
                <div className="border-t border-[#253347] pt-3 mt-1">
                  <div className={sectionLabelClass}>
                    <Lock size={12} />
                    {t('connectionModal.sslSettings')}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className={labelClass}>{t('connectionModal.sslMode')}</label>
                      <DropdownSelect
                        value={form.ssl_mode ?? 'disable'}
                        options={SSL_MODES.map(m => ({ value: m, label: m }))}
                        onChange={(v) => setForm(f => ({ ...f, ssl_mode: v }))}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className={labelClass}>{t('connectionModal.sslCaPath')}</label>
                      <div className="flex gap-2">
                        <input
                          className={`${inputClass} flex-1`}
                          value={form.ssl_ca_path ?? ''}
                          onChange={(e) => setForm((f) => ({ ...f, ssl_ca_path: e.target.value }))}
                          placeholder={t('connectionModal.selectFile')}
                        />
                        <button
                          type="button"
                          onClick={() => handleBrowseSslFile('ssl_ca_path')}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#1a2639] border border-[#253347] rounded hover:bg-[#253347] text-[#c8daea] transition-colors whitespace-nowrap"
                        >
                          <FolderOpen size={14} />
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className={labelClass}>{t('connectionModal.sslCertPath')}</label>
                      <div className="flex gap-2">
                        <input
                          className={`${inputClass} flex-1`}
                          value={form.ssl_cert_path ?? ''}
                          onChange={(e) => setForm((f) => ({ ...f, ssl_cert_path: e.target.value }))}
                          placeholder={t('connectionModal.selectFile')}
                        />
                        <button
                          type="button"
                          onClick={() => handleBrowseSslFile('ssl_cert_path')}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#1a2639] border border-[#253347] rounded hover:bg-[#253347] text-[#c8daea] transition-colors whitespace-nowrap"
                        >
                          <FolderOpen size={14} />
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className={labelClass}>{t('connectionModal.sslKeyPath')}</label>
                      <div className="flex gap-2">
                        <input
                          className={`${inputClass} flex-1`}
                          value={form.ssl_key_path ?? ''}
                          onChange={(e) => setForm((f) => ({ ...f, ssl_key_path: e.target.value }))}
                          placeholder={t('connectionModal.selectFile')}
                        />
                        <button
                          type="button"
                          onClick={() => handleBrowseSslFile('ssl_key_path')}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-[#1a2639] border border-[#253347] rounded hover:bg-[#253347] text-[#c8daea] transition-colors whitespace-nowrap"
                        >
                          <FolderOpen size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Advanced Settings (collapsible) ── */}
              <div className="border-t border-[#253347] pt-3 mt-1">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                  className="flex items-center gap-1.5 text-xs font-medium text-[#7a9bb8] hover:text-[#c8daea] transition-colors mb-2"
                >
                  {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {t('connectionModal.advancedSettings')}
                </button>
                {advancedOpen && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>{t('connectionModal.connectTimeout')}</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={form.connect_timeout_secs ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, connect_timeout_secs: e.target.value ? Number(e.target.value) : undefined }))}
                        placeholder="30"
                      />
                    </div>
                    <div>
                      <label className={labelClass}>{t('connectionModal.readTimeout')}</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={form.read_timeout_secs ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, read_timeout_secs: e.target.value ? Number(e.target.value) : undefined }))}
                        placeholder="60"
                      />
                    </div>
                    <div>
                      <label className={labelClass}>{t('connectionModal.poolMaxConnections')}</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={form.pool_max_connections ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, pool_max_connections: e.target.value ? Number(e.target.value) : undefined }))}
                        placeholder="5"
                      />
                    </div>
                    <div>
                      <label className={labelClass}>{t('connectionModal.poolIdleTimeout')}</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={form.pool_idle_timeout_secs ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, pool_idle_timeout_secs: e.target.value ? Number(e.target.value) : undefined }))}
                        placeholder="300"
                      />
                    </div>
                  </div>
                )}
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
            <button onClick={handleSave} disabled={saving}
              className="px-3 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded disabled:opacity-50">
              {saving ? t('connectionModal.saving') : isEdit ? t('connectionModal.saveChanges') : t('connectionModal.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
