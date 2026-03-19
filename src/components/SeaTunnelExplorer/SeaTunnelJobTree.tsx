import React, { useMemo, useState, useEffect } from 'react';
import {
  ChevronRight, ChevronDown,
  Folder, FolderOpen,
  Play, CircleStop,
  Trash2, FolderPlus, FilePlus, Eye, MoveRight,
} from 'lucide-react';
import { useSeaTunnelStore, type STTreeNode } from '../../store/seaTunnelStore';
import { useConfirmStore } from '../../store/confirmStore';

interface SeaTunnelJobTreeProps {
  searchQuery?: string;
  onOpenJob?: (jobId: number, title: string, connectionId?: number) => void;
}

interface ContextMenuState {
  node: STTreeNode;
  x: number;
  y: number;
}

function computeVisible(
  nodes: Map<string, STTreeNode>,
  expandedIds: Set<string>
): STTreeNode[] {
  const result: STTreeNode[] = [];

  function visit(parentId: string | null) {
    const children = Array.from(nodes.values())
      .filter(n => n.parentId === parentId)
      .sort((a, b) =>
        (a.meta.sortOrder ?? 0) - (b.meta.sortOrder ?? 0) || a.label.localeCompare(b.label)
      );
    for (const node of children) {
      result.push(node);
      if (node.nodeType === 'category' && expandedIds.has(node.id)) {
        visit(node.id);
      }
    }
  }

  visit(null);
  return result;
}

function searchNodes(nodes: Map<string, STTreeNode>, query: string): STTreeNode[] {
  const q = query.toLowerCase();
  const matched = Array.from(nodes.values()).filter(
    n => n.label.toLowerCase().includes(q)
  );

  // 收集祖先节点以保持层级结构
  const resultIds = new Set(matched.map(n => n.id));
  const toInclude = new Set<string>();

  for (const node of matched) {
    toInclude.add(node.id);
    let parentId = node.parentId;
    while (parentId) {
      toInclude.add(parentId);
      const parent = nodes.get(parentId);
      parentId = parent?.parentId ?? null;
    }
  }

  // 按可见顺序返回（重用 computeVisible 的排序逻辑，但只保留 toInclude 中的节点）
  return computeVisible(nodes, new Set(
    Array.from(nodes.values())
      .filter(n => n.nodeType === 'category')
      .map(n => n.id)
  )).filter(n => toInclude.has(n.id));
}

function getDepth(node: STTreeNode, nodes: Map<string, STTreeNode>): number {
  let depth = 0;
  let parentId = node.parentId;
  while (parentId) {
    depth++;
    const parent = nodes.get(parentId);
    parentId = parent?.parentId ?? null;
  }
  return depth;
}

