import React, { useEffect, useState, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Save, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Metric, UpdateMetricPayload, ColumnMeta, MetricScope } from '../../types';
import { DropdownSelect } from '../common/DropdownSelect';
import { Tooltip } from '../common/Tooltip';
import { useMetricsTreeStore } from '../../store/metricsTreeStore';
import { useConfirmStore } from '../../store/confirmStore';
import { useUIObjectRegistry } from '../../mcp/ui/useUIObjectRegistry';
import { MetricFormUIObject } from '../../mcp/ui/adapters/MetricFormAdapter';
import { useMetricFormStore } from '../../store/metricFormStore';
import { metricsDbNodeId, metricsSchemaNodeId } from '../../utils/nodeId';

// -------- 预设分类标签 --------
const PRESET_CATEGORIES = [
  '用户分析', '交易指标', '营收', '留存', '转化',
  '增长', '运营', '风控', '产品', '供应链',
];

// -------- Tag 输入组件 --------
function TagInput({ value, onChange, t }: { value: string; onChange: (v: string) => void; t: (key: string) => string }) {
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
            >×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="flex-1 min-w-[80px] bg-transparent text-xs text-white outline-none placeholder-[#4a6a8a]"
          placeholder={tags.length === 0 ? t('metricsExplorer.metricTab.categoryPlaceholder') : ''}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => { if (input) addTag(input); }}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {PRESET_CATEGORIES.filter(t => !tags.includes(t)).map(tag => (
          <button
            key={tag}
            type="button"
            onClick={() => addTag(tag)}
            className="px-2 py-0.5 text-[10px] border border-[#2a3f5a] text-[#7a9bb8] rounded
                       hover:border-[#00c9a7] hover:text-[#00c9a7] transition-colors"
          >+ {tag}</button>
        ))}
      </div>
    </div>
  );
}

// -------- 主组件 --------
interface Props {
  metricId?: number;           // 存在 = 编辑模式；不存在 = 新建模式
  newMetricScope?: MetricScope; // 新建模式必填
  tabId?: string;              // 用于 UIObject 注册和 store 管理
  connectionId?: number;       // 关联的连接 ID
  onSaved?: (metricId: number, title: string) => void; // 新建模式保存后回调
  onDelete?: () => void;
}

const inputCls = 'w-full bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-[#00c9a7] transition-colors';
const labelCls = 'block text-xs text-[#7a9bb8] mb-1';

