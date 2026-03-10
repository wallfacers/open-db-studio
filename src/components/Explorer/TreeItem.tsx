import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export const TreeItem = ({ label, id, icon: Icon, isOpen = false, hasChildren = false, indent = 0, active = false, secondaryLabel = '', onClick }: any) => (
  <div 
    className={`flex items-center py-1 px-2 cursor-pointer hover:bg-[#2a2d2e] ${active ? 'bg-[#37373d]' : ''}`} 
    style={{ paddingLeft: `${indent * 12 + 8}px` }}
    onClick={() => onClick && onClick(id || label)}
  >
    <div className="w-4 h-4 mr-1 flex items-center justify-center text-[#858585]">
      {hasChildren && (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
    </div>
    {Icon && <Icon size={14} className={`mr-1.5 ${active ? 'text-[#3794ff]' : 'text-[#858585]'}`} />}
    <span className={`text-[13px] truncate ${active ? 'text-[#ffffff]' : 'text-[#cccccc]'}`}>{label}</span>
    {secondaryLabel && <span className="ml-2 text-xs text-[#858585] truncate">{secondaryLabel}</span>}
  </div>
);
