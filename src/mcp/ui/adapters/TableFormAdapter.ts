import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { applyPatch } from '../jsonPatch'
import { useTableFormStore } from '../../../store/tableFormStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { invoke } from '@tauri-apps/api/core'

const TABLE_FORM_SCHEMA = {
  type: 'object',
  properties: {
    tableName: { type: 'string', description: 'Table name' },
    engine: { type: 'string', enum: ['InnoDB', 'MyISAM', 'MEMORY'], default: 'InnoDB' },
    charset: { type: 'string', default: 'utf8mb4' },
    comment: { type: 'string' },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          dataType: { type: 'string' },
          length: { type: ['string', 'null'] },
          isNullable: { type: 'boolean', default: true },
          defaultValue: { type: ['string', 'null'] },
          isPrimaryKey: { type: 'boolean', default: false },
          extra: { type: 'string' },
          comment: { type: 'string' },
        },
        required: ['name', 'dataType'],
        'x-addressable-by': 'name',
      },
    },
    indexes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' } },
          unique: { type: 'boolean', default: false },
        },
        'x-addressable-by': 'name',
      },
    },
  },
}

export class TableFormUIObject implements UIObject {
  type = 'table_form'
  objectId: string
  title: string
  connectionId: number
  private database: string

  constructor(tabId: string, connectionId: number, database: string) {
    this.objectId = tabId
    this.connectionId = connectionId
    this.database = database
    this.title = useTableFormStore.getState().getForm(tabId)?.tableName || 'New Table'
  }

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state':
        return useTableFormStore.getState().getForm(this.objectId) ?? {}
      case 'schema':
        return TABLE_FORM_SCHEMA
      case 'actions':
        return [
          { name: 'preview_sql', description: 'Preview CREATE/ALTER TABLE SQL' },
          { name: 'save', description: 'Generate SQL and write to query tab for review' },
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
    const current = useTableFormStore.getState().getForm(this.objectId)
    if (!current) return { status: 'error', message: `No form state for ${this.objectId}` }
    try {
      const patched = applyPatch(current, ops)
      useTableFormStore.getState().setForm(this.objectId, patched)
      return { status: 'applied' }
    } catch (e) {
      return { status: 'error', message: String(e) }
    }
  }

  async exec(action: string, _params?: any): Promise<ExecResult> {
    const state = useTableFormStore.getState().getForm(this.objectId)
    if (!state) return { success: false, error: 'No form state' }

    switch (action) {
      case 'preview_sql': {
        try {
          const sql = await invoke<string>('cmd_generate_create_table_sql', {
            params: {
              connection_id: this.connectionId,
              table_name: state.tableName,
              database: this.database,
              columns: state.columns.map(c => ({
                name: c.name, data_type: c.dataType, length: c.length,
                is_nullable: c.isNullable ?? true, default_value: c.defaultValue,
                is_primary_key: c.isPrimaryKey ?? false, extra: c.extra ?? '', comment: c.comment ?? '',
              })),
            },
          })
          return { success: true, data: { sql } }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
      case 'save': {
        const previewResult = await this.exec('preview_sql')
        if (!previewResult.success) return previewResult
        return { success: true, data: { sql: previewResult.data.sql, message: 'SQL generated. Open query tab to execute.' } }
      }
      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }
}
