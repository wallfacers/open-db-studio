import React, { useRef, useEffect, useState, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { createPortal } from 'react-dom';
import { Plus, History, X, DatabaseZap, ChevronDown, Send, Trash2, Copy, Check, Square, ChevronLeft, MessageSquare, RefreshCw, Pencil, Clock } from 'lucide-react';
import { ThinkingBlock } from './ThinkingBlock';
import { MarkdownContent } from '../shared/MarkdownContent';
import { PatchConfirmPanel } from './PatchConfirmPanel';
import { PermissionDock, QuestionDock } from './ElicitationPanel';
import { SlashCommandMenu } from './SlashCommandMenu';
import { ProgressIndicator } from './ProgressIndicator';
import { ToolCallCard } from './ToolCallCard';
import { ChatConnectionProvider } from './ChatConnectionContext';
import { SchemaAutocomplete } from './SchemaAutocomplete';
import { QueryHistoryPicker } from './QueryHistoryPicker';
import type { SchemaSuggestion } from '../../hooks/useSchemaCompletions';
import { useAiStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { useConnectionStore } from '../../store/connectionStore';
import { useQueryStore } from '../../store/queryStore';
import { useAppStore } from '../../store/appStore';
import { useConfirmStore } from '../../store/confirmStore';
import { Tooltip } from '../common/Tooltip';
import { usePacedValue } from '../../hooks/usePacedValue';
import { mergeReasoningForDisplay } from '../../utils/messageAdapter';
import type { ToastLevel } from '../Toast';

const EMPTY_PARTS: import('../../types').MessagePart[] = [];

const formatElapsed = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((ms % 1000) / 100);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}.${tenths}s`;
};

// ── 历史消息（memo 隔离：chatHistory 不变时完全不重渲染）────────────────────
const AssistantMessage: React.FC<{ content: string; thinkingContent?: string; parts?: import('../../types').MessagePart[] }> = memo(
  ({ content, thinkingContent, parts }) => {
    // 优先使用 parts 渲染（Part-based），否则使用 flat 字段（向后兼容）
    if (parts && parts.length > 0) {
      const displayParts = mergeReasoningForDisplay(parts);
      return (
        <div className="flex flex-col items-start">
          <div className="text-foreground-default text-[13px] w-full">
            {displayParts.map((part, i) => {
              switch (part.type) {
                case 'reasoning':
                  return <ThinkingBlock key={i} content={part.content} isStreaming={false} />;
                case 'text':
                  return <MarkdownContent key={i} content={part.content} />;
                case 'tool-use':
                  return <ToolCallCard key={i} toolUse={part} />;
                case 'tool-result':
                  return null; // tool-result 被 ToolCallCard 内联处理
                default:
                  return null;
              }
            })}
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-start">
        <div className="text-foreground-default text-[13px] w-full">
          {thinkingContent && (
            <ThinkingBlock content={thinkingContent} isStreaming={false} />
          )}
          <MarkdownContent content={content} />
        </div>
      </div>
    );
  }
);

// ── 等待第一个 Token 的弹跳动画（复用 ai-dot 样式，与 sessionStatus 视觉一致）────
const TypingIndicator: React.FC = () => {
  const { t } = useTranslation();
  const [msgIdx, setMsgIdx] = useState(0);
  const messages = [
    t('assistant.waitMsg0'),
    t('assistant.waitMsg1'),
    t('assistant.waitMsg2'),
  ];

  useEffect(() => {
    const id = setInterval(() => setMsgIdx((i) => (i + 1) % messages.length), 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2 py-1">
      <span className="ai-dot w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
      <span className="text-xs text-foreground-muted animate-pulse">{messages[msgIdx]}</span>
    </div>
  );
};

// ── 流式消息（独立组件，用 Zustand selector 精准订阅，不影响历史消息）────────
const StreamingMessage: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const content = useAiStore((s) => s.chatStates[sessionId]?.streamingContent ?? '');
  const thinking = useAiStore((s) => s.chatStates[sessionId]?.streamingThinkingContent ?? '');
  const streamingParts = useAiStore((s) => s.chatStates[sessionId]?.streamingParts ?? EMPTY_PARTS);
  const sessionStatus = useAiStore((s) => s.chatStates[sessionId]?.sessionStatus ?? null);
  const pendingQuestion = useAiStore((s) => s.chatStates[sessionId]?.pendingQuestion ?? null);
  const isChatting = useAiStore((s) => s.chatStates[sessionId]?.isChatting ?? false);
  const toolSteps = useAiStore((s) => s.chatStates[sessionId]?.toolSteps ?? []);
  const { t } = useTranslation();

  // PacedMarkdown：流式时节奏释放文本，非流式立即 snap
  const pacedContent = usePacedValue(content, isChatting && !pendingQuestion);

  // 已收到任何内容（包含深度思考）则不再显示等待动画
  const hasFirstToken = !!(content || thinking || streamingParts.length > 0);

  // 合并多个 reasoning 为单个思考块显示
  const displayParts = useMemo(() => mergeReasoningForDisplay(streamingParts), [streamingParts]);
  const hasParts = streamingParts.length > 0;
  // 判断 AI 当前是否在思考阶段（用原始 parts 判断，因为合并后只有一个 reasoning）
  const isCurrentlyThinking = isChatting && streamingParts.length > 0 && streamingParts[streamingParts.length - 1].type === 'reasoning';

  return (
    <div className="flex flex-col items-start">
      <div className="text-foreground-default text-[13px] w-full">
        {hasParts ? (
          displayParts.map((part, i) => {
            switch (part.type) {
              case 'reasoning':
                // 只有最后一个 reasoning 块才可能处于流式状态，前面的已完成
                const isLastPart = i === displayParts.length - 1;
                return <ThinkingBlock key={i} content={part.content} isStreaming={isCurrentlyThinking && isLastPart} />;
              case 'text':
                return <MarkdownContent key={i} content={part.content} isStreaming={isChatting && !pendingQuestion} />;
              default:
                return null;
            }
          })
        ) : (
          <>
            {/* 向后兼容：parts 尚未构建时走旧路径 */}
            {thinking && <ThinkingBlock content={thinking} isStreaming={isChatting} />}
            {pacedContent && <MarkdownContent content={pacedContent} isStreaming={!pendingQuestion} />}
          </>
        )}
        {/* 工具调用进度指示器 */}
        {toolSteps.length > 0 && <ProgressIndicator steps={toolSteps} />}
        {pendingQuestion ? (
          <div className="mt-2 space-y-1">
            {/* 从 questions 字段提取问题文本展示 */}
            {Array.isArray(pendingQuestion.questions) && pendingQuestion.questions.length > 0 && (
              pendingQuestion.questions.map((q, qi) => (
                <div key={qi} className="text-[13px] leading-relaxed">
                  {q.header && <div className="font-medium text-accent">{q.header}</div>}
                  {q.question && <div className="text-foreground-default">{q.question}</div>}
                  {Array.isArray(q.options) && q.options.length > 0 && (
                    <div className="mt-1 space-y-0.5 text-xs text-foreground-default">
                      {q.options.map((opt, oi) => (
                        <div key={oi}>• {opt.label}{opt.description ? ` — ${opt.description}` : ''}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
            <div className="flex items-center gap-2 py-1">
              <span className="ai-dot w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
              <span className="text-xs text-accent animate-pulse">{t('assistant.waitingForAnswer')}</span>
            </div>
          </div>
        ) : !hasFirstToken && (
          sessionStatus ? (
            <div className="flex items-center gap-2 py-1">
              <span className="ai-dot w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
              <span className="text-xs text-foreground-muted animate-pulse">{sessionStatus}</span>
            </div>
          ) : (
            <TypingIndicator />
          )
        )}
      </div>
    </div>
  );
};

// ── 主面板 ──────────────────────────────────────────────────────────────────
interface AssistantProps {
  assistantWidth: number;
  handleAssistantResize: (e: React.MouseEvent) => void;
  showToast: (msg: string, level?: ToastLevel) => void;
  activeConnectionId: number | null;
  activeDatabase: string | null;
  activeSchema: string | null;
  onOpenSettings: () => void;
}

export const Assistant: React.FC<AssistantProps> = ({
  assistantWidth,
  handleAssistantResize,
  showToast,
  activeConnectionId,
  activeDatabase,
  activeSchema,
  onOpenSettings,
}) => {
  const { t } = useTranslation();
  const confirm = useConfirmStore((s) => s.confirm);
  const setIsAssistantOpen = useAppStore((s) => s.setAssistantOpen);
  const autoMode = useAppStore((s) => s.autoMode);
  const setAutoMode = useAppStore((s) => s.setAutoMode);
  const initAutoMode = useAppStore((s) => s.initAutoMode);

  useEffect(() => {
    initAutoMode();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 精准订阅：只取主面板需要的字段，不含 streamingContent（由 StreamingMessage 自己订阅）
  const chatHistory = useAiStore((s) => s.chatHistory);
  const { sendAgentChatStream, clearHistory, newSession, switchSession, deleteSession, deleteAllSessions, sessions, currentSessionId, configs, setSessionConfigId, loadConfigs, loadSessions, cancelChat, respondPermission, respondQuestion, linkedConnectionId, setLinkedConnectionId, undoMessage, redoMessage, compactSession } = useAiStore(
    useShallow((s) => ({
      sendAgentChatStream: s.sendAgentChatStream,
      clearHistory: s.clearHistory,
      newSession: s.newSession,
      switchSession: s.switchSession,
      deleteSession: s.deleteSession,
      deleteAllSessions: s.deleteAllSessions,
      sessions: s.sessions,
      currentSessionId: s.currentSessionId,
      configs: s.configs,
      setSessionConfigId: s.setSessionConfigId,
      loadConfigs: s.loadConfigs,
      loadSessions: s.loadSessions,
      cancelChat: s.cancelChat,
      respondPermission: s.respondPermission,
      respondQuestion: s.respondQuestion,
      linkedConnectionId: s.linkedConnectionId,
      setLinkedConnectionId: s.setLinkedConnectionId,
      undoMessage: s.undoMessage,
      redoMessage: s.redoMessage,
      compactSession: s.compactSession,
    }))
  );
  const isChatting = useAiStore((s) => s.chatStates[currentSessionId]?.isChatting ?? false);
  const lastUserMessageId = useAiStore((s) => s.chatStates[currentSessionId]?.lastUserMessageId ?? null);
  const canRedo = useAiStore((s) => s.chatStates[currentSessionId]?.canRedo ?? false);
  const isCompacting = useAiStore((s) => s.chatStates[currentSessionId]?.isCompacting ?? false);
  const activeToolName = useAiStore((s) => s.chatStates[currentSessionId]?.activeToolName ?? null);
  const pendingPermission = useAiStore((s) => s.chatStates[currentSessionId]?.pendingPermission ?? null);
  const pendingQuestion = useAiStore((s) => s.chatStates[currentSessionId]?.pendingQuestion ?? null);
  const isWaitingForAnswer = isChatting && !!pendingQuestion;
  // 耗时统计
  const chatStartRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastElapsedMs, setLastElapsedMs] = useState(0);
  // 后台流式 session 的 isChatting map（用于历史列表角标）
  // 使用 ref 缓存结果，只有当 chatting 列表真正变化时才更新
  const chattingSessionIdsRef = useRef<Set<string>>(new Set());
  const rawChattingIds = useAiStore(
    useShallow((s) =>
      Object.entries(s.chatStates)
        .filter(([, v]) => v.isChatting)
        .map(([k]) => k)
        .sort()
    )
  );
  if (
    rawChattingIds.length !== chattingSessionIdsRef.current.size ||
    !rawChattingIds.every((id) => chattingSessionIdsRef.current.has(id))
  ) {
    chattingSessionIdsRef.current = new Set(rawChattingIds);
  }
  const chattingSessionIds = chattingSessionIdsRef.current;
  // 当前 session 的模型配置 ID：优先 chatStates.pendingConfigId（切换后立即生效），fallback sessions
  const pendingConfigId = useAiStore((s) => s.chatStates[currentSessionId]?.pendingConfigId ?? null);
  const activeConfigId =
    pendingConfigId ??
    sessions.find((s) => s.id === currentSessionId)?.configId ??
    null;
  const connectedConfigs = configs.filter((c) => c.test_status === 'success');
  const { connections, activeConnectionIds } = useConnectionStore();

  const [chatInput, setChatInput] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [showSchemaComplete, setShowSchemaComplete] = useState(true);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [showHistoryPicker, setShowHistoryPicker] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isModelMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setIsModelMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [isModelMenuOpen]);
  const [isConnectionMenuOpen, setIsConnectionMenuOpen] = useState(false);
  const [connectionMenuPos, setConnectionMenuPos] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);
  // 连接切换确认对话框：当 session 有内容时，Tab 切换触发
  const [pendingConnectionSwitch, setPendingConnectionSwitch] = useState<{
    oldConnectionId: number | null;
    oldConnectionName: string;
    newConnectionId: number | null;
    newConnectionName: string;
  } | null>(null);

  const effectiveConnectionId = linkedConnectionId ?? activeConnectionId;
  const effectiveConnectionName = effectiveConnectionId
    ? (connections.find(c => c.id === effectiveConnectionId)?.name ?? `#${effectiveConnectionId}`)
    : null;
  const openedConnections = connections.filter(c => activeConnectionIds.has(c.id) || c.id === (linkedConnectionId ?? activeConnectionId));

  // 当 Tab 切换导致 activeConnectionId 变化时，记录"待处理的连接切换"
  // （回答中暂存，回答结束后再弹提示）
  const prevActiveConnectionIdRef = useRef(activeConnectionId);
  const pendingConnSwitchAfterChatRef = useRef<{
    oldConnectionId: number | null;
    oldConnectionName: string;
    newConnectionId: number | null;
    newConnectionName: string;
  } | null>(null);

  const getConnName = (id: number | null) =>
    id ? (connections.find(c => c.id === id)?.name ?? `#${id}`) : t('assistant.noConnectionSelected');

  useEffect(() => {
    const prev = prevActiveConnectionIdRef.current;
    prevActiveConnectionIdRef.current = activeConnectionId;
    if (prev === activeConnectionId) return;

    const hasContent = chatHistory.length > 0;
    if (!hasContent) {
      // 空会话直接跟随
      if (linkedConnectionId !== null) setLinkedConnectionId(null);
      return;
    }

    // 仅当用户手动锁定了连接时才需要确认切换；
    // 跟随标签页模式下（linkedConnectionId === null）effectiveConnectionId 始终等于
    // 当前 Tab 连接，弹框确认等于询问"切换到已选中的连接"——无意义，直接跟随即可。
    if (linkedConnectionId === null) return;

    const oldEffectiveId = linkedConnectionId;
    const newEffectiveId = activeConnectionId;
    if (oldEffectiveId === newEffectiveId) return;

    const switchInfo = {
      oldConnectionId: oldEffectiveId,
      oldConnectionName: getConnName(oldEffectiveId),
      newConnectionId: newEffectiveId,
      newConnectionName: getConnName(newEffectiveId),
    };

    if (isChatting) {
      // 回答中：暂存，待回答完成后再弹提示
      pendingConnSwitchAfterChatRef.current = switchInfo;
    } else {
      setPendingConnectionSwitch(switchInfo);
    }
  }, [activeConnectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 回答结束时，检查是否有暂存的连接切换请求
  const prevIsChatting = useRef(isChatting);
  useEffect(() => {
    const wasChatting = prevIsChatting.current;
    prevIsChatting.current = isChatting;
    if (wasChatting && !isChatting && pendingConnSwitchAfterChatRef.current) {
      setPendingConnectionSwitch(pendingConnSwitchAfterChatRef.current);
      pendingConnSwitchAfterChatRef.current = null;
    }
  }, [isChatting]);

  // 聊天耗时计时器：isChatting 开始时计时，结束时保存耗时
  useEffect(() => {
    if (isChatting) {
      chatStartRef.current = Date.now();
      const id = setInterval(() => {
        if (chatStartRef.current) {
          setElapsedMs(Date.now() - chatStartRef.current);
        }
      }, 100);
      return () => clearInterval(id);
    } else {
      if (chatStartRef.current) {
        setLastElapsedMs(Date.now() - chatStartRef.current);
        chatStartRef.current = null;
      }
      setElapsedMs(0);
    }
  }, [isChatting]);

  // 切换会话时重置耗时（仅当非聊天中时清除 ref，避免与计时器竞争）
  useEffect(() => {
    setLastElapsedMs(0);
    setElapsedMs(0);
    if (!isChatting) {
      chatStartRef.current = null;
    }
  }, [currentSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const connectionMenuRef = useRef<HTMLDivElement>(null);
  const connectionDropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭：排除触发器和弹出层
  useEffect(() => {
    if (!isConnectionMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        connectionMenuRef.current?.contains(target) ||
        connectionDropdownRef.current?.contains(target)
      ) return;
      setIsConnectionMenuOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [isConnectionMenuOpen]);

  // 滚动或 resize 时关闭（下拉层内部滚动不触发）
  useEffect(() => {
    if (!isConnectionMenuOpen) return;
    const handleScroll = (e: Event) => {
      if (connectionDropdownRef.current?.contains(e.target as Node)) return;
      setIsConnectionMenuOpen(false);
    };
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', () => setIsConnectionMenuOpen(false));
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', () => setIsConnectionMenuOpen(false));
    };
  }, [isConnectionMenuOpen]);
  const [showHistory, setShowHistory] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const draftMessage = useAiStore((s) => s.draftMessage);
  const setDraftMessage = useAiStore((s) => s.setDraftMessage);

  useEffect(() => {
    if (draftMessage) {
      setChatInput(draftMessage);
      setDraftMessage('');
    }
  }, [draftMessage]);

  // 新消息或流式内容更新时自动滚底
  const streamingContent = useAiStore(
    (s) => s.chatStates[currentSessionId]?.streamingContent
  );
  const streamingThinking = useAiStore(
    (s) => s.chatStates[currentSessionId]?.streamingThinkingContent
  );
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, streamingContent, streamingThinking, pendingPermission, pendingQuestion, currentSessionId]);

  useEffect(() => {
    loadConfigs();
    loadSessions();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSendMessage = async () => {
    if (!chatInput.trim()) return;

    // 如果有 pending question，发送答案而非新消息
    if (isWaitingForAnswer && pendingQuestion) {
      const answer = chatInput.trim();
      setChatInput('');
      await respondQuestion(
        currentSessionId,
        pendingQuestion.question_id,
        [[answer]],  // 单个答案包装为 answers 格式
        false,
      );
      return;
    }

    if (isChatting) return;
    const prompt = chatInput.trim();
    const activeChatCount = Object.values(useAiStore.getState().chatStates).filter((s) => s.isChatting).length;
    if (activeChatCount >= 10) {
      showToast(t('assistant.concurrentChatLimit'), 'warning');
      return;
    }
    setChatInput('');
    await sendAgentChatStream(prompt, effectiveConnectionId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 斜杠菜单打开时，Enter 由 SlashCommandMenu 处理，不触发 send
    if (slashQuery !== null) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // 斜杠命令所需状态与上下文
  const activeConfig = configs.find((c) => c.id === activeConfigId) ?? configs.find((c) => c.is_default) ?? configs[0] ?? null;
  const commandState = {
    hasHistory: chatHistory.length > 0,
    isChatting,
    canUndo: lastUserMessageId !== null,
    canRedo,
    isCompacting,
    messageCount: chatHistory.length,
  };
  const commandContext = {
    sessionId: currentSessionId,
    modelId: activeConfig?.model ?? null,
    providerId: activeConfig?.opencode_provider_id ?? null,
    undoMessage,
    redoMessage,
    compactSession,
    newSession,
    clearHistory,
    showToast,
    openHistoryPicker: () => setShowHistoryPicker(true),
  };

  // 输入框 JSX，在空状态和正常状态中复用
  const renderInputBox = () => (
    <div className="bg-background-panel border border-border-strong rounded-lg p-2 flex flex-col focus-within:border-accent transition-colors relative">
      {slashQuery !== null && (
        <SlashCommandMenu
          query={slashQuery}
          activeIndex={slashIndex}
          commandState={commandState}
          commandContext={commandContext}
          onClose={() => { setSlashQuery(null); setChatInput(''); }}
          onIndexChange={setSlashIndex}
        />
      )}
      <div className="relative mb-2 w-fit" ref={connectionMenuRef}>
        <div
          className="flex items-center text-xs text-foreground-muted cursor-pointer hover:text-foreground-default transition-colors duration-200"
          onClick={(e) => {
            e.stopPropagation();
            if (!isConnectionMenuOpen && connectionMenuRef.current) {
              const rect = connectionMenuRef.current.getBoundingClientRect();
              setConnectionMenuPos({
                top: rect.bottom,
                bottom: window.innerHeight - rect.top,
                left: Math.min(rect.left, window.innerWidth - 208 - 8),
                width: rect.width,
              });
            }
            setIsConnectionMenuOpen(!isConnectionMenuOpen);
          }}
        >
          <DatabaseZap size={12} className="mr-1 text-accent" />
          <span className="max-w-[120px] truncate">{effectiveConnectionName ?? t('assistant.noConnectionSelected')}</span>
          <ChevronDown size={12} className="ml-1 flex-shrink-0" />
        </div>

        {/* 下拉列表：Portal 到 body，fixed 定位，自适应展开方向 */}
        {isConnectionMenuOpen && connectionMenuPos && createPortal(
          <div
            ref={connectionDropdownRef}
            className="fixed z-[200] w-52 bg-background-elevated border border-border-strong rounded shadow-lg overflow-y-auto"
            style={{
              // 根据视窗位置决定展开方向：底部空间不足时向上展开
              ...(connectionMenuPos.top + 240 > window.innerHeight
                ? { bottom: connectionMenuPos.bottom + 4 }
                : { top: connectionMenuPos.top + 4 }),
              left: connectionMenuPos.left,
              maxHeight: 240,
            }}
          >
            {/* 跟随标签页选项 */}
            <div
              className={`px-3 py-1.5 flex items-center cursor-pointer hover:bg-border-default transition-colors duration-150 ${
                linkedConnectionId === null ? 'text-accent' : 'text-foreground-muted'
              }`}
              onClick={() => { setLinkedConnectionId(null); setIsConnectionMenuOpen(false); }}
            >
              <span className="text-xs italic">{t('assistant.followActiveTab')}</span>
            </div>
            {openedConnections.length === 0 ? (
              <div className="px-3 py-2 text-xs text-foreground-muted">{t('assistant.noOpenedConnections')}</div>
            ) : (
              openedConnections.map((c) => {
                const isActive = linkedConnectionId === c.id;
                return (
                  <div
                    key={c.id}
                    className={`px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-border-default transition-colors duration-150 ${
                      isActive ? 'text-accent' : 'text-foreground-default'
                    }`}
                    onClick={() => { setLinkedConnectionId(c.id); setIsConnectionMenuOpen(false); }}
                  >
                    <span className="text-xs truncate flex-1">{c.name}</span>
                    <span className="ml-2 w-2 h-2 rounded-full flex-shrink-0 bg-success" />
                  </div>
                );
              })
            )}
          </div>,
          document.body,
        )}
      </div>

      {/* 查询历史选择器 */}
      {showHistoryPicker && (
        <QueryHistoryPicker
          connectionId={effectiveConnectionId}
          onSelect={(entry) => {
            // 将查询历史引用插入到输入框
            const ref = `[查询历史: ${entry.sql.slice(0, 60)}${entry.sql.length > 60 ? '...' : ''} | ${entry.row_count ?? 0} rows, ${entry.duration_ms ?? 0}ms]`;
            setChatInput((prev) => prev + ref);
            setShowHistoryPicker(false);
          }}
          onClose={() => setShowHistoryPicker(false)}
        />
      )}
      {/* Schema 感知补全（SQL 上下文时触发） */}
      {showSchemaComplete && slashQuery === null && (
        <SchemaAutocomplete
          connectionId={effectiveConnectionId}
          inputText={chatInput}
          cursorPosition={cursorPosition}
          onSelect={(suggestion: SchemaSuggestion, triggerStart: number) => {
            // 将补全插入到 cursor 位置
            const before = chatInput.slice(0, triggerStart);
            const after = chatInput.slice(cursorPosition);
            const newValue = before + suggestion.label + after;
            setChatInput(newValue);
            setCursorPosition(triggerStart + suggestion.label.length);
            setShowSchemaComplete(false);
            setTimeout(() => setShowSchemaComplete(true), 100);
          }}
          onClose={() => {
            setShowSchemaComplete(false);
            setTimeout(() => setShowSchemaComplete(true), 300);
          }}
        />
      )}
      <textarea
        className="bg-transparent text-[13px] text-foreground-default outline-none resize-none h-16 w-full placeholder-foreground-muted"
        placeholder={isWaitingForAnswer ? t('assistant.answerPlaceholder') : t('assistant.inputPlaceholder')}
        value={chatInput}
        onChange={(e) => {
          const val = e.target.value;
          setChatInput(val);
          setCursorPosition(e.target.selectionStart ?? val.length);
          if (val.startsWith('/') && !val.includes(' ')) {
            setSlashQuery(val.slice(1));
            setSlashIndex(0);
          } else {
            setSlashQuery(null);
          }
        }}
        onSelect={(e) => setCursorPosition((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onKeyDown={handleKeyDown}
        disabled={isChatting && !isWaitingForAnswer}
      />
      <div className="flex items-center justify-between mt-2 relative">
        {/* 模型选择器 + Auto 开关 */}
        <div className="flex items-center gap-2">
        <div className="relative" ref={modelMenuRef}>
          <div
            className="flex items-center text-xs text-foreground-muted cursor-pointer hover:text-foreground-default bg-background-elevated px-2 py-1 rounded border border-border-strong transition-colors duration-200"
            onClick={() => setIsModelMenuOpen(!isModelMenuOpen)}
          >
            <span className="max-w-[96px] truncate">
              {configs.length === 0
                ? t('assistant.noModelConfigured')
                : (() => {
                    const active = configs.find((c) => c.id === activeConfigId)
                      ?? configs.find((c) => c.is_default)
                      ?? configs[0];
                    return active ? (active.opencode_display_name || active.model) : t('assistant.selectModel');
                  })()}
            </span>
            <ChevronDown size={12} className="ml-1 flex-shrink-0" />
          </div>

          {isModelMenuOpen && (
            <div className="absolute left-0 bottom-full mb-1 w-52 bg-background-elevated border border-border-strong rounded shadow-lg z-50 py-1">
              {configs.length === 0 ? (
                <div className="px-3 py-2 text-xs text-foreground-muted">{t('assistant.noModelHint')}</div>
              ) : (
                configs.map((c) => {
                  const isConnected = c.test_status === 'success';
                  const isActive = activeConfigId === c.id || (!activeConfigId && c.is_default);
                  return (
                    <div
                      key={c.id}
                      className={`px-3 py-1.5 flex items-center justify-between transition-colors duration-150 ${
                        isConnected
                          ? `cursor-pointer hover:bg-border-default ${isActive ? 'text-accent' : 'text-foreground-default'}`
                          : 'cursor-not-allowed opacity-40 text-foreground-muted'
                      }`}
                      onClick={() => {
                        if (!isConnected) return;
                        setIsModelMenuOpen(false);
                        setSessionConfigId(currentSessionId, c.id);
                      }}
                      title={!isConnected ? t('assistant.modelNotConnected') : undefined}
                    >
                      <span className="text-xs truncate flex-1">{c.is_default ? `★ ${c.name}` : c.name}</span>
                      <span className={`ml-2 w-2 h-2 rounded-full flex-shrink-0 ${
                        c.test_status === 'success' ? 'bg-success' :
                        c.test_status === 'fail' ? 'bg-error' : 'bg-foreground-ghost'
                      }`} />
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Auto 模式开关 */}
        <Tooltip
          content={autoMode
            ? t('assistant.autoModeOn')
            : t('assistant.autoModeOff')}
          delay={500}
        >
          <button
            onClick={() => setAutoMode(!autoMode)}
            className="flex items-center gap-1.5 px-1.5 py-1 rounded transition-colors hover:bg-border-default"
            aria-label={t('assistant.toggleAutoMode')}
          >
            <span className="text-[11px] text-foreground-muted select-none">Auto</span>
            {/* 开关轨道 */}
            <span className={`relative inline-flex h-3.5 w-6 flex-shrink-0 rounded-full transition-colors duration-200 ${
              autoMode ? 'bg-accent' : 'bg-border-strong'
            }`}>
              {/* 滑块 */}
              <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform duration-200 ${
                autoMode ? 'translate-x-[10px]' : 'translate-x-0.5'
              }`} />
            </span>
          </button>
        </Tooltip>
        </div>

        {isChatting ? (
          isWaitingForAnswer && !chatInput.trim() ? (
            /* 等待回答 + 无输入：显示 X 按钮（拒绝/跳过问题） */
            <Tooltip content={t('assistant.rejectQuestion')} className="contents">
              <button
                className="p-1.5 rounded transition-colors bg-accent/20 text-accent hover:bg-accent/30"
                onClick={() => {
                  if (pendingQuestion) {
                    respondQuestion(currentSessionId, pendingQuestion.question_id, [], true);
                  }
                }}
              >
                <X size={14} />
              </button>
            </Tooltip>
          ) : isWaitingForAnswer ? (
            /* 等待回答 + 有输入：显示发送按钮 */
            <Tooltip content={t('assistant.sendMessage')} className="contents">
              <button
                className="p-1.5 rounded transition-colors bg-accent text-foreground hover:bg-accent-hover"
                onClick={handleSendMessage}
              >
                <Send size={14} />
              </button>
            </Tooltip>
          ) : (
            /* 生成中：显示停止按钮 */
            <Tooltip content={t('assistant.stopGeneration')} className="contents">
              <button
                className="p-1.5 rounded transition-colors bg-error-subtle text-error hover:bg-error-subtle"
                onClick={() => cancelChat(currentSessionId)}
              >
                <Square size={14} />
              </button>
            </Tooltip>
          )
        ) : (
          <Tooltip content={t('assistant.sendMessage')} className="contents">
            <button
              className={`p-1.5 rounded transition-colors ${chatInput.trim() ? 'bg-accent text-foreground hover:bg-accent-hover' : 'bg-border-default text-foreground-muted'}`}
              onClick={handleSendMessage}
              disabled={!chatInput.trim()}
            >
              <Send size={14} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );

  const isEmpty = chatHistory.length === 0 && !isChatting;

  return (
    <div className="flex flex-col bg-background-void flex-shrink-0 border-l border-border-default relative h-full" style={{ width: assistantWidth }}>
      <div
        className="absolute left-[-2px] top-0 bottom-0 w-[4.5px] cursor-col-resize hover:bg-accent z-10 transition-colors"
        onMouseDown={handleAssistantResize}
      />
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-border-default bg-background-base flex-shrink-0">
        <div className="text-[13px] font-medium truncate flex-1 flex items-center gap-1.5">
          {isChatting ? (
            <>
              <span className="flex items-center gap-[3px]">
                {[0, 0.2, 0.4].map((delay) => (
                  <span
                    key={delay}
                    className="ai-dot w-1 h-1 rounded-full bg-accent flex-shrink-0"
                    style={{ animationDelay: `${delay}s` }}
                  />
                ))}
              </span>
              <span className="text-accent">{t('assistant.title')}</span>
            </>
          ) : (
            <span className="text-foreground-default">{t('assistant.title')}</span>
          )}
        </div>
        <div className="flex items-center space-x-4 text-foreground-muted">
          {!showHistory && chatHistory.length > 0 && (
            <Tooltip content={t('assistant.clearHistory')} className="contents">
              <span
                className="flex items-center cursor-pointer hover:text-error p-1 transition-colors duration-200"
                onClick={async () => {
                  const ok = await confirm({
                    title: t('assistant.clearChatTitle'),
                    message: t('assistant.clearChatConfirm'),
                    variant: 'danger',
                  });
                  if (!ok) return;
                  clearHistory(currentSessionId);
                  showToast(t('assistant.historyCleared'), 'info');
                }}
              >
                <Trash2 size={16} />
              </span>
            </Tooltip>
          )}
          <Tooltip content={t('assistant.newChat')} className="contents">
            <span className="cursor-pointer hover:text-foreground-default p-1 transition-colors duration-200" onClick={() => { newSession(); setShowHistory(false); showToast(t('assistant.newChatOpened'), 'info'); }}><Plus size={16} /></span>
          </Tooltip>
          <Tooltip content={t('assistant.openHistory')} className="contents">
            <span className={`cursor-pointer transition-colors p-1 ${showHistory ? 'text-accent' : 'hover:text-foreground-default'}`} onClick={() => setShowHistory((v) => !v)}><History size={16} /></span>
          </Tooltip>
          <span className="cursor-pointer hover:text-foreground-default p-1 flex items-center transition-colors duration-200" onClick={() => { setIsAssistantOpen(false); showToast(t('assistant.assistantClosed'), 'info'); }}><X size={16} /></span>
        </div>
      </div>

      {/* ── 会话历史面板（覆盖在聊天区上方）── */}
      {showHistory && (
        <div className="absolute inset-0 top-10 z-20 flex flex-col bg-background-void">
          {/* 历史面板 Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-default bg-background-base flex-shrink-0">
            <button
              className="flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground-default transition-colors"
              onClick={() => { setShowHistory(false); }}
            >
              <ChevronLeft size={14} />
              <span>{t('assistant.backToChat')}</span>
            </button>
            <span className="text-xs text-foreground-subtle">{sessions.length} {t('assistant.sessionCount')}</span>
          </div>

          {/* 会话列表 */}
          <div className="flex-1 overflow-auto py-1 min-h-0">
            {sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-foreground-subtle text-center px-4 gap-3">
                <MessageSquare size={28} className="opacity-20" />
                <p className="text-xs">{t('assistant.noHistory')}</p>
              </div>
            ) : (
              sessions
                .slice()
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map((sess) => {
                  const isActive = sess.id === currentSessionId;
                  const date = new Date(sess.updatedAt);
                  const now = Date.now();
                  const diff = now - sess.updatedAt;
                  const mins = Math.floor(diff / 60_000);
                  const hrs = Math.floor(diff / 3_600_000);
                  const relTime =
                    diff < 60_000 ? t('assistant.justNow') :
                    diff < 3_600_000 ? `${mins} ${t('assistant.minutesAgo')}` :
                    diff < 86_400_000 ? `${hrs} ${t('assistant.hoursAgo')}` :
                    date.toLocaleDateString();
                  return (
                    <div
                      key={sess.id}
                      className={`group flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-background-panel transition-colors ${
                        isActive ? 'bg-background-base' : 'hover:bg-background-void'
                      }`}
                      onClick={() => { switchSession(sess.id); setShowHistory(false); }}
                    >
                      <MessageSquare size={13} className={`mt-0.5 flex-shrink-0 ${isActive ? 'text-accent' : 'text-foreground-subtle'}`} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-[12px] font-medium truncate leading-tight flex items-center gap-1.5 ${isActive ? 'text-foreground-default' : 'text-foreground-default'}`}>
                          <span className="truncate">{sess.title}</span>
                          {!sess.titleGenerated && (
                            <span className="text-[10px] text-foreground-subtle animate-pulse flex-shrink-0">•</span>
                          )}
                          {chattingSessionIds.has(sess.id) && (
                            <RefreshCw size={10} className="animate-spin text-accent flex-shrink-0" />
                          )}
                        </div>
                        <div className="text-[11px] text-foreground-subtle mt-0.5">
                          {relTime} · {sess.messages.length} {t('assistant.messageCount')}
                        </div>
                      </div>
                      <Tooltip content={t('assistant.deleteSession')} className="contents">
                        <button
                          className="opacity-0 group-hover:opacity-100 p-1 text-foreground-subtle hover:text-error transition-all flex-shrink-0"
                          onClick={async (e) => {
                            e.stopPropagation();
                            const ok = await confirm({
                              title: t('assistant.deleteSessionTitle'),
                              message: t('assistant.deleteSessionConfirm'),
                              variant: 'danger',
                            });
                            if (!ok) return;
                            deleteSession(sess.id);
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </Tooltip>
                    </div>
                  );
                })
            )}
          </div>

          {/* 清除所有会话按钮 */}
          {sessions.length > 0 && (
            <div className="px-3 py-2 border-t border-border-default flex-shrink-0">
              <button
                className="w-full flex items-center justify-center gap-2 py-1.5 text-xs text-foreground-muted hover:text-error hover:bg-border-default rounded transition-colors"
                onClick={async () => {
                  const ok = await confirm({
                    title: t('assistant.deleteAllSessionsTitle'),
                    message: t('assistant.deleteAllSessionsConfirm'),
                    variant: 'danger',
                  });
                  if (!ok) return;
                  deleteAllSessions();
                  setShowHistory(false);
                  showToast(t('assistant.allSessionsDeleted'), 'info');
                }}
              >
                <Trash2 size={13} />
                <span>{t('assistant.deleteAllSessions')}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {isEmpty ? (
        /* ── 空状态：提示文字 + 输入框垂直居中，紧凑排列 ── */
        <div className="flex flex-col flex-1 items-center justify-center gap-5 px-4 pb-6">
          <div className="flex flex-col items-center text-foreground-muted text-center">
            <DatabaseZap size={28} className="mb-3 opacity-25" />
            {connectedConfigs.length === 0 ? (
              <>
                <p className="text-sm">{t('assistant.noConnectedModel')}</p>
                <p className="text-xs mt-1 opacity-60 mb-4">{t('assistant.noConnectedModelHint')}</p>
                <button
                  onClick={onOpenSettings}
                  className="px-4 py-1.5 text-xs bg-accent hover:bg-accent-hover text-foreground rounded transition-colors duration-200"
                >
                  {t('assistant.goToSettings')}
                </button>
              </>
            ) : (
              <>
                <p className="text-sm">{t('assistant.inputDescription')}</p>
                <p className="text-xs mt-1 opacity-60">{t('assistant.aiWillGenerateSql')}</p>
              </>
            )}
          </div>
          {/* 输入框紧跟在提示文字下方 */}
          <div className="w-full">{renderInputBox()}</div>
        </div>
      ) : (
        /* ── 对话状态：消息滚动区 + 底部固定输入框 ── */
        <ChatConnectionProvider value={{ connectionId: effectiveConnectionId, database: activeDatabase ?? undefined, schema: activeSchema ?? undefined }}>
          <div className="flex-1 overflow-auto p-4 space-y-6 min-h-0">
            {chatHistory.map((msg, idx) => {
              const isLastUser = msg.role === 'user' && idx === chatHistory.length - 2;
              const isLastAssistant = msg.role === 'assistant' && idx === chatHistory.length - 1;
              const canEditOrRegen = !isChatting && chatHistory.length >= 2;

              return msg.role === 'user' ? (
                <div key={idx} className="flex flex-col items-end group/msg">
                  <div className="bg-border-default text-foreground-default px-3 py-2 rounded-lg max-w-[90%] text-[13px] leading-relaxed break-words">
                    {msg.content}
                  </div>
                  {/* 编辑按钮：常驻显示，仅最后一条用户消息可用 */}
                  {isLastUser && canEditOrRegen && (
                    <button
                      onClick={() => {
                        const msgContent = msg.content;
                        undoMessage(currentSessionId);
                        setChatInput(msgContent);
                      }}
                      className="mt-1 text-[11px] text-foreground-ghost hover:text-foreground-muted flex items-center gap-1 transition-colors"
                      title={t('assistant.editMessage', { defaultValue: '编辑并重新发送' })}
                    >
                      <Pencil size={10} />
                      <span>{t('assistant.edit', { defaultValue: '编辑' })}</span>
                    </button>
                  )}
                </div>
              ) : msg.role === 'system' ? null : (
                <div key={idx} className="group/msg">
                  <AssistantMessage
                    content={msg.content}
                    thinkingContent={msg.thinkingContent}
                    parts={msg.parts}
                  />
                  {/* 操作栏：重新生成 + 耗时统计，仅最后一条助手消息 */}
                  {isLastAssistant && (
                    <div className="mt-1 flex items-center gap-3">
                      {canEditOrRegen && (
                        <button
                          onClick={async () => {
                            const lastUserMsg = chatHistory.slice(0, idx).reverse().find((m) => m.role === 'user');
                            if (!lastUserMsg) return;
                            await undoMessage(currentSessionId);
                            const effectiveConnId = linkedConnectionId ?? useConnectionStore.getState().activeConnectionId;
                            sendAgentChatStream(lastUserMsg.content, effectiveConnId);
                          }}
                          className="text-[11px] text-foreground-ghost hover:text-foreground-muted flex items-center gap-1 transition-colors"
                          title={t('assistant.regenerate', { defaultValue: '重新生成' })}
                        >
                          <RefreshCw size={10} />
                          <span>{t('assistant.regenerate', { defaultValue: '重新生成' })}</span>
                        </button>
                      )}
                      {lastElapsedMs > 0 && (
                        <span className="flex items-center gap-1 text-[11px] text-foreground-ghost">
                          <Clock size={10} />
                          <span>{formatElapsed(lastElapsedMs)}</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {isChatting && (
              <div>
                <StreamingMessage sessionId={currentSessionId} />
                {/* 生成中实时耗时 */}
                {elapsedMs > 0 && (
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-foreground-ghost">
                    <Clock size={10} />
                    <span>{formatElapsed(elapsedMs)}</span>
                  </div>
                )}
              </div>
            )}

              {/* 权限/问答面板已移至底部 Dock 区域 */}

            <div ref={chatEndRef} />
          </div>

          {/* Patch 确认面板 */}
          <div className="px-3 pb-3"><PatchConfirmPanel /></div>

          {/* 权限确认 Dock（固定在底部，脱离消息流） */}
          {pendingPermission && (
            <div className="px-3 pb-3">
              <PermissionDock
                request={pendingPermission}
                onRespond={(optionId, cancelled) =>
                  respondPermission(currentSessionId, pendingPermission.id, optionId, cancelled)
                }
              />
            </div>
          )}

          {/* 问答 Dock（固定在底部） */}
          {pendingQuestion && (
            <div className="px-3 pb-3">
              <QuestionDock
                request={pendingQuestion}
                onAnswer={(questionId, answers, cancelled) =>
                  respondQuestion(currentSessionId, questionId, answers, cancelled)
                }
              />
            </div>
          )}

          {/* 连接切换确认 banner */}
          {pendingConnectionSwitch && (
            <div className="mx-3 mb-2 p-2 bg-background-hover border border-border-strong rounded-lg flex-shrink-0">
              <p className="text-xs text-foreground-muted mb-2">
                {t('assistant.connectionSwitchTitle')}
              </p>
              <p className="text-[11px] text-foreground-muted mb-2">
                {t('assistant.connectionSwitchDesc', {
                  old: pendingConnectionSwitch.oldConnectionName,
                  new: pendingConnectionSwitch.newConnectionName,
                })}
              </p>
              <div className="flex gap-2">
                <button
                  className="flex-1 text-[11px] px-2 py-1 rounded bg-background-panel border border-border-strong text-foreground-muted hover:text-foreground-default hover:border-border-strong transition-colors duration-200"
                  onClick={() => {
                    setLinkedConnectionId(pendingConnectionSwitch.oldConnectionId);
                    setPendingConnectionSwitch(null);
                  }}
                >
                  {t('assistant.keepLastConnection', { name: pendingConnectionSwitch.oldConnectionName })}
                </button>
                <button
                  className="flex-1 text-[11px] px-2 py-1 rounded bg-accent-subtle border border-accent text-accent hover:bg-accent-subtle transition-colors duration-200"
                  onClick={() => {
                    setLinkedConnectionId(null);
                    setPendingConnectionSwitch(null);
                  }}
                >
                  {t('assistant.switchToNewConnection', { name: pendingConnectionSwitch.newConnectionName })}
                </button>
              </div>
            </div>
          )}

          {/* 底部输入框 */}
          <div className="p-3 border-t border-border-default flex-shrink-0">
            {renderInputBox()}
          </div>
        </ChatConnectionProvider>
      )}
    </div>
  );
};
