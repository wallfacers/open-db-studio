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

  activeConfigId: number | null;
  setActiveConfigId: (id: number | null) => void;

  // ── 多会话管理（sessions 持久化到 localStorage）──
  sessions: ChatSession[];          // 历史会话列表（持久化）
  currentSessionId: string;         // 当前会话 ID（不持久化，每次启动新建）

  /** 保存当前 chatHistory 到 sessions（有消息才保存），不切换会话 */
  _saveCurrentSession: () => void;
  /** 新建会话：将当前对话存档后开启空白会话 */
  newSession: () => void;
  /** 切换到历史会话 */
  switchSession: (id: string) => void;
  /** 删除指定会话 */
  deleteSession: (id: string) => void;
  /** 删除所有会话并重置为新会话 */
  deleteAllSessions: () => void;

  // ── 当前对话 ──
  chatHistory: ChatMessage[];
  streamingContent: string;
  streamingThinkingContent: string;
  isChatting: boolean;
  activeToolName: string | null;
  sessionStatus: string | null;

  /** 清空当前对话（不保存到历史，直接丢弃） */
  clearHistory: () => void;
  cancelChat: () => Promise<void>;
  sendAgentChatStream: (message: string, connectionId: number | null) => Promise<void>;

  // ── AI 功能 ──
  isExplaining: Record<string, boolean>;
  isOptimizing: Record<string, boolean>;
  isDiagnosing: boolean;
  isCreatingTable: boolean;
  error: string | null;
  draftMessage: string;
  setDraftMessage: (msg: string) => void;
  explainSql: (
    sql: string,
    connectionId: number | null,
    database: string | null | undefined,
    tabId: string,
    onDelta: (delta: string) => void,
    onDone: () => void,
    onError: (err: string) => void,
  ) => Promise<void>;
  cancelExplainSql: (tabId: string) => Promise<void>;
  optimizeSql: (sql: string, connectionId: number | null, database: string | null | undefined, tabId: string) => Promise<string>;
  cancelOptimizeSql: (tabId: string) => Promise<void>;
  createTable: (description: string, connectionId: number) => Promise<string>;
  diagnoseError: (sql: string, errorMsg: string, connectionId: number) => Promise<string>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAiStore = create<AiState>()(
  persist(
    (set, get) => ({
      // ── 初始值 ──
      configs: [],
      activeConfigId: null,
      sessions: [],
      currentSessionId: uuid(),   // 每次启动自动生成新 ID（不持久化）
      chatHistory: [],
      streamingContent: '',
      streamingThinkingContent: '',
      isChatting: false,
      activeToolName: null,
      sessionStatus: null,
      isExplaining: {},
      isOptimizing: {},
      isDiagnosing: false,
      isCreatingTable: false,
      error: null,
      draftMessage: '',

      setActiveConfigId: (id) => set({ activeConfigId: id }),

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
        set((s) => ({ activeConfigId: s.activeConfigId === id ? null : s.activeConfigId }));
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
              },
              ...s.sessions,
            ],
          }));
        }
      },

      newSession: () => {
        // 先存档当前会话
        get()._saveCurrentSession();
        // 创建新会话
        const newId = uuid();
        set({
          currentSessionId: newId,
          chatHistory: [],
          streamingContent: '',
          streamingThinkingContent: '',
        });
        invoke('cancel_acp_session').catch(() => {});
      },

      switchSession: (id) => {
        // 存档当前
        get()._saveCurrentSession();
        // 加载目标会话
        const target = get().sessions.find((s) => s.id === id);
        if (!target) return;
        set({
          currentSessionId: id,
          chatHistory: target.messages,
          streamingContent: '',
          streamingThinkingContent: '',
          isChatting: false,
        });
        invoke('cancel_acp_session').catch(() => {});
      },

      deleteSession: (id) => {
        const { currentSessionId, sessions } = get();
        set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }));
        // 删除的是当前会话时，新建一个空会话
        if (id === currentSessionId) {
          const remaining = sessions.filter((s) => s.id !== id);
          if (remaining.length > 0) {
            const next = remaining[0];
            set({ currentSessionId: next.id, chatHistory: next.messages });
          } else {
            set({ currentSessionId: uuid(), chatHistory: [] });
          }
          invoke('cancel_acp_session').catch(() => {});
        }
      },

      // ── 清空当前对话（不存档，直接丢弃，同时从 sessions 中移除）──

      clearHistory: () => {
        const { currentSessionId } = get();
        set((s) => ({
          chatHistory: [],
          streamingContent: '',
          streamingThinkingContent: '',
          currentSessionId: uuid(),
          sessions: s.sessions.filter((sess) => sess.id !== currentSessionId),
        }));
        invoke('cancel_acp_session').catch(() => {});
      },

      deleteAllSessions: () => {
        set({
          sessions: [],
          chatHistory: [],
          streamingContent: '',
          streamingThinkingContent: '',
          currentSessionId: uuid(),
          isChatting: false,
          activeToolName: null,
          sessionStatus: null,
        });
        invoke('cancel_acp_session').catch(() => {});
      },

      // ── 停止生成 ──

      cancelChat: async () => {
        const { streamingContent, streamingThinkingContent } = get();
        set((s) => ({
          chatHistory: streamingContent
            ? [
                ...s.chatHistory,
                {
                  role: 'assistant' as const,
                  content: streamingContent,
                  thinkingContent: streamingThinkingContent || undefined,
                },
              ]
            : s.chatHistory,
          streamingContent: '',
          streamingThinkingContent: '',
          isChatting: false,
          activeToolName: null,
          sessionStatus: null,
        }));
        try {
          await invoke('cancel_acp_session');
        } catch (_) { /* session 可能已不存在 */ }
      },

      // ── 流式 AI 对话（核心）──

      sendAgentChatStream: async (message, connectionId) => {
        const { useQueryStore } = await import('./queryStore');
        const queryStore = useQueryStore.getState();
        const activeTabId = queryStore.activeTabId;
        const tabSql: string | null = activeTabId
          ? queryStore.sqlContent[activeTabId] ?? null
          : null;

        // 追加用户消息
        set((s) => ({
          isChatting: true,
          streamingContent: '',
          streamingThinkingContent: '',
          chatHistory: [...s.chatHistory, { role: 'user' as const, content: message }],
        }));

        // 记录是否是本次会话的第一轮对话（用于触发 AI 标题生成）
        const isFirstRound = get().chatHistory.filter((m) => m.role === 'assistant').length === 0;

        const commitAssistant = (content: string, thinking: string) => {
          set((s) => ({
            chatHistory: [
              ...s.chatHistory,
              { role: 'assistant' as const, content, thinkingContent: thinking || undefined },
            ],
            streamingContent: '',
            streamingThinkingContent: '',
            isChatting: false,
            activeToolName: null,
            sessionStatus: null,
          }));

          // 每次 AI 回复后自动保存会话快照
          const { chatHistory, currentSessionId, sessions } = get();
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
                },
                ...s.sessions,
              ],
            }));
          }

          // 第一轮对话完成后，后台生成 AI 标题
          if (isFirstRound && content && !content.startsWith('Error:')) {
            requestAiTitle(get().currentSessionId, message, content);
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
              if (!get().isChatting) return;
              const { streamingContent, streamingThinkingContent } = get();
              commitAssistant(streamingContent, streamingThinkingContent);
            } else if (event.type === 'Error') {
              flushNow();
              if (!get().isChatting) return;
              commitAssistant(`Error: ${event.data?.message ?? 'Unknown error'}`, '');
            }
          };

          const configId = get().activeConfigId;
          await invoke('ai_chat_acp', {
            prompt: message,
            tabSql,
            connectionId,
            configId,
            channel,
          });
        } catch (e) {
          commitAssistant(`Error: ${String(e)}`, '');
        }
      },

      // ── AI 工具功能 ──

      explainSql: async (sql, connectionId, database, tabId, onDelta, onDone, onError) => {
        set(s => ({ isExplaining: { ...s.isExplaining, [tabId]: true }, error: null }));
        try {
          const { Channel } = await import('@tauri-apps/api/core');
          const channel = new Channel<{
            type: 'ContentChunk' | 'ThinkingChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error';
            data?: { delta?: string; message?: string };
          }>();

          channel.onmessage = (event) => {
            // 已取消则忽略后续所有事件
            if (!get().isExplaining[tabId]) return;
            if (event.type === 'ContentChunk' && event.data?.delta) {
              onDelta(event.data.delta);
            } else if (event.type === 'Done') {
              set(s => ({ isExplaining: { ...s.isExplaining, [tabId]: false } }));
              onDone();
            } else if (event.type === 'Error') {
              set(s => ({ isExplaining: { ...s.isExplaining, [tabId]: false }, error: event.data?.message ?? 'Unknown error' }));
              onError(event.data?.message ?? 'Unknown error');
            }
          };

          await invoke('ai_explain_sql_acp', {
            sql,
            connectionId,
            database: database ?? null,
            channel,
          });
        } catch (e) {
          set(s => ({ isExplaining: { ...s.isExplaining, [tabId]: false } }));
          // 用户主动取消时 backend 会 drop done_tx，产生特定错误信息，静默处理不弹 toast
          const isCancelledError = String(e).includes('thread dropped') || String(e).includes('cancelled');
          if (!isCancelledError) {
            set(s => ({ ...s, error: String(e) }));
            onError(String(e));
          }
        }
      },

      cancelExplainSql: async (tabId) => {
        await invoke('cancel_explain_acp_session').catch(() => {});
        set(s => ({ isExplaining: { ...s.isExplaining, [tabId]: false } }));
      },

      optimizeSql: async (sql, connectionId, database, tabId) => {
        set(s => ({ isOptimizing: { ...s.isOptimizing, [tabId]: true }, error: null }));
        return new Promise<string>(async (resolve, reject) => {
          try {
            const { Channel } = await import('@tauri-apps/api/core');
            const channel = new Channel<{
              type: 'ContentChunk' | 'ThinkingChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error';
              data?: { delta?: string; message?: string };
            }>();

            let resultBuf = '';

            channel.onmessage = (event) => {
              // 已取消则忽略后续所有事件
              if (!get().isOptimizing[tabId]) return;
              if (event.type === 'ContentChunk' && event.data?.delta) {
                resultBuf += event.data.delta;
              } else if (event.type === 'Done') {
                set(s => ({ isOptimizing: { ...s.isOptimizing, [tabId]: false } }));
                resolve(resultBuf.trim());
              } else if (event.type === 'Error') {
                set(s => ({ isOptimizing: { ...s.isOptimizing, [tabId]: false }, error: event.data?.message ?? 'Unknown error' }));
                reject(new Error(event.data?.message ?? 'Unknown error'));
              }
            };

            await invoke('ai_optimize_sql', {
              sql,
              connectionId,
              database: database ?? null,
              channel,
            });
          } catch (e) {
            set(s => ({ isOptimizing: { ...s.isOptimizing, [tabId]: false } }));
            // 用户主动取消时 backend 会 drop done_tx，产生特定错误信息，静默处理不弹 toast
            const isCancelledError = String(e).includes('thread dropped') || String(e).includes('cancelled');
            if (!isCancelledError) {
              set(s => ({ ...s, error: String(e) }));
              reject(e);
            }
          }
        });
      },

      cancelOptimizeSql: async (tabId) => {
        await invoke('cancel_optimize_acp_session').catch(() => {});
        set(s => ({ isOptimizing: { ...s.isOptimizing, [tabId]: false } }));
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
