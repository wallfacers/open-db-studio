import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import type { LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput, ChatMessage, ChatSession } from '../types';
import { useAppStore } from './appStore';

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** 截断第一条用户消息作为默认标题 */
const makeDefaultTitle = (firstMsg: string): string => {
  const clean = firstMsg.replace(/\s+/g, ' ').trim();
  return clean.length > 22 ? clean.slice(0, 20) + '…' : clean;
};

/** 生成 UUID（浏览器原生 API） */
const uuid = () => crypto.randomUUID();

/**
 * 后台调用 AI 生成会话标题（复用已有的 ai_chat 命令）。
 * 失败时静默忽略，保留默认标题。
 */
async function requestAiTitle(sessionId: string, firstUser: string, firstAssistant: string) {
  try {
    const prompt =
      `根据以下对话内容，给出一个简洁的标题（最多6个词或字，不加引号和标点）：\n` +
      `用户：${firstUser.slice(0, 150)}\n` +
      `助手：${firstAssistant.slice(0, 200)}`;
    const raw = await invoke<string>('ai_chat', {
      message: prompt,
      context: { history: [] },
    });
    const title = raw.trim().replace(/^["'「『【\s]+|["'」』】\s.]+$/g, '');
    if (title) {
      useAiStore.setState((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? { ...sess, title, titleGenerated: true } : sess
        ),
      }));
    }
  } catch {
    // 静默失败，保留默认标题
  }
}

// ── per-session 运行时状态（不持久化）────────────────────────────────────────
interface SessionRuntimeState {
  isChatting: boolean;
  streamingContent: string;
  streamingThinkingContent: string;
  activeToolName: string | null;
  sessionStatus: string | null;
}

const defaultRuntimeState = (): SessionRuntimeState => ({
  isChatting: false,
  streamingContent: '',
  streamingThinkingContent: '',
  activeToolName: null,
  sessionStatus: null,
});

// ── 类型定义 ──────────────────────────────────────────────────────────────────

interface AiState {
  // ── LLM 配置 ──
  configs: LlmConfig[];
  loadConfigs: () => Promise<void>;
  createConfig: (input: CreateLlmConfigInput) => Promise<void>;
  updateConfig: (id: number, input: UpdateLlmConfigInput) => Promise<void>;
  deleteConfig: (id: number) => Promise<void>;
  setDefaultConfig: (id: number) => Promise<void>;
  testConfig: (id: number) => Promise<void>;

  // ── 多会话管理 ──
  sessions: ChatSession[];
  currentSessionId: string;
  _saveCurrentSession: () => void;
  newSession: () => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => Promise<void>;
  setSessionConfigId: (sessionId: string, configId: number | null) => void;

  // ── 当前对话视图缓存 ──
  chatHistory: ChatMessage[];

  // ── per-session 运行时状态（不持久化）──
  chatStates: Record<string, SessionRuntimeState>;

  // ── 对话操作 ──
  clearHistory: (sessionId: string) => Promise<void>;
  cancelChat: (sessionId: string) => Promise<void>;
  sendAgentChatStream: (message: string, connectionId: number | null) => Promise<void>;

  // ── AI 工具功能（不变）──
  isExplaining: boolean;
  isOptimizing: boolean;
  isDiagnosing: boolean;
  isCreatingTable: boolean;
  error: string | null;
  draftMessage: string;
  setDraftMessage: (msg: string) => void;
  explainSql: (sql: string, connectionId: number) => Promise<string>;
  optimizeSql: (sql: string, connectionId: number) => Promise<string>;
  createTable: (description: string, connectionId: number) => Promise<string>;
  diagnoseError: (sql: string, errorMsg: string, connectionId: number) => Promise<string>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAiStore = create<AiState>()(
  persist(
    (set, get) => ({
      // ── 初始值 ──
      configs: [],
      sessions: [],
      currentSessionId: uuid(),
      chatHistory: [],
      chatStates: {},
      isExplaining: false,
      isOptimizing: false,
      isDiagnosing: false,
      isCreatingTable: false,
      error: null,
      draftMessage: '',

      setSessionConfigId: (sessionId, configId) => {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId ? { ...sess, configId } : sess
          ),
        }));
      },

      // ── LLM 配置 CRUD ──

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

      setDraftMessage: (msg) => set({ draftMessage: msg }),

