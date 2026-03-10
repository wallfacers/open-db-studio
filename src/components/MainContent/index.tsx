import React, { useEffect, useRef, useState } from 'react';
import MonacoEditor, { type BeforeMount } from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';

const handleEditorWillMount: BeforeMount = (monaco) => {
  monaco.editor.defineTheme('odb-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1e1e1e',
      'editorGutter.background': '#141414',
      'editorLineNumber.foreground': '#4a4a4a',
      'editorLineNumber.activeForeground': '#3794ff',
      'editor.lineHighlightBackground': '#1e2a3a',
      'editor.lineHighlightBorder': '#00000000',
    },
  });
};
import {
  FileCode2, X, Play, Square, Save, FileEdit, Settings, DatabaseZap, ChevronDown, Folder,
  RefreshCw, Download, Search, Filter, TableProperties, Plus
} from 'lucide-react';
import { TabData } from '../../App';
import { TableDataView } from './TableDataView';
import ERDiagram from '../ERDiagram';
import { useQueryStore, useConnectionStore, useAiStore } from '../../store';

interface MainContentProps {
  tabs: TabData[];
  activeTab: string;
  setActiveTab: (tabId: string) => void;
  closeTab: (e: React.MouseEvent, tabId: string) => void;
  closeAllTabs: () => void;
  closeTabsLeft: (tabId: string) => void;
  closeTabsRight: (tabId: string) => void;
  sqlContent: string;
  setSqlContent: (content: string) => void;
  handleExecute: () => void;
  isExecuting: boolean;
  handleFormat: () => void;
  handleClear: () => void;
  showToast: (msg: string) => void;
  isDbMenuOpen: boolean;
  setIsDbMenuOpen: (isOpen: boolean) => void;
  isTableMenuOpen: boolean;
  setIsTableMenuOpen: (isOpen: boolean) => void;
  resultsHeight: number;
  handleResultsResize: (e: React.MouseEvent) => void;
  resultsTab: string;
  setResultsTab: (tab: string) => void;
  isPageSizeMenuOpen: boolean;
  setIsPageSizeMenuOpen: (isOpen: boolean) => void;
  isExportMenuOpen: boolean;
  setIsExportMenuOpen: (isOpen: boolean) => void;
  tableData: any[];
  executionTime: number;
}

interface ContextMenu {
  tabId: string;
  x: number;
  y: number;
}

