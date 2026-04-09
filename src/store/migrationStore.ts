import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { migCatNodeId, migJobNodeId } from '../utils/nodeId'

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
  lastStatus: 'RUNNING' | 'FINISHED' | 'FAILED' | 'STOPPED' | 'PARTIAL_FAILED' | null
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
  logContent: string | null
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
  currentMapping: string | null
  mappingProgress: { total: number; completed: number; current: number } | null
}

export interface MigrationLogEvent {
  jobId: number
  runId: string
  level: string
  message: string
  timestamp: string
}

export interface MigrationMilestone {
  id: string
  type: 'pipeline_start' | 'table_start' | 'table_complete' | 'table_failed' | 'pipeline_finish'
  label: string
  status: 'pending' | 'running' | 'success' | 'failed'
  timestamp: string
  elapsedMs?: number
  rowsRead?: number
  rowsWritten?: number
  rowsFailed?: number
  error?: string
  mappingIndex?: number
  totalMappings?: number
}

export interface MappingCardState {
  sourceTable: string
  targetTable: string
  status: 'pending' | 'running' | 'success' | 'failed'
  rowsRead: number
  rowsWritten: number
  rowsFailed: number
  startedAt?: string
  finishedAt?: string
  elapsedMs?: number
  error?: string
  mappingIndex: number
  totalMappings: number
}

export type LogViewMode = 'structured' | 'raw'

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
  runJob: (jobId: number) => Promise<void>
  startListening: () => () => void
}

