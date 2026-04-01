import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useQueryStore, loadTabsFromStorage } from './queryStore';

// Mock @tauri-apps/api/core so loadTabsFromStorage can run in unit tests
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
const mockInvoke = vi.mocked(invoke);

// Reset store state before each test
beforeEach(() => {
  vi.clearAllMocks();
  // closeTab / closeAllTabs 等函数会调用 invoke('delete_tab_file', ...)，
  // 需要返回 Promise 否则 .catch() 报错
  mockInvoke.mockResolvedValue(null);
  useQueryStore.setState({
    tabs: [
      { id: 'q1', type: 'query', title: 'Q1' },
      { id: 'q2', type: 'query', title: 'Q2' },
      { id: 'q3', type: 'query', title: 'Q3' },
    ],
    activeTabId: 'q2',
  });
});

describe('closeTab', () => {
  it('关闭非活动 tab，活动 tab 不变', () => {
    useQueryStore.getState().closeTab('q1');
    const { tabs, activeTabId } = useQueryStore.getState();
    expect(tabs.map(t => t.id)).toEqual(['q2', 'q3']);
    expect(activeTabId).toBe('q2');
  });

  it('关闭活动 tab，激活同位置（取右邻居）', () => {
    useQueryStore.getState().closeTab('q2');
    const { tabs, activeTabId } = useQueryStore.getState();
    expect(tabs.map(t => t.id)).toEqual(['q1', 'q3']);
    // q2 在 index 1，next=[q1,q3]，Math.min(1, 1) => next[1] = q3
    expect(activeTabId).toBe('q3');
  });

  it('关闭最后一个活动 tab，激活新的末尾', () => {
    useQueryStore.getState().closeTab('q3');
    const { tabs, activeTabId } = useQueryStore.getState();
    expect(tabs.map(t => t.id)).toEqual(['q1', 'q2']);
    // q3 在 index 2，next=[q1,q2]，Math.min(2, 1) => next[1] = q2
    expect(activeTabId).toBe('q2');
  });
});

describe('closeAllTabs', () => {
  it('清空所有 tab', () => {
    useQueryStore.getState().closeAllTabs();
    expect(useQueryStore.getState().tabs).toHaveLength(0);
    expect(useQueryStore.getState().activeTabId).toBe('');
  });
});

describe('closeTabsLeft', () => {
  it('关闭 q3 左侧，保留 q3', () => {
    useQueryStore.getState().closeTabsLeft('q3');
    expect(useQueryStore.getState().tabs.map(t => t.id)).toEqual(['q3']);
  });
});

describe('closeTabsRight', () => {
  it('关闭 q1 右侧，保留 q1', () => {
    useQueryStore.getState().closeTabsRight('q1');
    expect(useQueryStore.getState().tabs.map(t => t.id)).toEqual(['q1']);
  });
});

describe('closeOtherTabs', () => {
  it('仅保留指定 tab', () => {
    useQueryStore.getState().closeOtherTabs('q2');
    expect(useQueryStore.getState().tabs.map(t => t.id)).toEqual(['q2']);
    expect(useQueryStore.getState().activeTabId).toBe('q2');
  });
});

describe('updateTabContext', () => {
  it('合并 Partial<QueryContext> 到指定 tab', () => {
    useQueryStore.getState().updateTabContext('q1', { connectionId: 5, database: 'mydb' });
    const tab = useQueryStore.getState().tabs.find(t => t.id === 'q1');
    expect(tab?.queryContext?.connectionId).toBe(5);
    expect(tab?.queryContext?.database).toBe('mydb');
    expect(tab?.queryContext?.schema).toBeNull();
  });

  it('不影响其他 tab', () => {
    useQueryStore.getState().updateTabContext('q1', { connectionId: 5 });
    const q2 = useQueryStore.getState().tabs.find(t => t.id === 'q2');
    expect(q2?.queryContext).toBeUndefined();
  });
});

describe('openQueryTab', () => {
  it('新建查询 tab', () => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    useQueryStore.getState().openQueryTab(1, 'myconn', 'mydb');
    const { tabs, activeTabId } = useQueryStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].type).toBe('query');
    expect(tabs[0].queryContext?.connectionId).toBe(1);
    expect(tabs[0].queryContext?.database).toBe('mydb');
    expect(activeTabId).toBe(tabs[0].id);
  });

  it('传入 initialSql 时写入 sqlContent', () => {
    useQueryStore.setState({ tabs: [], activeTabId: '', sqlContent: {} });
    useQueryStore.getState().openQueryTab(1, 'MyDB', undefined, undefined, 'SELECT 1');
    const state = useQueryStore.getState();
    const tab = state.tabs[0];
    expect(state.sqlContent[tab.id]).toBe('SELECT 1');
  });
});

describe('openTableDataTab', () => {
  it('相同 table 不重复开 tab', () => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    useQueryStore.getState().openTableDataTab('users', 1, 'mydb');
    useQueryStore.getState().openTableDataTab('users', 1, 'mydb');
    expect(useQueryStore.getState().tabs).toHaveLength(1);
  });
});

describe('openTableStructureTab', () => {
  it('新建表时 title 为 新建表', () => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    useQueryStore.getState().openTableStructureTab(1, 'mydb');
    const { tabs } = useQueryStore.getState();
    expect(tabs[0].title).toBe('新建表');
    expect(tabs[0].id).toContain('_new_');
  });

  it('相同 table 不重复开 tab', () => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    useQueryStore.getState().openTableStructureTab(1, 'mydb', undefined, 'users');
    useQueryStore.getState().openTableStructureTab(1, 'mydb', undefined, 'users');
    expect(useQueryStore.getState().tabs).toHaveLength(1);
  });
});

