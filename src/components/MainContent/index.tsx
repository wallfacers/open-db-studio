import React, { useCallback, useEffect, useRef, useState } from 'react';
import MonacoEditor, { type BeforeMount, type OnMount, type Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorType, languages as MonacoLanguages, IRange as MonacoIRange } from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { FullSchemaInfo } from '../../types';
import { useAppStore } from '../../store/appStore';

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
  FileCode2, X, Play, Square, FileEdit, Settings, DatabaseZap, ChevronDown, ChevronRight, Folder,
  RefreshCw, Download, Search, Filter, Table, TableProperties, Plus, Lightbulb, Bot, Maximize2,
  BarChart2, Scissors, Copy, Clipboard, CirclePlay, TextSelect, MessageSquare, Workflow, Sparkles,
} from 'lucide-react';
import { DropdownSelect } from '../common/DropdownSelect';
import { TableDataView } from './TableDataView';
import { TableStructureView } from './TableStructureView';
import { CellEditorModal } from './CellEditorModal';
import ERDiagram from '../ERDiagram';
import { MetricTab } from '../MetricsExplorer/MetricTab';
import { MetricListPanel } from '../MetricsExplorer/MetricListPanel';
import SeaTunnelJobTab from '../SeaTunnelJobTab';
import { useQueryStore, useConnectionStore, useAiStore } from '../../store';
import { useTreeStore } from '../../store/treeStore';
import type { ToastLevel } from '../Toast';
import { Tooltip } from '../common/Tooltip';
import { buildErrorContext } from '../../utils/errorContext';
import { askAiWithContext } from '../../utils/askAi';
import { MarkdownContent } from '../shared/MarkdownContent';

function getSqlAtCursor(sql: string, cursorOffset: number): string {
  const parts = sql.split(';');
  let offset = 0;
  for (const part of parts) {
    const end = offset + part.length;
    if (cursorOffset <= end) {
      const trimmed = part.trim();
      return trimmed !== '' ? trimmed : sql.trim();
    }
    offset = end + 1;
  }
  return sql.trim();
}

interface MainContentProps {
  handleFormat: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
  resultsHeight: number;
  handleResultsResize: (e: React.MouseEvent) => void;
  showError?: (msg: string, ctx?: string | null) => void;
}

interface ContextMenu {
  tabId: string;
  x: number;
  y: number;
}

interface ResultCellContextMenuProps {
  x: number; y: number; colIdx: number;
  columns: string[];
  row: (string | number | boolean | null)[];
  onClose: () => void;
  onCopyCell: () => void;
  onCopyRow: () => void;
  onCopyInsert: () => void;
  onCopyUpdate: () => void;
  onCopyDelete: () => void;
  onViewCell?: () => void;
}

const ResultCellContextMenu = React.forwardRef<HTMLDivElement, ResultCellContextMenuProps>(
  ({ x, y, colIdx, onClose, onCopyCell, onCopyRow, onCopyInsert, onCopyUpdate, onCopyDelete, onViewCell }, ref) => {
    const { t } = useTranslation();
    const [pos, setPos] = React.useState({ x, y });
    const [sqlOpen, setSqlOpen] = React.useState(false);
    const sqlItemRef = React.useRef<HTMLDivElement>(null);
    const [sqlToLeft, setSqlToLeft] = React.useState(false);
    const [sqlToTop, setSqlToTop] = React.useState(false);

    React.useLayoutEffect(() => {
      const el = (ref as React.RefObject<HTMLDivElement>)?.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const nx = x + width > vw ? Math.max(4, vw - width - 4) : x;
      const ny = y + height > vh ? Math.max(4, vh - height - 4) : y;
      if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
    }, [x, y]);

    const item = 'px-4 py-1.5 hover:bg-[#1a2639] cursor-pointer text-[#c8daea] flex items-center justify-between text-xs';
    const divider = 'border-t border-[#1e2d42] my-1';

    return (
      <div
        ref={ref}
        style={{ position: 'fixed', top: pos.y, left: pos.x, zIndex: 9999 }}
        className="bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl text-xs min-w-[160px] py-1"
        onContextMenu={e => e.preventDefault()}
      >
        {colIdx >= 0 && (
          <div className={item} onClick={onCopyCell}>{t('tableDataView.copyCellValue')}</div>
        )}
        {colIdx >= 0 && onViewCell && (
          <div className={item} onClick={onViewCell}>{t('tableDataView.viewFullContent')}</div>
        )}
        <div className={item} onClick={onCopyRow}>{t('tableDataView.copyRow')}</div>
        <div className={divider} />
        <div
          ref={sqlItemRef}
          className={`${item} relative`}
          onClick={e => {
            e.stopPropagation();
            if (!sqlOpen && sqlItemRef.current) {
              const r = sqlItemRef.current.getBoundingClientRect();
              setSqlToLeft(r.right + 160 > window.innerWidth);
              setSqlToTop(r.bottom + 92 > window.innerHeight);
            }
            setSqlOpen(v => !v);
          }}
        >
          <span>{t('tableDataView.copyAsSql')}</span>
          <ChevronDown size={12} className={`text-[#7a9bb8] transition-transform ${sqlOpen ? '' : '-rotate-90'}`} />
          {sqlOpen && (
            <div className={`absolute ${sqlToLeft ? 'right-full' : 'left-full'} ${sqlToTop ? 'bottom-0' : 'top-0'} bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl text-xs min-w-[140px] py-1`}>
              <div className={item} onClick={onCopyInsert}>{t('tableDataView.copyAsInsertSql')}</div>
              <div className={item} onClick={onCopyUpdate}>{t('tableDataView.copyAsUpdateSql')}</div>
              <div className={item} onClick={onCopyDelete}>{t('tableDataView.copyAsDeleteSql')}</div>
            </div>
          )}
        </div>
      </div>
    );
  }
);

