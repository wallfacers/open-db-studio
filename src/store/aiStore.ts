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

  // 多轮对话：只存已完成的消息，流式中不写入
  chatHistory: ChatMessage[];
  // 当前流式消息内容（独立于 chatHistory，避免历史消息重渲染）
  streamingContent: string;
  streamingThinkingContent: string;
  isChatting: boolean;
  clearHistory: () => void;

  cancelChat: () => Promise<void>;
  sendAgentChatStream: (message: string, connectionId: number | null) => Promise<void>;
  // 当前工具调用状态
  activeToolName: string | null;
  // session 建立阶段的进度文字（仅在冷启动时短暂出现）
  sessionStatus: string | null;

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

export const useAiStore = create<AiState>((set, get) => ({
  configs: [],
  activeConfigId: null,
  chatHistory: [],
  streamingContent: '',
  streamingThinkingContent: '',
  isChatting: false,
  activeToolName: null,
  sessionStatus: null,
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

  clearHistory: () => {
    set({
      chatHistory: [],
      streamingContent: '',
      streamingThinkingContent: '',
    });
    // 同时销毁后端 session，确保下次对话从全新上下文开始
    invoke('cancel_acp_session').catch(() => {});
  },

  cancelChat: async () => {
    const { streamingContent, streamingThinkingContent } = get();
    set((s) => ({
      chatHistory: streamingContent
        ? [...s.chatHistory, { role: 'assistant' as const, content: streamingContent, thinkingContent: streamingThinkingContent || undefined }]
        : s.chatHistory,
      streamingContent: '',
      streamingThinkingContent: '',
      isChatting: false,
      activeToolName: null,
      sessionStatus: null,
    }));
    try {
      await invoke('cancel_acp_session');
    } catch (_) {
      // session 可能已经不存在，忽略
    }
  },

  sendAgentChatStream: async (message, connectionId) => {
    // 获取当前 tab SQL（用于注入上下文）
    const { useQueryStore } = await import('./queryStore');
    const queryStore = useQueryStore.getState();
    const activeTabId = queryStore.activeTabId;
    const tabSql: string | null = activeTabId
      ? queryStore.sqlContent[activeTabId] ?? null
      : null;

    // 只追加用户消息到 chatHistory；流式 assistant 内容存入独立状态
    set((s) => ({
      isChatting: true,
      streamingContent: '',
      streamingThinkingContent: '',
      chatHistory: [...s.chatHistory, { role: 'user' as const, content: message }],
    }));

    // 将最终流式内容 commit 到 chatHistory
    const commitAssistant = (content: string, thinking: string) => {
      set((s) => ({
        chatHistory: [
          ...s.chatHistory,
          { role: 'assistant' as const, content, thinkingContent: thinking },
        ],
        streamingContent: '',
        streamingThinkingContent: '',
        isChatting: false,
        activeToolName: null,
        sessionStatus: null,
      }));
    };

    try {
      const { Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<{
        type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error';
        data?: { delta?: string; message?: string; call_id?: string; name?: string; arguments?: string };
      }>();

      // RAF 节流：高频 delta 合并成每帧一次 state 更新
      // 只更新 streamingContent/streamingThinkingContent（不触碰 chatHistory）
      let contentBuf = '';
      let thinkingBuf = '';
      let rafId: number | null = null;

      const flushBuffers = () => {
        rafId = null;
        if (contentBuf) {
          const delta = contentBuf; contentBuf = '';
          set((s) => ({ streamingContent: s.streamingContent + delta }));
        }
        if (thinkingBuf) {
          const delta = thinkingBuf; thinkingBuf = '';
          set((s) => ({ streamingThinkingContent: s.streamingThinkingContent + delta }));
        }
      };

      const scheduleFlush = () => {
        if (!rafId) rafId = requestAnimationFrame(flushBuffers);
      };

      const flushNow = () => {
        if (rafId) { cancelAnimationFrame(rafId); flushBuffers(); }
      };

      channel.onmessage = (event) => {
        if (event.type === 'StatusUpdate' && event.data?.message) {
          set(() => ({ sessionStatus: event.data!.message! }));
        } else if (event.type === 'ThinkingChunk' && event.data?.delta) {
          set(() => ({ sessionStatus: null }));
          thinkingBuf += event.data.delta;
          scheduleFlush();
        } else if (event.type === 'ContentChunk' && event.data?.delta) {
          set(() => ({ sessionStatus: null }));
          contentBuf += event.data.delta;
          scheduleFlush();
        } else if (event.type === 'ToolCallRequest' && event.data?.name) {
          flushNow();
          set(() => ({ activeToolName: event.data!.name!, sessionStatus: null }));
        } else if (event.type === 'Done') {
          flushNow();
          if (!get().isChatting) return; // 已被 cancelChat 处理
          const { streamingContent, streamingThinkingContent } = get();
          commitAssistant(streamingContent, streamingThinkingContent);
        } else if (event.type === 'Error') {
          flushNow();
          if (!get().isChatting) return; // 已被 cancelChat 处理
          const errorContent = `Error: ${event.data?.message ?? 'Unknown error'}`;
          commitAssistant(errorContent, '');
        }
      };

      // 读取当前选中的配置 ID（null 表示使用默认）
      const configId = get().activeConfigId;

      await invoke('ai_chat_acp', {
        prompt: message,
        tabSql,
        connectionId,  // Rust 侧接收为 Option<i64>，null 序列化为 None
        configId,
        channel,
      });
    } catch (e) {
      commitAssistant(`Error: ${String(e)}`, '');
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
