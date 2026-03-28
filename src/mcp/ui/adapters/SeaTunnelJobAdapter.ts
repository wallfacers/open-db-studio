import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { applyPatch } from '../jsonPatch'
import { useSeaTunnelJobFormStore } from '../../../store/seatunnelJobStore'
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

export class SeaTunnelJobUIObject implements UIObject {
  type = 'seatunnel_job'
  objectId: string
  title: string
  connectionId?: number

  constructor(tabId: string) {
    this.objectId = tabId
    const form = useSeaTunnelJobFormStore.getState().getForm(tabId)
    this.title = form?.jobName || 'New Job'
    this.connectionId = form?.connectionId
  }

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state':
        return useSeaTunnelJobFormStore.getState().getForm(this.objectId) ?? {}
      case 'schema':
        return SEATUNNEL_JOB_SCHEMA
      case 'actions':
        return [
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
      ops, reason, currentState: this.read('state'),
      createdAt: Date.now(),
      onConfirm: () => this.patchDirect(ops),
    })
    return { status: 'pending_confirm', confirm_id: confirmId, preview: ops }
  }

  patchDirect(ops: JsonPatchOp[]): PatchResult {
    const current = useSeaTunnelJobFormStore.getState().getForm(this.objectId)
    if (!current) return { status: 'error', message: `No form state for ${this.objectId}` }
    try {
      const patched = applyPatch(current, ops)
      useSeaTunnelJobFormStore.getState().setForm(this.objectId, patched)
      return { status: 'applied' }
    } catch (e) {
      return { status: 'error', message: String(e) }
    }
  }

  async exec(action: string, _params?: any): Promise<ExecResult> {
    const state = useSeaTunnelJobFormStore.getState().getForm(this.objectId)
    if (!state) return { success: false, error: 'No form state' }

    switch (action) {
      case 'save': {
        try {
          if (state.jobId) {
            await invoke('update_st_job', {
              id: state.jobId,
              name: state.jobName,
              configJson: state.configJson,
              categoryId: state.categoryId,
              connectionId: state.connectionId,
            })
          }
          return { success: true }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      case 'submit': {
        try {
          if (!state.jobId) return { success: false, error: 'Job not saved yet' }
          const result = await invoke('submit_st_job', { jobId: state.jobId })
          return { success: true, data: result }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      case 'stop': {
        try {
          if (!state.jobId) return { success: false, error: 'No job to stop' }
          await invoke('stop_st_job', { jobId: state.jobId })
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
