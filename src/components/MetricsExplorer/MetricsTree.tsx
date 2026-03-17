import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, Loader2,
  Folder, FolderOpen, Database, Layers, BarChart2, GitMerge,
  Eye, RefreshCw, Trash2, List, Plus,
} from 'lucide-react';
import { DbDriverIcon } from '../Explorer/DbDriverIcon';
import { useMetricsTreeStore, MetricsTreeNode, loadPersistedMetricsExpandedIds } from '../../store/metricsTreeStore';
import { useConfirmStore } from '../../store/confirmStore';
import { useQueryStore } from '../../store/queryStore';

interface TreeProps {
  searchQuery?: string;
  onOpenMetricTab?: (metricId: number, title: string) => void;
  onOpenMetricListTab?: (scope: { connectionId: number; database?: string; schema?: string }, title: string) => void;
}

interface ContextMenuState {
  node: MetricsTreeNode;
  x: number;
  y: number;
}


function getIndentLevel(node: MetricsTreeNode, nodes: Map<string, MetricsTreeNode>): number {
  let level = 0;
  let current = node;
  while (current.parentId !== null) {
    const parent = nodes.get(current.parentId);
    if (!parent) break;
    level++;
    current = parent;
  }
  return level;
}

function computeVisible(
  nodes: Map<string, MetricsTreeNode>,
  expandedIds: Set<string>
): MetricsTreeNode[] {
  const result: MetricsTreeNode[] = [];

  function visit(parentId: string | null) {
    const children = Array.from(nodes.values())
      .filter(n => n.parentId === parentId)
      .sort((a, b) =>
        (a.meta.sortOrder ?? 0) - (b.meta.sortOrder ?? 0) || a.label.localeCompare(b.label)
      );
    for (const node of children) {
      result.push(node);
      if (expandedIds.has(node.id)) {
        visit(node.id);
      }
    }
  }

  visit(null);
  return result;
}

