import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
import { patchError, execError } from '../errors'
import { applyPatch } from '../jsonPatch'
import { useMetricFormStore } from '../../../store/metricFormStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { invoke } from '@tauri-apps/api/core'
import { useHighlightStore } from '../../../store/highlightStore'

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

  async exec(action: string, _params?: any): Promise<ExecResult> {
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
      default:
        return execError(`Unknown action: ${action}`, 'Available actions: save, validate')
    }
  }
}