export const MainContent: React.FC<MainContentProps> = ({
  tabs, activeTab, setActiveTab, closeTab, closeAllTabs, closeTabsLeft, closeTabsRight,
  handleFormat, showToast,
  isDbMenuOpen, setIsDbMenuOpen, isTableMenuOpen, setIsTableMenuOpen,
  resultsHeight, handleResultsResize, resultsTab, setResultsTab,
  isPageSizeMenuOpen, setIsPageSizeMenuOpen, isExportMenuOpen, setIsExportMenuOpen,
}) => {
  const { t } = useTranslation();
  const { sqlContent, setSql, executeQuery, isExecuting, results, error } = useQueryStore();
  const { activeConnectionId } = useConnectionStore();
  const { explainSql, isExplaining } = useAiStore();
  const [explanation, setExplanation] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const activeTabObj = tabs.find(t => t.id === activeTab);
  const currentSql = sqlContent[activeTab] ?? '';
  const currentResult = results[activeTab];

  const handleExecute = () => {
    if (!activeConnectionId) {
      showToast(t('mainContent.selectConnectionFirst'));
      return;
    }
    executeQuery(activeConnectionId, activeTab);
    setResultsTab('result1');
  };

  const handleClear = () => {
    setSql(activeTab, '');
  };

  const handleExplain = async () => {
    if (!currentSql.trim() || !activeConnectionId) {
      showToast(t('mainContent.inputSqlAndSelectConnection'));
      return;
    }
    try {
      const result = await explainSql(currentSql, activeConnectionId);
      setExplanation(result);
    } catch {
      showToast(t('mainContent.aiExplainFailed'));
    }
  };

  // 关闭右键菜单
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleTabContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ tabId, x: e.clientX, y: e.clientY });
  };

  // F5 快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        handleExecute();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeConnectionId, activeTab]);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#1e1e1e]">
      {/* Tabs */}
      <div className="flex-shrink-0 h-10 flex items-start bg-[#181818] border-b border-[#2b2b2b] overflow-x-auto no-scrollbar">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`flex items-center px-4 h-[38px] border-r border-[#2b2b2b] cursor-pointer min-w-[120px] max-w-[200px] group ${activeTab === tab.id ? 'bg-[#1e1e1e] text-[#3794ff] border-t-2 border-t-[#3794ff]' : 'bg-[#2d2d2d] text-[#858585] border-t-2 border-t-transparent hover:bg-[#252526]'}`}
            onClick={() => setActiveTab(tab.id)}
            onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
          >
            {tab.type === 'query' ? (
              <FileCode2 size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#3794ff]' : 'text-[#858585]'}`} />
            ) : tab.type === 'er_diagram' ? (
              <DatabaseZap size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#3794ff]' : 'text-[#858585]'}`} />
            ) : (
              <TableProperties size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#3794ff]' : 'text-[#858585]'}`} />
            )}
            <span className="truncate flex-1 text-xs">{tab.title}</span>
            <div
              className="ml-2 p-0.5 rounded-sm hover:bg-[#3c3c3c] opacity-100"
              onClick={(e) => closeTab(e, tab.id)}
            >
              <X size={12} />
            </div>
          </div>
        ))}
      </div>

      {activeTabObj ? (
        activeTabObj.type === 'er_diagram' ? (
          <div className="flex-1 w-full h-full relative">
            <ERDiagram />
          </div>
        ) : activeTabObj.type === 'table' ? (
          <TableDataView
            tableName={activeTabObj.title}
            dbName={activeTabObj.db || 'demo'}
            showToast={showToast}
          />
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Toolbar */}
            <div className="flex-shrink-0 h-10 flex items-center justify-between px-4 border-b border-[#2b2b2b] bg-[#141414]">
              <div className="flex items-center space-x-2">
                <button
                  className={`flex items-center px-3 py-1.5 rounded text-xs font-medium transition-colors ${isExecuting ? 'bg-[#2b2b2b] text-[#858585] cursor-not-allowed' : 'bg-[#3794ff] hover:bg-[#2b7cdb] text-white'}`}
                  onClick={handleExecute}
                  disabled={isExecuting}
                >
                  {isExecuting ? <Square size={14} className="mr-1.5" /> : <Play size={14} className="mr-1.5" />}
                  {isExecuting ? t('mainContent.executing') : t('mainContent.execute')}
                </button>
                <button
                  className={`flex items-center px-2 py-1.5 rounded text-xs transition-colors ${isExplaining ? 'bg-[#2b2b2b] text-[#858585] cursor-not-allowed' : 'bg-[#2b2b2b] hover:bg-[#3a3a3a] text-gray-300'}`}
                  onClick={handleExplain}
                  disabled={isExplaining || !activeConnectionId}
                >
                  {isExplaining ? t('mainContent.explaining') : t('mainContent.explainSql')}
                </button>
                <div className="w-[1px] h-4 bg-[#3c3c3c] mx-1"></div>
                <button className="p-1.5 text-[#858585] hover:text-[#d4d4d4] hover:bg-[#2b2b2b] rounded transition-colors" title="Save" onClick={() => showToast(t('mainContent.sqlSaved'))}>
                  <Save size={16} />
                </button>
                <button className="p-1.5 text-[#858585] hover:text-[#d4d4d4] hover:bg-[#2b2b2b] rounded transition-colors" title="Format SQL" onClick={handleFormat}>
                  <FileEdit size={16} />
                </button>
                <button className="p-1.5 text-[#858585] hover:text-[#d4d4d4] hover:bg-[#2b2b2b] rounded transition-colors" title="Clear" onClick={handleClear}>
                  <X size={16} />
                </button>
                <button className="p-1.5 text-[#858585] hover:text-[#d4d4d4] hover:bg-[#2b2b2b] rounded transition-colors" title="Settings" onClick={() => showToast(t('mainContent.openEditorSettings'))}>
                  <Settings size={16} />
                </button>
              </div>

              <div className="flex items-center space-x-3">
                <div className="relative">
                  <div
                    className="flex items-center text-xs text-[#d4d4d4] cursor-pointer hover:bg-[#2b2b2b] px-2 py-1 rounded"
                    onClick={(e) => { e.stopPropagation(); setIsDbMenuOpen(!isDbMenuOpen); setIsTableMenuOpen(false); }}
                  >
                    <DatabaseZap size={14} className="mr-1.5 text-[#3794ff]" />
                    <span>{activeConnectionId ? `${t('mainContent.connection')}${activeConnectionId}` : t('mainContent.noConnectionSelected')}</span>
                    <ChevronDown size={14} className="ml-1 text-[#858585]" />
                  </div>
                </div>
              </div>
            </div>

            {/* Editor Content */}
            <div className="flex-1 relative bg-[#1e1e1e] min-h-0">
              <MonacoEditor
                height="100%"
                language="sql"
                theme="odb-dark"
                beforeMount={handleEditorWillMount}
                value={currentSql}
                onChange={(val) => setSql(activeTab, val ?? '')}
                options={{
                  fontSize: 16,
                  fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  renderLineHighlight: 'line',
                  smoothScrolling: true,
                  cursorBlinking: 'smooth',
                  formatOnPaste: true,
                  tabSize: 2,
                  padding: { top: 12, bottom: 12 },
                  automaticLayout: true,
                  overviewRulerBorder: false,
                  overviewRulerLanes: 0,
                  hideCursorInOverviewRuler: true,
                }}
              />
            </div>

            {/* Results Resizer */}
            <div
              className="h-2 cursor-row-resize z-10 flex flex-col justify-center group"
              onMouseDown={handleResultsResize}
            >
              <div className="h-px bg-[#2b2b2b] group-hover:bg-[#3794ff] transition-colors" />
            </div>

            {/* Results Area */}
            <div className="flex flex-col bg-[#1e1e1e] flex-shrink-0" style={{ height: resultsHeight }}>
              {/* Results Tabs */}
              <div className="flex items-center bg-[#181818] border-b border-[#2b2b2b]">
                <div
                  className={`px-4 py-2 text-xs cursor-pointer border-t-2 ${resultsTab === 'result1' ? 'border-t-[#3794ff] text-[#d4d4d4] bg-[#1e1e1e]' : 'border-t-transparent text-[#858585] hover:text-[#d4d4d4]'}`}
                  onClick={() => setResultsTab('result1')}
                >
                  {t('mainContent.resultSet')}
                </div>
                <div
                  className={`px-4 py-2 text-xs cursor-pointer border-t-2 ${resultsTab === 'overview' ? 'border-t-[#3794ff] text-[#d4d4d4] bg-[#1e1e1e]' : 'border-t-transparent text-[#858585] hover:text-[#d4d4d4]'}`}
                  onClick={() => setResultsTab('overview')}
                >
                  {t('mainContent.executionOverview')}
                </div>
              </div>

              {resultsTab === 'result1' ? (
                <div className="flex-1 overflow-auto">
                  {isExecuting ? (
                    <div className="p-4 text-gray-400 text-sm">{t('mainContent.executing')}</div>
                  ) : error ? (
                    <div className="p-4 text-red-400 text-xs font-mono">{error}</div>
                  ) : !currentResult ? (
                    <div className="p-4 text-[#858585] text-sm">{t('mainContent.resultsWillShowHere')}</div>
                  ) : currentResult.columns.length === 0 ? (
                    <div className="p-4 text-green-400 text-sm">{t('mainContent.executeSuccess')}{currentResult.row_count} {t('mainContent.rowsAffected')}（{currentResult.duration_ms}ms）</div>
                  ) : (
                    <>
                      <div className="text-xs text-[#858585] px-3 py-1 border-b border-[#2b2b2b]">
                        {currentResult.row_count} {t('mainContent.rows')} · {currentResult.duration_ms}ms
                      </div>
                      <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
                        <thead className="sticky top-0 bg-[#252526] z-10">
                          <tr>
                            {currentResult.columns.map((col) => (
                              <th key={col} className="px-3 py-1.5 border-b border-r border-[#2b2b2b] text-[#d4d4d4] font-normal">
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {currentResult.rows.map((row, ri) => (
                            <tr key={ri} className="hover:bg-[#2a2d2e] border-b border-[#2b2b2b]">
                              {row.map((cell, ci) => (
                                <td key={ci} className="px-3 py-1.5 text-[#d4d4d4] border-r border-[#2b2b2b] max-w-[300px] truncate">
                                  {cell === null ? <span className="text-[#858585]">NULL</span> : String(cell)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-[#858585]">
                  <p className="text-sm">{t('mainContent.executionOverviewInfo')}</p>
                </div>
              )}

              {/* AI 解释面板 */}
              {explanation && (
                <div className="border-t border-[#2b2b2b] p-4 bg-[#181818]">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs text-gray-400 font-medium">{t('mainContent.aiExplanation')}</span>
                    <button onClick={() => setExplanation(null)} className="text-xs text-[#858585] hover:text-[#d4d4d4]">✕</button>
                  </div>
                  <p className="text-sm text-[#d4d4d4] whitespace-pre-wrap">{explanation}</p>
                </div>
              )}
            </div>
          </div>
        )
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-[#858585] bg-[#1e1e1e]">
          <DatabaseZap size={64} className="mb-4 opacity-20" />
          <p className="text-lg">{t('mainContent.noActiveEditor')}</p>
          <p className="text-sm mt-2 opacity-60">{t('mainContent.selectItemToView')}</p>
        </div>
      )}

      {/* Tab 右键菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-[#252526] border border-[#3c3c3c] rounded shadow-lg py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] hover:text-white"
            onClick={() => {
              const e = { stopPropagation: () => {} } as React.MouseEvent;
              closeTab(e, contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            {t('mainContent.close')}
          </button>
          <div className="h-px bg-[#3c3c3c] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={tabs.findIndex(t => t.id === contextMenu.tabId) === 0}
            onClick={() => {
              closeTabsLeft(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            {t('mainContent.closeLeft')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={tabs.findIndex(t => t.id === contextMenu.tabId) === tabs.length - 1}
            onClick={() => {
              closeTabsRight(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            {t('mainContent.closeRight')}
          </button>
          <div className="h-px bg-[#3c3c3c] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] hover:text-white"
            onClick={() => {
              closeAllTabs();
              setContextMenu(null);
            }}
          >
            {t('mainContent.closeAll')}
          </button>
        </div>
      )}
    </div>
  );
};
