import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, ChevronRight, Loader2,
  Folder, FolderOpen, Database, Layers, TableProperties,
  LayoutDashboard, Code2, GitBranch, Zap, Columns3,
  Eye, Hash, BarChart2
} from 'lucide-react';
import type { NodeType, TreeNode as TreeNodeType } from '../../types';
import { DbDriverIcon } from './DbDriverIcon';

const NODE_ICONS: Record<NodeType, React.ElementType> = {
  group: Folder,
  connection: LayoutDashboard, // 占位，connection 节点由 DbDriverIcon 单独渲染
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
  materialized_view: Eye,  // 物化视图：与普通视图同图标
  dictionary: Hash,        // ClickHouse 字典
  column: Columns3,
  metrics_folder: BarChart2,  // 指标目录：由 isExpanded 动态切换 Folder/FolderOpen
  metric: BarChart2,          // 单个指标：使用柱状图图标
};

interface TreeNodeProps {
  node: TreeNodeType;
  indent: number;
  isExpanded: boolean;
  isSelected: boolean;
  isLoading: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  badge?: React.ReactNode;
}

export const TreeNode: React.FC<TreeNodeProps> = ({
  node,
  indent,
  isExpanded,
  isSelected,
  isLoading,
  onClick,
  onDoubleClick,
  onContextMenu,
  badge,
}) => {
  const { t } = useTranslation();

  // category、group、metrics_folder 节点根据展开状态切换图标
  const Icon = (node.nodeType === 'category' || node.nodeType === 'group' || node.nodeType === 'metrics_folder')
    ? (isExpanded ? FolderOpen : Folder)
    : (NODE_ICONS[node.nodeType] ?? LayoutDashboard);

  // 统一规则：展开 → 主题色；收起 → 灰色（与节点类型、是否有子节点无关）
  const isGreen = isExpanded;

  // category 节点显示 i18n 标签；metrics_folder 节点的 label 是 i18n key
  const displayLabel = node.nodeType === 'category' && node.meta.objectName
    ? t(`category.${node.meta.objectName}`, { defaultValue: node.label })
    : node.nodeType === 'metrics_folder'
    ? t(node.label, { defaultValue: node.label })
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

  return (
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

      {node.nodeType === 'connection' ? (
        <DbDriverIcon
          driver={node.meta.driver ?? ''}
          size={14}
          className={`mr-1.5 flex-shrink-0 ${isGreen ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`}
        />
      ) : (
        <Icon
          size={14}
          className={`mr-1.5 flex-shrink-0 ${isGreen ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'}`}
        />
      )}

      <span
        className={`text-[13px] truncate ${isSelected ? 'text-[#e8f4ff]' : 'text-[#b5cfe8]'}`}
      >
        {displayLabel}
      </span>
      {badge}
    </div>
  );
};
