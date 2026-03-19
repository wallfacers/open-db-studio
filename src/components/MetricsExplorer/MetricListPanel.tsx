import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Trash2, Pencil, Plus, Sparkles, ListTodo, ChevronFirst, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import type { Metric, MetricPageResult, MetricScope, MetricStatus } from '../../types';
import { useMetricsTreeStore } from '../../store/metricsTreeStore';
import { useConfirmStore } from '../../store/confirmStore';
import { useQueryStore } from '../../store/queryStore';
import { useTaskStore } from '../../store/taskStore';
import { TablePickerModal } from './TablePickerModal';

interface Props {
  scope: MetricScope;
  onOpenMetric?: (metricId: number, title: string) => void;
}

type FilterTab = 'all' | MetricStatus;

/** 判断是否为从未填写过内容的空白指标 */
function isBlankMetric(m: Metric): boolean {
  return m.display_name === '新指标' && !m.table_name && !m.description;
}

export function MetricListPanel({ scope, onOpenMetric }: Props) {
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [genInfo, setGenInfo] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(100);
  const [rowCount, setRowCount] = useState(0);
  const [durationMs, setDurationMs] = useState(0);

  const deleteMetric = useMetricsTreeStore(s => s.deleteMetric);
  const confirm = useConfirmStore(s => s.confirm);
  const closeMetricTabById = useQueryStore(s => s.closeMetricTabById);
  const openNewMetricTab = useQueryStore(s => s.openNewMetricTab);

  const parentNodeId = scope.schema
    ? `schema_${scope.connectionId}_${scope.database}_${scope.schema}`
    : scope.database
      ? `db_${scope.connectionId}_${scope.database}`
      : null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<MetricPageResult>('list_metrics_paged', {
        connectionId: scope.connectionId,
        database: scope.database ?? null,
        schema: scope.schema ?? null,
        status: filterTab === 'all' ? null : filterTab,
        page,
        pageSize,
      });
      setMetrics(data.items);
      setRowCount(data.row_count);
      setDurationMs(data.duration_ms);

      // 空页回退：若拿到空列表且当前不是第一页，自动回退
      if (data.items.length === 0 && page > 1) {
        setPage(p => p - 1);
        return;
      }
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [scope.connectionId, scope.database, scope.schema, filterTab, page, pageSize]);

  // filterTab / scope 变化时重置 page=1
  useEffect(() => {
    setPage(1);
  }, [filterTab, scope.connectionId, scope.database, scope.schema]);

  // load 引用变化时触发加载（load 的 useCallback 已包含所有相关依赖）
  useEffect(() => {
    load();
  }, [load]);

  const filtered = metrics.filter(m =>
    !search || m.display_name.includes(search) || m.name.includes(search)
  );

  const toggleSelect = (id: number) => {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const allSelected = filtered.length > 0 && filtered.every(m => selected.has(m.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map(m => m.id)));

  const doDelete = async (ids: number[]) => {
    const toDelete = metrics.filter(m => ids.includes(m.id));
    const skipConfirm = toDelete.length === 1 && isBlankMetric(toDelete[0]);

    if (!skipConfirm) {
      const msg = ids.length === 1
        ? `确定要删除指标「${toDelete[0]?.display_name}」吗？此操作不可撤销。`
        : `确定要删除选中的 ${ids.length} 个指标吗？此操作不可撤销。`;
      const ok = await confirm({
        title: '删除指标',
        message: msg,
        variant: 'danger',
        confirmLabel: '删除',
      });
      if (!ok) return;
    }

    for (const id of ids) {
      try {
        await deleteMetric(id, `metric_${id}`, parentNodeId ?? undefined);
        closeMetricTabById(id);
      } catch (e: any) {
        setError(e?.message ?? '删除失败');
        return;
      }
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

  const doCreate = () => {
    const scopeTitle = scope.schema && scope.database
      ? `${scope.database}.${scope.schema}`
      : scope.database ?? '新指标';
    openNewMetricTab(scope, scopeTitle);
  };

  const [showTablePicker, setShowTablePicker] = useState(false);

  const handleAiConfirm = async (tableNames: string[], goToTasks: boolean) => {
    setShowTablePicker(false);
    setGenInfo(null);
    try {
      await invoke<string>('ai_generate_metrics', {
        connectionId: scope.connectionId,
        database: scope.database ?? null,
        schema: scope.schema ?? null,
        tableNames,
      });
      // Rust 已将任务写入 SQLite，等待刷新完成后再接收后续事件（防止 log 事件丢失）
      await useTaskStore.getState().loadTasks();
      if (goToTasks) {
        useTaskStore.getState().setVisible(true);
      } else {
        setGenInfo('AI 生成任务已启动，完成后指标将自动刷新。');
      }
    } catch (e: any) {
      setError(typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)));
    }
  };

  useEffect(() => {
    const respondedIds = new Set<string>();
    return useTaskStore.subscribe((state) => {
      const relevant = state.tasks.find(t =>
        t.type === 'ai_generate_metrics' &&
        (t.status === 'completed' || t.status === 'failed') &&
        !respondedIds.has(t.id) &&
        t.connectionId === scope.connectionId &&
        (t.database ?? undefined) === (scope.database ?? undefined) &&
        (t.schema ?? undefined) === (scope.schema ?? undefined)
      );
      if (relevant) {
        respondedIds.add(relevant.id);
        load();
        if (parentNodeId) useMetricsTreeStore.getState().refreshNode(parentNodeId);
      }
    });
  }, [scope.connectionId, scope.database, scope.schema, load]);

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
    <div className="flex flex-col h-full bg-[#080d12] text-white">
      {/* 过滤栏 */}
      <div className="flex items-center gap-2 px-4 h-10 border-b border-[#1e2d42] flex-wrap flex-shrink-0">
        {/* 分页控件 */}
        <button
          className="flex items-center justify-center w-6 h-6 rounded text-[#7a9bb8] hover:bg-[#1a2a3a] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
          onClick={() => setPage(1)}
          disabled={page <= 1}
          title="首页"
        ><ChevronFirst size={13} /></button>
        <button
          className="flex items-center justify-center w-6 h-6 rounded text-[#7a9bb8] hover:bg-[#1a2a3a] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
          onClick={() => setPage(p => p - 1)}
          disabled={page <= 1}
          title="上一页"
        ><ChevronLeft size={13} /></button>
        <span className="text-xs text-[#a0b4c8] px-1">{page}</span>
        <button
          className="flex items-center justify-center w-6 h-6 rounded text-[#7a9bb8] hover:bg-[#1a2a3a] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
          onClick={() => setPage(p => p + 1)}
          disabled={rowCount < pageSize}
          title="下一页"
        ><ChevronRight size={13} /></button>
        <span className="text-xs text-[#4a6a8a]">{pageSize}行/页</span>
        <button
          className="flex items-center justify-center w-6 h-6 rounded text-[#7a9bb8] hover:bg-[#1a2a3a] hover:text-white"
          onClick={load}
          title="刷新"
        ><RefreshCw size={12} /></button>
        <div className="w-px h-4 bg-[#1e2d42] mx-1" />
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
          className="w-40 bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1 text-xs
                     text-white placeholder-[#4a6a8a] focus:outline-none focus:border-[#00c9a7]"
          placeholder="搜索指标名称..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
        <button
          className="flex items-center gap-1 px-2 py-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded
                     text-xs text-[#a0b4c8] hover:border-[#00c9a7] hover:text-[#00c9a7]"
          onClick={doCreate}
        ><Plus size={12} /> 新增</button>
        <button
          className="flex items-center gap-1 px-2 py-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded
                     text-xs text-[#a0b4c8] hover:border-[#00c9a7] hover:text-[#00c9a7]"
          onClick={() => setShowTablePicker(true)}
        ><Sparkles size={12} /> AI 生成</button>
      </div>

      {/* 表格 */}
      <div className="flex-1 overflow-auto">
        {error && <div className="px-4 py-2 text-xs text-red-400">{error}</div>}
        {genInfo && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-[#00c9a7] bg-[#0a1f18] border-b border-[#0d3d2e]">
            <Sparkles size={12} className="flex-shrink-0" />
            <span className="flex-1">{genInfo}</span>
            <button
              className="flex items-center gap-1 text-[#00c9a7] hover:text-[#00b090] underline underline-offset-2 flex-shrink-0"
              onClick={() => { setGenInfo(null); useTaskStore.getState().setVisible(true); }}
            >
              <ListTodo size={12} />
              查看任务
            </button>
            <button
              className="text-[#7a9bb8] hover:text-white flex-shrink-0 ml-1"
              onClick={() => setGenInfo(null)}
              aria-label="关闭"
            >×</button>
          </div>
        )}
        <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
          <thead className="sticky top-0 bg-[#0d1117] z-10">
            <tr>
              <th className="w-8 border-b border-r border-[#1e2d42] text-[#7a9bb8] font-normal">
                <div className="flex items-center justify-center h-full py-1.5">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-[#00c9a7] block" />
                </div>
              </th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">显示名称</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">关联表</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">聚合</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">类型</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">状态</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal text-right">操作</th>
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
              <tr key={m.id} className="hover:bg-[#1a2639] border-b border-[#1e2d42] group">
                <td className="border-r border-[#1e2d42]">
                  <div className="flex items-center justify-center py-1.5">
                    <input type="checkbox" checked={selected.has(m.id)}
                      onChange={() => toggleSelect(m.id)} className="accent-[#00c9a7] block" />
                  </div>
                </td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42] text-white font-medium">{m.display_name}</td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42] text-[#a0b4c8]">{m.table_name || '-'}</td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42] text-[#a0b4c8]">{m.aggregation ?? '-'}</td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42]">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                    m.metric_type === 'composite' ? 'bg-[#2d1a4a] text-[#c084fc]' : 'bg-[#1a2a3a] text-[#7a9bb8]'
                  }`}>
                    {m.metric_type === 'composite' ? '复合' : '原子'}
                  </span>
                </td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42]">{statusBadge(m.status)}</td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42]">
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      className="flex items-center justify-center text-[#7a9bb8] hover:text-white"
                      onClick={() => onOpenMetric?.(m.id, m.display_name)}
                      title="编辑"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="flex items-center justify-center text-red-400 hover:text-red-300"
                      onClick={() => doDelete([m.id])}
                      title="删除"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 状态栏 */}
      <div className="flex items-center px-4 h-7 bg-[#080d12] border-t border-[#1e2d42] flex-shrink-0">
        <span className="text-xs text-[#7a9bb8]">
          {search ? filtered.length : rowCount} 行 · {durationMs}ms
        </span>
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

      {showTablePicker && (
        <TablePickerModal
          connectionId={scope.connectionId}
          database={scope.database}
          schema={scope.schema}
          onConfirm={handleAiConfirm}
          onClose={() => setShowTablePicker(false)}
        />
      )}
    </div>
  );
}
