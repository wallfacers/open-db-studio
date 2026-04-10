import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { TreeNode, NodeType, CategoryKey, ConnectionGroup, Metric } from '../types';
import { connNodeId, groupNodeId, dbNodeId, schemaNodeId, catNodeId, objectNodeId, colNodeId, metricsFolderNodeId, treeMetricNodeId } from '../utils/nodeId';

// 各数据库方言支持的 Category 列表
const CATEGORIES_BY_DRIVER: Record<string, CategoryKey[]> = {
  mysql:      ['tables', 'views', 'functions', 'procedures', 'triggers', 'events'],
  postgres:   ['tables', 'views', 'functions', 'procedures', 'triggers', 'sequences'],
  oracle:     ['tables', 'views', 'functions', 'procedures', 'triggers', 'sequences'],
  sqlserver:  ['tables', 'views', 'functions', 'procedures', 'triggers'],
  sqlite:     ['tables', 'views', 'triggers'],
  doris:      ['tables', 'views', 'materialized_views'],
  clickhouse: ['tables', 'views', 'dictionaries'],
  tidb:       ['tables', 'views'],
  gaussdb:    ['tables', 'views', 'functions', 'procedures', 'triggers', 'sequences', 'materialized_views'],
  db2:        ['tables', 'views', 'functions', 'procedures', 'triggers', 'materialized_views'],
};

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  tables:             'Tables',
  views:              'Views',
  functions:          'Functions',
  procedures:         'Procedures',
  triggers:           'Triggers',
  events:             'Events',
  sequences:          'Sequences',
  materialized_views: 'Materialized Views',
  dictionaries:       'Dictionaries',
};

// category key → 叶节点 NodeType 的映射（无法用 slice(0,-1) 统一推导）
const CATEGORY_TO_NODE_TYPE: Record<CategoryKey, NodeType> = {
  tables:             'table',
  views:              'view',
  functions:          'function',
  procedures:         'procedure',
  triggers:           'trigger',
  events:             'event',
  sequences:          'sequence',
  materialized_views: 'materialized_view',
  dictionaries:       'dictionary',
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
    id: catNodeId(parentId, cat),
    nodeType: 'category',
    label: CATEGORY_LABELS[cat],
    parentId,
    hasChildren: true,
    loaded: false,
    meta: { ...meta, objectName: cat },
  }));
}

function makeMetricsFolderNode(parentId: string, meta: TreeNode['meta']): TreeNode {
  return {
    id: metricsFolderNodeId(parentId),
    nodeType: 'metrics_folder',
    label: 'dbTree.metrics',   // i18n key，DBTree 渲染时调用 t()
    parentId,
    hasChildren: true,         // 初始设为 true 以显示展开箭头；加载后修正
    loaded: false,
    meta: { ...meta },
  };
}

interface TreeStore {
  nodes: Map<string, TreeNode>;
  searchIndex: Map<string, TreeNode>;
  expandedIds: Set<string>;
  selectedId: string | null;
  loadingIds: Set<string>;
  error: string | null;
  metricCounts: Map<string, number>;  // 新增：key = metrics_folder 节点 ID

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  loadChildren: (nodeId: string) => Promise<void>;
  toggleExpand: (nodeId: string) => void;
  selectNode: (nodeId: string) => void;
  refreshNode: (nodeId: string) => Promise<void>;
  search: (query: string) => TreeNode[];
  deleteMetricNode: (nodeId: string) => void;
  deleteMetricById: (metricId: number) => void;
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
  metricCounts: new Map(),

