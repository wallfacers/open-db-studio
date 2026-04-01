import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { invoke } from '@tauri-apps/api/core';
import {
  Network,
  Search,
  Loader2,
  RefreshCw,
  LayoutTemplate,
  Sparkles,
  ListTodo,
} from 'lucide-react';
import dagre from 'dagre';
import { useTranslation } from 'react-i18next';
import { useTaskStore } from '../../store';
import { useConnectionStore } from '../../store/connectionStore';
import { useGraphData } from './useGraphData';
import { nodeTypes, edgeTypes } from './nodeTypes';
import { getEdgeStyleBySource } from './graphUtils';
import { NodeDetail } from './NodeDetail';
import { AliasEditor } from './AliasEditor';
import { DropdownSelect } from '../common/DropdownSelect';
import type { GraphNode } from './useGraphData';
import { GraphSearchPanel } from './GraphSearchPanel';
import { Tooltip } from '../common/Tooltip';
import { useConfirmStore } from '../../store/confirmStore';
import { BaseModal } from '../common/BaseModal';

// ── Layout ────────────────────────────────────────────────────────────────────

const NODE_W = 240;
const NODE_H = 100;
const LINK_NODE_W = 260;
const LINK_NODE_H = 70;
const CLUSTER_THRESHOLD = 200;

/** 节点是否拥有已保存的坐标（position_x/position_y 非 null） */
function hasSavedPosition(n: Node): boolean {
  const d = n.data as Record<string, unknown> | undefined;
  return d?.position_x != null && d?.position_y != null;
}

function buildLayout(
  nodes: Node[],
  edges: Edge[],
  direction: 'LR' | 'TB' = 'LR',
  forceRelayout = false,
): { nodes: Node[]; edges: Edge[] } {
  // 如果所有节点都有已保存坐标且不是强制重排，直接使用保存的坐标
  const allSaved = !forceRelayout && nodes.length > 0 && nodes.every(hasSavedPosition);
  if (allSaved) return { nodes, edges };

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep: 200, nodesep: 80 });

  nodes.forEach((n) => {
    const isLink = n.type === 'link';
    g.setNode(n.id, { width: isLink ? LINK_NODE_W : NODE_W, height: isLink ? LINK_NODE_H : NODE_H });
  });
  edges.forEach((e) => {
    if (e.source && e.target) g.setEdge(e.source, e.target);
  });

  dagre.layout(g);

  const laid = nodes.map((n) => {
    // 有已保存坐标且非强制重排时保持原位
    if (!forceRelayout && hasSavedPosition(n)) return n;
    const pos = g.node(n.id);
    const isLink = n.type === 'link';
    const w = isLink ? LINK_NODE_W : NODE_W;
    const h = isLink ? LINK_NODE_H : NODE_H;
    return {
      ...n,
      position: {
        x: pos ? pos.x - w / 2 : 0,
        y: pos ? pos.y - h / 2 : 0,
      },
    };
  });
  return { nodes: laid, edges };
}

// ── Cluster folding ───────────────────────────────────────────────────────────

