// src/store/metricsTreeStore.ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Metric } from '../types';

export type MetricsNodeType = 'connection' | 'database' | 'schema' | 'metric';

export interface MetricsTreeNode {
  id: string;
  nodeType: MetricsNodeType;
  label: string;
  parentId: string | null;
  hasChildren: boolean;
  loaded: boolean;
  meta: {
    connectionId?: number;
    database?: string;
    schema?: string;
    metricId?: number;
    metricType?: string;
  };
}

interface MetricsTreeState {
  nodes: Map<string, MetricsTreeNode>;
  expandedIds: Set<string>;
  selectedId: string | null;
  metricCounts: Map<string, number>;
  loadingIds: Set<string>;

  init: () => Promise<void>;
  loadChildren: (nodeId: string) => Promise<void>;
  toggleExpand: (nodeId: string) => void;
  selectNode: (nodeId: string | null) => void;
  refreshNode: (nodeId: string) => Promise<void>;
  getChildNodes: (parentId: string | null) => MetricsTreeNode[];
}

export const useMetricsTreeStore = create<MetricsTreeState>((set, get) => ({
  nodes: new Map(),
  expandedIds: new Set(),
  selectedId: null,
  metricCounts: new Map(),
  loadingIds: new Set(),

  init: async () => {
    const conns: Array<{ id: number; name: string; driver: string }> =
      await invoke('list_connections');
    const nodes = new Map<string, MetricsTreeNode>();
    for (const c of conns) {
      const id = `conn_${c.id}`;
      nodes.set(id, {
        id,
        nodeType: 'connection',
        label: c.name,
        parentId: null,
        hasChildren: true,
        loaded: false,
        meta: { connectionId: c.id },
      });
    }
    set({ nodes });
  },

  loadChildren: async (nodeId: string) => {
    const { nodes, loadingIds } = get();
    if (loadingIds.has(nodeId)) return;
    const node = nodes.get(nodeId);
    if (!node) return;

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
            meta: {
              connectionId,
              database,
              schema,
              metricId: m.id,
              metricType: m.metric_type,
            },
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
    } else {
      next.add(nodeId);
      if (!node.loaded && node.hasChildren) {
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
    for (const [id, n] of newNodes) {
      if (n.parentId === nodeId) newNodes.delete(id);
    }
    newNodes.set(nodeId, { ...node, loaded: false });
    set({ nodes: newNodes });
    await get().loadChildren(nodeId);
  },

  getChildNodes: (parentId: string | null) => {
    const { nodes } = get();
    return [...nodes.values()].filter(n => n.parentId === parentId);
  },
}));
