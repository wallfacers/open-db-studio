import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, QueryHistory, Tab, SqlDiffProposal, EditorInfo, MetricScope, QueryContext } from '../types';
import { useAppStore } from './appStore';

/** 判断是否为返回结果集的查询语句 */
function isSelectLike(sql: string): boolean {
  const s = sql.trim().toUpperCase();
  return (
    s.startsWith('SELECT') ||
    s.startsWith('SHOW') ||
    s.startsWith('EXPLAIN') ||
    s.startsWith('WITH') ||
    s.startsWith('DESC ') ||
    s.startsWith('DESCRIBE ') ||
    s.startsWith('CALL')
  );
}

/** 从 SQL 提取操作类型关键字 */
function getSqlType(sql: string): string {
  const kw = sql.trim().toUpperCase().split(/\s+/)[0] ?? '';
  const labels: Record<string, string> = {
    INSERT: 'INSERT', UPDATE: 'UPDATE', DELETE: 'DELETE',
    CREATE: 'CREATE', ALTER: 'ALTER', DROP: 'DROP',
    TRUNCATE: 'TRUNCATE', RENAME: 'RENAME',
  };
  return labels[kw] ?? kw;
}

/** 截断 SQL 用于显示摘要 */
function truncateSql(sql: string, max = 40): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

interface StmtResult { stmt: string; result: QueryResult }

interface QueryState {
  tabs: Tab[];
  activeTabId: string;
  sqlContent: Record<string, string>;  // tabId → sql
  results: Record<string, QueryResult[]>;
  isExecuting: Record<string, boolean>;
  queryHistory: QueryHistory[];
  error: string | null;
  diagnosis: string | null;

  setSql: (tabId: string, sql: string) => void;
  setActiveTabId: (tabId: string) => void;
  openMetricTab: (metricId: number, title: string) => void;
  openMetricListTab: (scope: import('../types').MetricScope, title: string) => void;

  openQueryTab: (connId: number, connName: string, database?: string, schema?: string, initialSql?: string) => void;
  openTableDataTab: (tableName: string, connectionId: number, database?: string, schema?: string) => void;
  openTableStructureTab: (connectionId: number, database?: string, schema?: string, tableName?: string) => void;

  closeTab: (tabId: string) => void;
  closeAllTabs: () => void;
  closeTabsLeft: (tabId: string) => void;
  closeTabsRight: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  updateTabContext: (tabId: string, ctx: Partial<QueryContext>) => void;

  executeQuery: (connectionId: number, tabId: string, sqlOverride?: string, database?: string | null, schema?: string | null) => Promise<void>;
  loadHistory: (connectionId: number) => Promise<void>;
  removeResult: (tabId: string, idx: number) => void;
  removeResultsLeft: (tabId: string, idx: number) => void;
  removeResultsRight: (tabId: string, idx: number) => void;
  removeOtherResults: (tabId: string, idx: number) => void;
  clearResults: (tabId: string) => void;

  // SQL diff 提案（等待用户确认）
  pendingDiff: SqlDiffProposal | null;
  proposeSqlDiff: (proposal: SqlDiffProposal) => void;
  applyDiff: () => void;
  cancelDiff: () => void;

  // Monaco 编辑器光标/选区（由 MainContent 实时写入）
  editorInfo: Record<string, EditorInfo>;
  setEditorInfo: (tabId: string, info: EditorInfo) => void;

  // SQL 解释（per-tab，流式内容）
  explanationContent: Record<string, string>;
  explanationStreaming: Record<string, boolean>;
  setExplanationStreaming: (tabId: string, streaming: boolean) => void;
  appendExplanationContent: (tabId: string, delta: string) => void;
  clearExplanation: (tabId: string) => void;
  startExplanation: (tabId: string) => void;
}

const DEFAULT_TAB: Tab = { id: 'query-1', type: 'query', title: 'Query 1' };

