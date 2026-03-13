// src/components/Assistant/AssistantToggleTab.tsx
import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../store/appStore';

export const AssistantToggleTab: React.FC = () => {
  const isOpen = useAppStore((s) => s.isAssistantOpen);
  const setOpen = useAppStore((s) => s.setAssistantOpen);

  return (
    <button
      onClick={() => setOpen(!isOpen)}
      className="
        flex items-center justify-center
        w-5 self-stretch flex-shrink-0
        bg-[#111922] border-l border-[#1e2d42]
        text-[#4a6a8a] hover:text-[#00c9a7] hover:bg-[#1a2639]
        transition-colors duration-150 active:scale-110
        cursor-pointer select-none
      "
      title={isOpen ? '收起 AI 助手' : '打开 AI 助手'}
      aria-label={isOpen ? '收起 AI 助手' : '打开 AI 助手'}
    >
      {isOpen ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
    </button>
  );
};
