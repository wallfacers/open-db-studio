import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, QueryHistory, Tab, EditorInfo, MetricScope, QueryContext } from '../types';
import { useAppStore } from './appStore';
import { parseStatements } from '../utils/sqlParser';
import { metricTabId, newMetricTabId, metricListTabId, queryTabId, tableDataTabId, tableStructureTabId, newTableStructureTabId, stJobTabId, erDesignTabId } from '../utils/nodeId';

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
  openMetricTab: (metricId: number, title: string, connectionId?: number) => void;
  openMetricListTab: (scope: import('../types').MetricScope, title: string) => void;
  openNewMetricTab: (scope: import('../types').MetricScope, scopeTitle: string) => void;
  updateMetricTabId: (tabId: string, metricId: number, title: string) => void;

  openQueryTab: (connId: number, connName: string, database?: string, schema?: string, initialSql?: string) => void;
  openTableDataTab: (tableName: string, connectionId: number, database?: string, schema?: string) => void;
  openTableStructureTab: (connectionId: number, database?: string, schema?: string, tableName?: string) => void;
  openSeaTunnelJobTab: (jobId: number, title: string, connectionId?: number) => void;
  closeSeaTunnelJobTab: (jobId: number) => void;
  updateSeaTunnelJobTabTitle: (jobId: number, title: string) => void;
  openERDesignTab: (projectId: number, projectName: string) => void;
  updateERDesignTabTitle: (projectId: number, title: string) => void;
  closeERDesignTab: (projectId: number) => void;

  closeTab: (tabId: string) => void;
  closeMetricTabById: (metricId: number) => void;
  closeTabsByConnectionId: (connectionId: number) => void;
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

  // 表数据外部刷新信号（tabId → 递增计数器，TableDataView 订阅后自动刷新）
  tableRefreshSignals: Record<string, number>;
  triggerTableRefresh: (tabId: string) => void;
  toggleGhostText: (tabId: string) => void;
  isGhostTextEnabled: (tabId: string) => boolean;
}

const DEFAULT_TAB: Tab = { id: 'query-1', type: 'query', title: 'Query 1' };

export async function loadTabsFromStorage(): Promise<{
  tabs: Tab[];
  activeTabId: string;
  sqlContent: Record<string, string>;
}> {
  try {
    const rawMeta = await invoke<string | null>('get_ui_state', { key: 'tabs_metadata' });
    const rawActiveId = await invoke<string | null>('get_ui_state', { key: 'active_tab_id' });

    let tabs: Tab[] = [];
    if (rawMeta) {
      const parsed: unknown = JSON.parse(rawMeta);
      if (Array.isArray(parsed)) tabs = parsed as Tab[];
    }

    // 孤儿文件清理
    const existingFiles = await invoke<string[]>('list_tab_files');
    const tabIds = new Set(tabs.map((t) => t.id));
    await Promise.allSettled(
      existingFiles
        .filter((id) => !tabIds.has(id))
        .map((id) => invoke('delete_tab_file', { tabId: id }))
    );

    // 读取每个 tab 的 SQL 文件
    const sqlContent: Record<string, string> = {};
    await Promise.allSettled(
      tabs.map(async (tab) => {
        const sql = await invoke<string | null>('read_tab_file', { tabId: tab.id });
        if (sql != null) sqlContent[tab.id] = sql;
      })
    );

    // 兼容旧 localStorage（一次性迁移）
    if (tabs.length === 0) {
      const oldRaw =
        localStorage.getItem('unified_tabs_state') ??
        localStorage.getItem('metrics_tabs_state');
      if (oldRaw) {
        const old = JSON.parse(oldRaw) as { tabs?: Tab[]; sqlContent?: Record<string, string>; activeTabId?: string };
        tabs = old.tabs ?? [];
        const oldSql: Record<string, string> = old.sqlContent ?? {};
        await Promise.allSettled(
          Object.entries(oldSql).map(([id, sql]) =>
            invoke('write_tab_file', { tabId: id, content: sql })
          )
        );
        Object.assign(sqlContent, oldSql);
        if (old.activeTabId && !rawActiveId) {
          await invoke('set_ui_state', { key: 'active_tab_id', value: old.activeTabId });
        }
        localStorage.removeItem('unified_tabs_state');
        localStorage.removeItem('metrics_tabs_state');
      }
    }

    return { tabs, activeTabId: rawActiveId ?? '', sqlContent };
  } catch {
    return { tabs: [], activeTabId: '', sqlContent: {} };
  }
}

