import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { invoke } from '@tauri-apps/api/core';
import {
  GitBranch,
  Search,
  Loader2,
  RefreshCw,
  LayoutTemplate,
} from 'lucide-react';
import dagre from 'dagre';
import { useTaskStore } from '../../store';
import { useGraphData } from './useGraphData';
import { nodeTypes } from './nodeTypes';
import { NodeDetail } from './NodeDetail';
import { AliasEditor } from './AliasEditor';
import type { GraphNode } from './useGraphData';

// ── Layout ────────────────────────────────────────────────────────────────────

const NODE_W = 200;
const NODE_H = 80;
const CLUSTER_THRESHOLD = 200;

function buildLayout(
  nodes: Node[],
  edges: Edge[],
  direction: 'LR' | 'TB' = 'LR',
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep: 160, nodesep: 60 });

  nodes.forEach((n) => {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  });
  edges.forEach((e) => {
    if (e.source && e.target) g.setEdge(e.source, e.target);
  });

  dagre.layout(g);

  const laid = nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: {
        x: pos ? pos.x - NODE_W / 2 : 0,
        y: pos ? pos.y - NODE_H / 2 : 0,
      },
    };
  });
  return { nodes: laid, edges };
}

// ── Cluster folding ───────────────────────────────────────────────────────────

function clusterByConnection(rawNodes: GraphNode[]): GraphNode[] {
  if (rawNodes.length <= CLUSTER_THRESHOLD) return rawNodes;

  const byConn: Record<number, GraphNode[]> = {};
  rawNodes.forEach((n) => {
    const cid = n.connection_id ?? 0;
    if (!byConn[cid]) byConn[cid] = [];
    byConn[cid].push(n);
  });

  const result: GraphNode[] = [];
  Object.entries(byConn).forEach(([cid, group]) => {
    // Keep first 50 nodes per connection as representatives; replace rest with a cluster proxy
    const keep = group.slice(0, 50);
    keep.forEach((n) => result.push(n));
    if (group.length > 50) {
      result.push({
        id: `cluster_${cid}`,
        node_type: 'alias',
        name: `[连接 ${cid}：${group.length - 50} 个节点已折叠]`,
        display_name: '',
        aliases: '',
        metadata: '',
        connection_id: Number(cid),
        is_deleted: 0,
        source: 'cluster',
      });
    }
  });
  return result;
}

// ── Graph node / edge conversion ──────────────────────────────────────────────

const NODE_TYPE_MAP: Record<string, string> = {
  table: 'table',
  metric: 'metric',
  alias: 'alias',
};

function toFlowNodes(
  rawNodes: GraphNode[],
  onAddAlias: (nodeId: string) => void,
): Node[] {
  return rawNodes.map((n) => ({
    id: n.id,
    type: NODE_TYPE_MAP[n.node_type] ?? 'table',
    position: { x: 0, y: 0 },
    data: {
      ...n,
      onAddAlias,
    },
  }));
}

function toFlowEdges(rawEdges: { id: string; from_node: string; to_node: string; edge_type: string; weight: number }[]): Edge[] {
  return rawEdges.map((e) => ({
    id: e.id,
    source: e.from_node,
    target: e.to_node,
    label: e.edge_type,
    type: 'smoothstep',
    animated: false,
    data: { edge_type: e.edge_type, weight: e.weight },
  }));
}

// ── Edge Tooltip ──────────────────────────────────────────────────────────────

interface EdgeTooltip {
  x: number;
  y: number;
  edge_type: string;
  weight: number;
}

// ── Main Component (inner, must live inside ReactFlowProvider) ─────────────

interface GraphExplorerInnerProps {
  connectionId: number | null;
}

