// src/store/metricsTreeStore.ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Metric } from '../types';

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

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  loadChildren: (nodeId: string) => Promise<void>;
  toggleExpand: (nodeId: string) => void;
  selectNode: (nodeId: string | null) => void;
  refreshNode: (nodeId: string) => Promise<void>;
  getChildNodes: (parentId: string | null) => MetricsTreeNode[];
  search: (query: string) => MetricsTreeNode[];
}

export const useMetricsTreeStore = create<MetricsTreeState>((set, get) => ({
  nodes: new Map(),
  expandedIds: new Set(),
  selectedId: null,
  metricCounts: new Map(),
  loadingIds: new Set(),

  init: async () => {
    const [groups, conns] = await Promise.all([
      invoke<{ id: number; name: string; color: string | null; sort_order: number }[]>('list_groups'),
      invoke<{ id: number; name: string; group_id: number | null; driver: string; sort_order: number }[]>('list_connections'),
    ]);

    const nodes = new Map<string, MetricsTreeNode>();

    // 分组节点（根节点）
    for (const g of groups) {
      const id = `group_${g.id}`;
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
      const id = `conn_${c.id}`;
      const parentId = c.group_id ? `group_${c.group_id}` : null;
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

    set({ nodes });
  },

  refresh: async () => {
    const savedExpandedIds = new Set(get().expandedIds);
    await get().init(); // 重建根节点，不清 expandedIds（但子节点消失了）
    // 清空 stale expandedIds，重新从有效节点出发恢复
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

  loadChildren: async (nodeId: string) => {
    const { nodes, loadingIds } = get();
    if (loadingIds.has(nodeId)) return;
    const node = nodes.get(nodeId);
    if (!node) return;

    // group 节点：子节点已在 init 中建好，只需标记 loaded
    if (node.nodeType === 'group') {
      const newNodes = new Map(get().nodes);
      newNodes.set(nodeId, { ...node, loaded: true });
      set({ nodes: newNodes });
      return;
    }

    set(s => ({ loadingIds: new Set([...s.loadingIds, nodeId]) }));

    try {
      const newNodes = new Map(get().nodes);

      if (node.nodeType === 'connection') {
        const { connectionId } = node.meta;
        const dbs: string[] = await invoke('list_databases_for_metrics', { connectionId });
        const counts: Record<string, number> = await invoke('count_metrics_batch', {
          connectionId,
          database: null,
        });
        const newCounts = new Map(get().metricCounts);
        for (const db of dbs) {
          const id = `db_${connectionId}_${db}`;
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
            const id = `schema_${connectionId}_${database}_${sc}`;
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
        } else {
          const metrics: Metric[] = await invoke('list_metrics_by_node', {
            connectionId,
            database,
            schema: null,
            status: null,
          });
          for (const m of metrics) {
            const id = `metric_${m.id}`;
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
          newNodes.set(nodeId, { ...node, loaded: true, hasChildren: metrics.length > 0 });
          set({ nodes: newNodes });
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
          const id = `metric_${m.id}`;
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
        newNodes.set(nodeId, { ...node, loaded: true, hasChildren: metrics.length > 0 });
        set({ nodes: newNodes });
      }
    } finally {
      set(s => {
        const ids = new Set(s.loadingIds);
        ids.delete(nodeId);
        return { loadingIds: ids };
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
  },

  selectNode: (nodeId: string | null) => set({ selectedId: nodeId }),

  refreshNode: async (nodeId: string) => {
    const { nodes } = get();
    const node = nodes.get(nodeId);
    if (!node) return;
    const newNodes = new Map(nodes);
    // 递归删除所有子孙节点
    const removeChildren = (pid: string) => {
      for (const [id, n] of newNodes) {
        if (n.parentId === pid) {
          removeChildren(id);
          newNodes.delete(id);
        }
      }
    };
    removeChildren(nodeId);
    newNodes.set(nodeId, { ...node, loaded: false });
    set({ nodes: newNodes });
    await get().loadChildren(nodeId);
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
