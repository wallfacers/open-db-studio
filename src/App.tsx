import React, { useState, useEffect } from 'react';
import { format as formatSql, type SqlLanguage } from 'sql-formatter';
import { useTranslation } from 'react-i18next';
import { ActivityBar } from './components/ActivityBar';
import { Explorer } from './components/Explorer';
import { MainContent } from './components/MainContent';
import { Assistant } from './components/Assistant';
import { AssistantToggleTab } from './components/Assistant/AssistantToggleTab';
import { Toast, type ToastLevel } from './components/Toast';
import { useToastStore } from './store/toastStore';
import { SettingsPage } from './components/Settings/SettingsPage';
import { TitleBar } from './components/TitleBar';
import { useQueryStore } from './store/queryStore';
import { useConnectionStore } from './store/connectionStore';
import { useAppStore } from './store/appStore';
import { useMcpBridge } from './hooks/useMcpBridge';
import { TaskCenter } from './components/TaskCenter';
import { MetricsSidebar } from './components/MetricsExplorer/MetricsSidebar';
import { flushMetricsPersist } from './store/metricsTreeStore';
import { GraphExplorer } from './components/GraphExplorer';
import { SeaTunnelSidebar } from './components/SeaTunnelExplorer';
import { ERSidebar } from './components/ERDesigner';
import { flushSeaTunnelPersist, useSeaTunnelStore } from './store/seaTunnelStore';
import { initTaskProgressListener, useTaskStore } from './store';
import { askAiWithContext } from './utils/askAi';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { tabTypeToActivity, tabToTreeNodeId } from './utils/tabActivityMapping';
import { useTreeStore } from './store/treeStore';
import { useErDesignerStore } from './store/erDesignerStore';
import { stJobNodeId } from './utils/nodeId';

