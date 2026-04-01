import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  CheckCircle, XCircle, Loader2, Star, Plus, Pencil, Trash2, X, ChevronDown,
} from 'lucide-react';
import { PasswordInput } from '../common/PasswordInput';
import { useAiStore } from '../../store';
import type {
  LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput,
  OpenCodeProvider, OpenCodeProviderModel, ConfigMode,
} from '../../types';
import { useEscClose } from '../../hooks/useEscClose';

// ──────────────── 共用类名 ────────────────
const inputCls = 'w-full bg-[var(--background-hover)] border border-[var(--border-strong)] rounded px-3 py-1.5 text-sm text-[var(--foreground-default)] focus:outline-none focus:border-[#009e84]';
const labelCls = 'block text-xs text-[var(--foreground-muted)] mb-1 uppercase tracking-wide';

// ──────────────── TestStatusBadge ────────────────
function TestStatusBadge({ status, error, testedAt }: {
  status: string; error: string | null; testedAt: string | null;
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
  if (status === 'untested') return <span className="text-xs text-[var(--foreground-subtle)]">○ {t('llmSettings.untested')}</span>;
  if (status === 'testing') return (
    <span className="text-xs text-yellow-400 flex items-center gap-1">
      <Loader2 size={11} className="animate-spin" />{t('llmSettings.testing')}
    </span>
  );
  if (status === 'success') return (
    <span className="text-xs text-[#4ade80] flex items-center gap-1">
      <CheckCircle size={11} />{t('llmSettings.connected')} {ago}
    </span>
  );
  return (
    <span className="text-xs text-red-400 flex items-center gap-1" title={error ?? ''}>
      <XCircle size={11} />{t('llmSettings.failed')}
    </span>
  );
}

// ──────────────── ModelCombobox ────────────────
function ModelCombobox({
  models, value, onChange,
}: {
  models: OpenCodeProviderModel[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full bg-[var(--background-hover)] border rounded px-3 py-1.5 text-sm text-[var(--foreground-default)] focus:outline-none flex justify-between items-center ${open ? 'border-[#009e84] rounded-b-none' : 'border-[var(--border-strong)]'}`}
      >
        <span>{value || '选择模型…'}</span>
        <ChevronDown size={13} className="text-[var(--foreground-subtle)]" />
      </button>
      {open && (
        <div className="absolute z-50 w-full bg-[var(--background-base)] border border-[var(--border-default)] border-t-0 rounded-b-md max-h-52 overflow-y-auto">
          {models.length > 0 && (
            <div className="px-3 pt-2 pb-1 text-[10px] text-[var(--foreground-subtle)] uppercase tracking-wide">供应商模型</div>
          )}
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onChange(m.id); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--background-hover)] ${value === m.id ? 'text-[var(--accent)] bg-[var(--accent-subtle)]/20' : 'text-[var(--foreground-muted)]'}`}
            >
              {value === m.id && '✓ '}{m.name || m.id}
            </button>
          ))}
          <div className="border-t border-[var(--border-default)] mx-2 my-1" />
          <div className="px-2 pb-2">
            <input
              className="w-full bg-[var(--background-base)] border border-dashed border-[var(--border-strong)] rounded px-2 py-1 text-xs text-[var(--foreground-subtle)] focus:outline-none focus:border-[#009e84] focus:text-[var(--foreground-default)]"
              placeholder="输入自定义模型 ID…"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customInput.trim()) {
                  onChange(customInput.trim());
                  setCustomInput('');
                  setOpen(false);
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────── ProviderDropdown ────────────────
function ProviderDropdown({
  providers, value, onChange,
}: {
  providers: OpenCodeProvider[];
  value: string;       // provider id 或 'custom'
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedProvider = providers.find((p) => p.id === value);
  const displayLabel = value === 'custom'
    ? '⚙ 自定义供应商'
    : ((selectedProvider?.name ?? value) || '选择供应商…');

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full bg-[var(--background-hover)] border rounded px-3 py-1.5 text-sm text-[var(--foreground-default)] focus:outline-none flex justify-between items-center ${open ? 'border-[#009e84] rounded-b-none' : 'border-[var(--border-strong)]'}`}
      >
        <span className="flex items-center gap-2">
          {value && value !== 'custom' && (
            <span className="w-2 h-2 rounded-full bg-[var(--accent)] flex-shrink-0 inline-block" />
          )}
          {value === 'custom' && (
            <span className="w-2 h-2 rounded-full bg-[var(--foreground-muted)] flex-shrink-0 inline-block" />
          )}
          {displayLabel}
        </span>
        <ChevronDown size={13} className="text-[var(--foreground-subtle)]" />
      </button>
      {open && (
        <div className="absolute z-50 w-full bg-[var(--background-base)] border border-[var(--border-default)] border-t-0 rounded-b-md max-h-64 overflow-y-auto">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => { onChange(p.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-[var(--background-hover)] flex items-center gap-2 ${value === p.id ? 'text-[var(--accent)]' : 'text-[var(--foreground-muted)]'}`}
            >
              <span className="w-2 h-2 rounded-full bg-[var(--accent)] flex-shrink-0 inline-block" />
              {p.name || p.id}
            </button>
          ))}
          <div className="border-t border-[var(--border-default)] mx-2 my-1" />
          <button
            type="button"
            onClick={() => { onChange('custom'); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-xs hover:bg-[var(--background-hover)] flex items-center gap-2 ${value === 'custom' ? 'text-[var(--accent)]' : 'text-[var(--foreground-subtle)]'}`}
          >
            <span className="w-2 h-2 rounded-full bg-[var(--foreground-muted)] flex-shrink-0 inline-block" />
            ⚙ 自定义供应商…
          </button>
        </div>
      )}
    </div>
  );
}

// ──────────────── ConfigFormDialog ────────────────
interface ConfigFormDialogProps {
  title: string;
  initial: CreateLlmConfigInput;
  editId?: number;
  providers: OpenCodeProvider[];
  providersLoading: boolean;
  onSave: (input: CreateLlmConfigInput & { _skipCreate?: boolean }, testPassed: boolean) => Promise<void>;
  onCancel: () => void;
}

function ConfigFormDialog({
  title, initial, editId, providers, providersLoading, onSave, onCancel,
}: ConfigFormDialogProps) {
  const [form, setForm] = useState<CreateLlmConfigInput>(initial);
  const [nameTouched, setNameTouched] = useState(!!initial.name);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg?: string } | null>(null);
  const [apiKeyDirty, setApiKeyDirty] = useState(false);

  useEscClose(onCancel);

  // 当前选中的供应商对象
  const selectedProvider = providers.find((p) => p.id === form.opencode_provider_id);

  // 自动填充配置名称（用户未手动修改时）
  useEffect(() => {
    if (nameTouched) return;
    let autoName = '';
    if (form.config_mode === 'opencode' && form.model && form.opencode_provider_id) {
      const pName = selectedProvider?.name ?? form.opencode_provider_id;
      autoName = `${form.model} · ${pName}`;
    } else if (form.config_mode === 'custom' && form.model && form.opencode_provider_id) {
      autoName = `${form.opencode_provider_id} · ${form.model}`;
    }
    if (autoName) setForm((f) => ({ ...f, name: autoName }));
  }, [form.model, form.opencode_provider_id, form.config_mode, nameTouched]);

  // 切换供应商时，重置模型
  const handleProviderChange = (pid: string) => {
    const isCustom = pid === 'custom';
    setForm((f) => ({
      ...f,
      opencode_provider_id: isCustom ? '' : pid,
      config_mode: (isCustom ? 'custom' : 'opencode') as ConfigMode,
      model: '',
      opencode_model_options: isCustom
        ? (f.opencode_model_options || DEFAULT_CUSTOM_MODEL_OPTIONS)
        : f.opencode_model_options,
    }));
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (isCustomMode) {
        // 自定义模式：直接使用内联测试
        let effectiveApiKey = form.api_key;
        if (editId && !apiKeyDirty) {
          try { effectiveApiKey = await invoke<string>('get_llm_config_key', { id: editId }); } catch {}
        }
        await invoke('test_llm_config_inline', {
          model: form.model,
          apiType: form.api_type,
          baseUrl: form.base_url,
          apiKey: effectiveApiKey,
        });
      } else if (editId) {
        // opencode 编辑模式：通过已保存的配置 ID 测试
        await invoke('test_llm_config', { id: editId });
      } else {
        // opencode 新建模式：先自动保存，再用返回的 ID 测试
        const created = await invoke<LlmConfig>('create_llm_config', { input: form });
        try {
          await invoke('test_llm_config', { id: created.id });
          // 测试成功：设置状态并通知父组件关闭弹框（配置已创建，跳过重复创建）
          await invoke('set_llm_config_test_status', { id: created.id, status: 'success', error: null });
          setTestResult({ ok: true });
          await onSave({ ...form, _skipCreate: true }, true);
          return;
        } catch (e) {
          // 测试失败：通知父组件刷新列表（配置已创建）
          await onSave({ ...form, _skipCreate: true }, false);
          setTestResult({ ok: false, msg: String(e) });
          return;
        }
      }
      setTestResult({ ok: true });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(form, testResult?.ok === true);
    } finally {
      setSaving(false);
    }
  };

  const isCustomMode = form.config_mode === 'custom';
  const canTest = isCustomMode
    ? !!form.model && !!form.base_url
    : !!form.model && !!form.opencode_provider_id;
  const dropdownValue = isCustomMode ? 'custom' : form.opencode_provider_id;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      {/* 外层容器：不限制 overflow，让下拉框弹出部分正常显示 */}
      <div className="bg-[#0d1a26] border border-[var(--border-default)] rounded-lg w-full max-w-md min-h-[480px] max-h-[90vh] flex flex-col">
        {/* 标题行：固定在顶部 */}
        <div className="flex items-center justify-between p-6 pb-0">
          <h3 className="text-[var(--foreground)] font-semibold text-sm">{title}</h3>
          <button onClick={onCancel} className="text-[var(--foreground-muted)] hover:text-[var(--foreground-default)]"><X size={16} /></button>
        </div>
        {/* 内容区域：可滚动 */}
        <div className="flex-1 overflow-y-auto p-6 pt-4 space-y-4">

        {/* 配置名称 */}
        <div>
          <label className={labelCls}>配置名称</label>
          <input
            className={inputCls}
            value={form.name ?? ''}
            onChange={(e) => {
              setNameTouched(true);
              setForm((f) => ({ ...f, name: e.target.value }));
            }}
            placeholder="自动填充…"
          />
        </div>

        {/* 供应商下拉 */}
        <div>
          <label className={labelCls}>
            供应商
            {providersLoading && <span className="ml-2 text-[var(--foreground-subtle)] normal-case">加载中…</span>}
          </label>
          <ProviderDropdown
            providers={providers}
            value={dropdownValue}
            onChange={handleProviderChange}
          />
        </div>

        {/* 自定义模式展开框 */}
        {isCustomMode && (
          <div className="bg-[var(--background-panel)] border border-[var(--border-default)] rounded-lg p-4 space-y-3">
            <div className="text-[10px] text-[var(--foreground-subtle)] uppercase tracking-wide">自定义供应商配置</div>

            <div>
              <label className={labelCls}>Provider ID</label>
              <input
                className={inputCls}
                value={form.opencode_provider_id}
                onChange={(e) => setForm((f) => ({ ...f, opencode_provider_id: e.target.value }))}
                placeholder="my-azure-gpt"
              />
              <p className="text-[10px] text-[var(--foreground-subtle)] mt-1">opencode 中的唯一标识</p>
            </div>

            <div>
              <label className={labelCls}>API 兼容类型</label>
              <div className="flex gap-4">
                {(['openai', 'anthropic'] as const).map((type) => (
                  <label key={type} className="flex items-center gap-1.5 text-xs text-[var(--foreground-default)] cursor-pointer">
                    <input
                      type="radio"
                      name="api_type"
                      value={type}
                      checked={form.api_type === type}
                      onChange={() => setForm((f) => ({ ...f, api_type: type }))}
                      className="accent-[#009e84]"
                    />
                    {type === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className={labelCls}>Base URL</label>
              <input
                className={inputCls}
                value={form.base_url}
                onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
                placeholder="https://api.example.com/v1"
              />
            </div>

            <div>
              <label className={labelCls}>Provider 展示名</label>
              <input
                className={inputCls}
                value={form.opencode_provider_name ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, opencode_provider_name: e.target.value }))}
                placeholder="如：Model Studio Coding Plan"
              />
              <p className="text-[10px] text-[var(--foreground-subtle)] mt-1">写入 opencode.json provider.name 字段</p>
            </div>

            <div>
              <label className={labelCls}>模型展示名</label>
              <input
                className={inputCls}
                value={form.opencode_display_name ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, opencode_display_name: e.target.value }))}
                placeholder="如：Kimi K2.5"
              />
              <p className="text-[10px] text-[var(--foreground-subtle)] mt-1">opencode 侧显示的模型名，空则使用配置名称</p>
            </div>

            <div>
              <label className={labelCls}>模型扩展选项 (JSON)</label>
              <textarea
                className={`${inputCls} font-mono text-xs h-24 resize-none`}
                value={form.opencode_model_options ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, opencode_model_options: e.target.value }))}
                placeholder={'{"modalities":{"input":["text"],"output":["text"]},"limit":{"context":1000000,"output":65536}}'}
              />
              <p className="text-[10px] text-[var(--foreground-subtle)] mt-1">modalities / options.thinking 等，写入 opencode.json models 字段</p>
            </div>
          </div>
        )}

        {/* API Key（两种模式均显示） */}
        <div>
          <label className={labelCls}>API Key</label>
          <PasswordInput
            className={inputCls}
            value={form.api_key}
            onChange={(v) => {
              setForm((f) => ({ ...f, api_key: v }));
              setApiKeyDirty(true);
            }}
            placeholder={editId ? '不修改则留空' : 'sk-…'}
            onReveal={editId ? () => invoke<string>('get_llm_config_key', { id: editId }) : undefined}
          />
        </div>

        {/* 模型选择 */}
        <div>
          <label className={labelCls}>模型</label>
          {isCustomMode ? (
            <>
              <input
                className={inputCls}
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="直接输入模型 ID"
              />
              <p className="text-[10px] text-[var(--foreground-subtle)] mt-1">直接输入模型 ID</p>
            </>
          ) : (
            <ModelCombobox
              models={selectedProvider?.models ?? []}
              value={form.model}
              onChange={(v) => setForm((f) => ({ ...f, model: v }))}
            />
          )}
        </div>

        {/* 测试结果 */}
        {testResult && (
          <div className={`flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-[#4ade80]' : 'text-red-400'}`}>
            {testResult.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
            {testResult.ok ? '连接成功' : testResult.msg}
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center pt-2 justify-between">
          <button
            onClick={handleTest}
            disabled={testing || !canTest}
            title={!canTest ? '请填写必填字段后再测试' : undefined}
            className="px-3 py-1.5 text-xs border border-[var(--border-default)] text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] hover:bg-[var(--background-hover)] rounded disabled:opacity-50 flex items-center gap-1.5"
          >
            {testing && <Loader2 size={12} className="animate-spin" />}
            {testing ? '测试中…' : '测试连接'}
          </button>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-1.5 text-xs border border-[var(--border-strong)] text-[var(--foreground-default)] hover:bg-[var(--background-hover)] rounded"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !form.model || (!isCustomMode && !form.opencode_provider_id)}
              className="px-4 py-1.5 text-xs bg-[#009e84] hover:bg-[#007a62] text-white rounded disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

// 自定义厂商时模型扩展选项默认值
const DEFAULT_CUSTOM_MODEL_OPTIONS = JSON.stringify(
  {
    modalities: {
      input: ['text'],
      output: ['text'],
    },
    limit: {
      context: 1000000,
      output: 65536,
    },
  },
  null,
  2,
);

// ──────────────── 主组件 ────────────────
const EMPTY_FORM: CreateLlmConfigInput = {
  name: '',
  api_key: '',
  base_url: '',
  model: '',
  api_type: 'openai',
  opencode_provider_id: '',
  config_mode: 'opencode',
  preset: null,
  opencode_display_name: '',
  opencode_model_options: '',
  opencode_provider_name: '',
};

export function LlmSettingsPanel() {
  const { t } = useTranslation();
  const { configs, loadConfigs, deleteConfig, setDefaultConfig, testConfig } = useAiStore();
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<LlmConfig | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<LlmConfig | null>(null);
  const [providers, setProviders] = useState<OpenCodeProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);

  useEffect(() => { loadConfigs(); }, []);

  useEscClose(() => setDeleteConfirm(null), !!deleteConfirm && !showCreate && !editTarget);

  // 打开弹框时加载供应商列表
  const loadProviders = async () => {
    setProvidersLoading(true);
    try {
      const list = await invoke<OpenCodeProvider[]>('agent_list_providers');
      setProviders(list);
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoading(false);
    }
  };

  const handleOpenCreate = () => {
    loadProviders();
    setShowCreate(true);
  };

  const handleOpenEdit = (config: LlmConfig) => {
    loadProviders();
    setEditTarget(config);
  };

  const handleCreate = async (input: CreateLlmConfigInput & { _skipCreate?: boolean }, testPassed: boolean) => {
    // 如果 _skipCreate 为 true，说明配置已在测试时创建，只需刷新列表并关闭弹框
    if (!input._skipCreate) {
      const created = await invoke<LlmConfig>('create_llm_config', { input });
      if (testPassed) {
        await invoke('set_llm_config_test_status', { id: created.id, status: 'success', error: null });
      }
    }
    await loadConfigs();
    setShowCreate(false);
  };

  const handleUpdate = async (input: CreateLlmConfigInput, testPassed: boolean) => {
    if (!editTarget) return;
    const updateInput: UpdateLlmConfigInput = {
      name: input.name,
      api_key: input.api_key || undefined,
      base_url: input.base_url,
      model: input.model,
      api_type: input.api_type,
      preset: input.preset,
      opencode_provider_id: input.opencode_provider_id,
      config_mode: input.config_mode,
      opencode_display_name: input.opencode_display_name,
      opencode_model_options: input.opencode_model_options,
      opencode_provider_name: input.opencode_provider_name,
    };
    await invoke('update_llm_config', { id: editTarget.id, input: updateInput });
    if (testPassed) {
      await invoke('set_llm_config_test_status', { id: editTarget.id, status: 'success', error: null });
    }
    await loadConfigs();
    setEditTarget(null);
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteConfig(deleteConfirm.id);
    setDeleteConfirm(null);
  };

  // 供应商标签（卡片显示用）
  const providerLabel = (config: LlmConfig) => {
    if (config.config_mode === 'custom') {
      return `⚙ 自定义 · ${config.opencode_provider_id || config.api_type}`;
    }
    return (providers.find((p) => p.id === config.opencode_provider_id)?.name
      ?? config.opencode_provider_id)
      || config.api_type;
  };

  return (
    <div className="w-full max-w-2xl p-8">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-[var(--foreground)] font-semibold text-sm">{t('llmSettings.aiModelConfig')}</h3>
        <button
          onClick={handleOpenCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#009e84] hover:bg-[#007a62] text-white rounded"
        >
          <Plus size={13} />{t('llmSettings.addConfig')}
        </button>
      </div>

      {/* 配置卡片网格 */}
      {configs.length === 0 ? (
        <div className="text-center py-16 text-[var(--foreground-muted)]">
          <p className="text-sm">{t('llmSettings.noConfigs')}</p>
          <p className="text-xs mt-1 opacity-60">{t('llmSettings.noConfigsHint')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {configs.map((config) => (
            <div
              key={config.id}
              className={`bg-[var(--background-panel)] border rounded-lg p-4 flex flex-col gap-2 ${config.is_default ? 'border-[var(--accent)]' : 'border-[var(--border-default)]'}`}
            >
              {/* 标题行 */}
              <div className="flex items-start justify-between gap-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  {config.is_default && <Star size={13} className="text-[#009e84] fill-[#009e84] flex-shrink-0" />}
                  <span className="text-sm text-[var(--foreground)] font-medium truncate">{config.name}</span>
                </div>
                {config.is_default && (
                  <span className="text-[10px] bg-[var(--accent-subtle)] text-[var(--accent)] px-1.5 py-0.5 rounded flex-shrink-0">默认</span>
                )}
              </div>
              {/* 供应商 + 模型 */}
              <div className="text-xs text-[var(--foreground-muted)] space-y-0.5">
                <div className="truncate">{providerLabel(config)}</div>
                <div className="text-[var(--foreground-default)] truncate">{config.model}</div>
              </div>
              {/* 测试状态 */}
              <TestStatusBadge status={config.test_status} error={config.test_error} testedAt={config.tested_at} />
              {/* 操作 */}
              <div className="flex items-center gap-1.5 mt-1 pt-2 border-t border-[var(--border-default)] flex-wrap">
                {!config.is_default && (
                  <button
                    onClick={() => setDefaultConfig(config.id)}
                    className="text-xs px-2 py-1 border border-[var(--border-strong)] text-[var(--foreground-default)] hover:bg-[var(--background-hover)] rounded"
                  >
                    {t('llmSettings.setDefault')}
                  </button>
                )}
                <button
                  onClick={() => testConfig(config.id)}
                  disabled={config.test_status === 'testing'}
                  className="text-xs px-2 py-1 border border-[var(--border-strong)] text-[var(--foreground-default)] hover:bg-[var(--background-hover)] rounded disabled:opacity-50 flex items-center gap-1"
                >
                  {config.test_status === 'testing' && <Loader2 size={10} className="animate-spin" />}
                  {t('llmSettings.test')}
                </button>
                <button
                  onClick={() => handleOpenEdit(config)}
                  className="text-xs px-2 py-1 border border-[var(--border-strong)] text-[var(--foreground-default)] hover:bg-[var(--background-hover)] rounded flex items-center gap-1"
                >
                  <Pencil size={11} />{t('llmSettings.edit')}
                </button>
                <button
                  onClick={() => setDeleteConfirm(config)}
                  className="text-xs px-2 py-1 border border-red-900 text-red-400 hover:bg-red-950 rounded flex items-center gap-1"
                >
                  <Trash2 size={11} />{t('llmSettings.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新建弹框 */}
      {showCreate && (
        <ConfigFormDialog
          title={t('llmSettings.addConfigTitle')}
          initial={EMPTY_FORM}
          providers={providers}
          providersLoading={providersLoading}
          onSave={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {/* 编辑弹框 */}
      {editTarget && (
        <ConfigFormDialog
          title={t('llmSettings.editConfigTitle')}
          initial={{
            name: editTarget.name,
            api_key: '',
            base_url: editTarget.base_url,
            model: editTarget.model,
            api_type: editTarget.api_type,
            opencode_provider_id: editTarget.opencode_provider_id,
            config_mode: editTarget.config_mode,
            preset: editTarget.preset,
            opencode_display_name: editTarget.opencode_display_name,
            opencode_model_options: editTarget.opencode_model_options,
            opencode_provider_name: editTarget.opencode_provider_name,
          }}
          editId={editTarget.id}
          providers={providers}
          providersLoading={providersLoading}
          onSave={handleUpdate}
          onCancel={() => setEditTarget(null)}
        />
      )}

      {/* 删除确认 */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setDeleteConfirm(null); }}
        >
          <div className="bg-[#0d1a26] border border-[var(--border-default)] rounded-lg w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[var(--foreground)] font-semibold text-sm">{t('llmSettings.confirmDelete')}</h3>
              <button onClick={() => setDeleteConfirm(null)} className="text-[var(--foreground-muted)] hover:text-[var(--foreground-default)]"><X size={16} /></button>
            </div>
            <p className="text-xs text-[var(--foreground-default)]">
              {t('llmSettings.confirmDeleteMsg', { name: deleteConfirm.name })}
              {deleteConfirm.is_default && (
                <span className="text-yellow-400 block mt-1">{t('llmSettings.defaultDeleteWarning')}</span>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-1.5 text-xs border border-[var(--border-strong)] text-[var(--foreground-default)] hover:bg-[var(--background-hover)] rounded">
                {t('llmSettings.cancel')}
              </button>
              <button onClick={handleDelete} className="px-4 py-1.5 text-xs bg-red-700 hover:bg-red-800 text-white rounded">
                {t('llmSettings.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
