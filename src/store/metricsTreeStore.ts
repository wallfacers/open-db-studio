// src/store/metricsTreeStore.ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Metric } from '../types';
import { useQueryStore } from './queryStore';
import { useTreeStore } from './treeStore';
import { connNodeId, groupNodeId, metricsDbNodeId, metricsSchemaNodeId, metricsMetricNodeId } from '../utils/nodeId';

let _persistMetricsTimer: ReturnType<typeof setTimeout> | null = null;

function persistMetricsExpandedIds(ids: Set<string>): void {
  if (_persistMetricsTimer) clearTimeout(_persistMetricsTimer);
  _persistMetricsTimer = setTimeout(() => {
    invoke('set_ui_state', {
      key: 'metrics_tree_expanded_ids',
      value: JSON.stringify([...ids]),
    }).catch(() => {});
  }, 800);
}

export type MetricsNodeType = 'group' | 'connection' | 'database' | 'schema' | 'metric';

export interface MetricsTreeNode {
  id: string;
  nodeType: MetricsNodeType;
  label: string;
  parentId: string | null;
  hasChildren: boolean;
  loaded: boolean;
  meta: {
    groupId?: number;
    connectionId?: number;
    driver?: string;
    database?: string;
    schema?: string;
    metricId?: number;
    metricType?: string;
    sortOrder?: number;
  };
}

interface MetricsTreeState {
  nodes: Map<string, MetricsTreeNode>;
  expandedIds: Set<string>;
  selectedId: string | null;
  metricCounts: Map<string, number>;
  loadingIds: Set<string>;
  isInitializing: boolean;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  loadChildren: (nodeId: string) => Promise<string[]>;
  toggleExpand: (nodeId: string) => void;
  selectNode: (nodeId: string | null) => void;
  refreshNode: (nodeId: string) => Promise<void>;
  deleteMetric: (metricId: number, nodeId: string, knownParentNodeId?: string) => Promise<void>;
  notifyMetricAdded: (parentNodeId: string) => Promise<void>;
  getChildNodes: (parentId: string | null) => MetricsTreeNode[];
  search: (query: string) => MetricsTreeNode[];
}

