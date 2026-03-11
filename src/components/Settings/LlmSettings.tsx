import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle, XCircle, Loader2, Star, Plus, Pencil, Trash2 } from 'lucide-react';
import { PasswordInput } from '../common/PasswordInput';
import { useAiStore } from '../../store';
import type { LlmConfig, CreateLlmConfigInput, ApiType } from '../../types';

// -------- 厂商预设 --------
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

// -------- 连通性状态指示 --------
function TestStatusBadge({ status, error, testedAt }: {
  status: string;
  error: string | null;
  testedAt: string | null;
}) {
  const { t } = useTranslation();

  const ago = (() => {
    if (!testedAt) return '';
    const diff = Date.now() - new Date(testedAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('llmSettings.justNow');
    if (mins < 60) return t('llmSettings.minutesAgo', { n: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('llmSettings.hoursAgo', { n: hours });
    return t('llmSettings.daysAgo', { n: Math.floor(hours / 24) });
  })();

  if (status === 'untested') {
    return <span className="text-xs text-gray-500">○ {t('llmSettings.untested')}</span>;
  }
  if (status === 'testing') {
    return (
      <span className="text-xs text-yellow-400 flex items-center gap-1">
        <Loader2 size={11} className="animate-spin" />{t('llmSettings.testing')}
      </span>
    );
  }
  if (status === 'success') {
    return (
      <span className="text-xs text-green-400 flex items-center gap-1">
        <CheckCircle size={11} />{t('llmSettings.connected')} {ago}
      </span>
    );
  }
  return (
    <span className="text-xs text-red-400 flex items-center gap-1" title={error ?? ''}>
      <XCircle size={11} />{t('llmSettings.failed')}
    </span>
  );
}

// -------- 编辑/新建 模态对话框 --------
const EMPTY_FORM: CreateLlmConfigInput = {
  name: '',
  api_key: '',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  api_type: 'openai',
  preset: null,
};

type EffectiveTestStatus = 'success' | 'untested' | null;

// 连通性相关字段，用于判断测试后配置是否变更
type ConnSnapshot = { api_key: string; base_url: string; model: string; api_type: ApiType };

function snapshotFrom(form: CreateLlmConfigInput): ConnSnapshot {
  return { api_key: form.api_key, base_url: form.base_url, model: form.model, api_type: form.api_type };
}

function snapshotEqual(a: ConnSnapshot, b: ConnSnapshot): boolean {
  return a.api_key === b.api_key && a.base_url === b.base_url && a.model === b.model && a.api_type === b.api_type;
}

interface ConfigFormDialogProps {
  title: string;
  initial: CreateLlmConfigInput;
  onSave: (input: CreateLlmConfigInput, effectiveTestStatus: EffectiveTestStatus) => Promise<void>;
  onCancel: () => void;
}

function ConfigFormDialog({ title, initial, onSave, onCancel }: ConfigFormDialogProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<CreateLlmConfigInput>(initial);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg?: string } | null>(null);
  // 测试通过时记录的字段快照，用于判断保存时配置是否仍与测试时一致
  const [successSnapshot, setSuccessSnapshot] = useState<ConnSnapshot | null>(null);

  // 计算有效测试状态：通过且字段未变 → success；通过但字段已变 → untested；未测试 → null
  const effectiveTestStatus: EffectiveTestStatus = (() => {
    if (!successSnapshot) return null;
    return snapshotEqual(snapshotFrom(form), successSnapshot) ? 'success' : 'untested';
  })();

  const inputClass = 'w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const handlePreset = (preset: ProviderPreset | null) => {
    if (!preset) {
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

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setSuccessSnapshot(null);
    const tempInput: CreateLlmConfigInput = {
      ...form,
      name: form.name || `${form.model} · ${form.api_type}`,
    };
    try {
      const created = await invoke<LlmConfig>('create_llm_config', { input: tempInput });
      try {
        await invoke('test_llm_config', { id: created.id });
        setTestResult({ ok: true });
        setSuccessSnapshot(snapshotFrom(form));  // 记录测试通过时的字段快照
      } catch (e) {
        setTestResult({ ok: false, msg: String(e) });
      } finally {
        await invoke('delete_llm_config', { id: created.id });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(form, effectiveTestStatus);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[#0d1a26] border border-[#1e2d42] rounded-lg w-full max-w-md p-6 space-y-4">
        <h3 className="text-white font-semibold text-sm">{title}</h3>

        {/* 厂商预设 */}
        <div>
          <label className={labelClass}>{t('llmSettings.preset')}</label>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handlePreset(null)}
              className={`px-3 py-1 text-xs rounded border transition-colors ${
                !form.preset
                  ? 'bg-[#009e84] border-[#009e84] text-white'
                  : 'border-[#253347] text-[#c8daea] hover:bg-[#1a2639]'
              }`}
            >
              {t('llmSettings.custom')}
            </button>
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => handlePreset(p)}
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

        {/* 名称 */}
        <div>
          <label className={labelClass}>{t('llmSettings.name')}（{t('llmSettings.namePlaceholder')}）</label>
          <input
            className={inputClass}
            value={form.name ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={`${form.model} · ${form.api_type}`}
          />
        </div>

        {/* API 协议 */}
        <div>
          <label className={labelClass}>
            {t('llmSettings.apiType')}
            {form.preset && <span className="ml-2 text-[#5b8ab0]">({t('llmSettings.lockedByPreset')})</span>}
          </label>
          <div className="flex gap-4">
            {(['openai', 'anthropic'] as ApiType[]).map((type) => (
              <label
                key={type}
                className={`flex items-center gap-1.5 text-sm ${
                  form.preset ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer text-[#c8daea]'
                }`}
              >
                <input
                  type="radio"
                  name="api_type"
                  value={type}
                  checked={form.api_type === type}
                  onChange={() => setForm((f) => ({ ...f, api_type: type, preset: null }))}
                  disabled={!!form.preset}
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
            onChange={(v) => setForm((f) => ({ ...f, api_key: v }))}
            placeholder="sk-..."
          />
        </div>

        {/* Base URL */}
        <div>
          <label className={labelClass}>{t('llmSettings.baseUrl')}</label>
          <input
            className={inputClass}
            value={form.base_url}
            onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value, preset: null }))}
            placeholder="https://api.openai.com/v1"
          />
        </div>

        {/* 模型 */}
        <div>
          <label className={labelClass}>{t('llmSettings.model')}</label>
          <input
            className={inputClass}
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            placeholder="gpt-4o-mini"
          />
        </div>

        {/* 测试结果 */}
        {testResult && (
          <p className={`text-xs flex items-center gap-1 ${
            effectiveTestStatus === 'success' ? 'text-green-400' :
            effectiveTestStatus === 'untested' ? 'text-yellow-400' : 'text-red-400'
          }`}>
            {effectiveTestStatus === 'success' && <CheckCircle size={12} />}
            {effectiveTestStatus === 'untested' && <XCircle size={12} />}
            {!testResult.ok && <XCircle size={12} />}
            {effectiveTestStatus === 'success'
              ? t('llmSettings.testPassed')
              : effectiveTestStatus === 'untested'
              ? t('llmSettings.configChangedRetest')
              : testResult.msg}
          </p>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={handleTest}
            disabled={testing || !form.api_key}
            className="px-3 py-1.5 text-xs border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded disabled:opacity-50 flex items-center gap-1.5"
          >
            {testing && <Loader2 size={12} className="animate-spin" />}
            {testing ? t('llmSettings.testing') : t('llmSettings.testConnectivity')}
          </button>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-1.5 text-xs border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded"
            >
              {t('llmSettings.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-xs bg-[#009e84] hover:bg-[#007a62] text-white rounded disabled:opacity-50"
            >
              {saving ? t('llmSettings.saving') : t('llmSettings.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------- 主组件 --------
export function LlmSettingsPanel() {
  const { t } = useTranslation();
  const { configs, loadConfigs, createConfig, updateConfig, deleteConfig, setDefaultConfig, testConfig } = useAiStore();
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<LlmConfig | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<LlmConfig | null>(null);

  useEffect(() => { loadConfigs(); }, []);

  const handleCreate = async (input: CreateLlmConfigInput, effectiveTestStatus: EffectiveTestStatus) => {
    const created = await invoke<LlmConfig>('create_llm_config', { input });
    if (effectiveTestStatus === 'success') {
      await invoke('set_llm_config_test_status', { id: created.id, status: 'success', error: null });
    }
    await loadConfigs();
    setShowCreate(false);
  };

  const handleUpdate = async (input: CreateLlmConfigInput, effectiveTestStatus: EffectiveTestStatus) => {
    if (!editTarget) return;
    await invoke('update_llm_config', { id: editTarget.id, input });
    if (effectiveTestStatus !== null) {
      await invoke('set_llm_config_test_status', { id: editTarget.id, status: effectiveTestStatus, error: null });
    }
    await loadConfigs();
    setEditTarget(null);
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteConfig(deleteConfirm.id);
    setDeleteConfirm(null);
  };

  return (
    <div className="w-full max-w-2xl p-8">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-white font-semibold text-sm">{t('llmSettings.aiModelConfig')}</h3>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#009e84] hover:bg-[#007a62] text-white rounded"
        >
          <Plus size={13} />{t('llmSettings.addConfig')}
        </button>
      </div>

      {/* 卡片网格 */}
      {configs.length === 0 ? (
        <div className="text-center py-16 text-[#7a9bb8]">
          <p className="text-sm">{t('llmSettings.noConfigs')}</p>
          <p className="text-xs mt-1 opacity-60">{t('llmSettings.noConfigsHint')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {configs.map((config) => (
            <div
              key={config.id}
              className={`bg-[#0d1a26] border rounded-lg p-4 flex flex-col gap-2 ${
                config.is_default ? 'border-[#009e84]' : 'border-[#1e2d42]'
              }`}
            >
              {/* 标题行 */}
              <div className="flex items-center gap-1.5">
                {config.is_default && (
                  <Star size={13} className="text-[#009e84] fill-[#009e84] flex-shrink-0" />
                )}
                <span className="text-sm text-white font-medium truncate">{config.name}</span>
              </div>
              {/* 配置信息 */}
              <div className="text-xs text-[#7a9bb8] space-y-0.5">
                <div className="truncate">{config.model}</div>
                <div>{config.api_type === 'openai' ? t('llmSettings.openaiCompat') : t('llmSettings.anthropicCompat')}</div>
              </div>
              {/* 连通性状态 */}
              <TestStatusBadge
                status={config.test_status}
                error={config.test_error}
                testedAt={config.tested_at}
              />
              {/* 操作按钮 */}
              <div className="flex items-center gap-1.5 mt-1 pt-2 border-t border-[#1e2d42] flex-wrap">
                {!config.is_default && (
                  <button
                    onClick={() => setDefaultConfig(config.id)}
                    className="text-xs px-2 py-1 border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded"
                  >
                    {t('llmSettings.setDefault')}
                  </button>
                )}
                <button
                  onClick={() => testConfig(config.id)}
                  disabled={config.test_status === 'testing'}
                  className="text-xs px-2 py-1 border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded disabled:opacity-50 flex items-center gap-1"
                >
                  {config.test_status === 'testing' && <Loader2 size={10} className="animate-spin" />}
                  {t('llmSettings.test')}
                </button>
                <button
                  onClick={() => setEditTarget(config)}
                  className="text-xs px-2 py-1 border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1"
                >
                  <Pencil size={11} />{t('llmSettings.edit')}
                </button>
                <button
                  onClick={() => setDeleteConfirm(config)}
                  disabled={config.test_status === 'testing'}
                  className="text-xs px-2 py-1 border border-red-900 text-red-400 hover:bg-red-950 rounded flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 size={11} />{t('llmSettings.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新建对话框 */}
      {showCreate && (
        <ConfigFormDialog
          title={t('llmSettings.addConfigTitle')}
          initial={EMPTY_FORM}
          onSave={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {/* 编辑对话框 */}
      {editTarget && (
        <ConfigFormDialog
          title={t('llmSettings.editConfigTitle')}
          initial={{
            name: editTarget.name,
            api_key: editTarget.api_key,
            base_url: editTarget.base_url,
            model: editTarget.model,
            api_type: editTarget.api_type,
            preset: editTarget.preset,
          }}
          onSave={handleUpdate}
          onCancel={() => setEditTarget(null)}
        />
      )}

      {/* 删除确认 */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-[#0d1a26] border border-[#1e2d42] rounded-lg w-full max-w-sm p-6 space-y-4">
            <h3 className="text-white font-semibold text-sm">{t('llmSettings.confirmDelete')}</h3>
            <p className="text-xs text-[#c8daea]">
              {t('llmSettings.confirmDeleteMsg', { name: deleteConfirm.name })}
              {deleteConfirm.is_default && (
                <span className="text-yellow-400 block mt-1">
                  {t('llmSettings.defaultDeleteWarning')}
                </span>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-1.5 text-xs border border-[#253347] text-[#c8daea] hover:bg-[#1a2639] rounded"
              >
                {t('llmSettings.cancel')}
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-1.5 text-xs bg-red-700 hover:bg-red-800 text-white rounded"
              >
                {t('llmSettings.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
