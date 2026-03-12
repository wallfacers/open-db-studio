import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput, ChatMessage } from '../types';

interface AiState {
  // 配置列表
  configs: LlmConfig[];
  loadConfigs: () => Promise<void>;
  createConfig: (input: CreateLlmConfigInput) => Promise<void>;
  updateConfig: (id: number, input: UpdateLlmConfigInput) => Promise<void>;
  deleteConfig: (id: number) => Promise<void>;
  setDefaultConfig: (id: number) => Promise<void>;
  testConfig: (id: number) => Promise<void>;

  // AI 面板当前选中的配置（null = 使用 default）
  activeConfigId: number | null;
  setActiveConfigId: (id: number | null) => void;

  // 多轮对话
  chatHistory: ChatMessage[];
  isChatting: boolean;
  clearHistory: () => void;

  sendAgentChatStream: (message: string, connectionId: number | null) => Promise<void>;
  // 当前工具调用状态
  activeToolName: string | null;

  // AI 功能
  isExplaining: boolean;
  isOptimizing: boolean;
  isDiagnosing: boolean;
  isCreatingTable: boolean;
  error: string | null;
  explainSql: (sql: string, connectionId: number) => Promise<string>;
  optimizeSql: (sql: string, connectionId: number) => Promise<string>;
  createTable: (description: string, connectionId: number) => Promise<string>;
  diagnoseError: (sql: string, errorMsg: string, connectionId: number) => Promise<string>;
}

// Mutate the last entry in chatHistory with partial updates.
const updateLastMsg = (
  set: (fn: (s: AiState) => Partial<AiState>) => void,
  updates: Partial<ChatMessage>,
  extra: Partial<AiState> = {}
) =>
  set((s) => {
    const h = [...s.chatHistory];
    h[h.length - 1] = { ...h[h.length - 1], ...updates };
    return { chatHistory: h, ...extra };
  });

// Append a delta string to a field on the last chatHistory entry.
const appendToLastMsg = (
  set: (fn: (s: AiState) => Partial<AiState>) => void,
  field: 'content' | 'thinkingContent',
  delta: string
) =>
  set((s) => {
    const h = [...s.chatHistory];
    const last = { ...h[h.length - 1] };
    last[field] = ((last[field] as string) ?? '') + delta;
    h[h.length - 1] = last;
    return { chatHistory: h };
  });

export const useAiStore = create<AiState>((set, get) => ({
  configs: [],
  activeConfigId: null,
  chatHistory: [],
  isChatting: false,
  activeToolName: null,
  isExplaining: false,
  isOptimizing: false,
  isDiagnosing: false,
  isCreatingTable: false,
  error: null,

  setActiveConfigId: (id) => set({ activeConfigId: id }),

  loadConfigs: async () => {
    const configs = await invoke<LlmConfig[]>('list_llm_configs');
    set({ configs });
  },

  createConfig: async (input) => {
    await invoke('create_llm_config', { input });
    await get().loadConfigs();
  },

  updateConfig: async (id, input) => {
    await invoke('update_llm_config', { id, input });
    await get().loadConfigs();
  },

  deleteConfig: async (id) => {
    await invoke('delete_llm_config', { id });
    set((s) => ({
      activeConfigId: s.activeConfigId === id ? null : s.activeConfigId,
    }));
    await get().loadConfigs();
  },

  setDefaultConfig: async (id) => {
    await invoke('set_default_llm_config', { id });
    await get().loadConfigs();
  },

  testConfig: async (id) => {
    set((s) => ({
      configs: s.configs.map((c) =>
        c.id === id ? { ...c, test_status: 'testing' as const } : c
      ),
    }));
    try {
      await invoke('test_llm_config', { id });
    } finally {
      await get().loadConfigs();
    }
  },

  clearHistory: () => set({ chatHistory: [] }),

  sendAgentChatStream: async (message, connectionId) => {
    // 获取当前 tab SQL（用于注入上下文）
    const { useQueryStore } = await import('./queryStore');
    const queryStore = useQueryStore.getState();
    const activeTabId = queryStore.activeTabId;
    const tabSql: string | null = activeTabId
      ? queryStore.sqlContent[activeTabId] ?? null
      : null;

    // 展示用户消息 + 占位 assistant 消息
    set((s) => ({
      isChatting: true,
      chatHistory: [
        ...s.chatHistory,
        { role: 'user' as const, content: message },
        { role: 'assistant' as const, content: '', thinkingContent: '', isStreaming: true },
      ],
    }));

    try {
      const { Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<{
        type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'Done' | 'Error';
        data?: { delta?: string; message?: string; call_id?: string; name?: string; arguments?: string };
      }>();

      channel.onmessage = (event) => {
        if (event.type === 'ThinkingChunk' && event.data?.delta) {
          appendToLastMsg(set, 'thinkingContent', event.data.delta);
        } else if (event.type === 'ContentChunk' && event.data?.delta) {
          appendToLastMsg(set, 'content', event.data.delta);
        } else if (event.type === 'ToolCallRequest' && event.data?.name) {
          set(() => ({ activeToolName: event.data!.name! }));
        } else if (event.type === 'Done') {
          updateLastMsg(set, { isStreaming: false }, { isChatting: false, activeToolName: null });
        } else if (event.type === 'Error') {
          updateLastMsg(
            set,
            { content: `Error: ${event.data?.message ?? 'Unknown error'}`, isStreaming: false },
            { isChatting: false, activeToolName: null }
          );
        }
      };

      await invoke('ai_chat_acp', {
        prompt: message,
        tabSql,
        channel,
      });
    } catch (e) {
      updateLastMsg(set, { content: `Error: ${String(e)}`, isStreaming: false }, { isChatting: false, activeToolName: null });
    }
  },

  explainSql: async (sql, connectionId) => {
    set({ isExplaining: true, error: null });
    try {
      return await invoke<string>('ai_explain_sql', { sql, connectionId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isExplaining: false });
    }
  },

  optimizeSql: async (sql, connectionId) => {
    set({ isOptimizing: true, error: null });
    try {
      return await invoke<string>('ai_optimize_sql', { sql, connectionId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isOptimizing: false });
    }
  },

  createTable: async (description, connectionId) => {
    set({ isCreatingTable: true, error: null });
    try {
      return await invoke<string>('ai_create_table', { description, connectionId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isCreatingTable: false });
    }
  },

  diagnoseError: async (sql, errorMsg, connectionId) => {
    set({ isDiagnosing: true, error: null });
    try {
      return await invoke<string>('ai_diagnose_error', { sql, errorMsg, connectionId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isDiagnosing: false });
    }
  },
}));
