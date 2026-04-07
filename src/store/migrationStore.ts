import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// ── Types ─────────────────────────────────────────────────────

export interface MigrationCategory {
  id: number
  name: string
  parentId: number | null
  sortOrder: number
  createdAt: string
}

export interface MigrationJob {
  id: number
  name: string
  categoryId: number | null
  configJson: string
  lastStatus: 'RUNNING' | 'FINISHED' | 'FAILED' | 'STOPPED' | null
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MigrationRunHistory {
  id: number
  jobId: number
  runId: string
  status: string
  rowsRead: number
  rowsWritten: number
  rowsFailed: number
  bytesTransferred: number
  durationMs: number | null
  startedAt: string
  finishedAt: string | null
}

export interface MigrationDirtyRecord {
  id: number
  jobId: number
  runId: string
  rowIndex: number | null
  fieldName: string | null
  rawValue: string | null
  errorMsg: string | null
  createdAt: string
}

export interface MigrationStatsEvent {
  jobId: number
  runId: string
  rowsRead: number
  rowsWritten: number
  rowsFailed: number
  bytesTransferred: number
  readSpeedRps: number
  writeSpeedRps: number
  etaSeconds: number | null
  progressPct: number | null
}

export interface MigrationLogEvent {
  jobId: number
  runId: string
  level: string
  message: string
  timestamp: string
}

export type MigTreeNode =
  | { nodeType: 'category'; id: string; label: string; parentId: string | null; sortOrder: number }
  | { nodeType: 'job'; id: string; label: string; parentId: string | null; jobId: number; status: string | null }

// ── Persist helpers ───────────────────────────────────────────

let _persistTimer: ReturnType<typeof setTimeout> | null = null
function persistExpandedIds(ids: Set<string>) {
  if (_persistTimer) clearTimeout(_persistTimer)
  _persistTimer = setTimeout(() => {
    invoke('set_ui_state', {
      key: 'migration_tree_expanded_ids',
      value: JSON.stringify([...ids]),
    }).catch(() => {})
  }, 800)
}

export function flushMigrationPersist() {
  if (_persistTimer) {
    clearTimeout(_persistTimer)
    _persistTimer = null
    const { expandedIds } = useMigrationStore.getState()
    invoke('set_ui_state', {
      key: 'migration_tree_expanded_ids',
      value: JSON.stringify([...expandedIds]),
    }).catch(() => {})
  }
}

// ── Store ────────────────────────────────────────────────────

interface MigrationStore {
  nodes: Map<string, MigTreeNode>
  expandedIds: Set<string>
  selectedId: string | null
  isInitializing: boolean
  activeRuns: Map<number, { runId: string; stats: MigrationStatsEvent | null; logs: MigrationLogEvent[] }>

