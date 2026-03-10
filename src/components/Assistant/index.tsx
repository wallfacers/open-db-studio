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
      { role: 'ai', content: <div className="text-[#858585] text-[13px] animate-pulse">{t('assistant.generatingSql')}</div> },
    ]);

    try {
      const sql = await generateSql(prompt, activeConnectionId);
      setSql(activeTabId, sql);
      setChatMessages((prev: any[]) => [
        ...prev.slice(0, -1),
        {
          role: 'ai',
          content: (
            <div className="text-[#d4d4d4] text-[13px] space-y-2 w-full">
              <p>{t('assistant.sqlGeneratedAndInjected')}</p>
              <div className="bg-[#1e1e1e] border border-[#2b2b2b] rounded p-2 font-mono text-xs text-[#569cd6] break-all whitespace-pre-wrap">
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
    <div className="flex flex-col bg-[#141414] flex-shrink-0 border-l border-[#2b2b2b] relative" style={{ width: assistantWidth }}>
      <div
        className="absolute left-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#3794ff] z-10 transition-colors"
        onMouseDown={handleAssistantResize}
      ></div>
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#2b2b2b]">
        <div className="text-[13px] font-medium truncate flex-1 text-[#d4d4d4]">{t('assistant.title')}</div>
        <div className="flex items-center space-x-3 text-[#858585]">
          <Plus size={16} className="cursor-pointer hover:text-[#d4d4d4]" onClick={() => { setChatMessages([]); showToast(t('assistant.newChatOpened')); }} />
          <History size={16} className="cursor-pointer hover:text-[#d4d4d4]" onClick={() => showToast(t('assistant.openHistory'))} />
          <X size={16} className="cursor-pointer hover:text-[#d4d4d4]" onClick={() => { setIsAssistantOpen(false); showToast(t('assistant.assistantClosed')); }} />
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {chatMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-[#858585] text-center pt-8">
            <DatabaseZap size={32} className="mb-3 opacity-30" />
            <p className="text-sm">{t('assistant.inputDescription')}</p>
            <p className="text-xs mt-1 opacity-60">{t('assistant.aiWillGenerateSql')}</p>
          </div>
        )}
        {chatMessages.map((msg: any, idx: number) => (
          <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            {msg.role === 'user' ? (
              <div className="bg-[#2b2b2b] text-[#d4d4d4] px-3 py-2 rounded-lg max-w-[90%] text-[13px] leading-relaxed">
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
      <div className="p-3 border-t border-[#2b2b2b]">
        <div className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg p-2 flex flex-col focus-within:border-[#3794ff] transition-colors">
          <div className="flex items-center text-xs text-[#858585] mb-2 cursor-pointer hover:text-[#d4d4d4] w-fit" onClick={() => showToast(t('assistant.selectContext'))}>
            <DatabaseZap size={12} className="mr-1 text-[#3794ff]" />
            <span>{activeConnectionId ? `${t('assistant.connection')}${activeConnectionId}` : t('assistant.noConnectionSelected')}</span>
            <ChevronDown size={12} className="ml-1" />
          </div>
          <textarea
            className="bg-transparent text-[13px] text-[#d4d4d4] outline-none resize-none h-16 w-full placeholder-[#858585]"
            placeholder={t('assistant.inputPlaceholder')}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isGenerating}
          />
          <div className="flex items-center justify-between mt-2 relative">
            <div
              className="flex items-center text-xs text-[#858585] cursor-pointer hover:text-[#d4d4d4] bg-[#252526] px-2 py-1 rounded border border-[#3c3c3c]"
              onClick={(e) => { e.stopPropagation(); setIsModelMenuOpen(!isModelMenuOpen); }}
            >
              <span>{t('assistant.aiGenerateSql')}</span>
              <ChevronDown size={12} className="ml-1" />
            </div>

            {isModelMenuOpen && (
              <div className="absolute left-0 bottom-full mb-1 w-48 bg-[#252526] border border-[#3c3c3c] rounded shadow-lg z-50 py-1">
                <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4]" onClick={() => setIsModelMenuOpen(false)}>{t('assistant.generateSql')}</div>
              </div>
            )}

            <button
              className={`p-1.5 rounded transition-colors ${chatInput.trim() && !isGenerating ? 'bg-[#3794ff] text-white hover:bg-[#2b7cdb]' : 'bg-[#2b2b2b] text-[#858585]'}`}
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
