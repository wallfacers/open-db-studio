import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  ChevronRight, ChevronDown,
  Folder, FolderOpen, Server,
  Play, CircleStop,
  Trash2, FolderPlus, FilePlus, Eye, MoveRight, Pencil,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSeaTunnelStore, type STTreeNode } from '../../store/seaTunnelStore';
import { useConfirmStore } from '../../store/confirmStore';
import { SeaTunnelConnectionModal } from './SeaTunnelConnectionModal';
import { CategoryEditModal } from './CategoryEditModal';

interface SeaTunnelJobTreeProps {
  searchQuery?: string;
  onOpenJob?: (jobId: number, title: string, connectionId?: number) => void;
}

interface ContextMenuState {
  node: STTreeNode;
  x: number;
  y: number;
}

interface InlineEditState {
  nodeId: string;
  originalLabel: string;
  value: string;
}

function computeVisible(nodes: Map<string, STTreeNode>, expandedIds: Set<string>): STTreeNode[] {
  const result: STTreeNode[] = [];
  function visit(parentId: string | null) {
    const children = Array.from(nodes.values())
      .filter(n => n.parentId === parentId)
      .sort((a, b) => {
        // connection 节点按名称排序；category/job 按 sortOrder 再按名称
        if (a.nodeType === 'connection' && b.nodeType === 'connection') return a.label.localeCompare(b.label);
        return (a.meta.sortOrder ?? 0) - (b.meta.sortOrder ?? 0) || a.label.localeCompare(b.label);
      });
    for (const node of children) {
      result.push(node);
      const isExpandable = node.nodeType === 'connection' || node.nodeType === 'category';
      if (isExpandable && expandedIds.has(node.id)) {
        visit(node.id);
      }
    }
  }
  visit(null);
  return result;
}

function searchNodes(nodes: Map<string, STTreeNode>, query: string): STTreeNode[] {
  const q = query.toLowerCase();
  const matched = Array.from(nodes.values()).filter(n => n.label.toLowerCase().includes(q));
  const toInclude = new Set<string>();
  for (const node of matched) {
    toInclude.add(node.id);
    let parentId = node.parentId;
    while (parentId) {
      toInclude.add(parentId);
      parentId = nodes.get(parentId)?.parentId ?? null;
    }
  }
  return computeVisible(nodes, new Set(
    Array.from(nodes.values())
      .filter(n => n.nodeType === 'connection' || n.nodeType === 'category')
      .map(n => n.id)
  )).filter(n => toInclude.has(n.id));
}

function getVisualDepth(node: STTreeNode, nodes: Map<string, STTreeNode>): number {
  let depth = 0;
  let parentId = node.parentId;
  while (parentId) {
    depth++;
    parentId = nodes.get(parentId)?.parentId ?? null;
  }
  return depth;
}

