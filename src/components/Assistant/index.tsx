import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, History, X, DatabaseZap, ChevronDown, Send } from 'lucide-react';
import { useAiStore, useConnectionStore, useQueryStore } from '../../store';

interface AssistantProps {
  isAssistantOpen: boolean;
  assistantWidth: number;
  handleAssistantResize: (e: React.MouseEvent) => void;
  setIsAssistantOpen: (isOpen: boolean) => void;
  showToast: (msg: string) => void;
  chatMessages: any[];
  setChatMessages: (msgs: any) => void;
  chatEndRef: React.RefObject<HTMLDivElement>;
  chatInput: string;
  setChatInput: (input: string) => void;
  isModelMenuOpen: boolean;
  setIsModelMenuOpen: (isOpen: boolean) => void;
}

export const Assistant: React.FC<AssistantProps> = ({
  isAssistantOpen,
  assistantWidth,
  handleAssistantResize,
  setIsAssistantOpen,
  showToast,
  chatMessages,
  setChatMessages,
  chatEndRef,
  chatInput,
  setChatInput,
  isModelMenuOpen,
  setIsModelMenuOpen,
}) => {
  const { t } = useTranslation();
  const { generateSql, isGenerating } = useAiStore();
  const { activeConnectionId } = useConnectionStore();
  const { setSql, activeTabId } = useQueryStore();

  const handleSendMessage = async () => {
    if (!chatInput.trim() || isGenerating) return;
    const prompt = chatInput;
    setChatInput('');

    setChatMessages((prev: any[]) => [...prev, { role: 'user', content: prompt }]);

    if (!activeConnectionId) {
      setChatMessages((prev: any[]) => [
        ...prev,
        { role: 'ai', content: <div className="text-yellow-400 text-[13px]">{t('assistant.selectConnectionFirst')}</div> },
      ]);
      return;
    }

    setChatMessages((prev: any[]) => [
      ...prev,
      { role: 'ai', content: <div className="text-[#7a9bb8] text-[13px] animate-pulse">{t('assistant.generatingSql')}</div> },
    ]);

    try {
      const sql = await generateSql(prompt, activeConnectionId);
      setSql(activeTabId, sql);
      setChatMessages((prev: any[]) => [
        ...prev.slice(0, -1),
        {
          role: 'ai',
          content: (
            <div className="text-[#c8daea] text-[13px] space-y-2 w-full">
              <p>{t('assistant.sqlGeneratedAndInjected')}</p>
              <div className="bg-[#111922] border border-[#1e2d42] rounded p-2 font-mono text-xs text-[#569cd6] break-all whitespace-pre-wrap">
                {sql}
              </div>
            </div>
          ),
        },
      ]);
    } catch (e) {
      setChatMessages((prev: any[]) => [
        ...prev.slice(0, -1),
        { role: 'ai', content: <div className="text-red-400 text-[13px]">{t('assistant.generationFailed')}{String(e)}</div> },
      ]);
    }
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
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42]">
        <div className="text-[13px] font-medium truncate flex-1 text-[#c8daea]">{t('assistant.title')}</div>
        <div className="flex items-center space-x-3 text-[#7a9bb8]">
          <Plus size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => { setChatMessages([]); showToast(t('assistant.newChatOpened')); }} />
          <History size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => showToast(t('assistant.openHistory'))} />
          <X size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => { setIsAssistantOpen(false); showToast(t('assistant.assistantClosed')); }} />
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {chatMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-[#7a9bb8] text-center pt-8">
            <DatabaseZap size={32} className="mb-3 opacity-30" />
            <p className="text-sm">{t('assistant.inputDescription')}</p>
            <p className="text-xs mt-1 opacity-60">{t('assistant.aiWillGenerateSql')}</p>
          </div>
        )}
        {chatMessages.map((msg: any, idx: number) => (
          <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            {msg.role === 'user' ? (
              <div className="bg-[#1e2d42] text-[#c8daea] px-3 py-2 rounded-lg max-w-[90%] text-[13px] leading-relaxed">
                {msg.content}
              </div>
            ) : (
              msg.content
            )}
          </div>
        ))}
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
            disabled={isGenerating}
          />
          <div className="flex items-center justify-between mt-2 relative">
            <div
              className="flex items-center text-xs text-[#7a9bb8] cursor-pointer hover:text-[#c8daea] bg-[#151d28] px-2 py-1 rounded border border-[#2a3f5a]"
              onClick={(e) => { e.stopPropagation(); setIsModelMenuOpen(!isModelMenuOpen); }}
            >
              <span>{t('assistant.aiGenerateSql')}</span>
              <ChevronDown size={12} className="ml-1" />
            </div>

            {isModelMenuOpen && (
              <div className="absolute left-0 bottom-full mb-1 w-48 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg z-50 py-1">
                <div className="px-3 py-1.5 hover:bg-[#1e2d42] cursor-pointer text-[#c8daea]" onClick={() => setIsModelMenuOpen(false)}>{t('assistant.generateSql')}</div>
              </div>
            )}

            <button
              className={`p-1.5 rounded transition-colors ${chatInput.trim() && !isGenerating ? 'bg-[#00c9a7] text-white hover:bg-[#00a98f]' : 'bg-[#1e2d42] text-[#7a9bb8]'}`}
              onClick={handleSendMessage}
              disabled={!chatInput.trim() || isGenerating}
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
