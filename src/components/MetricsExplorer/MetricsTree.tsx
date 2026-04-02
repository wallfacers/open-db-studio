import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, Loader2,
  Folder, FolderOpen, Database, Layers, BarChart2, GitMerge,
  Eye, RefreshCw, Trash2, List, Plus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DbDriverIcon } from '../Explorer/DbDriverIcon';
import { useMetricsTreeStore, MetricsTreeNode, loadPersistedMetricsExpandedIds, flushMetricsPersist } from '../../store/metricsTreeStore';
import { useConfirmStore } from '../../store/confirmStore';
import { useQueryStore } from '../../store/queryStore';

interface TreeProps {
  searchQuery?: string;
  onOpenMetricTab?: (metricId: number, title: string, connectionId?: number) => void;
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
  const { t } = useTranslation();
  const {
    nodes, expandedIds, selectedId, metricCounts, loadingIds, isInitializing,
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

        // 恢复期间直接更新 expandedIds，不经过 toggleExpand，
        // 避免每次展开都触发防抖 persist 写入中间状态。
        const expandNode = (nodeId: string) => {
          useMetricsTreeStore.setState(s => ({
            expandedIds: new Set([...s.expandedIds, nodeId]),
          }));
        };

        const restoreNode = async (nodeId: string): Promise<void> => {
          if (!savedExpandedIds.has(nodeId)) return;
          const store = useMetricsTreeStore.getState();
          const node = store.nodes.get(nodeId);
          if (!node) return;

          if (!node.loaded) {
            await store.loadChildren(nodeId);
          }
          if (!useMetricsTreeStore.getState().expandedIds.has(nodeId)) {
            expandNode(nodeId);
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

        // 恢复完成后一次性持久化最终状态
        flushMetricsPersist();
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
    const isBlank = node.label === t('metricsExplorer.newMetric');
    if (!isBlank) {
      const ok = await confirm({
        title: t('metricsExplorer.metricsTree.deleteTitle'),
        message: t('metricsExplorer.metricsTree.confirmDelete', { name: node.label }),
        variant: 'danger',
        confirmLabel: t('metricsExplorer.metricsTree.delete'),
      });
      if (!ok) return;
    }
    try {
      await deleteMetric(metricId, node.id);
      closeMetricTabById(metricId);
    } catch (e: any) {
      setDeleteError(e?.message ?? t('metricsExplorer.metricsTree.deleteFailed'));
    }
  };

  const handleNewMetric = (node: MetricsTreeNode) => {
    const { connectionId, database, schema } = node.meta;
    if (!connectionId) return;
    const scopeTitle = schema && database
      ? `${database}.${schema}`
      : database ?? t('metricsExplorer.newMetric');
    openNewMetricTab({ connectionId, database, schema }, scopeTitle);
    setContextMenu(null);
  };

  // 搜索模式下被手动折叠的节点（初始全部展开，点击后折叠/展开）
  const [collapsedInSearch, setCollapsedInSearch] = useState<Set<string>>(new Set());

  // 搜索词变化时清空折叠状态
  useEffect(() => {
    setCollapsedInSearch(new Set());
  }, [searchQuery]);

  const visibleNodes = useMemo(() => {
    if (!searchQuery.trim()) return computeVisible(nodes, expandedIds);
    const allSearchNodes = search(searchQuery);
    return allSearchNodes.filter(node => {
      let curParentId: string | null = node.parentId;
      while (curParentId !== null) {
        if (collapsedInSearch.has(curParentId)) return false;
        curParentId = nodes.get(curParentId)?.parentId ?? null;
      }
      return true;
    });
  }, [nodes, expandedIds, searchQuery, search, collapsedInSearch]);

  if (isInitializing) {
    return (
      <div className="px-3 py-2 space-y-1">
        {[80, 64, 72, 56].map((w, i) => (
          <div key={i} className="flex items-center gap-2 h-7 px-1">
            <div className="w-3 h-3 rounded bg-border-default animate-pulse flex-shrink-0" />
            <div className="h-2.5 rounded bg-border-default animate-pulse" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    );
  }

  if (visibleNodes.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-foreground-muted">
        {searchQuery.trim() ? t('metricsExplorer.noResults') : t('metricsExplorer.noConnections')}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {deleteError && (
        <div className="mx-2 mb-1 px-3 py-1.5 text-xs text-error bg-error-subtle rounded border border-error/30 flex items-center justify-between">
          <span>{deleteError}</span>
          <button onClick={() => setDeleteError(null)} className="ml-2 text-error/60 hover:text-error transition-colors duration-200">✕</button>
        </div>
      )}
      {visibleNodes.map(node => {
        const indent = getIndentLevel(node, nodes);
        const isExpanded = searchQuery.trim() ? !collapsedInSearch.has(node.id) : expandedIds.has(node.id);
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
            className={`flex items-center py-1 px-2 cursor-pointer hover:bg-background-hover outline-none select-none transition-colors duration-150 ${
              isSelected ? 'bg-border-default' : ''
            }`}
            style={{ paddingLeft: `${indent * 12 + 8}px` }}
            tabIndex={0}
            onClick={() => {
              selectNode(node.id);
              if (node.nodeType === 'metric') return;
              if (searchQuery.trim()) {
                // 搜索模式：折叠/展开节点
                setCollapsedInSearch(prev => {
                  const next = new Set(prev);
                  if (next.has(node.id)) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                });
              } else {
                toggleExpand(node.id);
              }
            }}
            onDoubleClick={() => {
              if (node.nodeType === 'metric' && node.meta.metricId) {
                onOpenMetricTab?.(node.meta.metricId, node.label, node.meta.connectionId);
              }
            }}
            onContextMenu={e => handleContextMenu(e, node)}
          >
            <div className="w-4 h-4 mr-1 flex items-center justify-center text-foreground-muted flex-shrink-0">
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
                className={`mr-1.5 flex-shrink-0 ${isGreen ? 'text-accent' : 'text-foreground-muted'}`}
              />
            ) : (
              <Icon
                size={14}
                className={`mr-1.5 flex-shrink-0 ${isGreen ? 'text-accent' : 'text-foreground-muted'}`}
              />
            )}

            <span className={`text-[13px] truncate flex-1 ${isSelected ? 'text-foreground' : 'text-foreground'}`}>
              {node.label}
            </span>

            {count !== undefined && count > 0 && (
              <span className="text-[10px] text-foreground-muted flex-shrink-0 ml-1">[{count}]</span>
            )}
          </div>
        );
      })}

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-background-base border border-border-default rounded shadow-xl py-1 min-w-[160px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.node.nodeType === 'metric' ? (
            <>
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover hover:text-foreground transition-colors duration-150"
                onClick={() => {
                  if (contextMenu.node.meta.metricId) {
                    onOpenMetricTab?.(contextMenu.node.meta.metricId, contextMenu.node.label, contextMenu.node.meta.connectionId);
                  }
                  setContextMenu(null);
                }}
              ><Eye size={13} />{t('metricsExplorer.metricsTree.open')}</button>
              <div className="h-px bg-border-strong my-1" />
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-error hover:bg-background-hover hover:text-error-foreground transition-colors duration-150"
                onClick={async () => {
                  const node = contextMenu.node;
                  setContextMenu(null);
                  await handleDeleteMetric(node);
                }}
              ><Trash2 size={13} />{t('metricsExplorer.metricsTree.delete')}</button>
            </>
          ) : (
            <>
              {(contextMenu.node.nodeType === 'database' || contextMenu.node.nodeType === 'schema') && (
                <>
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover hover:text-foreground transition-colors duration-150"
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
                  ><List size={13} />{t('metricsExplorer.metricsTree.openMetricList')}</button>
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover hover:text-foreground transition-colors duration-150"
                    onClick={() => handleNewMetric(contextMenu.node)}
                  ><Plus size={13} />{t('metricsExplorer.metricsTree.addMetric')}</button>
                  <div className="h-px bg-border-strong my-1" />
                </>
              )}
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover hover:text-foreground transition-colors duration-150"
                onClick={() => {
                  refreshNode(contextMenu.node.id);
                  setContextMenu(null);
                }}
              ><RefreshCw size={13} />{t('metricsExplorer.metricsTree.refresh')}</button>
            </>
          )}
        </div>
      )}

    </div>
  );
}
