import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, QueryHistory, Tab } from '../types';

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

    // Split by semicolon and filter out empty statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    set({ isExecuting: true, error: null, diagnosis: null });
    const resultList: QueryResult[] = [];
    try {
      for (const stmt of statements) {
        const result = await invoke<QueryResult>('execute_query', {
          connectionId,
          sql: stmt,
          database: database ?? null,
          schema: schema ?? null,
        });
        resultList.push(result);
      }
      set(s => ({ results: { ...s.results, [tabId]: resultList }, isExecuting: false }));
    } catch (e) {
      const errorMsg = String(e);
      set({ error: errorMsg, isExecuting: false });
      // 自动诊断（非阻塞，不影响主流程）
      const sql = get().sqlContent[tabId] ?? '';
      invoke<string>('ai_diagnose_error', { sql, errorMsg, connectionId })
        .then(diagnosis => set({ diagnosis }))
        .catch(() => {}); // 诊断失败静默处理
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
