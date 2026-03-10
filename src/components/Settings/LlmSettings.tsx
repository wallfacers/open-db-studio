import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAiStore } from '../../store';
import type { LlmSettings } from '../../types';

export function LlmSettingsPanel() {
  const { t } = useTranslation();
  const { settings, loadSettings, saveSettings } = useAiStore();
  const [form, setForm] = useState<LlmSettings>({
    api_key: '',
    base_url: 'https://api.openai.com',
    model: 'gpt-4o-mini',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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

  const inputClass = 'w-full bg-[#2a2a2a] border border-[#3a3a3a] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#0078d4]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 space-y-4 max-w-lg">
        <h3 className="text-white font-semibold text-sm border-b border-[#2b2b2b] pb-2">{t('llmSettings.aiModelConfig')}</h3>

        <div>
          <label className={labelClass}>{t('llmSettings.apiKey')}</label>
          <input
            className={inputClass}
            type="password"
            value={form.api_key}
            onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
            placeholder="sk-..."
          />
        </div>

        <div>
          <label className={labelClass}>{t('llmSettings.baseUrl')}</label>
          <input
            className={inputClass}
            value={form.base_url}
            onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
            placeholder="https://api.openai.com"
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

        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 text-sm bg-[#0078d4] hover:bg-[#006bc2] text-white rounded disabled:opacity-50"
        >
          {saved ? t('llmSettings.saved') : saving ? t('llmSettings.saving') : t('llmSettings.save')}
        </button>

        <p className="text-xs text-[#858585] pt-2">
          {t('llmSettings.supportInfo')}
        </p>
      </div>
    </div>
  );
}