export const useQueryStore = create<QueryState>((set, get) => ({
  tabs: [DEFAULT_TAB],
  activeTabId: DEFAULT_TAB.id,
  sqlContent: { [DEFAULT_TAB.id]: '' },
  results: {},
  isExecuting: {},
  queryHistory: [],
  error: null,
  diagnosis: null,
  pendingDiff: null,
  editorInfo: {},
  explanationContent: {},
  explanationStreaming: {},

  setSql: (tabId, sql) =>
    set((s) => ({ sqlContent: { ...s.sqlContent, [tabId]: sql } })),
  setActiveTabId: (tabId) => set({ activeTabId: tabId }),

  openMetricTab: (metricId, title) => {
    set(s => {
      const existing = s.tabs.find(t => t.type === 'metric' && t.metricId === metricId);
      if (existing) return { activeTabId: existing.id };
      const id = `metric_${metricId}_${Date.now()}`;
      const tab: Tab = { id, type: 'metric', title, metricId };
      return { tabs: [...s.tabs, tab], activeTabId: id };
    });
  },
  openMetricListTab: (scope, title) => {
    const key = `ml_${scope.connectionId}_${scope.database ?? ''}_${scope.schema ?? ''}`;
    set(s => {
      const existing = s.tabs.find(t => t.id === key);
      if (existing) return { activeTabId: key };
      const tab: Tab = {
        id: key,
        type: 'metric_list',
        title: `${title} 指标列表`,
        metricScope: scope,
      };
      return { tabs: [...s.tabs, tab], activeTabId: key };
    });
  },

  /** 每次调用均新建查询 Tab（无去重），适用于用户主动触发的"新建查询"操作 */
  openQueryTab: (connId, connName, database, schema, initialSql) => {
    let newTabId = '';
    set(s => {
      const id = `query_${connId}_${Date.now()}`;
      const queryCount = s.tabs.filter(t => t.type === 'query').length + 1;
      const tab: Tab = {
        id,
        type: 'query',
        title: `查询${queryCount}`,
        db: connName,
        queryContext: { connectionId: connId, database: database ?? null, schema: schema ?? null },
      };
      newTabId = id;
      return { tabs: [...s.tabs, tab], activeTabId: id };
    });
    if (initialSql && newTabId) get().setSql(newTabId, initialSql);
  },

  openTableDataTab: (tableName, connectionId, database, schema) => {
    const dbName = database ?? `conn_${connectionId}`;
    const id = `table_${connectionId}_${dbName}_${schema ?? ''}_${tableName}`;
    set(s => {
      if (s.tabs.find(t => t.id === id)) return { activeTabId: id };
      const tab: Tab = { id, type: 'table', title: tableName, db: dbName, connectionId, schema };
      return { tabs: [...s.tabs, tab], activeTabId: id };
    });
  },

  openTableStructureTab: (connectionId, database, schema, tableName) => {
    const dbName = database ?? `conn_${connectionId}`;
    const isNew = !tableName;
    const id = isNew
      ? `table_structure_new_${connectionId}_${dbName}_${schema ?? ''}_${Date.now()}`
      : `table_structure_${connectionId}_${dbName}_${schema ?? ''}_${tableName}`;
    set(s => {
      if (s.tabs.find(t => t.id === id)) return { activeTabId: id };
      const tab: Tab = {
        id, type: 'table_structure',
        title: tableName ?? '新建表',
        db: dbName, connectionId, schema,
        isNewTable: isNew,
      };
      return { tabs: [...s.tabs, tab], activeTabId: id };
    });
  },

  closeTab: (tabId) =>
    set(s => {
      const next = s.tabs.filter(t => t.id !== tabId);
      if (s.activeTabId !== tabId) return { tabs: next };
      const idx = s.tabs.findIndex(t => t.id === tabId);
      const newActive = next[Math.min(idx, next.length - 1)]?.id ?? '';
      return { tabs: next, activeTabId: newActive };
    }),

  closeAllTabs: () => set({ tabs: [], activeTabId: '' }),

  closeTabsLeft: (tabId) =>
    set(s => {
      const idx = s.tabs.findIndex(t => t.id === tabId);
      if (idx <= 0) return s;
      const next = s.tabs.slice(idx);
      const newActive = next.find(t => t.id === s.activeTabId) ? s.activeTabId : tabId;
      return { tabs: next, activeTabId: newActive };
    }),

  closeTabsRight: (tabId) =>
    set(s => {
      const idx = s.tabs.findIndex(t => t.id === tabId);
      if (idx === s.tabs.length - 1) return s;
      const next = s.tabs.slice(0, idx + 1);
      const newActive = next.find(t => t.id === s.activeTabId) ? s.activeTabId : tabId;
      return { tabs: next, activeTabId: newActive };
    }),

  closeOtherTabs: (tabId) =>
    set(s => ({
      tabs: s.tabs.filter(t => t.id === tabId),
      activeTabId: tabId,
    })),

  updateTabContext: (tabId, ctx) =>
    set(s => ({
      tabs: s.tabs.map(t =>
        t.id !== tabId ? t : {
          ...t,
          queryContext: { ...(t.queryContext ?? { connectionId: null, database: null, schema: null }), ...ctx },
        }
      ),
    })),

  executeQuery: async (connectionId, tabId, sqlOverride, database, schema) => {
    const sql = sqlOverride ?? get().sqlContent[tabId] ?? '';
    if (!sql.trim()) return;

    // NOTE: 简单按 ; 分割，不支持字符串字面量或注释中的分号，是已知限制
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    // 写入操作上下文快照（供错误诊断使用）
    useAppStore.getState().setLastOperationContext({
      type: 'sql_execute',
      connectionId,
      database: database ?? undefined,
      schema: schema ?? undefined,
      sql,
    });

    set(s => ({ isExecuting: { ...s.isExecuting, [tabId]: true }, error: null, diagnosis: null }));

    const selectResults: StmtResult[] = [];
    const dmlResults: StmtResult[] = [];

    try {
      for (const stmt of statements) {
        const result = await invoke<QueryResult>('execute_query', {
          connectionId,
          sql: stmt,
          database: database ?? null,
          schema: schema ?? null,
        });
        const isSelect = isSelectLike(stmt) || result.columns.length > 0;
        const enriched: QueryResult = {
          ...result,
          sql: stmt,
          kind: isSelect ? 'select' : undefined,
        };
        if (isSelect) {
          selectResults.push({ stmt, result: enriched });
        } else {
          dmlResults.push({ stmt, result: enriched });
        }
      }

      const finalList: QueryResult[] = selectResults.map(r => r.result);

      if (dmlResults.length > 0) {
        const totalDuration = dmlResults.reduce((sum, r) => sum + r.result.duration_ms, 0);
        const dmlReport: QueryResult = {
          columns: ['#', '操作', 'SQL摘要', '影响行数', '耗时(ms)', '状态'],
          rows: dmlResults.map((item, i) => [
            String(i + 1),
            getSqlType(item.stmt),
            truncateSql(item.stmt),
            String(item.result.row_count),
            String(item.result.duration_ms),
            '✓ 成功',
          ]),
          row_count: dmlResults.reduce((sum, r) => sum + r.result.row_count, 0),
          duration_ms: totalDuration,
          kind: 'dml-report',
          sql: `-- DML batch (${dmlResults.length} statements)`,
        };
        finalList.push(dmlReport);
      }

      set(s => ({ results: { ...s.results, [tabId]: finalList }, isExecuting: { ...s.isExecuting, [tabId]: false } }));
    } catch (e) {
      const errorMsg = String(e);
      set(s => ({ error: errorMsg, isExecuting: { ...s.isExecuting, [tabId]: false } }));
      invoke<string>('ai_diagnose_error', { sql, errorMsg, connectionId })
        .then(diagnosis => set({ diagnosis }))
        .catch(() => {});
    }
  },

  removeResult: (tabId, idx) =>
    set(s => {
      const list = (s.results[tabId] ?? []).filter((_, i) => i !== idx);
      return { results: { ...s.results, [tabId]: list } };
    }),

  removeResultsLeft: (tabId, idx) =>
    set(s => {
      const list = (s.results[tabId] ?? []).slice(idx);
      return { results: { ...s.results, [tabId]: list } };
    }),

  removeResultsRight: (tabId, idx) =>
    set(s => {
      const list = (s.results[tabId] ?? []).slice(0, idx + 1);
      return { results: { ...s.results, [tabId]: list } };
    }),

  removeOtherResults: (tabId, idx) =>
    set(s => {
      const list = (s.results[tabId] ?? []).filter((_, i) => i === idx);
      return { results: { ...s.results, [tabId]: list } };
    }),

  clearResults: (tabId) =>
    set(s => ({ results: { ...s.results, [tabId]: [] } })),

  proposeSqlDiff: (proposal) => set({ pendingDiff: proposal }),

  applyDiff: () => {
    const { pendingDiff } = get();
    if (!pendingDiff) return;
    const full = get().sqlContent[pendingDiff.tabId] ?? '';
    // endOffset 指向语句末尾（不含分号），若原文紧跟分号则一并消费，
    // 避免 modified 自带分号时出现双分号
    const endOffset =
      full[pendingDiff.endOffset] === ';'
        ? pendingDiff.endOffset + 1
        : pendingDiff.endOffset;
    const newSql =
      full.slice(0, pendingDiff.startOffset) +
      pendingDiff.modified +
      full.slice(endOffset);
    set((s) => ({
      sqlContent: { ...s.sqlContent, [pendingDiff.tabId]: newSql },
      pendingDiff: null,
    }));
  },

  cancelDiff: () => set({ pendingDiff: null }),

  setEditorInfo: (tabId, info) =>
    set((s) => ({ editorInfo: { ...s.editorInfo, [tabId]: info } })),

  setExplanationStreaming: (tabId, streaming) =>
    set((s) => ({ explanationStreaming: { ...s.explanationStreaming, [tabId]: streaming } })),

  appendExplanationContent: (tabId, delta) =>
    set((s) => ({
      explanationContent: {
        ...s.explanationContent,
        [tabId]: (s.explanationContent[tabId] ?? '') + delta,
      },
    })),

  clearExplanation: (tabId) =>
    set((s) => {
      const ec = { ...s.explanationContent };
      const es = { ...s.explanationStreaming };
      delete ec[tabId];
      delete es[tabId];
      return { explanationContent: ec, explanationStreaming: es };
    }),

  startExplanation: (tabId) =>
    set((s) => ({
      explanationContent: { ...s.explanationContent, [tabId]: '' },
      explanationStreaming: { ...s.explanationStreaming, [tabId]: true },
    })),

  loadHistory: async (connectionId) => {
    try {
      const queryHistory = await invoke<QueryHistory[]>('get_query_history', { connectionId });
      set({ queryHistory });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
