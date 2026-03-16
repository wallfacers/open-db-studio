import React, { useState, useCallback, useRef, useEffect } from 'react';
import { MetricsTree } from './MetricsTree';
import { MetricTab } from './MetricTab';
import { MetricListPanel } from './MetricListPanel';
import { BarChart2, X, GitMerge, TableProperties, RefreshCw, Search } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';
import { useMetricsTreeStore } from '../../store/metricsTreeStore';
import type { MetricScope } from '../../types';

type MetricsTabType = 'metric' | 'metric_list';

interface MetricsTab {
  id: string;
  type: MetricsTabType;
  title: string;
  metricId?: number;
  metricScope?: MetricScope;
}

interface TabContextMenu { tabId: string; x: number; y: number; }

const STORAGE_KEY = 'metrics_tabs_state';

function loadTabsState(): { tabs: MetricsTab[]; activeTabId: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { tabs: [], activeTabId: null };
}

function saveTabsState(tabs: MetricsTab[], activeTabId: string | null) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
}

/** 自包含的指标布局：左侧树 + 右侧 Tab 内容区 */
export function MetricsLayout() {
  const { init } = useMetricsTreeStore();
  const initial = loadTabsState();
  const [tabs, setTabs] = useState<MetricsTab[]>(initial.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initial.activeTabId);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [searchQuery, setSearchQuery] = useState('');
  const [isResizing, setIsResizing] = useState(false);
  const [contextMenu, setContextMenu] = useState<TabContextMenu | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

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

  const closeTabsLeft = (tabId: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === tabId);
      return prev.slice(idx);
    });
  };

  const closeTabsRight = (tabId: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === tabId);
      const next = prev.slice(0, idx + 1);
      if (activeTabId && !next.find(t => t.id === activeTabId)) {
        setActiveTabId(next[next.length - 1]?.id ?? null);
      }
      return next;
    });
  };

  const closeOtherTabs = (tabId: string) => {
    setTabs(prev => {
      const kept = prev.filter(t => t.id === tabId);
      setActiveTabId(tabId);
      return kept;
    });
  };

  const closeAllTabs = () => {
    setTabs([]);
    setActiveTabId(null);
  };

  // 持久化 Tab 状态
  useEffect(() => {
    saveTabsState(tabs, activeTabId);
  }, [tabs, activeTabId]);

  // 点击外部关闭右键菜单
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    if (contextMenu) window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [contextMenu]);

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
      <div className="flex flex-col bg-[#0d1117] border-r border-[#1e2d42] flex-shrink-0 relative"
        style={{ width: sidebarWidth }}>
        {/* resize 拖拽条：absolute 骑在 border 两侧，与 Explorer/Assistant 一致 */}
        <div
          className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#00c9a7] z-20 transition-colors"
          onMouseDown={handleMouseDown}
        />
        <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42] flex-shrink-0">
          <div className="flex items-center gap-2">
            <BarChart2 size={14} className="text-[#00c9a7]" />
            <span className="font-medium text-[#c8daea]">业务指标</span>
          </div>
          <div className="flex items-center space-x-2 text-[#7a9bb8]">
            <Tooltip content="刷新">
              <RefreshCw
                size={16}
                className="cursor-pointer hover:text-[#c8daea]"
                onClick={() => init()}
              />
            </Tooltip>
          </div>
        </div>
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
        <MetricsTree
          searchQuery={searchQuery}
          onOpenMetricTab={openMetricTab}
          onOpenMetricListTab={openMetricListTab}
        />
      </div>

      {/* 右侧内容区 */}
      <div className="flex flex-col flex-1 overflow-hidden bg-[#0d1821]">
        {tabs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-[#4a6a8a] text-sm">
            在左侧展开数据库，选择指标打开编辑
          </div>
        ) : (
          <>
            {/* Tab 栏 */}
            <div className="flex-shrink-0 h-10 flex items-start border-b border-[#1e2d42] bg-[#0d1821] overflow-x-auto no-scrollbar">
              {tabs.map(tab => (
                <div
                  key={tab.id}
                  className={`flex items-center gap-1.5 px-3 h-[38px] border-r border-[#1e2d42] cursor-pointer
                    text-xs whitespace-nowrap flex-shrink-0 select-none border-t-2
                    ${tab.id === activeTabId
                      ? 'bg-[#111922] text-white border-t-[#00c9a7]'
                      : 'text-[#7a9bb8] hover:bg-[#111922] hover:text-white border-t-transparent'}`}
                  onClick={() => setActiveTabId(tab.id)}
                  onContextMenu={e => { e.preventDefault(); setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY }); }}
                >
                  {tab.type === 'metric_list'
                    ? <TableProperties size={11} className="flex-shrink-0" />
                    : <BarChart2 size={11} className="flex-shrink-0" />}
                  <span className="max-w-[140px] truncate">{tab.title}</span>
                  <button
                    className="ml-1 opacity-50 hover:opacity-100 flex-shrink-0"
                    onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                  >
                    <X size={12} />
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
      {/* Tab 右键菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => { closeTab(contextMenu.tabId); setContextMenu(null); }}
          >关闭</button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={tabs.findIndex(t => t.id === contextMenu.tabId) === 0}
            onClick={() => { closeTabsLeft(contextMenu.tabId); setContextMenu(null); }}
          >关闭左侧</button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={tabs.findIndex(t => t.id === contextMenu.tabId) === tabs.length - 1}
            onClick={() => { closeTabsRight(contextMenu.tabId); setContextMenu(null); }}
          >关闭右侧</button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={tabs.length <= 1}
            onClick={() => { closeOtherTabs(contextMenu.tabId); setContextMenu(null); }}
          >关闭其他</button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => { closeAllTabs(); setContextMenu(null); }}
          >关闭全部</button>
        </div>
      )}
    </div>
  );
}