function GraphExplorerInner({ connectionId }: GraphExplorerInnerProps) {
  const { nodes: rawNodes, edges: rawEdges, loading, error, refetch } = useGraphData(connectionId);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const [typeFilter, setTypeFilter] = useState<string[]>(['table', 'metric', 'alias']);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [edgeTooltip, setEdgeTooltip] = useState<EdgeTooltip | null>(null);
  const [showAliasEditorForNode, setShowAliasEditorForNode] = useState<string | null>(null);

  const { fitView } = useReactFlow();
  const { _addTaskStub, tasks: bgTasks } = useTaskStore();
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up layout timer on unmount
  useEffect(() => {
    return () => {
      if (layoutTimerRef.current !== null) clearTimeout(layoutTimerRef.current);
    };
  }, []);

  // ── Filter + convert nodes ──────────────────────────────────────────────────
  const filteredRaw = useMemo(() => {
    const kw = searchQuery.trim().toLowerCase();
    return rawNodes.filter((n) => {
      if (!typeFilter.includes(n.node_type)) return false;
      if (!kw) return true;
      return (
        n.name.toLowerCase().includes(kw) ||
        n.display_name.toLowerCase().includes(kw) ||
        n.aliases.toLowerCase().includes(kw)
      );
    });
  }, [rawNodes, typeFilter, searchQuery]);

  const clustered = useMemo(() => clusterByConnection(filteredRaw), [filteredRaw]);
  const visibleNodeIds = useMemo(() => new Set(clustered.map((n) => n.id)), [clustered]);

  const filteredEdges = useMemo(
    () => rawEdges.filter((e) => visibleNodeIds.has(e.from_node) && visibleNodeIds.has(e.to_node)),
    [rawEdges, visibleNodeIds],
  );

  // ── Alias editor handler (passed into node data) ────────────────────────────
  const handleAddAlias = useCallback((nodeId: string) => {
    setShowAliasEditorForNode(nodeId);
  }, []);

  // ── Sync to React Flow whenever filtered data changes ───────────────────────
  useEffect(() => {
    const flowNodes = toFlowNodes(clustered, handleAddAlias);
    const flowEdges = toFlowEdges(filteredEdges);
    const { nodes: laid, edges: laidEdges } = buildLayout(flowNodes, flowEdges);
    setRfNodes(laid);
    setRfEdges(laidEdges);
    // Defer fitView until layout is painted
    const timerId = setTimeout(() => {
      fitView({ duration: 600, padding: 0.15, maxZoom: 1 });
    }, 80);
    return () => clearTimeout(timerId);
  }, [clustered, filteredEdges, setRfNodes, setRfEdges, handleAddAlias, fitView]);

  // ── Auto-layout button ──────────────────────────────────────────────────────
  const handleAutoLayout = useCallback(() => {
    const { nodes: laid, edges: laidEdges } = buildLayout(rfNodes, rfEdges);
    setRfNodes([...laid]);
    setRfEdges([...laidEdges]);
    if (layoutTimerRef.current !== null) clearTimeout(layoutTimerRef.current);
    layoutTimerRef.current = setTimeout(() => {
      fitView({ duration: 600, padding: 0.15, maxZoom: 1 });
      layoutTimerRef.current = null;
    }, 50);
  }, [rfNodes, rfEdges, setRfNodes, setRfEdges, fitView]);

  // ── Build schema graph (with TaskBar integration) ───────────────────────────
  const handleBuildGraph = useCallback(async () => {
    if (connectionId === null) return;
    setIsBuilding(true);
    try {
      const result = await invoke<{ task_id?: string } | string>('build_schema_graph', { connectionId });

      let taskId: string | null = null;
      if (result && typeof result === 'object' && 'task_id' in result) {
        taskId = result.task_id ?? null;
      } else if (typeof result === 'string') {
        taskId = result;
      }

      if (taskId) {
        _addTaskStub({
          id: taskId,
          type: 'build_schema_graph',
          status: 'running',
          title: `构建知识图谱 (连接 ${connectionId})`,
          progress: 0,
          processedRows: 0,
          totalRows: null,
          currentTarget: '',
          error: null,
          errorDetails: [],
          outputPath: null,
          description: null,
          startTime: new Date().toISOString(),
          endTime: null,
          connectionId,
        });
      }
      // Note: refetch is triggered by the useEffect that monitors bgTasks completion
    } catch (err) {
      console.warn('[GraphExplorer] build_schema_graph error:', err);
      setIsBuilding(false);
      // Fallback: still try to refresh
      refetch();
    }
  }, [connectionId, refetch, _addTaskStub]);

  // ── Watch bgTasks for build_schema_graph completion ──────────────────────────
  useEffect(() => {
    let lastTask: typeof bgTasks[number] | undefined;
    for (let i = bgTasks.length - 1; i >= 0; i--) {
      if (bgTasks[i].type === 'build_schema_graph' && bgTasks[i].status === 'completed') {
        lastTask = bgTasks[i];
        break;
      }
    }
    if (lastTask) {
      refetch();
      setIsBuilding(false);
    }
  }, [bgTasks, refetch]);

  // ── Alias updated callback ──────────────────────────────────────────────────
  const handleAliasUpdated = useCallback(() => {
    refetch();
    setSelectedNode(null);
  }, [refetch]);

  // ── Node click ──────────────────────────────────────────────────────────────
  const onNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      const raw = rawNodes.find((n) => n.id === node.id);
      if (raw) setSelectedNode(raw);
    },
    [rawNodes],
  );

  // ── Pane double-click → close detail ────────────────────────────────────────
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    if (event.detail >= 2) {
      setSelectedNode(null);
    }
  }, []);

  // ── Edge hover tooltip ──────────────────────────────────────────────────────
  const onEdgeMouseEnter: EdgeMouseHandler = useCallback((_evt, edge) => {
    setEdgeTooltip({
      x: _evt.clientX,
      y: _evt.clientY,
      edge_type: String(edge.data?.edge_type ?? edge.label ?? ''),
      weight: Number(edge.data?.weight ?? 0),
    });
  }, []);

  const onEdgeMouseMove = useCallback((evt: React.MouseEvent) => {
    setEdgeTooltip((prev) => prev ? { ...prev, x: evt.clientX, y: evt.clientY } : prev);
  }, []);

  const onEdgeMouseLeave: EdgeMouseHandler = useCallback(() => {
    setEdgeTooltip(null);
  }, []);

  // ── Type filter toggle ──────────────────────────────────────────────────────
  const toggleType = (type: string) => {
    setTypeFilter((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  };

  // ── No connection state ─────────────────────────────────────────────────────
  if (connectionId === null) {
    return (
      <div className="flex-1 flex flex-col min-w-0 bg-[#0d1117] items-center justify-center">
        <GitBranch size={40} className="text-[#253347] mb-3" />
        <p className="text-[#7a9bb8] text-sm">请先选择数据库连接</p>
      </div>
    );
  }

  const typeButtons = [
    { type: 'table', label: '表', activeClass: 'bg-[#0d2a3d] text-[#3794ff] border-[#3794ff]/50' },
    { type: 'metric', label: '指标', activeClass: 'bg-[#2d1e0d] text-[#f59e0b] border-[#f59e0b]/50' },
    { type: 'alias', label: '别名', activeClass: 'bg-[#1e0d2d] text-[#a855f7] border-[#a855f7]/50' },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#0d1117] overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#1e2d42] flex-shrink-0 bg-[#0d1117]">
        <GitBranch size={16} className="text-[#00c9a7] flex-shrink-0" />
        <span className="text-[#c8daea] text-sm font-semibold mr-2">知识图谱</span>

        {/* Type filter */}
        <div className="flex items-center gap-1">
          {typeButtons.map(({ type, label, activeClass }) => (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                typeFilter.includes(type)
                  ? activeClass
                  : 'text-[#7a9bb8] border-[#1e2d42] hover:border-[#2a3f5a] hover:text-[#c8daea]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs ml-2">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#7a9bb8] pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索节点..."
            className="w-full pl-7 pr-3 py-1 text-xs bg-[#111922] border border-[#1e2d42] rounded text-[#c8daea] placeholder-[#3d5470] focus:outline-none focus:border-[#00c9a7]/50 transition-colors"
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {/* Auto layout */}
          <button
            onClick={handleAutoLayout}
            disabled={rfNodes.length === 0}
            title="自动布局"
            className="flex items-center gap-1 px-2 py-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] bg-[#111922] hover:bg-[#1e2d42] border border-[#1e2d42] rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <LayoutTemplate size={13} />
          </button>

          {/* Build graph */}
          <button
            onClick={handleBuildGraph}
            disabled={isBuilding || loading}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] bg-[#111922] hover:bg-[#1e2d42] border border-[#1e2d42] rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isBuilding || loading
              ? <Loader2 size={13} className="animate-spin" />
              : <RefreshCw size={13} />}
            {isBuilding ? '构建中...' : '构建图谱'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-[#2d1216] border-b border-[#f43f5e]/30 text-[#f43f5e] text-xs flex-shrink-0">
          {error}
        </div>
      )}

      {/* Main canvas area */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative graph-canvas-container" onMouseMove={onEdgeMouseMove}>
          {/* Empty state overlay */}
          {!loading && rfNodes.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
              <GitBranch size={36} className="text-[#253347] mb-3" />
              <p className="text-[#7a9bb8] text-sm">
                {rawNodes.length === 0 ? '暂无图谱数据，请点击「构建图谱」' : '没有匹配的节点'}
              </p>
            </div>
          )}

          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onEdgeMouseEnter={onEdgeMouseEnter}
            onEdgeMouseLeave={onEdgeMouseLeave}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            defaultEdgeOptions={{
              type: 'smoothstep',
              animated: false,
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#1e2d42" gap={20} size={1} />
            <Controls
              className="!bg-[#111922] border border-[#2a3f5a] shadow-lg rounded-md overflow-hidden [&_button]:!bg-[#111922] [&_button]:!border-b [&_button]:!border-[#2a3f5a] [&_button:last-child]:!border-b-0 [&_button]:!fill-[#c8daea] hover:[&_button]:!bg-[#1e2d42]"
            />
            <MiniMap
              position="bottom-left"
              nodeColor={(n) => {
                const t = n.type ?? '';
                if (t === 'table') return '#3794ff';
                if (t === 'metric') return '#f59e0b';
                if (t === 'alias') return '#a855f7';
                return '#1e2d42';
              }}
              maskColor="rgba(13, 17, 23, 0.7)"
              className="!bg-[#111922] !border !border-[#1e2d42] !rounded-md"
            />
          </ReactFlow>

          {/* Edge tooltip */}
          {edgeTooltip && (
            <div
              className="fixed z-[9998] pointer-events-none px-2.5 py-1.5 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg text-[#c8daea] text-xs"
              style={{ left: edgeTooltip.x + 12, top: edgeTooltip.y - 36 }}
            >
              <span className="text-[#7a9bb8]">类型: </span>{edgeTooltip.edge_type}
              <span className="mx-2 text-[#1e2d42]">|</span>
              <span className="text-[#7a9bb8]">权重: </span>{edgeTooltip.weight.toFixed(2)}
            </div>
          )}
        </div>

        {/* Node detail panel */}
        {selectedNode && (
          <NodeDetail
            node={selectedNode}
            edges={rawEdges}
            onClose={() => setSelectedNode(null)}
            onAliasUpdated={handleAliasUpdated}
          />
        )}
      </div>

      {/* Alias editor opened from node canvas button */}
      {showAliasEditorForNode && (() => {
        const targetNode = rawNodes.find((n) => n.id === showAliasEditorForNode);
        if (!targetNode) return null;
        return (
          <AliasEditor
            nodeId={targetNode.id}
            nodeName={targetNode.name}
            currentAliases={targetNode.aliases}
            onSave={() => {
              setShowAliasEditorForNode(null);
              refetch();
            }}
            onClose={() => setShowAliasEditorForNode(null)}
          />
        );
      })()}
    </div>
  );
}

// ── Public export (wrapped with ReactFlowProvider) ────────────────────────────

interface GraphExplorerProps {
  connectionId: number | null;
}

export const GraphExplorer: React.FC<GraphExplorerProps> = ({ connectionId }) => (
  <ReactFlowProvider>
    <GraphExplorerInner connectionId={connectionId} />
  </ReactFlowProvider>
);
