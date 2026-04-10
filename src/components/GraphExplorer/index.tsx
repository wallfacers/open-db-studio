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
import { useGraphData } from './useGraphData';
import { nodeTypes, edgeTypes } from './nodeTypes';
import { getEdgeStyleBySource } from './graphUtils';
import { NodeDetail } from './NodeDetail';
import { AliasEditor } from './AliasEditor';
import { ConnectionDbSelector } from '../common/ConnectionDbSelector';
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
const GROUP_GAP_X = 600;     // 组间横向间距
const GROUP_GAP_Y = 500;     // 组间纵向间距
const MAX_COLS = 4;          // 每行最多组数
const ESTIMATED_GROUP_W = 1400; // 预估每组宽度（用于新组网格定位）
const ESTIMATED_GROUP_H = 600;  // 预估每组高度

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
  // 快速路径：所有节点都有已保存坐标且不强制重排
  const allSaved = !forceRelayout && nodes.length > 0 && nodes.every(hasSavedPosition);
  if (allSaved) return { nodes, edges };

  // ── 按 connection_id|database 分组 ───────────────────────────────────────
  const groupMap = new Map<string, Node[]>();
  nodes.forEach((n) => {
    const d = n.data as Record<string, unknown>;
    const key = `${d?.connection_id ?? 0}|${d?.database ?? ''}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(n);
  });

  // 有已保存节点的组优先，其次按节点数降序
  const sortedGroups = [...groupMap.entries()].sort((a, b) => {
    const aHasPos = a[1].some((n) => !forceRelayout && hasSavedPosition(n));
    const bHasPos = b[1].some((n) => !forceRelayout && hasSavedPosition(n));
    if (aHasPos && !bHasPos) return -1;
    if (!aHasPos && bHasPos) return 1;
    return b[1].length - a[1].length;
  });

  // 计算所有已有坐标节点的全局最大 X，作为新组的起始基准
  let existingMaxX = 0;
  sortedGroups.forEach(([, groupNodes]) => {
    groupNodes.forEach((n) => {
      if (!forceRelayout && hasSavedPosition(n)) {
        const d = n.data as Record<string, unknown>;
        const nx = (d.position_x as number) + NODE_W;
        if (nx > existingMaxX) existingMaxX = nx;
      }
    });
  });

  const resultNodes = new Map<string, Node>(nodes.map((n) => [n.id, n]));
  let newGroupCol = 0;
  let newGroupRow = 0;

  sortedGroups.forEach(([, groupNodes]) => {
    // 本组中需要重新分配坐标的节点
    const needsLayout = groupNodes.filter((n) => forceRelayout || !hasSavedPosition(n));
    if (needsLayout.length === 0) return;

    // ── 本组 Dagre（对 needsLayout 中所有节点建图，只包含两端均在 needsLayout 中的边）────────────────
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: direction, ranksep: 200, nodesep: 80 });

    needsLayout.forEach((n) => {
      const isLink = n.type === 'link';
      g.setNode(n.id, { width: isLink ? LINK_NODE_W : NODE_W, height: isLink ? LINK_NODE_H : NODE_H });
    });

    const needsLayoutIds = new Set(needsLayout.map((n) => n.id));
    edges.forEach((e) => {
      if (needsLayoutIds.has(e.source) && needsLayoutIds.has(e.target)) {
        g.setEdge(e.source, e.target);
      }
    });

    dagre.layout(g);

    // ── 计算本组新节点的基准偏移 ──────────────────────────────────────────
    const positioned = groupNodes.filter((n) => !forceRelayout && hasSavedPosition(n));
    let baseX: number;
    let baseY: number;

    if (positioned.length > 0) {
      // 有已保存节点：在其右侧插入
      const maxX = positioned.reduce((m, n) => {
        const d = n.data as Record<string, unknown>;
        return Math.max(m, (d.position_x as number) + NODE_W);
      }, -Infinity);
      const minY = positioned.reduce((m, n) => {
        const d = n.data as Record<string, unknown>;
        return Math.min(m, d.position_y as number);
      }, Infinity);
      baseX = (isFinite(maxX) ? maxX : 0) + GROUP_GAP_X;
      baseY = isFinite(minY) ? minY : 0;
    } else {
      // 全新组：按网格排列
      baseX = existingMaxX + newGroupCol * (ESTIMATED_GROUP_W + GROUP_GAP_X);
      baseY = newGroupRow * (ESTIMATED_GROUP_H + GROUP_GAP_Y);
      newGroupCol++;
      if (newGroupCol >= MAX_COLS) {
        newGroupCol = 0;
        newGroupRow++;
      }
    }

    // ── 应用 Dagre 坐标 ───────────────────────────────────────────────────
    needsLayout.forEach((n) => {
      const pos = g.node(n.id);
      const isLink = n.type === 'link';
      const w = isLink ? LINK_NODE_W : NODE_W;
      const h = isLink ? LINK_NODE_H : NODE_H;
      resultNodes.set(n.id, {
        ...n,
        position: {
          x: baseX + (pos ? pos.x - w / 2 : 0),
          y: baseY + (pos ? pos.y - h / 2 : 0),
        },
      });
    });
  });

  return { nodes: nodes.map((n) => resultNodes.get(n.id) ?? n), edges };
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
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--edge-default)' },
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
  const [internalConnId, setInternalConnId] = useState<number>(() => connectionId ?? 0);
  const [internalDb, setInternalDb] = useState<string>(() => database ?? '');

  const { nodes: rawNodes, edges: rawEdges, loading, error, refetch } = useGraphData(internalConnId > 0 ? internalConnId : null, internalDb || null);

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

  // ── Auto-clear UI selections when database or connection changes ────────────
  useEffect(() => {
    setSelectedNode(null);
    setActivePanel((prev) => prev === 'detail' ? null : prev);
    setPathFrom(null);
    setPathTo(null);
    setSubgraphMode(false);
    setSubgraphNodeIds(new Set());
    setHighlightedNodeIds(new Set());
    setHighlightedEdgeIds(new Set());
    setFocusedNodeId(null);
  }, [internalConnId, internalDb]);

  // ── Auto-close detail panel if selected node is no longer in canvas ───────
  useEffect(() => {
    if (activePanel === 'detail' && selectedNode) {
      // Check if selectedNode is still in the rendered nodes
      // (e.g. filtered out by search or type filter)
      const existsInCanvas = rfNodes.some(n => n.id === selectedNode.id);
      if (!existsInCanvas) {
        setSelectedNode(null);
        setActivePanel(null);
      }
    }
  }, [rfNodes, selectedNode, activePanel]);

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
    if (!name || internalConnId === 0) return;
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

  const { fitView } = useReactFlow();
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
    const result = rawNodes.filter((n) => {
      if (!typeFilter.includes(n.node_type)) return false;
      if (!kw) return true;
      return (
        n.name?.toLowerCase().includes(kw) ||
        n.display_name?.toLowerCase().includes(kw) ||
        (n.aliases ?? '').toLowerCase().includes(kw)
      );
    });
    return result;
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
        // 列节点 ID 格式: "{conn_id}:column:[{db}:]{table_name}:{col_name}"
        // 目标表节点 ID: "{conn_id}:table:[{db}:]{table_name}"
        // 贪婪匹配 (.+) 自动兼容有无 database 前缀两种格式
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
      if (dragged) return { ...n, position: dragged, data: { ...n.data as Record<string, unknown>, position_x: dragged.x, position_y: dragged.y } };
      return n;
    });
    const { nodes: laid, edges: laidEdges } = buildLayout(mergedNodes, flowEdges);
    setRfNodes(laid);
    setRfEdges(laidEdges);
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
    if (internalConnId > 0) {
      await invoke('clear_graph_node_positions', {
        connectionId: internalConnId,
        database: internalDb || null,
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
    if (!internalConnId) return;
    setIsBuilding(true);
    try {
      const result = await invoke<{ task_id?: string } | string>('build_schema_graph', { connectionId: internalConnId, database: internalDb || null });

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
  }, [internalConnId, internalDb, refetch, _addTaskStub, loadTasks]);

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

  const selectNodeById = useCallback((nodeId: string) => {
    const raw = rawNodes.find((n) => n.id === nodeId);
    const rfNode = rfNodes.find((n) => n.id === nodeId);
    if (!raw) return;

    // Calculate 1-hop neighbors from filteredEdges
    const neighborNodeIds = new Set<string>();
    const neighborEdgeIds = new Set<string>();
    const potentialLinkNodes = new Set<string>();

    filteredEdges.forEach(edge => {
      if (edge.from_node === nodeId) {
        neighborNodeIds.add(edge.to_node);
        neighborEdgeIds.add(edge.id);
        if (raw.node_type !== 'link') potentialLinkNodes.add(edge.to_node);
      } else if (edge.to_node === nodeId) {
        neighborNodeIds.add(edge.from_node);
        neighborEdgeIds.add(edge.id);
        if (raw.node_type !== 'link') potentialLinkNodes.add(edge.from_node);
      }
    });

    // 2nd pass: if clicked node is not a link, expand its 1-hop neighbors that ARE links
    if (raw.node_type !== 'link' && potentialLinkNodes.size > 0) {
      const actualLinkNodes = new Set(
        rawNodes.filter(n => n.node_type === 'link' && potentialLinkNodes.has(n.id)).map(n => n.id)
      );
      
      if (actualLinkNodes.size > 0) {
        filteredEdges.forEach(edge => {
          if (actualLinkNodes.has(edge.from_node)) {
            neighborNodeIds.add(edge.to_node);
            neighborEdgeIds.add(edge.id);
          } else if (actualLinkNodes.has(edge.to_node)) {
            neighborNodeIds.add(edge.from_node);
            neighborEdgeIds.add(edge.id);
          }
        });
      }
    }

    // Include the clicked node itself
    neighborNodeIds.add(nodeId);

    // Set focus state
    setFocusedNodeId(nodeId);
    setHighlightedNodeIds(neighborNodeIds);
    setHighlightedEdgeIds(neighborEdgeIds);

    // Open detail panel
    setSelectedNode(raw);
    setActivePanel('detail');
  }, [rawNodes, rfNodes, filteredEdges]);

  const handleHighlightNode = useCallback((nodeId: string) => {
    selectNodeById(nodeId);
  }, [selectNodeById]);

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
      selectNodeById(node.id);
    },
    [selectNodeById],
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
    { type: 'table', label: t('graphExplorer.typeTable'), activeClass: 'bg-node-table-bg text-node-table border-node-table/50' },
    { type: 'metric', label: t('graphExplorer.typeMetric'), activeClass: 'bg-node-metric-bg text-node-metric border-node-metric/50' },
    { type: 'alias', label: t('graphExplorer.typeAlias'), activeClass: 'bg-node-alias-bg text-node-alias border-node-alias/50' },
    { type: 'link', label: t('graphExplorer.typeLink'), activeClass: 'bg-accent-subtle text-accent border-accent/50' },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background-base overflow-hidden" style={{ display: hidden ? 'none' : undefined }}>
      {/* Toolbar */}
      <div className="h-10 flex items-center gap-2 px-4 border-b border-border-default flex-shrink-0 bg-background-base">
        <Network size={16} className="text-accent flex-shrink-0" />
        <span className="text-foreground-default text-sm font-semibold mr-2">{t('graphExplorer.title')}</span>

        {/* Connection + Database selector */}
        <ConnectionDbSelector
          connectionId={internalConnId}
          database={internalDb}
          onConnectionChange={v => { setInternalConnId(v); setInternalDb(''); }}
          onDatabaseChange={setInternalDb}
          connectionPlaceholder={t('graphExplorer.selectConnection')}
          databasePlaceholder={t('graphExplorer.allDatabases', '全部数据库')}
          direction="horizontal"
        />

        {/* Type filter */}
        <div className="flex items-center gap-1">
          {typeButtons.map(({ type, label, activeClass }) => (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                typeFilter.includes(type)
                  ? activeClass
                  : 'text-foreground-muted border-border-default hover:border-border-strong hover:text-foreground-default'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs ml-2">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-muted pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('graphExplorer.searchPlaceholder')}
            className="w-full pl-7 pr-3 py-1 text-xs bg-background-panel border border-border-default rounded text-foreground-default placeholder-foreground-ghost focus:outline-none focus:border-accent/50 transition-colors"
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
                  ? 'text-accent bg-accent-subtle border-accent-hover/35'
                  : 'text-foreground-muted hover:text-foreground-default bg-background-panel hover:bg-border-default border-border-default'
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
              border: editMode ? '1px solid var(--warning)' : '1px solid var(--border-strong)',
              color: editMode ? 'var(--warning)' : 'var(--foreground-muted)',
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
                border: '1px solid var(--node-alias)',
                color: 'var(--node-alias)',
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
            className="flex items-center gap-1 px-2 py-1 text-xs text-foreground-muted hover:text-foreground-default bg-background-panel hover:bg-border-default border border-border-default rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <LayoutTemplate size={13} />
          </button>

          {/* Build graph */}
          <button
            onClick={handleBuildGraph}
            disabled={isBuilding || loading}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-foreground-muted hover:text-foreground-default bg-background-panel hover:bg-border-default border border-border-default rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
        <div className="px-4 py-2 bg-error-subtle border-b border-error/30 text-error text-xs flex-shrink-0">
          {error}
        </div>
      )}

      {/* Build task info banner */}
      {buildInfo && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-accent bg-accent-subtle border-b border-accent/30 flex-shrink-0">
          <Sparkles size={12} className="flex-shrink-0" />
          <span className="flex-1">{buildInfo}</span>
          <button
            className="flex items-center gap-1 text-accent hover:text-accent-hover underline underline-offset-2 flex-shrink-0 transition-colors duration-200"
            onClick={() => { setBuildInfo(null); useTaskStore.getState().setVisible(true); }}
          >
            <ListTodo size={12} />
            {t('graphExplorer.viewTasks')}
          </button>
          <button
            className="text-foreground-muted hover:text-foreground flex-shrink-0 ml-1 transition-colors duration-200"
            onClick={() => setBuildInfo(null)}
            aria-label="关闭"
          >×</button>
        </div>
      )}

      {/* Main canvas area */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative graph-canvas-container" onMouseMove={onEdgeMouseMove}>
          {/* Empty state overlay */}
          {!loading && (!internalConnId || rfNodes.length === 0) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
              <Network size={36} className="text-border-strong mb-3" />
              <p className="text-foreground-muted text-sm">
                {!internalConnId
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
            panActivationKeyCode={hidden ? null : 'Space'}
            selectionKeyCode={hidden ? null : 'Shift'}
            multiSelectionKeyCode={hidden ? null : 'Meta'}
            zoomActivationKeyCode={hidden ? null : 'Meta'}
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
              className="!bg-background-panel border border-border-strong shadow-lg rounded-md overflow-hidden [&_button]:!bg-background-panel [&_button]:!border-b [&_button]:!border-border-strong [&_button:last-child]:!border-b-0 [&_button]:!fill-foreground-default hover:[&_button]:!bg-border-default"
            />
            <MiniMap
              position="bottom-left"
              nodeColor={(n) => {
                const t = n.type ?? '';
                if (t === 'table') return 'var(--node-table)';
                if (t === 'metric') return 'var(--node-metric)';
                if (t === 'alias') return 'var(--node-alias)';
                if (t === 'link') return 'var(--accent)';
                return 'var(--border-default)';
              }}
              maskColor="rgba(13, 17, 23, 0.7)"
              className="!bg-background-panel !border !border-border-default !rounded-md"
            />
          </ReactFlow>

          {/* Edge tooltip */}
          {edgeTooltip && (
            <div
              className="fixed z-[9998] pointer-events-none px-2.5 py-1.5 bg-background-elevated border border-border-strong rounded shadow-lg text-foreground-default text-xs"
              style={{ left: edgeTooltip.x + 12, top: edgeTooltip.y - 36 }}
            >
              <span className="text-foreground-muted">{t('graphExplorer.edgeTooltipType')}: </span>{edgeTooltip.edge_type}
              <span className="mx-2 text-border-default">|</span>
              <span className="text-foreground-muted">{t('graphExplorer.edgeTooltipWeight')}: </span>{edgeTooltip.weight.toFixed(2)}
            </div>
          )}

          {/* 右键上下文菜单 */}
          {contextMenu && (
            <div
              className="fixed z-[9999] min-w-[120px] bg-background-elevated border border-border-strong rounded-md shadow-xl py-1"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <button
                onClick={handleContextMenuDelete}
                className="w-full text-left px-3 py-1.5 text-xs text-error hover:bg-error-subtle transition-colors"
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
            onNodeClick={handleHighlightNode}
            onRefresh={refetch}
          />
        )}

        {/* Search / Path panel */}
        {activePanel === 'search' && (
          <GraphSearchPanel
            connectionId={internalConnId > 0 ? internalConnId : null}
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
            <label className="block text-xs text-foreground-muted mb-1.5 uppercase tracking-wide">节点名称</label>
            <input
              autoFocus
              type="text"
              value={addNodeName}
              onChange={(e) => setAddNodeName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && addNodeName.trim()) handleAddNodeSubmit(); }}
              placeholder="请输入节点名称"
              className="w-full bg-background-hover border border-border-strong rounded px-3 py-1.5 text-sm text-foreground-default placeholder-foreground-subtle focus:outline-none focus:border-accent transition-colors"
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
            <label className="block text-xs text-foreground-muted mb-1.5 uppercase tracking-wide">边类型</label>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground-default">
                <input
                  type="radio"
                  name="edgeType"
                  checked={connectEdgeType === 'user_defined'}
                  onChange={() => setConnectEdgeType('user_defined')}
                  className="accent-accent"
                />
                用户自定义 <span className="text-foreground-subtle text-xs">(user_defined)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground-default">
                <input
                  type="radio"
                  name="edgeType"
                  checked={connectEdgeType === 'join_path'}
                  onChange={() => setConnectEdgeType('join_path')}
                  className="accent-accent"
                />
                连接路径 <span className="text-foreground-subtle text-xs">(join_path)</span>
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
