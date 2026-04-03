import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
import { patchError, execError } from '../errors'
import { applyPatch } from '../jsonPatch'
import { useTableFormStore, type TableFormState } from '../../../store/tableFormStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { useConnectionStore } from '../../../store/connectionStore'
import { useHighlightStore } from '../../../store/highlightStore'

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
// Shared logic for both TableFormAdapter and TableStructureView.
// Supports CREATE TABLE (new) and ALTER TABLE (existing) generation.

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

type Column = TableFormState['columns'][0]

function colDef(c: Column, isPg: boolean): string {
  const typ = c.length ? `${c.dataType}(${c.length})` : c.dataType
  const nullable = (c.isNullable ?? true) ? 'NULL' : 'NOT NULL'
  const def = c.defaultValue ? `DEFAULT ${c.defaultValue}` : ''
  const extra = (!isPg && c.extra) ? c.extra.toUpperCase() : ''
  const comment = (!isPg && c.comment) ? `COMMENT '${esc(c.comment)}'` : ''
  return [q(c.name, isPg), typ, nullable, def, extra, comment].filter(Boolean).join(' ')
}

function generateCreateSql(state: TableFormState, isPg: boolean): string {
  const activeCols = state.columns.filter(c => !c._isDeleted)
  const pkCols = activeCols.filter(c => c.isPrimaryKey).map(c => q(c.name, isPg))
  const lines = activeCols.map(c => `  ${colDef(c, isPg)}`)
  if (pkCols.length) lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`)

  const stmts = [`CREATE TABLE ${q(state.tableName, isPg)} (\n${lines.join(',\n')}\n);`]
  if (isPg) {
    for (const c of activeCols) {
      if (c.comment) {
        stmts.push(`COMMENT ON COLUMN ${q(state.tableName, true)}.${q(c.name, true)} IS '${esc(c.comment)}';`)
      }
    }
  }
  return stmts.join('\n')
}

function generateAlterSql(state: TableFormState, original: Column[], isPg: boolean): string {
  const tbl = q(state.tableName, isPg)
  const statements: string[] = []
  const edited = state.columns

  const existingEdited = edited.filter(c => !c._isNew && !c._isDeleted)
  const orderChanged = !isPg && existingEdited.some((c, i) => {
    if (i === 0) return false
    const prevOrigIdx = original.findIndex(o => o.name === (existingEdited[i - 1]._originalName ?? existingEdited[i - 1].name))
    const currOrigIdx = original.findIndex(o => o.name === (c._originalName ?? c.name))
    return prevOrigIdx > currOrigIdx
  })

  for (const col of edited) {
    if (col._isDeleted && !col._isNew) {
      statements.push(`ALTER TABLE ${tbl} DROP COLUMN ${q(col._originalName ?? col.name, isPg)};`)
    } else if (col._isNew && !col._isDeleted) {
      statements.push(`ALTER TABLE ${tbl} ADD COLUMN ${colDef(col, isPg)};`)
    } else if (!col._isNew && !col._isDeleted) {
      const orig = original.find(o => o.name === (col._originalName ?? col.name))
      if (!orig) continue
      const changed = orig.name !== col.name
        || orig.dataType !== col.dataType
        || orig.length !== col.length
        || orig.isNullable !== col.isNullable
        || orig.defaultValue !== col.defaultValue
        || orig.extra !== col.extra
        || orig.comment !== col.comment
        || (orderChanged && !isPg)
      if (changed) {
        if (isPg) {
          if (orig.dataType !== col.dataType || orig.length !== col.length) {
            const type = col.length ? `${col.dataType}(${col.length})` : col.dataType
            statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name, isPg)} TYPE ${type};`)
          }
          if (orig.isNullable !== col.isNullable) {
            statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name, isPg)} ${col.isNullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`)
          }
          if (orig.defaultValue !== col.defaultValue) {
            statements.push(col.defaultValue
              ? `ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name, isPg)} SET DEFAULT ${col.defaultValue};`
              : `ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name, isPg)} DROP DEFAULT;`)
          }
          if (orig.comment !== col.comment) {
            statements.push(col.comment
              ? `COMMENT ON COLUMN ${tbl}.${q(col.name, isPg)} IS '${esc(col.comment)}';`
              : `COMMENT ON COLUMN ${tbl}.${q(col.name, isPg)} IS NULL;`)
          }
        } else {
          const activeEdited = edited.filter(c => !c._isDeleted)
          const idx = activeEdited.indexOf(col)
          const after = idx <= 0 ? 'FIRST' : `AFTER ${q(activeEdited[idx - 1].name, isPg)}`
          statements.push(`ALTER TABLE ${tbl} MODIFY COLUMN ${colDef(col, isPg)} ${after};`)
        }
      }
    }
  }

  const origPks = original.filter(c => c.isPrimaryKey).map(c => q(c.name, isPg))
  const newPks = edited.filter(c => c.isPrimaryKey && !c._isDeleted).map(c => q(c.name, isPg))
  const pkChanged = JSON.stringify([...origPks].sort()) !== JSON.stringify([...newPks].sort())
  if (pkChanged) {
    if (isPg) {
      statements.push(`ALTER TABLE ${tbl} DROP CONSTRAINT IF EXISTS "${state.tableName}_pkey";`)
    } else {
      statements.push(`ALTER TABLE ${tbl} DROP PRIMARY KEY;`)
    }
    if (newPks.length > 0) statements.push(`ALTER TABLE ${tbl} ADD PRIMARY KEY (${newPks.join(', ')});`)
  }

  return statements.length > 0 ? statements.join('\n') : '-- No changes'
}

/**
 * Generate SQL for a table form state.
 * - isNewTable=true (or no originalColumns): CREATE TABLE
 * - isNewTable=false with originalColumns: ALTER TABLE (diff-based)
 */
export function generateTableSql(state: TableFormState, driver: string): string {
  validateIdent(state.tableName, 'table name')
  for (const c of state.columns) {
    if (!c._isDeleted) validateIdent(c.name, 'column name')
  }

  const isPg = driver === 'postgres' || driver === 'postgresql'
  const isNew = state.isNewTable !== false || !state.originalColumns?.length
  return isNew ? generateCreateSql(state, isPg) : generateAlterSql(state, state.originalColumns!, isPg)
}

const TABLE_FORM_PATCH_CAPABILITIES: PatchCapability[] = [
  { pathPattern: '/tableName', ops: ['replace'], description: 'Rename the table' },
  { pathPattern: '/engine', ops: ['replace'], description: 'Change storage engine' },
  { pathPattern: '/charset', ops: ['replace'], description: 'Change charset' },
  { pathPattern: '/comment', ops: ['replace'], description: 'Change table comment' },
  {
    pathPattern: '/columns[name=<s>]/<field>',
    ops: ['replace', 'remove'],
    description: 'Modify or remove a column by name',
    addressableBy: ['name'],
  },
  {
    pathPattern: '/columns/-',
    ops: ['add'],
    description: 'Append a new column',
  },
  {
    pathPattern: '/indexes[name=<s>]/<field>',
    ops: ['replace', 'remove'],
    description: 'Modify or remove an index by name',
    addressableBy: ['name'],
  },
  {
    pathPattern: '/indexes/-',
    ops: ['add'],
    description: 'Append a new index',
  },
]

export class TableFormUIObject implements UIObject {
  type = 'table_form'
  objectId: string
  title: string
  connectionId: number
  database: string

  constructor(tabId: string, connectionId: number, database: string) {
    this.objectId = tabId
    this.connectionId = connectionId
    this.database = database
    this.title = useTableFormStore.getState().getForm(tabId)?.tableName || 'New Table'
  }

  get patchCapabilities(): PatchCapability[] {
    return TABLE_FORM_PATCH_CAPABILITIES
  }

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state':
        return useTableFormStore.getState().getForm(this.objectId) ?? {}
      case 'schema':
        return { ...TABLE_FORM_SCHEMA, patchCapabilities: TABLE_FORM_PATCH_CAPABILITIES }
      case 'actions':
        return [
          {
            name: 'preview_sql',
            description: 'Preview CREATE/ALTER TABLE SQL based on current form state',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'save',
            description: 'Generate SQL and write to query tab for review',
            paramsSchema: { type: 'object', properties: {} },
          },
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

  private extractChangedPaths(ops: JsonPatchOp[], patched: TableFormState): string[] {
    const paths: string[] = []
    for (const op of ops) {
      const segments = op.path.replace(/^\//, '').split('/')
      const topKey = segments[0]

      if (topKey === 'columns' && segments.length >= 2) {
        // Column field change → merge to row level by column name
        const addressable = segments[1]
        const nameMatch = addressable.match(/^\[name=(.+)\]$/)
        if (nameMatch) {
          // /columns/[name=id]/dataType → "columns.id"
          paths.push(`columns.${nameMatch[1]}`)
        } else if (/^\d+$/.test(addressable)) {
          // /columns/3/comment → resolve index to column name
          const col = patched.columns[Number(addressable)]
          if (col) paths.push(`columns.${col.name}`)
        } else if (addressable === '-') {
          // /columns/- (append) → last column in patched array
          const last = patched.columns[patched.columns.length - 1]
          if (last) paths.push(`columns.${last.name}`)
        }
      } else if (topKey === 'indexes' && segments.length >= 2) {
        // Index change → merge to index level by name
        const addressable = segments[1]
        const nameMatch = addressable.match(/^\[name=(.+)\]$/)
        if (nameMatch) {
          paths.push(`indexes.${nameMatch[1]}`)
        } else if (/^\d+$/.test(addressable)) {
          const idx = patched.indexes?.[Number(addressable)]
          if (idx?.name) paths.push(`indexes.${idx.name}`)
        }
      } else {
        // Top-level field: /tableName, /engine, /charset, /comment
        paths.push(topKey)
      }
    }
    return [...new Set(paths)]
  }

  patchDirect(ops: JsonPatchOp[]): PatchResult {
    const current = useTableFormStore.getState().getForm(this.objectId)
    if (!current) return patchError(`No form state for ${this.objectId}`)
    try {
      const patched = applyPatch(current, ops)
      // Ensure all columns have id (for React key) and _isNew for new columns
      for (const col of patched.columns) {
        if (!col.id) {
          col.id = Math.random().toString(36).slice(2)
          col._isNew = true
        }
      }
      useTableFormStore.getState().setForm(this.objectId, patched)
      // Extract changed paths and trigger highlights
      const paths = this.extractChangedPaths(ops, patched)
      if (paths.length > 0) {
        useHighlightStore.getState().addHighlights(this.objectId, paths)
      }
      return { status: 'applied' }
    } catch (e) {
      return patchError(String(e))
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
    if (!state) return execError('No form state', `Table form ${this.objectId} not initialized`)

    switch (action) {
      case 'preview_sql': {
        try {
          const sql = generateTableSql(state, this.getDriver())
          return { success: true, data: { sql } }
        } catch (e) {
          return execError(String(e))
        }
      }
      case 'save': {
        const previewResult = await this.exec('preview_sql')
        if (!previewResult.success) return previewResult
        return { success: true, data: { sql: previewResult.data.sql, message: 'SQL generated. Open query tab to execute.' } }
      }
      default:
        return execError(`Unknown action: ${action}`, 'Available actions: preview_sql, save')
    }
  }
}
