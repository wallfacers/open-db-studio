import React, { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Save, X as XIcon } from 'lucide-react';
import type { Metric, UpdateMetricPayload, TableMeta, ColumnMeta } from '../../types';

// -------- 预设分类标签 --------
const PRESET_CATEGORIES = [
  '用户分析', '交易指标', '营收', '留存', '转化',
  '增长', '运营', '风控', '产品', '供应链',
];

// -------- Tag 输入组件 --------
function TagInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tags = value ? value.split(',').map(t => t.trim()).filter(Boolean) : [];
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || tags.includes(trimmed)) { setInput(''); return; }
    onChange([...tags, trimmed].join(','));
    setInput('');
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter(t => t !== tag).join(','));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input);
    } else if (e.key === 'Backspace' && !input && tags.length) {
      removeTag(tags[tags.length - 1]);
    }
  };

  return (
    <div className="space-y-2">
      {/* Tag pills + 输入框 */}
      <div
        className="min-h-[34px] flex flex-wrap gap-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded
                   px-2 py-1.5 cursor-text focus-within:border-[#00c9a7] transition-colors"
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map(tag => (
          <span
            key={tag}
            className="flex items-center gap-1 px-1.5 py-0.5 bg-[#0d3d2e] text-[#00c9a7] text-xs rounded"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(tag); }}
              className="hover:text-white transition-colors"
            >
              <XIcon size={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="flex-1 min-w-[80px] bg-transparent text-xs text-white outline-none
                     placeholder-[#4a6a8a]"
          placeholder={tags.length === 0 ? '输入分类，回车或逗号确认...' : ''}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => { if (input) addTag(input); }}
        />
      </div>
      {/* 预设快捷标签 */}
      <div className="flex flex-wrap gap-1">
        {PRESET_CATEGORIES.filter(t => !tags.includes(t)).map(tag => (
          <button
            key={tag}
            type="button"
            onClick={() => addTag(tag)}
            className="px-2 py-0.5 text-[10px] border border-[#2a3f5a] text-[#7a9bb8] rounded
                       hover:border-[#00c9a7] hover:text-[#00c9a7] transition-colors"
          >
            + {tag}
          </button>
        ))}
      </div>
    </div>
  );
}

// -------- 主组件 --------
interface Props {
  metricId: number;
}

const inputCls = 'w-full bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-[#00c9a7] transition-colors';
const selectCls = 'w-full bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-[#00c9a7] transition-colors appearance-none cursor-pointer';
const labelCls = 'block text-xs text-[#7a9bb8] mb-1';

export function MetricTab({ metricId }: Props) {
  const [metric, setMetric] = useState<Metric | null>(null);
  const [form, setForm] = useState<UpdateMetricPayload>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 关联表 / 列下拉数据
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [columns, setColumns] = useState<ColumnMeta[]>([]);

  const loadMetric = async () => {
    try {
      const m = await invoke<Metric>('get_metric', { id: metricId });
      setMetric(m);
      setForm({
        name: m.name,
        display_name: m.display_name,
        table_name: m.table_name,
        column_name: m.column_name,
        aggregation: m.aggregation,
        filter_sql: m.filter_sql,
        description: m.description,
        metric_type: m.metric_type,
        category: m.category,
        data_caliber: m.data_caliber,
        version: m.version,
      });
      // 加载表列表
      try {
        const ts = await invoke<TableMeta[]>('get_tables', { connectionId: m.connection_id });
        setTables(ts);
      } catch {}
      // 如果已有关联表，加载列列表
      if (m.table_name) {
        try {
          const detail = await invoke<{ columns: ColumnMeta[] }>('get_table_detail', {
            connectionId: m.connection_id,
            database: m.scope_database ?? null,
            schema: m.scope_schema ?? null,
            table: m.table_name,
          });
          setColumns(detail.columns);
        } catch {}
      }
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    }
  };

  useEffect(() => { loadMetric(); }, [metricId]);

  // 选择关联表时，联动加载列
  const handleTableChange = async (tableName: string) => {
    setForm(f => ({ ...f, table_name: tableName || undefined, column_name: undefined }));
    setColumns([]);
    if (!tableName || !metric) return;
    try {
      const detail = await invoke<{ columns: ColumnMeta[] }>('get_table_detail', {
        connectionId: metric.connection_id,
        database: metric.scope_database ?? null,
        schema: metric.scope_schema ?? null,
        table: tableName,
      });
      setColumns(detail.columns);
    } catch {}
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await invoke('update_metric', { id: metricId, input: form });
      await loadMetric();
    } catch (e: any) {
      setError(e?.message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const setValue = (key: keyof UpdateMetricPayload, value: string) =>
    setForm(f => ({ ...f, [key]: value || undefined }));

  if (!metric && !error) {
    return <div className="flex items-center justify-center h-full text-[#7a9bb8] text-sm">加载中...</div>;
  }
  if (error && !metric) {
    return <div className="flex items-center justify-center h-full text-red-400 text-sm">{error}</div>;
  }

  const currentType = form.metric_type ?? metric?.metric_type ?? 'atomic';

  return (
    <div className="flex flex-col h-full bg-[#111922] text-white overflow-hidden">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e2d42] flex-shrink-0">
        <span className="text-sm font-medium text-[#a0b4c8]">{metric?.display_name}</span>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-red-400">{error}</span>}
          <button
            className="flex items-center gap-1.5 px-3 py-1 bg-[#00c9a7] text-black text-xs rounded
                       hover:bg-[#00b090] disabled:opacity-50 font-medium"
            onClick={handleSave}
            disabled={saving}
          >
            <Save size={12} />
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>

      {/* 表单区域 — 居中 + 限制最大宽度 */}
      <div className="flex-1 overflow-y-auto py-6">
        <div className="max-w-xl mx-auto px-4 space-y-4">

          {/* 指标类型切换 */}
          <div>
            <label className={labelCls}>指标类型</label>
            <div className="flex gap-4">
              {(['atomic', 'composite'] as const).map(t => (
                <label key={t} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    value={t}
                    checked={currentType === t}
                    onChange={() => setForm(f => ({ ...f, metric_type: t }))}
                    className="accent-[#00c9a7]"
                  />
                  <span className="text-xs text-[#a0b4c8]">
                    {t === 'atomic' ? '原子指标' : '复合指标'}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* 显示名称 */}
          <div>
            <label className={labelCls}>显示名称 <span className="text-red-400">*</span></label>
            <input
              className={inputCls}
              value={(form.display_name as string | undefined) ?? ''}
              onChange={e => setValue('display_name', e.target.value)}
            />
          </div>

          {/* 英文标识 */}
          <div>
            <label className={labelCls}>英文标识 <span className="text-red-400">*</span></label>
            <input
              className={inputCls}
              value={(form.name as string | undefined) ?? ''}
              onChange={e => setValue('name', e.target.value)}
            />
          </div>

          {/* 分类标签 — Tag 输入 */}
          <div>
            <label className={labelCls}>分类标签</label>
            <TagInput
              value={(form.category as string | undefined) ?? ''}
              onChange={v => setForm(f => ({ ...f, category: v || undefined }))}
            />
          </div>

          {/* 版本号 */}
          <div>
            <label className={labelCls}>版本号</label>
            <input
              className={inputCls}
              value={(form.version as string | undefined) ?? ''}
              onChange={e => setValue('version', e.target.value)}
            />
          </div>

          {/* 原子指标专有字段 */}
          {currentType === 'atomic' && (
            <>
              {/* 关联表 — 下拉 */}
              <div>
                <label className={labelCls}>关联表 <span className="text-red-400">*</span></label>
                <select
                  className={selectCls}
                  value={form.table_name ?? ''}
                  onChange={e => handleTableChange(e.target.value)}
                >
                  <option value="">请选择表...</option>
                  {tables.map(t => (
                    <option key={t.name} value={t.name}>{t.name}</option>
                  ))}
                </select>
              </div>

              {/* 关联列 — 下拉 */}
              <div>
                <label className={labelCls}>关联列</label>
                <select
                  className={selectCls}
                  value={form.column_name ?? ''}
                  onChange={e => setValue('column_name', e.target.value)}
                  disabled={columns.length === 0}
                >
                  <option value="">{columns.length === 0 ? '先选择关联表' : '请选择列...'}</option>
                  {columns.map(c => (
                    <option key={c.name} value={c.name}>{c.name} ({c.data_type})</option>
                  ))}
                </select>
              </div>

              {/* 聚合方式 */}
              <div>
                <label className={labelCls}>聚合方式</label>
                <select
                  className={selectCls}
                  value={form.aggregation ?? metric?.aggregation ?? ''}
                  onChange={e => setForm(f => ({ ...f, aggregation: e.target.value || undefined }))}
                >
                  <option value="">不设置</option>
                  {['SUM', 'COUNT', 'AVG', 'MAX', 'MIN', 'COUNT_DISTINCT'].map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* 描述 */}
          <div>
            <label className={labelCls}>描述</label>
            <textarea
              className="w-full bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs
                         text-white focus:outline-none focus:border-[#00c9a7] transition-colors resize-none h-16"
              value={(form.description as string | undefined) ?? ''}
              onChange={e => setValue('description', e.target.value)}
            />
          </div>

          {/* 数据口径说明 */}
          <div>
            <label className={labelCls}>数据口径说明</label>
            <textarea
              className="w-full bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs
                         text-white focus:outline-none focus:border-[#00c9a7] transition-colors resize-none h-16"
              value={(form.data_caliber as string | undefined) ?? ''}
              onChange={e => setValue('data_caliber', e.target.value)}
            />
          </div>

          {/* filter_sql 编辑器（仅原子指标） */}
          {currentType === 'atomic' && (
            <div className="border border-[#2a3f5a] rounded overflow-hidden">
              <div className="px-3 py-1.5 bg-[#1a2a3a] border-b border-[#2a3f5a] text-xs text-[#7a9bb8]">
                filter_sql（WHERE 条件，不含 WHERE 关键字）
              </div>
              <textarea
                className="w-full bg-[#0d1821] px-3 py-2 text-xs text-white font-mono
                           focus:outline-none resize-none h-36"
                placeholder="created_at >= '2024-01-01' AND status = 'active'"
                value={(form.filter_sql as string | undefined) ?? ''}
                onChange={e => setForm(f => ({ ...f, filter_sql: e.target.value || undefined }))}
              />
            </div>
          )}

          {/* 复合指标提示 */}
          {currentType === 'composite' && (
            <div className="p-3 bg-[#1a2a3a] border border-[#2a3f5a] rounded text-xs text-[#7a9bb8]">
              复合指标组合器（P2 功能，即将支持）
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
