import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Trash2, Pencil, Plus, Sparkles, ListTodo, ChevronFirst, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Metric, MetricPageResult, MetricScope, MetricStatus } from '../../types';
import { useMetricsTreeStore } from '../../store/metricsTreeStore';
import { useConfirmStore } from '../../store/confirmStore';
import { useQueryStore } from '../../store/queryStore';
import { useTaskStore } from '../../store/taskStore';
import { TablePickerModal } from './TablePickerModal';
import { DropdownSelect } from '../common/DropdownSelect';
import { Tooltip } from '../common/Tooltip';

interface Props {
  scope: MetricScope;
  onOpenMetric?: (metricId: number, title: string) => void;
}

type FilterTab = 'all' | MetricStatus;

/** 判断是否为从未填写过内容的空白指标 */
function isBlankMetric(m: Metric, t: (key: string) => string): boolean {
  return m.display_name === t('metricsExplorer.newMetric') && !m.table_name && !m.description;
}

export function MetricListPanel({ scope, onOpenMetric }: Props) {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [genInfo, setGenInfo] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [rowCount, setRowCount] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
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
      setTotalRows(data.total_rows);
      setDurationMs(data.duration_ms);

      // 空页回退：若拿到空列表且当前不是第一页，自动回退
      if (data.items.length === 0 && page > 1) {
        setPage(p => p - 1);
        return;
      }
    } catch (e: any) {
      setError(e?.message ?? t('metricsExplorer.metricTab.loadFailed'));
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
    const skipConfirm = toDelete.length === 1 && isBlankMetric(toDelete[0], t);

    if (!skipConfirm) {
      const msg = ids.length === 1
        ? t('metricsExplorer.metricList.confirmDelete', { name: toDelete[0]?.display_name })
        : t('metricsExplorer.metricList.confirmDeleteMulti', { count: ids.length });
      const ok = await confirm({
        title: t('metricsExplorer.metricList.deleteTitle'),
        message: msg,
        variant: 'danger',
        confirmLabel: t('metricsExplorer.metricList.delete'),
      });
      if (!ok) return;
    }

    for (const id of ids) {
      try {
        await deleteMetric(id, `metric_${id}`, parentNodeId ?? undefined);
        closeMetricTabById(id);
      } catch (e: any) {
        setError(e?.message ?? t('metricsExplorer.metricList.deleteFailed'));
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
      : scope.database ?? t('metricsExplorer.newMetric');
    openNewMetricTab(scope, scopeTitle);
  };

  const [showTablePicker, setShowTablePicker] = useState(false);

  const handleAiConfirm = async (tableNames: string[], goToTasks: boolean) => {
    setShowTablePicker(false);
    setGenInfo(null);
    try {
      const taskId = await invoke<string>('ai_generate_metrics', {
        connectionId: scope.connectionId,
        database: scope.database ?? null,
        schema: scope.schema ?? null,
        tableNames,
      });
      // 立即将 stub 放入 store，防止进度事件在 loadTasks 完成前到达时被静默丢弃
      useTaskStore.getState()._addTaskStub({
        id: taskId,
        type: 'ai_generate_metrics',
        status: 'running',
        title: `AI 生成指标 · ${scope.database ?? 'default'}`,
        progress: 0,
        processedRows: 0,
        totalRows: null,
        currentTarget: '',
        error: null,
        errorDetails: [],
        outputPath: null,
        description: null,
        startTime: new Date().toISOString(),
        endTime: null,
        connectionId: scope.connectionId,
        database: scope.database,
        schema: scope.schema,
      });
      // 再从 SQLite 同步完整信息（合并时会保留内存 progress）
      await useTaskStore.getState().loadTasks();
      if (goToTasks) {
        useTaskStore.getState().setVisible(true);
      } else {
        setGenInfo(t('metricsExplorer.metricList.aiTaskStarted'));
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
      approved: { cls: 'bg-[#0d3d2e] text-[#00c9a7]', label: `✅ ${t('metricsExplorer.metricList.statusApproved')}` },
      rejected: { cls: 'bg-[#3d1a1a] text-[#f87171]', label: `❌ ${t('metricsExplorer.metricList.statusRejected')}` },
      draft:    { cls: 'bg-[#1e2d42] text-[#7a9bb8]',  label: `📝 ${t('metricsExplorer.metricList.statusDraft')}` },
    };
    const s = map[status];
    return <span className={`px-1.5 py-0.5 rounded text-[10px] ${s.cls}`}>{s.label}</span>;
  };

  const totalPages = useMemo(() => Math.max(1, Math.ceil(totalRows / pageSize)), [totalRows, pageSize]);

  const pageOptions = useMemo(() =>
    Array.from({ length: Math.min(totalPages, 500) }, (_, i) => ({
      value: String(i + 1),
      label: String(i + 1),
    })),
  [totalPages]);

  const PAGE_SIZE_OPTIONS = [
    { value: '100', label: '100' },
    { value: '200', label: '200' },
    { value: '500', label: '500' },
    { value: '1000', label: '1000' },
  ];

  const handlePageSizeChange = (v: string) => {
    setPage(1);
    setPageSize(Number(v));
  };

  const TABS: { key: FilterTab; label: string }[] = [
    { key: 'all', label: t('metricsExplorer.metricList.all') },
    { key: 'draft', label: t('metricsExplorer.metricList.draft') },
    { key: 'approved', label: t('metricsExplorer.metricList.approved') },
    { key: 'rejected', label: t('metricsExplorer.metricList.rejected') },
  ];

  return (
    <div className="flex flex-col h-full bg-[#080d12] text-white">
      {/* 过滤栏 */}
      <div className="flex items-center gap-2 px-4 h-10 border-b border-[#1e2d42] flex-wrap flex-shrink-0">
        {/* 分页控件 */}
        <Tooltip content={t('metricsExplorer.metricList.firstPage')} className="contents">
          <button
            className="flex items-center justify-center w-6 h-6 rounded text-[#7a9bb8] hover:bg-[#1a2a3a] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={() => setPage(1)}
            disabled={page <= 1}
          ><ChevronFirst size={13} /></button>
        </Tooltip>
        <Tooltip content={t('metricsExplorer.metricList.prevPage')} className="contents">
          <button
            className="flex items-center justify-center w-6 h-6 rounded text-[#7a9bb8] hover:bg-[#1a2a3a] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={() => setPage(p => p - 1)}
            disabled={page <= 1}
          ><ChevronLeft size={13} /></button>
        </Tooltip>
        <DropdownSelect
          value={String(page)}
          options={pageOptions}
          onChange={v => setPage(Number(v))}
          plain
        />
        <span className="text-xs text-[#4a6a8a]">/ {totalPages}</span>
        <Tooltip content={t('metricsExplorer.metricList.nextPage')} className="contents">
          <button
            className="flex items-center justify-center w-6 h-6 rounded text-[#7a9bb8] hover:bg-[#1a2a3a] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={() => setPage(p => p + 1)}
            disabled={page >= totalPages}
          ><ChevronRight size={13} /></button>
        </Tooltip>
        <Tooltip content={t('tableDataView.lastPage')} className="contents">
          <button
            className="flex items-center justify-center w-6 h-6 rounded text-[#7a9bb8] hover:bg-[#1a2a3a] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed text-xs"
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages}
          >&gt;|</button>
        </Tooltip>
        <DropdownSelect
          value={String(pageSize)}
          options={PAGE_SIZE_OPTIONS}
          onChange={handlePageSizeChange}
          plain
        />
        <span className="text-xs text-[#4a6a8a]">{t('metricsExplorer.metricList.rowsPerPage')}</span>
        <Tooltip content={t('metricsExplorer.refresh')} className="contents">
          <button
            className="flex items-center justify-center w-6 h-6 rounded text-[#7a9bb8] hover:bg-[#1a2a3a] hover:text-white"
            onClick={load}
          ><RefreshCw size={12} /></button>
        </Tooltip>
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
          placeholder={t('metricsExplorer.metricList.searchPlaceholder')}
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
        <button
          className="flex items-center gap-1 px-2 py-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded
                     text-xs text-[#a0b4c8] hover:border-[#00c9a7] hover:text-[#00c9a7]"
          onClick={doCreate}
        ><Plus size={12} /> {t('metricsExplorer.metricList.add')}</button>
        <button
          className="flex items-center gap-1 px-2 py-1 bg-[#1a2a3a] border border-[#2a3f5a] rounded
                     text-xs text-[#a0b4c8] hover:border-[#00c9a7] hover:text-[#00c9a7]"
          onClick={() => setShowTablePicker(true)}
        ><Sparkles size={12} /> {t('metricsExplorer.metricList.aiGenerate')}</button>
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
              {t('metricsExplorer.metricList.viewTasks')}
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
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">{t('metricsExplorer.metricList.displayName')}</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">{t('metricsExplorer.metricList.relatedTable')}</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">{t('metricsExplorer.metricList.relatedColumn')}</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">{t('metricsExplorer.metricList.aggregation')}</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">{t('metricsExplorer.metricList.type')}</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">{t('metricsExplorer.metricList.status')}</th>
              <th className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal text-right">{t('metricsExplorer.metricList.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="text-center py-8 text-[#7a9bb8]">{t('metricsExplorer.loading')}</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="text-center py-8 text-[#4a6a8a]">{t('metricsExplorer.metricList.noMetrics')}</td></tr>
            )}
            {filtered.map(m => (
              <tr key={m.id} className="hover:bg-[#1a2639] border-b border-[#1e2d42] group cursor-pointer" onClick={() => toggleSelect(m.id)}>
                <td className="border-r border-[#1e2d42]">
                  <div className="flex items-center justify-center py-1.5">
                    <input type="checkbox" checked={selected.has(m.id)}
                      onChange={() => toggleSelect(m.id)} onClick={e => e.stopPropagation()} className="accent-[#00c9a7] block" />
                  </div>
                </td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42] text-white font-medium">{m.display_name}</td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42] text-[#a0b4c8]">{m.table_name || '-'}</td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42] text-[#a0b4c8]">{m.column_name || '-'}</td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42] text-[#a0b4c8]">{m.aggregation ?? '-'}</td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42]">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                    m.metric_type === 'composite' ? 'bg-[#2d1a4a] text-[#c084fc]' : 'bg-[#1a2a3a] text-[#7a9bb8]'
                  }`}>
                    {m.metric_type === 'composite' ? t('metricsExplorer.metricList.typeComposite') : t('metricsExplorer.metricList.typeAtomic')}
                  </span>
                </td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42]">{statusBadge(m.status)}</td>
                <td className="px-3 py-1.5 border-r border-[#1e2d42]" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center gap-2 justify-end">
                    <Tooltip content={t('metricsExplorer.metricList.edit')} className="contents">
                      <button
                        className="flex items-center justify-center text-[#7a9bb8] hover:text-white"
                        onClick={() => onOpenMetric?.(m.id, m.display_name)}
                      >
                        <Pencil size={12} />
                      </button>
                    </Tooltip>
                    <Tooltip content={t('metricsExplorer.metricList.delete')} className="contents">
                      <button
                        className="flex items-center justify-center text-red-400 hover:text-red-300"
                        onClick={() => doDelete([m.id])}
                      >
                        <Trash2 size={12} />
                      </button>
                    </Tooltip>
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
          {search ? filtered.length : rowCount} {t('metricsExplorer.metricList.rows')} · {durationMs}ms
        </span>
      </div>

      {/* 批量操作栏 */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-[#1a2a3a] border-t border-[#2a3f5a] text-xs flex-shrink-0">
          <span className="text-[#7a9bb8]">{t('metricsExplorer.metricList.selected', { count: selected.size })}</span>
          <button className="text-red-400 hover:text-red-300" onClick={() => doDelete([...selected])}>{t('metricsExplorer.metricList.batchDelete')}</button>
          <button className="text-[#00c9a7] hover:text-[#00b090]" onClick={() => doSetStatus([...selected], 'approved')}>{t('metricsExplorer.metricList.batchApprove')}</button>
          <button className="text-[#f87171] hover:text-red-300" onClick={() => doSetStatus([...selected], 'rejected')}>{t('metricsExplorer.metricList.batchReject')}</button>
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