export function SeaTunnelJobTree({ searchQuery = '', onOpenJob }: SeaTunnelJobTreeProps) {
  const {
    nodes, expandedIds, selectedId, isInitializing,
    toggleExpand, selectNode,
    deleteCategory, deleteJob, createCategory, createJob,
  } = useSeaTunnelStore();
  const confirm = useConfirmStore(s => s.confirm);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 关闭右键菜单
  useEffect(() => {
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, []);

  const visibleNodes = useMemo(() => {
    if (searchQuery.trim()) return searchNodes(nodes, searchQuery);
    return computeVisible(nodes, expandedIds);
  }, [nodes, expandedIds, searchQuery]);

  // 搜索模式下所有分类都展开
  const isExpanded = (node: STTreeNode): boolean => {
    if (searchQuery.trim()) return node.nodeType === 'category';
    return expandedIds.has(node.id);
  };

  const handleContextMenu = (e: React.MouseEvent, node: STTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ node, x: e.clientX, y: e.clientY });
  };

  const handleDeleteCategory = async (node: STTreeNode) => {
    const { categoryId } = node.meta;
    if (!categoryId) return;
    const ok = await confirm({
      title: '删除分类',
      message: `确定要删除分类「${node.label}」吗？其下所有子分类和 Job 也将被删除，此操作不可撤销。`,
      variant: 'danger',
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      await deleteCategory(categoryId);
    } catch (e: any) {
      setError(e?.message ?? '删除分类失败');
    }
  };

  const handleDeleteJob = async (node: STTreeNode) => {
    const { jobId } = node.meta;
    if (!jobId) return;
    const ok = await confirm({
      title: '删除 Job',
      message: `确定要删除 Job「${node.label}」吗？此操作不可撤销。`,
      variant: 'danger',
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      await deleteJob(jobId);
    } catch (e: any) {
      setError(e?.message ?? '删除 Job 失败');
    }
  };

  const handleNewSubCategory = async (parentNode: STTreeNode) => {
    setContextMenu(null);
    const { categoryId } = parentNode.meta;
    try {
      await createCategory('新分类', categoryId);
    } catch (e: any) {
      setError(e?.message ?? '创建分类失败');
    }
  };

  const handleNewJob = async (parentNode: STTreeNode) => {
    setContextMenu(null);
    const { categoryId } = parentNode.meta;
    try {
      await createJob('新 Job', categoryId);
    } catch (e: any) {
      setError(e?.message ?? '创建 Job 失败');
    }
  };

  if (isInitializing) {
    return (
      <div className="px-3 py-2 space-y-1">
        {[80, 64, 72, 56, 68].map((w, i) => (
          <div key={i} className="flex items-center gap-2 h-7 px-1">
            <div className="w-3 h-3 rounded bg-[#1e2d42] animate-pulse flex-shrink-0" />
            <div className="h-2.5 rounded bg-[#1e2d42] animate-pulse" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    );
  }

  if (visibleNodes.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-[#7a9bb8]">
        {searchQuery.trim() ? '无匹配结果' : '暂无分类或 Job'}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1 relative">
      {error && (
        <div className="mx-2 mb-1 px-3 py-1.5 text-xs text-red-400 bg-red-900/20 rounded border border-red-900/40 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-red-400/60 hover:text-red-400">✕</button>
        </div>
      )}

      {visibleNodes.map(node => {
        const depth = getDepth(node, nodes);
        const expanded = isExpanded(node);
        const isSelected = selectedId === node.id;
        const paddingLeft = depth * 16 + 8;

        // 图标
        let Icon: React.ElementType;
        let iconClass = 'text-[#7a9bb8]';
        if (node.nodeType === 'category') {
          Icon = expanded ? FolderOpen : Folder;
          if (expanded) iconClass = 'text-[#00c9a7]';
        } else {
          const status = node.meta.status;
          Icon = status === 'RUNNING' ? CircleStop : Play;
          if (status === 'RUNNING') iconClass = 'text-[#00c9a7]';
        }

        return (
          <div
            key={node.id}
            className={`flex items-center py-1 px-2 cursor-pointer hover:bg-[#1a2639] outline-none select-none ${
              isSelected ? 'bg-[#1e2d42]' : ''
            }`}
            style={{ paddingLeft }}
            tabIndex={0}
            onClick={() => {
              selectNode(node.id);
              if (node.nodeType === 'category') toggleExpand(node.id);
            }}
            onDoubleClick={() => {
              if (node.nodeType === 'job' && node.meta.jobId) {
                onOpenJob?.(node.meta.jobId, node.label, node.meta.connectionId);
              }
            }}
            onContextMenu={e => handleContextMenu(e, node)}
          >
            {/* 展开箭头 */}
            <div className="w-4 h-4 mr-1 flex items-center justify-center text-[#7a9bb8] flex-shrink-0">
              {node.nodeType === 'category' ? (
                expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
              ) : null}
            </div>

            {/* 节点图标 */}
            <Icon size={14} className={`mr-1.5 flex-shrink-0 ${iconClass}`} />

            {/* 标签 */}
            <span className={`text-[13px] truncate flex-1 ${isSelected ? 'text-[#e8f4ff]' : 'text-[#b5cfe8]'}`}>
              {node.label}
            </span>

            {/* Job 状态徽章 */}
            {node.nodeType === 'job' && node.meta.status && (
              <span
                className={`text-[10px] flex-shrink-0 ml-1 px-1 rounded ${
                  node.meta.status === 'RUNNING'
                    ? 'text-[#00c9a7] bg-[#00c9a7]/10'
                    : node.meta.status === 'FAILED'
                      ? 'text-red-400 bg-red-900/20'
                      : 'text-[#7a9bb8]'
                }`}
              >
                {node.meta.status}
              </span>
            )}

            {/* 连接 ID 徽章（有连接时显示） */}
            {node.nodeType === 'job' && node.meta.connectionId && (
              <span className="text-[10px] text-[#7a9bb8] flex-shrink-0 ml-1">
                #{node.meta.connectionId}
              </span>
            )}
          </div>
        );
      })}

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl py-1 min-w-[160px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.node.nodeType === 'category' ? (
            <>
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                onClick={() => handleNewSubCategory(contextMenu.node)}
              >
                <FolderPlus size={13} />新建子分类
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                onClick={() => handleNewJob(contextMenu.node)}
              >
                <FilePlus size={13} />新建 Job
              </button>
              <div className="h-px bg-[#253347] my-1" />
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-red-400 hover:bg-[#1a2639] hover:text-red-300"
                onClick={async () => {
                  const node = contextMenu.node;
                  setContextMenu(null);
                  await handleDeleteCategory(node);
                }}
              >
                <Trash2 size={13} />删除分类
              </button>
            </>
          ) : (
            <>
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                onClick={() => {
                  const { jobId } = contextMenu.node.meta;
                  if (jobId) onOpenJob?.(jobId, contextMenu.node.label, contextMenu.node.meta.connectionId);
                  setContextMenu(null);
                }}
              >
                <Eye size={13} />打开
              </button>
              <div className="h-px bg-[#253347] my-1" />
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                onClick={() => {
                  // TODO: 打开移动 Job 对话框
                  setContextMenu(null);
                }}
              >
                <MoveRight size={13} />移动到分类
              </button>
              <div className="h-px bg-[#253347] my-1" />
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-red-400 hover:bg-[#1a2639] hover:text-red-300"
                onClick={async () => {
                  const node = contextMenu.node;
                  setContextMenu(null);
                  await handleDeleteJob(node);
                }}
              >
                <Trash2 size={13} />删除 Job
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
