import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { applyPatch } from '../jsonPatch'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { invoke } from '@tauri-apps/api/core'

const SEATUNNEL_JOB_SCHEMA = {
  type: 'object',
  properties: {
    jobName: { type: 'string', description: 'Job name' },
    configJson: { type: 'string', description: 'SeaTunnel job config JSON' },
    connectionId: { type: 'number' },
    categoryId: { type: 'number' },
  },
  required: ['jobName', 'configJson'],
}

export interface SeaTunnelJobState {
  jobId?: number
  jobName: string
  configJson: string
  connectionId?: number
  categoryId?: number
}

export class SeaTunnelJobUIObject implements UIObject {
  type = 'seatunnel_job'
  objectId: string
  title: string
  connectionId?: number
  private state: SeaTunnelJobState
  private setState: (s: SeaTunnelJobState) => void

  constructor(objectId: string, state: SeaTunnelJobState, setState: (s: SeaTunnelJobState) => void) {
    this.objectId = objectId
    this.title = state.jobName || 'New Job'
    this.connectionId = state.connectionId
    this.state = state
    this.setState = setState
  }

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state': return this.state
      case 'schema': return SEATUNNEL_JOB_SCHEMA
      case 'actions': return [
        { name: 'save', description: 'Save job configuration' },
        { name: 'submit', description: 'Submit job for execution' },
        { name: 'stop', description: 'Stop running job' },
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
          if (this.state.jobId) {
            await invoke('update_st_job', {
              id: this.state.jobId,
              name: this.state.jobName,
              configJson: this.state.configJson,
              categoryId: this.state.categoryId,
              connectionId: this.state.connectionId,
            })
          }
          return { success: true }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      case 'submit': {
        try {
          if (!this.state.jobId) return { success: false, error: 'Job not saved yet' }
          const result = await invoke('submit_st_job', { jobId: this.state.jobId })
          return { success: true, data: result }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      case 'stop': {
        try {
          if (!this.state.jobId) return { success: false, error: 'No job to stop' }
          await invoke('stop_st_job', { jobId: this.state.jobId })
          return { success: true }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }
}
