import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Reuse DropdownSelect's global open-event mechanism
let dropdownIdCounter = 0;
const DROPDOWN_OPEN_EVENT = 'combobox-select-open';

interface ComboboxSelectProps {
  value: string;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  onChange: (value: string) => void;
  className?: string;
  maxHeight?: number;
}

export const ComboboxSelect: React.FC<ComboboxSelectProps> = ({
  value,
  options,
  placeholder = '',
  onChange,
  className = '',
  maxHeight = 240,
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);
  const [searchText, setSearchText] = useState('');
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownId = useRef(++dropdownIdCounter);

  const close = useCallback(() => {
    setOpen(false);
    setSearchText('');
  }, []);

  useEffect(() => {
    const handleOtherOpen = (e: Event) => {
      const customEvent = e as CustomEvent<number>;
      if (customEvent.detail !== dropdownId.current) close();
    };
    document.addEventListener(DROPDOWN_OPEN_EVENT, handleOtherOpen);
    return () => document.removeEventListener(DROPDOWN_OPEN_EVENT, handleOtherOpen);
  }, [close]);

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
      document.dispatchEvent(new CustomEvent(DROPDOWN_OPEN_EVENT, { detail: dropdownId.current }));
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setPos({
          top: rect.bottom,
          bottom: window.innerHeight - rect.top,
          left: Math.min(rect.left, window.innerWidth - rect.width - 8),
          width: rect.width,
        });
        setOpen(true);
      }
    }
  };

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open]);

  const filteredOptions = useMemo(() => {
    const term = searchText.toLowerCase();
    if (!term) return options;
    return options.filter(o => o.label.toLowerCase().includes(term));
  }, [searchText, options]);

  // Sync searchText with value when opening
  useEffect(() => {
    if (open) setSearchText('');
  }, [open]);

  return (
    <div ref={triggerRef} className={`relative flex items-center ${className}`}>
      {/* Editable input */}
      <input
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-background-elevated border border-border-strong rounded-l px-2 py-1 text-[12px] text-foreground-default outline-none focus:border-border-focus transition-colors"
      />
      {/* Dropdown toggle button */}
      <div
        className="flex items-center justify-center bg-background-elevated border border-l-0 border-border-strong rounded-r px-1 cursor-pointer hover:border-border-focus transition-colors select-none"
        onClick={handleToggle}
      >
        <ChevronDown
          size={11}
          className={`text-foreground-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </div>

      {/* Dropdown list */}
      {open && pos && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[200] bg-background-elevated border border-border-strong rounded shadow-lg overflow-y-auto"
          style={{
            top: pos.top + 4,
            left: pos.left,
            width: pos.width + 20,
            maxHeight,
          }}
        >
          <div className="p-1.5 border-b border-border-default sticky top-0 bg-background-elevated">
            <input
              ref={searchInputRef}
              className="w-full bg-background-base border border-border-strong rounded px-2 py-1 text-xs text-foreground-default outline-none focus:border-border-focus"
              placeholder={t('commonComponents.dropdown.searchPlaceholder')}
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              onClick={e => e.stopPropagation()}
            />
          </div>
          {filteredOptions.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-foreground-muted">{t('commonComponents.dropdown.noResults')}</div>
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
        </div>,
        document.body,
      )}
    </div>
  );
};
