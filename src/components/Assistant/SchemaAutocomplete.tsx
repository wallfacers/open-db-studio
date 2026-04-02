import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Table2, Eye, Columns3 } from 'lucide-react';
import { useSchemaCompletions, type SchemaSuggestion } from '../../hooks/useSchemaCompletions';

interface SchemaAutocompleteProps {
  connectionId: number | null;
  inputText: string;
  cursorPosition: number;
  onSelect: (suggestion: SchemaSuggestion, triggerStart: number) => void;
  onClose: () => void;
}

const ICON_MAP = {
  table: Table2,
  view: Eye,
  column: Columns3,
};

export const SchemaAutocomplete: React.FC<SchemaAutocompleteProps> = ({
  connectionId,
  inputText,
  cursorPosition,
  onSelect,
  onClose,
}) => {
  const { suggestions, triggerStart, isActive } = useSchemaCompletions(
    connectionId,
    inputText,
    cursorPosition,
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 重置选中索引
  useEffect(() => {
    setActiveIndex(0);
  }, [suggestions]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isActive) return;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
        break;
      case 'Tab':
      case 'Enter':
        if (suggestions[activeIndex]) {
          e.preventDefault();
          onSelect(suggestions[activeIndex], triggerStart);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [isActive, suggestions, activeIndex, triggerStart, onSelect, onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  if (!isActive || suggestions.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full mb-1 left-0 right-0 z-20 bg-background-panel border border-border-strong rounded-lg shadow-lg overflow-hidden max-h-48 overflow-y-auto"
    >
      {suggestions.map((item, i) => {
        const Icon = ICON_MAP[item.kind] ?? Table2;
        const isActive = i === activeIndex;

        return (
          <button
            key={`${item.kind}-${item.label}`}
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => onSelect(item, triggerStart)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
              isActive ? 'bg-background-hover' : 'hover:bg-background-elevated'
            }`}
          >
            <Icon size={12} className={`flex-shrink-0 ${
              item.kind === 'table' ? 'text-node-table' :
              item.kind === 'view' ? 'text-node-view' :
              'text-foreground-muted'
            }`} />
            <span className="text-foreground-default font-mono truncate">{item.label}</span>
            {item.detail && (
              <span className="text-foreground-ghost text-[10px] ml-auto">{item.detail}</span>
            )}
          </button>
        );
      })}
    </div>
  );
};
