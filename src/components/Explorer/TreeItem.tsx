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
      className={`flex items-center py-1 px-2 cursor-pointer hover:bg-[#1a2639] outline-none ${active ? 'bg-[#1e2d42]' : ''}`}
      style={{ paddingLeft: `${indent * 12 + 8}px` }}
      tabIndex={0}
      onClick={() => onClick && onClick(id || label)}
      onDoubleClick={() => onDoubleClick && onDoubleClick(id || label)}
      onKeyDown={handleKeyDown}
    >
      <div className="w-4 h-4 mr-1 flex items-center justify-center text-[#7a9bb8]">
        {hasChildren && (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
      </div>
      {Icon && <Icon size={14} className={`mr-1.5 ${active ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`} />}
      <span className={`text-[13px] truncate ${active ? 'text-[#e8f4ff]' : 'text-[#b5cfe8]'}`}>{label}</span>
      {secondaryLabel && <span className="ml-2 text-xs text-[#7a9bb8] truncate">{secondaryLabel}</span>}
    </div>
  );
};
