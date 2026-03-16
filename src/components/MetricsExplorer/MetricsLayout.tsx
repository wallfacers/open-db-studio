import React, { useState, useCallback } from 'react';
import { MetricsTree } from './MetricsTree';
import { MetricTab } from './MetricTab';
import { MetricListPanel } from './MetricListPanel';
import { BarChart2, X, GitMerge, TableProperties } from 'lucide-react';
import type { MetricScope } from '../../types';

type MetricsTabType = 'metric' | 'metric_list';

interface MetricsTab {
  id: string;
  type: MetricsTabType;
  title: string;
  metricId?: number;
  metricScope?: MetricScope;
}

/** 自包含的指标布局：左侧树 + 右侧 Tab 内容区 */
export function MetricsLayout() {
  const [tabs, setTabs] = useState<MetricsTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isResizing, setIsResizing] = useState(false);

  const openMetricTab = useCallback((metricId: number, title: string) => {
    setTabs(prev => {
      const existing = prev.find(t => t.type === 'metric' && t.metricId === metricId);
      if (existing) { setActiveTabId(existing.id); return prev; }
      const id = `metric_${metricId}`;
      const tab: MetricsTab = { id, type: 'metric', title, metricId };
      setActiveTabId(id);
      return [...prev, tab];
    });
  }, []);

  const openMetricListTab = useCallback((scope: MetricScope, title: string) => {
    const id = `ml_${scope.connectionId}_${scope.database ?? ''}_${scope.schema ?? ''}`;
    setTabs(prev => {
      const existing = prev.find(t => t.id === id);
      if (existing) { setActiveTabId(id); return prev; }
      const tab: MetricsTab = { id, type: 'metric_list', title, metricScope: scope };
      setActiveTabId(id);
      return [...prev, tab];
    });
  }, []);

  const closeTab = (tabId: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId) {
        const idx = prev.findIndex(t => t.id === tabId);
        setActiveTabId(next[Math.min(idx, next.length - 1)]?.id ?? null);
      }
      return next;
    });
  };

  // 侧边栏 resize
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      setSidebarWidth(Math.max(180, Math.min(480, startW + ev.clientX - startX)));
    };
    const onUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <div className="flex flex-1 overflow-hidden" style={{ userSelect: isResizing ? 'none' : undefined }}>
      {/* 左侧树 */}
      <div className="flex flex-col bg-[#111922] border-r border-[#1e2d42] flex-shrink-0 overflow-hidden"
        style={{ width: sidebarWidth }}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1e2d42] flex-shrink-0">
          <BarChart2 size={14} className="text-[#00c9a7]" />
          <span className="text-xs font-semibold text-[#a0b4c8] uppercase tracking-wider">业务指标</span>
        </div>
        <MetricsTree onOpenMetricTab={openMetricTab} onOpenMetricListTab={openMetricListTab} />
      </div>

      {/* resize 拖拽条 */}
      <div
        className="w-1 cursor-col-resize hover:bg-[#00c9a7] flex-shrink-0 transition-colors"
        style={{ background: isResizing ? '#00c9a7' : 'transparent' }}
        onMouseDown={handleMouseDown}
      />

      {/* 右侧内容区 */}
      <div className="flex flex-col flex-1 overflow-hidden bg-[#0d1821]">
        {tabs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-[#4a6a8a] text-sm">
            在左侧展开数据库，选择指标打开编辑
          </div>
        ) : (
          <>
            {/* Tab 栏 */}
            <div className="flex items-end border-b border-[#1e2d42] bg-[#0d1821] overflow-x-auto flex-shrink-0">
              {tabs.map(tab => (
                <div
                  key={tab.id}
                  className={`flex items-center gap-1.5 px-3 py-2 border-r border-[#1e2d42] cursor-pointer
                    text-xs whitespace-nowrap flex-shrink-0 select-none
                    ${tab.id === activeTabId
                      ? 'bg-[#111922] text-white border-t-2 border-t-[#00c9a7]'
                      : 'text-[#7a9bb8] hover:bg-[#111922] hover:text-white'}`}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  {tab.type === 'metric_list'
                    ? <TableProperties size={11} className="flex-shrink-0" />
                    : <BarChart2 size={11} className="flex-shrink-0" />}
                  <span className="max-w-[140px] truncate">{tab.title}</span>
                  <button
                    className="ml-1 opacity-50 hover:opacity-100 flex-shrink-0"
                    onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>

            {/* Tab 内容 */}
            <div className="flex-1 overflow-hidden">
              {activeTab?.type === 'metric' && activeTab.metricId && (
                <MetricTab metricId={activeTab.metricId} />
              )}
              {activeTab?.type === 'metric_list' && activeTab.metricScope && (
                <MetricListPanel
                  scope={activeTab.metricScope}
                  onOpenMetric={openMetricTab}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
