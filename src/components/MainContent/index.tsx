import React, { useEffect, useRef, useState } from 'react';
import MonacoEditor, { type BeforeMount, type OnMount, type Monaco } from '@monaco-editor/react';
import type { languages as MonacoLanguages } from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { FullSchemaInfo } from '../../types';

const handleEditorWillMount: BeforeMount = (monaco) => {
  monaco.editor.defineTheme('odb-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword',    foreground: '5eb2f7', fontStyle: 'bold' },
      { token: 'string',     foreground: 'e8a87c' },
      { token: 'number',     foreground: '9de0b2' },
      { token: 'comment',    foreground: '4caf76', fontStyle: 'italic' },
      { token: 'identifier', foreground: 'c8daea' },
      { token: 'operator',   foreground: '88d8ff' },
      { token: 'delimiter',  foreground: '7a9bb8' },
    ],
    colors: {
      'editor.background':                 '#111922',
      'editorGutter.background':           '#0d1117',
      'editorLineNumber.foreground':       '#2a3f5a',
      'editorLineNumber.activeForeground': '#00c9a7',
      'editor.lineHighlightBackground':    '#0e1e2e',
      'editor.lineHighlightBorder':        '#00000000',
      'editor.selectionBackground':        '#003d2f80',
      'editor.inactiveSelectionBackground':'#003d2f40',
      'editorCursor.foreground':           '#00c9a7',
      'editorIndentGuide.background1':     '#1e2d42',
      'editorIndentGuide.activeBackground1':'#2a3f5a',
      'editorWidget.background':           '#151d28',
      'editorWidget.border':               '#1e2d42',
      'editorSuggestWidget.background':    '#151d28',
      'editorSuggestWidget.border':        '#1e2d42',
      'editorSuggestWidget.selectedBackground': '#003d2f',
      'list.hoverBackground':              '#1a2639',
      'list.activeSelectionBackground':    '#003d2f',
      'scrollbarSlider.background':        '#1e2d4260',
      'scrollbarSlider.hoverBackground':   '#2a3f5a80',
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
  const { sqlContent, setSql, executeQuery, isExecuting, results, error, diagnosis } = useQueryStore();
  const { activeConnectionId } = useConnectionStore();
  const { explainSql, isExplaining, optimizeSql, isOptimizing } = useAiStore();
  const [explanation, setExplanation] = useState<string | null>(null);
  const [optimization, setOptimization] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const schemaRef = useRef<FullSchemaInfo | null>(null);

  // Fetch full schema whenever the active connection changes
  useEffect(() => {
    if (!activeConnectionId) {
      schemaRef.current = null;
      return;
    }
    invoke<FullSchemaInfo>('get_full_schema', { connectionId: activeConnectionId })
      .then((schema) => { schemaRef.current = schema; })
      .catch(() => { schemaRef.current = null; });
  }, [activeConnectionId]);

  // Register Monaco completion provider once (module-level guard)
  const completionProviderRegistered = useRef(false);

  const handleEditorDidMount: OnMount = (_editor, monaco: Monaco) => {
    if (completionProviderRegistered.current) return;
    completionProviderRegistered.current = true;

    monaco.languages.registerCompletionItemProvider('sql', {
      provideCompletionItems: (
        model: Parameters<MonacoLanguages.CompletionItemProvider['provideCompletionItems']>[0],
        position: Parameters<MonacoLanguages.CompletionItemProvider['provideCompletionItems']>[1],
      ) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const schema = schemaRef.current;
        if (!schema) return { suggestions: [] };

        const suggestions: MonacoLanguages.CompletionItem[] = [];
        schema.tables.forEach(t => {
          suggestions.push({
            label: t.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: t.name,
            range,
            detail: 'Table',
          });
          t.columns.forEach(c => {
            suggestions.push({
              label: `${t.name}.${c.name}`,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: c.name,
              range,
              detail: `${t.name} (${c.data_type})`,
            });
          });
        });
        return { suggestions };
      },
    });
  };

  const activeTabObj = tabs.find(t => t.id === activeTab);
  const currentSql = sqlContent[activeTab] ?? '';
  const currentResults = results[activeTab] ?? [];
  const [selectedResultIdx, setSelectedResultIdx] = useState(0);

  // Reset selected result index when active editor tab changes
  useEffect(() => {
    setSelectedResultIdx(0);
  }, [activeTab]);

  // Reset to first result tab after a new execution completes
  useEffect(() => {
    if (!isExecuting) {
      setSelectedResultIdx(0);
    }
  }, [isExecuting]);

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

  const handleOptimize = async () => {
    if (!currentSql.trim() || !activeConnectionId) {
      showToast(t('mainContent.inputSqlAndSelectConnection'));
      return;
    }
    try {
      const result = await optimizeSql(currentSql, activeConnectionId);
      setOptimization(result);
    } catch {
      showToast(t('mainContent.aiOptimizeFailed'));
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
    <div className="flex-1 flex flex-col min-w-0 bg-[#111922]">
      {/* Tabs */}
      <div className="flex-shrink-0 h-10 flex items-start bg-[#0d1117] border-b border-[#1e2d42] overflow-x-auto no-scrollbar">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`flex items-center px-4 h-[38px] border-r border-[#1e2d42] cursor-pointer min-w-[120px] max-w-[200px] group ${activeTab === tab.id ? 'bg-[#111922] text-[#00c9a7] border-t-2 border-t-[#00c9a7]' : 'bg-[#1a2639] text-[#7a9bb8] border-t-2 border-t-transparent hover:bg-[#151d28]'}`}
            onClick={() => setActiveTab(tab.id)}
            onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
          >
            {tab.type === 'query' ? (
              <FileCode2 size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`} />
            ) : tab.type === 'er_diagram' ? (
              <DatabaseZap size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`} />
            ) : (
              <TableProperties size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`} />
            )}
            <span className="truncate flex-1 text-xs">{tab.title}</span>
            <div
              className="ml-2 p-0.5 rounded-sm hover:bg-[#2a3f5a] opacity-100"
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
            <div className="flex-shrink-0 h-10 flex items-center justify-between px-4 border-b border-[#1e2d42] bg-[#080d12]">
              <div className="flex items-center space-x-2">
                <button
                  className={`flex items-center px-3 py-1.5 rounded text-xs font-medium transition-colors ${isExecuting ? 'bg-[#1e2d42] text-[#7a9bb8] cursor-not-allowed' : 'bg-[#00c9a7] hover:bg-[#00a98f] text-white'}`}
                  onClick={handleExecute}
                  disabled={isExecuting}
                >
                  {isExecuting ? <Square size={14} className="mr-1.5" /> : <Play size={14} className="mr-1.5" />}
                  {isExecuting ? t('mainContent.executing') : t('mainContent.execute')}
                </button>
                <button
                  className={`flex items-center px-2 py-1.5 rounded text-xs transition-colors ${isExplaining ? 'bg-[#1e2d42] text-[#7a9bb8] cursor-not-allowed' : 'bg-[#1e2d42] hover:bg-[#253347] text-gray-300'}`}
                  onClick={handleExplain}
                  disabled={isExplaining || !activeConnectionId}
                >
                  {isExplaining ? t('mainContent.explaining') : t('mainContent.explainSql')}
                </button>
                <button
                  className={`flex items-center px-2 py-1.5 rounded text-xs transition-colors ${isOptimizing ? 'bg-[#1e2d42] text-[#7a9bb8] cursor-not-allowed' : 'bg-[#1e2d42] hover:bg-[#253347] text-gray-300'}`}
                  onClick={handleOptimize}
                  disabled={isOptimizing || !activeConnectionId}
                >
                  {isOptimizing ? t('mainContent.optimizing') : t('mainContent.optimizeSql')}
                </button>
                <div className="w-[1px] h-4 bg-[#2a3f5a] mx-1"></div>
                <button className="p-1.5 text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42] rounded transition-colors" title="Save" onClick={() => showToast(t('mainContent.sqlSaved'))}>
                  <Save size={16} />
                </button>
                <button className="p-1.5 text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42] rounded transition-colors" title="Format SQL" onClick={handleFormat}>
                  <FileEdit size={16} />
                </button>
                <button className="p-1.5 text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42] rounded transition-colors" title="Clear" onClick={handleClear}>
                  <X size={16} />
                </button>
                <button className="p-1.5 text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42] rounded transition-colors" title="Settings" onClick={() => showToast(t('mainContent.openEditorSettings'))}>
                  <Settings size={16} />
                </button>
              </div>

              <div className="flex items-center space-x-3">
                <div className="relative">
                  <div
                    className="flex items-center text-xs text-[#c8daea] cursor-pointer hover:bg-[#1e2d42] px-2 py-1 rounded"
                    onClick={(e) => { e.stopPropagation(); setIsDbMenuOpen(!isDbMenuOpen); setIsTableMenuOpen(false); }}
                  >
                    <DatabaseZap size={14} className="mr-1.5 text-[#00c9a7]" />
                    <span>{activeConnectionId ? `${t('mainContent.connection')}${activeConnectionId}` : t('mainContent.noConnectionSelected')}</span>
                    <ChevronDown size={14} className="ml-1 text-[#7a9bb8]" />
                  </div>
                </div>
              </div>
            </div>

            {/* Editor Content */}
            <div className="flex-1 relative bg-[#111922] min-h-0">
              <MonacoEditor
                height="100%"
                language="sql"
                theme="odb-dark"
                beforeMount={handleEditorWillMount}
                onMount={handleEditorDidMount}
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
              className="h-1 cursor-row-resize z-10 flex flex-col justify-center group"
              onMouseDown={handleResultsResize}
            >
              <div className="h-px bg-[#1e2d42] group-hover:bg-[#00c9a7] transition-colors" />
            </div>

            {/* Results Area */}
            <div className="flex flex-col bg-[#080d12] flex-shrink-0" style={{ height: resultsHeight }}>
              {/* Results Tabs */}
              <div className="flex items-center bg-[#0d1117] border-b border-[#1e2d42]">
                <div
                  className={`px-4 h-[38px] flex items-center text-xs cursor-pointer border-t-2 border-r border-r-[#1e2d42] ${resultsTab === 'result1' ? 'bg-[#080d12] text-[#00c9a7] border-t-[#00c9a7]' : 'bg-[#1a2639] text-[#7a9bb8] border-t-transparent hover:bg-[#151d28]'}`}
                  onClick={() => setResultsTab('result1')}
                >
                  {t('mainContent.resultSet')}
                </div>
                <div
                  className={`px-4 h-[38px] flex items-center text-xs cursor-pointer border-t-2 border-r border-r-[#1e2d42] ${resultsTab === 'overview' ? 'bg-[#080d12] text-[#00c9a7] border-t-[#00c9a7]' : 'bg-[#1a2639] text-[#7a9bb8] border-t-transparent hover:bg-[#151d28]'}`}
                  onClick={() => setResultsTab('overview')}
                >
                  {t('mainContent.executionOverview')}
                </div>
              </div>

              {resultsTab === 'result1' ? (
                <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                  {/* Multi-result sub-tabs (only shown when there are multiple result sets) */}
                  {currentResults.length > 1 && (
                    <div className="flex items-center bg-[#111922] border-b border-[#1e2d42] flex-shrink-0">
                      {currentResults.map((_, idx) => (
                        <div
                          key={idx}
                          className={`px-4 h-[32px] flex items-center text-xs cursor-pointer border-b-2 border-r border-r-[#1e2d42] ${selectedResultIdx === idx ? 'bg-[#080d12] text-[#00c9a7] border-b-[#00c9a7]' : 'bg-[#1a2639] text-[#7a9bb8] border-b-transparent hover:bg-[#151d28]'}`}
                          onClick={() => setSelectedResultIdx(idx)}
                        >
                          {t('mainContent.resultSet')} {idx + 1}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex-1 overflow-auto">
                    {isExecuting ? (
                      <div className="p-4 text-gray-400 text-sm">{t('mainContent.executing')}</div>
                    ) : error ? (
                      <div className="p-3 text-red-400 text-xs font-mono">
                        {error}
                        {diagnosis && (
                          <div className="mt-2 p-2 bg-[#2b2b2b] rounded text-[#d4d4d4] whitespace-pre-wrap font-sans">
                            <span className="text-[#3794ff]">{t('mainContent.aiDiagnosis')}</span>{diagnosis}
                          </div>
                        )}
                      </div>
                    ) : currentResults.length === 0 ? (
                      <div className="p-4 text-[#7a9bb8] text-sm">{t('mainContent.resultsWillShowHere')}</div>
                    ) : currentResults[selectedResultIdx]?.columns.length === 0 ? (
                      <div className="p-4 text-green-400 text-sm">{t('mainContent.executeSuccess')}{currentResults[selectedResultIdx].row_count} {t('mainContent.rowsAffected')}（{currentResults[selectedResultIdx].duration_ms}ms）</div>
                    ) : (
                      <>
                        <div className="text-xs text-[#7a9bb8] px-3 py-1 border-b border-[#1e2d42]">
                          {currentResults[selectedResultIdx]?.row_count} {t('mainContent.rows')} · {currentResults[selectedResultIdx]?.duration_ms}ms
                        </div>
                        <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
                          <thead className="sticky top-0 bg-[#0d1117] z-10">
                            <tr>
                              {currentResults[selectedResultIdx]?.columns.map((col) => (
                                <th key={col} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {currentResults[selectedResultIdx]?.rows.map((row, ri) => (
                              <tr key={ri} className="hover:bg-[#1a2639] border-b border-[#1e2d42]">
                                {row.map((cell, ci) => (
                                  <td key={ci} className="px-3 py-1.5 text-[#c8daea] border-r border-[#1e2d42] max-w-[300px] truncate">
                                    {cell === null ? <span className="text-[#7a9bb8]">NULL</span> : String(cell)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-[#7a9bb8]">
                  <p className="text-sm">{t('mainContent.executionOverviewInfo')}</p>
                </div>
              )}

              {/* AI 解释面板 */}
              {explanation && (
                <div className="border-t border-[#1e2d42] p-4 bg-[#0d1117]">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs text-gray-400 font-medium">{t('mainContent.aiExplanation')}</span>
                    <button onClick={() => setExplanation(null)} className="text-xs text-[#7a9bb8] hover:text-[#c8daea]">✕</button>
                  </div>
                  <p className="text-sm text-[#c8daea] whitespace-pre-wrap">{explanation}</p>
                </div>
              )}

              {/* AI 优化面板 */}
              {optimization && (
                <div className="border-t border-[#1e2d42] p-4 bg-[#0d1117]">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs text-gray-400 font-medium">{t('mainContent.aiOptimization')}</span>
                    <button onClick={() => setOptimization(null)} className="text-xs text-[#7a9bb8] hover:text-[#c8daea]">✕</button>
                  </div>
                  <p className="text-sm text-[#c8daea] whitespace-pre-wrap">{optimization}</p>
                </div>
              )}
            </div>
          </div>
        )
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-[#7a9bb8] bg-[#111922]">
          <DatabaseZap size={64} className="mb-4 opacity-20" />
          <p className="text-lg">{t('mainContent.noActiveEditor')}</p>
          <p className="text-sm mt-2 opacity-60">{t('mainContent.selectItemToView')}</p>
        </div>
      )}

      {/* Tab 右键菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#003d2f] hover:text-white"
            onClick={() => {
              const e = { stopPropagation: () => {} } as React.MouseEvent;
              closeTab(e, contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            {t('mainContent.close')}
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#003d2f] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={tabs.findIndex(t => t.id === contextMenu.tabId) === 0}
            onClick={() => {
              closeTabsLeft(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            {t('mainContent.closeLeft')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#003d2f] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={tabs.findIndex(t => t.id === contextMenu.tabId) === tabs.length - 1}
            onClick={() => {
              closeTabsRight(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            {t('mainContent.closeRight')}
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#003d2f] hover:text-white"
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
