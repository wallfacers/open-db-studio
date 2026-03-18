import React, { useState, useEffect } from 'react';
import { format as formatSql } from 'sql-formatter';
import { ActivityBar } from './components/ActivityBar';
import { Explorer } from './components/Explorer';
import { MainContent } from './components/MainContent';
import { Assistant } from './components/Assistant';
import { AssistantToggleTab } from './components/Assistant/AssistantToggleTab';
import { Toast, type ToastLevel } from './components/Toast';
import { SettingsPage } from './components/Settings/SettingsPage';
import { TitleBar } from './components/TitleBar';
import { useQueryStore } from './store/queryStore';
import { useAppStore } from './store/appStore';
import { useToolBridge } from './hooks/useToolBridge';
import { useMcpBridge } from './hooks/useMcpBridge';
import { TaskCenter } from './components/TaskCenter';
import { MetricsSidebar } from './components/MetricsExplorer/MetricsSidebar';
import { GraphExplorer } from './components/GraphExplorer';
import { MigrationWizard } from './components/MigrationWizard';
import { initTaskProgressListener, useTaskStore } from './store';
import { askAiWithContext } from './utils/askAi';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { TaskBar } from './components/TaskBar';

export default function App() {
  const isAssistantOpen = useAppStore((s) => s.isAssistantOpen);
  const [activeActivity, setActiveActivity] = useState('database');
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
  const { visible: taskCenterVisible, setVisible: setTaskCenterVisible } = useTaskStore();
  // 全局挂载 MCP propose_sql_diff 事件监听器
  useToolBridge();
  // 全局挂载 MCP 双向桥接（UI action / query request）
  useMcpBridge();
  // 初始化任务进度监听器
  useEffect(() => {
    initTaskProgressListener();
  }, []);
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

  const [toast, setToast] = useState<{ message: string; level: ToastLevel; markdownContext?: string | null } | null>(null);

  const showToast = (msg: string, level: ToastLevel = 'default') => {
    setToast({ message: msg, level });
  };

  const showError = (userMessage: string, markdownContext?: string | null) => {
    setToast({ message: userMessage, level: 'error', markdownContext });
  };

  const handleFormat = () => {
    const { activeTabId, sqlContent, setSql } = useQueryStore.getState();
    const current = sqlContent[activeTabId] ?? '';
    if (!current.trim()) return;
    try {
      const formatted = formatSql(current, {
        language: 'sql',
        tabWidth: 2,
        keywordCase: 'upper',
      });
      setSql(activeTabId, formatted);
    } catch {
      showToast('SQL 格式化失败', 'error');
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
    <div className="h-screen w-screen flex flex-col bg-[#080d12] text-[#b5cfe8] overflow-hidden font-sans text-[13px]">
      {!isMac && <TitleBar />}
      <div className="flex flex-1 overflow-hidden">
      <ActivityBar
        activeActivity={activeActivity}
        setActiveActivity={setActiveActivity}
        isSidebarOpen={isSidebarOpen}
        setIsSidebarOpen={setIsSidebarOpen}
        showToast={showToast}
      />

      {activeActivity === 'metrics' ? (
        <MetricsSidebar sidebarWidth={sidebarWidth} onResize={handleSidebarResize} />
      ) : (
        activeActivity !== 'settings' && activeActivity !== 'tasks' &&
        activeActivity !== 'graph' && activeActivity !== 'migration' && (
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
          />
        )
      )}

      {activeActivity === 'settings' ? (
        <SettingsPage />
      ) : activeActivity === 'tasks' ? (
        <TaskCenter />
      ) : activeActivity === 'graph' ? (
        <GraphExplorer connectionId={activeConnectionId} />
      ) : activeActivity === 'migration' ? (
        <MigrationWizard />
      ) : (
        <MainContent
          handleFormat={handleFormat}
          showToast={showToast}
          showError={showError}
          resultsHeight={resultsHeight}
          handleResultsResize={handleResultsResize}
        />
      )}

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
          onOpenSettings={() => setActiveActivity('settings')}
        />
      </div>

      <Toast
        message={toast?.message ?? null}
        level={toast?.level}
        markdownContext={toast?.markdownContext}
        onAskAi={toast?.markdownContext ? () => {
          askAiWithContext(toast!.markdownContext!);
          setToast(null);
        } : undefined}
        onClose={() => setToast(null)}
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
      <TaskBar />
    </div>
  );
}
