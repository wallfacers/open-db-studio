import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

// 防抖持久化（对齐 metricsTreeStore 模式）
let _persistSTTimer: ReturnType<typeof setTimeout> | null = null;

function persistSTExpandedIds(ids: Set<string>): void {
  if (_persistSTTimer) clearTimeout(_persistSTTimer);
  _persistSTTimer = setTimeout(() => {
    invoke('set_ui_state', {
      key: 'seatunnel_tree_expanded_ids',
      value: JSON.stringify([...ids]),
    }).catch(() => {});
  }, 800);
}

export function flushSeaTunnelPersist(): void {
  if (_persistSTTimer) {
    clearTimeout(_persistSTTimer);
    _persistSTTimer = null;
    // 立即执行持久化
    const { expandedIds } = useSeaTunnelStore.getState();
    invoke('set_ui_state', {
      key: 'seatunnel_tree_expanded_ids',
      value: JSON.stringify([...expandedIds]),
    }).catch(() => {});
  }
}

export interface STTreeNode {
  id: string                      // "conn_1" | "cat_5" | "job_10"
  nodeType: 'connection' | 'category' | 'job'
  label: string
  parentId: string | null
  meta: {
    connectionId?: number
    connectionUrl?: string
    categoryId?: number
    jobId?: number
    status?: string
    sortOrder?: number
    depth?: number
  }
  hasChildren: boolean
  loaded: boolean
}

interface SeaTunnelStore {
  nodes: Map<string, STTreeNode>
  expandedIds: Set<string>
  selectedId: string | null
  isInitializing: boolean
  error: string | null
  // actions
  init: () => Promise<void>
  toggleExpand: (id: string) => void
  selectNode: (id: string | null) => void
  editConnection: (id: number, name: string, url: string, authToken?: string) => Promise<void>
  deleteConnection: (id: number) => Promise<void>
  createCategory: (name: string, parentCategoryId?: number, connectionId?: number) => Promise<void>
  renameCategory: (id: number, name: string) => Promise<void>
  deleteCategory: (id: number) => Promise<void>
  createJob: (name: string, categoryId?: number, connectionId?: number) => Promise<number>
  deleteJob: (id: number) => Promise<void>
  renameJob: (id: number, name: string) => Promise<void>
  moveJob: (jobId: number, categoryId: number | null) => Promise<void>
  updateJobStatus: (jobId: number, status: string) => void
}