export function SeaTunnelJobTree({ searchQuery = '', onOpenJob }: SeaTunnelJobTreeProps) {
  const { t } = useTranslation();
  const {
    nodes, expandedIds, selectedId, isInitializing,
    toggleExpand, selectNode,
    deleteCategory, deleteJob, createCategory, createJob,
    deleteConnection, renameCategory, renameJob, init,
  } = useSeaTunnelStore();
  const confirm = useConfirmStore(s => s.confirm);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCategoryModal, setShowCategoryModal] = useState<{ parentNode: STTreeNode; connectionId: number } | null>(null);
  const [showEditConnectionModal, setShowEditConnectionModal] = useState<{ id: number; name: string; url: string } | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, []);

  useEffect(() => {
    if (inlineEdit) inlineInputRef.current?.select();
  }, [inlineEdit?.nodeId]);

  const visibleNodes = useMemo(() => {
    if (searchQuery.trim()) return searchNodes(nodes, searchQuery);
    return computeVisible(nodes, expandedIds);
  }, [nodes, expandedIds, searchQuery]);

  const isExpanded = (node: STTreeNode) => {
    if (searchQuery.trim()) return node.nodeType !== 'job';
    return expandedIds.has(node.id);
  };

  // ─── 辅助：确保节点处于展开状态（若已展开则不切换）────────────────────────
  const ensureExpanded = (nodeId: string) => {
    if (!expandedIds.has(nodeId)) toggleExpand(nodeId);
  };

  // ─── 辅助：从节点向上找最近的 connectionId ────────────────────────────────
  function resolveConnectionId(node: STTreeNode): number | undefined {
    if (node.meta.connectionId) return node.meta.connectionId;
    let parentId = node.parentId;
    while (parentId) {
      const parent = nodes.get(parentId);
      if (!parent) break;
      if (parent.meta.connectionId) return parent.meta.connectionId;
      parentId = parent.parentId;
    }
    return undefined;
  }

  // ─── 右键菜单操作 ─────────────────────────────────────────────────────────
  const startInlineEdit = (node: STTreeNode) => {
    setContextMenu(null);
    setInlineEdit({ nodeId: node.id, originalLabel: node.label, value: node.label });
  };

  const commitInlineEdit = async () => {
    if (!inlineEdit) return;
    const trimmed = inlineEdit.value.trim();
    if (!trimmed || trimmed === inlineEdit.originalLabel) {
      setInlineEdit(null);
      return;
    }
    const node = nodes.get(inlineEdit.nodeId);
    if (!node) { setInlineEdit(null); return; }
    try {
      if (node.nodeType === 'category' && node.meta.categoryId) {
        await renameCategory(node.meta.categoryId, trimmed);
      } else if (node.nodeType === 'job' && node.meta.jobId) {
        await renameJob(node.meta.jobId, trimmed);
      }
    } catch (e: any) {
      setError(e?.message ?? t('seaTunnel.jobTree.renameFailed'));
    }
    setInlineEdit(null);
  };

  const handleDeleteConnection = async (node: STTreeNode) => {
    const ok = await confirm({
      title: t('seaTunnel.jobTree.deleteConnectionTitle'),
      message: t('seaTunnel.jobTree.confirmDeleteConnection', { name: node.label }),
      variant: 'danger',
      confirmLabel: t('common.confirm'),
    });
    if (!ok) return;
    try { await deleteConnection(node.meta.connectionId!); }
    catch (e: any) { setError(e?.message ?? t('seaTunnel.jobTree.deleteConnectionFailed')); }
  };

  const handleDeleteCategory = async (node: STTreeNode) => {
    const ok = await confirm({
      title: t('seaTunnel.jobTree.deleteCategoryTitle'),
      message: t('seaTunnel.jobTree.confirmDeleteCategory', { name: node.label }),
      variant: 'danger',
      confirmLabel: t('common.confirm'),
    });
    if (!ok) return;
    try { await deleteCategory(node.meta.categoryId!); }
    catch (e: any) { setError(e?.message ?? t('seaTunnel.jobTree.deleteCategoryFailed')); }
  };

  const handleDeleteJob = async (node: STTreeNode) => {
    const ok = await confirm({
      title: t('seaTunnel.jobTree.deleteJobTitle'),
      message: t('seaTunnel.jobTree.confirmDeleteJob', { name: node.label }),
      variant: 'danger',
      confirmLabel: t('common.confirm'),
    });
    if (!ok) return;
    try { await deleteJob(node.meta.jobId!); }
    catch (e: any) { setError(e?.message ?? t('seaTunnel.jobTree.deleteJobFailed')); }
  };

  const handleNewCategory = async (parentNode: STTreeNode) => {
    setContextMenu(null);
    const connId = resolveConnectionId(parentNode);
    if (!connId) return;
    ensureExpanded(parentNode.id);
    setShowCategoryModal({ parentNode, connectionId: connId });
  };

  const handleNewJob = async (parentNode: STTreeNode) => {
    setContextMenu(null);
    const connId = resolveConnectionId(parentNode);
    const catId = parentNode.nodeType === 'category' ? parentNode.meta.categoryId : undefined;
    // 生成不重复的任务名
    const siblings = Array.from(nodes.values()).filter(
      n => n.parentId === parentNode.id && n.nodeType === 'job'
    );
    const existingNames = new Set(siblings.map(n => n.label));
    const baseName = t('seaTunnel.jobTree.newJobName');
    let name = baseName;
    let counter = 1;
    while (existingNames.has(name)) {
      counter++;
      name = `${baseName} (${counter})`;
    }
    try {
      await createJob(name, catId, connId);
      ensureExpanded(parentNode.id);
    } catch (e: any) {
      setError(e?.message ?? t('seaTunnel.jobTree.createJobFailed'));
    }
  };

  // ─── 渲染 ─────────────────────────────────────────────────────────────────
  if (isInitializing) {
    return (
      <div className="px-3 py-2 space-y-1">
        {[80, 64, 72, 56, 68].map((w, i) => (
          <div key={i} className="flex items-center gap-2 h-7 px-1">
            <div className="w-3 h-3 rounded bg-[var(--border-default)] animate-pulse flex-shrink-0" />
            <div className="h-2.5 rounded bg-[var(--border-default)] animate-pulse" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    );
  }

  if (visibleNodes.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-[var(--foreground-muted)]">
        {searchQuery.trim() ? t('seaTunnel.noResults') : t('seaTunnel.noConnections')}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1 relative">
      {error && (
        <div className="mx-2 mb-1 px-3 py-1.5 text-xs text-[var(--error)] bg-[var(--error-subtle)] rounded border border-[var(--error)]/30 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-[var(--error)]/60 hover:text-[var(--error)]">✕</button>
        </div>
      )}

      {visibleNodes.map(node => {
        const depth = getVisualDepth(node, nodes);
        const expanded = isExpanded(node);
        const isSelected = selectedId === node.id;
        const paddingLeft = depth * 16 + 8;
        const isEditing = inlineEdit?.nodeId === node.id;

        // 图标
        let Icon: React.ElementType;
        let iconClass = 'text-[var(--foreground-muted)]';
        if (node.nodeType === 'connection') {
          Icon = Server;
          if (expanded) iconClass = 'text-[var(--accent)]';
        } else if (node.nodeType === 'category') {
          Icon = expanded ? FolderOpen : Folder;
          if (expanded) iconClass = 'text-[var(--accent)]';
        } else {
          Icon = node.meta.status === 'RUNNING' ? CircleStop : Play;
          if (node.meta.status === 'RUNNING') iconClass = 'text-[var(--accent)]';
        }

        const isExpandable = node.nodeType === 'connection' || node.nodeType === 'category';

        return (
          <div
            key={node.id}
            className={`flex items-center py-1 px-2 cursor-pointer hover:bg-[var(--background-hover)] outline-none select-none ${isSelected ? 'bg-[var(--border-default)]' : ''}`}
            style={{ paddingLeft }}
            tabIndex={0}
            onClick={() => {
              selectNode(node.id);
              if (isExpandable) {
                toggleExpand(node.id);
              } else if (node.nodeType === 'job' && node.meta.jobId) {
                onOpenJob?.(node.meta.jobId, node.label, node.meta.connectionId);
              }
            }}
            onContextMenu={e => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ node, x: e.clientX, y: e.clientY });
            }}
          >
            {/* 展开箭头 */}
            <div className="w-4 h-4 mr-1 flex items-center justify-center text-[var(--foreground-muted)] flex-shrink-0">
              {isExpandable ? (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
            </div>

            {/* 节点图标 */}
            <Icon size={14} className={`mr-1.5 flex-shrink-0 ${iconClass}`} />

            {/* 标签 / 内联编辑 */}
            {isEditing ? (
              <input
                ref={inlineInputRef}
                className="flex-1 text-[13px] bg-[var(--background-base)] border border-[var(--accent)] rounded px-1 text-[var(--foreground)] outline-none min-w-0"
                value={inlineEdit.value}
                onChange={e => setInlineEdit(prev => prev ? { ...prev, value: e.target.value } : null)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitInlineEdit(); }
                  if (e.key === 'Escape') setInlineEdit(null);
                }}
                onBlur={commitInlineEdit}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className={`text-[13px] truncate flex-1 ${isSelected ? 'text-[var(--foreground)]' : 'text-[var(--foreground)]'}`}>
                {node.label}
              </span>
            )}

            {/* connection 节点右侧 URL */}
            {node.nodeType === 'connection' && node.meta.connectionUrl && !isEditing && (
              <span className="text-[10px] text-[var(--foreground-muted)] flex-shrink-0 ml-1 max-w-[100px] truncate">
                {node.meta.connectionUrl}
              </span>
            )}

            {/* Job 状态徽章 */}
            {node.nodeType === 'job' && node.meta.status && !isEditing && (
              <span className={`text-[10px] flex-shrink-0 ml-1 px-1 rounded ${
                node.meta.status === 'RUNNING' ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                : node.meta.status === 'FAILED' ? 'text-[var(--error)] bg-[var(--error-subtle)]'
                : 'text-[var(--foreground-muted)]'
              }`}>
                {node.meta.status}
              </span>
            )}
          </div>
        );
      })}

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-[var(--background-base)] border border-[var(--border-default)] rounded shadow-xl py-1 min-w-[160px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.node.nodeType === 'connection' && (
            <>
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] hover:text-[var(--foreground)]"
                onClick={() => handleNewCategory(contextMenu.node)}>
                <FolderPlus size={13} />{t('seaTunnel.jobTree.newCategory')}
              </button>
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] hover:text-[var(--foreground)]"
                onClick={() => handleNewJob(contextMenu.node)}>
                <FilePlus size={13} />{t('seaTunnel.jobTree.newJob')}
              </button>
              <div className="h-px bg-[var(--border-strong)] my-1" />
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] hover:text-[var(--foreground)]"
                onClick={() => {
                  const { connectionId, connectionUrl } = contextMenu.node.meta;
                  if (connectionId) {
                    setShowEditConnectionModal({ id: connectionId, name: contextMenu.node.label, url: connectionUrl ?? '' });
                  }
                  setContextMenu(null);
                }}>
                <Pencil size={13} />{t('seaTunnel.jobTree.editConnection')}
              </button>
              <div className="h-px bg-[var(--border-strong)] my-1" />
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--error)] hover:bg-[var(--background-hover)] hover:text-[var(--error-foreground)]"
                onClick={async () => {
                  const node = contextMenu.node;
                  setContextMenu(null);
                  await handleDeleteConnection(node);
                }}>
                <Trash2 size={13} />{t('seaTunnel.jobTree.deleteConnection')}
              </button>
            </>
          )}

          {contextMenu.node.nodeType === 'category' && (
            <>
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] hover:text-[var(--foreground)]"
                onClick={() => handleNewCategory(contextMenu.node)}>
                <FolderPlus size={13} />{t('seaTunnel.jobTree.newSubCategory')}
              </button>
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] hover:text-[var(--foreground)]"
                onClick={() => handleNewJob(contextMenu.node)}>
                <FilePlus size={13} />{t('seaTunnel.jobTree.newJob')}
              </button>
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] hover:text-[var(--foreground)]"
                onClick={() => startInlineEdit(contextMenu.node)}>
                <Pencil size={13} />{t('seaTunnel.jobTree.rename')}
              </button>
              <div className="h-px bg-[var(--border-strong)] my-1" />
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--error)] hover:bg-[var(--background-hover)] hover:text-[var(--error-foreground)]"
                onClick={async () => {
                  const node = contextMenu.node;
                  setContextMenu(null);
                  await handleDeleteCategory(node);
                }}>
                <Trash2 size={13} />{t('seaTunnel.jobTree.deleteCategory')}
              </button>
            </>
          )}

          {contextMenu.node.nodeType === 'job' && (
            <>
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] hover:text-[var(--foreground)]"
                onClick={() => {
                  const { jobId, connectionId } = contextMenu.node.meta;
                  if (jobId) onOpenJob?.(jobId, contextMenu.node.label, connectionId);
                  setContextMenu(null);
                }}>
                <Eye size={13} />{t('seaTunnel.jobTree.open')}
              </button>
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] hover:text-[var(--foreground)]"
                onClick={() => startInlineEdit(contextMenu.node)}>
                <Pencil size={13} />{t('seaTunnel.jobTree.rename')}
              </button>
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--foreground-default)] hover:bg-[var(--background-hover)] hover:text-[var(--foreground)]"
                onClick={() => { setContextMenu(null); /* TODO: move dialog */ }}>
                <MoveRight size={13} />{t('seaTunnel.jobTree.moveToCategory')}
              </button>
              <div className="h-px bg-[var(--border-strong)] my-1" />
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[var(--error)] hover:bg-[var(--background-hover)] hover:text-[var(--error-foreground)]"
                onClick={async () => {
                  const node = contextMenu.node;
                  setContextMenu(null);
                  await handleDeleteJob(node);
                }}>
                <Trash2 size={13} />{t('seaTunnel.jobTree.deleteJob')}
              </button>
            </>
          )}
        </div>
      )}

      {/* 新建目录弹窗 */}
      {showCategoryModal && (
        <CategoryEditModal
          parentNode={showCategoryModal.parentNode}
          connectionId={showCategoryModal.connectionId}
          onClose={() => setShowCategoryModal(null)}
          onSave={async (name) => {
            const catId = showCategoryModal.parentNode.nodeType === 'category'
              ? showCategoryModal.parentNode.meta.categoryId
              : undefined;
            await createCategory(name, catId, showCategoryModal.connectionId);
            setShowCategoryModal(null);
          }}
        />
      )}

      {/* 编辑集群弹窗 */}
      {showEditConnectionModal && (
        <SeaTunnelConnectionModal
          mode="edit"
          connection={showEditConnectionModal}
          onClose={() => setShowEditConnectionModal(null)}
          onSave={() => { init(); setShowEditConnectionModal(null); }}
        />
      )}
    </div>
  );
}
