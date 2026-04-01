import { emit } from '@tauri-apps/api/event'
import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { applyPatch } from '../jsonPatch'
import { useQueryStore } from '../../../store/queryStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { useHighlightStore } from '../../../store/highlightStore'

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
        const ctx = tab.queryContext ?? { connectionId: null, database: null, schema: null }
        return {
          content,
          connectionId: ctx.connectionId,
          database: ctx.database,
          schema: ctx.schema,
        }
      }
      case 'schema':
        return {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'SQL content' },
            connectionId: { type: 'number', description: 'Connection ID for query execution' },
            database: { type: 'string', description: 'Target database name' },
            schema: { type: 'string', description: 'Target schema name (PostgreSQL/Oracle)' },
          },
        }
      case 'actions':
        return [
          { name: 'run_sql', description: 'Execute the SQL in this tab' },
          { name: 'format', description: 'Format/beautify the SQL' },
          { name: 'undo', description: 'Undo last change' },
          { name: 'focus', description: 'Switch to this tab' },
          { name: 'set_context', description: 'Set connection/database/schema context. Params: { connectionId?: number, database?: string, schema?: string }' },
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
      createdAt: Date.now(),
      onConfirm: () => this.patchDirect(ops),
    })
    return { status: 'pending_confirm', confirm_id: confirmId, preview: ops }
  }

  patchDirect(ops: JsonPatchOp[]): PatchResult {
    const store = useQueryStore.getState()
    const tab = store.tabs.find(t => t.id === this.objectId)
    const ctx = tab?.queryContext ?? { connectionId: null, database: null, schema: null }
    const currentState = {
      content: store.sqlContent[this.objectId] ?? '',
      connectionId: ctx.connectionId,
      database: ctx.database,
      schema: ctx.schema,
    }
    try {
      const patched = applyPatch(currentState, ops)

      // Apply SQL content change
      if (patched.content !== currentState.content) {
        store.setSql(this.objectId, patched.content)
      }

      // Apply queryContext changes
      const ctxUpdate: Partial<{ connectionId: number | null; database: string | null; schema: string | null }> = {}
      if (patched.connectionId !== currentState.connectionId) ctxUpdate.connectionId = patched.connectionId
      if (patched.database !== currentState.database) ctxUpdate.database = patched.database
      if (patched.schema !== currentState.schema) ctxUpdate.schema = patched.schema
      if (Object.keys(ctxUpdate).length > 0) {
        store.updateTabContext(this.objectId, ctxUpdate)
      }

      // Extract changed paths and trigger highlights
      const paths: string[] = []
      if (patched.content !== currentState.content) paths.push('content')
      if (patched.connectionId !== currentState.connectionId) paths.push('connectionId')
      if (patched.database !== currentState.database) paths.push('database')
      if (patched.schema !== currentState.schema) paths.push('schema')
      if (paths.length > 0) {
        useHighlightStore.getState().addHighlights(this.objectId, paths)
      }

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

      case 'set_context': {
        const { connectionId, database, schema } = _params ?? {}
        const ctx: Partial<{ connectionId: number | null; database: string | null; schema: string | null }> = {}
        if (connectionId !== undefined) ctx.connectionId = connectionId
        if (database !== undefined) ctx.database = database
        if (schema !== undefined) ctx.schema = schema
        if (Object.keys(ctx).length === 0) {
          return { success: false, error: 'No context fields provided. Use connectionId, database, or schema.' }
        }
        useQueryStore.getState().updateTabContext(this.objectId, ctx)
        return { success: true }
      }

      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }
}
