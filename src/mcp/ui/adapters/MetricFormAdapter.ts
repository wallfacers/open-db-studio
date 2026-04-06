import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
import { patchError, execError } from '../errors'
import { applyPatch } from '../jsonPatch'
import { useMetricFormStore } from '../../../store/metricFormStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { invoke } from '@tauri-apps/api/core'
import { useHighlightStore } from '../../../store/highlightStore'
import { resolveVarRefs, validateBatchVarRefs } from '../batchUtils'

const METRIC_FORM_SCHEMA = {
  type: 'object',
  properties: {
    displayName: { type: 'string', description: 'User-facing display name' },
    name: { type: 'string', description: 'English identifier' },
    metricType: { type: 'string', enum: ['atomic', 'composite'] },
    tableName: { type: 'string', description: 'Source table (atomic only)' },
    columnName: { type: 'string', description: 'Aggregation column (atomic only)' },
    aggregation: { type: 'string', enum: ['SUM', 'COUNT', 'AVG', 'MAX', 'MIN', 'COUNT_DISTINCT'] },
    filterSql: { type: 'string', description: 'SQL filter clause' },
    category: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['displayName', 'name'],
}

const METRIC_PATCH_CAPABILITIES: PatchCapability[] = [
  { pathPattern: '/displayName', ops: ['replace'], description: 'Change display name' },
  { pathPattern: '/name', ops: ['replace'], description: 'Change identifier' },
  { pathPattern: '/metricType', ops: ['replace'], description: 'Change metric type (atomic/composite)' },
  { pathPattern: '/tableName', ops: ['replace'], description: 'Change source table' },
  { pathPattern: '/columnName', ops: ['replace'], description: 'Change aggregation column' },
  { pathPattern: '/aggregation', ops: ['replace'], description: 'Change aggregation function' },
  { pathPattern: '/filterSql', ops: ['replace'], description: 'Change SQL filter clause' },
  { pathPattern: '/category', ops: ['replace'], description: 'Change category' },
  { pathPattern: '/description', ops: ['replace'], description: 'Change description' },
]

export class MetricFormUIObject implements UIObject {
  type = 'metric_form'
  objectId: string
  title: string
  connectionId?: number

  constructor(tabId: string, connectionId?: number) {
    this.objectId = tabId
    this.connectionId = connectionId
    this.title = useMetricFormStore.getState().getForm(tabId)?.displayName || 'New Metric'
  }

  get patchCapabilities(): PatchCapability[] {
    return METRIC_PATCH_CAPABILITIES
  }

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state':
        return useMetricFormStore.getState().getForm(this.objectId) ?? {}
      case 'schema':
        return { ...METRIC_FORM_SCHEMA, patchCapabilities: METRIC_PATCH_CAPABILITIES }
      case 'actions':
        return [
          {
            name: 'save',
            description: 'Save metric definition to database',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'validate',
            description: 'Validate metric fields and return any errors',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'batch_create',
            description:
              'Create multiple metrics at once without opening individual tabs. ' +
              'Each item is saved directly to the database. ' +
              'Returns { created: number, results: [{displayName, metricId}] }.',
            paramsSchema: {
              type: 'object',
              properties: {
                metrics: {
                  type: 'array',
                  description: 'Array of metric definitions to create',
                  items: {
                    type: 'object',
                    properties: {
                      displayName: { type: 'string', description: 'User-facing display name (required)' },
                      name: { type: 'string', description: 'English identifier (required)' },
                      metricType: { type: 'string', enum: ['atomic', 'composite'], default: 'atomic' },
                      tableName: { type: 'string' },
                      columnName: { type: 'string' },
                      aggregation: { type: 'string', enum: ['SUM', 'COUNT', 'AVG', 'MAX', 'MIN', 'COUNT_DISTINCT'] },
                      filterSql: { type: 'string' },
                      category: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['displayName', 'name'],
                  },
                },
              },
              required: ['metrics'],
            },
          },
          {
            name: 'batch',
            description:
              'Execute a sequence of actions in one call with variable binding. ' +
              'Each op is { action, params }; results are stored and can be referenced by later ops ' +
              'via "$N.path" syntax. Stops on first failure. ' +
              'Set dryRun=true to validate without executing.',
            paramsSchema: {
              type: 'object',
              properties: {
                ops: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      action: { type: 'string' },
                      params: { type: 'object' },
                    },
                    required: ['action'],
                  },
                },
                dryRun: { type: 'boolean', default: false },
              },
              required: ['ops'],
            },
          },
        ]
    }
  }

  patch(ops: JsonPatchOp[], reason?: string): PatchResult {
    const autoMode = useAppStore.getState().autoMode
    if (autoMode) return this.patchDirect(ops)

    const confirmId = `patch_${this.objectId}_${Date.now()}`
    usePatchConfirmStore.getState().propose({
      confirmId, objectId: this.objectId, objectType: this.type,
      ops, reason, currentState: this.read('state'),
      createdAt: Date.now(),
      onConfirm: () => this.patchDirect(ops),
    })
    return { status: 'pending_confirm', confirm_id: confirmId, preview: ops }
  }

  patchDirect(ops: JsonPatchOp[]): PatchResult {
    const current = useMetricFormStore.getState().getForm(this.objectId)
    if (!current) return patchError(`No form state for ${this.objectId}`)
    try {
      const patched = applyPatch(current, ops)
      useMetricFormStore.getState().setForm(this.objectId, patched)
      // Extract changed paths by comparing old vs new field values
      const paths: string[] = []
      for (const key of Object.keys(patched) as Array<keyof typeof patched>) {
        if (current[key] !== patched[key]) {
          paths.push(key)
        }
      }
      if (paths.length > 0) {
        useHighlightStore.getState().addHighlights(this.objectId, paths)
      }
      return { status: 'applied' }
    } catch (e) {
      return { status: 'error', message: String(e) }
    }
  }

  async exec(action: string, params?: any): Promise<ExecResult> {
    const state = useMetricFormStore.getState().getForm(this.objectId)
    if (!state) return execError('No form state', `Metric form ${this.objectId} not initialized`)

    switch (action) {
      case 'save': {
        try {
          if (state.metricId) {
            await invoke('update_metric', { id: state.metricId, input: state })
          } else {
            await invoke('save_metric', { input: state })
          }
          return { success: true }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      case 'validate': {
        const errors: string[] = []
        if (!state.displayName) errors.push('displayName is required')
        if (!state.name) errors.push('name is required')
        return { success: errors.length === 0, data: { errors } }
      }
      case 'batch_create': {
        const metrics: any[] = params?.metrics
        if (!Array.isArray(metrics) || metrics.length === 0) {
          return execError('metrics must be a non-empty array')
        }
        const results: Array<{ displayName: string; metricId: unknown }> = []
        for (let i = 0; i < metrics.length; i++) {
          const m = metrics[i]
          if (!m.displayName || !m.name) {
            return {
              success: false,
              error: `metrics[${i}]: displayName and name are required`,
              data: { created: results.length, results },
            }
          }
          const input = {
            displayName: m.displayName,
            name: m.name,
            metricType: m.metricType ?? 'atomic',
            tableName: m.tableName ?? '',
            columnName: m.columnName ?? '',
            aggregation: m.aggregation ?? '',
            filterSql: m.filterSql ?? '',
            category: m.category ?? '',
            description: m.description ?? '',
            connectionId: this.connectionId,
          }
          try {
            const metricId = await invoke('save_metric', { input })
            results.push({ displayName: m.displayName, metricId })
          } catch (e) {
            return {
              success: false,
              error: `metrics[${i}] "${m.displayName}" failed: ${String(e)}`,
              data: { created: results.length, results },
            }
          }
        }
        return { success: true, data: { created: results.length, results } }
      }

      case 'batch':
        return this._batchExec(params)

      default:
        return execError(`Unknown action: ${action}`, 'Available actions: save, validate, batch_create, batch')
    }
  }

  private async _batchExec(params: any): Promise<ExecResult> {
    const ops: Array<{ action: string; params?: unknown }> = params?.ops ?? []
    if (ops.length === 0) return execError('ops array is required and must be non-empty')
    if (ops.length > 50) return execError('ops array too large (max 50)')

    if (params?.dryRun) {
      const actionDefs = this.read('actions') as Array<{ name: string; paramsSchema?: any }>
      const actionNames = new Set(actionDefs.map(a => a.name))
      const errors: string[] = []
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]
        if (op.action === 'batch') {
          errors.push(`op[${i}]: nested batch is not allowed`)
          continue
        }
        if (!actionNames.has(op.action)) {
          errors.push(`op[${i}]: unknown action "${op.action}"`)
        }
      }
      errors.push(...validateBatchVarRefs(ops))
      if (errors.length > 0) {
        return { success: false, error: `Dry-run validation failed:\n${errors.join('\n')}` }
      }
      return { success: true, data: { validated: true, opCount: ops.length } }
    }

    const results: unknown[] = []
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      if (op.action === 'batch') {
        return { success: false, error: `op[${i}]: nested batch is not allowed` }
      }
      let resolvedParams: unknown
      try {
        resolvedParams = resolveVarRefs(op.params, results)
      } catch (e) {
        return {
          success: false,
          error: `op[${i}] ${op.action}: variable resolve failed — ${e instanceof Error ? e.message : String(e)}`,
          data: { completedOps: i, results },
        }
      }
      const result = await this.exec(op.action, resolvedParams)
      if (!result.success) {
        return {
          success: false,
          error: `op[${i}] ${op.action} failed: ${result.error}`,
          data: { completedOps: i, results },
        }
      }
      results.push(result.data ?? {})
    }
    return { success: true, data: { results } }
  }
}
