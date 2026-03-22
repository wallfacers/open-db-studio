import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import type { LlmConfig, CreateLlmConfigInput, UpdateLlmConfigInput, ChatMessage, ChatSession, ElicitationRequest, PermissionRequest } from '../types';
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
 * 后台调用 AI 生成会话标题（复用 agent_request_ai_title 命令）。
 * 失败时静默忽略，保留默认标题。
 */
async function requestAiTitle(sessionId: string, firstUser: string, firstAssistant: string) {
  try {
    const prompt =
      `根据以下对话内容，给出一个简洁的标题（最多6个词或字，不加引号和标点）：\n` +
      `用户：${firstUser.slice(0, 150)}\n` +
      `助手：${firstAssistant.slice(0, 200)}`;
    const raw = await invoke<string>('agent_request_ai_title', {
      sessionId,
      context: prompt,
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
  pendingElicitation: ElicitationRequest | null;       // 文字检测路径
  pendingPermission: PermissionRequest | null;          // permission 路径（isChatting=true）
  streamingElicitationFired: boolean;                   // P0：mid-stream 已触发，防重复
  pendingConfigId: number | null;                       // 切换模型时暂存（session 尚未进入 sessions 列表）
  lastUserMessageId: string | null;                     // OpenCode message ID，undo 用
  canRedo: boolean;                                     // redo 可用标志
  isCompacting: boolean;                                // compact 执行中（防重复触发）
}

const defaultRuntimeState = (): SessionRuntimeState => ({
  isChatting: false,
  streamingContent: '',
  streamingThinkingContent: '',
  activeToolName: null,
  sessionStatus: null,
  pendingElicitation: null,
  pendingPermission: null,
  streamingElicitationFired: false,
  pendingConfigId: null,
  lastUserMessageId: null,
  canRedo: false,
  isCompacting: false,
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
  newSession: () => Promise<void>;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => Promise<void>;
  /** 删除所有会话并重置为新会话 */
  deleteAllSessions: () => void;
  setSessionConfigId: (sessionId: string, configId: number | null) => void;

  // ── AI 助手连接绑定（null = 跟随活跃标签页）──
  linkedConnectionId: number | null;
  setLinkedConnectionId: (id: number | null) => void;

  // ── 当前对话视图缓存 ──
  chatHistory: ChatMessage[];

  // ── per-session 运行时状态（不持久化）──
  chatStates: Record<string, SessionRuntimeState>;

  // ── 对话操作 ──
  loadSessions: () => Promise<void>;
  loadSessionMessages: (sessionId: string) => Promise<void>;
  clearHistory: (sessionId: string) => Promise<void>;
  cancelChat: (sessionId: string) => Promise<void>;
  undoMessage: (sessionId: string) => Promise<void>;
  redoMessage: (sessionId: string) => Promise<void>;
  compactSession: (sessionId: string, modelId: string, providerId: string) => Promise<void>;
  respondPermission: (sessionId: string, permissionId: string, selectedOptionId: string, cancelled: boolean) => Promise<void>;
  respondElicitation: (sessionId: string, selectedText: string) => Promise<void>;
  clearElicitation: (sessionId: string) => void;
  sendAgentChatStream: (message: string, connectionId: number | null) => Promise<void>;

  // ── AI 功能 ──
  isExplaining: Record<string, boolean>;
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
      isExplaining: {},
      isDiagnosing: false,
      isCreatingTable: false,
      error: null,
      draftMessage: '',
      linkedConnectionId: null,

      setLinkedConnectionId: (id) => set({ linkedConnectionId: id }),

      setSessionConfigId: (sessionId, configId) => {
        set((s) => {
          const existsInSessions = s.sessions.some((sess) => sess.id === sessionId);
          return {
            // 若已在 sessions 中，更新持久化字段
            sessions: existsInSessions
              ? s.sessions.map((sess) =>
                  sess.id === sessionId ? { ...sess, configId } : sess
                )
              : s.sessions,
            // 同时写入 chatStates，用于尚未进入 sessions 的新 session
            chatStates: {
              ...s.chatStates,
              [sessionId]: {
                ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
                pendingConfigId: configId,
              },
            },
          };
        });
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

      newSession: async () => {
        get()._saveCurrentSession();
        // 从服务端获取 session_id，失败则 fallback 到本地 uuid()
        let newId: string;
        try {
          newId = await invoke<string>('agent_create_session', {});
        } catch {
          newId = uuid();
        }
        set((s) => ({
          currentSessionId: newId,
          chatHistory: [],
          chatStates: {
            ...s.chatStates,
            [newId]: defaultRuntimeState(),
          },
        }));
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
        // 若消息未加载（空数组），从 OpenCode API 懒加载
        if (target.messages.length === 0) {
          get().loadSessionMessages(id).catch(() => {});
        }
      },

      deleteSession: async (id) => {
        // 若正在流式，先取消（必须 await，确保 commitAssistant 不再触发）
        if (get().chatStates[id]?.isChatting) {
          await get().cancelChat(id);
        }
        // 通知服务端删除 session（不阻塞 UI）
        invoke('agent_delete_session', { sessionId: id }).catch(() => {});
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
            const newId = await invoke<string>('agent_create_session', {}).catch(() => uuid());
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
          await invoke('agent_cancel_session', { sessionId });
        } catch (_) {
          // session 可能已不存在
        }
      },

      respondPermission: async (sessionId, permissionId, selectedOptionId, cancelled) => {
        // 立即清空（UI 响应优先，不等待 Rust 确认）
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: { ...s.chatStates[sessionId], pendingPermission: null },
          },
        }));
        try {
          await invoke('agent_permission_respond', {
            sessionId,
            permissionId,
            response: selectedOptionId,
            remember: !cancelled,
          });
        } catch (e) {
          console.error('[permission] agent_permission_respond failed:', e);
        }
      },

      respondElicitation: async (sessionId, selectedText) => {
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: { ...s.chatStates[sessionId], pendingElicitation: null },
          },
        }));
        // activeConnectionId 在 connectionStore，不在 aiStore
        const { useConnectionStore } = await import('./connectionStore');
        const connectionId = useConnectionStore.getState().activeConnectionId;
        await get().sendAgentChatStream(selectedText, connectionId);
      },

      clearElicitation: (sessionId) => {
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: { ...s.chatStates[sessionId], pendingElicitation: null },
          },
        }));
      },

      deleteAllSessions: () => {
        set({
          sessions: [],
          chatHistory: [],
          chatStates: {},
          currentSessionId: uuid(), // 临时占位，下方异步替换为服务端 ID
        });
        // 删除所有后台 session，然后创建新 session（尽力，不阻塞）
        invoke('agent_delete_all_sessions')
          .catch(() => {})
          .then(() => invoke<string>('agent_create_session', {}))
          .then((newId) => set({ currentSessionId: newId as string }))
          .catch(() => {});
      },

      loadSessions: async () => {
        try {
          const records = await invoke<Array<{
            id: string;
            title: string | null;
            config_id: number | null;
            created_at: string;
            updated_at: string;
          }>>('agent_list_sessions');

          if (records.length === 0) {
            // 没有历史会话，创建新 session
            await get().newSession();
            return;
          }

          const chatSessions: ChatSession[] = records.map((r) => ({
            id: r.id,
            title: r.title ?? '新对话',
            messages: [],
            createdAt: new Date(r.created_at).getTime() || Date.now(),
            updatedAt: new Date(r.updated_at).getTime() || Date.now(),
            titleGenerated: !!r.title,
            configId: r.config_id ?? null,
          }));

          // 取最近更新的 session 作为当前 session
          const mostRecent = chatSessions.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));

          set((s) => ({
            sessions: chatSessions,
            currentSessionId: mostRecent.id,
            chatHistory: [],
            chatStates: {
              ...s.chatStates,
              [mostRecent.id]: s.chatStates[mostRecent.id] ?? defaultRuntimeState(),
            },
          }));

          // 懒加载当前 session 的历史消息
          await get().loadSessionMessages(mostRecent.id);
        } catch (e) {
          console.warn('[loadSessions] Failed, creating new session:', e);
          try {
            await get().newSession();
          } catch {
            // fallback: 保持空状态
          }
        }
      },

      loadSessionMessages: async (sessionId: string) => {
        try {
          const messages = await invoke<Array<{
            role: string;
            content: string;
            thinking_content: string | null;
          }>>('agent_get_session_messages', { sessionId });

          const chatMessages: ChatMessage[] = messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
              ...(m.thinking_content ? { thinkingContent: m.thinking_content } : {}),
            }));

          const isCurrentSession = get().currentSessionId === sessionId;
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId ? { ...sess, messages: chatMessages } : sess
            ),
            ...(isCurrentSession ? { chatHistory: chatMessages } : {}),
          }));
        } catch (e) {
          // 静默忽略：session 可能尚无消息
          console.debug('[loadSessionMessages] No messages or error:', e);
        }
      },

      clearHistory: async (sessionId) => {
        // 必须 await cancelChat，防止 cancel 完成前 commitAssistant 仍写入
        if (get().chatStates[sessionId]?.isChatting) {
          await get().cancelChat(sessionId);
        }
        // 通过服务端清空 session 历史，获取新 session_id
        try {
          const newSessionId = await invoke<string>('agent_clear_session_history', { sessionId });
          const isCurrentSession = get().currentSessionId === sessionId;
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId
                ? { ...sess, id: newSessionId, messages: [], updatedAt: Date.now() }
                : sess
            ),
            chatStates: {
              ...s.chatStates,
              [newSessionId]: defaultRuntimeState(),
            },
            ...(isCurrentSession ? { currentSessionId: newSessionId, chatHistory: [] } : {}),
          }));
          // 删除旧 session 的 chatState（如果 id 确实改变了）
          if (newSessionId !== sessionId) {
            set((s) => {
              const { [sessionId]: _removed, ...restStates } = s.chatStates;
              return { chatStates: restStates };
            });
          }
        } catch {
          // 失败则仅清空本地状态
          const isCurrentSession = get().currentSessionId === sessionId;
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId ? { ...sess, messages: [], updatedAt: Date.now() } : sess
            ),
            chatStates: { ...s.chatStates, [sessionId]: defaultRuntimeState() },
            ...(isCurrentSession ? { chatHistory: [] } : {}),
          }));
        }
      },

      undoMessage: async (sessionId) => {
        const state = get().chatStates[sessionId];
        const messageId = state?.lastUserMessageId;
        if (!messageId) return;
        await invoke('agent_revert_message', { sessionId, messageId });
        // 从 chatHistory 移除最后一条 assistant 消息和最后一条 user 消息
        const history = [...(sessionId === get().currentSessionId ? get().chatHistory : (get().sessions.find(s => s.id === sessionId)?.messages ?? []))];
        const lastAssistantIdx = [...history].map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'assistant').at(-1)?.i ?? -1;
        if (lastAssistantIdx >= 0) history.splice(lastAssistantIdx, 1);
        const lastUserIdx = [...history].map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'user').at(-1)?.i ?? -1;
        if (lastUserIdx >= 0) history.splice(lastUserIdx, 1);
        const isCurrentSession = get().currentSessionId === sessionId;
        const now = Date.now();
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId ? { ...sess, messages: history, updatedAt: now } : sess
          ),
          chatStates: {
            ...s.chatStates,
            [sessionId]: { ...(s.chatStates[sessionId] ?? defaultRuntimeState()), canRedo: true, lastUserMessageId: null },
          },
          ...(isCurrentSession ? { chatHistory: history } : {}),
        }));
      },

      redoMessage: async (sessionId) => {
        const state = get().chatStates[sessionId];
        if (!state?.canRedo) return;
        await invoke('agent_unrevert_message', { sessionId });
        // 重新拉取消息列表以服务端为准
        await get().loadSessionMessages(sessionId);
        // 获取最新 lastUserMessageId
        const lastId = await invoke<string>('agent_get_last_user_message_id', { sessionId }).catch(() => null);
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: {
              ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
              canRedo: false,
              lastUserMessageId: lastId ?? null,
            },
          },
        }));
      },

      compactSession: async (sessionId, modelId, providerId) => {
        const state = get().chatStates[sessionId];
        if (state?.isCompacting) return;
        set((s) => ({
          chatStates: {
            ...s.chatStates,
            [sessionId]: { ...(s.chatStates[sessionId] ?? defaultRuntimeState()), isCompacting: true },
          },
        }));
        try {
          await invoke('agent_summarize_session', { sessionId, modelId, providerId });
          await get().loadSessionMessages(sessionId);
          set((s) => ({
            chatStates: {
              ...s.chatStates,
              [sessionId]: {
                ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
                isCompacting: false,
                canRedo: false,
                lastUserMessageId: null,
              },
            },
          }));
        } catch (e) {
          set((s) => ({
            chatStates: {
              ...s.chatStates,
              [sessionId]: { ...(s.chatStates[sessionId] ?? defaultRuntimeState()), isCompacting: false },
            },
          }));
          throw e;
        }
      },

      // ── 流式 AI 对话（核心）──

      sendAgentChatStream: async (message, connectionId) => {
        // 预导入检测器（commitAssistant 和 flushBuffers 均需要，必须在两者定义之前）
        const { detectElicitation, isLikelyComplete } = await import('../utils/elicitationDetector');

        const { useQueryStore } = await import('./queryStore');
        const queryStore = useQueryStore.getState();
        const activeTabId = queryStore.activeTabId;
        const tabSql: string | null = activeTabId
          ? queryStore.sqlContent[activeTabId] ?? null
          : null;

        // 捕获发送时的 sessionId；若不是有效的 opencode session（需以 'ses' 开头）则先创建
        let sessionId = get().currentSessionId;

        // 必须在 sessionId 替换之前读取 configId（pendingConfigId 存在旧 UUID 下）
        const configId =
          get().chatStates[sessionId]?.pendingConfigId ??
          get().sessions.find((s) => s.id === sessionId)?.configId ??
          null;

        if (!sessionId.startsWith('ses')) {
          try {
            sessionId = await invoke<string>('agent_create_session', {});
            set({ currentSessionId: sessionId });
          } catch (_) {
            // 创建失败继续执行，downstream 会报错
          }
        }

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

        const commitAssistant = async (content: string, thinking: string) => {
          // Guard: 已被 cancel 或 session 已被删除（deleteSession 会同时清除 chatStates）
          if (!get().chatStates[sessionId]?.isChatting) return;

          // turn 结束时始终对完整内容重新检测，确保 mid-stream 提前触发时不会丢失后续选项
          const detected = detectElicitation(content, sessionId) ?? null;

          const newMsg = {
            role: 'assistant' as const,
            content,
            thinkingContent: thinking || undefined,
          };
          const now = Date.now();
          const isCurrentSession = get().currentSessionId === sessionId;

          set((s) => {
            const existing = s.sessions.find((sess) => sess.id === sessionId);
            // 当前 session 用 chatHistory（已含最新用户消息），后台 session 用 sessions 快照
            const baseMessages = existing && sessionId !== s.currentSessionId
              ? existing.messages
              : s.chatHistory;
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
              chatStates: {
                ...s.chatStates,
                [sessionId]: {
                  ...defaultRuntimeState(),
                  pendingElicitation: detected ?? null,  // 与 isChatting=false 同步写入，无竞态
                },
              },
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
            type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'StatusUpdate' | 'Done' | 'Error' | 'PermissionRequest';
            data?: {
              delta?: string;
              message?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
              // PermissionRequest 字段
              permission_id?: string;
              options?: Array<{ option_id: string; label: string; kind: string }>;
            };
          }>();

          let contentBuf = '';
          let thinkingBuf = '';
          let rafId: number | null = null;

          const flushBuffers = () => {
            rafId = null;
            if (contentBuf) {
              const delta = contentBuf; contentBuf = '';
              const currentState = get().chatStates[sessionId] ?? defaultRuntimeState();
              const newContent = (currentState.streamingContent ?? '') + delta;

              // P0：mid-stream 检测——当新增内容含换行且尚未触发过
              if (!currentState.streamingElicitationFired && delta.includes('\n') && isLikelyComplete(newContent)) {
                const detected = detectElicitation(newContent, sessionId);
                if (detected) {
                  set((s) => ({
                    chatStates: {
                      ...s.chatStates,
                      [sessionId]: {
                        ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
                        streamingContent: newContent,
                        pendingElicitation: detected,
                        streamingElicitationFired: true,
                      },
                    },
                  }));
                  return;
                }
              }

              set((s) => ({
                chatStates: {
                  ...s.chatStates,
                  [sessionId]: {
                    ...(s.chatStates[sessionId] ?? defaultRuntimeState()),
                    streamingContent: newContent,
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

          channel.onmessage = async (event) => {
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
            } else if (event.type === 'PermissionRequest' && event.data?.permission_id) {
              // PermissionRequest 在 isChatting=true 时到达（agent 暂停等待响应）
              setChatStateField({
                pendingPermission: {
                  id: event.data.permission_id,
                  sessionId,
                  source: 'acp' as const,
                  message: event.data.message ?? '工具执行确认',
                  options: (event.data.options ?? []).map((o) => ({
                    option_id: o.option_id,
                    label: o.label,
                    kind: o.kind as 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'deny',
                  })),
                },
              });
            } else if (event.type === 'Done') {
              flushNow();
              if (!get().chatStates[sessionId]?.isChatting) return;
              // 清空任何未完成的 pendingPermission（abort 场景兜底）
              setChatStateField({ pendingPermission: null });
              const state = get().chatStates[sessionId];
              const content = state?.streamingContent ?? '';
              // 如果内容为空，说明 opencode/provider 未能返回任何内容，给出提示
              const finalContent = content || 'AI 未返回内容，请检查 LLM 配置（供应商、模型、API Key）是否正确。';
              await commitAssistant(finalContent, state?.streamingThinkingContent ?? '');
              // 后台拉取 lastUserMessageId（静默失败，不影响主流程）
              invoke<string>('agent_get_last_user_message_id', { sessionId })
                .then(id => setChatStateField({ lastUserMessageId: id, canRedo: false }))
                .catch(() => {});
            } else if (event.type === 'Error') {
              flushNow();
              if (!get().chatStates[sessionId]?.isChatting) return;
              // 清空任何未完成的 pendingPermission（abort 场景兜底）
              setChatStateField({ pendingPermission: null });
              await commitAssistant(`Error: ${event.data?.message ?? 'Unknown error'}`, '');
            }
          };

          await invoke('agent_chat', {
            prompt: message,
            tabSql,
            connectionId,
            configId,
            sessionId,
            channel,
          });
        } catch (e) {
          await commitAssistant(`Error: ${String(e)}`, '');
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

          await invoke('agent_explain_sql', {
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
        await invoke('cancel_explain_sql').catch(() => {});
        set(s => ({ isExplaining: { ...s.isExplaining, [tabId]: false } }));
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
      // 只持久化 linkedConnectionId，sessions 以服务端为准不再本地持久化
      partialize: (state) => ({ linkedConnectionId: state.linkedConnectionId }),
    }
  )
);
