import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { TreeNode, NodeType, CategoryKey, ConnectionGroup } from '../types';

// 各数据库方言支持的 Category 列表
const CATEGORIES_BY_DRIVER: Record<string, CategoryKey[]> = {
  mysql: ['tables', 'views', 'functions', 'procedures', 'triggers', 'events'],
  postgres: ['tables', 'views', 'functions', 'procedures', 'triggers', 'sequences'],
  oracle: ['tables', 'views', 'functions', 'procedures', 'triggers', 'sequences'],
  sqlserver: ['tables', 'views', 'functions', 'procedures', 'triggers'],
};

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  tables: 'Tables',
  views: 'Views',
  functions: 'Functions',
  procedures: 'Procedures',
  triggers: 'Triggers',
  events: 'Events',
  sequences: 'Sequences',
};

let _persistTreeTimer: ReturnType<typeof setTimeout> | null = null;

function persistTreeExpandedIds(ids: Set<string>): void {
  if (_persistTreeTimer) clearTimeout(_persistTreeTimer);
  _persistTreeTimer = setTimeout(() => {
    invoke('set_ui_state', {
      key: 'tree_expanded_ids',
      value: JSON.stringify([...ids]),
    }).catch(() => {});
  }, 800);
}

function makeCategoryNodes(parentId: string, driver: string, meta: TreeNode['meta']): TreeNode[] {
  const cats = CATEGORIES_BY_DRIVER[driver] ?? ['tables', 'views'];
  return cats.map((cat): TreeNode => ({
    id: `${parentId}/cat_${cat}`,
    nodeType: 'category',
    label: CATEGORY_LABELS[cat],
    parentId,
    hasChildren: true,
    loaded: false,
    meta: { ...meta, objectName: cat },
  }));
}

interface TreeStore {
  nodes: Map<string, TreeNode>;
  searchIndex: Map<string, TreeNode>;
  expandedIds: Set<string>;
  selectedId: string | null;
  loadingIds: Set<string>;
  error: string | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  loadChildren: (nodeId: string) => Promise<void>;
  toggleExpand: (nodeId: string) => void;
  selectNode: (nodeId: string) => void;
  refreshNode: (nodeId: string) => Promise<void>;
  search: (query: string) => TreeNode[];
  _addNodes: (nodes: TreeNode[]) => void;
  _removeSubtree: (nodeId: string) => void;
}

