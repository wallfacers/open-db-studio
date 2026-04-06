import type { UIObject, JsonPatchOp, PatchResult, ExecResult, PatchCapability } from '../types'
import { patchError, execError } from '../errors'
import { applyPatch } from '../jsonPatch'
import { useTableFormStore, type TableFormState, type TableFormIndex, type TableFormForeignKey } from '../../../store/tableFormStore'
import { useAppStore } from '../../../store/appStore'
import { usePatchConfirmStore } from '../../../store/patchConfirmStore'
import { useConnectionStore } from '../../../store/connectionStore'
import { useHighlightStore } from '../../../store/highlightStore'
import { makeId } from '../../../utils/makeId'
import { parseIndexColumns, stringifyIndexColumns } from '../../../utils/indexColumns'
import type { IndexColumnEntry } from '../../../utils/indexColumns'
import { resolveVarRefs, validateBatchVarRefs } from '../batchUtils'

const CASCADE_OPTS = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT'] as const
const INDEX_TYPES = ['INDEX', 'UNIQUE', 'FULLTEXT'] as const

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
          type: { type: 'string', enum: ['INDEX', 'UNIQUE', 'FULLTEXT'], default: 'INDEX' },
          columns: { type: 'string', description: 'JSON array: [{"name":"col","order":"ASC|DESC"}]' },
        },
        required: ['name'],
        'x-addressable-by': 'name',
      },
    },
    foreignKeys: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          constraintName: { type: 'string' },
          column: { type: 'string' },
          referencedTable: { type: 'string' },
          referencedColumn: { type: 'string' },
          onDelete: { type: 'string', enum: ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT'], default: 'NO ACTION' },
          onUpdate: { type: 'string', enum: ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT'], default: 'NO ACTION' },
        },
        required: ['constraintName', 'column', 'referencedTable', 'referencedColumn'],
        'x-addressable-by': 'constraintName',
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

// ── Index SQL helpers ─────────────────────────────────────────────────────

function generateIndexCreateSql(tableName: string, index: TableFormIndex, isPg: boolean): string {
  const cols = parseIndexColumns(index.columns)
  if (cols.length === 0) return ''
  const quotedCols = cols.map(c => {
    const quoted = q(c.name, isPg)
    return c.order === 'DESC' ? `${quoted} DESC` : quoted
  })
  // FULLTEXT is MySQL-only; not supported on PostgreSQL
  if (isPg && index.type === 'FULLTEXT') return ''
  const unique = index.type === 'UNIQUE' ? 'UNIQUE ' : ''
  const fulltext = (!isPg && index.type === 'FULLTEXT') ? 'FULLTEXT ' : ''
  const prefix = unique || fulltext
  return `CREATE ${prefix}INDEX ${q(index.name, isPg)} ON ${q(tableName, isPg)} (${quotedCols.join(', ')});`
}

function generateIndexDropSql(indexName: string, tableName: string, isPg: boolean): string {
  if (isPg) {
    return `DROP INDEX IF EXISTS ${q(indexName, isPg)};`
  }
  return `DROP INDEX ${q(indexName, isPg)} ON ${q(tableName, isPg)};`
}

// ── Foreign Key SQL helpers ──────────────────────────────────────────────

function generateFkConstraintLine(fk: TableFormForeignKey, isPg: boolean): string {
  return `  CONSTRAINT ${q(fk.constraintName, isPg)} FOREIGN KEY (${q(fk.column, isPg)}) REFERENCES ${q(fk.referencedTable, isPg)} (${q(fk.referencedColumn, isPg)}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`
}

function generateFkAddSql(tableName: string, fk: TableFormForeignKey, isPg: boolean): string {
  const tbl = q(tableName, isPg)
  return `ALTER TABLE ${tbl} ADD CONSTRAINT ${q(fk.constraintName, isPg)} FOREIGN KEY (${q(fk.column, isPg)}) REFERENCES ${q(fk.referencedTable, isPg)} (${q(fk.referencedColumn, isPg)}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate};`
}

function generateFkDropSql(tableName: string, constraintName: string, isPg: boolean): string {
  const tbl = q(tableName, isPg)
  if (isPg) return `ALTER TABLE ${tbl} DROP CONSTRAINT ${q(constraintName, isPg)};`
  return `ALTER TABLE ${tbl} DROP FOREIGN KEY ${q(constraintName, isPg)};`
}

function isFkComplete(fk: TableFormForeignKey): boolean {
  return !!(fk.constraintName && fk.column && fk.referencedTable && fk.referencedColumn)
}

function generateCreateSql(state: TableFormState, isPg: boolean): string {
  const activeCols = state.columns.filter(c => !c._isDeleted)
  const pkCols = activeCols.filter(c => c.isPrimaryKey).map(c => q(c.name, isPg))
  const lines = activeCols.map(c => `  ${colDef(c, isPg)}`)
  if (pkCols.length) lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`)

  const activeFks = (state.foreignKeys ?? []).filter(fk => !fk._isDeleted && isFkComplete(fk))
  for (const fk of activeFks) {
    lines.push(generateFkConstraintLine(fk, isPg))
  }

  const stmts = [`CREATE TABLE ${q(state.tableName, isPg)} (\n${lines.join(',\n')}\n);`]
  if (isPg) {
    for (const c of activeCols) {
      if (c.comment) {
        stmts.push(`COMMENT ON COLUMN ${q(state.tableName, true)}.${q(c.name, true)} IS '${esc(c.comment)}';`)
      }
    }
  }
  const activeIndexes = (state.indexes ?? []).filter(i => !i._isDeleted)
  for (const idx of activeIndexes) {
    const idxSql = generateIndexCreateSql(state.tableName, idx, isPg)
    if (idxSql) stmts.push(idxSql)
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

  // ── Index diff ──
  const originalIndexes = state.originalIndexes ?? []
  const editedIndexes = state.indexes ?? []

  // Dropped indexes
  for (const idx of editedIndexes) {
    if (idx._isDeleted && !idx._isNew) {
      statements.push(generateIndexDropSql(idx._originalName ?? idx.name, state.tableName, isPg))
    }
  }

  // New indexes
  for (const idx of editedIndexes) {
    if (idx._isNew && !idx._isDeleted) {
      const sql = generateIndexCreateSql(state.tableName, idx, isPg)
      if (sql) statements.push(sql)
    }
  }

  // Modified indexes (name, type, or columns changed): DROP old + CREATE new
  for (const idx of editedIndexes) {
    if (!idx._isNew && !idx._isDeleted && idx._originalName) {
      const orig = originalIndexes.find(o => (o._originalName ?? o.name) === idx._originalName)
      if (orig && (orig.name !== idx.name || orig.type !== idx.type || orig.columns !== idx.columns)) {
        statements.push(generateIndexDropSql(idx._originalName, state.tableName, isPg))
        const sql = generateIndexCreateSql(state.tableName, idx, isPg)
        if (sql) statements.push(sql)
      }
    }
  }

  // ── Foreign Key diff ──
  const origFks = state.originalForeignKeys ?? []
  const editedFks = state.foreignKeys ?? []

  for (const fk of editedFks) {
    if (fk._isDeleted && !fk._isNew) {
      statements.push(generateFkDropSql(state.tableName, fk._originalName ?? fk.constraintName, isPg))
    } else if (fk._isNew && !fk._isDeleted) {
      if (isFkComplete(fk)) statements.push(generateFkAddSql(state.tableName, fk, isPg))
    } else if (!fk._isNew && !fk._isDeleted) {
      const orig = origFks.find(o => (o._originalName ?? o.constraintName) === (fk._originalName ?? fk.constraintName))
      if (orig && (
        orig.constraintName !== fk.constraintName ||
        orig.column !== fk.column ||
        orig.referencedTable !== fk.referencedTable ||
        orig.referencedColumn !== fk.referencedColumn ||
        orig.onDelete !== fk.onDelete ||
        orig.onUpdate !== fk.onUpdate
      )) {
        statements.push(generateFkDropSql(state.tableName, orig._originalName ?? orig.constraintName, isPg))
        if (isFkComplete(fk)) statements.push(generateFkAddSql(state.tableName, fk, isPg))
      }
    }
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
    description: 'Append a new column (upsert: if a column with the same name exists, its properties are updated instead of creating a duplicate)',
  },
  {
    pathPattern: '/columns[name=<s>]',
    ops: ['remove'],
    description: 'Remove a column by name',
    addressableBy: ['name'],
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
  {
    pathPattern: '/indexes[name=<s>]',
    ops: ['remove'],
    description: 'Remove an index by name',
    addressableBy: ['name'],
  },
  {
    pathPattern: '/foreignKeys/-',
    ops: ['add'],
    description: 'Add a new FK constraint',
  },
  {
    pathPattern: '/foreignKeys[name=<s>]',
    ops: ['remove'],
    description: 'Remove an FK by constraintName',
    addressableBy: ['constraintName'],
  },
  {
    pathPattern: '/foreignKeys[name=<s>]/<field>',
    ops: ['replace'],
    description: 'Modify FK properties',
    addressableBy: ['constraintName'],
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
      case 'actions': {
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
          {
            name: 'add_foreign_key',
            description: 'Add a foreign key constraint. constraintName is auto-generated as fk_{tableName}_{column} if omitted.',
            paramsSchema: {
              type: 'object',
              properties: {
                column: { type: 'string', description: 'Column in this table (required)' },
                referencedTable: { type: 'string', description: 'Referenced table name (required)' },
                referencedColumn: { type: 'string', description: 'Referenced column name (required)' },
                constraintName: { type: 'string', description: 'Constraint name (auto-generated if omitted)' },
                onDelete: { type: 'string', enum: CASCADE_OPTS, default: 'NO ACTION' },
                onUpdate: { type: 'string', enum: CASCADE_OPTS, default: 'NO ACTION' },
              },
              required: ['column', 'referencedTable', 'referencedColumn'],
            },
          },
          {
            name: 'update_foreign_key',
            description: 'Update properties of an existing foreign key (located by constraintName).',
            paramsSchema: {
              type: 'object',
              properties: {
                constraintName: { type: 'string', description: 'Constraint name to locate the FK (required)' },
                column: { type: 'string' },
                referencedTable: { type: 'string' },
                referencedColumn: { type: 'string' },
                onDelete: { type: 'string', enum: CASCADE_OPTS },
                onUpdate: { type: 'string', enum: CASCADE_OPTS },
              },
              required: ['constraintName'],
            },
          },
          {
            name: 'remove_foreign_key',
            description: 'Remove a foreign key constraint. Soft-deletes for existing tables; physically removes for new tables.',
            paramsSchema: {
              type: 'object',
              properties: {
                constraintName: { type: 'string', description: 'Constraint name to remove (required)' },
              },
              required: ['constraintName'],
            },
          },
          {
            name: 'add_index',
            description: 'Add an index. name is auto-generated as idx_{columns} if omitted.',
            paramsSchema: {
              type: 'object',
              properties: {
                columns: { type: 'array', items: { type: 'string' }, description: 'Column names for the index (required)' },
                name: { type: 'string', description: 'Index name (auto-generated if omitted)' },
                type: { type: 'string', enum: INDEX_TYPES, default: 'INDEX' },
              },
              required: ['columns'],
            },
          },
          {
            name: 'update_index',
            description: 'Update properties of an existing index (located by name).',
            paramsSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Index name to locate (required)' },
                columns: { type: 'array', items: { type: 'string' }, description: 'New column names' },
                type: { type: 'string', enum: INDEX_TYPES },
              },
              required: ['name'],
            },
          },
          {
            name: 'remove_index',
            description: 'Remove an index. Soft-deletes for existing tables; physically removes for new tables.',
            paramsSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Index name to remove (required)' },
              },
              required: ['name'],
            },
          },
          {
            name: 'batch_create_table',
            description:
              'Create a complete table with all columns, indexes, and foreign keys in one call. ' +
              'Much faster than calling ui_patch + add_index × N + add_foreign_key × N separately. ' +
              'Returns { tableName, columnCount, indexCount, fkCount, previewSql }.',
            paramsSchema: {
              type: 'object',
              properties: {
                tableName: { type: 'string', description: 'Table name (required)' },
                columns: {
                  type: 'array',
                  description: 'Column definitions (ordered)',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      dataType: { type: 'string' },
                      length: { type: 'string' },
                      isNullable: { type: 'boolean', default: true },
                      defaultValue: { type: 'string' },
                      isPrimaryKey: { type: 'boolean', default: false },
                      extra: { type: 'string', description: 'e.g. "auto_increment"' },
                      comment: { type: 'string' },
                    },
                    required: ['name', 'dataType'],
                  },
                },
                indexes: {
                  type: 'array',
                  description: 'Index definitions (optional)',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'Auto-generated as idx_{columns} if omitted' },
                      columns: { type: 'array', items: { type: 'string' } },
                      type: { type: 'string', enum: ['INDEX', 'UNIQUE', 'FULLTEXT'], default: 'INDEX' },
                    },
                    required: ['columns'],
                  },
                },
                foreignKeys: {
                  type: 'array',
                  description: 'Foreign key definitions (optional)',
                  items: {
                    type: 'object',
                    properties: {
                      column: { type: 'string' },
                      referencedTable: { type: 'string' },
                      referencedColumn: { type: 'string' },
                      constraintName: { type: 'string', description: 'Auto-generated if omitted' },
                      onDelete: { type: 'string', enum: CASCADE_OPTS, default: 'NO ACTION' },
                      onUpdate: { type: 'string', enum: CASCADE_OPTS, default: 'NO ACTION' },
                    },
                    required: ['column', 'referencedTable', 'referencedColumn'],
                  },
                },
                engine: { type: 'string', default: 'InnoDB' },
                charset: { type: 'string', default: 'utf8mb4' },
                comment: { type: 'string' },
              },
              required: ['tableName', 'columns'],
            },
          },
          {
            name: 'batch',
            description:
              'Execute a sequence of actions in one call with variable binding. ' +
              'Each op is { action, params }; results are stored and can be referenced by later ops ' +
              'via "$N.path" syntax (e.g. "$0.name", "$1.constraintName"). ' +
              'Stops on first failure. Returns { results: [...] }. ' +
              'Set dryRun=true to validate without executing.',
            paramsSchema: {
              type: 'object',
              properties: {
                ops: {
                  type: 'array',
                  description: 'Ordered operations. Each op reuses any existing action (add_index, add_foreign_key, etc.)',
                  items: {
                    type: 'object',
                    properties: {
                      action: { type: 'string', description: 'Action name' },
                      params: { type: 'object', description: 'Action params. "$N.path" references previous op results.' },
                    },
                    required: ['action'],
                  },
                },
                dryRun: { type: 'boolean', default: false, description: 'Validate all ops without executing' },
                returnState: { type: 'boolean', default: false, description: 'Include current form state in response' },
              },
              required: ['ops'],
            },
          },
        ]
      }
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
          // /columns/- (append) → resolve from op.value.name if available, else fallback to last
          if (op.op === 'add' && op.value?.name) {
            paths.push(`columns.${op.value.name}`)
          } else {
            const last = patched.columns[patched.columns.length - 1]
            if (last) paths.push(`columns.${last.name}`)
          }
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
      } else if (topKey === 'foreignKeys' && segments.length >= 2) {
        // FK change → merge to FK level by constraintName
        const addressable = segments[1]
        const nameMatch = addressable.match(/^\[name=(.+)\]$/)
        if (nameMatch) {
          if (segments.length >= 3) {
            paths.push(`foreignKeys.${segments[2]}`)
          } else {
            paths.push('foreignKeys')
          }
        } else if (/^\d+$/.test(addressable)) {
          const fk = patched.foreignKeys?.[Number(addressable)]
          if (fk?.constraintName) paths.push(`foreignKeys.${fk.constraintName}`)
        }
        // /foreignKeys/- (array append) → no specific path pushed
      } else {
        // Top-level field: /tableName, /engine, /charset, /comment
        paths.push(topKey)
      }
    }
    return [...new Set(paths)]
  }

  /**
   * Normalize column ops before applying:
   * - Upsert: add /columns/- with existing name → replace existing column properties
   * - Remove by name: remove /columns[name=xxx] → soft-delete for existing, physical for new
   */
  private normalizeColumnOps(ops: JsonPatchOp[], current: TableFormState): JsonPatchOp[] {
    const normalized: JsonPatchOp[] = []
    const workingColumns = current.columns.map(c => ({ ...c }))

    for (const op of ops) {
      // Upsert: add /columns/- with a name that already exists
      if (op.op === 'add' && op.path === '/columns/-' && op.value?.name) {
        const existingIdx = workingColumns.findIndex(
          c => c.name === op.value.name && !c._isDeleted
        )
        if (existingIdx !== -1) {
          for (const [key, val] of Object.entries(op.value)) {
            if (['id', '_isNew', '_isDeleted', '_originalName'].includes(key)) continue
            normalized.push({ op: 'replace', path: `/columns/${existingIdx}/${key}`, value: val })
            ;(workingColumns[existingIdx] as any)[key] = val
          }
          continue
        }
        workingColumns.push({ ...op.value } as any)
      }

      // Remove column by name: soft-delete for existing columns, physical for new
      if (op.op === 'remove' && /^\/columns\[name=[^\]]+\]$/.test(op.path)) {
        const nameMatch = op.path.match(/\[name=([^\]]+)\]/)
        if (nameMatch) {
          const idx = workingColumns.findIndex(c => c.name === nameMatch[1] && !c._isDeleted)
          if (idx !== -1) {
            if (workingColumns[idx]._isNew) {
              normalized.push(op)
            } else {
              normalized.push({ op: 'add', path: `/columns/${idx}/_isDeleted`, value: true })
            }
            workingColumns[idx]._isDeleted = true
            continue
          }
        }
      }

      normalized.push(op)
    }
    return normalized
  }

  patchDirect(ops: JsonPatchOp[]): PatchResult {
    const current = useTableFormStore.getState().getForm(this.objectId)
    if (!current) return patchError(`No form state for ${this.objectId}`)
    try {
      const normalizedOps = this.normalizeColumnOps(ops, current)
      const patched = applyPatch(current, normalizedOps)
      // Ensure all columns have id (for React key) and _isNew for new columns
      for (const col of patched.columns) {
        if (!col.id) {
          col.id = makeId()
          col._isNew = true
        }
      }
      // Ensure all indexes have id and _isNew for new indexes
      for (const idx of patched.indexes ?? []) {
        if (!idx.id) {
          idx.id = makeId()
          idx._isNew = true
        }
      }
      // Ensure all foreignKeys have id and _isNew for new FKs
      for (const fk of patched.foreignKeys ?? []) {
        if (!fk.id) {
          fk.id = makeId()
          fk._isNew = true
        }
      }
      useTableFormStore.getState().setForm(this.objectId, patched)
      // Extract changed paths and trigger highlights (use both original + normalized for complete coverage)
      const paths = this.extractChangedPaths([...ops, ...normalizedOps], patched)
      if (paths.length > 0) {
        useHighlightStore.getState().addHighlights(this.objectId, paths)
      }
      return {
        status: 'applied',
        summary: {
          changedPaths: paths,
          columnCount: patched.columns.filter(c => !c._isDeleted).length,
          indexCount: (patched.indexes ?? []).filter(i => !i._isDeleted).length,
          fkCount: (patched.foreignKeys ?? []).filter(f => !f._isDeleted).length,
        },
      }
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

  /** Physically remove a _isNew item or soft-delete an existing one */
  private softDeleteOrRemove<T extends { _isNew?: boolean; _isDeleted?: boolean }>(arr: T[], idx: number): T[] {
    const item = arr[idx]
    return item._isNew
      ? arr.filter((_, i) => i !== idx)
      : arr.map((el, i) => i === idx ? { ...el, _isDeleted: true } : el)
  }

  async exec(action: string, params?: any): Promise<ExecResult> {
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

      case 'add_foreign_key': {
        const p = params ?? {}
        const { column, referencedTable, referencedColumn, onDelete = 'NO ACTION', onUpdate = 'NO ACTION' } = p
        if (!column || !referencedTable || !referencedColumn) {
          return execError('column, referencedTable, referencedColumn are required')
        }
        const constraintName = p.constraintName || `fk_${state.tableName}_${column}`
        const r = this.patchDirect([{
          op: 'add',
          path: '/foreignKeys/-',
          value: { constraintName, column, referencedTable, referencedColumn, onDelete, onUpdate },
        }])
        if (r.status === 'applied') return { success: true, data: { constraintName } }
        return execError('Failed to add foreign key')
      }

      case 'update_foreign_key': {
        const p = params ?? {}
        const { constraintName, ...updates } = p
        if (!constraintName) return execError('constraintName is required')
        const ALLOWED = ['column', 'referencedTable', 'referencedColumn', 'onDelete', 'onUpdate']
        const ops: JsonPatchOp[] = Object.entries(updates as Record<string, unknown>)
          .filter(([k]) => ALLOWED.includes(k))
          .map(([k, v]) => ({ op: 'replace' as const, path: `/foreignKeys[constraintName=${constraintName}]/${k}`, value: v }))
        if (ops.length === 0) return execError('No valid fields to update')
        const r = this.patchDirect(ops)
        if (r.status === 'applied') return { success: true, data: { updated: constraintName } }
        return execError('Failed to update foreign key')
      }

      case 'remove_foreign_key': {
        const { constraintName } = params ?? {}
        if (!constraintName) return execError('constraintName is required')
        const fresh = useTableFormStore.getState().getForm(this.objectId)
        if (!fresh) return execError('No form state')
        const fks = fresh.foreignKeys ?? []
        const idx = fks.findIndex(fk => fk.constraintName === constraintName && !fk._isDeleted)
        if (idx === -1) return execError(`Foreign key not found: ${constraintName}`)
        useTableFormStore.getState().setForm(this.objectId, { ...fresh, foreignKeys: this.softDeleteOrRemove(fks, idx) })
        useHighlightStore.getState().addHighlights(this.objectId, ['foreignKeys'])
        return { success: true, data: { removed: constraintName } }
      }

      case 'add_index': {
        const p = params ?? {}
        const { columns, type = 'INDEX', name } = p
        if (!columns || !Array.isArray(columns) || columns.length === 0) {
          return execError('columns array is required')
        }
        const indexName: string = name || `idx_${(columns as string[]).join('_')}`
        const columnsJson = stringifyIndexColumns((columns as string[]).map(c => ({ name: c, order: 'ASC' as const })))
        const r = this.patchDirect([{
          op: 'add',
          path: '/indexes/-',
          value: { name: indexName, type, columns: columnsJson },
        }])
        if (r.status === 'applied') return { success: true, data: { name: indexName } }
        return execError('Failed to add index')
      }

      case 'update_index': {
        const p = params ?? {}
        const { name, columns, type } = p
        if (!name) return execError('name is required')
        const ops: JsonPatchOp[] = []
        if (type !== undefined) {
          ops.push({ op: 'replace', path: `/indexes[name=${name}]/type`, value: type })
        }
        if (columns !== undefined) {
          if (!Array.isArray(columns)) return execError('columns must be an array of strings')
          const columnsJson = stringifyIndexColumns((columns as string[]).map(c => ({ name: c, order: 'ASC' as const })))
          ops.push({ op: 'replace', path: `/indexes[name=${name}]/columns`, value: columnsJson })
        }
        if (ops.length === 0) return execError('No valid fields to update')
        const r = this.patchDirect(ops)
        if (r.status === 'applied') return { success: true, data: { updated: name } }
        return execError('Failed to update index')
      }

      case 'remove_index': {
        const { name } = params ?? {}
        if (!name) return execError('name is required')
        const fresh = useTableFormStore.getState().getForm(this.objectId)
        if (!fresh) return execError('No form state')
        const indexes = fresh.indexes ?? []
        const idx = indexes.findIndex(i => i.name === name && !i._isDeleted)
        if (idx === -1) return execError(`Index not found: ${name}`)
        useTableFormStore.getState().setForm(this.objectId, { ...fresh, indexes: this.softDeleteOrRemove(indexes, idx) })
        useHighlightStore.getState().addHighlights(this.objectId, ['indexes'])
        return { success: true, data: { removed: name } }
      }

      case 'batch_create_table': {
        const p = params ?? {}
        const { tableName, columns, indexes, foreignKeys, engine, charset, comment } = p
        if (!tableName || !columns || !Array.isArray(columns) || columns.length === 0) {
          return execError('tableName and columns (non-empty array) are required')
        }

        // Step 1: Build patch ops for table metadata + all columns
        const ops: JsonPatchOp[] = [
          { op: 'replace', path: '/tableName', value: tableName },
        ]
        if (engine) ops.push({ op: 'replace', path: '/engine', value: engine })
        if (charset) ops.push({ op: 'replace', path: '/charset', value: charset })
        if (comment) ops.push({ op: 'replace', path: '/comment', value: comment })
        for (const col of columns) {
          ops.push({ op: 'add', path: '/columns/-', value: col })
        }
        const patchResult = this.patchDirect(ops)
        if (patchResult.status === 'error') {
          return execError(`Failed to apply columns: ${patchResult.message}`)
        }

        // Step 2: Add indexes via exec
        const indexResults: string[] = []
        if (Array.isArray(indexes)) {
          for (const idx of indexes) {
            const r = await this.exec('add_index', idx)
            if (!r.success) return { ...r, data: { ...r.data, completedColumns: columns.length, completedIndexes: indexResults } }
            indexResults.push(r.data?.name ?? idx.name)
          }
        }

        // Step 3: Add foreign keys via exec
        const fkResults: string[] = []
        if (Array.isArray(foreignKeys)) {
          for (const fk of foreignKeys) {
            const r = await this.exec('add_foreign_key', fk)
            if (!r.success) return { ...r, data: { ...r.data, completedColumns: columns.length, completedIndexes: indexResults, completedFKs: fkResults } }
            fkResults.push(r.data?.constraintName ?? fk.constraintName)
          }
        }

        // Step 4: Generate preview SQL
        const freshState = useTableFormStore.getState().getForm(this.objectId)
        let previewSql = ''
        try {
          if (freshState) previewSql = generateTableSql(freshState, this.getDriver())
        } catch { /* non-critical */ }

        return {
          success: true,
          data: {
            tableName,
            columnCount: columns.length,
            indexCount: indexResults.length,
            fkCount: fkResults.length,
            previewSql,
          },
        }
      }

      case 'batch': {
        return this._batchExec(params)
      }

      default:
        return execError(`Unknown action: ${action}`, 'Available actions: preview_sql, save, add_foreign_key, update_foreign_key, remove_foreign_key, add_index, update_index, remove_index, batch_create_table, batch')
    }
  }

  // ── Batch: generic sequential execution with variable binding ──

  private async _batchExec(params: any): Promise<ExecResult> {
    const ops: Array<{ action: string; params?: unknown }> = params?.ops ?? []
    if (ops.length === 0) return execError('ops array is required and must be non-empty')

    // Dry-run: validate without executing
    if (params?.dryRun) {
      return this._validateBatchOps(ops)
    }

    const results: unknown[] = []

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      if (op.action === 'batch') {
        return { success: false, error: `op[${i}]: nested batch is not allowed` }
      }

      let resolvedParams: unknown
      try {
        resolvedParams = resolveVarRefs(op.params, results)
      } catch (e) {
        return {
          success: false,
          error: `op[${i}] ${op.action}: variable resolve failed — ${e instanceof Error ? e.message : String(e)}`,
          data: { completedOps: i, results, failedOp: { index: i, action: op.action, rawParams: op.params } },
        }
      }

      const result = await this.exec(op.action, resolvedParams)
      if (!result.success) {
        return {
          success: false,
          error: `op[${i}] ${op.action} failed: ${result.error}`,
          data: { completedOps: i, results, failedOp: { index: i, action: op.action, resolvedParams } },
        }
      }
      results.push(result.data ?? {})
    }

    const data: Record<string, unknown> = { results }
    if (params?.returnState) {
      data.state = this.read('state')
    }
    return { success: true, data }
  }

  private _validateBatchOps(ops: Array<{ action: string; params?: unknown }>): ExecResult {
    const actionDefs = this.read('actions') as Array<{ name: string; paramsSchema?: any }>
    const actionNames = new Set(actionDefs.map(a => a.name))
    const errors: string[] = []

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      if (op.action === 'batch') {
        errors.push(`op[${i}]: nested batch is not allowed`)
        continue
      }
      if (!actionNames.has(op.action)) {
        errors.push(`op[${i}]: unknown action "${op.action}"`)
        continue
      }
      const def = actionDefs.find(a => a.name === op.action)
      if (def?.paramsSchema?.required && op.params && typeof op.params === 'object') {
        for (const key of def.paramsSchema.required) {
          const val = (op.params as Record<string, unknown>)[key]
          if (val === undefined) {
            errors.push(`op[${i}] ${op.action}: missing required param "${key}"`)
          }
        }
      }
    }

    const varErrors = validateBatchVarRefs(ops)
    errors.push(...varErrors)

    if (errors.length > 0) {
      return { success: false, error: `Dry-run validation failed:\n${errors.join('\n')}` }
    }
    return { success: true, data: { validated: true, opCount: ops.length } }
  }
}
