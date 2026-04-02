import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TextShimmer } from '../shared/TextShimmer';
import { TextReveal } from '../shared/TextReveal';

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

  // 构建标题文本：流式 vs 完成
  const headingText = isStreaming
    ? `${t('assistant.thinking.thinking')}${elapsedSeconds > 0 ? `（${elapsedSeconds}s）` : '...'}`
    : `${t('assistant.thinking.thought')}${doneDuration !== null && doneDuration > 0 ? `（${doneDuration}s）` : ''}`;

  return (
    <div className="mb-3">
      {/* 标题行：TextShimmer 闪烁 + TextReveal 切换动画 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground-default transition-colors mb-1.5 select-none"
      >
        <Sparkles
          size={11}
          className={isStreaming ? 'text-accent animate-pulse' : 'text-accent opacity-70'}
        />
        {isStreaming ? (
          <TextShimmer
            text={headingText}
            active={isStreaming}
            className="text-shimmer-thinking"
          />
        ) : (
          <TextReveal
            text={headingText}
            duration={350}
            travel={4}
          />
        )}
        {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      </button>

      {/* 内容区：左侧竖线引用风格 */}
      {expanded && (
        <div ref={scrollRef} className="pl-3 border-l-2 border-border-strong text-[11px] text-foreground-subtle leading-relaxed whitespace-pre-wrap max-h-52 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
};
