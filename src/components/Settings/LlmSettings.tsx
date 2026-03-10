import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { PasswordInput } from '../common/PasswordInput';
import { useAiStore } from '../../store';
import type { LlmSettings, ApiType } from '../../types';

type TestStatus = 'idle' | 'testing' | 'success' | 'fail';

interface ProviderPreset {
  id: string;
  labelKey: string;
  base_url: string;
  api_type: ApiType;
  default_model: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'alicloud',
    labelKey: 'llmSettings.alicloud',
    base_url: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    api_type: 'anthropic',
    default_model: 'qwen3.5-plus',
  },
];

export function LlmSettingsPanel() {
  const { t } = useTranslation();
  const { settings, loadSettings, saveSettings } = useAiStore();
  const [form, setForm] = useState<LlmSettings>({
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    api_type: 'openai',
    preset: null,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    if (settings) {
      setForm({
        ...settings,
        api_type: settings.api_type ?? 'openai',
        preset: settings.preset ?? null,
      });
    }
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

  const handlePresetSelect = (preset: ProviderPreset | null) => {
    if (preset === null) {
      setForm((f) => ({ ...f, preset: null }));
    } else {
      setForm((f) => ({
        ...f,
        preset: preset.id,
        base_url: preset.base_url,
        api_type: preset.api_type,
        model: preset.default_model,
      }));
    }
  };

  const handleFieldChange = <K extends keyof LlmSettings>(key: K, value: LlmSettings[K]) => {
    // 修改 base_url 或 api_type 才视为切换到自定义，修改 model/api_key 保留预设标记
    const resetsPreset = key === 'base_url' || key === 'api_type';
    setForm((f) => ({ ...f, [key]: value, ...(resetsPreset ? { preset: null } : {}) }));
  };

  const handleApiTypeChange = (type: ApiType) => {
    setForm((f) => {
      const defaultBaseUrls: Record<ApiType, string> = {
        openai: 'https://api.openai.com/v1',
        anthropic: 'https://api.anthropic.com',
      };
      // 只有在使用预设时才同步重置 base_url，手动配置时保留用户值
      const base_url = f.preset !== null ? defaultBaseUrls[type] : f.base_url;
      return { ...f, api_type: type, base_url, preset: null };
    });
  };

  const inputClass = 'w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div className="w-full max-w-lg">
      <div className="p-8 space-y-4">
        <h3 className="text-white font-semibold text-sm border-b border-[#1e2d42] pb-2">
          {t('llmSettings.aiModelConfig')}
        </h3>

        {/* 厂商预设 */}
        <div>
          <label className={labelClass}>{t('llmSettings.preset')}</label>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handlePresetSelect(null)}
              className={`px-3 py-1 text-xs rounded border transition-colors ${
                form.preset === null
                  ? 'bg-[#009e84] border-[#009e84] text-white'
                  : 'border-[#253347] text-[#c8daea] hover:bg-[#1a2639]'
              }`}
            >
              {t('llmSettings.custom')}
            </button>
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => handlePresetSelect(p)}
                className={`px-3 py-1 text-xs rounded border transition-colors ${
                  form.preset === p.id
                    ? 'bg-[#009e84] border-[#009e84] text-white'
                    : 'border-[#253347] text-[#c8daea] hover:bg-[#1a2639]'
                }`}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* API 协议 */}
        <div>
          <label className={labelClass}>{t('llmSettings.apiType')}</label>
          <div className="flex gap-4">
            {(['openai', 'anthropic'] as ApiType[]).map((type) => (
              <label key={type} className="flex items-center gap-1.5 cursor-pointer text-sm text-[#c8daea]">
                <input
                  type="radio"
                  name="api_type"
                  value={type}
                  checked={form.api_type === type}
                  onChange={() => handleApiTypeChange(type)}
                  className="accent-[#009e84]"
                />
                {type === 'openai' ? t('llmSettings.openaiCompat') : t('llmSettings.anthropicCompat')}
              </label>
            ))}
          </div>
        </div>

        {/* API Key */}
        <div>
          <label className={labelClass}>{t('llmSettings.apiKey')}</label>
          <PasswordInput
            className={inputClass}
            value={form.api_key}
            onChange={(v) => handleFieldChange('api_key', v)}
            placeholder="sk-..."
          />
        </div>

        {/* Base URL */}
        <div>
          <label className={labelClass}>{t('llmSettings.baseUrl')}</label>
          <input
            className={inputClass}
            value={form.base_url}
            onChange={(e) => handleFieldChange('base_url', e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </div>

        {/* 模型 */}
        <div>
          <label className={labelClass}>{t('llmSettings.model')}</label>
          <input
            className={inputClass}
            value={form.model}
            onChange={(e) => handleFieldChange('model', e.target.value)}
            placeholder="gpt-4o-mini"
          />
        </div>

        {/* 操作按钮 */}
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

        {form.preset === 'alicloud' ? (
          <div className="pt-2 space-y-2">
            <p className="text-xs text-[#7a9bb8]">{t('llmSettings.supportInfoCodingPlan')}</p>
            <div className="bg-[#0d1a26] border border-[#1e2d42] rounded px-3 py-2 font-mono text-xs text-[#7ecba1] space-y-0.5">
              <div><span className="text-[#5b8ab0]">ANTHROPIC_AUTH_TOKEN</span>=<span className="text-[#c8daea]">{form.api_key || 'YOUR_API_KEY'}</span></div>
              <div><span className="text-[#5b8ab0]">ANTHROPIC_BASE_URL</span>=<span className="text-[#c8daea]">{form.base_url}</span></div>
              <div><span className="text-[#5b8ab0]">ANTHROPIC_MODEL</span>=<span className="text-[#c8daea]">{form.model}</span></div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-[#7a9bb8] pt-2">
            {form.api_type === 'anthropic' ? t('llmSettings.supportInfoAnthropic') : t('llmSettings.supportInfo')}
          </p>
        )}
      </div>
    </div>
  );
}
