import React, { useRef, useEffect, useState, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Plus, History, X, DatabaseZap, ChevronDown, Send, Trash2, Copy, Check, Square, ChevronLeft, MessageSquare, RefreshCw } from 'lucide-react';
import { ThinkingBlock } from './ThinkingBlock';
import { MarkdownContent } from '../shared/MarkdownContent';
import { DiffPanel } from './DiffPanel';
import ElicitationPanel from './ElicitationPanel';
import { SlashCommandMenu } from './SlashCommandMenu';
import { useAiStore } from '../../store';
import { useConnectionStore } from '../../store/connectionStore';
import { useQueryStore } from '../../store/queryStore';
import { useAppStore } from '../../store/appStore';
import { Tooltip } from '../common/Tooltip';
import type { ToastLevel } from '../Toast';

// ── 历史消息（memo 隔离：chatHistory 不变时完全不重渲染）────────────────────
const AssistantMessage: React.FC<{ content: string; thinkingContent?: string }> = memo(
  ({ content, thinkingContent }) => (
    <div className="flex flex-col items-start">
      <div className="text-[#c8daea] text-[13px] w-full">
        {thinkingContent && (
          <ThinkingBlock content={thinkingContent} isStreaming={false} />
        )}
        <MarkdownContent content={content} />
      </div>
    </div>
  )
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
      <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7] flex-shrink-0" />
      <span className="text-xs text-[#5b8ab0] animate-pulse">{messages[msgIdx]}</span>
    </div>
  );
};