export function MetricTab({ metricId, newMetricScope, tabId, connectionId, onSaved, onDelete }: Props) {
  const { t } = useTranslation();
  const isCreateMode = !metricId && !!newMetricScope;

  const [metric, setMetric] = useState<Metric | null>(null);
  const [form, setForm] = useState<UpdateMetricPayload>({
    display_name: isCreateMode ? '' : undefined,
    metric_type: 'atomic',
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [columns, setColumns] = useState<ColumnMeta[]>([]);

  const refreshNode = useMetricsTreeStore(s => s.refreshNode);
  const notifyMetricAdded = useMetricsTreeStore(s => s.notifyMetricAdded);
  const confirm = useConfirmStore(s => s.confirm);

  const loadMetric = async () => {
    if (!metricId) return;
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
      if (m.scope_database) {
        try {
          const names = await invoke<string[]>('list_objects', {
            connectionId: m.connection_id,
            database: m.scope_database,
            schema: m.scope_schema ?? null,
            category: 'tables',
          });
          setTables(names);
        } catch (e: any) {
          setError(`${t('metricsExplorer.metricTab.loadTablesFailed')}: ${e?.message ?? e}`);
        }
      }
      if (m.table_name) {
        try {
          const detail = await invoke<{ columns: ColumnMeta[] }>('get_table_detail', {
            connectionId: m.connection_id,
            database: m.scope_database ?? null,
            schema: m.scope_schema ?? null,
            table: m.table_name,
          });
          setColumns(detail.columns);
        } catch (e: any) {
          setError(`${t('metricsExplorer.metricTab.loadColumnsFailed')}: ${e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      setError(e?.message ?? t('metricsExplorer.metricTab.loadFailed'));
    }
  };

  // 新建模式：加载该 scope 下的表列表供选择
  const loadTablesForCreate = async () => {
    if (!newMetricScope?.database) return;
    try {
      const names = await invoke<string[]>('list_objects', {
        connectionId: newMetricScope.connectionId,
        database: newMetricScope.database,
        schema: newMetricScope.schema ?? null,
        category: 'tables',
      });
      setTables(names);
    } catch {}
  };

  useEffect(() => {
    if (metricId) {
      loadMetric();
    } else if (isCreateMode) {
      loadTablesForCreate();
    }
  }, [metricId]);

  // ── MetricForm store 初始化 & UIObject 注册 ────────────────────────
  useEffect(() => {
    if (!tabId) return;
    useMetricFormStore.getState().initForm(tabId, {
      displayName: '',
      name: '',
      metricType: 'atomic',
      tableName: '',
      columnName: '',
      aggregation: 'COUNT',
      filterSql: '',
      category: '',
      description: '',
      connectionId,
    });
    return () => useMetricFormStore.getState().removeForm(tabId);
  }, [tabId, connectionId]);

  // 编辑模式加载完 metric 后同步到 metricFormStore
  useEffect(() => {
    if (!tabId || !metric) return;
    useMetricFormStore.getState().setForm(tabId, {
      metricId: metric.id,
      displayName: metric.display_name ?? '',
      name: metric.name ?? '',
      metricType: metric.metric_type ?? 'atomic',
      tableName: metric.table_name ?? '',
      columnName: metric.column_name ?? '',
      aggregation: metric.aggregation ?? '',
      filterSql: metric.filter_sql ?? '',
      category: metric.category ?? '',
      description: metric.description ?? '',
      connectionId: metric.connection_id ?? connectionId,
    });
  }, [tabId, metric, connectionId]);

  const metricUIObject = useMemo(() => {
    if (!tabId) return null;
    return new MetricFormUIObject(tabId, connectionId);
  }, [tabId, connectionId]);
  useUIObjectRegistry(metricUIObject);

  const handleTableChange = async (tableName: string) => {
    setForm(f => ({ ...f, table_name: tableName || undefined, column_name: undefined }));
    setColumns([]);
    if (!tableName) return;
    const connId = metric?.connection_id ?? newMetricScope?.connectionId;
    const db = metric?.scope_database ?? newMetricScope?.database;
    const sc = metric?.scope_schema ?? newMetricScope?.schema;
    if (!connId || !db) return;
    try {
      const detail = await invoke<{ columns: ColumnMeta[] }>('get_table_detail', {
        connectionId: connId,
        database: db,
        schema: sc ?? null,
        table: tableName,
      });
      setColumns(detail.columns);
    } catch {}
  };

  // 编辑模式保存
  const handleSave = async () => {
    if (!metricId) return;
    setSaving(true);
    setError(null);
    try {
      await invoke('update_metric', { id: metricId, input: form });
      await loadMetric();
    } catch (e: any) {
      setError(e?.message ?? t('metricsExplorer.metricTab.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // 新建模式保存（首次创建）
  const handleCreate = async () => {
    if (!newMetricScope) return;
    setSaving(true);
    setError(null);
    try {
      const displayName = (form.display_name as string | undefined)?.trim() || t('metricsExplorer.newMetric');
      const m = await invoke<Metric>('save_metric', {
        input: {
          connection_id: newMetricScope.connectionId,
          name: (form.name as string | undefined)?.trim() || `metric_${Date.now()}`,
          display_name: displayName,
          metric_type: form.metric_type ?? 'atomic',
          source: 'user',
          scope_database: newMetricScope.database ?? null,
          scope_schema: newMetricScope.schema ?? null,
          table_name: form.table_name ?? null,
          column_name: form.column_name ?? null,
          aggregation: form.aggregation ?? null,
          filter_sql: form.filter_sql ?? null,
          description: form.description ?? null,
          category: form.category ?? null,
          data_caliber: form.data_caliber ?? null,
          version: form.version ?? null,
        },
      });
      const parentNodeId = newMetricScope.schema
        ? metricsSchemaNodeId(newMetricScope.connectionId, newMetricScope.database!, newMetricScope.schema)
        : newMetricScope.database
          ? metricsDbNodeId(newMetricScope.connectionId, newMetricScope.database)
          : null;
      if (parentNodeId) await notifyMetricAdded(parentNodeId);
      onSaved?.(m.id, m.display_name);
    } catch (e: any) {
      setError(e?.message ?? t('metricsExplorer.metricTab.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!metric || !metricId) return;
    const isBlank = metric.display_name === t('metricsExplorer.newMetric') && !metric.table_name && !metric.description;
    if (!isBlank) {
      const ok = await confirm({
        title: t('metricsExplorer.metricTab.deleteTitle'),
        message: t('metricsExplorer.metricTab.confirmDelete', { name: metric.display_name }),
        variant: 'danger',
        confirmLabel: t('metricsExplorer.metricTab.delete'),
      });
      if (!ok) return;
    }
    setDeleting(true);
    setError(null);
    try {
      await invoke('delete_metric', { id: metricId });
      const parentNodeId = metric.scope_schema
        ? metricsSchemaNodeId(metric.connection_id, metric.scope_database!, metric.scope_schema)
        : metric.scope_database
          ? metricsDbNodeId(metric.connection_id, metric.scope_database)
          : null;
      if (parentNodeId) await refreshNode(parentNodeId);
      onDelete?.();
    } catch (e: any) {
      setError(e?.message ?? t('metricsExplorer.metricTab.deleteFailed'));
      setDeleting(false);
    }
  };

  const setValue = (key: keyof UpdateMetricPayload, value: string) =>
    setForm(f => ({ ...f, [key]: value || undefined }));

  // 编辑模式加载中
  if (!isCreateMode && !metric && !error) {
    return <div className="flex items-center justify-center h-full text-[#7a9bb8] text-sm">{t('metricsExplorer.loading')}</div>;
  }
  if (!isCreateMode && error && !metric) {
    return <div className="flex items-center justify-center h-full text-red-400 text-sm">{error}</div>;
  }

  const currentType = form.metric_type ?? metric?.metric_type ?? 'atomic';
  const headerTitle = isCreateMode ? t('metricsExplorer.metricTab.newMetric') : (metric?.display_name ?? '');

  return (
    <div className="flex flex-col h-full bg-[#111922] text-white overflow-hidden">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e2d42] flex-shrink-0">
        <span className="text-sm font-medium text-[#a0b4c8]">{headerTitle}</span>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-red-400">{error}</span>}
          {/* 编辑模式才显示删除按钮 */}
          {!isCreateMode && (
            <Tooltip content={t('metricsExplorer.metricTab.deleteTitle')} className="contents">
              <button
                className="flex items-center gap-1.5 px-3 py-1 bg-[#1a2a3a] border border-[#2a3f5a] text-red-400 text-xs rounded
                           hover:border-red-500 hover:text-red-300 disabled:opacity-50"
                onClick={handleDelete}
                disabled={deleting || saving}
              >
                <Trash2 size={12} />
                {deleting ? t('metricsExplorer.metricTab.deleting') : t('metricsExplorer.metricTab.delete')}
              </button>
            </Tooltip>
          )}
          <button
            className="flex items-center gap-1.5 px-3 py-1 bg-[#00c9a7] text-black text-xs rounded
                       hover:bg-[#00b090] disabled:opacity-50 font-medium"
            onClick={isCreateMode ? handleCreate : handleSave}
            disabled={saving || deleting}
          >
            <Save size={12} />
            {saving ? (isCreateMode ? t('metricsExplorer.metricTab.creating') : t('metricsExplorer.metricTab.saving')) : t('metricsExplorer.metricTab.save')}
          </button>
        </div>
      </div>

      {/* 表单区域 */}
      <div className="flex-1 overflow-y-auto py-6">
        <div className="max-w-xl mx-auto px-4 space-y-4">

          {/* 指标类型切换 */}
          <div>
            <label className={labelCls}>{t('metricsExplorer.metricTab.metricType')}</label>
            <div className="flex gap-4">
              {(['atomic', 'composite'] as const).map(mt => (
                <label key={mt} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    value={mt}
                    checked={currentType === mt}
                    onChange={() => setForm(f => ({ ...f, metric_type: mt }))}
                    className="accent-[#00c9a7]"
                  />
                  <span className="text-xs text-[#a0b4c8]">
                    {mt === 'atomic' ? t('metricsExplorer.metricTab.atomicMetric') : t('metricsExplorer.metricTab.compositeMetric')}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* 显示名称 */}
          <div>
            <label className={labelCls}>{t('metricsExplorer.metricTab.displayName')} <span className="text-red-400">*</span></label>
            <input
              className={inputCls}
              value={(form.display_name as string | undefined) ?? ''}
              onChange={e => setValue('display_name', e.target.value)}
            />
          </div>

          {/* 英文标识 */}
          <div>
            <label className={labelCls}>{t('metricsExplorer.metricTab.englishName')} <span className="text-red-400">*</span></label>
            <input
              className={inputCls}
              value={(form.name as string | undefined) ?? ''}
              onChange={e => setValue('name', e.target.value)}
            />
          </div>

          {/* 分类标签 */}
          <div>
            <label className={labelCls}>{t('metricsExplorer.metricTab.categoryTags')}</label>
            <TagInput
              value={(form.category as string | undefined) ?? ''}
              onChange={v => setForm(f => ({ ...f, category: v || undefined }))}
              t={t}
            />
          </div>

          {/* 版本号 */}
          <div>
            <label className={labelCls}>{t('metricsExplorer.metricTab.version')}</label>
            <input
              className={inputCls}
              value={(form.version as string | undefined) ?? ''}
              onChange={e => setValue('version', e.target.value)}
            />
          </div>

          {/* 原子指标专有字段 */}
          {currentType === 'atomic' && (
            <>
              <div>
                <label className={labelCls}>{t('metricsExplorer.metricTab.relatedTable')} <span className="text-red-400">*</span></label>
                <DropdownSelect
                  className="w-full"
                  value={form.table_name ?? ''}
                  placeholder={tables.length === 0 ? t('metricsExplorer.metricTab.noTables') : t('metricsExplorer.metricTab.selectTable')}
                  options={tables.map(tbl => ({ value: tbl, label: tbl }))}
                  onChange={handleTableChange}
                />
              </div>

              <div>
                <label className={labelCls}>{t('metricsExplorer.metricTab.relatedColumn')}</label>
                <DropdownSelect
                  className="w-full"
                  value={form.column_name ?? ''}
                  placeholder={columns.length === 0 ? t('metricsExplorer.metricTab.selectColumnFirst') : t('metricsExplorer.metricTab.selectColumn')}
                  options={columns.map(c => ({ value: c.name, label: `${c.name} (${c.data_type})` }))}
                  onChange={v => setValue('column_name', v)}
                />
              </div>

              <div>
                <label className={labelCls}>{t('metricsExplorer.metricTab.aggregationMethod')}</label>
                <DropdownSelect
                  className="w-full"
                  value={form.aggregation ?? metric?.aggregation ?? ''}
                  placeholder={t('metricsExplorer.metricTab.noAggregation')}
                  options={['SUM', 'COUNT', 'AVG', 'MAX', 'MIN', 'COUNT_DISTINCT'].map(a => ({ value: a, label: a }))}
                  onChange={v => setForm(f => ({ ...f, aggregation: v || undefined }))}
                />
              </div>
            </>
          )}

          {/* 描述 */}
          <div>
            <label className={labelCls}>{t('metricsExplorer.metricTab.description')}</label>
            <textarea
              className="w-full bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs
                         text-white focus:outline-none focus:border-[#00c9a7] transition-colors resize-none h-16"
              value={(form.description as string | undefined) ?? ''}
              onChange={e => setValue('description', e.target.value)}
            />
          </div>

          {/* 数据口径说明 */}
          <div>
            <label className={labelCls}>{t('metricsExplorer.metricTab.dataCaliber')}</label>
            <textarea
              className="w-full bg-[#1a2a3a] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs
                         text-white focus:outline-none focus:border-[#00c9a7] transition-colors resize-none h-16"
              value={(form.data_caliber as string | undefined) ?? ''}
              onChange={e => setValue('data_caliber', e.target.value)}
            />
          </div>

          {/* filter_sql（仅原子指标） */}
          {currentType === 'atomic' && (
            <div className="border border-[#2a3f5a] rounded overflow-hidden">
              <div className="px-3 py-1.5 bg-[#1a2a3a] border-b border-[#2a3f5a] text-xs text-[#7a9bb8]">
                {t('metricsExplorer.metricTab.filterSql')}
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

          {currentType === 'composite' && (
            <div className="p-3 bg-[#1a2a3a] border border-[#2a3f5a] rounded text-xs text-[#7a9bb8]">
              {t('metricsExplorer.metricTab.compositeComingSoon')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
