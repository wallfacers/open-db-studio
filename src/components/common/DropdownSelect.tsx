import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

interface Option {
  value: string;
  label: string;
}

interface DropdownSelectProps {
  value: string;
  options: Option[];
  placeholder?: string;
  onChange: (value: string) => void;
  className?: string;         // 触发器额外宽度类，如 "w-32"
  direction?: 'up' | 'down';  // 默认 'down'
  maxHeight?: number;         // 下拉列表最大高度px，默认 240
  plain?: boolean;            // 纯文字触发器，无边框/背景/箭头
}

interface DropdownPos {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

export const DropdownSelect: React.FC<DropdownSelectProps> = ({
  value,
  options,
  placeholder = '',
  onChange,
  className = '',
  direction = 'down',
  maxHeight = 240,
  plain = false,
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<DropdownPos | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // 点击外部关闭：同时排除触发器和弹出层
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) return;
      close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  // 外部滚动或窗口大小变化时关闭（下拉层内部滚动不触发）
  useEffect(() => {
    if (!open) return;
    const handleScroll = (e: Event) => {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  const handleToggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom,
        bottom: window.innerHeight - rect.top,
        left: Math.min(rect.left, window.innerWidth - rect.width - 8),
        width: rect.width,
      });
    }
    setOpen(o => !o);
  };

  const selected = options.find(o => o.value === value);
  const displayLabel = selected?.label ?? placeholder;
  const isPlaceholder = !selected;

  return (
    <div ref={triggerRef} className={`relative ${className}`}>
      {/* 触发器 */}
      {plain ? (
        <span
          className={`text-[12px] cursor-pointer select-none hover:text-[#00c9a7] transition-colors
                      ${isPlaceholder ? 'text-[#7a9bb8]' : 'text-[#b5cfe8]'}`}
          onClick={handleToggle}
        >
          {displayLabel}
        </span>
      ) : (
        <div
          className="flex items-center gap-1 bg-[#151d28] border border-[#2a3f5a] rounded
                     px-2 py-1 cursor-pointer hover:border-[#3a5a7a] transition-colors select-none"
          onClick={handleToggle}
        >
          <span className={`text-xs truncate flex-1 ${isPlaceholder ? 'text-[#7a9bb8]' : 'text-[#c8daea]'}`}>
            {displayLabel}
          </span>
          <ChevronDown
            size={11}
            className={`flex-shrink-0 text-[#7a9bb8] transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </div>
      )}

      {/* 下拉列表：Portal 到 body，fixed 定位，脱离所有 overflow 约束 */}
      {open && pos && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[200] bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg overflow-y-auto"
          style={{
            ...(direction === 'up'
              ? { bottom: pos.bottom + 4 }
              : { top: pos.top + 4 }),
            left: pos.left,
            minWidth: pos.width,
            maxHeight,
          }}
        >
          {placeholder && (
            <div
              className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-[#1e2d42]
                          ${!value ? 'text-[#009e84]' : 'text-[#7a9bb8]'}`}
              onClick={() => { onChange(''); close(); }}
            >
              {placeholder}
            </div>
          )}
          {options.map(opt => (
            <div
              key={opt.value}
              className={`px-3 py-1.5 text-[12px] cursor-pointer hover:bg-[#1e2d42]
                          ${value === opt.value ? 'text-[#009e84]' : 'text-[#b5cfe8]'}`}
              onClick={() => { onChange(opt.value); close(); }}
            >
              {opt.label}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
};