function buildNodes(
  categories: MigrationCategory[],
  jobs: MigrationJob[],
): Map<string, MigTreeNode> {
  const nodes = new Map<string, MigTreeNode>()
  for (const cat of categories) {
    const catId = migCatNodeId(cat.id)
    nodes.set(catId, {
      nodeType: 'category',
      id: catId,
      label: cat.name,
      parentId: cat.parentId ? migCatNodeId(cat.parentId) : null,
      sortOrder: cat.sortOrder,
    })
  }
  for (const job of jobs) {
    const jobId = migJobNodeId(job.id)
    nodes.set(jobId, {
      nodeType: 'job',
      id: jobId,
      label: job.name,
      parentId: job.categoryId ? migCatNodeId(job.categoryId) : null,
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
      const nodeId = migCatNodeId(id)
      const node = nodes.get(nodeId)
      if (node) nodes.set(nodeId, { ...node, label: name })
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
      const nodeId = migJobNodeId(id)
      const node = nodes.get(nodeId)
      if (node) nodes.set(nodeId, { ...node, label: name })
      return { nodes }
    })
  },

  deleteJob: async (id) => {
    await invoke('delete_migration_job', { id })
    set(s => {
      const nodes = new Map(s.nodes)
      nodes.delete(migJobNodeId(id))
      return { nodes }
    })
  },

  moveJob: async (id, categoryId) => {
    await invoke('move_migration_job', { id, categoryId })
    set(s => {
      const nodes = new Map(s.nodes)
      const nodeId = migJobNodeId(id)
      const node = nodes.get(nodeId)
      if (node && node.nodeType === 'job') {
        nodes.set(nodeId, {
          ...node,
          parentId: categoryId ? migCatNodeId(categoryId) : null,
        })
      }
      return { nodes }
    })
  },

  updateJobStatus: (jobId, status) => set(s => {
    const nodes = new Map(s.nodes)
    const nodeId = migJobNodeId(jobId)
    const node = nodes.get(nodeId)
    if (node && node.nodeType === 'job') {
      nodes.set(nodeId, { ...node, status })
    }
    return { nodes }
  }),

  runJob: async (jobId) => {
    // Optimistically set to RUNNING, but only if we are not already receiving a finished event
    get().updateJobStatus(jobId, 'RUNNING')
    try {
      await invoke('run_migration_job', { jobId })
    } catch (err) {
      console.error('[migrationStore] runJob failed:', err)
      get().updateJobStatus(jobId, 'FAILED')
      throw err
    }
  },

  startListening: () => {
    let cleaned = false
    const unlisteners: Array<() => void> = []

    const register = <T>(event: string, handler: (payload: T) => void) => {
      listen<T>(event, ({ payload }) => handler(payload)).then(u => {
        if (cleaned) { u() } else { unlisteners.push(u) }
      })
    }

    register<MigrationLogEvent>('migration_log', (payload) => {
      set(s => {
        const runs = new Map(s.activeRuns)
        const existing = runs.get(payload.jobId)
        // New run started: reset logs and stats
        const run = existing && existing.runId === payload.runId
          ? existing
          : { runId: payload.runId, stats: null, logs: [] }
        runs.set(payload.jobId, { ...run, logs: [...run.logs, payload].slice(-500) })
        return { activeRuns: runs }
      })
    })

    register<MigrationStatsEvent>('migration_stats', (payload) => {
      set(s => {
        const runs = new Map(s.activeRuns)
        const existing = runs.get(payload.jobId)
        const run = existing && existing.runId === payload.runId
          ? existing
          : { runId: payload.runId, stats: null, logs: [] }
        runs.set(payload.jobId, { ...run, stats: payload })
        
        // Also ensure the job status is RUNNING if we are receiving stats
        const nodes = new Map(s.nodes)
        const nodeId = migJobNodeId(payload.jobId)
        const node = nodes.get(nodeId)
        if (node && node.nodeType === 'job' && node.status !== 'RUNNING') {
          nodes.set(nodeId, { ...node, status: 'RUNNING' })
          return { activeRuns: runs, nodes }
        }
        
        return { activeRuns: runs }
      })
    })

    register<{ jobId: number; runId: string; status: string; rowsRead?: number; rowsWritten?: number; rowsFailed?: number; bytesTransferred?: number; elapsedSeconds?: number }>('migration_finished', (payload) => {
      console.log(`[migrationStore] finished event for job ${payload.jobId}, status=${payload.status}`);
      
      // Synthesize a Pipeline FINISHED/FAILED log entry so the parser can
      // update pipeline_start status and deduplicate table_start milestones
      const finishLog: MigrationLogEvent = {
        jobId: payload.jobId,
        runId: payload.runId,
        level: 'SYSTEM',
        message: `Pipeline ${payload.status}: rows_written=${payload.rowsWritten ?? 0} rows_failed=${payload.rowsFailed ?? 0} elapsed=${(payload.elapsedSeconds ?? 0).toFixed(2)}s`,
        timestamp: new Date().toISOString(),
      }

      // Merge final stats into the run's stats snapshot
      set(s => {
        const runs = new Map(s.activeRuns)
        const existing = runs.get(payload.jobId)
        if (existing && existing.runId === payload.runId) {
          const stats = existing.stats ? { ...existing.stats } : {
            jobId: payload.jobId,
            runId: payload.runId,
            rowsRead: payload.rowsRead ?? 0,
            rowsWritten: payload.rowsWritten ?? 0,
            rowsFailed: payload.rowsFailed ?? 0,
            bytesTransferred: payload.bytesTransferred ?? 0,
            readSpeedRps: 0,
            writeSpeedRps: 0,
            etaSeconds: 0,
            progressPct: 100,
            currentMapping: null,
            mappingProgress: null,
          }
          if (payload.rowsRead !== undefined) stats.rowsRead = payload.rowsRead
          if (payload.rowsWritten !== undefined) stats.rowsWritten = payload.rowsWritten
          if (payload.rowsFailed !== undefined) stats.rowsFailed = payload.rowsFailed
          if (payload.bytesTransferred !== undefined) stats.bytesTransferred = payload.bytesTransferred
          if (payload.elapsedSeconds !== undefined) {
            stats.progressPct = 100
            stats.etaSeconds = 0
          }
          runs.set(payload.jobId, {
            ...existing,
            stats,
            logs: [...existing.logs, finishLog].slice(-500),
          })
          
          // Also update nodes status in the same set call to avoid race conditions
          const nodes = new Map(s.nodes)
          const nodeId = migJobNodeId(payload.jobId)
          const node = nodes.get(nodeId)
          if (node && node.nodeType === 'job') {
            nodes.set(nodeId, { ...node, status: payload.status })
          }
          
          return { activeRuns: runs, nodes }
        }
        
        // Even if no existing run, create one so the finish log is visible
        runs.set(payload.jobId, {
          runId: payload.runId,
          stats: null,
          logs: [finishLog],
        })
        
        const nodes = new Map(s.nodes)
        const nodeId = migJobNodeId(payload.jobId)
        const node = nodes.get(nodeId)
        if (node && node.nodeType === 'job') {
          nodes.set(nodeId, { ...node, status: payload.status })
        }
        
        return { activeRuns: runs, nodes }
      })
    })

    return () => { cleaned = true; unlisteners.forEach(u => u()) }
  },
}))