describe('SQLite/file persistence (loadTabsFromStorage)', () => {
  beforeEach(() => {
    localStorage.clear();
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    vi.clearAllMocks();
  });

  it('从 SQLite 元数据加载 tabs 和 activeTabId', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);
    const tabsMeta = JSON.stringify([{ id: 't1', type: 'query', title: '查询1' }]);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_ui_state') return Promise.resolve(
        // discriminate by call order via argument inspection
        undefined
      );
      if (cmd === 'list_tab_files') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    // More precise: mock per key argument
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const a = args as Record<string, unknown> | undefined;
      if (cmd === 'get_ui_state' && a?.key === 'tabs_metadata') return Promise.resolve(tabsMeta);
      if (cmd === 'get_ui_state' && a?.key === 'active_tab_id') return Promise.resolve('t1');
      if (cmd === 'list_tab_files') return Promise.resolve([]);
      if (cmd === 'read_tab_file') return Promise.resolve('SELECT 1');
      return Promise.resolve(null);
    });

    const { tabs, activeTabId, sqlContent } = await loadTabsFromStorage();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe('t1');
    expect(activeTabId).toBe('t1');
    expect(sqlContent['t1']).toBe('SELECT 1');
  });

  it('SQLite 元数据为空时触发 localStorage 一次性迁移', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);
    const oldData = {
      tabs: [{ id: 'm1', type: 'query', title: 'M1' }],
      activeTabId: 'm1',
      sqlContent: { m1: 'SELECT * FROM t' },
    };
    localStorage.setItem('unified_tabs_state', JSON.stringify(oldData));

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_ui_state') return Promise.resolve(null);
      if (cmd === 'list_tab_files') return Promise.resolve([]);
      if (cmd === 'write_tab_file') return Promise.resolve(null);
      if (cmd === 'set_ui_state') return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const { tabs, sqlContent } = await loadTabsFromStorage();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe('m1');
    expect(sqlContent['m1']).toBe('SELECT * FROM t');
    // localStorage 旧键应被清除
    expect(localStorage.getItem('unified_tabs_state')).toBeNull();
  });

  it('invoke 全部返回 null 时返回空状态', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_tab_files') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const { tabs, activeTabId, sqlContent } = await loadTabsFromStorage();
    expect(tabs).toHaveLength(0);
    expect(activeTabId).toBe('');
    expect(Object.keys(sqlContent)).toHaveLength(0);
  });

  it('invoke 抛出异常时返回空状态', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockRejectedValue(new Error('Tauri not available'));

    const { tabs, activeTabId, sqlContent } = await loadTabsFromStorage();
    expect(tabs).toHaveLength(0);
    expect(activeTabId).toBe('');
    expect(Object.keys(sqlContent)).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// MCP Tab 联动相关：openMetricTab / openMetricListTab / setActiveTabId
// ────────────────────────────────────────────────────────────────────────────

describe('openMetricTab', () => {
  beforeEach(() => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
  });

  it('新建 metric tab，type=metric，metricId 正确', () => {
    useQueryStore.getState().openMetricTab(42, 'monthly_revenue');
    const { tabs, activeTabId } = useQueryStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].type).toBe('metric');
    expect(tabs[0].metricId).toBe(42);
    expect(tabs[0].title).toBe('monthly_revenue');
    expect(activeTabId).toBe(tabs[0].id);
  });

  it('相同 metricId 不重复创建 tab，聚焦已有 tab', () => {
    useQueryStore.getState().openMetricTab(42, 'monthly_revenue');
    const firstId = useQueryStore.getState().tabs[0].id;
    useQueryStore.getState().openMetricTab(42, 'monthly_revenue');
    const { tabs, activeTabId } = useQueryStore.getState();
    expect(tabs).toHaveLength(1);
    expect(activeTabId).toBe(firstId);
  });

  it('不同 metricId 创建独立 tab', () => {
    useQueryStore.getState().openMetricTab(1, 'metric_a');
    useQueryStore.getState().openMetricTab(2, 'metric_b');
    expect(useQueryStore.getState().tabs).toHaveLength(2);
  });
});

describe('openMetricListTab', () => {
  beforeEach(() => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
  });

  it('新建 metric_list tab，scope 正确', () => {
    const scope = { connectionId: 1, database: 'mydb' };
    useQueryStore.getState().openMetricListTab(scope, '指标列表');
    const { tabs } = useQueryStore.getState();
    expect(tabs[0].type).toBe('metric_list');
    expect(tabs[0].metricScope).toEqual(scope);
  });

  it('相同 scope 不重复开 tab', () => {
    const scope = { connectionId: 1, database: 'mydb' };
    useQueryStore.getState().openMetricListTab(scope, '指标列表');
    useQueryStore.getState().openMetricListTab(scope, '指标列表');
    expect(useQueryStore.getState().tabs).toHaveLength(1);
  });
});

describe('setActiveTabId（MCP focus_tab 底层依赖）', () => {
  it('切换 activeTabId', () => {
    useQueryStore.setState({
      tabs: [
        { id: 'a', type: 'query', title: 'A' },
        { id: 'b', type: 'query', title: 'B' },
      ],
      activeTabId: 'a',
    });
    useQueryStore.getState().setActiveTabId('b');
    expect(useQueryStore.getState().activeTabId).toBe('b');
  });

  it('切换到不存在的 tabId 时 activeTabId 仍更新（防御性检查由调用方保证）', () => {
    useQueryStore.setState({ tabs: [{ id: 'a', type: 'query', title: 'A' }], activeTabId: 'a' });
    useQueryStore.getState().setActiveTabId('ghost');
    expect(useQueryStore.getState().activeTabId).toBe('ghost');
  });
});
