import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock Tauri APIs ────────────────────────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// ─── Mock fs module（提升到顶层，vitest 会自动 hoist）────────────────────────
vi.mock('../mcp/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp/fs')>()
  return {
    ...actual,
    fsRouter: {
      handle: vi.fn().mockResolvedValue(JSON.stringify({ content: 'SELECT 1', lines: [] })),
    },
    registerFsAdapters: vi.fn(),
  }
});

type ListenCallback<T> = (event: { payload: T }) => void | Promise<void>;
const capturedListeners: Record<string, ListenCallback<unknown>> = {};

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, cb: ListenCallback<unknown>) => {
    capturedListeners[eventName] = cb;
    // 返回 Promise<unlisten fn>（与真实 API 一致）
    return Promise.resolve(() => { delete capturedListeners[eventName]; });
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import { renderHook } from '@testing-library/react';
import { useQueryStore } from '../store/queryStore';
import { useTreeStore } from '../store/treeStore';
import { useMcpBridge } from './useMcpBridge';
import { fsRouter, registerFsAdapters } from '../mcp/fs';

const mockInvoke = vi.mocked(invoke);

// ─── 辅助：触发模拟事件 ──────────────────────────────────────────────────────
async function emitUiAction(payload: unknown) {
  const handler = capturedListeners['mcp://ui-action'];
  if (!handler) throw new Error('mcp://ui-action listener not registered');
  await handler({ payload } as { payload: unknown });
}

async function emitQueryRequest(payload: unknown) {
  const handler = capturedListeners['mcp://query-request'];
  if (!handler) throw new Error('mcp://query-request listener not registered');
  await handler({ payload } as { payload: unknown });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);

  // 重置 queryStore
  useQueryStore.setState({
    tabs: [
      { id: 'tab-q1', type: 'query', title: 'MyConn / mydb', connectionId: 1, db: 'mydb' },
      { id: 'tab-ts1', type: 'table_structure', title: 'users', connectionId: 1, db: 'mydb' },
      { id: 'tab-m1', type: 'metric', title: 'monthly_revenue', connectionId: 1, metricId: 10 },
    ],
    activeTabId: 'tab-q1',
    sqlContent: { 'tab-q1': 'SELECT 1', 'tab-ts1': '' },
  });

  // 重置 treeStore
  useTreeStore.setState({
    nodes: new Map([
      ['conn_1/db_mydb/cat_tables/table_users',
        { id: 'conn_1/db_mydb/cat_tables/table_users', nodeType: 'table', label: 'users', parentId: 'cat', hasChildren: false, loaded: true, meta: { connectionId: 1 } }],
      ['conn_1/db_mydb/cat_tables/table_orders',
        { id: 'conn_1/db_mydb/cat_tables/table_orders', nodeType: 'table', label: 'orders', parentId: 'cat', hasChildren: false, loaded: true, meta: { connectionId: 1 } }],
    ]),
    searchIndex: new Map(),
    expandedIds: new Set(),
    selectedId: null,
    loadingIds: new Set(),
    error: null,
  });
});

// ─── 渲染 hook（注册事件监听器）─────────────────────────────────────────────
function mountBridge() {
  return renderHook(() => useMcpBridge());
}

