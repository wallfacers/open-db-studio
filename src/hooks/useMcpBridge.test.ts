import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock Tauri APIs ────────────────────────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// ─── Mock ui module ────────────────────────────────────────────────────────
vi.mock('../mcp/ui', () => ({
  uiRouter: {
    registerInstance: vi.fn(),
    setActiveTabIdProvider: vi.fn(),
    handle: vi.fn().mockResolvedValue({ data: { content: 'SELECT 1' } }),
  },
}));

vi.mock('../mcp/ui/adapters/WorkspaceAdapter', () => ({
  WorkspaceAdapter: vi.fn(),
}));
vi.mock('../mcp/ui/adapters/DbTreeAdapter', () => ({
  DbTreeAdapter: vi.fn(),
}));
vi.mock('../mcp/ui/adapters/HistoryAdapter', () => ({
  HistoryAdapter: vi.fn(),
}));

type ListenCallback<T> = (event: { payload: T }) => void | Promise<void>;
const capturedListeners: Record<string, ListenCallback<unknown>> = {};

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, cb: ListenCallback<unknown>) => {
    capturedListeners[eventName] = cb;
    return Promise.resolve(() => { delete capturedListeners[eventName]; });
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import { renderHook } from '@testing-library/react';
import { useQueryStore } from '../store/queryStore';
import { useMcpBridge } from './useMcpBridge';
import { uiRouter } from '../mcp/ui';

const mockInvoke = vi.mocked(invoke);

// ─── 辅助：触发模拟事件 ──────────────────────────────────────────────────────
async function emitUIRequest(payload: unknown) {
  const handler = capturedListeners['mcp://ui-request'];
  if (!handler) throw new Error('mcp://ui-request listener not registered');
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
    ],
    activeTabId: 'tab-q1',
    sqlContent: { 'tab-q1': 'SELECT 1', 'tab-ts1': '' },
  });
});

// ─── 渲染 hook（注册事件监听器）─────────────────────────────────────────────
function mountBridge() {
  return renderHook(() => useMcpBridge());
}

// ════════════════════════════════════════════════════════════════════════════
// Adapter registration
// ════════════════════════════════════════════════════════════════════════════
describe('adapter registration', () => {
  it('registers workspace, db_tree, history singleton adapters', () => {
    mountBridge();

    expect(uiRouter.registerInstance).toHaveBeenCalledWith('workspace', expect.anything());
    expect(uiRouter.registerInstance).toHaveBeenCalledWith('db_tree', expect.anything());
    expect(uiRouter.registerInstance).toHaveBeenCalledWith('history', expect.anything());
  });

  it('sets activeTabId provider', () => {
    mountBridge();

    expect(uiRouter.setActiveTabIdProvider).toHaveBeenCalledWith(expect.any(Function));
  });

  it('activeTabId provider returns current activeTabId from store', () => {
    mountBridge();

    const provider = vi.mocked(uiRouter.setActiveTabIdProvider).mock.calls[0][0] as () => string | null;
    expect(provider()).toBe('tab-q1');

    useQueryStore.setState({ activeTabId: 'tab-ts1' });
    expect(provider()).toBe('tab-ts1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://ui-request listener
// ════════════════════════════════════════════════════════════════════════════
describe('mcp://ui-request → uiRouter', () => {
  it('registers mcp://ui-request listener on mount', () => {
    mountBridge();
    expect(capturedListeners['mcp://ui-request']).toBeDefined();
  });

  it('routes ui_read to uiRouter.handle and responds', async () => {
    mountBridge();

    await emitUIRequest({
      request_id: 'ui-1',
      query_type: 'ui_request',
      params: { tool: 'ui_read', object: 'query_editor', target: 'active', payload: { mode: 'state' } },
    });

    expect(uiRouter.handle).toHaveBeenCalledWith({
      tool: 'ui_read', object: 'query_editor', target: 'active', payload: { mode: 'state' },
    });
    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'ui-1',
      data: { data: { content: 'SELECT 1' } },
    });
  });

  it('routes ui_patch with ops to uiRouter.handle', async () => {
    mountBridge();

    const ops = [{ op: 'replace' as const, path: '/content', value: 'SELECT * FROM users' }];
    await emitUIRequest({
      request_id: 'ui-2',
      query_type: 'ui_request',
      params: { tool: 'ui_patch', object: 'query_editor', target: 'active', payload: { ops, reason: 'test' } },
    });

    expect(uiRouter.handle).toHaveBeenCalledWith({
      tool: 'ui_patch', object: 'query_editor', target: 'active', payload: { ops, reason: 'test' },
    });
  });

  it('routes ui_exec to uiRouter.handle', async () => {
    vi.mocked(uiRouter.handle).mockResolvedValueOnce({ data: { success: true } });
    mountBridge();

    await emitUIRequest({
      request_id: 'ui-3',
      query_type: 'ui_request',
      params: { tool: 'ui_exec', object: 'query_editor', target: 'active', payload: { action: 'run_sql' } },
    });

    expect(uiRouter.handle).toHaveBeenCalledWith({
      tool: 'ui_exec', object: 'query_editor', target: 'active', payload: { action: 'run_sql' },
    });
  });

  it('routes ui_list to uiRouter.handle', async () => {
    vi.mocked(uiRouter.handle).mockResolvedValueOnce({ data: [{ objectId: 'tab-q1', type: 'query_editor' }] });
    mountBridge();

    await emitUIRequest({
      request_id: 'ui-4',
      query_type: 'ui_request',
      params: { tool: 'ui_list', object: '', target: '', payload: { filter: { type: 'query_editor' } } },
    });

    expect(uiRouter.handle).toHaveBeenCalledWith({
      tool: 'ui_list', object: '', target: '', payload: { filter: { type: 'query_editor' } },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Error handling
// ════════════════════════════════════════════════════════════════════════════
describe('error handling', () => {
  it('uiRouter.handle throws — responds with error', async () => {
    vi.mocked(uiRouter.handle).mockRejectedValueOnce(new Error('adapter error'));
    mountBridge();

    await emitUIRequest({
      request_id: 'err-1',
      query_type: 'ui_request',
      params: { tool: 'ui_read', object: 'query_editor', target: 'active', payload: { mode: 'state' } },
    });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_query_respond', {
      requestId: 'err-1',
      data: { error: 'Error: adapter error' },
    });
  });

  it('mcp_query_respond invoke fails — does not throw', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('invoke failed'));
    mountBridge();

    // Should not throw — error is silently caught
    await expect(
      emitUIRequest({
        request_id: 'err-2',
        query_type: 'ui_request',
        params: { tool: 'ui_read', object: 'query_editor', target: 'active', payload: {} },
      })
    ).resolves.not.toThrow();
  });
});
