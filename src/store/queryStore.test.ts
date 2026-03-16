import { describe, it, expect, beforeEach } from 'vitest';
import { useQueryStore, loadTabsFromStorage } from './queryStore';

// Reset store state before each test
beforeEach(() => {
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
    expect(tabs[0].isNewTable).toBe(true);
  });

  it('相同 table 不重复开 tab', () => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    useQueryStore.getState().openTableStructureTab(1, 'mydb', undefined, 'users');
    useQueryStore.getState().openTableStructureTab(1, 'mydb', undefined, 'users');
    expect(useQueryStore.getState().tabs).toHaveLength(1);
  });
});

describe('localStorage persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset store to initial empty state
    useQueryStore.setState({ tabs: [], activeTabId: '' });
  });

  it('从 unified_tabs_state 加载已保存的 tabs', () => {
    const saved = { tabs: [{ id: 't1', type: 'query', title: '查询1' }], activeTabId: 't1' };
    localStorage.setItem('unified_tabs_state', JSON.stringify(saved));
    const { tabs: loadedTabs, activeTabId: loadedId } = loadTabsFromStorage();
    expect(loadedTabs).toHaveLength(1);
    expect(loadedTabs[0].id).toBe('t1');
    expect(loadedId).toBe('t1');
  });

  it('从 metrics_tabs_state 迁移并写入新键', () => {
    const old = { tabs: [{ id: 'm1', type: 'metric', title: 'M1' }], activeTabId: 'm1' };
    localStorage.setItem('metrics_tabs_state', JSON.stringify(old));
    const { tabs: loadedTabs } = loadTabsFromStorage();
    expect(loadedTabs).toHaveLength(1);
    expect(localStorage.getItem('unified_tabs_state')).not.toBeNull();
    expect(localStorage.getItem('metrics_tabs_state')).toBeNull();
  });

  it('两个键都不存在时返回空状态', () => {
    const { tabs: loadedTabs, activeTabId: loadedId } = loadTabsFromStorage();
    expect(loadedTabs).toHaveLength(0);
    expect(loadedId).toBe('');
  });
});
