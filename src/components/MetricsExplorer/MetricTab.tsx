import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Save } from 'lucide-react';
import type { Metric, UpdateMetricPayload } from '../../types';

interface Props {
  metricId: number;
}

export function MetricTab({ metricId }: Props) {
  const [metric, setMetric] = useState<Metric | null>(null);
  const [form, setForm] = useState<UpdateMetricPayload>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    }
  };

  useEffect(() => { loadMetric(); }, [metricId]);

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

      <div className="flex-1 overflow-y-auto p-4">
        {/* 指标类型切换 */}
        <div className="flex items-center gap-3 mb-4">
          <label className="w-24 text-xs text-[#7a9bb8] text-right flex-shrink-0">指标类型</label>
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

        {/* 表单字段 */}
        {[
          { label: '显示名称', key: 'display_name' as const, required: true },
          { label: '英文标识', key: 'name' as const, required: true },
          { label: '分类标签', key: 'category' as const },
          { label: '版本号', key: 'version' as const },
        ].map(({ label, key, required }) => (
          <div key={key} className="flex items-center gap-3 mb-3">
            <label className="w-24 text-xs text-[#7a9bb8] text-right flex-shrink-0">
              {label}{required && <span className="text-red-400 ml-0.5">*</span>}
            </label>
            <input
              className="flex-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs
                         text-white focus:outline-none focus:border-[#00c9a7]"
              value={(form[key] as string | undefined) ?? ''}
              onChange={e => setValue(key, e.target.value)}
            />
          </div>
        ))}

        {/* 原子指标专有字段 */}
        {currentType === 'atomic' && (
          <>
            {[
              { label: '关联表', key: 'table_name' as const, required: true },
              { label: '关联列', key: 'column_name' as const },
            ].map(({ label, key, required }) => (
              <div key={key} className="flex items-center gap-3 mb-3">
                <label className="w-24 text-xs text-[#7a9bb8] text-right flex-shrink-0">
                  {label}{required && <span className="text-red-400 ml-0.5">*</span>}
                </label>
                <input
                  className="flex-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs
                             text-white focus:outline-none focus:border-[#00c9a7]"
                  value={(form[key] as string | undefined) ?? ''}
                  onChange={e => setValue(key, e.target.value)}
                />
              </div>
            ))}
            <div className="flex items-center gap-3 mb-3">
              <label className="w-24 text-xs text-[#7a9bb8] text-right flex-shrink-0">聚合方式</label>
              <select
                className="bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs
                           text-white focus:outline-none focus:border-[#00c9a7]"
                value={form.aggregation ?? metric?.aggregation ?? ''}
                onChange={e => setForm(f => ({ ...f, aggregation: e.target.value || undefined }))}
              >
                <option value="">不设置</option>
                {['SUM', 'COUNT', 'AVG', 'MAX', 'MIN'].map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* 描述和数据口径 */}
        {[
          { label: '描述', key: 'description' as const },
          { label: '数据口径说明', key: 'data_caliber' as const },
        ].map(({ label, key }) => (
          <div key={key} className="flex items-start gap-3 mb-3">
            <label className="w-24 text-xs text-[#7a9bb8] text-right flex-shrink-0 pt-1.5">{label}</label>
            <textarea
              className="flex-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs
                         text-white focus:outline-none focus:border-[#00c9a7] resize-none h-16"
              value={(form[key] as string | undefined) ?? ''}
              onChange={e => setValue(key, e.target.value)}
            />
          </div>
        ))}

        {/* filter_sql 编辑器（仅原子指标） */}
        {currentType === 'atomic' && (
          <div className="mt-4 border border-[#2a3f5a] rounded overflow-hidden">
            <div className="px-3 py-1.5 bg-[#1a2a3a] border-b border-[#2a3f5a] text-xs text-[#7a9bb8] flex items-center justify-between">
              <span>filter_sql（WHERE 条件，不含 WHERE 关键字）</span>
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
          <div className="mt-4 p-3 bg-[#1a2a3a] border border-[#2a3f5a] rounded text-xs text-[#7a9bb8]">
            复合指标组合器（P2 功能，即将支持）
          </div>
        )}
      </div>
    </div>
  );
}