export const useSeaTunnelStore = create<SeaTunnelStore>((set, get) => ({
  nodes: new Map(),
  expandedIds: new Set(),
  selectedId: null,
  isInitializing: false,
  error: null,

  init: async () => {
    set({ isInitializing: true, error: null });
    try {
      const savedIds = await invoke<string | null>('get_ui_state', { key: 'seatunnel_tree_expanded_ids' });
      const expandedIds = new Set<string>(savedIds ? JSON.parse(savedIds) : []);

      const [connections, categories, jobs] = await Promise.all([
        invoke<Array<{ id: number; name: string; url: string }>>('list_st_connections'),
        invoke<Array<{ id: number; name: string; parent_id: number | null; connection_id: number | null; sort_order: number }>>('list_st_categories'),
        invoke<Array<{ id: number; name: string; category_id: number | null; connection_id: number | null; last_status: string | null }>>('list_st_jobs'),
      ]);

      const nodes = new Map<string, STTreeNode>();

      // 1. 生成 connection 根节点
      for (const c of connections) {
        nodes.set(`conn_${c.id}`, {
          id: `conn_${c.id}`,
          nodeType: 'connection',
          label: c.name,
          parentId: null,
          hasChildren: false,
          loaded: true,
          meta: { connectionId: c.id, connectionUrl: c.url },
        });
      }

      // 2. 构建 category 节点（depth 相对 category 层，0-based）
      const catDepthMap = new Map<number, number>();
      const catDepthVisiting = new Set<number>();
      function getCatDepth(catId: number): number {
        if (catDepthMap.has(catId)) return catDepthMap.get(catId)!;
        if (catDepthVisiting.has(catId)) { catDepthMap.set(catId, 0); return 0; } // 循环引用检测，中断递归
        catDepthVisiting.add(catId);
        const cat = categories.find(c => c.id === catId);
        if (!cat || cat.parent_id === null) { catDepthMap.set(catId, 0); catDepthVisiting.delete(catId); return 0; }
        const d = getCatDepth(cat.parent_id) + 1;
        catDepthMap.set(catId, d);
        catDepthVisiting.delete(catId);
        return d;
      }

      for (const cat of categories) {
        const id = `cat_${cat.id}`;
        let parentId: string | null = null;
        if (cat.parent_id !== null) {
          parentId = `cat_${cat.parent_id}`;
        } else if (cat.connection_id !== null) {
          parentId = `conn_${cat.connection_id}`;
        } else {
          continue; // 无归属的根目录，隐藏
        }
        nodes.set(id, {
          id,
          nodeType: 'category',
          label: cat.name,
          parentId,
          hasChildren: false,
          loaded: true,
          meta: { categoryId: cat.id, sortOrder: cat.sort_order, depth: getCatDepth(cat.id) },
        });
      }

      // 3. 构建 Job 节点
      for (const job of jobs) {
        const id = `job_${job.id}`;
        let parentId: string | null = null;
        if (job.category_id !== null) {
          parentId = `cat_${job.category_id}`;
        } else if (job.connection_id !== null) {
          parentId = `conn_${job.connection_id}`;
        } else {
          continue; // 孤儿 Job，隐藏
        }
        nodes.set(id, {
          id,
          nodeType: 'job',
          label: job.name,
          parentId,
          hasChildren: false,
          loaded: true,
          meta: { jobId: job.id, connectionId: job.connection_id ?? undefined, status: job.last_status ?? undefined },
        });
      }

      // 4. 更新 hasChildren
      for (const node of nodes.values()) {
        if (node.parentId) {
          const parent = nodes.get(node.parentId);
          if (parent) {
            nodes.set(node.parentId, { ...parent, hasChildren: true });
          }
        }
      }

      set({ nodes, expandedIds, isInitializing: false });
    } catch (e) {
      set({ isInitializing: false, error: String(e) });
    }
  },

  toggleExpand: (id) => {
    set(s => {
      const next = new Set(s.expandedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistSTExpandedIds(next);
      return { expandedIds: next };
    });
  },

  selectNode: (id) => set({ selectedId: id }),

  editConnection: async (id, name, url, authToken) => {
    await invoke('update_st_connection', { id, name, url, authToken: authToken ?? null });
    await get().init();
  },

  deleteConnection: async (id) => {
    await invoke('delete_st_connection', { id });
    await get().init();
  },

  createCategory: async (name, parentCategoryId, connectionId) => {
    const newId = await invoke<number>('create_st_category', {
      name,
      parentId: parentCategoryId ?? null,
      connectionId: connectionId ?? null,
    });
    await get().init();
    // 展开父节点（如有）
    if (parentCategoryId) {
      set(s => {
        const next = new Set(s.expandedIds);
        next.add(`cat_${parentCategoryId}`);
        persistSTExpandedIds(next);
        return { expandedIds: next };
      });
    }
    set({ selectedId: `cat_${newId}` });
  },

  renameCategory: async (id, name) => {
    await invoke('rename_st_category', { id, name });
    set(s => {
      const next = new Map(s.nodes);
      const node = next.get(`cat_${id}`);
      if (node) next.set(`cat_${id}`, { ...node, label: name });
      return { nodes: next };
    });
  },

  deleteCategory: async (id) => {
    await invoke('delete_st_category', { id });
    await get().init();
  },

  createJob: async (name, categoryId, connectionId) => {
    const newId = await invoke<number>('create_st_job', {
      name,
      categoryId: categoryId ?? null,
      connectionId: connectionId ?? null,
    });
    await get().init();
    set({ selectedId: `job_${newId}` });
    return newId;
  },

  deleteJob: async (id) => {
    await invoke('delete_st_job', { id });
    set(s => {
      const next = new Map(s.nodes);
      next.delete(`job_${id}`);
      return { nodes: next };
    });
  },

  renameJob: async (id, name) => {
    await invoke('rename_st_job', { id, name });
    set(s => {
      const key = `job_${id}`;
      const node = s.nodes.get(key);
      if (!node) return {};
      const next = new Map(s.nodes);
      next.set(key, { ...node, label: name });
      return { nodes: next };
    });
  },

  moveJob: async (jobId, categoryId) => {
    await invoke('move_st_job', { jobId, categoryId });
    await get().init();
  },

  updateJobStatus: (jobId, status) => {
    set(s => {
      const key = `job_${jobId}`;
      const node = s.nodes.get(key);
      if (!node) return {};
      const next = new Map(s.nodes);
      next.set(key, { ...node, meta: { ...node.meta, status } });
      return { nodes: next };
    });
  },
}));