      // ── 多会话管理 ──

      _saveCurrentSession: () => {
        const { chatHistory, currentSessionId, sessions } = get();
        if (chatHistory.length === 0) return;
        const now = Date.now();
        const existing = sessions.find((s) => s.id === currentSessionId);
        if (existing) {
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === currentSessionId
                ? { ...sess, messages: chatHistory, updatedAt: now }
                : sess
            ),
          }));
        } else {
          const firstUser = chatHistory.find((m) => m.role === 'user')?.content ?? '新对话';
          set((s) => ({
            sessions: [
              {
                id: currentSessionId,
                title: makeDefaultTitle(firstUser),
                messages: chatHistory,
                createdAt: now,
                updatedAt: now,
                titleGenerated: false,
                configId: null,
              },
              ...s.sessions,
            ],
          }));
        }
      },

      newSession: () => {
        get()._saveCurrentSession();
        const newId = uuid();
        set((s) => ({
          currentSessionId: newId,
          chatHistory: [],
          chatStates: {
            ...s.chatStates,
            [newId]: defaultRuntimeState(),
          },
        }));
        // 注意：不再调用 cancel_acp_session，后台 session 继续运行
      },

      switchSession: (id) => {
        get()._saveCurrentSession();
        const target = get().sessions.find((s) => s.id === id);
        if (!target) return;
        set({
          currentSessionId: id,
          chatHistory: target.messages,
          // 注意：不重置 chatStates，后台 channel 继续运行
        });
        // 注意：不再调用 cancel_acp_session
      },

      deleteSession: async (id) => {
        // 若正在流式，先取消（必须 await，确保 commitAssistant 不再触发）
        if (get().chatStates[id]?.isChatting) {
          await get().cancelChat(id);
        }
        // 清理 chatStates
        set((s) => {
          const { [id]: _removed, ...restStates } = s.chatStates;
          return { chatStates: restStates };
        });
        const { currentSessionId, sessions } = get();
        set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }));
        // 若删除的是当前 session，切换到其他会话
        if (id === currentSessionId) {
          const remaining = sessions.filter((s) => s.id !== id);
          if (remaining.length > 0) {
            const next = remaining[0];
            set({ currentSessionId: next.id, chatHistory: next.messages });
          } else {
            const newId = uuid();
            set({ currentSessionId: newId, chatHistory: [] });
          }
        }
      },

      cancelChat: async (sessionId) => {
        const state = get().chatStates[sessionId];
        const streamingContent = state?.streamingContent ?? '';
        const streamingThinkingContent = state?.streamingThinkingContent ?? '';
        const isCurrentSession = get().currentSessionId === sessionId;

        if (streamingContent) {
          const truncatedMsg = {
            role: 'assistant' as const,
            content: streamingContent,
            thinkingContent: streamingThinkingContent || undefined,
          };
          const now = Date.now();
          set((s) => {
            const existing = s.sessions.find((sess) => sess.id === sessionId);
            const updatedMessages = existing
              ? [...existing.messages, truncatedMsg]
              : [...s.chatHistory, truncatedMsg];
            const updatedSessions = existing
              ? s.sessions.map((sess) =>
                  sess.id === sessionId
                    ? { ...sess, messages: updatedMessages, updatedAt: now }
                    : sess
                )
              : [
                  {
                    id: sessionId,
                    title: makeDefaultTitle(
                      updatedMessages.find((m) => m.role === 'user')?.content ?? '新对话'
                    ),
                    messages: updatedMessages,
                    createdAt: now,
                    updatedAt: now,
                    titleGenerated: false,
                    configId: null,
                  },
                  ...s.sessions,
                ];
            return {
              sessions: updatedSessions,
              chatStates: { ...s.chatStates, [sessionId]: defaultRuntimeState() },
              ...(isCurrentSession ? { chatHistory: updatedMessages } : {}),
            };
          });
        } else {
          set((s) => ({
            chatStates: { ...s.chatStates, [sessionId]: defaultRuntimeState() },
          }));
        }

        try {
          await invoke('cancel_acp_session', { sessionId });
        } catch (_) {
          // session 可能已不存在
        }
      },

      clearHistory: async (sessionId) => {
        // 必须 await cancelChat，防止 cancel 完成前 commitAssistant 仍写入
        if (get().chatStates[sessionId]?.isChatting) {
          await get().cancelChat(sessionId);
        }
        const isCurrentSession = get().currentSessionId === sessionId;
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId ? { ...sess, messages: [], updatedAt: Date.now() } : sess
          ),
          chatStates: { ...s.chatStates, [sessionId]: defaultRuntimeState() },
          ...(isCurrentSession ? { chatHistory: [] } : {}),
        }));
      },

      // ── 流式 AI 对话（核心）── [Task 6 中替换此函数体]

      sendAgentChatStream: async (message, connectionId) => {
        const { useQueryStore } = await import('./queryStore');
        const queryStore = useQueryStore.getState();
        const activeTabId = queryStore.activeTabId;
        const tabSql: string | null = activeTabId
          ? queryStore.sqlContent[activeTabId] ?? null
          : null;

        // 捕获发送时的 sessionId
        const sessionId = get().currentSessionId;

        // 从 sessions 读取该 session 的 configId（不从 chatStates 读）
        const configId = get().sessions.find((s) => s.id === sessionId)?.configId ?? null;

        // 并发上限检查
        const activeChatCount = Object.values(get().chatStates).filter((s) => s.isChatting).length;
        if (activeChatCount >= 10) {
          return;
        }

        // 追加用户消息到 chatHistory
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: {
              ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
              isChatting: true,
              streamingContent: '',
              streamingThinkingContent: '',
              activeToolName: null,
              sessionStatus: null,
            },
          },
          chatHistory: [...s.chatHistory, { role: 'user' as const, content: message }],
        }));

        const isFirstRound = get().chatHistory.filter((m) => m.role === 'assistant').length === 0;

        const commitAssistant = (content: string, thinking: string) => {
          // Guard 1: session 已被删除
          if (!get().sessions.find((s) => s.id === sessionId)) return;
          // Guard 2: 已被 cancel
          if (!get().chatStates[sessionId]?.isChatting) return;

          const newMsg = {
            role: 'assistant' as const,
            content,
            thinkingContent: thinking || undefined,
          };
          const now = Date.now();
          const isCurrentSession = get().currentSessionId === sessionId;

          set((s) => {
            const existing = s.sessions.find((sess) => sess.id === sessionId);
            const baseMessages = existing ? existing.messages : s.chatHistory;
            const updatedMessages = [...baseMessages, newMsg];

            const updatedSessions = existing
              ? s.sessions.map((sess) =>
                  sess.id === sessionId
                    ? { ...sess, messages: updatedMessages, updatedAt: now }
                    : sess
                )
              : [
                  {
                    id: sessionId,
                    title: makeDefaultTitle(
                      updatedMessages.find((m) => m.role === 'user')?.content ?? '新对话'
                    ),
                    messages: updatedMessages,
                    createdAt: now,
                    updatedAt: now,
                    titleGenerated: false,
                    configId,
                  },
                  ...s.sessions,
                ];

            return {
              sessions: updatedSessions,
              chatStates: { ...s.chatStates, [sessionId]: defaultRuntimeState() },
              ...(isCurrentSession ? { chatHistory: updatedMessages } : {}),
            };
          });

          if (isFirstRound && content && !content.startsWith('Error:')) {
            requestAiTitle(sessionId, message, content);
          }
        };

        try {
          const { Channel } = await import('@tauri-apps/api/core');
          const channel = new Channel<{
            type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error';
            data?: { delta?: string; message?: string; call_id?: string; name?: string; arguments?: string };
          }>();

          let contentBuf = '';
          let thinkingBuf = '';
          let rafId: number | null = null;

          const flushBuffers = () => {
            rafId = null;
            if (contentBuf) {
              const delta = contentBuf; contentBuf = '';
              set((s) => ({
                chatStates: {
                  ...s.chatStates,
                  [sessionId]: {
                    ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
                    streamingContent: (s.chatStates[sessionId]?.streamingContent ?? '') + delta,
                  },
                },
              }));
            }
            if (thinkingBuf) {
              const delta = thinkingBuf; thinkingBuf = '';
              set((s) => ({
                chatStates: {
                  ...s.chatStates,
                  [sessionId]: {
                    ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
                    streamingThinkingContent: (s.chatStates[sessionId]?.streamingThinkingContent ?? '') + delta,
                  },
                },
              }));
            }
          };

          const scheduleFlush = () => {
            if (!rafId) rafId = requestAnimationFrame(flushBuffers);
          };

          const flushNow = () => {
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; flushBuffers(); }
          };

          const setChatStateField = (fields: Partial<SessionRuntimeState>) => {
            set((s) => ({
              chatStates: {
                ...s.chatStates,
                [sessionId]: { ...(s.chatStates[sessionId] ?? defaultRuntimeState()), ...fields },
              },
            }));
          };

          channel.onmessage = (event) => {
            if (event.type === 'StatusUpdate' && event.data?.message) {
              setChatStateField({ sessionStatus: event.data.message });
            } else if (event.type === 'ThinkingChunk' && event.data?.delta) {
              setChatStateField({ sessionStatus: null });
              thinkingBuf += event.data.delta;
              scheduleFlush();
            } else if (event.type === 'ContentChunk' && event.data?.delta) {
              setChatStateField({ sessionStatus: null });
              contentBuf += event.data.delta;
              scheduleFlush();
            } else if (event.type === 'ToolCallRequest' && event.data?.name) {
              flushNow();
              setChatStateField({ activeToolName: event.data.name, sessionStatus: null });
            } else if (event.type === 'Done') {
              flushNow();
              if (!get().chatStates[sessionId]?.isChatting) return;
              const state = get().chatStates[sessionId];
              commitAssistant(state?.streamingContent ?? '', state?.streamingThinkingContent ?? '');
            } else if (event.type === 'Error') {
              flushNow();
              if (!get().chatStates[sessionId]?.isChatting) return;
              commitAssistant(`Error: ${event.data?.message ?? 'Unknown error'}`, '');
            }
          };

          await invoke('ai_chat_acp', {
            prompt: message,
            tabSql,
            connectionId,
            configId,
            sessionId,
            channel,
          });
        } catch (e) {
          commitAssistant(`Error: ${String(e)}`, '');
        }
      },

      // ── AI 工具功能 ──

      explainSql: async (sql, connectionId) => {
        set({ isExplaining: true, error: null });
        useAppStore.getState().setLastOperationContext({
          type: 'ai_request', connectionId, aiRequestType: 'explain', prompt: sql,
        });
        try {
          return await invoke<string>('ai_explain_sql', { sql, connectionId });
        } catch (e) {
          const status = (e as any)?.status ?? (e as any)?.response?.status;
          if (status) {
            const ctx = useAppStore.getState().lastOperationContext;
            if (ctx) useAppStore.getState().setLastOperationContext({ ...ctx, httpStatus: status });
          }
          set({ error: String(e) });
          throw e;
        } finally {
          set({ isExplaining: false });
        }
      },

      optimizeSql: async (sql, connectionId) => {
        set({ isOptimizing: true, error: null });
        useAppStore.getState().setLastOperationContext({
          type: 'ai_request', connectionId, aiRequestType: 'optimize', prompt: sql,
        });
        try {
          return await invoke<string>('ai_optimize_sql', { sql, connectionId });
        } catch (e) {
          const status = (e as any)?.status ?? (e as any)?.response?.status;
          if (status) {
            const ctx = useAppStore.getState().lastOperationContext;
            if (ctx) useAppStore.getState().setLastOperationContext({ ...ctx, httpStatus: status });
          }
          set({ error: String(e) });
          throw e;
        } finally {
          set({ isOptimizing: false });
        }
      },

      createTable: async (description, connectionId) => {
        set({ isCreatingTable: true, error: null });
        useAppStore.getState().setLastOperationContext({
          type: 'ai_request', connectionId, aiRequestType: 'create_table', prompt: description,
        });
        try {
          return await invoke<string>('ai_create_table', { description, connectionId });
        } catch (e) {
          const status = (e as any)?.status ?? (e as any)?.response?.status;
          if (status) {
            const ctx = useAppStore.getState().lastOperationContext;
            if (ctx) useAppStore.getState().setLastOperationContext({ ...ctx, httpStatus: status });
          }
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
    }),
    {
      name: 'open-db-studio-ai-sessions',
      // 只持久化历史会话列表，其他状态（流式内容、isChatting 等）不持久化
      partialize: (state) => ({ sessions: state.sessions }),
    }
  )
);