// ════════════════════════════════════════════════════════════════════════════
// UI Action — focus_tab
// ════════════════════════════════════════════════════════════════════════════
describe('mcp://ui-action → focus_tab', () => {
  it('切换到存在的 tab，回调 success=true 并更新 activeTabId', async () => {
    mountBridge();

    await emitUiAction({
      request_id: 'req-1',
      action: 'focus_tab',
      params: { tab_id: 'tab-ts1' },
    });

    expect(useQueryStore.getState().activeTabId).toBe('tab-ts1');
    expect(mockInvoke).toHaveBeenCalledWith('mcp_ui_action_respond', {
      requestId: 'req-1',
      success: true,
      data: { tab_id: 'tab-ts1' },
      error: null,
    });
  });

  it('tab 不存在时回调 success=false', async () => {
    mountBridge();

    await emitUiAction({
      request_id: 'req-2',
      action: 'focus_tab',
      params: { tab_id: 'non-existent' },
    });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_ui_action_respond', expect.objectContaining({
      requestId: 'req-2',
      success: false,
    }));
    // activeTabId 不变
    expect(useQueryStore.getState().activeTabId).toBe('tab-q1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// UI Action — open_tab (table_structure)
// ════════════════════════════════════════════════════════════════════════════
describe('mcp://ui-action → open_tab (table_structure)', () => {
  it('打开 table_structure tab 并回调 success=true 含 tab_id', async () => {
    // 清空现有 tabs 以便验证新建
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    mountBridge();

    await emitUiAction({
      request_id: 'req-3',
      action: 'open_tab',
      params: { connection_id: 1, type: 'table_structure', table_name: 'orders', database: 'mydb' },
    });

    const tabs = useQueryStore.getState().tabs;
    const newTab = tabs.find(t => t.type === 'table_structure');
    expect(newTab).toBeDefined();
    expect(mockInvoke).toHaveBeenCalledWith('mcp_ui_action_respond', expect.objectContaining({
      requestId: 'req-3',
      success: true,
      data: { tab_id: newTab!.id },
    }));
  });

  it('新建表模式（无 table_name）+ initial_columns 预填，回调 success=true 含 tab_id', async () => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    mountBridge();

    await emitUiAction({
      request_id: 'req-4',
      action: 'open_tab',
      params: {
        connection_id: 1,
        type: 'table_structure',
        database: 'mydb',
        initial_table_name: 'operation_logs',
        initial_columns: [
          { name: 'id',         data_type: 'BIGINT',      is_primary_key: true, extra: 'auto_increment' },
          { name: 'user_id',    data_type: 'BIGINT',      is_nullable: true },
          { name: 'action',     data_type: 'VARCHAR',     length: '50', is_nullable: false },
          { name: 'created_at', data_type: 'DATETIME',    is_nullable: false },
        ],
      },
    });

    const tabs = useQueryStore.getState().tabs;
    const newTab = tabs.find(t => t.type === 'table_structure' && t.title === 'operation_logs');
    expect(newTab).toBeDefined();
    expect(newTab!.initialColumns).toHaveLength(4);
    expect(newTab!.initialColumns![0].name).toBe('id');
    expect(mockInvoke).toHaveBeenCalledWith('mcp_ui_action_respond', expect.objectContaining({
      requestId: 'req-4',
      success: true,
      data: { tab_id: newTab!.id },
    }));
  });

  it('多个"新建表" tab 并存时，beforeIds 差集能正确找到本次新增的 tab', async () => {
    // 预设一个已有的 '新建表' tab，模拟旧 title-matching 会碰撞的场景
    useQueryStore.setState({
      tabs: [
        { id: 'existing-new-table', type: 'table_structure', title: '新建表', connectionId: 1, db: 'mydb', isNewTable: true },
      ],
      activeTabId: 'existing-new-table',
    });
    mountBridge();

    await emitUiAction({
      request_id: 'req-5',
      action: 'open_tab',
      params: { connection_id: 1, type: 'table_structure', database: 'mydb' },
    });

    const call = mockInvoke.mock.calls.find(
      c => c[0] === 'mcp_ui_action_respond' && (c[1] as { requestId: string }).requestId === 'req-5'
    );
    expect(call).toBeDefined();
    const resp = call![1] as { success: boolean; data: { tab_id: string } };
    expect(resp.success).toBe(true);
    // 返回的 tab_id 应该是新建的那个，不是预设的旧 tab
    expect(resp.data.tab_id).not.toBe('existing-new-table');
  });

  it('connection_id 为 null 时回调 success=false', async () => {
    mountBridge();

    await emitUiAction({
      request_id: 'req-6',
      action: 'open_tab',
      params: { connection_id: null, type: 'table_structure', database: 'mydb' },
    });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_ui_action_respond', expect.objectContaining({
      requestId: 'req-6',
      success: false,
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Query Request — search_tabs
// ════════════════════════════════════════════════════════════════════════════
describe('mcp://query-request → search_tabs', () => {
  it('无过滤条件返回所有 tab', async () => {
    mountBridge();

    await emitQueryRequest({ request_id: 'q-1', query_type: 'search_tabs', params: {} });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'q-1',
      data: expect.arrayContaining([
        expect.objectContaining({ tab_id: 'tab-q1' }),
        expect.objectContaining({ tab_id: 'tab-ts1' }),
        expect.objectContaining({ tab_id: 'tab-m1' }),
      ]),
    });
  });

  it('按 type 过滤：只返回 table_structure 类型', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-2',
      query_type: 'search_tabs',
      params: { type: 'table_structure' },
    });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'q-2',
      data: [expect.objectContaining({ tab_id: 'tab-ts1', type: 'table_structure' })],
    });
  });

  it('按 table_name 模糊过滤：匹配 title 含 users', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-3',
      query_type: 'search_tabs',
      params: { table_name: 'users' },
    });

    const call = mockInvoke.mock.calls.find(c => c[0] === 'mcp_query_respond');
    const data = (call![1] as { data: Array<{ tab_id: string }> }).data;
    expect(data.some(t => t.tab_id === 'tab-ts1')).toBe(true);
    // tab-q1 title 含 mydb 不含 users，不应出现
    expect(data.some(t => t.tab_id === 'tab-q1')).toBe(false);
  });

  it('table_name + type 同时过滤：无匹配返回空数组', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-4',
      query_type: 'search_tabs',
      params: { table_name: 'users', type: 'metric' },
    });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'q-4',
      data: [],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Query Request — get_tab_content
