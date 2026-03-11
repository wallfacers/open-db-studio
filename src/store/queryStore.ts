import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, QueryHistory, Tab } from '../types';

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

interface QueryState {
  tabs: Tab[];
  activeTabId: string;
  sqlContent: Record<string, string>;  // tabId → sql
  results: Record<string, QueryResult[]>;
  isExecuting: boolean;
  queryHistory: QueryHistory[];
  error: string | null;
  diagnosis: string | null;

  addTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setSql: (tabId: string, sql: string) => void;

  executeQuery: (connectionId: number, tabId: string, sqlOverride?: string, database?: string | null, schema?: string | null) => Promise<void>;
  loadHistory: (connectionId: number) => Promise<void>;
  removeResult: (tabId: string, idx: number) => void;
  removeResultsLeft: (tabId: string, idx: number) => void;
  removeResultsRight: (tabId: string, idx: number) => void;
  clearResults: (tabId: string) => void;
}

const DEFAULT_TAB: Tab = { id: 'query-1', type: 'query', title: 'Query 1' };

export const useQueryStore = create<QueryState>((set, get) => ({
  tabs: [DEFAULT_TAB],
  activeTabId: DEFAULT_TAB.id,
  sqlContent: { [DEFAULT_TAB.id]: '' },
  results: {},
  isExecuting: false,
  queryHistory: [],
  error: null,
  diagnosis: null,

  addTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      sqlContent: { ...s.sqlContent, [tab.id]: '' },
    })),

  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      return {
        tabs,
        activeTabId: s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? '') : s.activeTabId,
      };
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  setSql: (tabId, sql) =>
    set((s) => ({ sqlContent: { ...s.sqlContent, [tabId]: sql } })),

  executeQuery: async (connectionId, tabId, sqlOverride, database, schema) => {
    const sql = sqlOverride ?? get().sqlContent[tabId] ?? '';
    if (!sql.trim()) return;

    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    set({ isExecuting: true, error: null, diagnosis: null });

    interface StmtResult { stmt: string; result: QueryResult }
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
        result.sql = stmt;
        if (isSelectLike(stmt) || result.columns.length > 0) {
          result.kind = 'select';
          selectResults.push({ stmt, result });
        } else {
          dmlResults.push({ stmt, result });
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
          row_count: dmlResults.length,
          duration_ms: totalDuration,
          kind: 'dml-report',
          sql: '',
        };
        finalList.push(dmlReport);
      }

      set(s => ({ results: { ...s.results, [tabId]: finalList }, isExecuting: false }));
    } catch (e) {
      const errorMsg = String(e);
      set({ error: errorMsg, isExecuting: false });
      const sql = get().sqlContent[tabId] ?? '';
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

  clearResults: (tabId) =>
    set(s => ({ results: { ...s.results, [tabId]: [] } })),

  loadHistory: async (connectionId) => {
    try {
      const queryHistory = await invoke<QueryHistory[]>('get_query_history', { connectionId });
      set({ queryHistory });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