  init: async () => {
    set({ error: null });
    try {
      const [groups, connections] = await Promise.all([
        invoke<{ id: number; name: string; color: string | null; sort_order: number; created_at: string }[]>('list_groups'),
        invoke<{ id: number; name: string; group_id: number | null; driver: string; sort_order: number; database_name: string | null }[]>('list_connections'),
      ]);

      const newNodes = new Map<string, TreeNode>();

      for (const g of groups) {
        const node: TreeNode = {
          id: groupNodeId(g.id),
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
        const parentId = c.group_id ? groupNodeId(c.group_id) : null;
        const node: TreeNode = {
          id: connNodeId(c.id),
          nodeType: 'connection',
          label: c.name,
          parentId,
          hasChildren: true,
          loaded: false,
          meta: { connectionId: c.id, driver: c.driver, sortOrder: c.sort_order, ...(c.database_name ? { database: c.database_name } : {}) },
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
    await get().init(); // init 只更新节点，不重置 expandedIds（由持久化机制维护）

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
        const needsSchema = ['postgres', 'oracle', 'gaussdb'].includes(driver);

        if (databases.length === 0) {
          // 无多数据库概念（如 SQLite）：category 直接挂在 connection 节点下
          children.push(makeMetricsFolderNode(nodeId, node.meta));
          children.push(...makeCategoryNodes(nodeId, driver, { ...node.meta }));
        } else {
          for (const db of databases) {
            const dbId = dbNodeId(nodeId, db);
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
              children.push(makeMetricsFolderNode(dbId, { ...node.meta, database: db }));
              children.push(...makeCategoryNodes(dbId, driver, { ...node.meta, database: db }));
            }
          }
        }
      } else if (node.nodeType === 'database') {
        const driver = node.meta.driver ?? 'postgres';
        if (['postgres', 'oracle', 'gaussdb'].includes(driver)) {
          const schemas = await invoke<string[]>('list_schemas', {
            connectionId: node.meta.connectionId,
            database: node.meta.database,
          });
          for (const schema of schemas) {
            const schemaId = schemaNodeId(nodeId, schema);
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
          // metrics_folder 放在所有 schema 节点之前
          children.unshift(makeMetricsFolderNode(nodeId, node.meta));
        } else {
          children.push(makeMetricsFolderNode(nodeId, node.meta));
          children.push(...makeCategoryNodes(nodeId, driver, { ...node.meta }));
        }
      } else if (node.nodeType === 'schema') {
        const driver = node.meta.driver ?? 'postgres';
        children.push(...makeCategoryNodes(nodeId, driver, { ...node.meta }));
      } else if (node.nodeType === 'category') {
        const category = node.meta.objectName ?? 'tables';
        const objects = await invoke<string[]>('list_objects', {
          connectionId: node.meta.connectionId,
          database: node.meta.database ?? null,
          schema: node.meta.schema ?? null,
          category,
        });
        const leafType = CATEGORY_TO_NODE_TYPE[category as CategoryKey] ?? (category.slice(0, -1) as NodeType);
        const hasChildren = ['table', 'view', 'materialized_view'].includes(leafType);
        for (const name of objects) {
          children.push({
            id: objectNodeId(nodeId, leafType, name),
            nodeType: leafType,
            label: name,
            parentId: nodeId,
            hasChildren,
            loaded: false,
            meta: { ...node.meta, objectName: name },
          });
        }
      } else if (node.nodeType === 'metrics_folder') {
        const { connectionId, database } = node.meta;
        const metrics = await invoke<Metric[]>('list_metrics_by_node', {
          connectionId,
          database: database ?? null,
          schema: null,
          status: null,
        });
        for (const m of metrics) {
          children.push({
            id: treeMetricNodeId(nodeId, m.id),
            nodeType: 'metric',
            label: m.display_name,
            parentId: nodeId,
            hasChildren: false,
            loaded: true,
            meta: { ...node.meta, objectName: String(m.id) },
          });
        }
      } else if (node.nodeType === 'table' || node.nodeType === 'view') {
        const detail = await invoke<{ columns: { name: string; data_type: string; is_primary_key: boolean }[] }>(
          'get_table_detail',
          { connectionId: node.meta.connectionId, database: node.meta.database ?? null, schema: node.meta.schema ?? null, table: node.meta.objectName }
        );
        for (const col of detail.columns) {
          children.push({
            id: colNodeId(nodeId, col.name),
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

      // 在创建 metrics_folder 节点后立即获取指标计数（未展开时也显示徽章）
      const metricsFolderNodes = children.filter(c => c.nodeType === 'metrics_folder');
      if (metricsFolderNodes.length > 0) {
        if (node.nodeType === 'connection') {
          // connection 分支：使用 count_metrics_batch 批量获取
          const driver = node.meta.driver ?? 'mysql';
          const needsSchema = ['postgres', 'oracle', 'gaussdb'].includes(driver);
          if (!needsSchema && metricsFolderNodes.length > 1) {
            // 多数据库（MySQL 等）：一次批量获取
            const counts: Record<string, number> = await invoke('count_metrics_batch', {
              connectionId: node.meta.connectionId,
              database: null,
            });
            set(s => {
              const newCounts = new Map(s.metricCounts);
              const newNodes = new Map(s.nodes);
              for (const folder of metricsFolderNodes) {
                const db = folder.meta.database;
                const cnt = db ? (counts[db] ?? 0) : 0;
                newCounts.set(folder.id, cnt);
                const f = newNodes.get(folder.id);
                if (f) newNodes.set(folder.id, { ...f, hasChildren: cnt > 0 });
              }
              return { metricCounts: newCounts, nodes: newNodes };
            });
          } else {
            // 单数据库（SQLite）或 schema 型驱动在 connection 层无 metrics_folder
            for (const folder of metricsFolderNodes) {
              try {
                const cnt = await invoke<number>('count_metrics_by_node', {
                  connectionId: folder.meta.connectionId,
                  database: folder.meta.database ?? null,
                  schema: null,
                });
                set(s => {
                  const newCounts = new Map(s.metricCounts);
                  const newNodes = new Map(s.nodes);
                  newCounts.set(folder.id, cnt);
                  const f = newNodes.get(folder.id);
                  if (f) newNodes.set(folder.id, { ...f, hasChildren: cnt > 0 });
                  return { metricCounts: newCounts, nodes: newNodes };
                });
              } catch { /* ignore */ }
            }
          }
        } else {
          // database 分支（PG/Oracle）：逐个获取计数
          for (const folder of metricsFolderNodes) {
            try {
              const cnt = await invoke<number>('count_metrics_by_node', {
                connectionId: folder.meta.connectionId,
                database: folder.meta.database ?? null,
                schema: null,
              });
              set(s => {
                const newCounts = new Map(s.metricCounts);
                const newNodes = new Map(s.nodes);
                newCounts.set(folder.id, cnt);
                const f = newNodes.get(folder.id);
                if (f) newNodes.set(folder.id, { ...f, hasChildren: cnt > 0 });
                return { metricCounts: newCounts, nodes: newNodes };
              });
            } catch { /* ignore */ }
          }
        }
      }

      // metrics_folder 节点加载后更新 metricCounts 和 hasChildren
      if (node.nodeType === 'metrics_folder') {
        const metrics = children.filter(c => c.nodeType === 'metric');
        set(s => ({
          metricCounts: new Map(s.metricCounts).set(nodeId, metrics.length),
          nodes: (() => {
            const n = new Map(s.nodes);
            const folder = n.get(nodeId);
            if (folder) n.set(nodeId, { ...folder, hasChildren: metrics.length > 0 });
            return n;
          })(),
        }));
      }

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
    const { nodes } = get();
    // 1. 记下当前子节点 ID，用于加载后清理已删除的节点
    const oldChildrenIds = Array.from(nodes.values())
      .filter(n => n.parentId === nodeId)
      .map(n => n.id);

    // 2. 重置 loaded 状态以允许 loadChildren 重新执行
    set(s => {
      const newNodes = new Map(s.nodes);
      const node = newNodes.get(nodeId);
      if (node) newNodes.set(nodeId, { ...node, loaded: false });
      return { nodes: newNodes };
    });

    // 3. 加载新子节点（loadChildren 内部会调用 _addNodes 更新/添加节点）
    await get().loadChildren(nodeId);

    // 4. 清理那些在数据库中已不存在的旧节点（即：原来有，但新加载列表里没有的）
    const currentNodes = get().nodes;
    const currentChildrenIds = new Set(
      Array.from(currentNodes.values())
        .filter(n => n.parentId === nodeId)
        .map(n => n.id)
    );

    const toRemove = oldChildrenIds.filter(id => !currentChildrenIds.has(id));
    if (toRemove.length > 0) {
      set(s => {
        const nodesMap = new Map(s.nodes);
        const searchIndex = new Map(s.searchIndex);
        const expandedIds = new Set(s.expandedIds);
        const metricCounts = new Map(s.metricCounts);

        const removeRecursive = (id: string) => {
          nodesMap.delete(id);
          searchIndex.delete(id);
          expandedIds.delete(id);
          metricCounts.delete(id);
          for (const [nodeKey, node] of nodesMap.entries()) {
            if (node.parentId === id) removeRecursive(nodeKey);
          }
        };

        for (const id of toRemove) {
          removeRecursive(id);
        }
        return { nodes: nodesMap, searchIndex, expandedIds, metricCounts };
      });
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

  deleteMetricNode: (nodeId: string) => {
    set(s => {
      const node = s.nodes.get(nodeId);
      if (!node || node.nodeType !== 'metric') return s;

      const nodes = new Map(s.nodes);
      const searchIndex = new Map(s.searchIndex);
      const expandedIds = new Set(s.expandedIds);

      nodes.delete(nodeId);
      searchIndex.delete(nodeId);
      expandedIds.delete(nodeId);

      // Update metric count for parent metrics_folder
      const parentId = node.parentId;
      if (parentId) {
        const metricCounts = new Map(s.metricCounts);
        const currentCount = metricCounts.get(parentId) ?? 0;
        metricCounts.set(parentId, Math.max(0, currentCount - 1));
        return { nodes, searchIndex, expandedIds, metricCounts };
      }

      return { nodes, searchIndex, expandedIds };
    });
  },

  deleteMetricById: (metricId: number) => {
    const { nodes } = get();
    for (const [id, node] of nodes) {
      if (node.nodeType === 'metric' && node.meta.objectName === String(metricId)) {
        get().deleteMetricNode(id);
        return;
      }
    }
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
      const metricCounts = new Map(s.metricCounts);
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
        metricCounts.delete(id);
      }
      // Clear current node's count (applicable for metrics_folder)
      metricCounts.delete(nodeId);
      return { nodes, searchIndex, expandedIds, metricCounts };
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