// ════════════════════════════════════════════════════════════════════════════
describe('mcp://query-request → get_tab_content', () => {
  it('存在的 tab 返回完整内容含 sql_content', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-5',
      query_type: 'get_tab_content',
      params: { tab_id: 'tab-q1' },
    });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'q-5',
      data: expect.objectContaining({
        tab_id: 'tab-q1',
        type: 'query',
        sql_content: 'SELECT 1',
        db: 'mydb',
        connection_id: 1,
      }),
    });
  });

  it('不存在的 tab 返回 null', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-6',
      query_type: 'get_tab_content',
      params: { tab_id: 'nonexistent' },
    });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'q-6',
      data: null,
    });
  });

  it('无 sql_content 的 tab 返回 null 的 sql_content', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-7',
      query_type: 'get_tab_content',
      params: { tab_id: 'tab-m1' },
    });

    const call = mockInvoke.mock.calls.find(c => c[0] === 'mcp_query_respond');
    const data = (call![1] as { data: { sql_content: unknown } }).data;
    expect(data.sql_content).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Query Request — search_db_metadata
// ════════════════════════════════════════════════════════════════════════════
describe('mcp://query-request → search_db_metadata', () => {
  it('精确前缀匹配返回正确节点', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-8',
      query_type: 'search_db_metadata',
      params: { keyword: 'users' },
    });

    const call = mockInvoke.mock.calls.find(c => c[0] === 'mcp_query_respond');
    const data = (call![1] as { data: Array<{ name: string; type: string }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('users');
    expect(data[0].type).toBe('table');
  });

  it('模糊匹配：ord 匹配 orders', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-9',
      query_type: 'search_db_metadata',
      params: { keyword: 'ord' },
    });

    const call = mockInvoke.mock.calls.find(c => c[0] === 'mcp_query_respond');
    const data = (call![1] as { data: Array<{ name: string }> }).data;
    expect(data.some(n => n.name === 'orders')).toBe(true);
  });

  it('大小写不敏感', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-10',
      query_type: 'search_db_metadata',
      params: { keyword: 'USERS' },
    });

    const call = mockInvoke.mock.calls.find(c => c[0] === 'mcp_query_respond');
    const data = (call![1] as { data: Array<{ name: string }> }).data;
    expect(data.some(n => n.name === 'users')).toBe(true);
  });

  it('无匹配时返回空数组', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-11',
      query_type: 'search_db_metadata',
      params: { keyword: 'nonexistent_xyz' },
    });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'q-11',
      data: [],
    });
  });

  it('treeStore 为空时返回空数组', async () => {
    useTreeStore.setState({ nodes: new Map() });
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-12',
      query_type: 'search_db_metadata',
      params: { keyword: 'users' },
    });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'q-12',
      data: [],
    });
  });

  it('返回 connection_id meta 信息', async () => {
    mountBridge();

    await emitQueryRequest({
      request_id: 'q-13',
      query_type: 'search_db_metadata',
      params: { keyword: 'users' },
    });

    const call = mockInvoke.mock.calls.find(c => c[0] === 'mcp_query_respond');
    const data = (call![1] as { data: Array<{ connection_id?: number }> }).data;
    expect(data[0].connection_id).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 错误处理
// ════════════════════════════════════════════════════════════════════════════
describe('错误处理', () => {
  it('invoke 失败时 ui-action handler 不抛出', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('invoke failed'));
    mountBridge();

    // 不应抛出
    await expect(
      emitUiAction({ request_id: 'err-1', action: 'focus_tab', params: { tab_id: 'tab-q1' } })
    ).resolves.not.toThrow();
  });

  it('query-request handler 发生内部错误时调用 mcp_query_respond 兜底', async () => {
    // 故意传入损坏的 params
    mountBridge();

    await emitQueryRequest({
      request_id: 'err-2',
      query_type: 'search_db_metadata',
      params: { keyword: '' },
    });

    // 空关键词应正常返回，不报错
    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', expect.objectContaining({
      requestId: 'err-2',
    }));
  });
});

// ─── 新增：fs_request 场景 ───────────────────────────────────────────────────

describe('mcp://query-request → fs_request', () => {
  it('将 fs_request 路由到 fsRouter.handle 并回调 mcp_query_respond', async () => {
    mountBridge()

    await emitQueryRequest({
      request_id: 'fs-1',
      query_type: 'fs_request',
      params: { op: 'read', resource: 'tab.query', target: 'active', payload: { mode: 'text' } },
    })

    expect(fsRouter.handle).toHaveBeenCalledWith({
      op: 'read', resource: 'tab.query', target: 'active', payload: { mode: 'text' },
    })
    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'fs-1',
      data: { content: 'SELECT 1', lines: [] },
    })
  })

  it('fsRouter 抛出错误时回调 error 字段', async () => {
    vi.mocked(fsRouter.handle).mockRejectedValueOnce(new Error('Unknown resource: tab.unknown'))
    mountBridge()

    await emitQueryRequest({
      request_id: 'fs-2',
      query_type: 'fs_request',
      params: { op: 'read', resource: 'tab.unknown', target: 'active', payload: { mode: 'text' } },
    })

    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'fs-2',
      data: { error: 'Unknown resource: tab.unknown' },
    })
  })
})
