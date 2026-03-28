import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { applyPatch } from '../jsonPatch'
import { useMetricFormStore } from '../../../store/metricFormStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { invoke } from '@tauri-apps/api/core'

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

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state':
        return useMetricFormStore.getState().getForm(this.objectId) ?? {}
      case 'schema':
        return METRIC_FORM_SCHEMA
      case 'actions':
        return [
          { name: 'save', description: 'Save metric definition' },
          { name: 'validate', description: 'Validate metric fields' },
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
    if (!current) return { status: 'error', message: `No form state for ${this.objectId}` }
    try {
      const patched = applyPatch(current, ops)
      useMetricFormStore.getState().setForm(this.objectId, patched)
      return { status: 'applied' }
    } catch (e) {
      return { status: 'error', message: String(e) }
    }
  }

  async exec(action: string, _params?: any): Promise<ExecResult> {
    const state = useMetricFormStore.getState().getForm(this.objectId)
    if (!state) return { success: false, error: 'No form state' }

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
        return { success: false, error: `Unknown action: ${action}` }
    }
  }
}
