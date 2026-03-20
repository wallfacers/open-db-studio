import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mock Tauri APIs ────────────────────────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

type ListenCb<T> = (event: { payload: T }) => void | Promise<void>;
const capturedListeners: Record<string, ListenCb<unknown>> = {};

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, cb: ListenCb<unknown>) => {
    capturedListeners[eventName] = cb;
    return Promise.resolve(() => { delete capturedListeners[eventName]; });
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import { renderHook } from '@testing-library/react';
import { useQueryStore } from '../store/queryStore';
import { useAppStore } from '../store/appStore';
import { useToolBridge } from './useToolBridge';

const mockInvoke = vi.mocked(invoke);

// ─── 辅助：触发 sql-diff-proposal 事件 ──────────────────────────────────────
async function emitDiffProposal(payload: { original: string; modified: string; reason: string }) {
  const handler = capturedListeners['sql-diff-proposal'];
  if (!handler) throw new Error('sql-diff-proposal listener not registered');
  await handler({ payload });
}

function mountBridge() {
  return renderHook(() => useToolBridge());
}

// 使用假定时器，防止 setSql 内部的 persistSqlContent 防抖（500ms）跨用例残留
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  // 默认关闭 Auto 模式
  useAppStore.setState({ autoMode: false, isAssistantOpen: false });
  // 初始化 store：tab-1 包含可匹配的 SQL
  useQueryStore.setState({
    tabs: [{ id: 'tab-1', type: 'query', title: 'Q1' }],
    activeTabId: 'tab-1',
    sqlContent: { 'tab-1': 'SELECT 1;' },
    pendingDiff: null,
    autoApplyBanner: null,
  });
});

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════
// 分支 1: autoMode=false + 找到匹配 → DiffPanel 流程
// ════════════════════════════════════════════════════════════════════════════
describe('autoMode=false + 找到匹配', () => {
  it('设置 pendingDiff，不调用 mcp_diff_respond，打开助手面板', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2', reason: '优化' });

    const { pendingDiff, autoApplyBanner } = useQueryStore.getState();
    expect(pendingDiff).not.toBeNull();
    expect(pendingDiff?.original).toBe('SELECT 1');
    expect(autoApplyBanner).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith('mcp_diff_respond', expect.anything());
    // 回归断言：非 Auto 找到匹配时同样打开助手面板（原有行为）
    expect(useAppStore.getState().isAssistantOpen).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 分支 2: autoMode=false + 未找到匹配 → mcp_diff_respond(false)
// ════════════════════════════════════════════════════════════════════════════
describe('autoMode=false + 未找到匹配', () => {
  it('调用 mcp_diff_respond(false)，不设 pendingDiff', async () => {
    mountBridge();
    // 'NOT IN EDITOR' 在编辑器 SQL 中找不到
    await emitDiffProposal({ original: 'NOT IN EDITOR', modified: 'X', reason: '' });

    expect(useQueryStore.getState().pendingDiff).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('mcp_diff_respond', { confirmed: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 分支 3: autoMode=true + 找到匹配 → 直接写 SQL
// ════════════════════════════════════════════════════════════════════════════
describe('autoMode=true + 找到匹配', () => {
  beforeEach(() => {
    useAppStore.setState({ autoMode: true, isAssistantOpen: false });
  });

  it('直接更新 sqlContent，不设 pendingDiff', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2;', reason: '优化' });

    const { sqlContent, pendingDiff } = useQueryStore.getState();
    expect(sqlContent['tab-1']).toBe('SELECT 2;');
    expect(pendingDiff).toBeNull();
  });

  it('调用 mcp_diff_respond(true)', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2;', reason: '优化' });

    expect(mockInvoke).toHaveBeenCalledWith('mcp_diff_respond', { confirmed: true });
  });

  it('设置 autoApplyBanner', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2;', reason: '优化查询' });

    expect(useQueryStore.getState().autoApplyBanner).toEqual({ reason: '优化查询' });
  });

  it('打开助手面板', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2;', reason: '' });

    expect(useAppStore.getState().isAssistantOpen).toBe(true);
  });

  it('分号消费：modified 带分号不产生双分号', async () => {
    // full = 'SELECT 1;'，endOffset=8（'SELECT 1' 末尾），full[8]=';'
    mountBridge();
    await emitDiffProposal({ original: 'SELECT 1', modified: 'SELECT 2;', reason: '' });

    expect(useQueryStore.getState().sqlContent['tab-1']).toBe('SELECT 2;');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 分支 4: autoMode=true + 未找到匹配 → mcp_diff_respond(false)
// ════════════════════════════════════════════════════════════════════════════
describe('autoMode=true + 未找到匹配', () => {
  beforeEach(() => {
    useAppStore.setState({ autoMode: true });
  });

  it('调用 mcp_diff_respond(false)，不修改 sqlContent', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'NOT IN EDITOR', modified: 'X', reason: '' });

    expect(useQueryStore.getState().sqlContent['tab-1']).toBe('SELECT 1;');
    expect(mockInvoke).toHaveBeenCalledWith('mcp_diff_respond', { confirmed: false });
  });

  it('不设置 autoApplyBanner', async () => {
    mountBridge();
    await emitDiffProposal({ original: 'NOT IN EDITOR', modified: 'X', reason: '' });

    expect(useQueryStore.getState().autoApplyBanner).toBeNull();
  });
});
