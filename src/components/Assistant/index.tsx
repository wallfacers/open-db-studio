import React, { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, History, X, DatabaseZap, ChevronDown, Send, Trash2, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ThinkingBlock } from './ThinkingBlock';
import { DiffPanel } from './DiffPanel';
import { useAiStore } from '../../store';
import { useConnectionStore } from '../../store/connectionStore';
import { useQueryStore } from '../../store/queryStore';
import type { ToastLevel } from '../Toast';

// ── 代码块 ──────────────────────────────────────────────────────────────────
const CodeBlock: React.FC<{ language: string; code: string }> = memo(({ language, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="my-2 rounded overflow-hidden border border-[#1e2d42]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-[#1e2d42]">
        <span className="text-xs text-[#7a9bb8] font-mono">{language || 'plaintext'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
        >
          {copied ? (
            <><Check size={12} className="text-[#00c9a7]" /><span className="text-[#00c9a7]">已复制</span></>
          ) : (
            <><Copy size={12} /><span>复制</span></>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        style={oneDark}
        language={language || 'plaintext'}
        useInlineStyles={false}
        PreTag="div"
        customStyle={{ margin: 0, borderRadius: 0, fontSize: '12px', background: '#0d1117', padding: '12px' }}
        codeTagProps={{ style: { background: 'transparent' } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
});

// ── Markdown 渲染器（已完成消息专用，用 memo 防止无关重渲染）───────────────
const mdComponents = {
  code({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const language = match ? match[1] : '';
    if (match) {
      return <CodeBlock language={language} code={String(children).replace(/\n$/, '')} />;
    }
    return (
      <code className="bg-[#111922] text-[#569cd6] px-1 py-0.5 rounded text-xs font-mono" {...props}>
        {children}
      </code>
    );
  },
  p({ children }: React.ComponentPropsWithoutRef<'p'>) {
    return <p className="leading-relaxed mb-2 last:mb-0">{children}</p>;
  },
  ul({ children }: React.ComponentPropsWithoutRef<'ul'>) {
    return <ul className="list-disc list-inside space-y-1 mb-2 pl-2">{children}</ul>;
  },
  ol({ children }: React.ComponentPropsWithoutRef<'ol'>) {
    return <ol className="list-decimal list-inside space-y-1 mb-2 pl-2">{children}</ol>;
  },
  li({ children }: React.ComponentPropsWithoutRef<'li'>) {
    return <li className="text-[#c8daea]">{children}</li>;
  },
  h1({ children }: React.ComponentPropsWithoutRef<'h1'>) {
    return <h1 className="text-base font-semibold text-[#e8f4fd] mb-2 mt-3 first:mt-0">{children}</h1>;
  },
  h2({ children }: React.ComponentPropsWithoutRef<'h2'>) {
    return <h2 className="text-sm font-semibold text-[#e8f4fd] mb-2 mt-3 first:mt-0">{children}</h2>;
  },
  h3({ children }: React.ComponentPropsWithoutRef<'h3'>) {
    return <h3 className="text-sm font-medium text-[#e8f4fd] mb-1 mt-2 first:mt-0">{children}</h3>;
  },
  strong({ children }: React.ComponentPropsWithoutRef<'strong'>) {
    return <strong className="font-semibold text-[#e8f4fd]">{children}</strong>;
  },
  blockquote({ children }: React.ComponentPropsWithoutRef<'blockquote'>) {
    return <blockquote className="border-l-2 border-[#2a3f5a] pl-3 text-[#7a9bb8] italic my-2">{children}</blockquote>;
  },
  table({ children }: React.ComponentPropsWithoutRef<'table'>) {
    return (
      <div className="overflow-x-auto my-2">
        <table className="text-xs border-collapse w-full">{children}</table>
      </div>
    );
  },
  th({ children }: React.ComponentPropsWithoutRef<'th'>) {
    return <th className="border border-[#1e2d42] bg-[#111922] px-2 py-1 text-left font-medium text-[#c8daea]">{children}</th>;
  },
  td({ children }: React.ComponentPropsWithoutRef<'td'>) {
    return <td className="border border-[#1e2d42] px-2 py-1 text-[#c8daea]">{children}</td>;
  },
};

const MarkdownContent: React.FC<{ content: string }> = memo(({ content }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
    {content}
  </ReactMarkdown>
));

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

// ── 流式消息（独立组件，用 Zustand selector 精准订阅，不影响历史消息）────────
const StreamingMessage: React.FC = () => {
  const content = useAiStore((s) => s.streamingContent);
  const thinking = useAiStore((s) => s.streamingThinkingContent);
  const sessionStatus = useAiStore((s) => s.sessionStatus);

  return (
    <div className="flex flex-col items-start">
      <div className="text-[#c8daea] text-[13px] w-full">
        {thinking && <ThinkingBlock content={thinking} isStreaming={true} />}
        {content ? (
          <MarkdownContent content={content} />
        ) : (
          <div className="flex items-center gap-2 py-1">
            {sessionStatus ? (
              <>
                <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7] flex-shrink-0" />
                <span className="text-xs text-[#5b8ab0] animate-pulse">{sessionStatus}</span>
              </>
            ) : (
              <>
                <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7]" />
                <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7]" />
                <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7]" />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ── 主面板 ──────────────────────────────────────────────────────────────────
interface AssistantProps {
  isAssistantOpen: boolean;
  assistantWidth: number;
  handleAssistantResize: (e: React.MouseEvent) => void;
  setIsAssistantOpen: (isOpen: boolean) => void;
  showToast: (msg: string, level?: ToastLevel) => void;
  activeConnectionId: number | null;
}

export const Assistant: React.FC<AssistantProps> = ({
  isAssistantOpen,
  assistantWidth,
  handleAssistantResize,
  setIsAssistantOpen,
  showToast,
  activeConnectionId,
}) => {
  const { t } = useTranslation();
  // 精准订阅：只取主面板需要的字段，不含 streamingContent（由 StreamingMessage 自己订阅）
  const chatHistory = useAiStore((s) => s.chatHistory);
  const isChatting = useAiStore((s) => s.isChatting);
  const activeToolName = useAiStore((s) => s.activeToolName);
  const { sendAgentChatStream, clearHistory, configs, activeConfigId, setActiveConfigId, loadConfigs } = useAiStore();
  const { pendingDiff, applyDiff, cancelDiff } = useQueryStore();
  const { connections } = useConnectionStore();
  const activeConnectionName = activeConnectionId
    ? (connections.find(c => c.id === activeConnectionId)?.name ?? `#${activeConnectionId}`)
    : null;

  const [chatInput, setChatInput] = useState('');
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // 新消息或流式内容更新时自动滚底
  const streamingContent = useAiStore((s) => s.streamingContent);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, streamingContent]);

  useEffect(() => {
    loadConfigs();
  }, []);

  const handleSendMessage = async () => {
    if (!chatInput.trim() || isChatting) return;
    const prompt = chatInput.trim();
    setChatInput('');
    await sendAgentChatStream(prompt, activeConnectionId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  if (!isAssistantOpen) return null;

  return (
    <div className="flex flex-col bg-[#080d12] flex-shrink-0 border-l border-[#1e2d42] relative" style={{ width: assistantWidth }}>
      <div
        className="absolute left-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#00c9a7] z-10 transition-colors"
        onMouseDown={handleAssistantResize}
      />
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42] bg-[#0d1117]">
        <div className="text-[13px] font-medium truncate flex-1 text-[#c8daea]">{t('assistant.title')}</div>
        <div className="flex items-center space-x-3 text-[#7a9bb8]">
          <span title={t('assistant.clearHistory')} className="flex items-center cursor-pointer hover:text-red-400" onClick={() => { clearHistory(); showToast(t('assistant.historyCleared'), 'info'); }}>
            <Trash2 size={16} />
          </span>
          <Plus size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => { clearHistory(); showToast(t('assistant.newChatOpened'), 'info'); }} />
          <History size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => showToast(t('assistant.openHistory'), 'info')} />
          <X size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => { setIsAssistantOpen(false); showToast(t('assistant.assistantClosed'), 'info'); }} />
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {chatHistory.length === 0 && !isChatting && (
          <div className="flex flex-col items-center justify-center h-full text-[#7a9bb8] text-center pt-8">
            <DatabaseZap size={32} className="mb-3 opacity-30" />
            <p className="text-sm">{t('assistant.inputDescription')}</p>
            <p className="text-xs mt-1 opacity-60">{t('assistant.aiWillGenerateSql')}</p>
          </div>
        )}

        {/* 已完成的历史消息（memo 隔离，流式中完全静止） */}
        {chatHistory.map((msg, idx) =>
          msg.role === 'user' ? (
            <div key={idx} className="flex flex-col items-end">
              <div className="bg-[#1e2d42] text-[#c8daea] px-3 py-2 rounded-lg max-w-[90%] text-[13px] leading-relaxed">
                {msg.content}
              </div>
            </div>
          ) : (
            <AssistantMessage
              key={idx}
              content={msg.content}
              thinkingContent={msg.thinkingContent}
            />
          )
        )}

        {/* 当前流式消息（仅 isChatting 时显示，独立订阅不污染历史消息） */}
        {isChatting && <StreamingMessage />}

        {/* 工具调用状态提示 */}
        {isChatting && activeToolName && (
          <div className="text-xs text-[#5b8ab0] px-3 py-1 italic">
            {t('assistant.callingTool', { name: activeToolName })}
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* SQL Diff 确认面板 */}
      {pendingDiff && (
        <DiffPanel proposal={pendingDiff} onApply={applyDiff} onCancel={cancelDiff} />
      )}

      {/* Input Area */}
      <div className="p-3 border-t border-[#1e2d42]">
        <div className="bg-[#111922] border border-[#2a3f5a] rounded-lg p-2 flex flex-col focus-within:border-[#00c9a7] transition-colors">
          <div className="flex items-center text-xs text-[#7a9bb8] mb-2 cursor-pointer hover:text-[#c8daea] w-fit" onClick={() => showToast(t('assistant.selectContext'), 'info')}>
            <DatabaseZap size={12} className="mr-1 text-[#00c9a7]" />
            <span>{activeConnectionName ?? t('assistant.noConnectionSelected')}</span>
            <ChevronDown size={12} className="ml-1" />
          </div>
          <textarea
            className="bg-transparent text-[13px] text-[#c8daea] outline-none resize-none h-16 w-full placeholder-[#7a9bb8]"
            placeholder={t('assistant.inputPlaceholder')}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isChatting}
          />
          <div className="flex items-center justify-between mt-2 relative">
            {/* 模型选择器 */}
            <div className="relative">
              <div
                className="flex items-center text-xs text-[#7a9bb8] cursor-pointer hover:text-[#c8daea] bg-[#151d28] px-2 py-1 rounded border border-[#2a3f5a]"
                onClick={(e) => { e.stopPropagation(); setIsModelMenuOpen(!isModelMenuOpen); }}
              >
                <span className="max-w-[96px] truncate">
                  {configs.length === 0
                    ? t('assistant.noModelConfigured')
                    : (() => {
                        const active = configs.find((c) => c.id === activeConfigId)
                          ?? configs.find((c) => c.is_default)
                          ?? configs[0];
                        return active?.name ?? t('assistant.selectModel');
                      })()}
                </span>
                <ChevronDown size={12} className="ml-1 flex-shrink-0" />
              </div>

              {isModelMenuOpen && (
                <div className="absolute left-0 bottom-full mb-1 w-52 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg z-50 py-1">
                  {configs.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-[#7a9bb8]">{t('assistant.noModelHint')}</div>
                  ) : (
                    configs.map((c) => (
                      <div
                        key={c.id}
                        className={`px-3 py-1.5 hover:bg-[#1e2d42] cursor-pointer flex items-center justify-between ${
                          (activeConfigId === c.id || (!activeConfigId && c.is_default)) ? 'text-[#009e84]' : 'text-[#c8daea]'
                        }`}
                        onClick={() => { setActiveConfigId(c.id); setIsModelMenuOpen(false); }}
                      >
                        <span className="text-xs truncate flex-1">{c.is_default ? `★ ${c.name}` : c.name}</span>
                        <span className={`ml-2 w-2 h-2 rounded-full flex-shrink-0 ${
                          c.test_status === 'success' ? 'bg-green-400' :
                          c.test_status === 'fail' ? 'bg-red-400' : 'bg-gray-600'
                        }`} />
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            <button
              className={`p-1.5 rounded transition-colors ${chatInput.trim() && !isChatting ? 'bg-[#00c9a7] text-white hover:bg-[#00a98f]' : 'bg-[#1e2d42] text-[#7a9bb8]'}`}
              onClick={handleSendMessage}
              disabled={!chatInput.trim() || isChatting}
              title={t('assistant.sendMessage')}
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