function clusterByConnection(rawNodes: GraphNode[]): GraphNode[] {
  if (rawNodes.length <= CLUSTER_THRESHOLD) return rawNodes;

  const result: GraphNode[] = [];
  const byConn: Record<number, { links: GraphNode[]; objects: GraphNode[] }> = {};

  rawNodes.forEach(n => {
    const cid = n.connection_id ?? 0;
    if (!byConn[cid]) byConn[cid] = { links: [], objects: [] };
    if (n.node_type === 'link') byConn[cid].links.push(n);
    else byConn[cid].objects.push(n);
  });

  Object.entries(byConn).forEach(([cid, { links, objects }]) => {
    const linkQuota = Math.min(links.length, 50);
    const objectQuota = Math.max(0, 50 - linkQuota);
    links.slice(0, linkQuota).forEach(n => result.push(n));
    objects.slice(0, objectQuota).forEach(n => result.push(n));
    const collapsed = objects.length - objectQuota;
    if (collapsed > 0) {
      result.push({
        id: `cluster_${cid}`,
        node_type: 'alias',
        name: `[连接 ${cid}：${collapsed} 个节点已折叠]`,
        display_name: '',
        aliases: '',
        metadata: '',
        connection_id: Number(cid),
        is_deleted: 0,
        source: 'cluster',
        position_x: null,
        position_y: null,
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
  link: 'link',   // 新增
};

function toFlowNodes(
  rawNodes: GraphNode[],
  onAddAlias: (nodeId: string) => void,
  onHighlightLinks: (nodeId: string) => void,
  linkCountMap: Record<string, number>,
  columnMap: Record<string, import('./GraphNodeComponents').ColumnInfo[]>,
): Node[] {
  return rawNodes.map((n) => ({
    id: n.id,
    type: NODE_TYPE_MAP[n.node_type] ?? 'table',
    position: {
      x: n.position_x ?? 0,
      y: n.position_y ?? 0,
    },
    data: {
      ...n,
      onAddAlias,
      onHighlightLinks,
      linkCount: linkCountMap[n.id] ?? 0,
      tableColumns: n.node_type === 'table' ? (columnMap[n.id] ?? []) : undefined,
    },
  }));
}

function toFlowEdges(
  rawEdges: { id: string; from_node: string; to_node: string; edge_type: string; weight: number; source?: string }[],
  selfRefLinkIds?: Set<string>,
): Edge[] {
  return rawEdges.map((e) => {
    // 自引用 link 边：to_link 用 Top handles，from_link 用 Bottom handles
    const isSelfRefToLink = selfRefLinkIds?.has(e.to_node) && e.edge_type === 'to_link';
    const isSelfRefFromLink = selfRefLinkIds?.has(e.from_node) && e.edge_type === 'from_link';

    return {
      id: e.id,
      source: e.from_node,
      target: e.to_node,
      type: e.from_node === e.to_node ? 'selfLoop' : 'relation',
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: '#4a6380' },
      style: getEdgeStyleBySource(e.source ?? 'schema'),
      data: { edge_type: e.edge_type, weight: e.weight, edgeSource: e.source ?? 'schema' },
      // 自引用 to_link: Table(top-source) → Link(self-target)
      ...(isSelfRefToLink ? { sourceHandle: 'top-source', targetHandle: 'self-target' } : {}),
      // 自引用 from_link: Link(self-source) → Table(bottom-target)
      ...(isSelfRefFromLink ? { sourceHandle: 'self-source', targetHandle: 'bottom-target' } : {}),
    };
  });
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
  database?: string | null;
  hidden?: boolean;
}

function GraphExplorerInner({ connectionId, database, hidden }: GraphExplorerInnerProps) {
  const { t } = useTranslation();

  // ── Independent connection / database selection ────────────────────────────
  const { connections, loadConnections } = useConnectionStore();
  const [internalConnId, setInternalConnId] = useState<number | null>(() => connectionId);
  const [internalDb, setInternalDb] = useState<string | null>(() => database ?? null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  // Ensure connections are loaded
  useEffect(() => {
    if (connections.length === 0) loadConnections();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load database list when connection changes
  useEffect(() => {
    if (internalConnId === null) {
      setDatabases([]);
      setDbError(null);
      return;
    }
    let cancelled = false;
    setDbLoading(true);
    setDbError(null);

    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        cancelled = true;
        setDbLoading(false);
        setDbError('加载超时');
      }
    }, 15000);

    invoke<string[]>('list_databases_for_metrics', { connectionId: internalConnId })
      .then(dbs => { if (!cancelled) setDatabases(dbs); })
      .catch((err) => {
        if (!cancelled) {
          setDatabases([]);
          setDbError(typeof err === 'string' ? err : '加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setDbLoading(false);
        clearTimeout(timeoutId);
      });

    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [internalConnId]);

  const { nodes: rawNodes, edges: rawEdges, loading, error, refetch } = useGraphData(internalConnId, internalDb);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const [typeFilter, setTypeFilter] = useState<string[]>(['table', 'metric', 'alias', 'link']);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [currentBuildTaskId, setCurrentBuildTaskId] = useState<string | null>(null);
  const [buildInfo, setBuildInfo] = useState<string | null>(null);
  const [edgeTooltip, setEdgeTooltip] = useState<EdgeTooltip | null>(null);
  const [showAliasEditorForNode, setShowAliasEditorForNode] = useState<string | null>(null);

  // ── Search panel & path query state ────────────────────────────────────────
  const [activePanel, setActivePanel] = useState<'detail' | 'search' | null>(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [highlightedEdgeIds, setHighlightedEdgeIds] = useState<Set<string>>(new Set());
  const [pathFrom, setPathFrom] = useState<GraphNode | null>(null);
  const [pathTo, setPathTo] = useState<GraphNode | null>(null);
  const [subgraphMode, setSubgraphMode] = useState(false);
  const [subgraphNodeIds, setSubgraphNodeIds] = useState<Set<string>>(new Set());

  const [editMode, setEditMode] = useState(false);

  // ── 编辑模式弹框状态 ──────────────────────────────────────────────────────
  const [showAddNodeModal, setShowAddNodeModal] = useState(false);
  const [addNodeName, setAddNodeName] = useState('');
  const [addNodeLoading, setAddNodeLoading] = useState(false);
  const [pendingConnect, setPendingConnect] = useState<{ source: string; target: string } | null>(null);
  const [connectEdgeType, setConnectEdgeType] = useState<'user_defined' | 'join_path'>('user_defined');

  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);

  // 本次会话中拖拽过的节点位置（避免 useEffect 重建时被覆盖）
  const draggedPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // ── Node click focus state (1-hop neighbor highlight) ────────────────────────
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  const handleHighlightLinks = useCallback((nodeId: string) => {
    setHighlightedNodeId(prev => prev === nodeId ? null : nodeId);
  }, []);

  // ── Edit mode: add virtual node ─────────────────────────────────────────────
  const handleAddVirtualNode = useCallback(() => {
    setAddNodeName('');
    setShowAddNodeModal(true);
  }, []);

  const handleAddNodeSubmit = useCallback(async () => {
    const name = addNodeName.trim();
    if (!name || !internalConnId) return;
    setAddNodeLoading(true);
    try {
      await invoke('add_user_node', {
        connectionId: internalConnId,
        name,
        displayName: name,
        nodeType: 'table',
      });
      setShowAddNodeModal(false);
      refetch();
    } catch (e) {
      console.error('添加虚拟节点失败', e);
      alert(`添加节点失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAddNodeLoading(false);
    }
  }, [addNodeName, internalConnId, refetch]);

  // ── Edit mode: manual connect ───────────────────────────────────────────────
  const onConnect = useCallback((params: Connection) => {
    if (!editMode || !params.source || !params.target) return;
    setConnectEdgeType('user_defined');
    setPendingConnect({ source: params.source, target: params.target });
  }, [editMode]);

  const handleConnectSubmit = useCallback(async () => {
    if (!pendingConnect) return;
    try {
      await invoke('add_user_edge', {
        fromNode: pendingConnect.source,
        toNode: pendingConnect.target,
        edgeType: connectEdgeType,
        weight: 1.0,
      });
      setPendingConnect(null);
      refetch();
    } catch (e) {
      console.error('添加边失败', e);
      alert(`添加边失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [pendingConnect, connectEdgeType, refetch]);

  const { fitView, setCenter, getZoom } = useReactFlow();
  const { _addTaskStub, tasks: bgTasks, loadTasks } = useTaskStore();
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
        n.name?.toLowerCase().includes(kw) ||
        n.display_name?.toLowerCase().includes(kw) ||
        (n.aliases ?? '').toLowerCase().includes(kw)
      );
    });
  }, [rawNodes, typeFilter, searchQuery]);

  const linkCountMap = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    filteredRaw
      .filter(n => n.node_type === 'link')
      .forEach(n => {
        try {
          const meta = JSON.parse(n.metadata || '{}') as { source_node_id?: string; target_node_id?: string };
          if (meta.source_node_id) map[meta.source_node_id] = (map[meta.source_node_id] ?? 0) + 1;
          if (meta.target_node_id) map[meta.target_node_id] = (map[meta.target_node_id] ?? 0) + 1;
        } catch { /* ignore */ }
      });
    return map;
  }, [filteredRaw]);

  // ── 列节点映射：tableNodeId → ColumnInfo[] ───────────────────────────────────
  const columnMap = useMemo<Record<string, import('./GraphNodeComponents').ColumnInfo[]>>(() => {
    const map: Record<string, import('./GraphNodeComponents').ColumnInfo[]> = {};
    rawNodes
      .filter(n => n.node_type === 'column')
      .forEach(n => {
        // 列节点 ID 格式: "{conn_id}:column:{table_name}:{col_name}"
        // 目标表节点 ID: "{conn_id}:table:{table_name}"
        const match = n.id.match(/^(\d+):column:(.+):.+$/);
        if (!match) return;
        const tableId = `${match[1]}:table:${match[2]}`;
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(n.metadata || '{}'); } catch { /* ignore */ }
        if (!map[tableId]) map[tableId] = [];
        map[tableId].push({
          name: n.name,
          data_type: meta.data_type as string | undefined,
          is_primary_key: Boolean(meta.is_primary_key),
          is_nullable: Boolean(meta.is_nullable),
        });
      });
    return map;
  }, [rawNodes]);

  const sourceNodes = useMemo(
    () => subgraphMode ? filteredRaw.filter(n => subgraphNodeIds.has(n.id)) : filteredRaw,
    [filteredRaw, subgraphMode, subgraphNodeIds],
  );
  const clustered = useMemo(() => clusterByConnection(sourceNodes), [sourceNodes]);

  // 数据重新加载后清除拖拽缓存（rawNodes 已包含最新 position_x/position_y）
  const prevClusteredRef = useRef(clustered);
  if (prevClusteredRef.current !== clustered) {
    prevClusteredRef.current = clustered;
    draggedPositionsRef.current.clear();
  }

  const nodeNameMap = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    rawNodes.forEach(n => { map[n.id] = n.display_name || n.name; });
    return map;
  }, [rawNodes]);
  const visibleNodeIds = useMemo(() => new Set(clustered.map((n) => n.id)), [clustered]);

  // 自引用 Link Node ID 集合（source_table === target_table）
  const selfRefLinkIds = useMemo(() => {
    const ids = new Set<string>();
    filteredRaw.filter(n => n.node_type === 'link').forEach(n => {
      try {
        const meta = JSON.parse(n.metadata || '{}');
        if (meta.source_table && meta.source_table === meta.target_table) {
          ids.add(n.id);
        }
      } catch { /* ignore */ }
    });
    return ids;
  }, [filteredRaw]);

  const filteredEdges = useMemo(() => {
    // 正常两段式边（Link Node 开启时）
    const normal = rawEdges.filter(
      (e) => visibleNodeIds.has(e.from_node) && visibleNodeIds.has(e.to_node)
    );

    // 合成直连边（Link Node 关闭时，从 Link Node metadata 重建）
    const synthetic: typeof rawEdges = typeFilter.includes('link')
      ? []
      : filteredRaw
          .filter(n => n.node_type === 'link')
          .flatMap(n => {
            try {
              const meta = JSON.parse(n.metadata || '{}') as {
                source_node_id?: string;
                target_node_id?: string;
                edge_type?: string;
                weight?: number;
              };
              if (!meta.source_node_id || !meta.target_node_id) return [];
              if (!visibleNodeIds.has(meta.source_node_id) || !visibleNodeIds.has(meta.target_node_id)) return [];
              return [{
                id: `synthetic_${n.id}`,
                from_node: meta.source_node_id,
                to_node: meta.target_node_id,
                edge_type: meta.edge_type ?? 'fk',
                weight: meta.weight ?? 0.95,
                source: 'schema',
              }];
            } catch { return []; }
          });

    return [...normal, ...synthetic];
  }, [rawEdges, visibleNodeIds, typeFilter, filteredRaw]);

  // ── Alias editor handler (passed into node data) ────────────────────────────
  const handleAddAlias = useCallback((nodeId: string) => {
    setShowAliasEditorForNode(nodeId);
  }, []);

  // ── Sync to React Flow whenever filtered data changes ───────────────────────
  useEffect(() => {
    const flowNodes = toFlowNodes(clustered, handleAddAlias, handleHighlightLinks, linkCountMap, columnMap).map(n => ({
      ...n,
      data: {
        ...n.data,
        isHighlighted: highlightedNodeIds.has(n.id),
        isDimmed: highlightedNodeIds.size > 0 && !highlightedNodeIds.has(n.id),
        isPathFrom: pathFrom?.id === n.id,
        isPathTo: pathTo?.id === n.id,
      },
    }));
    const flowEdges = toFlowEdges(filteredEdges, selfRefLinkIds).map(e => {
      const isHighlighted = highlightedEdgeIds.has(e.id);
      const isDimmed = highlightedEdgeIds.size > 0 && !highlightedEdgeIds.has(e.id);
      return {
        ...e,
        data: {
          ...e.data,
          highlighted: isHighlighted,
          dimmed: isDimmed,
        },
        // Keep style for backwards compatibility with non-RelationEdge edges
        style: {
          ...e.style,
          ...(isHighlighted ? { stroke: 'var(--accent)', strokeWidth: 3 } : {}),
          ...(isDimmed ? { opacity: 0.3 } : {}),
        },
        animated: isHighlighted,
      };
    });
    // 合并本次会话拖拽过的坐标，防止高亮/焦点等状态变化导致位置回弹
    const mergedNodes = flowNodes.map(n => {
      const dragged = draggedPositionsRef.current.get(n.id);
      if (dragged) return { ...n, position: dragged };
      return n;
    });
    const { nodes: laid, edges: laidEdges } = buildLayout(mergedNodes, flowEdges);
    setRfNodes(laid);
    setRfEdges(laidEdges);
    // Defer fitView until layout is painted, but skip when a node is focused
    // (focused node uses setCenter in onNodeClick for smooth centering)
    if (!focusedNodeId) {
      const timerId = setTimeout(() => {
        fitView({ duration: 600, padding: 0.15, maxZoom: 1 });
      }, 80);
      return () => clearTimeout(timerId);
    }
  }, [clustered, filteredEdges, setRfNodes, setRfEdges, handleAddAlias, handleHighlightLinks, linkCountMap, fitView, highlightedNodeIds, highlightedEdgeIds, pathFrom, pathTo, focusedNodeId, selfRefLinkIds]);

  // ── 拖拽结束保存坐标 ──────────────────────────────────────────────────────
  const onNodeDragStop: NodeMouseHandler = useCallback((_event, node) => {
    // 同时保存到 ref（防止 useEffect 重建时覆盖）和数据库
    draggedPositionsRef.current.set(node.id, { x: node.position.x, y: node.position.y });
    invoke('save_graph_node_position', {
      nodeId: node.id,
      x: node.position.x,
      y: node.position.y,
    }).catch((err) => console.warn('[GraphExplorer] save position failed:', err));
  }, []);

  // ── Auto-layout button ──────────────────────────────────────────────────────
  const handleAutoLayout = useCallback(async () => {
    // 清除本次拖拽缓存和数据库中的已保存坐标
    draggedPositionsRef.current.clear();
    if (internalConnId !== null) {
      await invoke('clear_graph_node_positions', {
        connectionId: internalConnId,
        database: internalDb ?? null,
      }).catch((err) => console.warn('[GraphExplorer] clear positions failed:', err));
    }
    const { nodes: laid, edges: laidEdges } = buildLayout(rfNodes, rfEdges, 'LR', true);
    setRfNodes([...laid]);
    setRfEdges([...laidEdges]);
    if (layoutTimerRef.current !== null) clearTimeout(layoutTimerRef.current);
    layoutTimerRef.current = setTimeout(() => {
      fitView({ duration: 600, padding: 0.15, maxZoom: 1 });
      layoutTimerRef.current = null;
    }, 50);
  }, [rfNodes, rfEdges, setRfNodes, setRfEdges, fitView, internalConnId, internalDb]);

  // ── Delete/Backspace 键删除拦截 ────────────────────────────────────────────
  const onBeforeDelete = useCallback(async ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
    if (!editMode) return false;

    // 筛选可删除项：节点仅 source='user'，边仅 source='user'|'comment'
    const deletableNodes = nodes.filter(n => (n.data as Record<string, unknown>)?.source === 'user');
    const deletableEdges = edges.filter(e => {
      const s = String((e.data as Record<string, unknown>)?.edgeSource ?? 'schema');
      return s === 'user' || s === 'comment';
    });

    if (deletableNodes.length === 0 && deletableEdges.length === 0) return false;

    const parts: string[] = [];
    if (deletableNodes.length > 0) parts.push(`${deletableNodes.length} 个节点`);
    if (deletableEdges.length > 0) parts.push(`${deletableEdges.length} 条边`);

    const ok = await useConfirmStore.getState().confirm({
      title: '删除确认',
      message: `确认删除选中的 ${parts.join(' 和 ')}？此操作不可撤销。`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      variant: 'danger',
    });
    if (!ok) return false;

    try {
      for (const n of deletableNodes) {
        await invoke('delete_graph_node', { nodeId: n.id });
      }
      for (const e of deletableEdges) {
        await invoke('delete_graph_edge', { edgeId: e.id });
      }
      refetch();
    } catch (err) {
      console.error('删除失败', err);
      alert(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false; // 由 refetch 刷新，不需要 React Flow 自行移除
  }, [editMode, refetch]);

  // ── Build schema graph (with TaskBar integration) ───────────────────────────
  const handleBuildGraph = useCallback(async () => {
    if (internalConnId === null) return;
    setIsBuilding(true);
    try {
      const result = await invoke<{ task_id?: string } | string>('build_schema_graph', { connectionId: internalConnId, database: internalDb ?? null });

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
          title: `构建知识图谱 (连接 ${internalConnId})`,
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
          connectionId: internalConnId,
        });
        setCurrentBuildTaskId(taskId);
        setBuildInfo(t('graphExplorer.taskStarted'));
        // 从 SQLite 加载任务实际状态，处理快速完成的构建（事件可能早于 stub 到达）
        loadTasks();
      }
      // Note: refetch is triggered by the useEffect that monitors bgTasks completion
    } catch (err) {
      console.warn('[GraphExplorer] build_schema_graph error:', err);
      setIsBuilding(false);
      // Fallback: still try to refresh
      refetch();
    }
  }, [connectionId, refetch, _addTaskStub, loadTasks]);

  // ── Watch bgTasks for build_schema_graph completion ──────────────────────────
  useEffect(() => {
    if (!currentBuildTaskId) return;
    const task = bgTasks.find((t) => t.id === currentBuildTaskId);
    if (task && (task.status === 'completed' || task.status === 'failed')) {
      refetch();
      setIsBuilding(false);
      setCurrentBuildTaskId(null);
    }
  }, [bgTasks, currentBuildTaskId, refetch]);

  // ── Polling fallback: 若 emit_completed 在 _addTaskStub 前到达则任务会丢失，
  //    每 2s 轮询一次 loadTasks 确保状态最终同步 ──────────────────────────────
  useEffect(() => {
    if (!currentBuildTaskId) return undefined;
    const timer = setInterval(loadTasks, 2000);
    return () => clearInterval(timer);
  }, [currentBuildTaskId, loadTasks]);

  // ── Alias updated callback ──────────────────────────────────────────────────
  const handleAliasUpdated = useCallback(() => {
    refetch();
    setSelectedNode(null);
  }, [refetch]);

  // ── Search panel handlers ───────────────────────────────────────────────────

  const handleHighlightNode = useCallback((nodeId: string) => {
    setHighlightedNodeIds(new Set([nodeId]));
    setHighlightedEdgeIds(new Set());
    setTimeout(() => setHighlightedNodeIds(new Set()), 2000);
  }, []);

  const handleHighlightPath = useCallback((nodeIds: Set<string>, edgeIds: Set<string>) => {
    setHighlightedNodeIds(new Set(nodeIds));
    setHighlightedEdgeIds(new Set(edgeIds));
  }, []);

  const handleEnterSubgraph = useCallback((nodeIds: Set<string>) => {
    setSubgraphNodeIds(nodeIds);
    setSubgraphMode(true);
  }, []);

  const handleExitSubgraph = useCallback(() => {
    setSubgraphMode(false);
    setSubgraphNodeIds(new Set());
    setHighlightedNodeIds(new Set());
    setHighlightedEdgeIds(new Set());
  }, []);

  // ── Node click → focus 1-hop neighbors + open detail ────────────────────────
  const onNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      // Calculate 1-hop neighbors from filteredEdges
      const neighborNodeIds = new Set<string>();
      const neighborEdgeIds = new Set<string>();

      filteredEdges.forEach(edge => {
        if (edge.from_node === node.id) {
          neighborNodeIds.add(edge.to_node);
          neighborEdgeIds.add(edge.id);
        } else if (edge.to_node === node.id) {
          neighborNodeIds.add(edge.from_node);
          neighborEdgeIds.add(edge.id);
        }
      });

      // Include the clicked node itself
      neighborNodeIds.add(node.id);

      // Set focus state
      setFocusedNodeId(node.id);
      setHighlightedNodeIds(neighborNodeIds);
      setHighlightedEdgeIds(neighborEdgeIds);

      // Smoothly center the clicked node in viewport
      const nodeWidth = node.measured?.width ?? (node.type === 'link' ? 260 : 240);
      const nodeHeight = node.measured?.height ?? (node.type === 'link' ? 70 : 100);
      const centerX = (node.position?.x ?? 0) + nodeWidth / 2;
      const centerY = (node.position?.y ?? 0) + nodeHeight / 2;
      setCenter(centerX, centerY, { zoom: getZoom(), duration: 300 });

      // Open detail panel
      const raw = rawNodes.find((n) => n.id === node.id);
      if (raw) {
        setSelectedNode(raw);
        setActivePanel('detail');
      }
    },
    [rawNodes, filteredEdges, setCenter, getZoom],
  );

  // ── Pane click → clear focus; double-click → close detail ───────────────────
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    // Always clear focus state on any pane click
    setFocusedNodeId(null);
    setHighlightedNodeIds(new Set());
    setHighlightedEdgeIds(new Set());

    // Double-click also closes detail panel
    if (event.detail >= 2) {
      setSelectedNode(null);
      setActivePanel(null);
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

  // ── 右键菜单状态 ─────────────────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number;
    type: 'edge' | 'node';
    id: string;
    edgeSource?: string;
    nodeSource?: string;
    label?: string;
  } | null>(null);

  // 点击其他区域关闭右键菜单
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // 编辑模式下右键边 → 弹出上下文菜单
  const onEdgeContextMenu: EdgeMouseHandler = useCallback((evt, edge) => {
    evt.preventDefault();
    if (!editMode) return;
    const edgeSource = String(edge.data?.edgeSource ?? 'schema');
    if (edgeSource !== 'user' && edgeSource !== 'comment') return;
    setContextMenu({
      x: evt.clientX,
      y: evt.clientY,
      type: 'edge',
      id: edge.id,
      edgeSource,
      label: String(edge.data?.edge_type ?? ''),
    });
  }, [editMode]);

  // 编辑模式下右键节点 → 弹出上下文菜单
  const onNodeContextMenu: NodeMouseHandler = useCallback((evt, node) => {
    evt.preventDefault();
    if (!editMode) return;
    const nodeSource = String((node.data as Record<string, unknown>)?.source ?? 'schema');
    if (nodeSource !== 'user') return;
    setContextMenu({
      x: evt.clientX,
      y: evt.clientY,
      type: 'node',
      id: node.id,
      nodeSource,
      label: String((node.data as Record<string, unknown>)?.display_name || (node.data as Record<string, unknown>)?.name || ''),
    });
  }, [editMode]);

  const handleContextMenuDelete = useCallback(async () => {
    if (!contextMenu) return;
    const { type, id, edgeSource, nodeSource, label } = contextMenu;
    setContextMenu(null);

    const itemLabel = type === 'edge'
      ? `${edgeSource === 'user' ? '用户自定义' : '注释推断'}关系`
      : `用户节点「${label}」`;

    const ok = await useConfirmStore.getState().confirm({
      title: type === 'edge' ? '删除关系' : '删除节点',
      message: `确认删除${itemLabel}？${type === 'node' ? '该节点相关的自定义边也将一并删除。' : ''}此操作不可撤销。`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      variant: 'danger',
    });
    if (!ok) return;

    try {
      if (type === 'edge') {
        await invoke('delete_graph_edge', { edgeId: id });
      } else {
        await invoke('delete_graph_node', { nodeId: id });
      }
      refetch();
    } catch (e) {
      console.error(`删除${type === 'edge' ? '边' : '节点'}失败`, e);
      alert(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [contextMenu, refetch]);

  // ── Type filter toggle ──────────────────────────────────────────────────────
  const toggleType = (type: string) => {
    setTypeFilter((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  };

  const typeButtons = [
    { type: 'table', label: t('graphExplorer.typeTable'), activeClass: 'bg-[#0d2a3d] text-[#3794ff] border-[#3794ff]/50' },
    { type: 'metric', label: t('graphExplorer.typeMetric'), activeClass: 'bg-[#2d1e0d] text-[#f59e0b] border-[#f59e0b]/50' },
    { type: 'alias', label: t('graphExplorer.typeAlias'), activeClass: 'bg-[#1e0d2d] text-[#a855f7] border-[#a855f7]/50' },
    { type: 'link', label: t('graphExplorer.typeLink'), activeClass: 'bg-[#0d1f1a] text-[var(--accent)] border-[var(--accent)]/50' },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[var(--background-base)] overflow-hidden" style={{ display: hidden ? 'none' : undefined }}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-default)] flex-shrink-0 bg-[var(--background-base)]">
        <Network size={16} className="text-[var(--accent)] flex-shrink-0" />
        <span className="text-[var(--foreground-default)] text-sm font-semibold mr-2">{t('graphExplorer.title')}</span>

        {/* Connection selector */}
        <DropdownSelect
          value={internalConnId !== null ? String(internalConnId) : ''}
          options={connections.map(c => ({ value: String(c.id), label: c.name }))}
          placeholder={t('graphExplorer.selectConnection')}
          onChange={(v) => {
            setInternalConnId(v ? Number(v) : null);
            setInternalDb(null);
          }}
          className="w-36"
        />

        {/* Database selector (optional, shown when databases are available) */}
        {internalConnId !== null && databases.length > 0 && !dbLoading && (
          <DropdownSelect
            value={internalDb ?? ''}
            options={databases.map(db => ({ value: db, label: db }))}
            placeholder={t('graphExplorer.allDatabases', '全部数据库')}
            onChange={(v) => setInternalDb(v || null)}
            className="w-32"
          />
        )}
        {internalConnId !== null && dbLoading && (
          <Loader2 size={14} className="animate-spin text-[var(--foreground-muted)]" />
        )}
        {internalConnId !== null && !dbLoading && dbError && (
          <span className="text-[11px] text-red-400" title={dbError}>{dbError}</span>
        )}

        {/* Type filter */}
        <div className="flex items-center gap-1">
          {typeButtons.map(({ type, label, activeClass }) => (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                typeFilter.includes(type)
                  ? activeClass
                  : 'text-[var(--foreground-muted)] border-[var(--border-default)] hover:border-[var(--border-strong)] hover:text-[var(--foreground-default)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs ml-2">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)] pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('graphExplorer.searchPlaceholder')}
            className="w-full pl-7 pr-3 py-1 text-xs bg-[var(--background-panel)] border border-[var(--border-default)] rounded text-[var(--foreground-default)] placeholder-[#3d5470] focus:outline-none focus:border-[var(--accent)]/50 transition-colors"
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {/* Search panel toggle */}
          <Tooltip content="实体搜索 / 路径查询" className="contents">
            <button
              onClick={() => {
                if (activePanel === 'search') {
                  setActivePanel(null);
                } else {
                  setSelectedNode(null);
                  setActivePanel('search');
                }
              }}
              className={`flex items-center gap-1 px-2 py-1 text-xs border rounded transition-colors ${
                activePanel === 'search'
                  ? 'text-[var(--accent)] bg-[#0a1f18] border-[var(--accent-hover)55]'
                  : 'text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] bg-[var(--background-panel)] hover:bg-[var(--border-default)] border-[var(--border-default)]'
              }`}
            >
              <Search size={13} />
            </button>
          </Tooltip>

          {/* Edit mode toggle */}
          <button
            onClick={() => setEditMode(v => !v)}
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              border: editMode ? '1px solid #f59e0b' : '1px solid #374151',
              color: editMode ? '#f59e0b' : '#9ca3af',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {editMode ? '✏️ 编辑中' : '编辑模式'}
          </button>

          {/* Add virtual node (only in edit mode) */}
          {editMode && (
            <button
              onClick={handleAddVirtualNode}
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid #a855f7',
                color: '#a855f7',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              + 节点
            </button>
          )}

          {/* Auto layout */}
          <button
            onClick={handleAutoLayout}
            disabled={rfNodes.length === 0}
            title={t('graphExplorer.autoLayout')}
            className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] bg-[var(--background-panel)] hover:bg-[var(--border-default)] border border-[var(--border-default)] rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <LayoutTemplate size={13} />
          </button>

          {/* Build graph */}
          <button
            onClick={handleBuildGraph}
            disabled={isBuilding || loading}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] bg-[var(--background-panel)] hover:bg-[var(--border-default)] border border-[var(--border-default)] rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isBuilding || loading
              ? <Loader2 size={13} className="animate-spin" />
              : <RefreshCw size={13} />}
            {isBuilding ? t('graphExplorer.building') : t('graphExplorer.buildGraph')}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-[#2d1216] border-b border-[#f43f5e]/30 text-[#f43f5e] text-xs flex-shrink-0">
          {error}
        </div>
      )}

      {/* Build task info banner */}
      {buildInfo && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-[var(--accent)] bg-[#0a1f18] border-b border-[#0d3d2e] flex-shrink-0">
          <Sparkles size={12} className="flex-shrink-0" />
          <span className="flex-1">{buildInfo}</span>
          <button
            className="flex items-center gap-1 text-[var(--accent)] hover:text-[#00b090] underline underline-offset-2 flex-shrink-0"
            onClick={() => { setBuildInfo(null); useTaskStore.getState().setVisible(true); }}
          >
            <ListTodo size={12} />
            {t('graphExplorer.viewTasks')}
          </button>
          <button
            className="text-[var(--foreground-muted)] hover:text-white flex-shrink-0 ml-1"
            onClick={() => setBuildInfo(null)}
            aria-label="关闭"
          >×</button>
        </div>
      )}

      {/* Main canvas area */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative graph-canvas-container" onMouseMove={onEdgeMouseMove}>
          {/* Empty state overlay */}
          {!loading && (internalConnId === null || rfNodes.length === 0) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
              <Network size={36} className="text-[var(--border-strong)] mb-3" />
              <p className="text-[var(--foreground-muted)] text-sm">
                {internalConnId === null
                  ? t('graphExplorer.selectConnection')
                  : rawNodes.length === 0
                    ? t('graphExplorer.noData')
                    : t('graphExplorer.noMatchingNodes')}
              </p>
            </div>
          )}

          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(e, n) => { closeContextMenu(); onNodeClick(e, n); }}
            onNodeContextMenu={onNodeContextMenu}
            onPaneClick={(e) => { closeContextMenu(); onPaneClick(e); }}
            onEdgeContextMenu={onEdgeContextMenu}
            onEdgeMouseEnter={onEdgeMouseEnter}
            onEdgeMouseLeave={onEdgeMouseLeave}
            onConnect={onConnect}
            onBeforeDelete={onBeforeDelete}
            deleteKeyCode={editMode ? 'Delete' : null}
            nodesConnectable={editMode}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            defaultEdgeOptions={{
              type: 'relation',
              animated: false,
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background id="graph-explorer-bg" color="var(--border-default)" gap={20} size={1} />
            <Controls
              className="!bg-[var(--background-panel)] border border-[var(--border-strong)] shadow-lg rounded-md overflow-hidden [&_button]:!bg-[var(--background-panel)] [&_button]:!border-b [&_button]:!border-[var(--border-strong)] [&_button:last-child]:!border-b-0 [&_button]:!fill-[var(--foreground-default)] hover:[&_button]:!bg-[var(--border-default)]"
            />
            <MiniMap
              position="bottom-left"
              nodeColor={(n) => {
                const t = n.type ?? '';
                if (t === 'table') return '#3794ff';
                if (t === 'metric') return '#f59e0b';
                if (t === 'alias') return '#a855f7';
                if (t === 'link') return 'var(--accent)';   // 新增
                return 'var(--border-default)';
              }}
              maskColor="rgba(13, 17, 23, 0.7)"
              className="!bg-[var(--background-panel)] !border !border-[var(--border-default)] !rounded-md"
            />
          </ReactFlow>

          {/* Edge tooltip */}
          {edgeTooltip && (
            <div
              className="fixed z-[9998] pointer-events-none px-2.5 py-1.5 bg-[var(--background-elevated)] border border-[var(--border-strong)] rounded shadow-lg text-[var(--foreground-default)] text-xs"
              style={{ left: edgeTooltip.x + 12, top: edgeTooltip.y - 36 }}
            >
              <span className="text-[var(--foreground-muted)]">{t('graphExplorer.edgeTooltipType')}: </span>{edgeTooltip.edge_type}
              <span className="mx-2 text-[var(--border-default)]">|</span>
              <span className="text-[var(--foreground-muted)]">{t('graphExplorer.edgeTooltipWeight')}: </span>{edgeTooltip.weight.toFixed(2)}
            </div>
          )}

          {/* 右键上下文菜单 */}
          {contextMenu && (
            <div
              className="fixed z-[9999] min-w-[120px] bg-[var(--background-elevated)] border border-[var(--border-strong)] rounded-md shadow-xl py-1"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <button
                onClick={handleContextMenuDelete}
                className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-red-600/20 transition-colors"
              >
                删除{contextMenu.type === 'edge' ? '关系' : '节点'}
              </button>
            </div>
          )}
        </div>

        {/* Node detail panel */}
        {activePanel === 'detail' && selectedNode && (
          <NodeDetail
            node={selectedNode}
            edges={filteredEdges}
            nodeNameMap={nodeNameMap}
            onClose={() => { setSelectedNode(null); setActivePanel(null); }}
            onAliasUpdated={handleAliasUpdated}
            onRefresh={refetch}
          />
        )}

        {/* Search / Path panel */}
        {activePanel === 'search' && (
          <GraphSearchPanel
            connectionId={internalConnId}
            visibleNodeIds={visibleNodeIds}
            pathFrom={pathFrom}
            pathTo={pathTo}
            subgraphMode={subgraphMode}
            onClose={() => setActivePanel(null)}
            onSetPathFrom={setPathFrom}
            onSetPathTo={setPathTo}
            onClearPathFrom={() => setPathFrom(null)}
            onClearPathTo={() => setPathTo(null)}
            onHighlightNode={handleHighlightNode}
            onHighlightPath={handleHighlightPath}
            onEnterSubgraph={handleEnterSubgraph}
            onExitSubgraph={handleExitSubgraph}
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

      {/* 添加虚拟节点弹框 */}
      {showAddNodeModal && (
        <BaseModal
          title="添加虚拟节点"
          onClose={() => setShowAddNodeModal(false)}
          width={400}
          footerButtons={[
            { label: '取消', onClick: () => setShowAddNodeModal(false), variant: 'secondary' },
            { label: '添加', onClick: handleAddNodeSubmit, variant: 'primary', loading: addNodeLoading, disabled: !addNodeName.trim() },
          ]}
        >
          <div className="px-1">
            <label className="block text-xs text-[var(--foreground-muted)] mb-1.5 uppercase tracking-wide">节点名称</label>
            <input
              autoFocus
              type="text"
              value={addNodeName}
              onChange={(e) => setAddNodeName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && addNodeName.trim()) handleAddNodeSubmit(); }}
              placeholder="请输入节点名称"
              className="w-full bg-[var(--background-hover)] border border-[var(--border-strong)] rounded px-3 py-1.5 text-sm text-[var(--foreground-default)] placeholder-[#4a5e75] focus:outline-none focus:border-[#009e84] transition-colors"
            />
          </div>
        </BaseModal>
      )}

      {/* 添加边类型选择弹框 */}
      {pendingConnect && (
        <BaseModal
          title="添加关系"
          onClose={() => setPendingConnect(null)}
          width={400}
          footerButtons={[
            { label: '取消', onClick: () => setPendingConnect(null), variant: 'secondary' },
            { label: '添加', onClick: handleConnectSubmit, variant: 'primary' },
          ]}
        >
          <div className="px-1">
            <label className="block text-xs text-[var(--foreground-muted)] mb-1.5 uppercase tracking-wide">边类型</label>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--foreground-default)]">
                <input
                  type="radio"
                  name="edgeType"
                  checked={connectEdgeType === 'user_defined'}
                  onChange={() => setConnectEdgeType('user_defined')}
                  className="accent-[#009e84]"
                />
                用户自定义 <span className="text-[#4a5e75] text-xs">(user_defined)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--foreground-default)]">
                <input
                  type="radio"
                  name="edgeType"
                  checked={connectEdgeType === 'join_path'}
                  onChange={() => setConnectEdgeType('join_path')}
                  className="accent-[#009e84]"
                />
                连接路径 <span className="text-[#4a5e75] text-xs">(join_path)</span>
              </label>
            </div>
          </div>
        </BaseModal>
      )}
    </div>
  );
}

// ── Public export (wrapped with ReactFlowProvider) ────────────────────────────

interface GraphExplorerProps {
  connectionId: number | null;
  database?: string | null;
  hidden?: boolean;
}

export const GraphExplorer: React.FC<GraphExplorerProps> = ({ connectionId, database, hidden }) => (
  <ReactFlowProvider>
    <GraphExplorerInner connectionId={connectionId} database={database} hidden={hidden} />
  </ReactFlowProvider>
);
