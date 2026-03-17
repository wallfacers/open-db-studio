import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { useMetricsTreeStore } from './metricsTreeStore';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
  useMetricsTreeStore.setState({
    nodes: new Map(),
    expandedIds: new Set(),
    selectedId: null,
    metricCounts: new Map(),
    loadingIds: new Set(),
  });
});

describe('search', () => {
  function buildNodes() {
    return new Map([
      ['conn_1', { id: 'conn_1', nodeType: 'connection' as const, label: 'ProdConn', parentId: null, hasChildren: true, loaded: true, meta: { connectionId: 1 } }],
      ['db_1_mydb', { id: 'db_1_mydb', nodeType: 'database' as const, label: 'mydb', parentId: 'conn_1', hasChildren: true, loaded: true, meta: { connectionId: 1, database: 'mydb' } }],
      ['metric_1', { id: 'metric_1', nodeType: 'metric' as const, label: 'monthly_revenue', parentId: 'db_1_mydb', hasChildren: false, loaded: true, meta: { connectionId: 1, database: 'mydb', metricId: 1 } }],
      ['metric_2', { id: 'metric_2', nodeType: 'metric' as const, label: 'daily_orders', parentId: 'db_1_mydb', hasChildren: false, loaded: true, meta: { connectionId: 1, database: 'mydb', metricId: 2 } }],
    ]);
  }

  beforeEach(() => {
    useMetricsTreeStore.setState({ nodes: buildNodes() });
  });

  it('搜索结果包含匹配节点及其所有祖先节点', () => {
    const results = useMetricsTreeStore.getState().search('revenue');
    const ids = results.map(n => n.id);
    expect(ids).toContain('conn_1');
    expect(ids).toContain('db_1_mydb');
    expect(ids).toContain('metric_1');
  });

  it('不包含非匹配的兄弟节点', () => {
    const results = useMetricsTreeStore.getState().search('revenue');
    const ids = results.map(n => n.id);
    expect(ids).not.toContain('metric_2');
  });

  it('结果保持树层级顺序（父节点在子节点之前）', () => {
    const results = useMetricsTreeStore.getState().search('revenue');
    const ids = results.map(n => n.id);
    expect(ids.indexOf('conn_1')).toBeLessThan(ids.indexOf('metric_1'));
    expect(ids.indexOf('db_1_mydb')).toBeLessThan(ids.indexOf('metric_1'));
  });

  it('空查询返回空数组', () => {
    expect(useMetricsTreeStore.getState().search('')).toHaveLength(0);
  });
});

describe('refresh', () => {
  it('refresh 方法存在', () => {
    expect(typeof useMetricsTreeStore.getState().refresh).toBe('function');
  });

  it('refresh 后 stale expandedIds 被清除，不显示无子节点的绿色图标', async () => {
    // 模拟 init() 返回两个连接
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_groups') return Promise.resolve([]);
      if (cmd === 'list_connections') return Promise.resolve([
        { id: 1, name: 'conn1', group_id: null, driver: 'mysql', sort_order: 1 },
      ]);
      if (cmd === 'list_databases_for_metrics') return Promise.resolve(['mydb']);
      if (cmd === 'count_metrics_batch') return Promise.resolve({});
      return Promise.resolve([]);
    });

    await useMetricsTreeStore.getState().init();

    // 模拟用户曾展开过 conn_1，子节点已在 nodes 里
    await useMetricsTreeStore.getState().loadChildren('conn_1');
    useMetricsTreeStore.setState(s => ({
      expandedIds: new Set([...s.expandedIds, 'conn_1']),
    }));

    // 确认 conn_1 在 expandedIds 里
    expect(useMetricsTreeStore.getState().expandedIds.has('conn_1')).toBe(true);

    // 调用 refresh：init 后子节点消失，expandedIds 仍有 conn_1（stale）
    // refresh 应清除 stale 状态，重新加载后正确恢复
    await useMetricsTreeStore.getState().refresh();

    const state = useMetricsTreeStore.getState();
    // conn_1 仍在 expandedIds（已重新加载）
    expect(state.expandedIds.has('conn_1')).toBe(true);
    // 子节点 db_1_mydb 应存在（重新加载过）
    const hasDbChild = [...state.nodes.values()].some(n => n.parentId === 'conn_1');
    expect(hasDbChild).toBe(true);
  });

  it('refresh 后不再有 stale expandedIds（即 expandedIds 中的 id 在 nodes 里都存在）', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_groups') return Promise.resolve([]);
      if (cmd === 'list_connections') return Promise.resolve([
        { id: 1, name: 'conn1', group_id: null, driver: 'mysql', sort_order: 1 },
      ]);
      if (cmd === 'list_databases_for_metrics') return Promise.resolve(['mydb']);
      if (cmd === 'count_metrics_batch') return Promise.resolve({});
      return Promise.resolve([]);
    });

    await useMetricsTreeStore.getState().init();
    // 注入一个 stale expandedId（不存在于 nodes 的 id）
    useMetricsTreeStore.setState(s => ({
      expandedIds: new Set([...s.expandedIds, 'stale_id_that_does_not_exist']),
    }));

    await useMetricsTreeStore.getState().refresh();

    const state = useMetricsTreeStore.getState();
    for (const id of state.expandedIds) {
      expect(state.nodes.has(id)).toBe(true);
    }
  });
});
