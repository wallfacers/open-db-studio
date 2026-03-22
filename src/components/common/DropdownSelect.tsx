import React, { useState, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { useClickOutside } from '../../hooks/useClickOutside';

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
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, () => setOpen(false), open);

  const selected = options.find(o => o.value === value);
  const displayLabel = selected?.label ?? placeholder;
  const isPlaceholder = !selected;

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* 触发器 */}
      {plain ? (
        <span
          className={`text-xs cursor-pointer select-none hover:text-[#00c9a7] transition-colors
                      ${isPlaceholder ? 'text-[#7a9bb8]' : 'text-[#c8daea]'}`}
          onClick={() => setOpen(o => !o)}
        >
          {displayLabel}
        </span>
      ) : (
      <div
        className="flex items-center gap-1 bg-[#151d28] border border-[#2a3f5a] rounded
                   px-2 py-1 cursor-pointer hover:border-[#3a5a7a] transition-colors select-none"
        onClick={() => setOpen(o => !o)}
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

      {/* 下拉列表 */}
      {open && (
        <div
          className={`absolute z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg
                      overflow-y-auto min-w-full ${direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'}`}
          style={{ maxHeight }}
        >
          {placeholder && (
            <div
              className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-[#1e2d42]
                          ${!value ? 'text-[#009e84]' : 'text-[#7a9bb8]'}`}
              onClick={() => { onChange(''); setOpen(false); }}
            >
              {placeholder}
            </div>
          )}
          {options.map(opt => (
            <div
              key={opt.value}
              className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-[#1e2d42]
                          ${value === opt.value ? 'text-[#009e84]' : 'text-[#c8daea]'}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
