import { describe, it, expect, beforeEach } from 'vitest';
import { useQueryStore } from './queryStore';

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
