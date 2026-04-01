import React, { useState } from 'react';
import { Activity, X, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../common/Tooltip';
import { MetricsTree } from './MetricsTree';
import { useMetricsTreeStore } from '../../store/metricsTreeStore';
import { useQueryStore } from '../../store/queryStore';
import type { MetricScope } from '../../types';

export interface MetricsSidebarProps {
  sidebarWidth: number;
  onResize: (e: React.MouseEvent) => void;
  hidden?: boolean;
}

export function MetricsSidebar({ sidebarWidth, onResize, hidden }: MetricsSidebarProps) {
  const { t } = useTranslation();
  const { refresh } = useMetricsTreeStore();
  const [searchQuery, setSearchQuery] = useState('');

  const handleOpenMetricTab = (metricId: number, title: string, connectionId?: number) => {
    useQueryStore.getState().openMetricTab(metricId, title, connectionId);
  };

  const handleOpenMetricListTab = (scope: MetricScope, title: string) => {
    useQueryStore.getState().openMetricListTab(scope, title);
  };

  return (
    <div
      className="flex flex-col bg-[var(--background-base)] border-r border-[var(--border-default)] flex-shrink-0 relative"
      style={{ width: sidebarWidth, display: hidden ? 'none' : undefined }}
    >
      {/* resize 拖拽条 */}
      <div
        className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent)] z-20 transition-colors"
        onMouseDown={onResize}
      />

      {/* 标题栏 */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[var(--border-default)] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-[var(--accent)]" />
          <span className="font-medium text-[var(--foreground-default)]">{t('metricsExplorer.metricsSidebar.title')}</span>
        </div>
        <div className="flex items-center space-x-2 text-[var(--foreground-muted)]">
          <Tooltip content={t('metricsExplorer.refresh')}>
            <RefreshCw
              size={16}
              className="cursor-pointer hover:text-[var(--foreground-default)]"
              onClick={() => refresh()}
            />
          </Tooltip>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="p-2 border-b border-[var(--border-default)]">
        <div className="flex items-center bg-[var(--background-elevated)] border border-[var(--border-strong)] rounded px-2 py-1 focus-within:border-[var(--accent-hover)] transition-colors">
          <Search size={14} className="text-[var(--foreground-muted)] mr-1 flex-shrink-0" />
          <input
            type="text"
            placeholder={t('metricsExplorer.searchPlaceholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="bg-transparent border-none outline-none text-[var(--foreground-default)] w-full text-xs placeholder-[var(--foreground-muted)]"
          />
          {searchQuery && (
            <button
              className="text-[var(--foreground-muted)] ml-1 hover:text-[var(--foreground-default)] flex-shrink-0"
              onClick={() => setSearchQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* 指标树 */}
      <MetricsTree
        searchQuery={searchQuery}
        onOpenMetricTab={handleOpenMetricTab}
        onOpenMetricListTab={handleOpenMetricListTab}
      />
    </div>
  );
}
