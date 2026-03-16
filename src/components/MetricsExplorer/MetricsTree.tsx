import React, { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Database, Server, Layers, BarChart2, GitMerge,
  ChevronRight, ChevronDown, RefreshCw,
} from 'lucide-react';
import { useMetricsTreeStore, MetricsTreeNode } from '../../store/metricsTreeStore';

// queryStore 中 openMetricTab/openMetricListTab 的调用需要等 Task 7 完成
// 这里先用动态导入方式避免循环依赖
function openMetricTab(metricId: number, label: string) {
  import('../../store/queryStore').then(({ useQueryStore }) => {
    (useQueryStore.getState() as any).openMetricTab?.(metricId, label);
  });
}

function openMetricListTab(node: MetricsTreeNode) {
  const { connectionId, database, schema } = node.meta;
  if (!connectionId) return;
  const title = schema ?? database ?? 'Metrics';
  import('../../store/queryStore').then(({ useQueryStore }) => {
    (useQueryStore.getState() as any).openMetricListTab?.({ connectionId, database, schema }, title);
  });
}

interface ContextMenuState {
  node: MetricsTreeNode;
  x: number;
  y: number;
}

export function MetricsTree() {
  const {
    nodes, expandedIds, selectedId, metricCounts, loadingIds,
    init, toggleExpand, selectNode, refreshNode, getChildNodes,
  } = useMetricsTreeStore();
  const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null);

  useEffect(() => { init(); }, []);

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

  const renderNode = (node: MetricsTreeNode, depth: number): React.ReactNode => {
    const isExpanded = expandedIds.has(node.id);
    const isSelected = selectedId === node.id;
    const isLoading = loadingIds.has(node.id);
    const count = metricCounts.get(node.id);
    const children = isExpanded ? getChildNodes(node.id) : [];

    const NodeIcon = () => {
      switch (node.nodeType) {
        case 'connection': return <Server size={14} className="text-blue-400 flex-shrink-0" />;
        case 'database':   return <Database size={14} className="text-cyan-400 flex-shrink-0" />;
        case 'schema':     return <Layers size={14} className="text-indigo-400 flex-shrink-0" />;
        case 'metric':
          return node.meta.metricType === 'composite'
            ? <GitMerge size={14} className="text-purple-400 flex-shrink-0" />
            : <BarChart2 size={14} className="text-green-400 flex-shrink-0" />;
        default: return null;
      }
    };

    return (
      <div key={node.id}>
        <div
          className={`flex items-center gap-1 px-2 py-0.5 cursor-pointer rounded select-none
            ${isSelected ? 'bg-[#1a3a5c] text-white' : 'text-[#a0b4c8] hover:bg-[#1a2a3a] hover:text-white'}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => {
            selectNode(node.id);
            if (node.nodeType !== 'metric') toggleExpand(node.id);
          }}
          onDoubleClick={() => {
            if (node.nodeType === 'metric' && node.meta.metricId) {
              openMetricTab(node.meta.metricId, node.label);
            }
          }}
          onContextMenu={e => handleContextMenu(e, node)}
        >
          {node.hasChildren || node.nodeType !== 'metric' ? (
            <span className="w-4 flex-shrink-0">
              {isLoading
                ? <RefreshCw size={12} className="animate-spin text-[#7a9bb8]" />
                : isExpanded
                  ? <ChevronDown size={12} />
                  : <ChevronRight size={12} />
              }
            </span>
          ) : <span className="w-4 flex-shrink-0" />}

          <NodeIcon />
          <span className="text-xs truncate flex-1 ml-1">{node.label}</span>
          {count !== undefined && (
            <span className="text-[10px] text-[#7a9bb8] flex-shrink-0 ml-1">[{count}]</span>
          )}
        </div>

        {isExpanded && children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  };

  const rootNodes = getChildNodes(null);

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {rootNodes.length === 0 && (
        <div className="px-4 py-4 text-xs text-[#4a6a8a]">暂无数据库连接</div>
      )}
      {rootNodes.map(n => renderNode(n, 0))}

      {contextMenu && (
        <div
          className="fixed z-50 bg-[#1e2d42] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[150px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.node.nodeType === 'metric' ? (
            <>
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-[#a0b4c8] hover:bg-[#253347] hover:text-white"
                onClick={() => {
                  if (contextMenu.node.meta.metricId) {
                    openMetricTab(contextMenu.node.meta.metricId, contextMenu.node.label);
                  }
                  setContextMenu(null);
                }}
              >📂 打开</button>
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-[#a0b4c8] hover:bg-[#253347] hover:text-white"
                onClick={() => {
                  if (contextMenu.node.meta.metricId) {
                    openMetricTab(contextMenu.node.meta.metricId, contextMenu.node.label);
                  }
                  setContextMenu(null);
                }}
              >✏️ 编辑</button>
              <div className="border-t border-[#2a3f5a] my-1" />
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-[#3d1a1a]"
                onClick={async () => {
                  const { metricId } = contextMenu.node.meta;
                  if (!metricId) return;
                  const parentId = contextMenu.node.parentId;
                  try {
                    await invoke('delete_metric', { id: metricId });
                    if (parentId) refreshNode(parentId);
                  } catch (e: any) {
                    alert(e?.message ?? '删除失败');
                  }
                  setContextMenu(null);
                }}
              >🗑️ 删除</button>
            </>
          ) : (
            <>
              {(contextMenu.node.nodeType === 'database' || contextMenu.node.nodeType === 'schema') && (
                <>
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs text-[#a0b4c8] hover:bg-[#253347] hover:text-white"
                    onClick={() => {
                      openMetricListTab(contextMenu.node);
                      setContextMenu(null);
                    }}
                  >📋 打开指标列表</button>
                  <div className="border-t border-[#2a3f5a] my-1" />
                </>
              )}
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-[#a0b4c8] hover:bg-[#253347] hover:text-white"
                onClick={() => {
                  refreshNode(contextMenu.node.id);
                  setContextMenu(null);
                }}
              >🔄 刷新</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
