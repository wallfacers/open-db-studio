import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { patchError, execError } from '../errors'
import { invoke } from '@tauri-apps/api/core'

export class HistoryAdapter implements UIObject {
  type = 'history'
  objectId = 'history'
  title = 'Change History'

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state':
        return { message: 'Use exec("list") to get change history' }
      case 'schema':
        return {
          type: 'object',
          properties: {
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  actionType: { type: 'string' },
                  tableName: { type: 'string' },
                  oldValue: { type: 'string' },
                  newValue: { type: 'string' },
                  createdAt: { type: 'string' },
                },
              },
            },
          },
        }
      case 'actions':
        return [
          {
            name: 'list',
            description: 'List change history entries',
            paramsSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Maximum entries to return (default: 50)' },
              },
            },
          },
          {
            name: 'undo',
            description: 'Undo last change',
            paramsSchema: { type: 'object', properties: {} },
          },
        ]
    }
  }

  patch(_ops: JsonPatchOp[]): PatchResult {
    return patchError('history does not support patch')
  }

  async exec(action: string, params?: any): Promise<ExecResult> {
    switch (action) {
      case 'list': {
        try {
          const limit = params?.limit ?? 50
          const entries = await invoke('get_change_history', { limit })
          return { success: true, data: entries }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      case 'undo': {
        try {
          const result = await invoke('undo_last_change')
          return { success: true, data: result }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      default:
        return execError(`Unknown action: ${action}`, 'Available actions: list, undo')
    }
  }
}
