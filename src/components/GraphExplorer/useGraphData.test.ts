import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Tauri invoke（必须在 import 之前）───────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { renderHook, waitFor } from '@testing-library/react';
import { useGraphData, type GraphNode, type GraphEdge } from './useGraphData';

const mockInvoke = vi.mocked(invoke);

// ─── 测试数据工厂 ─────────────────────────────────────────────────────────────
function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'node-1',
    node_type: 'table',
    name: 'users',
    display_name: '用户表',
    aliases: 'users,user',
    metadata: '{}',
    connection_id: 1,
    is_deleted: 0,
    source: 'manual',
    ...overrides,
  };
}

function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: 'edge-1',
    from_node: 'node-1',
    to_node: 'node-2',
    edge_type: 'FOREIGN_KEY',
    weight: 1,
    source: 'schema',
    ...overrides,
  };
}

// ─── 测试套件 ─────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// 模块导入检查
// ════════════════════════════════════════════════════════════════════════════
describe('模块导入', () => {
  it('useGraphData 是函数', () => {
    expect(typeof useGraphData).toBe('function');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// connectionId 为 null
// ════════════════════════════════════════════════════════════════════════════
describe('connectionId 为 null', () => {
  it('不调用 invoke，nodes/edges 均为空数组', async () => {
    const { result } = renderHook(() => useGraphData(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 正常加载流程
// ════════════════════════════════════════════════════════════════════════════
describe('正常加载流程', () => {
  it('调用 get_graph_nodes 传入 connectionId', async () => {
    const nodes = [makeNode()];
    const edges = [makeEdge()];

    mockInvoke
      .mockResolvedValueOnce(nodes)  // get_graph_nodes
      .mockResolvedValueOnce(edges); // get_graph_edges

    const { result } = renderHook(() => useGraphData(1));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockInvoke).toHaveBeenCalledWith('get_graph_nodes', { connectionId: 1 });
  });

  it('节点加载成功后调用 get_graph_edges 传入 nodeIds', async () => {
    const nodes = [makeNode({ id: 'n1' }), makeNode({ id: 'n2' })];
    const edges: GraphEdge[] = [];

    mockInvoke
      .mockResolvedValueOnce(nodes)
      .mockResolvedValueOnce(edges);

    const { result } = renderHook(() => useGraphData(42));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockInvoke).toHaveBeenCalledWith('get_graph_edges', {
      connectionId: 42,
      nodeIds: ['n1', 'n2'],
    });
  });

  it('正确设置 nodes 和 edges 状态', async () => {
    const nodes = [makeNode({ id: 'n1', name: 'orders' })];
    const edges = [makeEdge({ id: 'e1', edge_type: 'BELONGS_TO' })];

    mockInvoke
      .mockResolvedValueOnce(nodes)
      .mockResolvedValueOnce(edges);

    const { result } = renderHook(() => useGraphData(1));

    await waitFor(() => {
      expect(result.current.nodes).toHaveLength(1);
    });

    expect(result.current.nodes[0].name).toBe('orders');
    expect(result.current.edges[0].edge_type).toBe('BELONGS_TO');
    expect(result.current.error).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 节点为空时的分支
// ════════════════════════════════════════════════════════════════════════════
describe('节点列表为空', () => {
  it('get_graph_nodes 返回空数组时不调用 get_graph_edges', async () => {
    mockInvoke.mockResolvedValueOnce([]); // get_graph_nodes → 空

    const { result } = renderHook(() => useGraphData(1));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // 只调用了一次（get_graph_nodes），没有调用 get_graph_edges
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('get_graph_nodes', { connectionId: 1 });
    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 错误处理
// ════════════════════════════════════════════════════════════════════════════
describe('错误处理', () => {
  it('get_graph_nodes 失败时 error 字段有值，loading 为 false', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('数据库连接失败'));

    const { result } = renderHook(() => useGraphData(1));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('数据库连接失败');
    expect(result.current.nodes).toEqual([]);
  });

  it('get_graph_nodes 失败时 error 为字符串类型也能正确设置', async () => {
    mockInvoke.mockRejectedValueOnce('Tauri invoke error');

    const { result } = renderHook(() => useGraphData(1));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Tauri invoke error');
  });

  it('get_graph_nodes 失败时 error 为未知类型时使用默认消息', async () => {
    mockInvoke.mockRejectedValueOnce(null);

    const { result } = renderHook(() => useGraphData(1));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('加载图谱数据失败');
  });

  it('get_graph_edges 失败时 error 有值，nodes 已加载', async () => {
    const nodes = [makeNode()];
    mockInvoke
      .mockResolvedValueOnce(nodes)             // get_graph_nodes 成功
      .mockRejectedValueOnce(new Error('边加载失败')); // get_graph_edges 失败

    const { result } = renderHook(() => useGraphData(1));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // nodes 已被设置（在 try 块中 setNodes 先于 get_graph_edges）
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.error).toBe('边加载失败');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// refetch
// ════════════════════════════════════════════════════════════════════════════
describe('refetch', () => {
  it('调用 refetch 后重新触发 invoke', async () => {
    const nodes = [makeNode()];
    const edges = [makeEdge()];

    mockInvoke
      .mockResolvedValueOnce(nodes)
      .mockResolvedValueOnce(edges)
      .mockResolvedValueOnce(nodes) // 第二次 refetch
      .mockResolvedValueOnce(edges);

    const { result } = renderHook(() => useGraphData(1));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const invokeCountBefore = mockInvoke.mock.calls.length;

    // 手动触发 refetch
    result.current.refetch();

    await waitFor(() => {
      expect(mockInvoke.mock.calls.length).toBeGreaterThan(invokeCountBefore);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 返回值结构
// ════════════════════════════════════════════════════════════════════════════
describe('返回值结构', () => {
  it('返回 nodes, edges, loading, error, refetch 五个字段', async () => {
    mockInvoke.mockResolvedValue([]);

    const { result } = renderHook(() => useGraphData(null));

    expect(result.current).toHaveProperty('nodes');
    expect(result.current).toHaveProperty('edges');
    expect(result.current).toHaveProperty('loading');
    expect(result.current).toHaveProperty('error');
    expect(result.current).toHaveProperty('refetch');
    expect(typeof result.current.refetch).toBe('function');
  });
});
