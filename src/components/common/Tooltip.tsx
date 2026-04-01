import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const MAX_WIDTH = 320;
const MARGIN = 8;

interface TooltipProps {
  content?: string;
  children: React.ReactNode;
  /** 延迟显示时间（ms），默认 700 */
  delay?: number;
  /** wrapper div 的额外 className，默认为空（块级元素） */
  className?: string;
}

/**
 * 统一主题风格的 Tooltip 组件。
 * 显示在鼠标光标正下方，使用 Portal 渲染到 body。
 * 自动处理四边缘溢出：右侧不足时向左偏移，底部不足时显示在光标上方。
 */
export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  delay = 700,
  className = '',
}) => {
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPos = useRef<{ x: number; y: number } | null>(null);

  const handleMouseEnter = (e: React.MouseEvent) => {
    if (!content) return;
    pendingPos.current = { x: e.clientX, y: e.clientY };
    timerRef.current = setTimeout(() => {
      setMousePos(pendingPos.current);
    }, delay);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    pendingPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMousePos(null);
  };

  const handleMouseDown = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMousePos(null);
  };

  const getPosition = (pos: { x: number; y: number }) => {
    // 右边缘：光标右侧偏移 12px，超出则从右侧留出 margin
    const left = Math.min(pos.x + 12, window.innerWidth - MAX_WIDTH - MARGIN);
    // 底部边缘：下方放不下时显示在光标上方
    const top = pos.y + 24 + 32 > window.innerHeight
      ? pos.y - 32
      : pos.y + 24;
    return { left, top };
  };

  return (
    <div
      className={className}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
    >
      {children}
      {mousePos && content &&
        createPortal(
          <div
            className="fixed z-[9999] px-2 py-1 text-xs text-[#c8daea] bg-[#151d28]
                       border border-[#2a3f5a] rounded shadow-lg break-words
                       pointer-events-none tooltip-fade-in"
            style={{ maxWidth: MAX_WIDTH, ...getPosition(mousePos) }}
          >
            {content}
          </div>,
          document.body,
        )}
    </div>
  );
};
