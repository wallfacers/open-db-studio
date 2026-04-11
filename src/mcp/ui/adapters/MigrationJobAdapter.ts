import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
import { applyPatch } from '../jsonPatch'
import { execError } from '../errors'
import { useMigrationStore } from '../../../store/migrationStore'
import { useQueryStore } from '../../../store/queryStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { useHighlightStore } from '../../../store/highlightStore'
import { invoke } from '@tauri-apps/api/core'

const MIGRATION_JOB_PATCH_CAPABILITIES: PatchCapability[] = [
  { pathPattern: '/scriptText', ops: ['replace'], description: 'Replace MigrateQL script content' },
]

export class MigrationJobAdapter implements UIObject {
  type = 'migration_job'
  objectId: string
  title: string
  private jobId: number

  /** Injected by MigrationJobTab — reads current editor content */
  getScriptText: () => string = () => ''
  /** Injected by MigrationJobTab — writes to editor state */
  setScriptText: (value: string) => void = () => {}
  /** Injected by MigrationJobTab — triggers save to backend */
  triggerSave: () => Promise<void> = async () => {}

  constructor(tabId: string, jobId: number, title: string) {
    this.objectId = tabId
    this.jobId = jobId
    this.title = title
  }

  get patchCapabilities(): PatchCapability[] {
    return MIGRATION_JOB_PATCH_CAPABILITIES
  }

  read(mode: 'state' | 'schema' | 'actions' | 'full'): any {
    switch (mode) {
      case 'state': {
        const store = useMigrationStore.getState()
        const node = store.nodes.get(`job_${this.jobId}`)
        const status = node?.nodeType === 'job' ? node.status : null
        return {
          scriptText: this.getScriptText(),
          jobId: this.jobId,
          name: this.title,
          status,
        }
      }
      case 'schema':
        return {
          type: 'object',
          properties: {
            scriptText: { type: 'string', description: 'MigrateQL script content' },
            jobId: { type: 'number', description: 'Migration job ID (read-only)' },
            name: { type: 'string', description: 'Job name (read-only)' },
            status: { type: 'string', description: 'Last run status (read-only)', enum: ['RUNNING', 'FINISHED', 'FAILED', 'STOPPED', 'PARTIAL_FAILED'] },
          },
          patchCapabilities: MIGRATION_JOB_PATCH_CAPABILITIES,
        }
      case 'actions':
        return [
          { name: 'run', description: 'Save and execute the migration job', paramsSchema: { type: 'object', properties: {} } },
          { name: 'stop', description: 'Stop a running migration job', paramsSchema: { type: 'object', properties: {} } },
          { name: 'format', description: 'Format MigrateQL script via LSP', paramsSchema: { type: 'object', properties: {} } },
          { name: 'save', description: 'Save script to database', paramsSchema: { type: 'object', properties: {} } },
          { name: 'focus', description: 'Switch to this tab', paramsSchema: { type: 'object', properties: {} } },
        ]
      case 'full':
        return {
          state: this.read('state'),
          schema: this.read('schema'),
          actions: this.read('actions'),
        }
    }
  }

  patch(ops: JsonPatchOp[], reason?: string): PatchResult {
    const autoMode = useAppStore.getState().autoMode
    if (autoMode) {
      return this.patchDirect(ops)
    }

    const confirmId = `patch_${this.objectId}_${Date.now()}`
    usePatchConfirmStore.getState().propose({
      confirmId,
      objectId: this.objectId,
      objectType: this.type,
      ops,
      reason,
      currentState: this.read('state'),
      createdAt: Date.now(),
      onConfirm: () => this.patchDirect(ops),
    })
    return { status: 'pending_confirm', confirm_id: confirmId, preview: ops }
  }

  patchDirect(ops: JsonPatchOp[]): PatchResult {
    const currentState = { scriptText: this.getScriptText() }
    try {
      const patched = applyPatch(currentState, ops)
      if (patched.scriptText !== currentState.scriptText) {
        this.setScriptText(patched.scriptText)
        useHighlightStore.getState().addHighlights(this.objectId, ['scriptText'])
      }
      return { status: 'applied' }
    } catch (e) {
      return { status: 'error', message: String(e) }
    }
  }

  async exec(action: string, _params?: any): Promise<ExecResult> {
    switch (action) {
      case 'run': {
        await this.triggerSave()
        await useMigrationStore.getState().runJob(this.jobId)
        return { success: true }
      }

      case 'stop':
        await invoke('stop_migration_job', { jobId: this.jobId })
        return { success: true }

      case 'format': {
        const result = await invoke<string | null>('lsp_request', {
          method: 'textDocument/formatting',
          params: { text: this.getScriptText() },
        })
        if (result) {
          this.setScriptText(result)
          await invoke('update_migration_job_script', { id: this.jobId, scriptText: result })
        }
        return { success: true }
      }

      case 'save':
        await this.triggerSave()
        return { success: true }

      case 'focus':
        useQueryStore.getState().setActiveTabId(this.objectId)
        return { success: true }

      default:
        return execError(`Unknown action: ${action}`, 'Available actions: run, stop, format, save, focus')
    }
  }
}
