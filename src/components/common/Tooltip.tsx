import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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

  return (
    <div
      className={className}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {mousePos && content &&
        createPortal(
          <div
            className="fixed z-[9999] px-2 py-1 text-xs text-[#c8daea] bg-[#151d28]
                       border border-[#2a3f5a] rounded shadow-lg whitespace-nowrap
                       pointer-events-none tooltip-fade-in"
            style={{
              left: mousePos.x + 8,
              top: mousePos.y + 24,
              transform: 'translateX(-50%)',
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </div>
  );
};
