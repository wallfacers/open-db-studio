import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { applyPatch } from '../jsonPatch'
import { useTableFormStore, type TableFormState } from '../../../store/tableFormStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { useConnectionStore } from '../../../store/connectionStore'

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

// ── Frontend SQL generation (eliminates nested IPC for preview_sql) ──────
// Mirrors Rust generate_create_table_sql in src-tauri/src/mcp/tools/table_edit.rs

/** Reason prefix used by init_table_form to bypass patch confirmation */
export const INIT_TABLE_FORM_REASON_PREFIX = 'init_table_form:'

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function validateIdent(name: string, label: string): void {
  if (!name || !IDENT_RE.test(name)) throw new Error(`Invalid ${label}: ${name}`)
}

function esc(s: string): string { return s.replace(/'/g, "''") }
function q(name: string, isPg: boolean): string {
  return isPg ? `"${name}"` : `\`${name}\``
}

function colDef(c: TableFormState['columns'][0], isPg: boolean): string {
  const typ = c.length ? `${c.dataType}(${c.length})` : c.dataType
  const nullable = (c.isNullable ?? true) ? 'NULL' : 'NOT NULL'
  const def = c.defaultValue ? `DEFAULT ${c.defaultValue}` : ''
  const extra = (!isPg && c.extra) ? c.extra.toUpperCase() : ''
  const comment = (!isPg && c.comment) ? `COMMENT '${esc(c.comment)}'` : ''
  return [q(c.name, isPg), typ, nullable, def, extra, comment].filter(Boolean).join(' ')
}

function generateCreateTableSql(state: TableFormState, driver: string): string {
  validateIdent(state.tableName, 'table name')
  for (const c of state.columns) validateIdent(c.name, 'column name')

  const isPg = driver === 'postgres'
  const pkCols = state.columns
    .filter(c => c.isPrimaryKey)
    .map(c => q(c.name, isPg))
  const lines = state.columns.map(c => `  ${colDef(c, isPg)}`)
  if (pkCols.length) lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`)

  const stmts = [`CREATE TABLE ${q(state.tableName, isPg)} (\n${lines.join(',\n')}\n)`]
  if (isPg) {
    for (const c of state.columns) {
      if (c.comment) {
        stmts.push(`COMMENT ON COLUMN ${q(state.tableName, true)}.${q(c.name, true)} IS '${esc(c.comment)}'`)
      }
    }
  }
  return stmts.join(';\n')
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
    if (autoMode || reason?.startsWith(INIT_TABLE_FORM_REASON_PREFIX)) {
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

  private getDriver(): string {
    const { metaCache, connections } = useConnectionStore.getState()
    const cached = metaCache[this.connectionId]?.driver
    if (cached) return cached
    // Fallback: look up driver from the connection list
    const conn = connections.find(c => c.id === this.connectionId)
    return conn?.driver ?? 'mysql'
  }

  async exec(action: string, _params?: any): Promise<ExecResult> {
    const state = useTableFormStore.getState().getForm(this.objectId)
    if (!state) return { success: false, error: 'No form state' }

    switch (action) {
      case 'preview_sql': {
        try {
          const sql = generateCreateTableSql(state, this.getDriver())
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