// ── 流式消息（独立组件，用 Zustand selector 精准订阅，不影响历史消息）────────
const StreamingMessage: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const content = useAiStore((s) => s.chatStates[sessionId]?.streamingContent ?? '');
  const thinking = useAiStore((s) => s.chatStates[sessionId]?.streamingThinkingContent ?? '');
  const sessionStatus = useAiStore((s) => s.chatStates[sessionId]?.sessionStatus ?? null);

  // 已收到任何内容（包含深度思考）则不再显示等待动画
  const hasFirstToken = !!(content || thinking);

  return (
    <div className="flex flex-col items-start">
      <div className="text-[#c8daea] text-[13px] w-full">
        {thinking && <ThinkingBlock content={thinking} isStreaming={true} />}
        {content && <MarkdownContent content={content} />}
        {!hasFirstToken && (
          sessionStatus ? (
            <div className="flex items-center gap-2 py-1">
              <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7] flex-shrink-0" />
              <span className="text-xs text-[#5b8ab0] animate-pulse">{sessionStatus}</span>
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
  onOpenSettings: () => void;
}

export const Assistant: React.FC<AssistantProps> = ({
  assistantWidth,
  handleAssistantResize,
  showToast,
  activeConnectionId,
  onOpenSettings,
}) => {
  const { t } = useTranslation();
  const setIsAssistantOpen = useAppStore((s) => s.setAssistantOpen);
  const autoMode = useAppStore((s) => s.autoMode);
  const setAutoMode = useAppStore((s) => s.setAutoMode);
  const initAutoMode = useAppStore((s) => s.initAutoMode);

  useEffect(() => {
    initAutoMode();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 精准订阅：只取主面板需要的字段，不含 streamingContent（由 StreamingMessage 自己订阅）
  const chatHistory = useAiStore((s) => s.chatHistory);
  const { sendAgentChatStream, clearHistory, newSession, switchSession, deleteSession, deleteAllSessions, sessions, currentSessionId, configs, setSessionConfigId, loadConfigs, loadSessions, cancelChat, respondPermission, respondElicitation, clearElicitation, linkedConnectionId, setLinkedConnectionId, undoMessage, redoMessage, compactSession } = useAiStore();
  const isChatting = useAiStore((s) => s.chatStates[currentSessionId]?.isChatting ?? false);
  const lastUserMessageId = useAiStore((s) => s.chatStates[currentSessionId]?.lastUserMessageId ?? null);
  const canRedo = useAiStore((s) => s.chatStates[currentSessionId]?.canRedo ?? false);
  const isCompacting = useAiStore((s) => s.chatStates[currentSessionId]?.isCompacting ?? false);
  const activeToolName = useAiStore((s) => s.chatStates[currentSessionId]?.activeToolName ?? null);
  const pendingPermission = useAiStore((s) => s.chatStates[currentSessionId]?.pendingPermission ?? null);
  const pendingElicitation = useAiStore((s) => s.chatStates[currentSessionId]?.pendingElicitation ?? null);
  // 后台流式 session 的 isChatting map（用于历史列表角标）
  // 返回稳定字符串避免每次 selector 返回新 Set 对象导致无限循环
  const chattingSessionIdsStr = useAiStore((s) =>
    Object.entries(s.chatStates)
      .filter(([, v]) => v.isChatting)
      .map(([k]) => k)
      .sort()
      .join(',')
  );
  const chattingSessionIds = useMemo(
    () => new Set(chattingSessionIdsStr ? chattingSessionIdsStr.split(',') : []),
    [chattingSessionIdsStr]
  );
  // 当前 session 的模型配置 ID：优先 chatStates.pendingConfigId（切换后立即生效），fallback sessions
  const pendingConfigId = useAiStore((s) => s.chatStates[currentSessionId]?.pendingConfigId ?? null);
  const activeConfigId =
    pendingConfigId ??
    sessions.find((s) => s.id === currentSessionId)?.configId ??
    null;
  const connectedConfigs = configs.filter((c) => c.test_status === 'success');
  const { pendingDiff, applyDiff, cancelDiff } = useQueryStore();
  const { connections, activeConnectionIds } = useConnectionStore();

  const [chatInput, setChatInput] = useState('');
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
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
  const openedConnections = connections.filter(c => activeConnectionIds.has(c.id));

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

    const oldEffectiveId = linkedConnectionId ?? prev;
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
  const connectionMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isConnectionMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (connectionMenuRef.current && !connectionMenuRef.current.contains(e.target as Node)) {
        setIsConnectionMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [isConnectionMenuOpen]);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
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
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, streamingContent, currentSessionId]);

  useEffect(() => {
    loadConfigs();
    loadSessions();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSendMessage = async () => {
    if (!chatInput.trim() || isChatting) return;
    const prompt = chatInput.trim();
    // 并发上限检查
    const activeChatCount = Object.values(useAiStore.getState().chatStates).filter((s) => s.isChatting).length;
    if (activeChatCount >= 10) {
      showToast('已有多个对话正在进行，请等待其完成后再发送新消息', 'warning');
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
  };

  // 输入框 JSX，在空状态和正常状态中复用
  const renderInputBox = () => (
    <div className="bg-[#111922] border border-[#2a3f5a] rounded-lg p-2 flex flex-col focus-within:border-[#00c9a7] transition-colors relative">
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
          className="flex items-center text-xs text-[#7a9bb8] cursor-pointer hover:text-[#c8daea]"
          onClick={(e) => { e.stopPropagation(); setIsConnectionMenuOpen(!isConnectionMenuOpen); }}
        >
          <DatabaseZap size={12} className="mr-1 text-[#00c9a7]" />
          <span className="max-w-[120px] truncate">{effectiveConnectionName ?? t('assistant.noConnectionSelected')}</span>
          <ChevronDown size={12} className="ml-1 flex-shrink-0" />
        </div>

        {isConnectionMenuOpen && (
          <div className="absolute left-0 top-full mt-1 w-52 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg z-50 py-1">
            {/* 跟随标签页选项 */}
            <div
              className={`px-3 py-1.5 flex items-center cursor-pointer hover:bg-[#1e2d42] ${
                linkedConnectionId === null ? 'text-[#009e84]' : 'text-[#7a9bb8]'
              }`}
              onClick={() => { setLinkedConnectionId(null); setIsConnectionMenuOpen(false); }}
            >
              <span className="text-xs italic">{t('assistant.followActiveTab')}</span>
            </div>
            {openedConnections.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[#7a9bb8]">{t('assistant.noOpenedConnections')}</div>
            ) : (
              openedConnections.map((c) => {
                const isActive = linkedConnectionId === c.id;
                return (
                  <div
                    key={c.id}
                    className={`px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-[#1e2d42] ${
                      isActive ? 'text-[#009e84]' : 'text-[#c8daea]'
                    }`}
                    onClick={() => { setLinkedConnectionId(c.id); setIsConnectionMenuOpen(false); }}
                  >
                    <span className="text-xs truncate flex-1">{c.name}</span>
                    <span className="ml-2 w-2 h-2 rounded-full flex-shrink-0 bg-green-400" />
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
      <textarea
        className="bg-transparent text-[13px] text-[#c8daea] outline-none resize-none h-16 w-full placeholder-[#7a9bb8]"
        placeholder={t('assistant.inputPlaceholder')}
        value={chatInput}
        onChange={(e) => {
          const val = e.target.value;
          setChatInput(val);
          if (val.startsWith('/') && !val.includes(' ')) {
            setSlashQuery(val.slice(1));
            setSlashIndex(0);
          } else {
            setSlashQuery(null);
          }
        }}
        onKeyDown={handleKeyDown}
        disabled={isChatting}
      />
      <div className="flex items-center justify-between mt-2 relative">
        {/* 模型选择器 + Auto 开关 */}
        <div className="flex items-center gap-2">
        <div className="relative" ref={modelMenuRef}>
          <div
            className="flex items-center text-xs text-[#7a9bb8] cursor-pointer hover:text-[#c8daea] bg-[#151d28] px-2 py-1 rounded border border-[#2a3f5a]"
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
            <div className="absolute left-0 bottom-full mb-1 w-52 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg z-50 py-1">
              {configs.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[#7a9bb8]">{t('assistant.noModelHint')}</div>
              ) : (
                configs.map((c) => {
                  const isConnected = c.test_status === 'success';
                  const isActive = activeConfigId === c.id || (!activeConfigId && c.is_default);
                  return (
                    <div
                      key={c.id}
                      className={`px-3 py-1.5 flex items-center justify-between ${
                        isConnected
                          ? `cursor-pointer hover:bg-[#1e2d42] ${isActive ? 'text-[#009e84]' : 'text-[#c8daea]'}`
                          : 'cursor-not-allowed opacity-40 text-[#7a9bb8]'
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
                        c.test_status === 'success' ? 'bg-green-400' :
                        c.test_status === 'fail' ? 'bg-red-400' : 'bg-gray-600'
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
            ? 'Auto 模式：开启 — AI 可直接执行写操作，无需逐一确认'
            : 'Auto 模式：关闭 — 写操作执行前需要手动确认'}
          delay={500}
        >
          <button
            onClick={() => setAutoMode(!autoMode)}
            className="flex items-center gap-1.5 px-1.5 py-1 rounded transition-colors hover:bg-[#1e2d42]"
            aria-label="切换 Auto 模式"
          >
            <span className="text-[11px] text-[#5b8ab0] select-none">Auto</span>
            {/* 开关轨道 */}
            <span className={`relative inline-flex h-3.5 w-6 flex-shrink-0 rounded-full transition-colors duration-200 ${
              autoMode ? 'bg-[#00c9a7]' : 'bg-[#2a3f5a]'
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
          <button
            className="p-1.5 rounded transition-colors bg-red-500/20 text-red-400 hover:bg-red-500/30"
            onClick={() => cancelChat(currentSessionId)}
            title={t('assistant.stopGeneration')}
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            className={`p-1.5 rounded transition-colors ${chatInput.trim() ? 'bg-[#00c9a7] text-white hover:bg-[#00a98f]' : 'bg-[#1e2d42] text-[#7a9bb8]'}`}
            onClick={handleSendMessage}
            disabled={!chatInput.trim()}
            title={t('assistant.sendMessage')}
          >
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );

  const isEmpty = chatHistory.length === 0 && !isChatting;

  return (
    <div className="flex flex-col bg-[#080d12] flex-shrink-0 border-l border-[#1e2d42] relative h-full" style={{ width: assistantWidth }}>
      <div
        className="absolute left-[-2px] top-0 bottom-0 w-[4.5px] cursor-col-resize hover:bg-[#00c9a7] z-10 transition-colors"
        onMouseDown={handleAssistantResize}
      />
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42] bg-[#0d1117] flex-shrink-0">
        <div className="text-[13px] font-medium truncate flex-1 text-[#c8daea]">{t('assistant.title')}</div>
        <div className="flex items-center space-x-3 text-[#7a9bb8]">
          {!showHistory && chatHistory.length > 0 && (
            <span title={t('assistant.clearHistory')} className="flex items-center cursor-pointer hover:text-red-400" onClick={() => { clearHistory(currentSessionId); showToast(t('assistant.historyCleared'), 'info'); }}>
              <Trash2 size={16} />
            </span>
          )}
          <span title={t('assistant.newChat')} className="cursor-pointer hover:text-[#c8daea]" onClick={() => { newSession(); setShowHistory(false); showToast(t('assistant.newChatOpened'), 'info'); }}><Plus size={16} /></span>
          <span title={t('assistant.openHistory')} className={`cursor-pointer transition-colors ${showHistory ? 'text-[#00c9a7]' : 'hover:text-[#c8daea]'}`} onClick={() => setShowHistory((v) => !v)}><History size={16} /></span>
          <X size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => { setIsAssistantOpen(false); showToast(t('assistant.assistantClosed'), 'info'); }} />
        </div>
      </div>

      {/* ── 会话历史面板（覆盖在聊天区上方）── */}
      {showHistory && (
        <div className="absolute inset-0 top-10 z-20 flex flex-col bg-[#080d12]">
          {/* 历史面板 Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#1e2d42] bg-[#0d1117] flex-shrink-0">
            <button
              className="flex items-center gap-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
              onClick={() => { setShowHistory(false); setConfirmDeleteAll(false); }}
            >
              <ChevronLeft size={14} />
              <span>{t('assistant.backToChat')}</span>
            </button>
            <span className="text-xs text-[#4a6a8a]">{sessions.length} {t('assistant.sessionCount')}</span>
          </div>

          {/* 会话列表 */}
          <div className="flex-1 overflow-auto py-1 min-h-0">
            {sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-[#4a6a8a] text-center px-4 gap-3">
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
                      className={`group flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-[#111922] transition-colors ${
                        isActive ? 'bg-[#0f1f33]' : 'hover:bg-[#0d1a28]'
                      }`}
                      onClick={() => { switchSession(sess.id); setShowHistory(false); }}
                    >
                      <MessageSquare size={13} className={`mt-0.5 flex-shrink-0 ${isActive ? 'text-[#00c9a7]' : 'text-[#4a6a8a]'}`} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-[12px] font-medium truncate leading-tight flex items-center gap-1.5 ${isActive ? 'text-[#c8daea]' : 'text-[#8ab0cc]'}`}>
                          <span className="truncate">{sess.title}</span>
                          {!sess.titleGenerated && (
                            <span className="text-[10px] text-[#4a6a8a] animate-pulse flex-shrink-0">•</span>
                          )}
                          {chattingSessionIds.has(sess.id) && (
                            <RefreshCw size={10} className="animate-spin text-[#00c9a7] flex-shrink-0" />
                          )}
                        </div>
                        <div className="text-[11px] text-[#4a6a8a] mt-0.5">
                          {relTime} · {sess.messages.length} {t('assistant.messageCount')}
                        </div>
                      </div>
                      <button
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-[#4a6a8a] hover:text-red-400 transition-all flex-shrink-0"
                        title={t('assistant.deleteSession')}
                        onClick={(e) => { e.stopPropagation(); deleteSession(sess.id); }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  );
                })
            )}
          </div>

          {/* 清除所有会话按钮 */}
          {sessions.length > 0 && (
            <div className="px-3 py-2 border-t border-[#1e2d42] flex-shrink-0">
              {confirmDeleteAll ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-[#c8daea]">{t('assistant.confirmDeleteAll')}</span>
                  <div className="flex items-center gap-2">
                    <button
                      className="px-2.5 py-1 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                      onClick={() => { setConfirmDeleteAll(false); deleteAllSessions(); setShowHistory(false); showToast(t('assistant.allSessionsDeleted'), 'info'); }}
                    >
                      {t('assistant.confirmYes')}
                    </button>
                    <button
                      className="px-2.5 py-1 text-xs rounded bg-[#1e2d42] text-[#7a9bb8] hover:bg-[#2a3f5a] transition-colors"
                      onClick={() => setConfirmDeleteAll(false)}
                    >
                      {t('assistant.confirmNo')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="w-full flex items-center justify-center gap-2 py-1.5 text-xs text-[#7a9bb8] hover:text-red-400 hover:bg-[#1e2d42] rounded transition-colors"
                  onClick={() => setConfirmDeleteAll(true)}
                >
                  <Trash2 size={13} />
                  <span>{t('assistant.deleteAllSessions')}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {isEmpty ? (
        /* ── 空状态：提示文字 + 输入框垂直居中，紧凑排列 ── */
        <div className="flex flex-col flex-1 items-center justify-center gap-5 px-4 pb-6">
          <div className="flex flex-col items-center text-[#7a9bb8] text-center">
            <DatabaseZap size={28} className="mb-3 opacity-25" />
            {connectedConfigs.length === 0 ? (
              <>
                <p className="text-sm">{t('assistant.noConnectedModel')}</p>
                <p className="text-xs mt-1 opacity-60 mb-4">{t('assistant.noConnectedModelHint')}</p>
                <button
                  onClick={onOpenSettings}
                  className="px-4 py-1.5 text-xs bg-[#009e84] hover:bg-[#007a62] text-white rounded"
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
        <>
          <div className="flex-1 overflow-auto p-4 space-y-6 min-h-0">
            {chatHistory.map((msg, idx) =>
              msg.role === 'user' ? (
                <div key={idx} className="flex flex-col items-end">
                  <div className="bg-[#1e2d42] text-[#c8daea] px-3 py-2 rounded-lg max-w-[90%] text-[13px] leading-relaxed">
                    {msg.content}
                  </div>
                </div>
              ) : msg.role === 'system' ? null : (
                <AssistantMessage
                  key={idx}
                  content={msg.content}
                  thinkingContent={msg.thinkingContent}
                />
              )
            )}
            {isChatting && <StreamingMessage sessionId={currentSessionId} />}

              {/* 权限确认面板（isChatting=true 时，ACP native 路径） */}
              {pendingPermission && (
                <ElicitationPanel
                  type="permission"
                  request={pendingPermission}
                  onRespond={(optionId, cancelled) =>
                    respondPermission(currentSessionId, pendingPermission.id, optionId, cancelled)
                  }
                />
              )}

              {/* 选项选择面板（文字检测路径：mid-stream 或 turn 结束后均可显示） */}
              {pendingElicitation && (
                <ElicitationPanel
                  type="elicitation"
                  request={pendingElicitation}
                  onSelect={(text) => respondElicitation(currentSessionId, text)}
                  onCancel={() => clearElicitation(currentSessionId)}
                />
              )}

            <div ref={chatEndRef} />
          </div>

          {/* SQL Diff 确认面板 */}
          {pendingDiff && (
            <DiffPanel
              proposal={pendingDiff}
              onApply={() => { applyDiff(); invoke('mcp_diff_respond', { confirmed: true }).catch(() => {}); }}
              onCancel={() => { cancelDiff(); invoke('mcp_diff_respond', { confirmed: false }).catch(() => {}); }}
            />
          )}

          {/* 连接切换确认 banner */}
          {pendingConnectionSwitch && (
            <div className="mx-3 mb-2 p-2 bg-[#1a2639] border border-[#2a3f5a] rounded-lg flex-shrink-0">
              <p className="text-xs text-[#7a9bb8] mb-2">
                {t('assistant.connectionSwitchTitle')}
              </p>
              <p className="text-[11px] text-[#5b8ab0] mb-2">
                {t('assistant.connectionSwitchDesc', {
                  old: pendingConnectionSwitch.oldConnectionName,
                  new: pendingConnectionSwitch.newConnectionName,
                })}
              </p>
              <div className="flex gap-2">
                <button
                  className="flex-1 text-[11px] px-2 py-1 rounded bg-[#111922] border border-[#2a3f5a] text-[#7a9bb8] hover:text-[#c8daea] hover:border-[#3a4f6a]"
                  onClick={() => {
                    setLinkedConnectionId(pendingConnectionSwitch.oldConnectionId);
                    setPendingConnectionSwitch(null);
                  }}
                >
                  {t('assistant.keepLastConnection', { name: pendingConnectionSwitch.oldConnectionName })}
                </button>
                <button
                  className="flex-1 text-[11px] px-2 py-1 rounded bg-[#003d2f] border border-[#00c9a7] text-[#00c9a7] hover:bg-[#004d3a]"
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
          <div className="p-3 border-t border-[#1e2d42] flex-shrink-0">
            {renderInputBox()}
          </div>
        </>
      )}
    </div>
  );
};
