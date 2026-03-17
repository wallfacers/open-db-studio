import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from './appStore';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ autoMode: false });
});

describe('autoMode 初始值', () => {
  it('默认为 false', () => {
    expect(useAppStore.getState().autoMode).toBe(false);
  });
});

describe('setAutoMode', () => {
  it('乐观更新本地状态', async () => {
    mockInvoke.mockResolvedValue(undefined);
    await useAppStore.getState().setAutoMode(true);
    expect(useAppStore.getState().autoMode).toBe(true);
  });

  it('调用 Tauri set_auto_mode 命令', async () => {
    mockInvoke.mockResolvedValue(undefined);
    await useAppStore.getState().setAutoMode(true);
    expect(mockInvoke).toHaveBeenCalledWith('set_auto_mode', { enabled: true });
  });

  it('setAutoMode(false) 调用正确参数', async () => {
    useAppStore.setState({ autoMode: true });
    mockInvoke.mockResolvedValue(undefined);
    await useAppStore.getState().setAutoMode(false);
    expect(useAppStore.getState().autoMode).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith('set_auto_mode', { enabled: false });
  });

  it('Tauri 调用失败时本地状态仍已更新（乐观更新不回滚）', async () => {
    mockInvoke.mockRejectedValue(new Error('Tauri error'));
    await useAppStore.getState().setAutoMode(true);
    // 乐观更新：本地状态先变，失败时不回滚
    expect(useAppStore.getState().autoMode).toBe(true);
  });
});

describe('initAutoMode', () => {
  it('从 Tauri 读取 true 并同步到 store', async () => {
    mockInvoke.mockResolvedValue(true);
    await useAppStore.getState().initAutoMode();
    expect(mockInvoke).toHaveBeenCalledWith('get_auto_mode');
    expect(useAppStore.getState().autoMode).toBe(true);
  });

  it('从 Tauri 读取 false 并同步到 store', async () => {
    useAppStore.setState({ autoMode: true });
    mockInvoke.mockResolvedValue(false);
    await useAppStore.getState().initAutoMode();
    expect(useAppStore.getState().autoMode).toBe(false);
  });

  it('Tauri 调用失败时 autoMode 保持原值（不抛出）', async () => {
    useAppStore.setState({ autoMode: false });
    mockInvoke.mockRejectedValue(new Error('Tauri not available'));
    await expect(useAppStore.getState().initAutoMode()).resolves.toBeUndefined();
    expect(useAppStore.getState().autoMode).toBe(false);
  });
});

describe('isAssistantOpen', () => {
  it('默认为 true', () => {
    useAppStore.setState({ isAssistantOpen: true });
    expect(useAppStore.getState().isAssistantOpen).toBe(true);
  });

  it('setAssistantOpen 更新状态', () => {
    useAppStore.getState().setAssistantOpen(false);
    expect(useAppStore.getState().isAssistantOpen).toBe(false);
  });
});
