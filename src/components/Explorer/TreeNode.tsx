import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../common/Tooltip';
import {
  ChevronDown, ChevronRight, Loader2,
  Folder, FolderOpen, DatabaseZap, Database, Layers, TableProperties,
  LayoutDashboard, Code2, GitBranch, Zap, Columns3,
  Eye, Hash
} from 'lucide-react';
import type { NodeType, TreeNode as TreeNodeType } from '../../types';

const NODE_ICONS: Record<NodeType, React.ElementType> = {
  group: Folder,
  connection: DatabaseZap,
  database: Database,
  schema: Layers,
  category: Folder,   // 占位，实际由 isExpanded 动态选择
  table: TableProperties,
  view: Eye,
  function: Code2,
  procedure: GitBranch,
  trigger: Zap,
  event: Hash,
  sequence: Hash,
  column: Columns3,
};

interface TreeNodeProps {
  node: TreeNodeType;
  indent: number;
  isExpanded: boolean;
  isSelected: boolean;
  isLoading: boolean;
  /** connection 节点专用：是否已显式打开（控制图标绿色） */
  isActive?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export const TreeNode: React.FC<TreeNodeProps> = ({
  node,
  indent,
  isExpanded,
  isSelected,
  isLoading,
  isActive,
  onClick,
  onDoubleClick,
  onContextMenu,
}) => {
  const { t } = useTranslation();

  // category 和 group 节点根据展开状态切换图标
  const Icon = (node.nodeType === 'category' || node.nodeType === 'group')
    ? (isExpanded ? FolderOpen : Folder)
    : (NODE_ICONS[node.nodeType] ?? LayoutDashboard);

  // connection 节点：只有显式打开（isActive）才变绿，与树展开状态无关
  // 其他节点：展开且有子节点时变绿
  const isGreen = node.nodeType === 'connection'
    ? !!isActive
    : isExpanded && node.hasChildren;

  // category 节点显示 i18n 标签
  const displayLabel = node.nodeType === 'category' && node.meta.objectName
    ? t(`category.${node.meta.objectName}`, { defaultValue: node.label })
    : node.label;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      navigator.clipboard.writeText(node.label);
    }
    if (e.key === 'Enter' && onDoubleClick) {
      onDoubleClick();
    }
  };

  const tooltipContent = node.nodeType === 'connection' && !isActive
    ? t('dbTree.doubleClickToOpen')
    : undefined;

  return (
    <Tooltip content={tooltipContent}>
    <div
      className={`flex items-center py-1 px-2 cursor-pointer hover:bg-[#1a2639] outline-none select-none ${
        isSelected ? 'bg-[#1e2d42]' : ''
      }`}
      style={{ paddingLeft: `${indent * 12 + 8}px` }}
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDown={handleKeyDown}
    >
      <div className="w-4 h-4 mr-1 flex items-center justify-center text-[#7a9bb8] flex-shrink-0">
        {isLoading ? (
          <Loader2 size={12} className="animate-spin" />
        ) : node.hasChildren ? (
          isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : null}
      </div>

      <Icon
        size={14}
        className={`mr-1.5 flex-shrink-0 ${isGreen ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`}
      />

      <span
        className={`text-[13px] truncate ${isSelected ? 'text-[#e8f4ff]' : 'text-[#b5cfe8]'}`}
      >
        {displayLabel}
      </span>
    </div>
    </Tooltip>
  );
};