export function MetricsTree({ searchQuery = '', onOpenMetricTab, onOpenMetricListTab }: TreeProps) {
  const {
    nodes, expandedIds, selectedId, metricCounts, loadingIds,
    init, toggleExpand, selectNode, refreshNode, deleteMetric, search,
  } = useMetricsTreeStore();
  const confirm = useConfirmStore(s => s.confirm);
  const closeMetricTabById = useQueryStore(s => s.closeMetricTabById);
  const openNewMetricTab = useQueryStore(s => s.openNewMetricTab);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (useMetricsTreeStore.getState().nodes.size === 0) {
      const restoreState = async () => {
        await init();

        const savedExpandedIds = await loadPersistedMetricsExpandedIds();
        if (savedExpandedIds.size === 0) return;

        const restoreNode = async (nodeId: string): Promise<void> => {
          if (!savedExpandedIds.has(nodeId)) return;
          const store = useMetricsTreeStore.getState();
          const node = store.nodes.get(nodeId);
          if (!node) return;

          if (!node.loaded) {
            await store.loadChildren(nodeId);
          }
          if (!useMetricsTreeStore.getState().expandedIds.has(nodeId)) {
            useMetricsTreeStore.getState().toggleExpand(nodeId);
          }
          const children = [...useMetricsTreeStore.getState().nodes.values()].filter(
            (n) => n.parentId === nodeId
          );
          for (const child of children) {
            await restoreNode(child.id);
          }
        };

        const rootNodes = [...useMetricsTreeStore.getState().nodes.values()].filter(
          (n) => n.parentId === null
        );
        for (const node of rootNodes) {
          await restoreNode(node.id);
        }
      };
      restoreState();
    }
  }, []);

  useEffect(() => {
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, node: MetricsTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ node, x: e.clientX, y: e.clientY });
  };

  const handleDeleteMetric = async (node: MetricsTreeNode) => {
    const { metricId } = node.meta;
    if (!metricId) return;
    const isBlank = node.label === '新指标';
    if (!isBlank) {
      const ok = await confirm({
        title: '删除指标',
        message: `确定要删除指标「${node.label}」吗？此操作不可撤销。`,
        variant: 'danger',
        confirmLabel: '删除',
      });
      if (!ok) return;
    }
    try {
      await deleteMetric(metricId, node.id);
      closeMetricTabById(metricId);
    } catch (e: any) {
      setDeleteError(e?.message ?? '删除失败');
    }
  };

  const handleNewMetric = (node: MetricsTreeNode) => {
    const { connectionId, database, schema } = node.meta;
    if (!connectionId) return;
    const scopeTitle = schema && database
      ? `${database}.${schema}`
      : database ?? '新指标';
    openNewMetricTab({ connectionId, database, schema }, scopeTitle);
    setContextMenu(null);
  };

  const visibleNodes = useMemo(
    () => searchQuery.trim() ? search(searchQuery) : computeVisible(nodes, expandedIds),
    [nodes, expandedIds, searchQuery, search]
  );

  const searchExpandedIds = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const resultIds = new Set(visibleNodes.map(n => n.id));
    return new Set(
      visibleNodes.filter(n => n.parentId && resultIds.has(n.parentId)).map(n => n.parentId!)
    );
  }, [visibleNodes, searchQuery]);

  if (visibleNodes.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-[#7a9bb8]">
        {searchQuery.trim() ? '无匹配结果' : '暂无数据库连接'}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {deleteError && (
        <div className="mx-2 mb-1 px-3 py-1.5 text-xs text-red-400 bg-red-900/20 rounded border border-red-900/40 flex items-center justify-between">
          <span>{deleteError}</span>
          <button onClick={() => setDeleteError(null)} className="ml-2 text-red-400/60 hover:text-red-400">✕</button>
        </div>
      )}
      {visibleNodes.map(node => {
        const indent = getIndentLevel(node, nodes);
        const isExpanded = searchExpandedIds ? searchExpandedIds.has(node.id) : expandedIds.has(node.id);
        const isSelected = selectedId === node.id;
        const isLoading = loadingIds.has(node.id);
        const count = metricCounts.get(node.id);

        const isGreen = isExpanded;

        const Icon = node.nodeType === 'group'
          ? (isExpanded ? FolderOpen : Folder)
          : node.nodeType === 'database'
            ? Database
            : node.nodeType === 'schema'
              ? Layers
              : node.nodeType === 'metric'
                ? (node.meta.metricType === 'composite' ? GitMerge : BarChart2)
                : Folder;

        return (
          <div
            key={node.id}
            className={`flex items-center py-1 px-2 cursor-pointer hover:bg-[#1a2639] outline-none select-none ${
              isSelected ? 'bg-[#1e2d42]' : ''
            }`}
            style={{ paddingLeft: `${indent * 12 + 8}px` }}
            tabIndex={0}
            onClick={() => {
              selectNode(node.id);
              if (node.nodeType !== 'metric') toggleExpand(node.id);
            }}
            onDoubleClick={() => {
              if (node.nodeType === 'metric' && node.meta.metricId) {
                onOpenMetricTab?.(node.meta.metricId, node.label);
              }
            }}
            onContextMenu={e => handleContextMenu(e, node)}
          >
            <div className="w-4 h-4 mr-1 flex items-center justify-center text-[#7a9bb8] flex-shrink-0">
              {isLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (node.hasChildren || node.nodeType !== 'metric') ? (
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

            <span className={`text-[13px] truncate flex-1 ${isSelected ? 'text-[#e8f4ff]' : 'text-[#b5cfe8]'}`}>
              {node.label}
            </span>

            {count !== undefined && count > 0 && (
              <span className="text-[10px] text-[#7a9bb8] flex-shrink-0 ml-1">[{count}]</span>
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
          {contextMenu.node.nodeType === 'metric' ? (
            <>
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                onClick={() => {
                  if (contextMenu.node.meta.metricId) {
                    onOpenMetricTab?.(contextMenu.node.meta.metricId, contextMenu.node.label);
                  }
                  setContextMenu(null);
                }}
              ><Eye size={13} />打开</button>
              <div className="h-px bg-[#253347] my-1" />
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-red-400 hover:bg-[#1a2639] hover:text-red-300"
                onClick={async () => {
                  const node = contextMenu.node;
                  setContextMenu(null);
                  await handleDeleteMetric(node);
                }}
              ><Trash2 size={13} />删除</button>
            </>
          ) : (
            <>
              {(contextMenu.node.nodeType === 'database' || contextMenu.node.nodeType === 'schema') && (
                <>
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                    onClick={() => {
                      const { connectionId, database, schema } = contextMenu.node.meta;
                      if (connectionId) {
                        onOpenMetricListTab?.(
                          { connectionId, database, schema },
                          schema && database ? `${database}.${schema}` : schema ?? database ?? 'Metrics'
                        );
                      }
                      setContextMenu(null);
                    }}
                  ><List size={13} />打开指标列表</button>
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                    onClick={() => handleNewMetric(contextMenu.node)}
                  ><Plus size={13} />新增指标</button>
                  <div className="h-px bg-[#253347] my-1" />
                </>
              )}
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                onClick={() => {
                  refreshNode(contextMenu.node.id);
                  setContextMenu(null);
                }}
              ><RefreshCw size={13} />刷新</button>
            </>
          )}
        </div>
      )}

    </div>
  );
}