export const useQueryStore = create<QueryState>((set, get) => ({
  tabs: [DEFAULT_TAB],
  activeTabId: DEFAULT_TAB.id,
  sqlContent: { [DEFAULT_TAB.id]: '' },
  results: {},
  isExecuting: {},
  queryHistory: [],
  error: null,
  diagnosis: null,
  tableRefreshSignals: {},
  triggerTableRefresh: (tabId) => set(s => ({
    tableRefreshSignals: { ...s.tableRefreshSignals, [tabId]: (s.tableRefreshSignals[tabId] ?? 0) + 1 },
  })),
  editorInfo: {},
  explanationContent: {},
  explanationStreaming: {},

  setSql: (tabId, sql) => {
    set((s) => ({ sqlContent: { ...s.sqlContent, [tabId]: sql } }));
    persistSqlContent(tabId, sql);
  },
  setActiveTabId: (tabId) => set({ activeTabId: tabId }),

  openMetricTab: (metricId, title, connectionId) => {
    set(s => {
      const existing = s.tabs.find(t => t.type === 'metric' && t.metricId === metricId);
      if (existing) return { activeTabId: existing.id };
      const id = metricTabId(metricId, Date.now());
      const tab: Tab = { id, type: 'metric', title, metricId, connectionId };
      return { tabs: [...s.tabs, tab], activeTabId: id };
    });
  },
  openNewMetricTab: (scope, scopeTitle) => {
    const id = newMetricTabId(Date.now());
    const tab: Tab = { id, type: 'metric', title: `新建指标`, metricScope: scope };
    set(s => ({ tabs: [...s.tabs, tab], activeTabId: id }));
  },

  updateMetricTabId: (tabId, metricId, title) => {
    set(s => ({
      tabs: s.tabs.map(t => t.id === tabId ? { ...t, metricId, title, metricScope: undefined } : t),
    }));
  },

  openMetricListTab: (scope, title) => {
    const key = metricListTabId(scope.connectionId, scope.database ?? '', scope.schema ?? '');
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
      const id = queryTabId(connId, Date.now());
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
    const id = tableDataTabId(connectionId, dbName, schema ?? '', tableName);
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
      ? newTableStructureTabId(connectionId, dbName, schema ?? '', Date.now())
      : tableStructureTabId(connectionId, dbName, schema ?? '', tableName!);
    set(s => {
      if (s.tabs.find(t => t.id === id)) return { activeTabId: id };
      const tab: Tab = {
        id, type: 'table_structure',
        title: tableName || '新建表',
        db: dbName, connectionId, schema,
      };
      return { tabs: [...s.tabs, tab], activeTabId: id };
    });
  },

  openSeaTunnelJobTab: (jobId, title, connectionId) => {
    set(s => {
      const existing = s.tabs.find(t => t.type === 'seatunnel_job' && t.stJobId === jobId);
      if (existing) return { activeTabId: existing.id };
      const id = stJobTabId(jobId, Date.now());
      const tab: Tab = { id, type: 'seatunnel_job', title, stJobId: jobId, stConnectionId: connectionId };
      return { tabs: [...s.tabs, tab], activeTabId: id };
    });
  },

  updateSeaTunnelJobTabTitle: (jobId, title) => {
    set(s => {
      const tab = s.tabs.find(t => t.type === 'seatunnel_job' && t.stJobId === jobId);
      if (!tab) return {};
      return { tabs: s.tabs.map(t => t.id === tab.id ? { ...t, title } : t) };
    });
  },

  closeSeaTunnelJobTab: (jobId) => {
    set(s => {
      const tab = s.tabs.find(t => t.type === 'seatunnel_job' && t.stJobId === jobId);
      if (!tab) return {};
      const newTabs = s.tabs.filter(t => t.id !== tab.id);
      const newActiveId = s.activeTabId === tab.id
        ? (newTabs[newTabs.length - 1]?.id ?? '')
        : s.activeTabId;
      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  updateERDesignTabTitle: (projectId, title) => {
    set(s => ({
      tabs: s.tabs.map(t =>
        t.type === 'er_design' && t.erProjectId === projectId ? { ...t, title } : t
      ),
    }));
  },

  closeERDesignTab: (projectId) => {
    set(s => {
      const tab = s.tabs.find(t => t.type === 'er_design' && t.erProjectId === projectId);
      if (!tab) return {};
      const newTabs = s.tabs.filter(t => t.id !== tab.id);
      const newActiveId = s.activeTabId === tab.id
        ? (newTabs[newTabs.length - 1]?.id ?? '')
        : s.activeTabId;
      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  openERDesignTab: (projectId, projectName) => {
    set(s => {
      const existing = s.tabs.find(t => t.type === 'er_design' && t.erProjectId === projectId);
      if (existing) return { activeTabId: existing.id };
      const id = erDesignTabId(projectId, Date.now());
      const tab: Tab = { id, type: 'er_design', title: projectName, erProjectId: projectId };
      return { tabs: [...s.tabs, tab], activeTabId: id };
    });
  },

  closeTab: (tabId) => {
    set(s => {
      const next = s.tabs.filter(t => t.id !== tabId);
      if (s.activeTabId !== tabId) return { tabs: next };
      const idx = s.tabs.findIndex(t => t.id === tabId);
      const newActive = next[Math.min(idx, next.length - 1)]?.id ?? '';
      return { tabs: next, activeTabId: newActive };
    });
    invoke('delete_tab_file', { tabId }).catch(() => {});
  },

  closeMetricTabById: (metricId) => {
    set(s => {
      const tab = s.tabs.find(t => t.type === 'metric' && t.metricId === metricId);
      if (!tab) return s;
      const tabs = s.tabs.filter(t => t.id !== tab.id);
      const activeTabId = s.activeTabId === tab.id
        ? (tabs[Math.max(0, s.tabs.findIndex(t => t.id === tab.id) - 1)]?.id ?? '')
        : s.activeTabId;
      return { tabs, activeTabId };
    });
  },

  closeTabsByConnectionId: (connectionId) => {
    let removedIds: string[] = [];
    set(s => {
      const keep = s.tabs.filter(t => {
        if (t.type === 'query') return t.queryContext?.connectionId !== connectionId;
        if (t.type === 'table' || t.type === 'table_structure') return t.connectionId !== connectionId;
        if (t.type === 'metric') return t.connectionId !== connectionId;
        if (t.type === 'metric_list') return t.metricScope?.connectionId !== connectionId;
        return true;
      });
      removedIds = s.tabs.filter(t => !keep.includes(t)).map(t => t.id);
      if (removedIds.length === 0) return s;
      const newActive = keep.find(t => t.id === s.activeTabId)
        ? s.activeTabId
        : (keep[keep.length - 1]?.id ?? '');
      return { tabs: keep, activeTabId: newActive };
    });
    removedIds.forEach(id => invoke('delete_tab_file', { tabId: id }).catch(() => {}));
  },

  closeAllTabs: () => {
    const removedIds = get().tabs.map(t => t.id);
    set({ tabs: [], activeTabId: '' });
    removedIds.forEach(id => invoke('delete_tab_file', { tabId: id }).catch(() => {}));
  },

  closeTabsLeft: (tabId) => {
    let removedIds: string[] = [];
    set(s => {
      const idx = s.tabs.findIndex(t => t.id === tabId);
      if (idx <= 0) return s;
      removedIds = s.tabs.slice(0, idx).map(t => t.id);
      const next = s.tabs.slice(idx);
      const newActive = next.find(t => t.id === s.activeTabId) ? s.activeTabId : tabId;
      return { tabs: next, activeTabId: newActive };
    });
    removedIds.forEach(id => invoke('delete_tab_file', { tabId: id }).catch(() => {}));
  },

  closeTabsRight: (tabId) => {
    let removedIds: string[] = [];
    set(s => {
      const idx = s.tabs.findIndex(t => t.id === tabId);
      if (idx === s.tabs.length - 1) return s;
      removedIds = s.tabs.slice(idx + 1).map(t => t.id);
      const next = s.tabs.slice(0, idx + 1);
      const newActive = next.find(t => t.id === s.activeTabId) ? s.activeTabId : tabId;
      return { tabs: next, activeTabId: newActive };
    });
    removedIds.forEach(id => invoke('delete_tab_file', { tabId: id }).catch(() => {}));
  },

  closeOtherTabs: (tabId) => {
    let removedIds: string[] = [];
    set(s => {
      removedIds = s.tabs.filter(t => t.id !== tabId).map(t => t.id);
      return { tabs: s.tabs.filter(t => t.id === tabId), activeTabId: tabId };
    });
    removedIds.forEach(id => invoke('delete_tab_file', { tabId: id }).catch(() => {}));
  },

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

    const statements = parseStatements(sql).map(s => s.text);

    // 写入操作上下文快照（供错误诊断使用）
    useAppStore.getState().setLastOperationContext({
      type: 'sql_execute',
      connectionId,
      database: database ?? undefined,
      schema: schema ?? undefined,
      sql,
    });

    set(s => ({ isExecuting: { ...s.isExecuting, [tabId]: true }, error: null, diagnosis: null }));

    // 逐条执行，按顺序收集成功/失败结果
    const orderedResults: QueryResult[] = [];
    const dmlBatch: { idx: number; stmt: string; result: QueryResult }[] = [];

    const flushDmlBatch = () => {
      if (dmlBatch.length === 0) return;
      if (dmlBatch.length === 1) {
        // 单条 DML 不聚合，保持原位
        orderedResults[dmlBatch[0].idx] = dmlBatch[0].result;
      } else {
        const totalDuration = dmlBatch.reduce((sum, r) => sum + r.result.duration_ms, 0);
        const dmlReport: QueryResult = {
          columns: ['#', '操作', 'SQL摘要', '影响行数', '耗时(ms)', '状态'],
          rows: dmlBatch.map((item, i) => [
            String(i + 1),
            getSqlType(item.stmt),
            item.stmt.replace(/\s+/g, ' ').trim(),
            String(item.result.row_count),
            String(item.result.duration_ms),
            '✓ 成功',
          ]),
          row_count: dmlBatch.reduce((sum, r) => sum + r.result.row_count, 0),
          duration_ms: totalDuration,
          kind: 'dml-report',
          sql: `-- DML batch (${dmlBatch.length} statements)`,
        };
        // 放在 batch 首位 index，后续位置标记为 null 待清理
        orderedResults[dmlBatch[0].idx] = dmlReport;
        for (let i = 1; i < dmlBatch.length; i++) {
          orderedResults[dmlBatch[i].idx] = null as unknown as QueryResult;
        }
      }
      dmlBatch.length = 0;
    };

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
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
          flushDmlBatch();
          orderedResults[i] = enriched;
        } else {
          dmlBatch.push({ idx: i, stmt, result: enriched });
        }
      } catch (e) {
        flushDmlBatch();
        orderedResults[i] = {
          columns: [],
          rows: [],
          row_count: 0,
          duration_ms: 0,
          kind: 'error',
          sql: stmt,
          error_message: String(e),
        };
      }
    }
    flushDmlBatch();

    // 过滤掉 null 占位（被聚合的 DML）
    const finalList = orderedResults.filter(Boolean);

    set(s => ({
      results: { ...s.results, [tabId]: finalList },
      isExecuting: { ...s.isExecuting, [tabId]: false },
    }));
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

  toggleGhostText: (tabId) => {
    const { tabs } = get();
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    const currentlyEnabled = tab.ghostTextEnabled ?? useAppStore.getState().ghostTextDefault;
    set({
      tabs: tabs.map(t => t.id === tabId ? { ...t, ghostTextEnabled: !currentlyEnabled } : t),
    });
  },
  isGhostTextEnabled: (tabId) => {
    const tab = get().tabs.find(t => t.id === tabId);
    if (!tab) return false;
    return tab.ghostTextEnabled ?? useAppStore.getState().ghostTextDefault;
  },
}));

// SQL 内容防抖写入文件
const _saveSqlTimers: Record<string, ReturnType<typeof setTimeout>> = {};
export function persistSqlContent(tabId: string, content: string): void {
  if (_saveSqlTimers[tabId]) clearTimeout(_saveSqlTimers[tabId]);
  _saveSqlTimers[tabId] = setTimeout(() => {
    invoke('write_tab_file', { tabId, content }).catch(() => {});
  }, 500);
}

// 初始化完成标志：防止 loadTabsFromStorage 完成前 subscribe 回调把 DEFAULT_TAB 写入 SQLite
let _storeInitialized = false;

// 持久化元数据（防抖 500ms）
let _saveMetaTimer: ReturnType<typeof setTimeout> | null = null;
useQueryStore.subscribe((state) => {
  if (!_storeInitialized) return; // 初始化完成前不写
  if (_saveMetaTimer) clearTimeout(_saveMetaTimer);
  _saveMetaTimer = setTimeout(() => {
    invoke('set_ui_state', {
      key: 'tabs_metadata',
      value: JSON.stringify(state.tabs),
    }).catch(() => {});
    invoke('set_ui_state', {
      key: 'active_tab_id',
      value: state.activeTabId,
    }).catch(() => {});
  }, 500);
});

// 异步加载持久化状态（应用启动时执行）
loadTabsFromStorage().then(({ tabs, activeTabId, sqlContent }) => {
  useQueryStore.setState({ tabs, activeTabId, sqlContent });
  _storeInitialized = true; // 标记初始化完成
}).catch(() => {
  _storeInitialized = true; // 即使加载失败也要打开持久化
});
