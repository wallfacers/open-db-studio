import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';

interface ThinkingBlockProps {
  content: string;
  isStreaming: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ content, isStreaming }) => {
  const [expanded, setExpanded] = useState(true);

  // 流式结束后自动折叠
  useEffect(() => {
    if (!isStreaming) {
      setExpanded(false);
    }
  }, [isStreaming]);

  // 非流式且无内容时不显示
  if (!content && !isStreaming) return null;

  return (
    <div className="mb-2 border border-[#2a3f5a] rounded bg-[#0d1520]">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Brain size={12} className="text-[#00c9a7] flex-shrink-0" />
        <span className="flex-1 text-left">
          {isStreaming ? (
            <span className="animate-pulse">思考中...</span>
          ) : (
            '思考过程'
          )}
        </span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && (
        <div className="px-3 pb-2 text-xs text-[#5a7a96] font-mono whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto border-t border-[#1e2d42]">
          {content}
        </div>
      )}
    </div>
  );
};
