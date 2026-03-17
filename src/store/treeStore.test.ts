import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @tauri-apps/api/core before importing the store
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { useTreeStore } from './treeStore';

const mockInvoke = vi.mocked(invoke);

function makeGroups() { return []; }
function makeConnections(ids: number[] = [1]) {
  return ids.map(id => ({ id, name: `conn${id}`, group_id: null, driver: 'mysql', sort_order: id }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useTreeStore.setState({
    nodes: new Map(),
    searchIndex: new Map(),
    expandedIds: new Set(),
    selectedId: null,
    loadingIds: new Set(),
    error: null,
  });
});

describe('search', () => {
  function buildNodes() {
    return new Map([
      ['conn_1', { id: 'conn_1', nodeType: 'connection' as const, label: 'MyConn', parentId: null, hasChildren: true, loaded: true, meta: {} }],
      ['conn_1/db_mydb', { id: 'conn_1/db_mydb', nodeType: 'database' as const, label: 'mydb', parentId: 'conn_1', hasChildren: true, loaded: true, meta: {} }],
      ['conn_1/db_mydb/cat_tables', { id: 'conn_1/db_mydb/cat_tables', nodeType: 'category' as const, label: 'Tables', parentId: 'conn_1/db_mydb', hasChildren: true, loaded: true, meta: {} }],
      ['conn_1/db_mydb/cat_tables/table_users', { id: 'conn_1/db_mydb/cat_tables/table_users', nodeType: 'table' as const, label: 'users', parentId: 'conn_1/db_mydb/cat_tables', hasChildren: false, loaded: true, meta: {} }],
      ['conn_1/db_mydb/cat_tables/table_orders', { id: 'conn_1/db_mydb/cat_tables/table_orders', nodeType: 'table' as const, label: 'orders', parentId: 'conn_1/db_mydb/cat_tables', hasChildren: false, loaded: true, meta: {} }],
    ]);
  }

  beforeEach(() => {
    const nodes = buildNodes();
    useTreeStore.setState({ nodes, searchIndex: nodes });
  });

  it('搜索结果包含匹配节点及其所有祖先节点', () => {
    const results = useTreeStore.getState().search('user');
    const ids = results.map(n => n.id);
    expect(ids).toContain('conn_1');
    expect(ids).toContain('conn_1/db_mydb');
    expect(ids).toContain('conn_1/db_mydb/cat_tables');
    expect(ids).toContain('conn_1/db_mydb/cat_tables/table_users');
  });

  it('不包含非匹配的兄弟节点', () => {
    const results = useTreeStore.getState().search('user');
    const ids = results.map(n => n.id);
    expect(ids).not.toContain('conn_1/db_mydb/cat_tables/table_orders');
  });

  it('结果保持树层级顺序（父节点在子节点之前）', () => {
    const results = useTreeStore.getState().search('user');
    const ids = results.map(n => n.id);
    expect(ids.indexOf('conn_1')).toBeLessThan(ids.indexOf('conn_1/db_mydb/cat_tables/table_users'));
    expect(ids.indexOf('conn_1/db_mydb')).toBeLessThan(ids.indexOf('conn_1/db_mydb/cat_tables/table_users'));
  });

  it('空查询返回空数组', () => {
    expect(useTreeStore.getState().search('')).toHaveLength(0);
    expect(useTreeStore.getState().search('   ')).toHaveLength(0);
  });
});

describe('refresh', () => {
  it('refresh 方法存在', () => {
    expect(typeof useTreeStore.getState().refresh).toBe('function');
  });

  it('refresh 后展开状态被恢复，而非清空', async () => {
    // 初始化：建立 conn_1 节点并设置为已展开
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_groups') return Promise.resolve(makeGroups());
      if (cmd === 'list_connections') return Promise.resolve(makeConnections([1]));
      if (cmd === 'list_databases') return Promise.resolve(['mydb']);
      return Promise.resolve([]);
    });

    await useTreeStore.getState().init();
    // 手动展开 conn_1（模拟用户已打开连接树）
    useTreeStore.setState(s => ({
      expandedIds: new Set([...s.expandedIds, 'conn_1']),
    }));
    // 标记为已加载（已有子节点）
    useTreeStore.setState(s => {
      const nodes = new Map(s.nodes);
      const conn = nodes.get('conn_1');
      if (conn) nodes.set('conn_1', { ...conn, loaded: true });
      return { nodes };
    });

    expect(useTreeStore.getState().expandedIds.has('conn_1')).toBe(true);

    // 调用 refresh：init 会清空 expandedIds，但 refresh 应该恢复
    await useTreeStore.getState().refresh();

    expect(useTreeStore.getState().expandedIds.has('conn_1')).toBe(true);
  });

  it('refresh 后图标颜色一致：展开的节点已重新加载子节点', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_groups') return Promise.resolve(makeGroups());
      if (cmd === 'list_connections') return Promise.resolve(makeConnections([1]));
      if (cmd === 'list_databases') return Promise.resolve(['mydb']);
      return Promise.resolve([]);
    });

    await useTreeStore.getState().init();
    useTreeStore.setState(s => ({
      expandedIds: new Set([...s.expandedIds, 'conn_1']),
    }));
    useTreeStore.setState(s => {
      const nodes = new Map(s.nodes);
      const conn = nodes.get('conn_1');
      if (conn) nodes.set('conn_1', { ...conn, loaded: true });
      return { nodes };
    });

    await useTreeStore.getState().refresh();

    // conn_1 在 expandedIds 里，且其子节点（db）应已被加载
    const state = useTreeStore.getState();
    const hasDbChild = [...state.nodes.values()].some(n => n.parentId === 'conn_1');
    expect(state.expandedIds.has('conn_1')).toBe(true);
    expect(hasDbChild).toBe(true);
  });
});
