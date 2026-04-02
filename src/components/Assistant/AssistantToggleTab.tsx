// src/components/Assistant/AssistantToggleTab.tsx
import React, { useState, useRef } from 'react';
import { ChevronRight, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store/appStore';
import { Tooltip } from '../common/Tooltip';

interface AssistantToggleTabProps {
  /** 当前 AI 助手面板实际宽度（面板关闭时传 0） */
  assistantWidth: number;
  /** 是否正在拖拽调整宽度（true 时禁用 transition 避免拖拽滞后） */
  isResizing: boolean;
}

export const AssistantToggleTab: React.FC<AssistantToggleTabProps> = ({
  assistantWidth,
  isResizing,
}) => {
  const { t } = useTranslation();
  const isOpen = useAppStore((s) => s.isAssistantOpen);
  const setOpen = useAppStore((s) => s.setAssistantOpen);

  // 垂直位置（px，从视口顶部计算）
  const [posY, setPosY] = useState(300);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartPosY = useRef(0);

  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = false;
    dragStartY.current = e.clientY;
    dragStartPosY.current = posY;
    e.preventDefault();

    const onMouseMove = (mv: MouseEvent) => {
      const delta = mv.clientY - dragStartY.current;
      if (Math.abs(delta) > 4) isDragging.current = true;
      if (isDragging.current) {
        const next = Math.max(60, Math.min(window.innerHeight - 80, dragStartPosY.current + delta));
        setPosY(next);
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const handleClick = () => {
    if (!isDragging.current) setOpen(!isOpen);
  };

  return (
    <Tooltip content={isOpen ? t('assistant.collapseAssistant') : t('assistant.expandAssistant')} className="contents">
    <button
      style={{
        position: 'fixed',
        right: assistantWidth,
        top: posY,
        transform: 'translateY(-50%)',
        zIndex: 60,
        // 仅在非拖拽调整宽度时启用 transition，避免 resize 时按钮滞后
        transition: isResizing ? 'none' : 'right 280ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      aria-label={isOpen ? t('assistant.collapseAssistant') : t('assistant.expandAssistant')}
      className={[
        'group flex flex-col items-center justify-center gap-0.5',
        'w-5 py-3.5 rounded-l-lg',
        'border border-r-0 outline-none',
        'transition-colors duration-200',
        'select-none',
        isDragging.current ? 'cursor-grabbing' : 'cursor-grab',
        isOpen
          ? 'bg-background-base border-border-default text-foreground-subtle hover:bg-background-hover hover:border-border-strong hover:text-accent'
          : [
              'bg-gradient-to-b from-background-base to-background-void',
              'border-border-strong text-accent',
              'hover:from-background-hover hover:to-background-base hover:border-border-focus',
              'shadow-[0_0_14px_rgba(99,102,241,0.12)]',
              'hover:shadow-[0_0_20px_rgba(99,102,241,0.25)]',
            ].join(' '),
      ].join(' ')}
    >
      {isOpen ? (
        <ChevronRight size={11} />
      ) : (
        <>
          <Sparkles size={11} className="group-hover:scale-110 transition-transform duration-200" />
          <span
            className="text-[8px] font-bold tracking-widest leading-none opacity-80 group-hover:opacity-100"
            style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
          >
            AI
          </span>
        </>
      )}
      {/* 拖拽手柄提示点 */}
      <div className="flex flex-col gap-[3px] mt-1 opacity-30 group-hover:opacity-60 transition-opacity">
        <span className="w-1 h-px bg-current rounded-full" />
        <span className="w-1 h-px bg-current rounded-full" />
        <span className="w-1 h-px bg-current rounded-full" />
      </div>
    </button>
    </Tooltip>
  );
};
