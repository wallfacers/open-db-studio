import React, { useState } from 'react';
import { Activity, X, RefreshCw, Search } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';
import { MetricsTree } from './MetricsTree';
import { useMetricsTreeStore } from '../../store/metricsTreeStore';
import { useQueryStore } from '../../store/queryStore';
import type { MetricScope } from '../../types';

export interface MetricsSidebarProps {
  sidebarWidth: number;
  onResize: (e: React.MouseEvent) => void;
}

export function MetricsSidebar({ sidebarWidth, onResize }: MetricsSidebarProps) {
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
      className="flex flex-col bg-[#0d1117] border-r border-[#1e2d42] flex-shrink-0 relative"
      style={{ width: sidebarWidth }}
    >
      {/* resize 拖拽条 */}
      <div
        className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#00c9a7] z-20 transition-colors"
        onMouseDown={onResize}
      />

      {/* 标题栏 */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-[#00c9a7]" />
          <span className="font-medium text-[#c8daea]">业务指标</span>
        </div>
        <div className="flex items-center space-x-2 text-[#7a9bb8]">
          <Tooltip content="刷新">
            <RefreshCw
              size={16}
              className="cursor-pointer hover:text-[#c8daea]"
              onClick={() => refresh()}
            />
          </Tooltip>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="p-2 border-b border-[#1e2d42]">
        <div className="flex items-center bg-[#151d28] border border-[#2a3f5a] rounded px-2 py-1 focus-within:border-[#00a98f] transition-colors">
          <Search size={14} className="text-[#7a9bb8] mr-1 flex-shrink-0" />
          <input
            type="text"
            placeholder="搜索指标..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="bg-transparent border-none outline-none text-[#c8daea] w-full text-xs placeholder-[#7a9bb8]"
          />
          {searchQuery && (
            <button
              className="text-[#7a9bb8] ml-1 hover:text-[#c8daea] flex-shrink-0"
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
