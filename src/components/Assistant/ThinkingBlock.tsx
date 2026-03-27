import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ThinkingBlockProps {
  content: string;
  isStreaming: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ content, isStreaming }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [doneDuration, setDoneDuration] = useState<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 首次有内容时启动计时
  useEffect(() => {
    if (content && !startTimeRef.current) {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current!) / 1000));
      }, 1000);
    }
  }, [content]);

  // 流式结束：记录总时长、停止计时、自动折叠
  useEffect(() => {
    if (!isStreaming && startTimeRef.current && timerRef.current) {
      setDoneDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      clearInterval(timerRef.current);
      timerRef.current = null;
      setExpanded(false);
    }
  }, [isStreaming]);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // 流式时内容更新自动滚到底部
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, isStreaming]);

  // 无内容时不显示
  if (!content) return null;

  return (
    <div className="mb-3">
      {/* 标题行：仿 DeepSeek 最小化样式 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-[#5a7a96] hover:text-[#c8daea] transition-colors mb-1.5 select-none"
      >
        <Sparkles
          size={11}
          className={isStreaming ? 'text-[#00c9a7] animate-pulse' : 'text-[#00c9a7] opacity-70'}
        />
        <span>
          {isStreaming
            ? `${t('assistant.thinking.thinking')}${elapsedSeconds > 0 ? `（${elapsedSeconds}s）` : '...'}`
            : `${t('assistant.thinking.thought')}${doneDuration !== null && doneDuration > 0 ? `（${doneDuration}s）` : ''}`
          }
        </span>
        {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      </button>

      {/* 内容区：左侧竖线引用风格 */}
      {expanded && (
        <div ref={scrollRef} className="pl-3 border-l-2 border-[#2a3f5a] text-[11px] text-[#4a6480] leading-relaxed whitespace-pre-wrap max-h-52 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
};
