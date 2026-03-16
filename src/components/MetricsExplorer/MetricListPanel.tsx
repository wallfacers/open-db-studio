import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Trash2, ExternalLink, Pencil, Plus, Sparkles } from 'lucide-react';
import type { Metric, MetricScope, MetricStatus } from '../../types';

interface Props {
  scope: MetricScope;
}

type FilterTab = 'all' | MetricStatus;

export function MetricListPanel({ scope }: Props) {
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<Metric[]>('list_metrics_by_node', {
        connectionId: scope.connectionId,
        database: scope.database ?? null,
        schema: scope.schema ?? null,
        status: filterTab === 'all' ? null : filterTab,
      });
      setMetrics(data);
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filterTab, scope.connectionId, scope.database, scope.schema]);

  const filtered = metrics.filter(m =>
    !search || m.display_name.includes(search) || m.name.includes(search)
  );

  const toggleSelect = (id: number) => {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const allSelected = filtered.length > 0 && filtered.every(m => selected.has(m.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map(m => m.id)));

  const doDelete = async (ids: number[]) => {
    for (const id of ids) {
      try { await invoke('delete_metric', { id }); } catch (e: any) { alert(e?.message); return; }
    }
    setSelected(new Set());
    load();
  };

  const doSetStatus = async (ids: number[], status: string) => {
    for (const id of ids) {
      await invoke('approve_metric', { id, status });
    }
    setSelected(new Set());
    load();
  };

  const openMetric = (m: Metric) => {
    import('../../store/queryStore').then(({ useQueryStore }) => {
      (useQueryStore.getState() as any).openMetricTab?.(m.id, m.display_name);
    });
  };

  const statusBadge = (status: MetricStatus) => {
    const map: Record<MetricStatus, { cls: string; label: string }> = {
      approved: { cls: 'bg-[#0d3d2e] text-[#00c9a7]', label: '✅ 已通过' },
      rejected: { cls: 'bg-[#3d1a1a] text-[#f87171]', label: '❌ 已拒绝' },
      draft:    { cls: 'bg-[#1e2d42] text-[#7a9bb8]',  label: '📝 草稿' },
    };
    const s = map[status];
    return <span className={`px-1.5 py-0.5 rounded text-[10px] ${s.cls}`}>{s.label}</span>;
  };

  const TABS: { key: FilterTab; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'draft', label: '草稿' },
    { key: 'approved', label: '已通过' },
    { key: 'rejected', label: '已拒绝' },
  ];

  return (
    <div className="flex flex-col h-full bg-[#111922] text-white">
      {/* 过滤栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[#1e2d42] flex-wrap flex-shrink-0">
        <div className="flex gap-1">
          {TABS.map(t => (
            <button
              key={t.key}
              className={`px-2 py-1 text-xs rounded ${filterTab === t.key
                ? 'bg-[#00c9a7] text-black font-medium'
                : 'text-[#7a9bb8] hover:bg-[#1a2a3a] hover:text-white'}`}
              onClick={() => setFilterTab(t.key)}
            >{t.label}</button>
          ))}
        </div>
        <input
          className="flex-1 min-w-[120px] bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1 text-xs
                     text-white placeholder-[#4a6a8a] focus:outline-none focus:border-[#00c9a7]"
          placeholder="搜索指标名称..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button
          className="flex items-center gap-1 px-2 py-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded
                     text-xs text-[#a0b4c8] hover:border-[#00c9a7] hover:text-[#00c9a7]"
          onClick={() => {/* TODO */}}
        ><Plus size={12} /> 新增</button>
        <button
          className="flex items-center gap-1 px-2 py-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded
                     text-xs text-[#a0b4c8] hover:border-[#00c9a7] hover:text-[#00c9a7]"
          onClick={() => {/* TODO */}}
        ><Sparkles size={12} /> AI 生成</button>
      </div>

      {/* 表格 */}
      <div className="flex-1 overflow-auto">
        {error && <div className="px-4 py-2 text-xs text-red-400">{error}</div>}
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#0d1821] text-[#7a9bb8] text-[10px] uppercase tracking-wider">
            <tr>
              <th className="w-8 px-3 py-2 text-left">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-[#00c9a7]" />
              </th>
              <th className="px-3 py-2 text-left">显示名称</th>
              <th className="px-3 py-2 text-left">关联表</th>
              <th className="px-3 py-2 text-left">聚合</th>
              <th className="px-3 py-2 text-left">类型</th>
              <th className="px-3 py-2 text-left">状态</th>
              <th className="px-3 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="text-center py-8 text-[#7a9bb8]">加载中...</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-[#4a6a8a]">暂无指标</td></tr>
            )}
            {filtered.map(m => (
              <tr key={m.id} className="border-b border-[#1a2a3a] hover:bg-[#1a2a3a]">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={selected.has(m.id)}
                    onChange={() => toggleSelect(m.id)} className="accent-[#00c9a7]" />
                </td>
                <td className="px-3 py-2 text-white font-medium">{m.display_name}</td>
                <td className="px-3 py-2 text-[#a0b4c8]">{m.table_name || '-'}</td>
                <td className="px-3 py-2 text-[#a0b4c8]">{m.aggregation ?? '-'}</td>
                <td className="px-3 py-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                    m.metric_type === 'composite' ? 'bg-[#2d1a4a] text-[#c084fc]' : 'bg-[#1a2a3a] text-[#7a9bb8]'
                  }`}>
                    {m.metric_type === 'composite' ? '复合' : '原子'}
                  </span>
                </td>
                <td className="px-3 py-2">{statusBadge(m.status)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2 justify-end">
                    <button className="text-[#7a9bb8] hover:text-white" onClick={() => openMetric(m)} title="打开">
                      <ExternalLink size={12} />
                    </button>
                    <button className="text-[#7a9bb8] hover:text-white" onClick={() => openMetric(m)} title="编辑">
                      <Pencil size={12} />
                    </button>
                    <button className="text-red-400 hover:text-red-300" onClick={() => doDelete([m.id])} title="删除">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 批量操作栏 */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-[#1a2a3a] border-t border-[#2a3f5a] text-xs flex-shrink-0">
          <span className="text-[#7a9bb8]">已选 {selected.size} 项</span>
          <button className="text-red-400 hover:text-red-300" onClick={() => doDelete([...selected])}>批量删除</button>
          <button className="text-[#00c9a7] hover:text-[#00b090]" onClick={() => doSetStatus([...selected], 'approved')}>批量通过</button>
          <button className="text-[#f87171] hover:text-red-300" onClick={() => doSetStatus([...selected], 'rejected')}>批量拒绝</button>
        </div>
      )}
    </div>
  );
}
