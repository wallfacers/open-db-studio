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
  id: string                      // "cat_1" | "job_5"
  nodeType: 'category' | 'job'
  label: string
  parentId: string | null
  meta: {
    categoryId?: number
    jobId?: number
    connectionId?: number
    status?: string
    sortOrder?: number
    depth?: number                // 嵌套深度（0-based），最大 2（3层）
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
  createCategory: (name: string, parentId?: number) => Promise<void>
  renameCategory: (id: number, name: string) => Promise<void>
  deleteCategory: (id: number) => Promise<void>
  createJob: (name: string, categoryId?: number) => Promise<number>
  deleteJob: (id: number) => Promise<void>
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
      // 加载持久化的展开状态
      const savedIds = await invoke<string | null>('get_ui_state', { key: 'seatunnel_tree_expanded_ids' });
      const expandedIds = new Set<string>(savedIds ? JSON.parse(savedIds) : []);

      // 并行加载分类和 Job
      const [categories, jobs] = await Promise.all([
        invoke<Array<{id: number, name: string, parent_id: number | null, sort_order: number}>>('list_st_categories'),
        invoke<Array<{id: number, name: string, category_id: number | null, connection_id: number | null, last_status: string | null}>>('list_st_jobs'),
      ]);

      const nodes = new Map<string, STTreeNode>();

      // 计算分类深度（辅助函数）
      const depthMap = new Map<number, number>();
      function getDepth(catId: number): number {
        if (depthMap.has(catId)) return depthMap.get(catId)!;
        const cat = categories.find(c => c.id === catId);
        if (!cat || cat.parent_id === null) {
          depthMap.set(catId, 0);
          return 0;
        }
        const d = getDepth(cat.parent_id) + 1;
        depthMap.set(catId, d);
        return d;
      }

      // 构建分类节点
      for (const cat of categories) {
        const id = `cat_${cat.id}`;
        const hasChildCategories = categories.some(c => c.parent_id === cat.id);
        const hasChildJobs = jobs.some(j => j.category_id === cat.id);
        nodes.set(id, {
          id,
          nodeType: 'category',
          label: cat.name,
          parentId: cat.parent_id ? `cat_${cat.parent_id}` : null,
          hasChildren: hasChildCategories || hasChildJobs,
          loaded: true,
          meta: {
            categoryId: cat.id,
            sortOrder: cat.sort_order,
            depth: getDepth(cat.id),
          },
        });
      }

      // 构建 Job 节点
      for (const job of jobs) {
        const id = `job_${job.id}`;
        nodes.set(id, {
          id,
          nodeType: 'job',
          label: job.name,
          parentId: job.category_id ? `cat_${job.category_id}` : null,
          hasChildren: false,
          loaded: true,
          meta: {
            jobId: job.id,
            connectionId: job.connection_id ?? undefined,
            status: job.last_status ?? undefined,
          },
        });
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

  createCategory: async (name, parentId) => {
    const newId = await invoke<number>('create_st_category', { name, parentId: parentId ?? null });
    await get().init(); // 重新加载树
    // 展开父节点（如有）
    if (parentId) {
      set(s => {
        const next = new Set(s.expandedIds);
        next.add(`cat_${parentId}`);
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

  createJob: async (name, categoryId) => {
    const newId = await invoke<number>('create_st_job', { name, categoryId: categoryId ?? null });
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
