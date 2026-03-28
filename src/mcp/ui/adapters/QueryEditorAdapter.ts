import { emit } from '@tauri-apps/api/event'
import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { applyPatch } from '../jsonPatch'
import { useQueryStore } from '../../../store/queryStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'

export class QueryEditorAdapter implements UIObject {
  type = 'query_editor'
  objectId: string
  title: string
  connectionId?: number

  constructor(tabId: string, connectionId?: number, title?: string) {
    this.objectId = tabId
    this.connectionId = connectionId
    this.title = title ?? 'Query'
  }

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state': {
        const { tabs, sqlContent } = useQueryStore.getState()
        const tab = tabs.find(t => t.id === this.objectId)
        if (!tab) return {}
        const content = sqlContent[this.objectId] ?? ''
        return {
          content,
          connectionId: tab.connectionId ?? null,
          database: tab.db ?? null,
        }
      }
      case 'schema':
        return {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'SQL content' },
            connectionId: { type: 'number' },
            database: { type: 'string' },
          },
        }
      case 'actions':
        return [
          { name: 'run_sql', description: 'Execute the SQL in this tab' },
          { name: 'format', description: 'Format/beautify the SQL' },
          { name: 'undo', description: 'Undo last change' },
          { name: 'focus', description: 'Switch to this tab' },
        ]
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
      onConfirm: () => this.patchDirect(ops),
    })
    return { status: 'pending_confirm', confirm_id: confirmId, preview: ops }
  }

  patchDirect(ops: JsonPatchOp[]): PatchResult {
    const { sqlContent, setSql } = useQueryStore.getState()
    const currentState = {
      content: sqlContent[this.objectId] ?? '',
    }
    try {
      const patched = applyPatch(currentState, ops)
      setSql(this.objectId, patched.content)
      return { status: 'applied' }
    } catch (e) {
      return { status: 'error', message: String(e) }
    }
  }

  async exec(action: string, _params?: any): Promise<ExecResult> {
    switch (action) {
      case 'run_sql':
        await emit('run-sql-request', { tab_id: this.objectId })
        return { success: true }

      case 'format':
        await emit('format-sql-request', { tab_id: this.objectId })
        return { success: true }

      case 'undo':
        await emit('undo-request', { tab_id: this.objectId })
        return { success: true }

      case 'focus':
        useQueryStore.getState().setActiveTabId(this.objectId)
        return { success: true }

      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }
}
