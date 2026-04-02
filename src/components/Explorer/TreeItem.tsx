import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export const TreeItem = ({ label, id, icon: Icon, isOpen = false, hasChildren = false, indent = 0, active = false, secondaryLabel = '', onClick, onDoubleClick }: any) => {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      navigator.clipboard.writeText(label);
    }
    if (e.key === 'Enter' && onDoubleClick) {
      onDoubleClick(id || label);
    }
  };

  return (
    <div
      className={`flex items-center py-1 px-2 cursor-pointer hover:bg-background-hover outline-none transition-colors duration-150 ${active ? 'bg-border-default' : ''}`}
      style={{ paddingLeft: `${indent * 12 + 8}px` }}
      tabIndex={0}
      onClick={() => onClick && onClick(id || label)}
      onDoubleClick={() => onDoubleClick && onDoubleClick(id || label)}
      onKeyDown={handleKeyDown}
    >
      <div className="w-4 h-4 mr-1 flex items-center justify-center text-foreground-muted">
        {hasChildren && (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
      </div>
      {Icon && <Icon size={14} className={`mr-1.5 ${active ? 'text-accent' : 'text-foreground-muted'}`} />}
      <span className={`text-[13px] truncate ${active ? 'text-foreground' : 'text-foreground'}`}>{label}</span>
      {secondaryLabel && <span className="ml-2 text-xs text-foreground-muted truncate">{secondaryLabel}</span>}
    </div>
  );
};
