import React, { useCallback, useEffect, useRef, useState } from 'react';
import MonacoEditor, { type BeforeMount, type OnMount, type Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorType, languages as MonacoLanguages } from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { FullSchemaInfo, QueryContext } from '../../types';

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
      'menu.background':                   '#151d28',
      'menu.foreground':                   '#c8daea',
      'menu.selectionBackground':          '#1a2639',
      'menu.selectionForeground':          '#ffffff',
      'menu.separatorBackground':          '#2a3f5a',
      'menu.border':                       '#2a3f5a',
    },
  });
};
import {
  FileCode2, X, Play, Square, Save, FileEdit, Settings, DatabaseZap, ChevronDown, Folder,
  RefreshCw, Download, Search, Filter, TableProperties, Plus, Lightbulb, Zap, Bot
} from 'lucide-react';
import { DropdownSelect } from '../common/DropdownSelect';
import { TabData } from '../../App';
import { TableDataView } from './TableDataView';
import ERDiagram from '../ERDiagram';
import { useQueryStore, useConnectionStore, useAiStore } from '../../store';
import { useTreeStore } from '../../store/treeStore';
import type { ToastLevel } from '../Toast';
import { Tooltip } from '../common/Tooltip';

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
  showToast: (msg: string, level?: ToastLevel) => void;
  isDbMenuOpen: boolean;
  setIsDbMenuOpen: (isOpen: boolean) => void;
  isTableMenuOpen: boolean;
  setIsTableMenuOpen: (isOpen: boolean) => void;
  resultsHeight: number;
  handleResultsResize: (e: React.MouseEvent) => void;
  isPageSizeMenuOpen: boolean;
  setIsPageSizeMenuOpen: (isOpen: boolean) => void;
  isExportMenuOpen: boolean;
  setIsExportMenuOpen: (isOpen: boolean) => void;
  tableData: any[];
  executionTime: number;
  updateTabContext: (tabId: string, context: Partial<QueryContext>) => void;
  onOpenAssistant: () => void;
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
  resultsHeight, handleResultsResize,
  isPageSizeMenuOpen, setIsPageSizeMenuOpen, isExportMenuOpen, setIsExportMenuOpen,
  updateTabContext, onOpenAssistant,
}) => {
  const { t } = useTranslation();
  const { sqlContent, setSql, executeQuery, isExecuting, results, error, diagnosis,
          removeResult, removeResultsLeft, removeResultsRight, clearResults } = useQueryStore();
  const { activeConnectionId } = useConnectionStore();
  const { nodes } = useTreeStore();
  const { explainSql, isExplaining, optimizeSql, isOptimizing } = useAiStore();
  const [explanation, setExplanation] = useState<string | null>(null);
  const [optimization, setOptimization] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [resultContextMenu, setResultContextMenu] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [editorContextMenu, setEditorContextMenu] = useState<{ x: number; y: number } | null>(null);
  const resultContextMenuRef = useRef<HTMLDivElement>(null);
  const editorContextMenuRef = useRef<HTMLDivElement>(null);
  // 上下文选择器动态缓存：数据库列表 key = connId，schema 列表 key = "connId/database"
  const [contextDatabases, setContextDatabases] = useState<Record<number, string[]>>({});
  const [contextSchemas, setContextSchemas] = useState<Record<string, string[]>>({});
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
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);

  const handleEditorDidMount: OnMount = (editor, monaco: Monaco) => {
    editorRef.current = editor;
    if (completionProviderRegistered.current) return;
    completionProviderRegistered.current = true;

    editor.onContextMenu((e) => {
      e.event.preventDefault();
      setEditorContextMenu({ x: e.event.posx, y: e.event.posy });
    });

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

  // Toast on execution error so user gets immediate feedback
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExecute = useCallback(() => {
    const connId = activeTabObj?.queryContext?.connectionId ?? null;
    const database = activeTabObj?.queryContext?.database ?? null;
    if (!connId || !database) {
      showToast(t('mainContent.selectConnectionAndDatabase'), 'warning');
      return;
    }
    // Execute selected text if any, otherwise execute all
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const selectedSql = (selection && !selection.isEmpty())
      ? editor?.getModel()?.getValueInRange(selection)?.trim()
      : undefined;
    const schema = activeTabObj?.queryContext?.schema ?? null;
    executeQuery(connId, activeTab, selectedSql || undefined, database, schema);
  }, [activeTabObj, activeTab, showToast, executeQuery, t]);

  const handleClear = () => {
    setSql(activeTab, '');
  };

  const handleExplain = async () => {
    const connId = activeTabObj?.queryContext?.connectionId ?? null;
    if (!currentSql.trim() || !connId) {
      showToast(t('mainContent.inputSqlAndSelectConnection'), 'warning');
      return;
    }
    try {
      const result = await explainSql(currentSql, connId);
      setExplanation(result);
    } catch {
      showToast(t('mainContent.aiExplainFailed'), 'error');
    }
  };

  const handleOptimize = async () => {
    const connId = activeTabObj?.queryContext?.connectionId ?? null;
    if (!currentSql.trim() || !connId) {
      showToast(t('mainContent.inputSqlAndSelectConnection'), 'warning');
      return;
    }
    try {
      const result = await optimizeSql(currentSql, connId);
      setOptimization(result);
    } catch {
      showToast(t('mainContent.aiOptimizeFailed'), 'error');
    }
  };

  // 关闭右键菜单
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
      if (resultContextMenuRef.current && !resultContextMenuRef.current.contains(e.target as Node)) {
        setResultContextMenu(null);
      }
      if (editorContextMenuRef.current && !editorContextMenuRef.current.contains(e.target as Node)) {
        setEditorContextMenu(null);
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
  }, [handleExecute]);

  // Schema 选择器辅助变量
  const queryCtx = activeTabObj?.type === 'query' ? activeTabObj.queryContext : undefined;
  const selectedConnNode = queryCtx?.connectionId != null
    ? Array.from(nodes.values()).find(n => n.nodeType === 'connection' && n.meta.connectionId === queryCtx.connectionId)
    : undefined;
  const needsSchema = selectedConnNode?.meta.driver === 'postgres' || selectedConnNode?.meta.driver === 'oracle';
  const contextSchemaKey = queryCtx?.connectionId != null && queryCtx?.database
    ? `${queryCtx.connectionId}/${queryCtx.database}`
    : null;

  // 切换 tab 时，若 tab 已绑定连接但数据库列表还未缓存，自动加载
  useEffect(() => {
    const connId = queryCtx?.connectionId;
    if (connId && !contextDatabases[connId]) {
      invoke<string[]>('list_databases', { connectionId: connId })
        .then(dbs => setContextDatabases(prev => ({ ...prev, [connId]: dbs })))
        .catch((err) => console.warn('[list_databases]', err));
    }
  }, [queryCtx?.connectionId]);

  // 切换 tab 时，若已有数据库但 schema 列表未缓存，自动加载
  useEffect(() => {
    const connId = queryCtx?.connectionId;
    const db = queryCtx?.database;
    if (connId && db && !contextSchemas[`${connId}/${db}`]) {
      invoke<string[]>('list_schemas', { connectionId: connId, database: db })
        .then(schemas => setContextSchemas(prev => ({ ...prev, [`${connId}/${db}`]: schemas })))
        .catch((err) => console.warn('[list_schemas]', err));
    }
  }, [queryCtx?.connectionId, queryCtx?.database]);

  // 数据库下拉：优先动态缓存，回退到 treeStore 节点
  const availableDatabases: string[] = queryCtx?.connectionId && contextDatabases[queryCtx.connectionId]
    ? contextDatabases[queryCtx.connectionId]
    : Array.from(nodes.values())
        .filter(n => n.nodeType === 'database' && n.meta.connectionId === queryCtx?.connectionId)
        .map(n => n.meta.database ?? n.label)
        .filter(Boolean) as string[];

  const availableSchemas: string[] = contextSchemaKey && contextSchemas[contextSchemaKey]
    ? contextSchemas[contextSchemaKey]
    : [];

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
            <Tooltip content={t('mainContent.closeTab')}>
              <div
                className="ml-2 p-0.5 rounded-sm hover:bg-[#2a3f5a] opacity-100"
                onClick={(e) => closeTab(e, tab.id)}
              >
                <X size={12} />
              </div>
            </Tooltip>
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
            dbName={activeTabObj.db || ''}
            connectionId={activeTabObj.connectionId}
            schema={activeTabObj.schema}
            showToast={showToast}
          />
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Toolbar */}
            <div className="flex-shrink-0 h-10 flex items-center justify-between px-4 border-b border-[#1e2d42] bg-[#080d12]">
              <div className="flex items-center space-x-2">
                <Tooltip content={isExecuting ? t('mainContent.executing') : t('mainContent.execute')}>
                  <button
                    className={`p-1.5 rounded transition-colors ${isExecuting ? 'text-red-400 hover:text-red-300 hover:bg-[#1e2d42]' : 'text-[#00c9a7] hover:text-[#00a98f] hover:bg-[#1e2d42]'}`}
                    onClick={handleExecute}
                    disabled={isExecuting}
                  >
                    {isExecuting ? <Square size={16} /> : <Play size={16} />}
                  </button>
                </Tooltip>
                <Tooltip content={isExplaining ? t('mainContent.explaining') : t('mainContent.explainSql')}>
                  <button
                    className={`p-1.5 rounded transition-colors ${isExplaining ? 'text-[#7a9bb8] cursor-not-allowed opacity-50' : 'text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42]'}`}
                    onClick={handleExplain}
                    disabled={isExplaining || !activeTabObj?.queryContext?.connectionId}
                  >
                    <Lightbulb size={16} />
                  </button>
                </Tooltip>
                <Tooltip content={isOptimizing ? t('mainContent.optimizing') : t('mainContent.optimizeSql')}>
                  <button
                    className={`p-1.5 rounded transition-colors ${isOptimizing ? 'text-[#7a9bb8] cursor-not-allowed opacity-50' : 'text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42]'}`}
                    onClick={handleOptimize}
                    disabled={isOptimizing || !activeTabObj?.queryContext?.connectionId}
                  >
                    <Zap size={16} />
                  </button>
                </Tooltip>
                <div className="w-[1px] h-4 bg-[#2a3f5a] mx-1"></div>
                <Tooltip content={t('mainContent.saveSql')}>
                  <button className="p-1.5 text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42] rounded transition-colors" onClick={() => showToast(t('mainContent.sqlSaved'), 'info')}>
                    <Save size={16} />
                  </button>
                </Tooltip>
                <Tooltip content={t('mainContent.formatSql')}>
                  <button className="p-1.5 text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42] rounded transition-colors" onClick={handleFormat}>
                    <FileEdit size={16} />
                  </button>
                </Tooltip>
                <Tooltip content={t('mainContent.openEditorSettings')}>
                  <button className="p-1.5 text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42] rounded transition-colors" onClick={() => showToast(t('mainContent.openEditorSettings'), 'info')}>
                    <Settings size={16} />
                  </button>
                </Tooltip>
              </div>

              {/* AI 助手入口 */}
              <Tooltip content={t('mainContent.openAiAssistant')}>
                <button
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors bg-[#00c9a7]/10 text-[#00c9a7] hover:bg-[#00c9a7]/20 border border-[#00c9a7]/30 hover:border-[#00c9a7]/60"
                  onClick={onOpenAssistant}
                >
                  <Bot size={14} />
                  <span>AI</span>
                </button>
              </Tooltip>

              {/* 上下文选择器（右侧） */}
              <div className="flex items-center gap-1.5">
                <DropdownSelect
                  value={String(activeTabObj?.queryContext?.connectionId ?? '')}
                  placeholder={t('mainContent.selectConnection')}
                  className="w-32"
                  options={Array.from(nodes.values())
                    .filter(n => n.nodeType === 'connection')
                    .map(n => ({ value: String(n.meta.connectionId ?? ''), label: n.label }))}
                  onChange={(val) => {
                    const connId = val ? Number(val) : null;
                    updateTabContext(activeTab, { connectionId: connId, database: null, schema: null });
                    if (connId && !contextDatabases[connId]) {
                      invoke<string[]>('list_databases', { connectionId: connId })
                        .then(dbs => setContextDatabases(prev => ({ ...prev, [connId]: dbs })))
                        .catch((err) => console.warn('[list_databases]', err));
                    }
                  }}
                />
                <span className="text-[#7a9bb8] text-xs">›</span>
                <DropdownSelect
                  value={activeTabObj?.queryContext?.database ?? ''}
                  placeholder={t('mainContent.selectDatabase')}
                  className="w-28"
                  options={availableDatabases.map(db => ({ value: db, label: db }))}
                  onChange={(val) => {
                    const db = val || null;
                    updateTabContext(activeTab, { database: db, schema: null });
                    const connId = activeTabObj?.queryContext?.connectionId;
                    if (db && connId) {
                      invoke<string[]>('list_schemas', { connectionId: connId, database: db })
                        .then(schemas => setContextSchemas(prev => ({ ...prev, [`${connId}/${db}`]: schemas })))
                        .catch((err) => console.warn('[list_schemas]', err));
                    }
                  }}
                />
                {needsSchema && availableSchemas.length > 0 && (
                  <>
                    <span className="text-[#7a9bb8] text-xs">›</span>
                    <DropdownSelect
                      value={queryCtx?.schema ?? ''}
                      placeholder={t('mainContent.selectSchema')}
                      className="w-24"
                      options={availableSchemas.map(s => ({ value: s, label: s }))}
                      onChange={(val) => updateTabContext(activeTab, { schema: val || null })}
                    />
                  </>
                )}
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
                  contextmenu: false,
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
              {/* Result tabs — one per result set, numbered from 1 */}
              <div className="flex items-center bg-[#0d1117] border-b border-[#1e2d42] overflow-x-auto">
                {currentResults.length === 0 ? (
                  <div className="px-4 h-[38px] flex items-center text-xs text-[#00c9a7] border-t-2 border-t-[#00c9a7] border-r border-r-[#1e2d42] bg-[#080d12]">
                    {t('mainContent.resultSet')}
                  </div>
                ) : (
                  currentResults.map((result, idx) => (
                    <div
                      key={idx}
                      className={`px-3 h-[38px] flex items-center gap-1.5 text-xs cursor-pointer border-t-2 border-r border-r-[#1e2d42] flex-shrink-0 ${selectedResultIdx === idx ? 'bg-[#080d12] text-[#00c9a7] border-t-[#00c9a7]' : 'bg-[#1a2639] text-[#7a9bb8] border-t-transparent hover:bg-[#151d28]'}`}
                      onClick={() => setSelectedResultIdx(idx)}
                      onContextMenu={(e) => { e.preventDefault(); setResultContextMenu({ idx, x: e.clientX, y: e.clientY }); }}
                    >
                      <span>
                        {result.kind === 'dml-report'
                          ? `执行报告（${result.rows.length}条）`
                          : `${t('mainContent.resultSet')} ${idx + 1}`}
                      </span>
                      <Tooltip content={t('mainContent.closeResult')}>
                        <span
                          className="hover:bg-[#1e2d42] rounded p-0.5 leading-none"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeResult(activeTab, idx);
                            if (selectedResultIdx >= idx && selectedResultIdx > 0) setSelectedResultIdx(s => s - 1);
                          }}
                        >✕</span>
                      </Tooltip>
                    </div>
                  ))
                )}
              </div>

              <div className="flex-1 overflow-auto">
                {isExecuting ? (
                  <div className="p-4 text-gray-400 text-sm">{t('mainContent.executing')}</div>
                ) : error ? (
                  <div className="p-3 text-red-400 text-xs font-mono">
                    {error}
                    {diagnosis && (
                      <div className="mt-2 p-2 bg-[#1a2639] rounded text-[#c8daea] whitespace-pre-wrap font-sans">
                        <span className="text-[#3794ff]">{t('mainContent.aiDiagnosis')}</span>{diagnosis}
                      </div>
                    )}
                  </div>
                ) : currentResults.length === 0 ? (
                  <div className="p-4 text-[#7a9bb8] text-sm">{t('mainContent.resultsWillShowHere')}</div>
                ) : currentResults[selectedResultIdx]?.kind === 'select' && currentResults[selectedResultIdx]?.columns.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-[#7a9bb8] text-sm">查询成功，暂无数据</div>
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
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
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
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={tabs.findIndex(t => t.id === contextMenu.tabId) === 0}
            onClick={() => {
              closeTabsLeft(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            {t('mainContent.closeLeft')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
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
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => {
              closeAllTabs();
              setContextMenu(null);
            }}
          >
            {t('mainContent.closeAll')}
          </button>
        </div>
      )}

      {/* 结果集 Tab 右键菜单 */}
      {resultContextMenu && (
        <div
          ref={resultContextMenuRef}
          className="fixed z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[160px]"
          style={{ left: resultContextMenu.x, top: resultContextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => {
              removeResult(activeTab, resultContextMenu.idx);
              if (selectedResultIdx >= resultContextMenu.idx && selectedResultIdx > 0) setSelectedResultIdx(s => s - 1);
              setResultContextMenu(null);
            }}
          >
            {t('mainContent.close')}
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={resultContextMenu.idx === 0}
            onClick={() => {
              removeResultsLeft(activeTab, resultContextMenu.idx);
              setSelectedResultIdx(0);
              setResultContextMenu(null);
            }}
          >
            {t('mainContent.closeLeft')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={resultContextMenu.idx === currentResults.length - 1}
            onClick={() => {
              removeResultsRight(activeTab, resultContextMenu.idx);
              if (selectedResultIdx > resultContextMenu.idx) setSelectedResultIdx(resultContextMenu.idx);
              setResultContextMenu(null);
            }}
          >
            {t('mainContent.closeRight')}
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => {
              clearResults(activeTab);
              setSelectedResultIdx(0);
              setResultContextMenu(null);
            }}
          >
            {t('mainContent.closeAll')}
          </button>
        </div>
      )}

      {/* 编辑器区域自定义右键菜单 */}
      {editorContextMenu && (
        <div
          ref={editorContextMenuRef}
          className="fixed z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[160px]"
          style={{ left: editorContextMenu.x, top: editorContextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => {
              editorRef.current?.trigger('menu', 'editor.action.clipboardCutAction', null);
              setEditorContextMenu(null);
            }}
          >
            {t('editorContextMenu.cut')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => {
              editorRef.current?.trigger('menu', 'editor.action.clipboardCopyAction', null);
              setEditorContextMenu(null);
            }}
          >
            {t('editorContextMenu.copy')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => {
              editorRef.current?.trigger('menu', 'editor.action.clipboardPasteAction', null);
              setEditorContextMenu(null);
            }}
          >
            {t('editorContextMenu.paste')}
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => {
              editorRef.current?.trigger('menu', 'editor.action.selectAll', null);
              setEditorContextMenu(null);
            }}
          >
            {t('editorContextMenu.selectAll')}
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => {
              handleFormat();
              setEditorContextMenu(null);
            }}
          >
            {t('editorContextMenu.format')}
          </button>
        </div>
      )}
    </div>
  );
};