  init: () => Promise<void>
  toggleExpand: (id: string) => void
  selectNode: (id: string | null) => void
  createCategory: (name: string, parentId?: number) => Promise<void>
  renameCategory: (id: number, name: string) => Promise<void>
  deleteCategory: (id: number) => Promise<void>
  createJob: (name: string, categoryId?: number) => Promise<number>
  renameJob: (id: number, name: string) => Promise<void>
  deleteJob: (id: number) => Promise<void>
  moveJob: (id: number, categoryId: number | null) => Promise<void>
  updateJobStatus: (jobId: number, status: string) => void
  startListening: () => () => void
}

function buildNodes(
  categories: MigrationCategory[],
  jobs: MigrationJob[],
): Map<string, MigTreeNode> {
  const nodes = new Map<string, MigTreeNode>()
  for (const cat of categories) {
    nodes.set(`cat_${cat.id}`, {
      nodeType: 'category',
      id: `cat_${cat.id}`,
      label: cat.name,
      parentId: cat.parentId ? `cat_${cat.parentId}` : null,
      sortOrder: cat.sortOrder,
    })
  }
  for (const job of jobs) {
    nodes.set(`job_${job.id}`, {
      nodeType: 'job',
      id: `job_${job.id}`,
      label: job.name,
      parentId: job.categoryId ? `cat_${job.categoryId}` : null,
      jobId: job.id,
      status: job.lastStatus,
    })
  }
  return nodes
}

export const useMigrationStore = create<MigrationStore>((set, get) => ({
  nodes: new Map(),
  expandedIds: new Set(),
  selectedId: null,
  isInitializing: false,
  activeRuns: new Map(),

  init: async () => {
    set({ isInitializing: true })
    try {
      const [categories, jobs, savedIds] = await Promise.all([
        invoke<MigrationCategory[]>('list_migration_categories'),
        invoke<MigrationJob[]>('list_migration_jobs'),
        invoke<string>('get_ui_state', { key: 'migration_tree_expanded_ids' }).catch(() => '[]'),
      ])
      const expandedIds = new Set<string>(JSON.parse(savedIds || '[]'))
      const nodes = buildNodes(categories, jobs)
      set({ nodes, expandedIds, isInitializing: false })
    } catch {
      set({ isInitializing: false })
    }
  },

  toggleExpand: (id) => set(s => {
    const next = new Set(s.expandedIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    persistExpandedIds(next)
    return { expandedIds: next }
  }),

  selectNode: (id) => set({ selectedId: id }),

  createCategory: async (name, parentId) => {
    await invoke('create_migration_category', { name, parentId: parentId ?? null })
    await get().init()
  },

  renameCategory: async (id, name) => {
    await invoke('rename_migration_category', { id, name })
    set(s => {
      const nodes = new Map(s.nodes)
      const node = nodes.get(`cat_${id}`)
      if (node) nodes.set(`cat_${id}`, { ...node, label: name })
      return { nodes }
    })
  },

  deleteCategory: async (id) => {
    await invoke('delete_migration_category', { id })
    await get().init()
  },

  createJob: async (name, categoryId) => {
    const job = await invoke<MigrationJob>('create_migration_job', {
      name, categoryId: categoryId ?? null,
    })
    await get().init()
    return job.id
  },

  renameJob: async (id, name) => {
    await invoke('rename_migration_job', { id, name })
    set(s => {
      const nodes = new Map(s.nodes)
      const node = nodes.get(`job_${id}`)
      if (node) nodes.set(`job_${id}`, { ...node, label: name })
      return { nodes }
    })
  },

  deleteJob: async (id) => {
    await invoke('delete_migration_job', { id })
    set(s => {
      const nodes = new Map(s.nodes)
      nodes.delete(`job_${id}`)
      return { nodes }
    })
  },

  moveJob: async (id, categoryId) => {
    await invoke('move_migration_job', { id, categoryId })
    set(s => {
      const nodes = new Map(s.nodes)
      const node = nodes.get(`job_${id}`)
      if (node && node.nodeType === 'job') {
        nodes.set(`job_${id}`, {
          ...node,
          parentId: categoryId ? `cat_${categoryId}` : null,
        })
      }
      return { nodes }
    })
  },

  updateJobStatus: (jobId, status) => set(s => {
    const nodes = new Map(s.nodes)
    const node = nodes.get(`job_${jobId}`)
    if (node && node.nodeType === 'job') {
      nodes.set(`job_${jobId}`, { ...node, status })
    }
    return { nodes }
  }),

  startListening: () => {
    const unlisteners: Array<() => void> = []

    listen<MigrationLogEvent>('migration_log', ({ payload }) => {
      set(s => {
        const runs = new Map(s.activeRuns)
        const run = runs.get(payload.jobId) ?? { runId: payload.runId, stats: null, logs: [] }
        runs.set(payload.jobId, { ...run, logs: [...run.logs, payload].slice(-500) })
        return { activeRuns: runs }
      })
    }).then(u => unlisteners.push(u))

    listen<MigrationStatsEvent>('migration_stats', ({ payload }) => {
      set(s => {
        const runs = new Map(s.activeRuns)
        const run = runs.get(payload.jobId) ?? { runId: payload.runId, stats: null, logs: [] }
        runs.set(payload.jobId, { ...run, stats: payload })
        return { activeRuns: runs }
      })
    }).then(u => unlisteners.push(u))

    listen<{ jobId: number; runId: string; status: string }>('migration_finished', ({ payload }) => {
      get().updateJobStatus(payload.jobId, payload.status)
      set(s => {
        const runs = new Map(s.activeRuns)
        const run = runs.get(payload.jobId)
        if (run) runs.set(payload.jobId, { ...run })
        return { activeRuns: runs }
      })
    }).then(u => unlisteners.push(u))

    return () => unlisteners.forEach(u => u())
  },
}))