// ── 等待 SQL 解释首词的弹跳动画（复用 ai-dot 样式） ────────────────────────
const ExplanationTypingIndicator: React.FC = () => {
  const { t } = useTranslation();
  const [msgIdx, setMsgIdx] = useState(0);
  const messages = [
    t('assistant.waitMsg0'),
    t('assistant.waitMsg1'),
    t('assistant.waitMsg2'),
  ];
  useEffect(() => {
    const id = setInterval(() => setMsgIdx((i) => (i + 1) % messages.length), 2200);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 p-4">
      <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7] flex-shrink-0" />
      <span className="text-xs text-[#5b8ab0] animate-pulse">{messages[msgIdx]}</span>
    </div>
  );
};

export const MainContent: React.FC<MainContentProps> = ({
  handleFormat, showToast,
  resultsHeight, handleResultsResize,
  showError,
}) => {
  const { t } = useTranslation();
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);
  const { tabs, activeTabId: activeTab, setActiveTabId: setActiveTab,
          closeTab, closeAllTabs, closeTabsLeft, closeTabsRight, closeOtherTabs,
          updateTabContext,
          sqlContent, setSql, executeQuery, isExecuting: isExecutingMap, results, error, diagnosis,
          removeResult, removeResultsLeft, removeResultsRight, removeOtherResults, clearResults,
          explanationContent, explanationStreaming,
          appendExplanationContent, clearExplanation, setExplanationStreaming, startExplanation,
          toggleGhostText } = useQueryStore();
  const { activeConnectionId } = useConnectionStore();
  const { nodes } = useTreeStore();
  const { explainSql, isExplaining: isExplainingMap, cancelExplainSql } = useAiStore();
  const isExecuting = isExecutingMap[activeTab] ?? false;
  const isExplaining = isExplainingMap[activeTab] ?? false;
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [resultContextMenu, setResultContextMenu] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [explanationContextMenu, setExplanationContextMenu] = useState<{ x: number; y: number } | null>(null);
  const explanationContextMenuRef = useRef<HTMLDivElement>(null);
  const [resultCellViewer, setResultCellViewer] = useState<{ value: string | null; columnName: string } | null>(null);
  const [resultCellMenu, setResultCellMenu] = useState<{ x: number; y: number; rowIdx: number; colIdx: number } | null>(null);
  const resultCellMenuRef = useRef<HTMLDivElement>(null);
  const [editorContextMenu, setEditorContextMenu] = useState<{
    x: number; y: number;
    selectedSql: string;
    cursorOffset: number;
    selectionRange: MonacoIRange | null;
  } | null>(null);
  const resultContextMenuRef = useRef<HTMLDivElement>(null);
  const editorContextMenuRef = useRef<HTMLDivElement>(null);
  // 上下文选择器动态缓存：数据库列表 key = connId，schema 列表 key = "connId/database"
  const [contextDatabases, setContextDatabases] = useState<Record<number, string[]>>({});
  const [contextSchemas, setContextSchemas] = useState<Record<string, string[]>>({});
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const schemaRef = useRef<FullSchemaInfo | null>(null);

  // ── NL→SQL (ai_generate_sql_v2) 状态 ───────────────────────────────────────
  interface TextToSqlResult {
    sql: string;
    /** 图谱上下文；图谱为空或无命中时为 null */
    graph_context: {
      relevant_tables: string[];
      join_paths: string[];
      metrics: string[];
      schema_ddl: string;
    } | null;
    validation_ok: boolean;
    validation_warning: string | null;
  }
  const [nlInput, setNlInput] = useState('');
  const [nlPanelOpen, setNlPanelOpen] = useState(false);
  const [nlLoading, setNlLoading] = useState(false);
  const [graphCtxExpanded, setGraphCtxExpanded] = useState(false);
  // key = tabId, value = 图谱上下文摘要文本
  const [graphCtxByTab, setGraphCtxByTab] = useState<Record<string, string>>({});
  const nlInputRef = useRef<HTMLInputElement>(null);

  const graphCtx = graphCtxByTab[activeTab] ?? null;

  const handleGenerateSqlV2 = async () => {
    const connId = activeTabObj?.queryContext?.connectionId ?? null;
    if (!nlInput.trim()) return;
    if (!connId) {
      showToast(t('mainContent.selectConnectionAndDatabase'), 'warning');
      return;
    }
    setNlLoading(true);
    try {
      const result = await invoke<TextToSqlResult>('ai_generate_sql_v2', {
        question: nlInput.trim(),
        connectionId: connId,
        history: [],
      });
      setSql(activeTab, result.sql);
      // 构建图谱上下文摘要文本（graph_context 为 null 时表示图谱未构建或无命中）
      const ctxParts: string[] = [];
      if (result.graph_context) {
        if (result.graph_context.relevant_tables.length > 0) {
          ctxParts.push(`相关表：${result.graph_context.relevant_tables.join('、')}`);
        }
        if (result.graph_context.join_paths.length > 0) {
          ctxParts.push(`JOIN 路径：${result.graph_context.join_paths.join('；')}`);
        }
        if (result.graph_context.metrics.length > 0) {
          ctxParts.push(`指标定义：\n${result.graph_context.metrics.map(m => `  • ${m}`).join('\n')}`);
        }
      }
      if (ctxParts.length > 0) {
        setGraphCtxByTab(prev => ({ ...prev, [activeTab]: ctxParts.join('\n') }));
        setGraphCtxExpanded(false);
      } else {
        setGraphCtxByTab(prev => { const n = { ...prev }; delete n[activeTab]; return n; });
      }
      if (result.validation_warning) {
        showToast(`SQL 校验警告：${result.validation_warning}`, 'warning');
      }
      setNlPanelOpen(false);
      setNlInput('');
    } catch (e) {
      showToast(`AI 生成失败：${String(e)}`, 'error');
    } finally {
      setNlLoading(false);
    }
  };

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
  const inlineProviderRegistered = useRef(false);
  const inlineDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);

  const handleEditorDidMount: OnMount = (editor, monaco: Monaco) => {
    editorRef.current = editor;

    // 同步光标/选区信息到 queryStore，供 Tool Bridge 消歧
    const syncEditorInfo = () => {
      const model = editor.getModel();
      if (!model) return;
      const selection = editor.getSelection();
      const cursorPos = editor.getPosition();
      const cursorOffset = cursorPos
        ? model.getOffsetAt(cursorPos)
        : 0;
      const selectedText =
        selection && !selection.isEmpty()
          ? model.getValueInRange(selection)
          : null;
      useQueryStore.getState().setEditorInfo(
        useQueryStore.getState().activeTabId,
        {
          cursorOffset,
          selectedText,
          cursorLine: cursorPos ? cursorPos.lineNumber - 1 : 0,
          cursorColumn: cursorPos ? cursorPos.column - 1 : 0,
          selectionStartLine: selection ? selection.startLineNumber - 1 : 0,
          selectionEndLine: selection ? selection.endLineNumber - 1 : 0,
        },
      );
    };
    editor.onDidChangeCursorPosition(syncEditorInfo);
    editor.onDidChangeCursorSelection(syncEditorInfo);
    syncEditorInfo(); // 初始化一次

    if (completionProviderRegistered.current) return;
    completionProviderRegistered.current = true;

    // 阻止浏览器原生右键菜单（Monaco 的 e.event.preventDefault 只影响 Monaco 内部事件）
    editor.getDomNode()?.addEventListener('contextmenu', (e) => e.preventDefault());

    editor.onContextMenu((e) => {
      e.event.preventDefault();
      const sel = editor.getSelection();
      const selectedSql = (sel && !sel.isEmpty())
        ? editor.getModel()?.getValueInRange(sel) ?? ''
        : '';
      const pos = editor.getPosition();
      const cursorOffset = pos ? (editor.getModel()?.getOffsetAt(pos) ?? 0) : 0;
      setEditorContextMenu({
        x: e.event.posx,
        y: e.event.posy,
        selectedSql,
        cursorOffset,
        selectionRange: (sel && !sel.isEmpty()) ? sel : null,
      });
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

    // ─── AI Ghost Text Inline Completion Provider ───────────────────────────
    if (!inlineProviderRegistered.current) {
      inlineProviderRegistered.current = true;

      // Schema 上下文构建
      function buildSchemaContext(): string {
        const schema = schemaRef.current;
        if (!schema) return '';
        return schema.tables
          .map(t =>
            `Table ${t.name}(${t.columns.map(c => `${c.name} ${c.data_type}`).join(', ')})`
          )
          .join('\n');
      }

      monaco.languages.registerInlineCompletionsProvider('sql', {
        provideInlineCompletions: (
          model: Parameters<MonacoLanguages.InlineCompletionsProvider['provideInlineCompletions']>[0],
          position: Parameters<MonacoLanguages.InlineCompletionsProvider['provideInlineCompletions']>[1],
          _context: Parameters<MonacoLanguages.InlineCompletionsProvider['provideInlineCompletions']>[2],
          token: Parameters<MonacoLanguages.InlineCompletionsProvider['provideInlineCompletions']>[3],
        ) => {
          return new Promise((resolve) => {
            if (inlineDebounceTimer.current) clearTimeout(inlineDebounceTimer.current);

            inlineDebounceTimer.current = setTimeout(async () => {
              try {
                // ── 1. 取当前 Tab（每次从 store 实时读取，避免闭包陈旧）
                const storeState = useQueryStore.getState();
                const currentActiveTabId = storeState.activeTabId;
                const currentTab = storeState.tabs.find(t => t.id === currentActiveTabId);

                // ── 2. 检查开关
                if (!(currentTab?.ghostTextEnabled ?? true)) {
                  resolve({ items: [] });
                  return;
                }

                // ── 3. 检查连接
                const tabConnectionId = currentTab?.queryContext?.connectionId;
                if (!tabConnectionId) {
                  resolve({ items: [] });
                  return;
                }

                // ── 4. 检查无选中
                const selection = editorRef.current?.getSelection();
                if (selection && !selection.isEmpty()) {
                  resolve({ items: [] });
                  return;
                }

                // ── 5. 检查光标前字符数（≥ 2 非空白）
                const offset = model.getOffsetAt(position);
                const fullText = model.getValue();
                const textBefore = fullText.slice(0, offset);
                if (textBefore.replace(/\s/g, '').length < 2) {
                  resolve({ items: [] });
                  return;
                }

                // ── 6. cancellation 检查（前置）
                if (token.isCancellationRequested) {
                  resolve({ items: [] });
                  return;
                }

                // ── 7. 构建上下文
                const sqlBefore = textBefore.slice(-4000); // 传前 4000 字节，Rust 再截 2000 字符
                const sqlAfter = fullText.slice(offset, offset + 1000);

                const lineBeforeCursor = model
                  .getLineContent(position.lineNumber)
                  .slice(0, position.column - 1);
                const hint = lineBeforeCursor.trim().length > 0 ? 'single_line' : 'multi_line';

                const schemaContext = buildSchemaContext();
                const historyContext = storeState.queryHistory
                  .slice(0, 5)
                  .map(h => h.sql)
                  .join('\n---\n');

                // ── 8. 调用 Rust
                const result = await invoke<string>('ai_inline_complete', {
                  connectionId: tabConnectionId,
                  sqlBefore,
                  sqlAfter,
                  schemaContext,
                  historyContext,
                  hint,
                });

                // ── 9. cancellation 检查（后置）
                if (token.isCancellationRequested || !result) {
                  resolve({ items: [] });
                  return;
                }

                // ── 10. 返回补全项
                resolve({
                  items: [
                    {
                      insertText: result,
                      range: {
                        startLineNumber: position.lineNumber,
                        startColumn: position.column,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column,
                      },
                    },
                  ],
                });
              } catch {
                // 静默降级
                resolve({ items: [] });
              }
            }, 600);
          });
        },
        freeInlineCompletions: () => {},
      });
    }
  };

  const activeTabObj = tabs.find(t => t.id === activeTab);
  const currentSql = sqlContent[activeTab] ?? '';
  const currentResults = results[activeTab] ?? [];
  const [selectedResultPane, setSelectedResultPane] = useState<number | 'explanation'>(0);

  // Reset selected result index when active editor tab changes
  useEffect(() => {
    setSelectedResultPane(0);
  }, [activeTab]);

  // Reset to first result tab after a new execution completes
  useEffect(() => {
    if (!isExecuting) {
      setSelectedResultPane(0);
    }
  }, [isExecuting]);

  // 解释内容消失时自动切回第一个结果集（避免 Zustand/React 批处理差异导致残留空白页）
  useEffect(() => {
    if (
      selectedResultPane === 'explanation' &&
      !explanationStreaming[activeTab] &&
      !explanationContent[activeTab]
    ) {
      setSelectedResultPane(0);
    }
  }, [explanationStreaming, explanationContent, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Toast on execution error so user gets immediate feedback
  useEffect(() => {
    if (error) {
      const ctx = buildErrorContext('sql_execute', { rawError: error });
      if (showError) {
        showError(ctx.userMessage, ctx.markdownContext);
      } else {
        showToast(ctx.userMessage, 'error');
      }
    }
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  // 结果集右键菜单：SQL 构建与复制
  const resultCopyToClipboard = async (text: string) => {
    try {
      await writeText(text);
      showToast(t('tableDataView.sqlCopied'), 'success');
    } catch (e) {
      showToast(`${t('tableDataView.copyFailed')}: ${String(e)}`, 'error');
    }
    setResultCellMenu(null);
  };

  const getResultRow = (rowIdx: number) => (typeof selectedResultPane === 'number' ? currentResults[selectedResultPane] : undefined)?.rows[rowIdx] ?? [];
  const getResultCols = () => (typeof selectedResultPane === 'number' ? currentResults[selectedResultPane] : undefined)?.columns ?? [];

  const buildResultInsertSql = (rowIdx: number) => {
    const cols = getResultCols().map(c => `\`${c}\``).join(', ');
    const vals = getResultRow(rowIdx).map(v => v === null ? 'NULL' : `'${String(v).replace(/'/g, "\\'")}'`).join(', ');
    return `INSERT INTO \`<table_name>\` (${cols}) VALUES (${vals});`;
  };

  const buildResultUpdateSql = (rowIdx: number) => {
    const cols = getResultCols();
    const row = getResultRow(rowIdx);
    const sets = cols.map((c, i) => `\`${c}\` = ${row[i] === null ? 'NULL' : `'${String(row[i]).replace(/'/g, "\\'")}'`}`).join(', ');
    return `UPDATE \`<table_name>\` SET ${sets} WHERE \`<pk_column>\` = '<pk_value>';`;
  };

  const buildResultDeleteSql = (rowIdx: number) => {
    const cols = getResultCols();
    const row = getResultRow(rowIdx);
    const firstCol = cols[0] ?? '<pk_column>';
    const firstVal = row[0] === null ? 'NULL' : `'${String(row[0]).replace(/'/g, "\\'")}'`;
    return `DELETE FROM \`<table_name>\` WHERE \`${firstCol}\` = ${firstVal};`;
  };

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

  const handleExplain = async (sqlOverride?: string) => {
    const connId = activeTabObj?.queryContext?.connectionId ?? null;
    if (!currentSql.trim() || !connId) {
      showToast(t('mainContent.inputSqlAndSelectConnection'), 'warning');
      return;
    }
    let sqlToExplain: string;
    if (sqlOverride !== undefined) {
      sqlToExplain = sqlOverride.trim() || currentSql;
    } else {
      const editor = editorRef.current;
      const selection = editor?.getSelection();
      const selectedSql =
        selection && !selection.isEmpty()
          ? editor!.getModel()?.getValueInRange(selection) ?? ''
          : '';
      sqlToExplain = selectedSql.trim() ? selectedSql : currentSql;
    }

    startExplanation(activeTab);       // 原子操作：清内容 + streaming=true（一次 zustand set）
    setSelectedResultPane('explanation');

    try {
      await explainSql(
        sqlToExplain,
        connId,
        activeTabObj?.queryContext?.database ?? null,
        activeTab,
        (delta) => appendExplanationContent(activeTab, delta),
        () => setExplanationStreaming(activeTab, false),
        (err) => {
          setExplanationStreaming(activeTab, false);
          showToast(err, 'error');
        },
      );
    } catch (e) {
      const ctx = buildErrorContext('ai_request', { rawError: String(e) });
      if (showError) showError(ctx.userMessage, ctx.markdownContext);
      else showToast(ctx.userMessage, 'error');
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
      if (explanationContextMenuRef.current && !explanationContextMenuRef.current.contains(e.target as Node)) {
        setExplanationContextMenu(null);
      }
      if (editorContextMenuRef.current && !editorContextMenuRef.current.contains(e.target as Node)) {
        setEditorContextMenu(null);
      }
      if (resultCellMenuRef.current && !resultCellMenuRef.current.contains(e.target as Node)) {
        setResultCellMenu(null);
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
            ) : tab.type === 'table_structure' ? (
              <Settings size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`} />
            ) : tab.type === 'metric' ? (
              <BarChart2 size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`} />
            ) : tab.type === 'metric_list' ? (
              <TableProperties size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`} />
            ) : tab.type === 'table' ? (
              <Table size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`} />
            ) : tab.type === 'seatunnel_job' ? (
              <Workflow size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`} />
            ) : (
              <TableProperties size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`} />
            )}
            <span className="truncate flex-1 text-xs">{tab.title}</span>
            <Tooltip content={t('mainContent.closeTab')}>
              <div
                className="ml-2 p-0.5 rounded-sm hover:bg-[#2a3f5a] opacity-100"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
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
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <TableDataView
              tableName={activeTabObj.title}
              dbName={activeTabObj.db || ''}
              connectionId={activeTabObj.connectionId}
              schema={activeTabObj.schema}
              showToast={showToast}
            />
          </div>
        ) : activeTabObj.type === 'table_structure' ? (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <TableStructureView
              connectionId={activeTabObj.connectionId!}
              tableName={activeTabObj.isNewTable ? undefined : activeTabObj.title}
              database={activeTabObj.db}
              schema={activeTabObj.schema}
              onSuccess={() => showToast('操作成功', 'success')}
              showToast={showToast}
            />
          </div>
        ) : activeTabObj.type === 'metric' ? (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <MetricTab
              metricId={activeTabObj.metricId}
              newMetricScope={!activeTabObj.metricId ? activeTabObj.metricScope : undefined}
              onSaved={(id, title) => useQueryStore.getState().updateMetricTabId(activeTab, id, title)}
              onDelete={() => useQueryStore.getState().closeTab(activeTab)}
            />
          </div>
        ) : activeTabObj.type === 'metric_list' && activeTabObj.metricScope ? (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <MetricListPanel
              scope={activeTabObj.metricScope}
              onOpenMetric={(id, title) => useQueryStore.getState().openMetricTab(id, title)}
            />
          </div>
        ) : activeTabObj.type === 'seatunnel_job' ? (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <SeaTunnelJobTab tab={activeTabObj} key={activeTabObj.id} />
          </div>
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
                {isExplaining ? (
                  <Tooltip content={t('mainContent.stopExplaining')}>
                    <button
                      className="p-1.5 rounded transition-colors text-[#3794ff] hover:text-red-400 hover:bg-[#1e2d42] group"
                      onClick={() => { cancelExplainSql(activeTab); setExplanationStreaming(activeTab, false); }}
                    >
                      <span className="block group-hover:hidden">
                        <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      </span>
                      <span className="hidden group-hover:block">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </span>
                    </button>
                  </Tooltip>
                ) : (
                  <Tooltip content={!currentSql.trim() ? '' : t('mainContent.explainSql')}>
                    <button
                      className={`p-1.5 rounded transition-colors ${!currentSql.trim() ? 'text-[#7a9bb8] cursor-not-allowed opacity-30' : 'text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42]'}`}
                      onClick={() => handleExplain()}
                      disabled={!currentSql.trim() || !activeTabObj?.queryContext?.connectionId}
                    >
                      <Lightbulb size={16} />
                    </button>
                  </Tooltip>
                )}
                <div className="w-[1px] h-4 bg-[#2a3f5a] mx-1"></div>
                {/* NL→SQL 按钮 */}
                <div className="relative">
                  <Tooltip content="自然语言生成 SQL（图谱增强）">
                    <button
                      className={`p-1.5 rounded transition-colors ${nlPanelOpen ? 'bg-[#1e2d42] text-[#00c9a7]' : 'text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42]'}`}
                      onClick={() => {
                        setNlPanelOpen(v => !v);
                        setTimeout(() => nlInputRef.current?.focus(), 50);
                      }}
                      disabled={!activeTabObj?.queryContext?.connectionId}
                    >
                      <Bot size={16} />
                    </button>
                  </Tooltip>
                  {nlPanelOpen && (
                    <div className="absolute top-full left-0 mt-1 z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-xl w-72 p-2 flex flex-col gap-2">
                      <div className="text-[10px] text-[#7a9bb8] px-1">用自然语言描述查询需求，AI 将结合知识图谱生成 SQL</div>
                      <input
                        ref={nlInputRef}
                        className="bg-[#0d1117] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none focus:border-[#00c9a7] placeholder:text-[#3a5070]"
                        placeholder="例：查询上月各城市销售额排名前10"
                        value={nlInput}
                        onChange={e => setNlInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerateSqlV2(); } if (e.key === 'Escape') setNlPanelOpen(false); }}
                        disabled={nlLoading}
                      />
                      <button
                        className={`self-end px-3 py-1 text-xs rounded transition-colors ${nlLoading || !nlInput.trim() ? 'bg-[#1e2d42] text-[#3a5070] cursor-not-allowed' : 'bg-[#00c9a7] text-white hover:bg-[#00a98f]'}`}
                        onClick={handleGenerateSqlV2}
                        disabled={nlLoading || !nlInput.trim()}
                      >
                        {nlLoading ? '生成中…' : '生成 SQL'}
                      </button>
                    </div>
                  )}
                </div>
                <div className="w-[1px] h-4 bg-[#2a3f5a] mx-1"></div>
                <Tooltip content={t('mainContent.formatSql')}>
                  <button className="p-1.5 text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42] rounded transition-colors" onClick={handleFormat}>
                    <FileEdit size={16} />
                  </button>
                </Tooltip>
                <Tooltip content={(activeTabObj?.ghostTextEnabled ?? true) ? 'AI Ghost Text 补全（已开启）' : 'AI Ghost Text 补全（已关闭）'}>
                  <button
                    className={`p-1.5 rounded transition-colors ${
                      (activeTabObj?.ghostTextEnabled ?? true)
                        ? 'text-[#00c9a7] hover:text-[#00e4c0] hover:bg-[#1e2d42]'
                        : 'text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1e2d42]'
                    }`}
                    onClick={() => toggleGhostText(activeTab)}
                  >
                    <Sparkles size={16} />
                  </button>
                </Tooltip>
              </div>

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

            {/* 图谱上下文折叠块（由 ai_generate_sql_v2 填充） */}
            {graphCtx && (
              <div className="flex-shrink-0 border-b border-[#1e2d42] bg-[#111922]">
                <button
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#0e1e2e] transition-colors"
                  onClick={() => setGraphCtxExpanded(v => !v)}
                >
                  {graphCtxExpanded
                    ? <ChevronDown size={12} className="flex-shrink-0" />
                    : <ChevronRight size={12} className="flex-shrink-0" />}
                  <span className="text-[#4a8ab0]">▸ 参考了以下知识图谱上下文</span>
                  <span className="text-[#3a5070] ml-1">（点击展开）</span>
                </button>
                {graphCtxExpanded && (
                  <div className="px-3 pb-2">
                    <pre className="text-[11px] text-[#7a9bb8] bg-[#0d1117] rounded p-2 whitespace-pre-wrap font-mono leading-5 border border-[#1e2d42]">
                      {graphCtx}
                    </pre>
                  </div>
                )}
              </div>
            )}

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
              className="h-1 cursor-row-resize z-10 hover:bg-[#00c9a7] transition-colors"
              onMouseDown={handleResultsResize}
            />

            {/* Results Area */}
            <div className="flex flex-col bg-[#080d12] flex-shrink-0" style={{ height: resultsHeight }}>
              {/* Result tabs — one per result set, numbered from 1 */}
              <div className="flex items-center bg-[#0d1117] border-b border-[#1e2d42] overflow-x-auto">
                {currentResults.map((result, idx) => (
                  <div
                    key={idx}
                    className={`px-3 h-[38px] flex items-center gap-1.5 text-xs cursor-pointer border-t-2 border-r border-r-[#1e2d42] flex-shrink-0 ${selectedResultPane === idx ? 'bg-[#080d12] text-[#00c9a7] border-t-[#00c9a7]' : 'bg-[#1a2639] text-[#7a9bb8] border-t-transparent hover:bg-[#151d28]'}`}
                    onClick={() => setSelectedResultPane(idx)}
                    onContextMenu={(e) => { e.preventDefault(); setResultContextMenu({ idx, x: e.clientX, y: e.clientY }); }}
                  >
                    <span>
                      {result.kind === 'dml-report'
                        ? `${t('mainContent.dmlReport')}（${result.rows.length}${t('mainContent.dmlReportCount')}）`
                        : `${t('mainContent.resultSet')} ${idx + 1}`}
                    </span>
                    <Tooltip content={t('mainContent.closeResult')}>
                      <span
                        className="hover:bg-[#1e2d42] rounded p-0.5 leading-none"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeResult(activeTab, idx);
                          if (typeof selectedResultPane === 'number' && selectedResultPane >= idx && selectedResultPane > 0)
                            setSelectedResultPane((s) => typeof s === 'number' ? Math.max(0, s - 1) : s);
                        }}
                      >✕</span>
                    </Tooltip>
                  </div>
                ))}
                {/* SQL 解释 Tab — 仅在有内容或正在解释时显示 */}
                {(explanationStreaming[activeTab] || explanationContent[activeTab]) && (
                  <div
                    className={`px-3 h-[38px] flex items-center gap-1.5 text-xs cursor-pointer border-t-2 border-r border-r-[#1e2d42] flex-shrink-0 ${selectedResultPane === 'explanation' ? 'bg-[#080d12] text-[#00c9a7] border-t-[#00c9a7]' : 'bg-[#1a2639] text-[#7a9bb8] border-t-transparent hover:bg-[#151d28]'}`}
                    onClick={() => setSelectedResultPane('explanation')}
                    onContextMenu={(e) => { e.preventDefault(); setExplanationContextMenu({ x: e.clientX, y: e.clientY }); }}
                  >
                    {explanationStreaming[activeTab] ? (
                      <svg className="animate-spin flex-shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                    ) : (
                      <Lightbulb size={11} className="flex-shrink-0" />
                    )}
                    <span>{t('mainContent.sqlExplanation')}</span>
                    {!(explanationStreaming[activeTab] && explanationContent[activeTab]) && (
                      <Tooltip content={t('mainContent.closeResult')}>
                        <span
                          className="hover:bg-[#1e2d42] rounded p-0.5 leading-none"
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelExplainSql(activeTab);
                            clearExplanation(activeTab);
                            setSelectedResultPane(0);
                          }}
                        >✕</span>
                      </Tooltip>
                    )}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-auto">
                {selectedResultPane === 'explanation' ? (
                  <div className="p-4 h-full overflow-auto">
                    {explanationContent[activeTab] ? (
                      <div className="prose prose-invert prose-sm max-w-none text-[#c8daea]">
                        <MarkdownContent content={explanationContent[activeTab]} />
                      </div>
                    ) : explanationStreaming[activeTab] ? (
                      <ExplanationTypingIndicator />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-[#7a9bb8] text-sm gap-2 pt-12">
                        <Lightbulb size={32} className="opacity-20" />
                        <span>{t('mainContent.clickToExplain')}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
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
                    ) : (typeof selectedResultPane === 'number' ? currentResults[selectedResultPane] : undefined)?.kind === 'select' && (typeof selectedResultPane === 'number' ? currentResults[selectedResultPane] : undefined)?.columns.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-[#7a9bb8] text-sm">查询成功，暂无数据</div>
                    ) : (
                      <>
                        <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
                          <thead className="sticky top-0 bg-[#0d1117] z-10">
                            <tr>
                              <th className="w-10 px-2 py-1.5 border-b border-r border-[#1e2d42] text-[#7a9bb8] font-normal text-center">{t('tableDataView.serialNo')}</th>
                              {(typeof selectedResultPane === 'number' ? currentResults[selectedResultPane] : undefined)?.columns.map((col) => (
                                <th key={col} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(typeof selectedResultPane === 'number' ? currentResults[selectedResultPane] : undefined)?.rows.map((row, ri) => (
                              <tr key={ri} className="hover:bg-[#1a2639] border-b border-[#1e2d42]">
                                <td
                                  className="px-3 py-1.5 border-r border-[#1e2d42] text-[#7a9bb8] bg-[#0d1117] text-left text-xs select-none cursor-default"
                                  onContextMenu={e => { e.preventDefault(); setResultCellMenu({ x: e.clientX, y: e.clientY, rowIdx: ri, colIdx: -1 }); }}
                                >{ri + 1}</td>
                                {row.map((cell, ci) => {
                                  const colName = (typeof selectedResultPane === 'number' ? currentResults[selectedResultPane] : undefined)?.columns[ci] ?? '';
                                  const cellStr = cell === null ? null : String(cell);
                                  return (
                                    <td
                                      key={ci}
                                      className="px-3 py-1.5 border-r border-[#1e2d42] relative group text-left"
                                      onContextMenu={e => { e.preventDefault(); setResultCellMenu({ x: e.clientX, y: e.clientY, rowIdx: ri, colIdx: ci }); }}
                                    >
                                      <div
                                        className="max-w-[300px] truncate"
                                        title={cellStr ?? undefined}
                                      >
                                        {cell === null
                                          ? <span className="text-[#7a9bb8]">NULL</span>
                                          : typeof cell === 'string' && cell.startsWith('✓')
                                            ? <span className="text-green-400">{cell}</span>
                                            : <span className="text-[#c8daea]">{cellStr}</span>}
                                      </div>
                                      {cellStr !== null && (
                                        <button
                                          className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-0.5 hover:bg-[#243a55] rounded text-[#7a9bb8] hover:text-[#3a7bd5] transition-opacity"
                                          onClick={() => setResultCellViewer({ value: cellStr, columnName: colName })}
                                        >
                                          <Maximize2 size={10} />
                                        </button>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </>
                )}
              </div>

              {/* Status Bar */}
              {!isExecuting && !error && typeof selectedResultPane === 'number' && currentResults[selectedResultPane]?.kind === 'select' && currentResults[selectedResultPane]?.columns.length > 0 && (
                <div className="flex-shrink-0 h-7 flex items-center px-3 border-t border-[#1e2d42] bg-[#080d12] text-[#7a9bb8] text-xs">
                  <span>{currentResults[selectedResultPane]?.row_count} {t('mainContent.rows')} · {currentResults[selectedResultPane]?.duration_ms}ms</span>
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
            onClick={(e) => {
              e.stopPropagation();
              closeTab(contextMenu.tabId);
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
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={tabs.length <= 1}
            onClick={() => {
              closeOtherTabs(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            {t('mainContent.closeOther')}
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
              const willBeEmpty = currentResults.length === 1;
              const hasExplanation = !!(explanationContent[activeTab] || explanationStreaming[activeTab]);
              if (willBeEmpty && hasExplanation) {
                setSelectedResultPane('explanation');
              } else if (typeof selectedResultPane === 'number' && selectedResultPane >= resultContextMenu.idx && selectedResultPane > 0) {
                setSelectedResultPane(s => typeof s === 'number' ? Math.max(0, s - 1) : s);
              }
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
              setSelectedResultPane(0);
              setResultContextMenu(null);
            }}
          >
            {t('mainContent.closeLeft')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={
              resultContextMenu.idx === currentResults.length - 1 &&
              !(explanationContent[activeTab] && !explanationStreaming[activeTab])
            }
            onClick={() => {
              removeResultsRight(activeTab, resultContextMenu.idx);
              // 若右侧只剩解释 Tab 且未在流式输出中，一并关闭
              if (explanationContent[activeTab] && !explanationStreaming[activeTab]) {
                cancelExplainSql(activeTab);
                clearExplanation(activeTab);
                if (selectedResultPane === 'explanation') setSelectedResultPane(resultContextMenu.idx);
              } else if (typeof selectedResultPane === 'number' && selectedResultPane > resultContextMenu.idx) {
                setSelectedResultPane(resultContextMenu.idx);
              }
              setResultContextMenu(null);
            }}
          >
            {t('mainContent.closeRight')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={currentResults.length <= 1}
            onClick={() => {
              removeOtherResults(activeTab, resultContextMenu.idx);
              setSelectedResultPane(0);
              setResultContextMenu(null);
            }}
          >
            {t('mainContent.closeOther')}
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => {
              clearResults(activeTab);
              const hasExplanation = !!(explanationContent[activeTab] || explanationStreaming[activeTab]);
              setSelectedResultPane(hasExplanation ? 'explanation' : 0);
              setResultContextMenu(null);
            }}
          >
            {t('mainContent.closeAll')}
          </button>
        </div>
      )}

      {/* SQL 解释 Tab 右键菜单 */}
      {explanationContextMenu && (
        <div
          ref={explanationContextMenuRef}
          className="fixed z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[160px]"
          style={{ left: explanationContextMenu.x, top: explanationContextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!!(explanationStreaming[activeTab] && explanationContent[activeTab])}
            onClick={() => {
              cancelExplainSql(activeTab);
              clearExplanation(activeTab);
              setSelectedResultPane(0);
              setExplanationContextMenu(null);
            }}
          >
            {t('mainContent.close')}
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={currentResults.length === 0}
            onClick={() => {
              clearResults(activeTab);
              setSelectedResultPane('explanation');
              setExplanationContextMenu(null);
            }}
          >
            {t('mainContent.closeLeft')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled
          >
            {t('mainContent.closeRight')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={currentResults.length === 0}
            onClick={() => {
              clearResults(activeTab);
              setSelectedResultPane('explanation');
              setExplanationContextMenu(null);
            }}
          >
            {t('mainContent.closeOther')}
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
            onClick={() => {
              cancelExplainSql(activeTab);
              clearResults(activeTab);
              clearExplanation(activeTab);
              setSelectedResultPane(0);
              setExplanationContextMenu(null);
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
          className="fixed z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[200px]"
          style={{ left: editorContextMenu.x, top: editorContextMenu.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* 分组1：剪贴板 */}
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white flex items-center gap-2"
            onClick={() => {
              const ed = editorRef.current;
              const menu = editorContextMenu!;
              setEditorContextMenu(null);
              if (menu.selectedSql && menu.selectionRange && ed) {
                writeText(menu.selectedSql).then(() => {
                  ed.executeEdits('cut', [{ range: menu.selectionRange!, text: '' }]);
                  ed.focus();
                });
              } else if (ed) {
                // 无选区：剪切当前行（Monaco 原生行为，焦点恢复后触发）
                ed.focus();
                ed.trigger('keyboard', 'editor.action.clipboardCutAction', null);
              }
            }}
          >
            <Scissors size={13} color="#7a9bb8" />
            <span className="flex-1">{t('editorContextMenu.cut')}</span>
            <span className="text-[#3a5070]">Ctrl+X</span>
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white flex items-center gap-2"
            onClick={() => {
              const ed = editorRef.current;
              const menu = editorContextMenu!;
              setEditorContextMenu(null);
              const text = menu.selectedSql || ed?.getModel()?.getValue() || '';
              const range = menu.selectionRange ?? ed?.getModel()?.getFullModelRange();
              if (text && range) {
                writeText(menu.selectedSql
                  ? menu.selectedSql
                  : (ed?.getModel()?.getValueInRange(range) ?? ''));
              }
              ed?.focus();
              ed?.trigger('keyboard', 'editor.action.clipboardCopyAction', null);
            }}
          >
            <Copy size={13} color="#7a9bb8" />
            <span className="flex-1">{t('editorContextMenu.copy')}</span>
            <span className="text-[#3a5070]">Ctrl+C</span>
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white flex items-center gap-2"
            onClick={async () => {
              const ed = editorRef.current;
              setEditorContextMenu(null);
              try {
                const text = await navigator.clipboard.readText();
                if (!text || !ed) return;
                const sel = ed.getSelection();
                const pos = ed.getPosition();
                const range: MonacoIRange = (sel && !sel.isEmpty()) ? sel : {
                  startLineNumber: pos?.lineNumber ?? 1,
                  startColumn: pos?.column ?? 1,
                  endLineNumber: pos?.lineNumber ?? 1,
                  endColumn: pos?.column ?? 1,
                };
                ed.executeEdits(null, [{ range, text }]);
                ed.focus();
              } catch { /* 剪贴板读取失败时静默忽略 */ }
            }}
          >
            <Clipboard size={13} color="#7a9bb8" />
            <span className="flex-1">{t('editorContextMenu.paste')}</span>
            <span className="text-[#3a5070]">Ctrl+V</span>
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />

          {/* 分组2：执行 */}
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white flex items-center gap-2"
            onClick={() => {
              const ed = editorRef.current;
              if (ed) { const pos = ed.getPosition(); if (pos) ed.setPosition(pos); }
              handleExecute();
              setEditorContextMenu(null);
            }}
          >
            <Play size={13} color="#00c9a7" />
            <span className="flex-1">{t('editorContextMenu.executeAll')}</span>
            <span className="text-[#3a5070]">F5</span>
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 disabled:cursor-not-allowed"
            style={{ color: editorContextMenu.selectedSql.trim() ? '#c8daea' : '#3a5070' }}
            disabled={!editorContextMenu.selectedSql.trim()}
            onClick={() => { handleExecute(); setEditorContextMenu(null); }}
          >
            <CirclePlay size={13} color={editorContextMenu.selectedSql.trim() ? '#00c9a7' : '#3a5070'} />
            <span className="flex-1">{t('editorContextMenu.executeSelected')}</span>
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />

          {/* 分组3：编辑辅助 */}
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white flex items-center gap-2"
            onClick={() => { editorRef.current?.trigger('menu', 'editor.action.selectAll', null); setEditorContextMenu(null); }}
          >
            <TextSelect size={13} color="#7a9bb8" />
            <span className="flex-1">{t('editorContextMenu.selectAll')}</span>
            <span className="text-[#3a5070]">Ctrl+A</span>
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white flex items-center gap-2"
            onClick={() => { editorRef.current?.trigger('menu', 'editor.action.commentLine', null); setEditorContextMenu(null); }}
          >
            <MessageSquare size={13} color="#7a9bb8" />
            <span className="flex-1">{t('editorContextMenu.toggleComment')}</span>
            <span className="text-[#3a5070]">Ctrl+/</span>
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white flex items-center gap-2"
            onClick={() => { editorRef.current?.trigger('menu', 'editor.action.startFindReplaceAction', null); setEditorContextMenu(null); }}
          >
            <Search size={13} color="#7a9bb8" />
            <span className="flex-1">{t('editorContextMenu.findReplace')}</span>
            <span className="text-[#3a5070]">Ctrl+H</span>
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />

          {/* 分组4：SQL / AI */}
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] hover:text-white flex items-center gap-2"
            onClick={() => { handleFormat(); setEditorContextMenu(null); }}
          >
            <FileEdit size={13} color="#7a9bb8" />
            <span className="flex-1">{t('editorContextMenu.format')}</span>
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 disabled:cursor-not-allowed"
            style={{ color: activeTabObj?.queryContext?.connectionId ? '#c8daea' : '#3a5070' }}
            disabled={!activeTabObj?.queryContext?.connectionId}
            onClick={() => {
              const menu = editorContextMenu!;
              const sql = menu.selectedSql.trim()
                ? menu.selectedSql
                : getSqlAtCursor(currentSql, menu.cursorOffset);
              setEditorContextMenu(null);
              handleExplain(sql);
            }}
          >
            <Lightbulb size={13} color={activeTabObj?.queryContext?.connectionId ? '#5eb2f7' : '#3a5070'} />
            <span className="flex-1">{t('editorContextMenu.explainSql')}</span>
          </button>
        </div>
      )}

      {resultCellMenu && (
        <ResultCellContextMenu
          ref={resultCellMenuRef}
          x={resultCellMenu.x}
          y={resultCellMenu.y}
          colIdx={resultCellMenu.colIdx}
          columns={getResultCols()}
          row={getResultRow(resultCellMenu.rowIdx)}
          onClose={() => setResultCellMenu(null)}
          onCopyCell={() => {
            const val = getResultRow(resultCellMenu.rowIdx)[resultCellMenu.colIdx];
            resultCopyToClipboard(val === null ? 'NULL' : String(val));
          }}
          onCopyRow={() => {
            const row = getResultRow(resultCellMenu.rowIdx);
            resultCopyToClipboard(row.map(v => v === null ? 'NULL' : String(v)).join('\t'));
          }}
          onCopyInsert={() => resultCopyToClipboard(buildResultInsertSql(resultCellMenu.rowIdx))}
          onCopyUpdate={() => resultCopyToClipboard(buildResultUpdateSql(resultCellMenu.rowIdx))}
          onCopyDelete={() => resultCopyToClipboard(buildResultDeleteSql(resultCellMenu.rowIdx))}
          onViewCell={resultCellMenu.colIdx >= 0 ? () => {
            const val = getResultRow(resultCellMenu.rowIdx)[resultCellMenu.colIdx];
            const colName = getResultCols()[resultCellMenu.colIdx] ?? '';
            setResultCellViewer({ value: val === null ? null : String(val), columnName: colName });
            setResultCellMenu(null);
          } : undefined}
        />
      )}

      {resultCellViewer && (
        <CellEditorModal
          value={resultCellViewer.value}
          columnName={resultCellViewer.columnName}
          readOnly
          onConfirm={() => {}}
          onClose={() => setResultCellViewer(null)}
        />
      )}
    </div>
  );
};
