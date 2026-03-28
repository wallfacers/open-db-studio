import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { applyPatch } from '../jsonPatch'
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

export interface MetricFormState {
  metricId?: number
  displayName: string
  name: string
  metricType: 'atomic' | 'composite'
  tableName: string
  columnName: string
  aggregation: string
  filterSql: string
  category: string
  description: string
}

export class MetricFormUIObject implements UIObject {
  type = 'metric_form'
  objectId: string
  title: string
  connectionId?: number
  private state: MetricFormState
  private setState: (s: MetricFormState) => void

  constructor(objectId: string, state: MetricFormState, setState: (s: MetricFormState) => void, connectionId?: number) {
    this.objectId = objectId
    this.title = state.displayName || 'New Metric'
    this.connectionId = connectionId
    this.state = state
    this.setState = setState
  }

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state': return this.state
      case 'schema': return METRIC_FORM_SCHEMA
      case 'actions': return [
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
      ops, reason, currentState: this.state,
      onConfirm: () => this.patchDirect(ops),
    })
    return { status: 'pending_confirm', confirm_id: confirmId, preview: ops }
  }

  patchDirect(ops: JsonPatchOp[]): PatchResult {
    try {
      const patched = applyPatch(this.state, ops)
      this.setState(patched)
      return { status: 'applied' }
    } catch (e) {
      return { status: 'error', message: String(e) }
    }
  }

  async exec(action: string, _params?: any): Promise<ExecResult> {
    switch (action) {
      case 'save': {
        try {
          if (this.state.metricId) {
            await invoke('update_metric', { id: this.state.metricId, input: this.state })
          } else {
            await invoke('save_metric', { input: this.state })
          }
          return { success: true }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      case 'validate': {
        const errors: string[] = []
        if (!this.state.displayName) errors.push('displayName is required')
        if (!this.state.name) errors.push('name is required')
        return { success: errors.length === 0, data: { errors } }
      }
      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }
}