export default function App() {
  const { t } = useTranslation();
  const isAssistantOpen = useAppStore((s) => s.isAssistantOpen);
  const { activeActivity, setActiveActivity } = useAppStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Resizable panel states
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [resultsHeight, setResultsHeight] = useState(0);
  const [assistantWidth, setAssistantWidth] = useState(380);
  const [isAssistantResizing, setIsAssistantResizing] = useState(false);

  // Auto-expand results panel when results appear or an error occurs; collapse when cleared
  const { tabs, activeTabId, openQueryTab, openTableDataTab, openTableStructureTab, results, error: queryError, explanationContent, explanationStreaming } = useQueryStore();
  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeConnectionId =
    activeTab?.queryContext?.connectionId ??
    activeTab?.metricScope?.connectionId ??
    activeTab?.connectionId ??
    null;
  const activeDatabase =
    activeTab?.queryContext?.database ??
    activeTab?.metricScope?.database ??
    activeTab?.db ??
    null;
  const activeSchema =
    activeTab?.queryContext?.schema ??
    activeTab?.schema ??
    null;
  const { visible: taskCenterVisible, setVisible: setTaskCenterVisible } = useTaskStore();
  // 全局挂载 MCP 双向桥接（UI action / query request）
  useMcpBridge();
  // 初始化任务进度监听器
  useEffect(() => {
    initTaskProgressListener();
  }, []);
  // app 关闭前立即 flush 防抖 persist，防止展开状态丢失
  useEffect(() => {
    const handler = () => { flushMetricsPersist(); flushSeaTunnelPersist(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  // 初始化 SeaTunnel store
  useEffect(() => {
    useSeaTunnelStore.getState().init();
  }, []);
  // Tab 切换联动 ActivityBar + 侧边栏树选中
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    // 1. 联动 ActivityBar
    const targetActivity = tabTypeToActivity(tab.type);
    if (targetActivity && activeActivity !== targetActivity) {
      setActiveActivity(targetActivity);
    }

    // 2a. database 树 — 选中对应表节点
    const treeNodeId = tabToTreeNodeId(tab);
    if (treeNodeId) {
      const treeState = useTreeStore.getState();
      if (treeState.nodes.has(treeNodeId) && treeState.selectedId !== treeNodeId) {
        treeState.selectNode(treeNodeId);
      }
    }

    // 2b. ER 设计器 — 切换活跃项目
    if (tab.type === 'er_design' && tab.erProjectId != null) {
      const erStore = useErDesignerStore.getState();
      if (erStore.activeProjectId !== tab.erProjectId) {
        erStore.loadProject(tab.erProjectId);
      }
    }

    // 2c. SeaTunnel — 选中 job 节点
    if (tab.type === 'seatunnel_job' && tab.stJobId != null) {
      const stStore = useSeaTunnelStore.getState();
      const jobNode = stJobNodeId(tab.stJobId);
      if (stStore.selectedId !== jobNode) {
        stStore.selectNode(jobNode);
      }
    }
  }, [activeTabId]);

  // 导入/导出完成后自动跳转到「我的任务」侧边栏
  useEffect(() => {
    if (taskCenterVisible) {
      setActiveActivity('tasks');
      setIsSidebarOpen(true);
      setTaskCenterVisible(false);
    }
  }, [taskCenterVisible]);
  useEffect(() => {
    const len = (results[activeTabId] ?? []).length;
    const hasError = !!queryError;
    const hasExplanation = !!(explanationContent[activeTabId] || explanationStreaming[activeTabId]);
    if ((len > 0 || hasError || hasExplanation) && resultsHeight === 0) {
      setResultsHeight(250);
    } else if (len === 0 && !hasError && !hasExplanation && resultsHeight > 0) {
      setResultsHeight(0);
    }
  }, [results, activeTabId, queryError, explanationContent, explanationStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  const { message: toastMsg, level: toastLevel, markdownContext: toastMarkdown, hide: hideToast } = useToastStore();

  const showToast = (msg: string, level: ToastLevel = 'default') => {
    useToastStore.getState().show(msg, level);
  };

  const showError = (userMessage: string, markdownContext?: string | null) => {
    useToastStore.getState().showError(userMessage, markdownContext);
  };

  const handleFormat = () => {
    const { activeTabId, sqlContent, setSql, tabs } = useQueryStore.getState();
    const current = sqlContent[activeTabId] ?? '';
    if (!current.trim()) return;

    // 根据当前 tab 的连接 driver 选择正确的 sql-formatter 方言
    const activeTab = tabs.find(t => t.id === activeTabId);
    const connectionId = activeTab?.queryContext?.connectionId ?? null;
    const connections = useConnectionStore.getState().connections;
    const driver = connectionId != null
      ? (connections.find(c => c.id === connectionId)?.driver ?? '')
      : '';
    const driverLanguageMap: Record<string, SqlLanguage> = {
      mysql: 'mysql',
      postgres: 'postgresql',
      mssql: 'tsql',
      oracle: 'plsql',
      sqlite: 'sqlite',
    };
    const language: SqlLanguage = driverLanguageMap[driver] ?? 'sql';

    const formatOpts = { language, tabWidth: 2, keywordCase: 'upper' } as const;

    try {
      setSql(activeTabId, formatSql(current, formatOpts));
    } catch {
      // 降级：逐条格式化，失败的语句保持原样
      try {
        const parts = current.split(/(?<=;)\s*\n/);
        const formatted = parts
          .map(part => {
            const trimmed = part.trim();
            if (!trimmed) return part;
            try { return formatSql(trimmed, formatOpts); } catch { return trimmed; }
          })
          .join('\n\n');
        const anyChanged = formatted !== parts.map(p => p.trim()).join('\n\n');
        if (anyChanged) {
          setSql(activeTabId, formatted);
        } else {
          showToast(t('app.sqlFormatFailed'), 'error');
        }
      } catch {
        showToast(t('app.sqlFormatFailed'), 'error');
      }
    }
  };

  // Resize handlers
  const handleSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(150, Math.min(600, startWidth + (moveEvent.clientX - startX)));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const handleResultsResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = resultsHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newHeight = Math.max(100, Math.min(window.innerHeight - 150, startHeight - (moveEvent.clientY - startY)));
      setResultsHeight(newHeight);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const handleAssistantResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = assistantWidth;
    setIsAssistantResizing(true);

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(800, startWidth - (moveEvent.clientX - startX)));
      setAssistantWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsAssistantResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const isMac = navigator.userAgent.includes('Mac');

  return (
    <div className="h-screen w-screen flex flex-col bg-background-void text-foreground overflow-hidden font-sans text-[13px]">
      {!isMac && <TitleBar />}
      <div className="flex flex-1 overflow-hidden">
      <ActivityBar
        activeActivity={activeActivity}
        setActiveActivity={setActiveActivity}
        isSidebarOpen={isSidebarOpen}
        setIsSidebarOpen={setIsSidebarOpen}
        showToast={showToast}
      />

      <MetricsSidebar
        sidebarWidth={sidebarWidth}
        onResize={handleSidebarResize}
        hidden={activeActivity !== 'metrics'}
      />
      <SeaTunnelSidebar
        sidebarWidth={sidebarWidth}
        onResize={handleSidebarResize}
        hidden={activeActivity !== 'seatunnel'}
      />
      <ERSidebar
        width={sidebarWidth}
        hidden={activeActivity !== 'er_designer'}
      />
      {activeActivity !== 'metrics' && activeActivity !== 'seatunnel' && activeActivity !== 'er_designer' && (
        activeActivity !== 'settings' && activeActivity !== 'tasks' &&
        activeActivity !== 'graph' && (
          <Explorer
            isSidebarOpen={isSidebarOpen}
            sidebarWidth={sidebarWidth}
            handleSidebarResize={handleSidebarResize}
            showToast={showToast}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            activeActivity={activeActivity}
            onNewQuery={openQueryTab}
            onOpenTableData={openTableDataTab}
            onOpenTableStructure={openTableStructureTab}
            onOpenMetricTab={(metricId, title, connId) => useQueryStore.getState().openMetricTab(metricId, title, connId)}
            onOpenMetricListTab={(scope, title) => useQueryStore.getState().openMetricListTab(scope, title)}
          />
        )
      )}

      <GraphExplorer connectionId={activeConnectionId} database={activeDatabase} hidden={activeActivity !== 'graph'} />
      {activeActivity === 'settings' ? (
        <SettingsPage />
      ) : activeActivity === 'tasks' ? (
        <TaskCenter />
      ) : activeActivity !== 'graph' ? (
        <MainContent
          handleFormat={handleFormat}
          showToast={showToast}
          showError={showError}
          resultsHeight={resultsHeight}
          handleResultsResize={handleResultsResize}
        />
      ) : null}

      <div
        style={{
          display: activeActivity === 'settings' ? 'none' : undefined,
          width: isAssistantOpen ? assistantWidth : 0,
          overflow: 'hidden',
          transition: isAssistantResizing ? 'none' : 'width 280ms cubic-bezier(0.32, 0.72, 0, 1)',
          flexShrink: 0,
        }}
      >
        <Assistant
          assistantWidth={assistantWidth}
          handleAssistantResize={handleAssistantResize}
          showToast={showToast}
          activeConnectionId={activeConnectionId}
          activeDatabase={activeDatabase}
          activeSchema={activeSchema}
          onOpenSettings={() => setActiveActivity('settings')}
        />
      </div>

      <Toast
        message={toastMsg}
        level={toastLevel}
        markdownContext={toastMarkdown}
        onAskAi={toastMarkdown ? () => {
          askAiWithContext(toastMarkdown!);
          hideToast();
        } : undefined}
        onClose={hideToast}
      />
      <ConfirmDialog />
      </div>
      {/* 浮动 AI 助手切换按钮（position:fixed，不占布局空间，无缝衔接内容区） */}
      {activeActivity !== 'settings' && (
        <AssistantToggleTab
          assistantWidth={isAssistantOpen ? assistantWidth : 0}
          isResizing={isAssistantResizing}
        />
      )}
    </div>
  );
}
