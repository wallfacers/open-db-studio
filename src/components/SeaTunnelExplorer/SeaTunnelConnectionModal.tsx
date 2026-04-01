import React, { useState, useRef, useEffect } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';

interface ConnectionData {
  id: number;
  name: string;
  url: string;
}

interface SeaTunnelConnectionModalProps {
  mode: 'create' | 'edit';
  connection?: ConnectionData;
  onClose: () => void;
  onSave: () => void;
}

export function SeaTunnelConnectionModal({
  mode,
  connection,
  onClose,
  onSave,
}: SeaTunnelConnectionModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(connection?.name ?? '');
  const [url, setUrl] = useState(connection?.url ?? '');
  const [authToken, setAuthToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) {
      setError(t('seaTunnel.connectionModal.nameRequired'));
      return;
    }
    if (!trimmedUrl) {
      setError(t('seaTunnel.connectionModal.urlRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === 'create') {
        await invoke('create_st_connection', {
          name: trimmedName,
          url: trimmedUrl,
          authToken: authToken.trim() || null,
        });
      } else if (connection) {
        await invoke('update_st_connection', {
          id: connection.id,
          name: trimmedName,
          url: trimmedUrl,
          authToken: authToken.trim() || null,
        });
      }
      onSave();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? t('seaTunnel.connectionModal.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setTestResult({ ok: false, msg: t('seaTunnel.connectionModal.urlRequired') });
      return;
    }
    setTesting(true);
    try {
      await invoke('test_st_connection', {
        url: trimmedUrl,
        authToken: authToken.trim() || null,
      });
      setTestResult({ ok: true, msg: t('seaTunnel.connectionModal.testSuccess') });
    } catch (err: any) {
      setTestResult({
        ok: false,
        msg: t('seaTunnel.connectionModal.testFailed', { error: err?.message ?? String(err) }),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const title = t(mode === 'create' ? 'seaTunnel.connectionModal.newTitle' : 'seaTunnel.connectionModal.editTitle');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-[var(--background-panel)] border border-[var(--border-strong)] rounded-lg shadow-2xl w-96"
        onKeyDown={handleKeyDown}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-strong)]">
          <span className="text-sm font-medium text-[var(--foreground-default)]">{title}</span>
          <button
            className="text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] transition-colors"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* 名称 */}
          <div>
            <label className="block text-xs text-[var(--foreground-muted)] mb-1">
              {t('seaTunnel.connectionModal.connectionName')} <span className="text-red-400">*</span>
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('seaTunnel.connectionModal.namePlaceholder')}
              className="w-full bg-[var(--background-base)] border border-[var(--border-strong)] rounded px-3 py-1.5 text-sm text-[var(--foreground-default)] placeholder-[var(--foreground-muted)] outline-none focus:border-[var(--accent)] transition-colors"
            />
          </div>

          {/* 集群地址 */}
          <div>
            <label className="block text-xs text-[var(--foreground-muted)] mb-1">
              {t('seaTunnel.connectionModal.clusterUrl')} <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder={t('seaTunnel.connectionModal.urlPlaceholder')}
              className="w-full bg-[var(--background-base)] border border-[var(--border-strong)] rounded px-3 py-1.5 text-sm text-[var(--foreground-default)] placeholder-[var(--foreground-muted)] outline-none focus:border-[var(--accent)] transition-colors"
            />
          </div>

          {/* Auth Token（可选） */}
          <div>
            <label className="block text-xs text-[var(--foreground-muted)] mb-1">
              Auth Token <span className="text-[var(--foreground-muted)]">({t('seaTunnel.connectionModal.optional')})</span>
            </label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={authToken}
                onChange={e => setAuthToken(e.target.value)}
                placeholder={t('seaTunnel.connectionModal.tokenPlaceholder')}
                className="w-full bg-[var(--background-base)] border border-[var(--border-strong)] rounded px-3 py-1.5 pr-9 text-sm text-[var(--foreground-default)] placeholder-[var(--foreground-muted)] outline-none focus:border-[var(--accent)] transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowToken(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] transition-colors"
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded px-3 py-2">
              {error}
            </div>
          )}

          {testResult && (
            <div className={`text-xs rounded px-3 py-2 ${testResult.ok ? 'text-[var(--accent)] bg-[var(--accent)]/10 border border-[var(--accent)]/30' : 'text-red-400 bg-red-900/20 border border-red-900/40'}`}>
              {testResult.msg}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing}
              className="px-3 py-1.5 text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] border border-[var(--border-strong)] rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testing ? t('seaTunnel.connectionModal.testing') : t('seaTunnel.connectionModal.testConnection')}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] border border-[var(--border-strong)] rounded transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-3 py-1.5 text-xs text-[var(--background-base)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
