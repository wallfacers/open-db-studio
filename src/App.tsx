import React, { useState, useEffect } from 'react';
import { format as formatSql } from 'sql-formatter';
import { useTranslation } from 'react-i18next';
import { ActivityBar } from './components/ActivityBar';
import { Explorer } from './components/Explorer';
import { MainContent } from './components/MainContent';
import { Assistant } from './components/Assistant';
import { Toast, type ToastLevel } from './components/Toast';
import { SettingsPage } from './components/Settings/SettingsPage';
import { TitleBar } from './components/TitleBar';
import { useQueryStore } from './store/queryStore';
import { QueryContext } from './types';

export interface TabData {
  id: string;
  type: 'query' | 'table' | 'er_diagram' | 'table_structure';
  title: string;
  db?: string;
  connectionId?: number;
  schema?: string;
  queryContext?: QueryContext;
  isNewTable?: boolean;
}

export default function App() {
  const { t } = useTranslation();
  const [activeActivity, setActiveActivity] = useState('database');
  const [isAssistantOpen, setIsAssistantOpen] = useState(true);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    'demo': true,
    'birth_analysis': true,
    '表': true,
  });
  const [activeTab, setActiveTab] = useState('er_diagram');
  const [tabs, setTabs] = useState<TabData[]>([
    { id: 'birth_analysis', type: 'query', title: 'birth_analysis', db: 'demo' },
    { id: 'er_diagram', type: 'er_diagram', title: 'ER Diagram', db: 'demo' }
  ]);
  
  const [sqlContent, setSqlContent] = useState(`SELECT analysis_date, time_period, birth_rate, growth_rate, gender_ratio,
avg_birth_weight
FROM birth_trend_analysis
WHERE region_id = 1
  AND YEAR(analysis_date) = 2023
ORDER BY analysis_date, time_period;

SELECT
    r.name AS region_name, ba.analysis_date, ba.birth_rate, ba.growth_rate,
    ba.gender_ratio, ba.avg_birth_weight, ba.analysis_result
FROM
    birth_trend_analysis ba
JOIN
    region r ON ba.region_id = r.id;`);

  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isPageSizeMenuOpen, setIsPageSizeMenuOpen] = useState(false);
  const [isDbMenuOpen, setIsDbMenuOpen] = useState(false);
  const [isTableMenuOpen, setIsTableMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [tableData, setTableData] = useState([
    ['2023-01-01', '月度', '12.56', '0.78', '105.23'],
    ['2023-02-01', '月度', '13.15', '0.78', '105.23'],
    ['2023-03-01', '月度', '10.99', '1.23', '104.98'],
    ['2023-04-01', '月度', '11.89', '-0.56', '106.12'],
    ['2023-05-01', '月度', '13.21', '0.90', '105.56'],
    ['2023-06-01', '月度', '11.30', '1.12', '104.78'],
    ['2023-07-01', '月度', '13.45', '-0.67', '106.34'],
  ]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionTime, setExecutionTime] = useState(46);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Resizable panel states
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [resultsHeight, setResultsHeight] = useState(0);
  const [assistantWidth, setAssistantWidth] = useState(380);

  // Auto-expand results panel when results appear or an error occurs; collapse when cleared
  const { results, error: queryError } = useQueryStore();
  useEffect(() => {
    const len = (results[activeTab] ?? []).length;
    const hasError = !!queryError;
    if ((len > 0 || hasError) && resultsHeight === 0) {
      setResultsHeight(250);
    } else if (len === 0 && !hasError && resultsHeight > 0) {
      setResultsHeight(0);
    }
  }, [results, activeTab, queryError]); // eslint-disable-line react-hooks/exhaustive-deps

  const [toast, setToast] = useState<{ message: string; level: ToastLevel } | null>(null);

  const showToast = (msg: string, level: ToastLevel = 'default') => {
    setToast({ message: msg, level });
  };


  const toggleFolder = (folder: string) => {
    setExpandedFolders(prev => ({ ...prev, [folder]: !prev[folder] }));
  };

  const closeTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    const newTabs = tabs.filter(t => t.id !== tabId);
    setTabs(newTabs);
    if (activeTab === tabId && newTabs.length > 0) {
      setActiveTab(newTabs[newTabs.length - 1].id);
    } else if (newTabs.length === 0) {
      setActiveTab('');
    }
  };

  const closeAllTabs = () => {
    setTabs([]);
    setActiveTab('');
  };

  const closeTabsLeft = (tabId: string) => {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx <= 0) return;
    const newTabs = tabs.slice(idx);
    setTabs(newTabs);
    if (!newTabs.find(t => t.id === activeTab)) {
      setActiveTab(newTabs[0]?.id ?? '');
    }
  };

  const closeTabsRight = (tabId: string) => {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === tabs.length - 1) return;
    const newTabs = tabs.slice(0, idx + 1);
    setTabs(newTabs);
    if (!newTabs.find(t => t.id === activeTab)) {
      setActiveTab(newTabs[newTabs.length - 1]?.id ?? '');
    }
  };

  const closeOtherTabs = (tabId: string) => {
    const targetTab = tabs.find(t => t.id === tabId);
    if (!targetTab) return;
    setTabs([targetTab]);
    setActiveTab(tabId);
  };

  const handleOpenTableData = (tableName: string, connectionId: number, database?: string, schema?: string) => {
    const dbName = database ?? `conn_${connectionId}`;
    const tabId = `table_${connectionId}_${dbName}_${schema ?? ''}_${tableName}`;
    setTabs(prev => {
      if (!prev.find(t => t.id === tabId)) {
        return [...prev, { id: tabId, type: 'table', title: tableName, db: dbName, connectionId, schema }];
      }
      return prev;
    });
    setActiveTab(tabId);
  };

  const handleOpenTableStructure = (connectionId: number, database?: string, schema?: string, tableName?: string) => {
    const dbName = database ?? `conn_${connectionId}`;
    const isNew = !tableName;
    const tabId = isNew
      ? `table_structure_new_${connectionId}_${dbName}_${schema ?? ''}_${Date.now()}`
      : `table_structure_${connectionId}_${dbName}_${schema ?? ''}_${tableName}`;
    setTabs(prev => {
      if (!prev.find(t => t.id === tabId)) {
        return [...prev, {
          id: tabId,
          type: 'table_structure' as const,
          title: tableName ?? '新建表',
          db: dbName,
          connectionId,
          schema,
          isNewTable: isNew,
        }];
      }
      return prev;
    });
    setActiveTab(tabId);
  };

  const handleNewQuery = (connId: number, connName: string, database?: string, schema?: string) => {
    const tabId = `query_${connId}_${Date.now()}`;
    const queryCount = tabs.filter(t => t.type === 'query').length + 1;
    setTabs(prev => [...prev, {
      id: tabId,
      type: 'query',
      title: `查询${queryCount}`,
      db: connName,
      queryContext: { connectionId: connId, database: database ?? null, schema: schema ?? null },
    }]);
    setActiveTab(tabId);
  };

  const updateTabContext = (tabId: string, context: Partial<QueryContext>) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== tabId) return t;
      const existing = t.queryContext ?? { connectionId: null, database: null, schema: null };
      return { ...t, queryContext: { ...existing, ...context } };
    }));
  };

  const handleExecute = () => {
    setIsExecuting(true);
    // Simulate execution delay
    setTimeout(() => {
      setIsExecuting(false);
      setExecutionTime(Math.floor(Math.random() * 100) + 20);
      
      // Shuffle data slightly to show it "updated"
      setTableData(prev => {
        const newData = [...prev];
        const first = newData.shift();
        if (first) newData.push(first);
        return newData;
      });
    }, 800);
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

  const handleClear = () => {
    setSqlContent('');
  };

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      setIsExportMenuOpen(false);
      setIsPageSizeMenuOpen(false);
      setIsDbMenuOpen(false);
      setIsTableMenuOpen(false);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

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

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(800, startWidth - (moveEvent.clientX - startX)));
      setAssistantWidth(newWidth);
    };

    const onMouseUp = () => {
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
        isAssistantOpen={isAssistantOpen}
        setIsAssistantOpen={setIsAssistantOpen}
        showToast={showToast}
      />
      
      {activeActivity !== 'settings' && (
        <Explorer
          isSidebarOpen={isSidebarOpen}
          sidebarWidth={sidebarWidth}
          handleSidebarResize={handleSidebarResize}
          showToast={showToast}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          activeActivity={activeActivity}
          onNewQuery={handleNewQuery}
          onOpenTableData={handleOpenTableData}
          onOpenTableStructure={handleOpenTableStructure}
        />
      )}

      {activeActivity === 'settings' ? (
        <SettingsPage />
      ) : (
      <MainContent
        tabs={tabs}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        closeTab={closeTab}
        closeAllTabs={closeAllTabs}
        closeTabsLeft={closeTabsLeft}
        closeTabsRight={closeTabsRight}
        closeOtherTabs={closeOtherTabs}
        sqlContent={sqlContent}
        setSqlContent={setSqlContent}
        handleExecute={handleExecute}
        isExecuting={isExecuting}
        handleFormat={handleFormat}
        handleClear={handleClear}
        showToast={showToast}
        isDbMenuOpen={isDbMenuOpen}
        setIsDbMenuOpen={setIsDbMenuOpen}
        isTableMenuOpen={isTableMenuOpen}
        setIsTableMenuOpen={setIsTableMenuOpen}
        resultsHeight={resultsHeight}
        handleResultsResize={handleResultsResize}
        isPageSizeMenuOpen={isPageSizeMenuOpen}
        setIsPageSizeMenuOpen={setIsPageSizeMenuOpen}
        isExportMenuOpen={isExportMenuOpen}
        setIsExportMenuOpen={setIsExportMenuOpen}
        tableData={tableData}
        executionTime={executionTime}
        updateTabContext={updateTabContext}
        onOpenAssistant={() => setIsAssistantOpen(true)}
      />
      )}

      {activeActivity !== 'settings' && (
      <Assistant
        isAssistantOpen={isAssistantOpen}
        assistantWidth={assistantWidth}
        handleAssistantResize={handleAssistantResize}
        setIsAssistantOpen={setIsAssistantOpen}
        showToast={showToast}
      />
      )}

      <Toast message={toast?.message ?? null} level={toast?.level} onClose={() => setToast(null)} />
      </div>
    </div>
  );
}
