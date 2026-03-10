import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { PasswordInput } from '../common/PasswordInput';
import { useAiStore } from '../../store';
import type { LlmSettings } from '../../types';

type TestStatus = 'idle' | 'testing' | 'success' | 'fail';

export function LlmSettingsPanel() {
  const { t } = useTranslation();
  const { settings, loadSettings, saveSettings } = useAiStore();
  const [form, setForm] = useState<LlmSettings>({
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveSettings(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTestStatus('testing');
    setTestError(null);
    try {
      await invoke('test_llm_connection', { settings: form });
      setTestStatus('success');
      setTimeout(() => setTestStatus('idle'), 3000);
    } catch (e) {
      setTestStatus('fail');
      setTestError(String(e));
    }
  };

  const inputClass = 'w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div className="w-full max-w-lg">
      <div className="p-8 space-y-4">
        <h3 className="text-white font-semibold text-sm border-b border-[#1e2d42] pb-2">{t('llmSettings.aiModelConfig')}</h3>

        <div>
          <label className={labelClass}>{t('llmSettings.apiKey')}</label>
          <PasswordInput
            className={inputClass}
            value={form.api_key}
            onChange={(v) => setForm((f) => ({ ...f, api_key: v }))}
            placeholder="sk-..."
          />
        </div>

        <div>
          <label className={labelClass}>{t('llmSettings.baseUrl')}</label>
          <input
            className={inputClass}
            value={form.base_url}
            onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
            placeholder="https://api.openai.com/v1"
          />
        </div>

        <div>
          <label className={labelClass}>{t('llmSettings.model')}</label>
          <input
            className={inputClass}
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            placeholder="gpt-4o-mini"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleTest}
            disabled={testStatus === 'testing' || !form.api_key}
            className="px-4 py-1.5 text-sm border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded disabled:opacity-50 flex items-center gap-1.5"
          >
            {testStatus === 'testing' && <Loader2 size={13} className="animate-spin" />}
            {testStatus === 'success' && <CheckCircle size={13} className="text-green-400" />}
            {testStatus === 'fail' && <XCircle size={13} className="text-red-400" />}
            {testStatus === 'testing' ? t('llmSettings.testing') : t('llmSettings.testConnection')}
          </button>

          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded disabled:opacity-50"
          >
            {saved ? t('llmSettings.saved') : saving ? t('llmSettings.saving') : t('llmSettings.save')}
          </button>
        </div>

        {testStatus === 'success' && (
          <p className="text-xs text-green-400 flex items-center gap-1">
            <CheckCircle size={12} /> {t('llmSettings.testSuccess')}
          </p>
        )}
        {testStatus === 'fail' && testError && (
          <p className="text-xs text-red-400 flex items-center gap-1 break-all">
            <XCircle size={12} className="flex-shrink-0" /> {testError}
          </p>
        )}

        <p className="text-xs text-[#7a9bb8] pt-2">
          {t('llmSettings.supportInfo')}
        </p>
      </div>
    </div>
  );
}
