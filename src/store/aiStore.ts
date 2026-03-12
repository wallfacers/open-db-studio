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
  sendChat: (message: string, connectionId: number | null) => Promise<string>;
  sendChatStream: (message: string, connectionId: number | null) => Promise<void>;
  clearHistory: () => void;

  sendAgentChatStream: (message: string, connectionId: number | null) => Promise<void>;
  // 当前工具调用状态
  activeToolName: string | null;

  // AI 功能
  isGenerating: boolean;
  isExplaining: boolean;
  isOptimizing: boolean;
  isDiagnosing: boolean;
  isCreatingTable: boolean;
  error: string | null;
  generateSql: (prompt: string, connectionId: number) => Promise<string>;
  explainSql: (sql: string, connectionId: number) => Promise<string>;
  optimizeSql: (sql: string, connectionId: number) => Promise<string>;
  createTable: (description: string, connectionId: number) => Promise<string>;
  diagnoseError: (sql: string, errorMsg: string, connectionId: number) => Promise<string>;
}

export const useAiStore = create<AiState>((set, get) => ({
  configs: [],
  activeConfigId: null,
  chatHistory: [],
  isChatting: false,
  activeToolName: null,
  isGenerating: false,
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
          set((s) => {
            const h = [...s.chatHistory];
            const last = { ...h[h.length - 1] };
            last.thinkingContent = (last.thinkingContent ?? '') + event.data!.delta!;
            h[h.length - 1] = last;
            return { chatHistory: h };
          });
        } else if (event.type === 'ContentChunk' && event.data?.delta) {
          set((s) => {
            const h = [...s.chatHistory];
            const last = { ...h[h.length - 1] };
            last.content = (last.content ?? '') + event.data!.delta!;
            h[h.length - 1] = last;
            return { chatHistory: h };
          });
        } else if (event.type === 'ToolCallRequest' && event.data?.name) {
          set({ activeToolName: event.data.name });
        } else if (event.type === 'Done') {
          set((s) => {
            const h = [...s.chatHistory];
            h[h.length - 1] = { ...h[h.length - 1], isStreaming: false };
            return { chatHistory: h, isChatting: false, activeToolName: null };
          });
        } else if (event.type === 'Error') {
          set((s) => {
            const h = [...s.chatHistory];
            h[h.length - 1] = {
              ...h[h.length - 1],
              content: `Error: ${event.data?.message ?? 'Unknown error'}`,
              isStreaming: false,
            };
            return { chatHistory: h, isChatting: false, activeToolName: null };
          });
        }
      };

      await invoke('ai_chat_acp', {
        prompt: message,
        connectionId,
        tabSql,
        channel,
      });
    } catch (e) {
      set((s) => {
        const h = [...s.chatHistory];
        h[h.length - 1] = {
          ...h[h.length - 1],
          content: `Error: ${String(e)}`,
          isStreaming: false,
        };
        return { chatHistory: h, isChatting: false, activeToolName: null };
      });
    }
  },

  sendChat: async (message, _connectionId) => {
    const historyBeforeMessage = get().chatHistory;
    set((s) => ({
      isChatting: true,
      chatHistory: [...s.chatHistory, { role: 'user', content: message }],
    }));
    try {
      const reply = await invoke<string>('ai_chat', {
        message,
        context: { history: historyBeforeMessage, model: null },
      });
      set((s) => ({
        chatHistory: [...s.chatHistory, { role: 'assistant', content: reply }],
        isChatting: false,
      }));
      return reply;
    } catch (e) {
      set((s) => ({
        chatHistory: [...s.chatHistory, { role: 'assistant', content: `Error: ${String(e)}` }],
        isChatting: false,
      }));
      throw e;
    }
  },

  sendChatStream: async (message, _connectionId) => {
    const historyBeforeMessage = get().chatHistory;
    set((s) => ({
      isChatting: true,
      chatHistory: [...s.chatHistory, { role: 'user', content: message }],
    }));
    set((s) => ({
      chatHistory: [
        ...s.chatHistory,
        { role: 'assistant', content: '', thinkingContent: '', isStreaming: true },
      ],
    }));

    try {
      const { Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<{
        type: 'ThinkingChunk' | 'ContentChunk' | 'Done' | 'Error';
        data?: { delta?: string; message?: string };
      }>();

      channel.onmessage = (event) => {
        if (event.type === 'ThinkingChunk' && event.data?.delta) {
          set((s) => {
            const history = [...s.chatHistory];
            const last = { ...history[history.length - 1] };
            last.thinkingContent = (last.thinkingContent ?? '') + event.data!.delta!;
            history[history.length - 1] = last;
            return { chatHistory: history };
          });
        } else if (event.type === 'ContentChunk' && event.data?.delta) {
          set((s) => {
            const history = [...s.chatHistory];
            const last = { ...history[history.length - 1] };
            last.content = (last.content ?? '') + event.data!.delta!;
            history[history.length - 1] = last;
            return { chatHistory: history };
          });
        } else if (event.type === 'Done') {
          set((s) => {
            const history = [...s.chatHistory];
            const last = { ...history[history.length - 1], isStreaming: false };
            history[history.length - 1] = last;
            return { chatHistory: history, isChatting: false };
          });
        } else if (event.type === 'Error') {
          set((s) => {
            const history = [...s.chatHistory];
            const last = {
              ...history[history.length - 1],
              content: `Error: ${event.data?.message ?? 'Unknown error'}`,
              isStreaming: false,
            };
            history[history.length - 1] = last;
            return { chatHistory: history, isChatting: false };
          });
        }
      };

      await invoke('ai_chat_stream', {
        message,
        context: { history: historyBeforeMessage, model: null },
        channel,
      });
    } catch (e) {
      set((s) => {
        const history = [...s.chatHistory];
        const last = {
          ...history[history.length - 1],
          content: `Error: ${String(e)}`,
          isStreaming: false,
        };
        history[history.length - 1] = last;
        return { chatHistory: history, isChatting: false };
      });
    }
  },

  generateSql: async (prompt, connectionId) => {
    set({ isGenerating: true, error: null });
    try {
      return await invoke<string>('ai_generate_sql', { prompt, connectionId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isGenerating: false });
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
