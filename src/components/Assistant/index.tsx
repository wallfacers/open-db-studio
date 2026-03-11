import React, { useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, History, X, DatabaseZap, ChevronDown, Send, Trash2 } from 'lucide-react';
import { useAiStore, useConnectionStore, useQueryStore } from '../../store';

interface AssistantProps {
  isAssistantOpen: boolean;
  assistantWidth: number;
  handleAssistantResize: (e: React.MouseEvent) => void;
  setIsAssistantOpen: (isOpen: boolean) => void;
  showToast: (msg: string) => void;
}

function extractSqlFromReply(reply: string): string | null {
  const match = reply.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : null;
}

export const Assistant: React.FC<AssistantProps> = ({
  isAssistantOpen,
  assistantWidth,
  handleAssistantResize,
  setIsAssistantOpen,
  showToast,
}) => {
  const { t } = useTranslation();
  const { chatHistory, isChatting, sendChat, clearHistory, configs, activeConfigId, setActiveConfigId, loadConfigs } = useAiStore();
  const { activeConnectionId } = useConnectionStore();
  const { setSql, activeTabId } = useQueryStore();

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
    await sendChat(prompt, activeConnectionId);
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
          <span title={t('assistant.clearHistory')} className="flex items-center cursor-pointer hover:text-red-400" onClick={() => { clearHistory(); showToast(t('assistant.historyCleared')); }}>
            <Trash2 size={16} />
          </span>
          <Plus size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => { clearHistory(); showToast(t('assistant.newChatOpened')); }} />
          <History size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => showToast(t('assistant.openHistory'))} />
          <X size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => { setIsAssistantOpen(false); showToast(t('assistant.assistantClosed')); }} />
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
          const extractedSql = extractSqlFromReply(msg.content);
          return (
            <div key={idx} className="flex flex-col items-start">
              <div className="text-[#c8daea] text-[13px] space-y-2 w-full">
                {extractedSql ? (
                  <>
                    <div className="bg-[#111922] border border-[#1e2d42] rounded p-2 font-mono text-xs text-[#569cd6] break-all whitespace-pre-wrap">
                      {extractedSql}
                    </div>
                    <button
                      className="text-xs px-2 py-1 bg-[#1e2d42] hover:bg-[#2a3f5a] rounded border border-[#2a3f5a] text-[#00c9a7] transition-colors"
                      onClick={() => { setSql(activeTabId, extractedSql); showToast(t('assistant.sqlInserted')); }}
                    >
                      {t('assistant.insertToEditor')}
                    </button>
                  </>
                ) : (
                  <p className="leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                )}
              </div>
            </div>
          );
        })}
        {isChatting && (
          <div className="flex flex-col items-start">
            <div className="text-[#7a9bb8] text-[13px] animate-pulse">{t('assistant.generatingSql')}</div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-3 border-t border-[#1e2d42]">
        <div className="bg-[#111922] border border-[#2a3f5a] rounded-lg p-2 flex flex-col focus-within:border-[#00c9a7] transition-colors">
          <div className="flex items-center text-xs text-[#7a9bb8] mb-2 cursor-pointer hover:text-[#c8daea] w-fit" onClick={() => showToast(t('assistant.selectContext'))}>
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
            {/* AI 生成 SQL 标签 */}
            <div className="flex items-center text-xs text-[#7a9bb8] bg-[#151d28] px-2 py-1 rounded border border-[#2a3f5a]">
              <span>{t('assistant.aiGenerateSql')}</span>
            </div>

            {/* 模型选择器 */}
            <div className="relative ml-1">
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
