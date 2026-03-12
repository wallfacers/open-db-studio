import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, History, X, DatabaseZap, ChevronDown, Send, Trash2, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ThinkingBlock } from './ThinkingBlock';
import { DiffPanel } from './DiffPanel';
import { useAiStore, useConnectionStore } from '../../store';
import { useQueryStore } from '../../store/queryStore';
import type { ToastLevel } from '../Toast';

const CodeBlock: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    // TODO: 后续支持模型直接操作 SQL 编辑器
    <div className="my-2 rounded overflow-hidden border border-[#1e2d42]">
      {/* 顶部栏 */}
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
      {/* 代码内容 */}
      <SyntaxHighlighter
        style={oneDark}
        language={language || 'plaintext'}
        useInlineStyles={false}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: 0,
          fontSize: '12px',
          background: '#0d1117',
          padding: '12px',
        }}
        codeTagProps={{ style: { background: 'transparent' } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
};

interface AssistantProps {
  isAssistantOpen: boolean;
  assistantWidth: number;
  handleAssistantResize: (e: React.MouseEvent) => void;
  setIsAssistantOpen: (isOpen: boolean) => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}


export const Assistant: React.FC<AssistantProps> = ({
  isAssistantOpen,
  assistantWidth,
  handleAssistantResize,
  setIsAssistantOpen,
  showToast,
}) => {
  const { t } = useTranslation();
  const { chatHistory, isChatting, sendChatStream, clearHistory, configs, activeConfigId, setActiveConfigId, loadConfigs } = useAiStore();
  const { activeConnectionId } = useConnectionStore();
  const { pendingDiff, applyDiff, cancelDiff } = useQueryStore();
  // TODO: 未来支持 AI 直接写入编辑器时，在此处补充解构 setSql / activeTabId

  const [chatInput, setChatInput] = useState('');
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistory]);

  useEffect(() => {
    loadConfigs();
  }, []);

  const handleSendMessage = async () => {
    if (!chatInput.trim() || isChatting) return;
    const prompt = chatInput.trim();
    setChatInput('');
    await sendChatStream(prompt, activeConnectionId);
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
      ></div>
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
        {chatHistory.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-[#7a9bb8] text-center pt-8">
            <DatabaseZap size={32} className="mb-3 opacity-30" />
            <p className="text-sm">{t('assistant.inputDescription')}</p>
            <p className="text-xs mt-1 opacity-60">{t('assistant.aiWillGenerateSql')}</p>
          </div>
        )}
        {chatHistory.map((msg, idx) => {
          if (msg.role === 'user') {
            return (
              <div key={idx} className="flex flex-col items-end">
                <div className="bg-[#1e2d42] text-[#c8daea] px-3 py-2 rounded-lg max-w-[90%] text-[13px] leading-relaxed">
                  {msg.content}
                </div>
              </div>
            );
          }
          // assistant message
          return (
            <div key={idx} className="flex flex-col items-start">
              <div className="text-[#c8daea] text-[13px] w-full">
                {/* 思考块 */}
                <ThinkingBlock
                  content={msg.thinkingContent ?? ''}
                  isStreaming={msg.isStreaming ?? false}
                />
                {/* 正文 */}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className ?? '');
                      const language = match ? match[1] : '';
                      const isBlock = Boolean(match);
                      if (isBlock) {
                        return (
                          <CodeBlock
                            language={language}
                            code={String(children).replace(/\n$/, '')}
                          />
                        );
                      }
                      return (
                        <code className="bg-[#111922] text-[#569cd6] px-1 py-0.5 rounded text-xs font-mono" {...props}>
                          {children}
                        </code>
                      );
                    },
                    p({ children }) {
                      return <p className="leading-relaxed mb-2 last:mb-0">{children}</p>;
                    },
                    ul({ children }) {
                      return <ul className="list-disc list-inside space-y-1 mb-2 pl-2">{children}</ul>;
                    },
                    ol({ children }) {
                      return <ol className="list-decimal list-inside space-y-1 mb-2 pl-2">{children}</ol>;
                    },
                    li({ children }) {
                      return <li className="text-[#c8daea]">{children}</li>;
                    },
                    h1({ children }) {
                      return <h1 className="text-base font-semibold text-[#e8f4fd] mb-2 mt-3 first:mt-0">{children}</h1>;
                    },
                    h2({ children }) {
                      return <h2 className="text-sm font-semibold text-[#e8f4fd] mb-2 mt-3 first:mt-0">{children}</h2>;
                    },
                    h3({ children }) {
                      return <h3 className="text-sm font-medium text-[#e8f4fd] mb-1 mt-2 first:mt-0">{children}</h3>;
                    },
                    strong({ children }) {
                      return <strong className="font-semibold text-[#e8f4fd]">{children}</strong>;
                    },
                    blockquote({ children }) {
                      return <blockquote className="border-l-2 border-[#2a3f5a] pl-3 text-[#7a9bb8] italic my-2">{children}</blockquote>;
                    },
                    table({ children }) {
                      return (
                        <div className="overflow-x-auto my-2">
                          <table className="text-xs border-collapse w-full">{children}</table>
                        </div>
                      );
                    },
                    th({ children }) {
                      return <th className="border border-[#1e2d42] bg-[#111922] px-2 py-1 text-left font-medium text-[#c8daea]">{children}</th>;
                    },
                    td({ children }) {
                      return <td className="border border-[#1e2d42] px-2 py-1 text-[#c8daea]">{children}</td>;
                    },
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
                {/* 等待首词动画：有 isStreaming 但还没有任何内容 */}
                {msg.isStreaming && !msg.content && !msg.thinkingContent && (
                  <div className="flex items-center gap-1 py-1">
                    <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7]" />
                    <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7]" />
                    <span className="ai-dot w-1.5 h-1.5 rounded-full bg-[#00c9a7]" />
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={chatEndRef} />
      </div>

      {/* SQL Diff 确认面板 */}
      {pendingDiff && (
        <DiffPanel
          proposal={pendingDiff}
          onApply={applyDiff}
          onCancel={cancelDiff}
        />
      )}

      {/* Input Area */}
      <div className="p-3 border-t border-[#1e2d42]">
        <div className="bg-[#111922] border border-[#2a3f5a] rounded-lg p-2 flex flex-col focus-within:border-[#00c9a7] transition-colors">
          <div className="flex items-center text-xs text-[#7a9bb8] mb-2 cursor-pointer hover:text-[#c8daea] w-fit" onClick={() => showToast(t('assistant.selectContext'), 'info')}>
            <DatabaseZap size={12} className="mr-1 text-[#00c9a7]" />
            <span>{activeConnectionId ? `${t('assistant.connection')}${activeConnectionId}` : t('assistant.noConnectionSelected')}</span>
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
                      })()
                  }
                </span>
                <ChevronDown size={12} className="ml-1 flex-shrink-0" />
              </div>

              {isModelMenuOpen && (
                <div className="absolute left-0 bottom-full mb-1 w-52 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg z-50 py-1">
                  {configs.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-[#7a9bb8]">
                      {t('assistant.noModelHint')}
                    </div>
                  ) : (
                    configs.map((c) => (
                      <div
                        key={c.id}
                        className={`px-3 py-1.5 hover:bg-[#1e2d42] cursor-pointer flex items-center justify-between ${
                          (activeConfigId === c.id || (!activeConfigId && c.is_default))
                            ? 'text-[#009e84]'
                            : 'text-[#c8daea]'
                        }`}
                        onClick={() => { setActiveConfigId(c.id); setIsModelMenuOpen(false); }}
                      >
                        <span className="text-xs truncate flex-1">
                          {c.is_default ? `★ ${c.name}` : c.name}
                        </span>
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
