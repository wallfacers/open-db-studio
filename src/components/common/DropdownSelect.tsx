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
  displayValue?: string;      // 自定义显示文本，覆盖默认的 label 查找
  searchable?: boolean;       // 顶部显示搜索框
  maxItems?: number;          // 无搜索时最多显示条数，默认不限
}

interface DropdownPos {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

// 全局唯一标识，用于关闭其他下拉菜单
let dropdownIdCounter = 0;
const DROPDOWN_OPEN_EVENT = 'dropdown-select-open';

export const DropdownSelect: React.FC<DropdownSelectProps> = ({
  value,
  options,
  placeholder = '',
  onChange,
  className = '',
  direction = 'down',
  maxHeight = 240,
  plain = false,
  displayValue,
  searchable = false,
  maxItems,
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<DropdownPos | null>(null);
  const [searchText, setSearchText] = useState('');
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownId = useRef(++dropdownIdCounter);

  const close = useCallback(() => { setOpen(false); setSearchText(''); }, []);

  // 监听其他下拉菜单打开事件，关闭当前下拉
  useEffect(() => {
    const handleOtherDropdownOpen = (e: Event) => {
      const customEvent = e as CustomEvent<number>;
      if (customEvent.detail !== dropdownId.current) {
        close();
      }
    };
    document.addEventListener(DROPDOWN_OPEN_EVENT, handleOtherDropdownOpen);
    return () => document.removeEventListener(DROPDOWN_OPEN_EVENT, handleOtherDropdownOpen);
  }, [close]);

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
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
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

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      close();
    } else {
      // 通知其他下拉菜单关闭
      document.dispatchEvent(new CustomEvent(DROPDOWN_OPEN_EVENT, { detail: dropdownId.current }));
      // 先计算位置，再打开，确保 pos 已准备好
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const newPos = {
          top: rect.bottom,
          bottom: window.innerHeight - rect.top,
          left: Math.min(rect.left, window.innerWidth - rect.width - 8),
          width: rect.width,
        };
        setPos(newPos);
        setOpen(true);
      }
    }
  };

  // 搜索打开后自动聚焦输入框
  useEffect(() => {
    if (open && searchable) {
      setTimeout(() => searchInputRef.current?.focus(), 30);
    }
  }, [open, searchable]);

  const filteredOptions = searchable && searchText
    ? options.filter(o => o.label.toLowerCase().includes(searchText.toLowerCase()))
    : maxItems ? options.slice(0, maxItems) : options;

  const selected = options.find(o => o.value === value);
  const displayLabel = displayValue ?? selected?.label ?? placeholder;
  const isPlaceholder = !selected && !displayValue;

  return (
    <div ref={triggerRef} className={`relative ${className}`}>
      {/* 触发器 */}
      {plain ? (
        <span
          className={`inline-block px-2.5 py-1.5 -mx-2.5 -my-1.5 rounded-sm text-[12px] cursor-pointer select-none hover:text-accent hover:bg-border-default/50 transition-colors
                      ${isPlaceholder ? 'text-foreground-muted' : 'text-foreground'}`}
          onClick={handleToggle}
        >
          {displayLabel}
        </span>
      ) : (
        <div
          className="flex items-center gap-1 bg-background-elevated border border-border-strong rounded
                     px-2 py-1 cursor-pointer hover:border-border-focus transition-colors select-none"
          onClick={handleToggle}
        >
          <span className={`text-xs truncate flex-1 ${isPlaceholder ? 'text-foreground-muted' : 'text-foreground-default'}`}>
            {displayLabel}
          </span>
          <ChevronDown
            size={11}
            className={`flex-shrink-0 text-foreground-muted transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </div>
      )}

      {/* 下拉列表：Portal 到 body，fixed 定位，脱离所有 overflow 约束 */}
      {open && pos && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[200] bg-background-elevated border border-border-strong rounded shadow-lg overflow-y-auto"
          style={{
            ...(direction === 'up'
              ? { bottom: pos.bottom + 4 }
              : { top: pos.top + 4 }),
            left: pos.left,
            minWidth: pos.width,
            maxHeight,
          }}
        >
          {searchable && (
            <div className="p-1.5 border-b border-border-default sticky top-0 bg-background-elevated">
              <input
                ref={searchInputRef}
                className="w-full bg-background-base border border-border-strong rounded px-2 py-1 text-xs text-foreground-default outline-none focus:border-border-focus"
                placeholder="搜索..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                onClick={e => e.stopPropagation()}
              />
            </div>
          )}
          {!searchText && placeholder && (
            <div
              className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-border-default transition-colors duration-150
                          ${!value ? 'text-accent' : 'text-foreground-muted'}`}
              onClick={() => { onChange(''); close(); }}
            >
              {placeholder}
            </div>
          )}
          {filteredOptions.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-foreground-muted">无匹配结果</div>
          )}
          {filteredOptions.map(opt => (
            <div
              key={opt.value}
              className={`px-3 py-1.5 text-[12px] cursor-pointer hover:bg-border-default transition-colors duration-150
                          ${value === opt.value ? 'text-accent' : 'text-foreground'}`}
              onClick={() => { onChange(opt.value); close(); }}
            >
              {opt.label}
            </div>
          ))}
          {!searchText && maxItems && options.length > maxItems && (
            <div className="px-3 py-1.5 text-[11px] text-foreground-ghost border-t border-border-default">
              共 {options.length} 条，输入搜索查看更多
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};
