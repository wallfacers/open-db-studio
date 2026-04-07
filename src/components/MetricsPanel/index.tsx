import React, { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BarChart2, Plus, Check, X, Trash2, Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../common/Tooltip';

interface Metric {
  id: number;
  connection_id: number;
  name: string;
  display_name: string;
  table_name: string;
  column_name?: string;
  aggregation?: string;
  filter_sql?: string;
  description?: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

interface MetricsPanelProps {
  connectionId: number | null;
}

type StatusFilter = 'all' | 'draft' | 'approved' | 'rejected';

const statusBadge = (status: string) => {
  switch (status) {
    case 'approved':
      return 'bg-accent-subtle text-accent border border-accent/30';
    case 'rejected':
      return 'bg-error-subtle text-error border border-error/30';
    default:
      return 'bg-border-default text-foreground-muted border border-border-strong';
  }
};

export const MetricsPanel: React.FC<MetricsPanelProps> = ({ connectionId }) => {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const loadMetrics = useCallback(async () => {
    if (connectionId === null) return;
    setIsLoading(true);
    try {
      const statusArg = filter === 'all' ? undefined : filter;
      const result = await invoke<Metric[]>('list_metrics', {
        connectionId,
        status: statusArg,
      });
      setMetrics(result);
    } catch (err) {
      console.warn('[MetricsPanel] list_metrics error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [connectionId, filter]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  const handleAiGenerate = async () => {
    if (connectionId === null) return;
    setIsGenerating(true);
    try {
      await invoke<Metric[]>('ai_generate_metrics', { connectionId });
      await loadMetrics();
    } catch (err) {
      console.warn('[MetricsPanel] ai_generate_metrics error:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleApprove = async (id: number) => {
    try {
      await invoke('set_metric_status', { id, status: 'approved' });
      await loadMetrics();
    } catch (err) {
      console.warn('[MetricsPanel] approve error:', err);
    }
  };

  const handleReject = async (id: number) => {
    try {
      await invoke('set_metric_status', { id, status: 'rejected' });
      await loadMetrics();
    } catch (err) {
      console.warn('[MetricsPanel] reject error:', err);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await invoke('delete_metric', { id });
      await loadMetrics();
    } catch (err) {
      console.warn('[MetricsPanel] delete error:', err);
    }
  };

  const filteredMetrics = filter === 'all'
    ? metrics
    : metrics.filter(m => m.status === filter);

  if (connectionId === null) {
    return (
      <div className="flex-1 flex flex-col min-w-0 bg-background-panel items-center justify-center">
        <BarChart2 size={40} className="text-border-strong mb-3" />
        <p className="text-foreground-muted text-sm">{t('metricsExplorer.noConnections')}</p>
      </div>
    );
  }

  // Status label helper
  const statusLabel = (status: string) => {
    switch (status) {
      case 'approved': return t('metricsExplorer.metricList.statusApproved');
      case 'rejected': return t('metricsExplorer.metricList.statusRejected');
      default: return t('metricsExplorer.metricList.statusDraft');
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background-panel overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border-default flex-shrink-0">
        <div className="flex items-center gap-2">
          <BarChart2 size={18} className="text-accent" />
          <h2 className="text-foreground font-semibold text-base">{t('metricsExplorer.title')}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleAiGenerate}
            disabled={isGenerating}
            className="flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground-default transition-colors px-3 py-1.5 bg-background-hover hover:bg-border-strong rounded border border-border-strong disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGenerating
              ? <Loader2 size={13} className="animate-spin" />
              : <Sparkles size={13} />
            }
            {t('metricsExplorer.metricList.aiGenerate')}
          </button>
          <button
            onClick={() => {/* TODO: open create dialog */}}
            className="flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground-default transition-colors px-3 py-1.5 bg-background-hover hover:bg-border-strong rounded border border-border-strong"
          >
            <Plus size={13} />
            {t('metricsExplorer.metricList.add')}
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex border-b border-border-default flex-shrink-0 px-6">
        {(['all', 'draft', 'approved', 'rejected'] as const).map((tab) => {
          const labelMap: Record<StatusFilter, string> = {
            all: t('metricsExplorer.metricList.all'),
            draft: t('metricsExplorer.metricList.draft'),
            approved: t('metricsExplorer.metricList.approved'),
            rejected: t('metricsExplorer.metricList.rejected'),
          };
          return (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-4 py-2.5 text-sm transition-colors ${
                filter === tab
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-foreground-muted hover:text-foreground-default'
              }`}
            >
              {labelMap[tab]}
            </button>
          );
        })}
      </div>

      {/* Metrics List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={24} className="animate-spin text-foreground-muted" />
          </div>
        ) : filteredMetrics.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-foreground-muted text-sm">
            <BarChart2 size={28} className="mb-2 text-border-strong" />
            {t('metricsExplorer.metricList.noMetrics')}
          </div>
        ) : (
          <div className="divide-y divide-border-default">
            {filteredMetrics.map((metric) => (
              <div
                key={metric.id}
                className="flex items-center px-6 py-3 hover:bg-background-base transition-colors group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-foreground-default text-sm font-medium truncate">
                      {metric.display_name}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${statusBadge(metric.status)}`}>
                      {statusLabel(metric.status)}
                    </span>
                    {metric.source === 'ai' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-info-subtle text-data-indigo border border-data-indigo/30 flex-shrink-0">
                        AI
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-foreground-muted">
                    <span>{metric.table_name}</span>
                    {metric.aggregation && (
                      <>
                        <span className="text-border-strong">·</span>
                        <span>{metric.aggregation}</span>
                      </>
                    )}
                    {metric.column_name && (
                      <>
                        <span className="text-border-strong">·</span>
                        <span>{metric.column_name}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Row Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-3 flex-shrink-0">
                  {metric.status === 'draft' && (
                    <>
                      <Tooltip content={t('metricsExplorer.metricsTree.open')} className="contents">
                        <button
                          onClick={() => handleApprove(metric.id)}
                          className="p-1.5 rounded text-foreground-muted hover:text-accent hover:bg-accent-subtle transition-colors"
                        >
                          <Check size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip content={t('metricsExplorer.metricList.rejected')} className="contents">
                        <button
                          onClick={() => handleReject(metric.id)}
                          className="p-1.5 rounded text-foreground-muted hover:text-error hover:bg-error-subtle transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </Tooltip>
                    </>
                  )}
                  <Tooltip content={t('metricsExplorer.metricList.delete')} className="contents">
                    <button
                      onClick={() => handleDelete(metric.id)}
                      className="p-1.5 rounded text-foreground-muted hover:text-error hover:bg-error-subtle transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