export const useMetricsTreeStore = create<MetricsTreeState>((set, get) => ({
  nodes: new Map(),
  expandedIds: new Set(),
  selectedId: null,
  metricCounts: new Map(),
  loadingIds: new Set(),
  isInitializing: false,

  init: async () => {
    set({ isInitializing: true });
    const [groups, conns] = await Promise.all([
      invoke<{ id: number; name: string; color: string | null; sort_order: number }[]>('list_groups'),
      invoke<{ id: number; name: string; group_id: number | null; driver: string; sort_order: number }[]>('list_connections'),
    ]);

    const nodes = new Map<string, MetricsTreeNode>();

    // 分组节点（根节点）
    for (const g of groups) {
      const id = groupNodeId(g.id);
      nodes.set(id, {
        id,
        nodeType: 'group',
        label: g.name,
        parentId: null,
        hasChildren: conns.some(c => c.group_id === g.id),
        loaded: false,
        meta: { groupId: g.id, sortOrder: g.sort_order },
      });
    }

    // 连接节点：属于分组的挂分组下，无分组的挂根节点
    for (const c of conns) {
      const id = connNodeId(c.id);
      const parentId = c.group_id ? groupNodeId(c.group_id) : null;
      nodes.set(id, {
        id,
        nodeType: 'connection',
        label: c.name,
        parentId,
        hasChildren: true,
        loaded: false,
        meta: { connectionId: c.id, driver: c.driver, sortOrder: c.sort_order },
      });
    }

    set({ nodes, isInitializing: false });
  },

  refresh: async () => {
    const savedExpandedIds = new Set(get().expandedIds);
    await get().init(); // 重建根节点，子节点消失了
    // 清空旧 expandedIds（含 stale ID），后续 restoreExpansion 只添加仍存在的节点
    set({ expandedIds: new Set() });

    const restoreExpansion = async (nodeId: string) => {
      const node = get().nodes.get(nodeId);
      if (!node) return;
      set(s => {
        const expandedIds = new Set(s.expandedIds);
        expandedIds.add(nodeId);
        return { expandedIds };
      });
      if (!node.loaded) {
        await get().loadChildren(nodeId);
      }
      for (const child of get().nodes.values()) {
        if (child.parentId === nodeId && savedExpandedIds.has(child.id)) {
          await restoreExpansion(child.id);
        }
      }
    };

    for (const node of get().nodes.values()) {
      if (node.parentId === null && savedExpandedIds.has(node.id)) {
        await restoreExpansion(node.id);
      }
    }
  },

  loadChildren: async (nodeId: string): Promise<string[]> => {
    const { nodes, loadingIds } = get();
    if (loadingIds.has(nodeId)) return [];
    const node = nodes.get(nodeId);
    if (!node) return [];

    // group 节点：子节点已在 init 中建好，只需标记 loaded
    if (node.nodeType === 'group') {
      const newNodes = new Map(get().nodes);
      newNodes.set(nodeId, { ...node, loaded: true });
      set({ nodes: newNodes });
      return [];
    }

    set(s => ({ loadingIds: new Set([...s.loadingIds, nodeId]) }));

    try {
      const newNodes = new Map(get().nodes);
      const loadedChildIds: string[] = [];

      if (node.nodeType === 'connection') {
        const { connectionId } = node.meta;
        const dbs: string[] = await invoke('list_databases_for_metrics', { connectionId });
        const counts: Record<string, number> = await invoke('count_metrics_batch', {
          connectionId,
          database: null,
        });
        const newCounts = new Map(get().metricCounts);
        for (const db of dbs) {
          const id = metricsDbNodeId(connectionId!, db);
          loadedChildIds.push(id);
          newNodes.set(id, {
            id,
            nodeType: 'database',
            label: db,
            parentId: nodeId,
            hasChildren: true,
            loaded: false,
            meta: { connectionId, database: db },
          });
          if (counts[db] !== undefined) newCounts.set(id, counts[db]);
        }
        newNodes.set(nodeId, { ...node, loaded: true });
        set({ nodes: newNodes, metricCounts: newCounts });
        return loadedChildIds;

      } else if (node.nodeType === 'database') {
        const { connectionId, database } = node.meta;
        let schemas: string[] = [];
        try {
          schemas = await invoke('list_schemas_for_metrics', { connectionId, database });
        } catch {
          schemas = [];
        }

        if (schemas.length > 0) {
          const counts: Record<string, number> = await invoke('count_metrics_batch', {
            connectionId,
            database,
          });
          const newCounts = new Map(get().metricCounts);
          for (const sc of schemas) {
            const id = metricsSchemaNodeId(connectionId!, database!, sc);
            loadedChildIds.push(id);
            newNodes.set(id, {
              id,
              nodeType: 'schema',
              label: sc,
              parentId: nodeId,
              hasChildren: true,
              loaded: false,
              meta: { connectionId, database, schema: sc },
            });
            if (counts[sc] !== undefined) newCounts.set(id, counts[sc]);
          }
          newNodes.set(nodeId, { ...node, loaded: true });
          set({ nodes: newNodes, metricCounts: newCounts });
          return loadedChildIds;
        } else {
          const metrics: Metric[] = await invoke('list_metrics_by_node', {
            connectionId,
            database,
            schema: null,
            status: null,
          });
          for (const m of metrics) {
            const id = metricsMetricNodeId(m.id);
            loadedChildIds.push(id);
            newNodes.set(id, {
              id,
              nodeType: 'metric',
              label: m.display_name,
              parentId: nodeId,
              hasChildren: false,
              loaded: true,
              meta: { connectionId, database, metricId: m.id, metricType: m.metric_type },
            });
          }
          const newCounts = new Map(get().metricCounts);
          newCounts.set(nodeId, metrics.length);
          newNodes.set(nodeId, { ...node, loaded: true, hasChildren: metrics.length > 0 });
          set({ nodes: newNodes, metricCounts: newCounts });
          return loadedChildIds;
        }

      } else if (node.nodeType === 'schema') {
        const { connectionId, database, schema } = node.meta;
        const metrics: Metric[] = await invoke('list_metrics_by_node', {
          connectionId,
          database,
          schema,
          status: null,
        });
        for (const m of metrics) {
          const id = metricsMetricNodeId(m.id);
          loadedChildIds.push(id);
          newNodes.set(id, {
            id,
            nodeType: 'metric',
            label: m.display_name,
            parentId: nodeId,
            hasChildren: false,
            loaded: true,
            meta: { connectionId, database, schema, metricId: m.id, metricType: m.metric_type },
          });
        }
        const newCounts = new Map(get().metricCounts);
        newCounts.set(nodeId, metrics.length);
        newNodes.set(nodeId, { ...node, loaded: true, hasChildren: metrics.length > 0 });
        set({ nodes: newNodes, metricCounts: newCounts });
        return loadedChildIds;
      }
      return loadedChildIds;
      } catch {
      set(s => {
        const expandedIds = new Set(s.expandedIds);
        expandedIds.delete(nodeId); // 加载失败时折叠，避免"展开但无内容"
        return { expandedIds };
      });
      return [];
      } finally {
      set(s => {
        const newLoading = new Set(s.loadingIds);
        newLoading.delete(nodeId);
        return { loadingIds: newLoading };
      });
      }
  },

  toggleExpand: (nodeId: string) => {
    const { expandedIds, nodes } = get();
    const node = nodes.get(nodeId);
    if (!node) return;
    const next = new Set(expandedIds);
    if (next.has(nodeId)) {
      next.delete(nodeId);
      // 递归清除所有子孙节点的展开状态
      const collapseDescendants = (pid: string) => {
        for (const [id, n] of nodes) {
          if (n.parentId === pid) {
            next.delete(id);
            collapseDescendants(id);
          }
        }
      };
      collapseDescendants(nodeId);
    } else {
      next.add(nodeId);
      if (!node.loaded) {
        get().loadChildren(nodeId);
      }
    }
    set({ expandedIds: next });
    persistMetricsExpandedIds(get().expandedIds);
  },

  selectNode: (nodeId: string | null) => set({ selectedId: nodeId }),

  refreshNode: async (nodeId: string) => {
    const { nodes } = get();
    const node = nodes.get(nodeId);
    if (!node) return;
    
    // 1. 记下当前子孙节点 ID
    const oldChildrenIds = Array.from(nodes.values())
      .filter(n => n.parentId === nodeId)
      .map(n => n.id);

    // 2. 重置 loaded 状态以允许 loadChildren 重新执行
    set(s => {
      const newNodes = new Map(s.nodes);
      newNodes.set(nodeId, { ...node, loaded: false });
      return { nodes: newNodes };
    });

    // 3. 加载新子节点
    const newChildrenIds = await get().loadChildren(nodeId);

    // 4. 清理那些在数据库中已不存在的旧节点
    const toRemove = oldChildrenIds.filter(id => !newChildrenIds.includes(id));
    if (toRemove.length > 0) {
      set(s => {
        const nodesMap = new Map(s.nodes);
        const expandedIds = new Set(s.expandedIds);
        const metricCounts = new Map(s.metricCounts);

        const removeRecursive = (id: string) => {
          nodesMap.delete(id);
          expandedIds.delete(id);
          metricCounts.delete(id);
          for (const [nodeKey, n] of nodesMap.entries()) {
            if (n.parentId === id) removeRecursive(nodeKey);
          }
        };

        for (const id of toRemove) {
          removeRecursive(id);
        }
        return { nodes: nodesMap, expandedIds, metricCounts };
      });
    }
  },

  deleteMetric: async (metricId: number, nodeId: string, knownParentNodeId?: string) => {
    await invoke('delete_metric', { id: metricId });
    set(s => {
      const nodes = new Map(s.nodes);
      const metricCounts = new Map(s.metricCounts);
      const node = nodes.get(nodeId);
      if (node) nodes.delete(nodeId);
      // 从指标节点的父节点（或提供的 knownParentNodeId）开始递减祖先计数
      const startParentId = node?.parentId ?? knownParentNodeId ?? null;
      let current = startParentId ? nodes.get(startParentId) : undefined;
      while (current) {
        const count = metricCounts.get(current.id) ?? 0;
        if (count > 0) metricCounts.set(current.id, count - 1);
        current = current.parentId ? nodes.get(current.parentId) : undefined;
      }
      return { nodes, metricCounts };
    });
    // 同步更新左侧数据库浏览树
    useTreeStore.getState().deleteMetricById(metricId);
    useQueryStore.getState().closeMetricTabById(metricId);
  },

  notifyMetricAdded: async (parentNodeId: string) => {
    // 刷新父节点（重新加载子节点列表并更新其计数）
    await get().refreshNode(parentNodeId);
    // 递增父节点以上所有祖先的计数
    set(s => {
      const metricCounts = new Map(s.metricCounts);
      const parent = s.nodes.get(parentNodeId);
      let current = parent?.parentId ? s.nodes.get(parent.parentId) : undefined;
      while (current) {
        const count = metricCounts.get(current.id) ?? 0;
        metricCounts.set(current.id, count + 1);
        current = current.parentId ? s.nodes.get(current.parentId) : undefined;
      }
      return { metricCounts };
    });
  },

  getChildNodes: (parentId: string | null) => {
    const { nodes } = get();
    return [...nodes.values()]
      .filter(n => n.parentId === parentId)
      .sort((a, b) => (a.meta.sortOrder ?? 0) - (b.meta.sortOrder ?? 0) || a.label.localeCompare(b.label));
  },

  search: (query: string): MetricsTreeNode[] => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const { nodes } = get();

    // 找出所有匹配节点
    const matchingIds = new Set<string>();
    for (const [id, node] of nodes) {
      if (node.label.toLowerCase().includes(q)) matchingIds.add(id);
    }

    // 找出所有匹配节点的祖先
    const ancestorIds = new Set<string>();
    for (const id of matchingIds) {
      let cur = nodes.get(id);
      while (cur?.parentId) {
        ancestorIds.add(cur.parentId);
        cur = nodes.get(cur.parentId);
      }
    }

    const relevantIds = new Set([...ancestorIds, ...matchingIds]);

    // 按树层级顺序（DFS）返回结果
    const result: MetricsTreeNode[] = [];
    function visit(parentId: string | null) {
      const children = [...nodes.values()]
        .filter(n => n.parentId === parentId && relevantIds.has(n.id))
        .sort((a, b) => (a.meta.sortOrder ?? 0) - (b.meta.sortOrder ?? 0) || a.label.localeCompare(b.label));
      for (const node of children) {
        result.push(node);
        if (ancestorIds.has(node.id)) visit(node.id);
      }
    }
    visit(null);
    return result;
  },
}));

export async function loadPersistedMetricsExpandedIds(): Promise<Set<string>> {
  try {
    const raw = await invoke<string | null>('get_ui_state', { key: 'metrics_tree_expanded_ids' });
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed))
      return new Set(parsed.filter((id): id is string => typeof id === 'string'));
    return new Set();
  } catch {
    return new Set();
  }
}

/** app 关闭前立即 flush，防止防抖计时器未触发导致状态丢失 */
export function flushMetricsPersist(): void {
  if (_persistMetricsTimer) {
    clearTimeout(_persistMetricsTimer);
    _persistMetricsTimer = null;
    invoke('set_ui_state', {
      key: 'metrics_tree_expanded_ids',
      value: JSON.stringify([...useMetricsTreeStore.getState().expandedIds]),
    }).catch(() => {});
  }
}