export const useTreeStore = create<TreeStore>((set, get) => ({
  nodes: new Map(),
  searchIndex: new Map(),
  expandedIds: new Set(),
  selectedId: null,
  loadingIds: new Set(),
  error: null,

  init: async () => {
    set({ error: null });
    try {
      const [groups, connections] = await Promise.all([
        invoke<{ id: number; name: string; color: string | null; sort_order: number; created_at: string }[]>('list_groups'),
        invoke<{ id: number; name: string; group_id: number | null; driver: string; sort_order: number }[]>('list_connections'),
      ]);

      const newNodes = new Map<string, TreeNode>();

      for (const g of groups) {
        const node: TreeNode = {
          id: `group_${g.id}`,
          nodeType: 'group',
          label: g.name,
          parentId: null,
          hasChildren: true,
          loaded: false,
          meta: { sortOrder: g.sort_order },
        };
        newNodes.set(node.id, node);
      }

      for (const c of connections) {
        const parentId = c.group_id ? `group_${c.group_id}` : null;
        const node: TreeNode = {
          id: `conn_${c.id}`,
          nodeType: 'connection',
          label: c.name,
          parentId,
          hasChildren: true,
          loaded: false,
          meta: { connectionId: c.id, driver: c.driver, sortOrder: c.sort_order },
        };
        newNodes.set(node.id, node);
      }

      // Keep expanded state from memory (will be restored from SQLite on app startup)
      set({ nodes: newNodes, searchIndex: new Map(newNodes) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  refresh: async () => {
    const savedExpandedIds = new Set(get().expandedIds);
    await get().init(); // init 会清空 expandedIds

    // 深度优先恢复展开状态并重新加载子节点
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
    const node = nodes.get(nodeId);
    if (!node || node.loaded || loadingIds.has(nodeId)) return;

    set(s => ({ loadingIds: new Set([...s.loadingIds, nodeId]) }));

    try {
      const children: TreeNode[] = [];

      if (node.nodeType === 'connection') {
        const databases = await invoke<string[]>('list_databases', {
          connectionId: node.meta.connectionId,
        });
        const driver = node.meta.driver ?? 'mysql';
        const needsSchema = ['postgres', 'oracle'].includes(driver);

        for (const db of databases) {
          const dbId = `${nodeId}/db_${db}`;
          const dbNode: TreeNode = {
            id: dbId,
            nodeType: 'database',
            label: db,
            parentId: nodeId,
            hasChildren: true,
            loaded: needsSchema ? false : true,
            meta: { ...node.meta, database: db },
          };
          children.push(dbNode);

          if (!needsSchema) {
            children.push(...makeCategoryNodes(dbId, driver, { ...node.meta, database: db }));
          }
        }
      } else if (node.nodeType === 'database') {
        const driver = node.meta.driver ?? 'postgres';
        if (['postgres', 'oracle'].includes(driver)) {
          const schemas = await invoke<string[]>('list_schemas', {
            connectionId: node.meta.connectionId,
            database: node.meta.database,
          });
          for (const schema of schemas) {
            const schemaId = `${nodeId}/schema_${schema}`;
            const schemaNode: TreeNode = {
              id: schemaId,
              nodeType: 'schema',
              label: schema,
              parentId: nodeId,
              hasChildren: true,
              loaded: false,
              meta: { ...node.meta, schema },
            };
            children.push(schemaNode);
          }
        }
      } else if (node.nodeType === 'schema') {
        const driver = node.meta.driver ?? 'postgres';
        children.push(...makeCategoryNodes(nodeId, driver, { ...node.meta }));
      } else if (node.nodeType === 'category') {
        const category = node.meta.objectName ?? 'tables';
        const objects = await invoke<string[]>('list_objects', {
          connectionId: node.meta.connectionId,
          database: node.meta.database,
          schema: node.meta.schema ?? null,
          category,
        });
        // category 末尾去掉 's' 得到 nodeType（tables->table, views->view 等）
        const leafType = category.slice(0, -1) as NodeType;
        const hasChildren = ['table', 'view'].includes(leafType);
        for (const name of objects) {
          children.push({
            id: `${nodeId}/${leafType}_${name}`,
            nodeType: leafType,
            label: name,
            parentId: nodeId,
            hasChildren,
            loaded: false,
            meta: { ...node.meta, objectName: name },
          });
        }
      } else if (node.nodeType === 'table' || node.nodeType === 'view') {
        const detail = await invoke<{ columns: { name: string; data_type: string; is_primary_key: boolean }[] }>(
          'get_table_detail',
          { connectionId: node.meta.connectionId, database: node.meta.database ?? null, schema: node.meta.schema ?? null, table: node.meta.objectName }
        );
        for (const col of detail.columns) {
          children.push({
            id: `${nodeId}/col_${col.name}`,
            nodeType: 'column',
            label: col.name,
            parentId: nodeId,
            hasChildren: false,
            loaded: true,
            meta: { ...node.meta, objectName: col.name },
          });
        }
      }

      get()._addNodes(children);

      set(s => {
        const newNodes = new Map(s.nodes);
        const updated = newNodes.get(nodeId);
        if (updated) newNodes.set(nodeId, { ...updated, loaded: true });
        return { nodes: newNodes };
      });
    } catch (e) {
      set(s => {
        const newNodes = new Map(s.nodes);
        const node = newNodes.get(nodeId);
        if (node) newNodes.set(nodeId, { ...node, loaded: false });
        const expandedIds = new Set(s.expandedIds);
        expandedIds.delete(nodeId); // 加载失败时折叠，避免"展开但无内容"
        return { nodes: newNodes, error: String(e), expandedIds };
      });
    } finally {
      set(s => {
        const newLoading = new Set(s.loadingIds);
        newLoading.delete(nodeId);
        return { loadingIds: newLoading };
      });
    }
  },

  toggleExpand: (nodeId: string) => {
    const node = get().nodes.get(nodeId);
    if (!node) return;
    const isCurrentlyExpanded = get().expandedIds.has(nodeId);

    set(s => {
      const newExpanded = new Set(s.expandedIds);
      if (isCurrentlyExpanded) {
        newExpanded.delete(nodeId);
        // 递归清除所有子孙节点的展开状态
        const collapseDescendants = (pid: string) => {
          for (const [id, n] of s.nodes) {
            if (n.parentId === pid) {
              newExpanded.delete(id);
              collapseDescendants(id);
            }
          }
        };
        collapseDescendants(nodeId);
      } else {
        newExpanded.add(nodeId);
      }
      return { expandedIds: newExpanded };
    });

    persistTreeExpandedIds(get().expandedIds);

    // loadChildren 必须在 set() 回调外部调用，否则会读到旧 state
    if (!isCurrentlyExpanded && !node.loaded) {
      get().loadChildren(nodeId);
    }
  },

  selectNode: (nodeId: string) => set({ selectedId: nodeId }),

  refreshNode: async (nodeId: string) => {
    const wasExpanded = get().expandedIds.has(nodeId);
    // Collapse first so the UI never shows "expanded with no children"
    set(s => {
      const expandedIds = new Set(s.expandedIds);
      expandedIds.delete(nodeId);
      return { expandedIds };
    });
    get()._removeSubtree(nodeId);
    set(s => {
      const newNodes = new Map(s.nodes);
      const node = newNodes.get(nodeId);
      if (node) newNodes.set(nodeId, { ...node, loaded: false });
      return { nodes: newNodes };
    });
    if (wasExpanded) {
      await get().loadChildren(nodeId);
      // Re-expand only if loading succeeded
      if (get().nodes.get(nodeId)?.loaded === true) {
        set(s => {
          const expandedIds = new Set(s.expandedIds);
          expandedIds.add(nodeId);
          return { expandedIds };
        });
      }
    }
  },

  search: (query: string): TreeNode[] => {
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
    const result: TreeNode[] = [];
    function visit(parentId: string | null) {
      const children = [...nodes.values()]
        .filter(n => n.parentId === parentId && relevantIds.has(n.id))
        .sort((a, b) => {
          const isOrderable = a.nodeType === 'connection' || a.nodeType === 'group';
          if (isOrderable) {
            const diff = (a.meta.sortOrder ?? 0) - (b.meta.sortOrder ?? 0);
            if (diff !== 0) return diff;
          }
          return a.label.localeCompare(b.label);
        });
      for (const node of children) {
        result.push(node);
        if (ancestorIds.has(node.id)) visit(node.id);
      }
    }
    visit(null);
    return result;
  },

  _addNodes: (newNodes: TreeNode[]) => {
    set(s => {
      const nodes = new Map(s.nodes);
      const searchIndex = new Map(s.searchIndex);
      for (const n of newNodes) {
        nodes.set(n.id, n);
        searchIndex.set(n.id, n);
      }
      return { nodes, searchIndex };
    });
  },

  _removeSubtree: (nodeId: string) => {
    set(s => {
      const nodes = new Map(s.nodes);
      const searchIndex = new Map(s.searchIndex);
      const expandedIds = new Set(s.expandedIds);
      const toRemove: string[] = [];
      const queue = [nodeId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        for (const [key, node] of nodes.entries()) {
          if (node.parentId === id) {
            toRemove.push(key);
            queue.push(key);
          }
        }
      }
      for (const id of toRemove) {
        nodes.delete(id);
        searchIndex.delete(id);
        expandedIds.delete(id);
      }
      return { nodes, searchIndex, expandedIds };
    });
  },
}));

export async function loadPersistedTreeExpandedIds(): Promise<Set<string>> {
  try {
    const raw = await invoke<string | null>('get_ui_state', { key: 'tree_expanded_ids' });
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed))
      return new Set(parsed.filter((id): id is string => typeof id === 'string'));
    return new Set();
  } catch {
    return new Set();
  }
}
