import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
import { patchError, execError } from '../errors'
import { applyPatch } from '../jsonPatch'
import { useSeaTunnelJobFormStore } from '../../../store/seatunnelJobStore'
import { useSeaTunnelStore } from '../../../store/seaTunnelStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { invoke } from '@tauri-apps/api/core'
import { useHighlightStore } from '../../../store/highlightStore'
import { diffJsonStringPaths } from '../../../utils/jsonDiff'

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

const SEATUNNEL_PATCH_CAPABILITIES: PatchCapability[] = [
  { pathPattern: '/jobName', ops: ['replace'], description: 'Change job name' },
  { pathPattern: '/configJson', ops: ['replace'], description: 'Replace entire job config JSON' },
  { pathPattern: '/connectionId', ops: ['replace'], description: 'Change connection' },
  { pathPattern: '/categoryId', ops: ['replace'], description: 'Change category' },
]

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

  get patchCapabilities(): PatchCapability[] {
    return SEATUNNEL_PATCH_CAPABILITIES
  }

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state':
        return useSeaTunnelJobFormStore.getState().getForm(this.objectId) ?? {}
      case 'schema':
        return { ...SEATUNNEL_JOB_SCHEMA, patchCapabilities: SEATUNNEL_PATCH_CAPABILITIES }
      case 'actions':
        return [
          {
            name: 'save',
            description: 'Save job configuration to database',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'submit',
            description: 'Submit job for execution (must be saved first)',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'stop',
            description: 'Stop a running job',
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
    const current = useSeaTunnelJobFormStore.getState().getForm(this.objectId)
    if (!current) return patchError(`No form state for ${this.objectId}`)
    const oldConfigJson = current.configJson
    try {
      const patched = applyPatch(current, ops)
      useSeaTunnelJobFormStore.getState().setForm(this.objectId, patched)
      // 同步到 seaTunnelStore.stJobContent，触发 SeaTunnelJobTab 的 externalContent 订阅
      if (patched.jobId && patched.configJson) {
        useSeaTunnelStore.getState().setStJobContent(patched.jobId, patched.configJson)
      }

      // 提取变更路径并触发高亮
      const changedPaths = this.extractChangedPaths(ops, oldConfigJson, patched.configJson)
      if (changedPaths.length > 0) {
        useHighlightStore.getState().addHighlights(this.objectId, changedPaths)
      }

      return { status: 'applied' }
    } catch (e) {
      return patchError(String(e))
    }
  }

  private extractChangedPaths(
    ops: JsonPatchOp[],
    oldConfigJson: string,
    newConfigJson: string,
  ): string[] {
    const paths: string[] = []
    for (const op of ops) {
      const segments = op.path.replace(/^\//, '').split('/')
      const topKey = segments[0]
      if (topKey === 'configJson') {
        // Diff the JSON content to get specific field paths
        paths.push(...diffJsonStringPaths(oldConfigJson, newConfigJson))
      } else {
        // Direct field (e.g. /jobName) → map as-is
        paths.push(segments.join('.'))
      }
    }
    return paths
  }

  async exec(action: string, _params?: any): Promise<ExecResult> {
    const state = useSeaTunnelJobFormStore.getState().getForm(this.objectId)
    if (!state) return execError('No form state', `SeaTunnel job form ${this.objectId} not initialized`)

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
          if (!state.jobId) return execError('Job not saved yet', 'Call save action first')
          const result = await invoke('submit_st_job', { jobId: state.jobId })
          return { success: true, data: result }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      case 'stop': {
        try {
          if (!state.jobId) return execError('No job to stop', 'Job must be saved and submitted first')
          await invoke('stop_st_job', { jobId: state.jobId })
          return { success: true }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      default:
        return execError(`Unknown action: ${action}`, 'Available actions: save, submit, stop')
    }
  }
}
