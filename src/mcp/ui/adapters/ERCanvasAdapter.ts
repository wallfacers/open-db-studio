import { emit } from '@tauri-apps/api/event'
import type { UIObject, JsonPatchOp, PatchResult, ExecResult, ActionDef, PatchCapability } from '../types'
import { parsePath } from '../pathResolver'
import { patchError, execError } from '../errors'
import { useErDesignerStore } from '../../../store/erDesignerStore'
import { useHighlightStore } from '../../../store/highlightStore'
import { executeBatch } from '../batchUtils'

// ── JSON Schema describing the er_canvas state shape ───────────────────────

const ER_CANVAS_STATE_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'number', description: 'ER project ID' },
    projectName: { type: 'string', description: 'ER project name' },
    connectionId: { type: ['number', 'null'], description: 'Bound database connection ID' },
    tables: {
      type: 'array',
      description: 'All tables in the ER diagram',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          position: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['x', 'y'],
          },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                name: { type: 'string' },
                data_type: { type: 'string' },
                nullable: { type: 'boolean' },
                is_primary_key: { type: 'boolean' },
                is_auto_increment: { type: 'boolean' },
                is_unique: { type: 'boolean' },
                unsigned: { type: 'boolean' },
                default_value: { type: ['string', 'null'] },
                comment: { type: ['string', 'null'] },
                length: { type: ['number', 'null'] },
                scale: { type: ['number', 'null'] },
                enum_values: { type: ['array', 'null'], items: { type: 'string' } },
                sort_order: { type: 'number' },
              },
              required: ['id', 'name', 'data_type'],
              'x-addressable-by': 'id',
            },
          },
          indexes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                name: { type: 'string' },
                columns: { type: 'array', items: { type: 'string' } },
                is_unique: { type: 'boolean' },
                index_type: { type: ['string', 'null'] },
              },
              required: ['id', 'name', 'columns', 'is_unique'],
              'x-addressable-by': 'id',
            },
          },
        },
        required: ['id', 'name', 'position', 'columns', 'indexes'],
        'x-addressable-by': 'id',
      },
    },
    relations: {
      type: 'array',
      description: 'Foreign key / relationship edges between tables',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: ['string', 'null'] },
          source_table_id: { type: 'number' },
          source_column_id: { type: 'number' },
          target_table_id: { type: 'number' },
          target_column_id: { type: 'number' },
          relation_type: { type: 'string', enum: ['one_to_one', 'one_to_many', 'many_to_many'] },
          on_delete: { type: 'string' },
          on_update: { type: 'string' },
        },
        required: ['id', 'source_table_id', 'source_column_id', 'target_table_id', 'target_column_id', 'relation_type'],
        'x-addressable-by': 'id',
      },
    },
  },
  required: ['projectId', 'projectName', 'connectionId', 'tables', 'relations'],
}

// ── Action definitions ─────────────────────────────────────────────────────

const ER_CANVAS_ACTIONS: ActionDef[] = [
  // CRUD — tables
  {
    name: 'add_table',
    description: 'Add a new table to the ER diagram at a given position',
    paramsSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Table name' },
        position: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_table',
    description: 'Update table properties (name, comment, color, position)',
    paramsSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'number' },
        updates: {
          type: 'object',
          description: 'Partial ErTable fields to update (name, comment, color, position_x, position_y)',
        },
      },
      required: ['tableId', 'updates'],
    },
  },
  {
    name: 'delete_table',
    description: 'Delete a table and all its columns, indexes, and related relations',
    paramsSchema: {
      type: 'object',
      properties: { tableId: { type: 'number' } },
      required: ['tableId'],
    },
  },
  // CRUD — columns
  {
    name: 'add_column',
    description: 'Add a column to an existing table. Column can be an object or shorthand string like "email VARCHAR(255) NOT NULL UNIQUE".',
    paramsSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'number' },
        column: {
          description: 'Column definition: object {name, data_type, ...} OR shorthand string "name TYPE [PK] [AI] [NOT NULL] [UNIQUE] [UNSIGNED] [DEFAULT \'val\'] [COMMENT \'text\']"',
          properties: {
            name: { type: 'string' },
            data_type: { type: 'string' },
            nullable: { type: 'boolean', default: true },
            is_primary_key: { type: 'boolean', default: false },
            is_auto_increment: { type: 'boolean', default: false },
            default_value: { type: ['string', 'null'] },
            comment: { type: ['string', 'null'] },
          },
          required: ['name', 'data_type'],
        },
      },
      required: ['tableId', 'column'],
    },
  },
  {
    name: 'update_column',
    description: 'Update column properties',
    paramsSchema: {
      type: 'object',
      properties: {
        columnId: { type: 'number' },
        updates: { type: 'object', description: 'Partial ErColumn fields to update' },
      },
      required: ['columnId', 'updates'],
    },
  },
  {
    name: 'delete_column',
    description: 'Delete a column from a table',
    paramsSchema: {
      type: 'object',
      properties: {
        columnId: { type: 'number' },
        tableId: { type: 'number' },
      },
      required: ['columnId', 'tableId'],
    },
  },
  // CRUD — relations
  {
    name: 'add_relation',
    description: 'Add a relation (foreign key edge) between two table columns',
    paramsSchema: {
      type: 'object',
      properties: {
        source_table_id: { type: 'number' },
        source_column_id: { type: 'number' },
        target_table_id: { type: 'number' },
        target_column_id: { type: 'number' },
        relation_type: { type: 'string', default: 'one_to_many' },
        on_delete: { type: 'string', default: 'NO ACTION' },
        on_update: { type: 'string', default: 'NO ACTION' },
      },
      required: ['source_table_id', 'source_column_id', 'target_table_id', 'target_column_id'],
    },
  },
  {
    name: 'update_relation',
    description: 'Update relation properties (relation_type, on_delete, on_update, name)',
    paramsSchema: {
      type: 'object',
      properties: {
        relationId: { type: 'number' },
        updates: { type: 'object', description: 'Partial ErRelation fields to update (relation_type, on_delete, on_update, name)' },
      },
      required: ['relationId', 'updates'],
    },
  },
  {
    name: 'delete_relation',
    description: 'Delete a relation edge by ID',
    paramsSchema: {
      type: 'object',
      properties: { relationId: { type: 'number' } },
      required: ['relationId'],
    },
  },
  // CRUD — indexes
  {
    name: 'add_index',
    description: 'Add an index to a table',
    paramsSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'number' },
        index: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['INDEX', 'UNIQUE', 'FULLTEXT'], default: 'INDEX' },
            columns: { type: 'array', items: { type: 'string' }, description: 'Column names for the index' },
          },
          required: ['name', 'columns'],
        },
      },
      required: ['tableId', 'index'],
    },
  },
  {
    name: 'update_index',
    description: 'Update an index definition',
    paramsSchema: {
      type: 'object',
      properties: {
        indexId: { type: 'number' },
        updates: { type: 'object', description: 'Partial ErIndex fields to update' },
      },
      required: ['indexId', 'updates'],
    },
  },
  {
    name: 'delete_index',
    description: 'Delete an index from a table',
    paramsSchema: {
      type: 'object',
      properties: {
        indexId: { type: 'number' },
        tableId: { type: 'number' },
      },
      required: ['indexId', 'tableId'],
    },
  },
  {
    name: 'replace_columns',
    description: 'Replace all columns of a table with new definitions. Deletes existing columns and creates new ones in batch.',
    paramsSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'number' },
        columns: {
          type: 'array',
          description: 'New column definitions to create',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              data_type: { type: 'string' },
              nullable: { type: 'boolean', default: true },
              is_primary_key: { type: 'boolean', default: false },
              is_auto_increment: { type: 'boolean', default: false },
              is_unique: { type: 'boolean', default: false },
              unsigned: { type: 'boolean', default: false },
              default_value: { type: ['string', 'null'] },
              comment: { type: ['string', 'null'] },
              length: { type: ['number', 'null'] },
              scale: { type: ['number', 'null'] },
              enum_values: { type: ['array', 'null'], items: { type: 'string' } },
            },
            required: ['name', 'data_type'],
          },
        },
      },
      required: ['tableId', 'columns'],
    },
  },
  {
    name: 'replace_indexes',
    description: 'Replace all indexes of a table with new definitions. Deletes existing indexes and creates new ones in batch.',
    paramsSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'number' },
        indexes: {
          type: 'array',
          description: 'New index definitions to create',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['INDEX', 'UNIQUE', 'FULLTEXT'], default: 'INDEX' },
              columns: { type: 'array', items: { type: 'string' }, description: 'Column names for the index' },
            },
            required: ['name', 'columns'],
          },
        },
      },
      required: ['tableId', 'indexes'],
    },
  },
  // Text results
  {
    name: 'generate_ddl',
    description: 'Generate DDL SQL for the ER project in the specified dialect',
    paramsSchema: {
      type: 'object',
      properties: {
        dialect: { type: 'string', description: 'SQL dialect, e.g. "mysql", "postgresql"' },
        includeIndexes: { type: 'boolean', default: true },
        includeComments: { type: 'boolean', default: true },
        includeForeignKeys: { type: 'boolean', default: true },
        includeCommentRefs: { type: 'boolean', description: 'Whether to generate comment-ref markers in column comments' },
      },
      required: ['dialect'],
    },
  },
  {
    name: 'diff_with_database',
    description: 'Diff the ER diagram against the bound live database and return the difference report',
    paramsSchema: { type: 'object', properties: {} },
  },
  // Dialog triggers
  {
    name: 'open_import_dialog',
    description: 'Open the SQL/DDL import dialog for this ER project',
    paramsSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_bind_dialog',
    description: 'Open the connection-bind dialog to link this project to a database',
    paramsSchema: { type: 'object', properties: {} },
  },
  {
    name: 'auto_layout',
    description: 'Trigger automatic layout of all nodes on the ER canvas',
    paramsSchema: { type: 'object', properties: {} },
  },
  // Column reorder
  {
    name: 'reorder_columns',
    description: 'Reorder columns within a table by providing the desired column ID sequence',
    paramsSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'number' },
        columnIds: { type: 'array', items: { type: 'number' }, description: 'Ordered array of column IDs' },
      },
      required: ['tableId', 'columnIds'],
    },
  },
  // ── Batch operations ────────────────────────────────────────
  {
    name: 'batch_create_table',
    description:
      'Create a complete table with all columns and indexes in one call. ' +
      'Much faster than calling add_table + add_column × N + add_index × N separately. ' +
      'Returns { tableId, columnIds, columnMap, indexIds }. Set returnState=true to also get the full project state.',
    paramsSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Table name' },
        comment: { type: 'string', description: 'Table comment' },
        position: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
        },
        columns: {
          type: 'array',
          description: 'Column definitions (ordered). Each item can be an object OR a shorthand string like "id BIGINT PK AI" or "email VARCHAR(255) NOT NULL UNIQUE".',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              data_type: { type: 'string' },
              length: { type: ['number', 'null'] },
              scale: { type: ['number', 'null'] },
              nullable: { type: 'boolean', default: true },
              is_primary_key: { type: 'boolean', default: false },
              is_auto_increment: { type: 'boolean', default: false },
              is_unique: { type: 'boolean', default: false },
              unsigned: { type: 'boolean', default: false },
              default_value: { type: ['string', 'null'] },
              comment: { type: ['string', 'null'] },
              enum_values: { type: ['array', 'null'], items: { type: 'string' } },
            },
            required: ['name', 'data_type'],
          },
        },
        indexes: {
          type: 'array',
          description: 'Index definitions',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              columns: { type: 'array', items: { type: 'string' }, description: 'Column names' },
              type: { type: 'string', enum: ['INDEX', 'UNIQUE', 'FULLTEXT'], default: 'INDEX' },
            },
            required: ['name', 'columns'],
          },
        },
        returnState: { type: 'boolean', default: false, description: 'If true, include full project state in the response' },
      },
      required: ['name', 'columns'],
    },
  },
  {
    name: 'batch',
    description:
      'Execute a sequence of actions in one call with variable binding. ' +
      'Each op is { action, params }; results are stored and can be referenced by later ops ' +
      'via "$N.path" syntax where N is the zero-based index of a prior op ' +
      '(e.g. "$0.tableId", "$1.columnMap.user_id", "$2.columnIds[0]", "$0.columnIds" for the whole array). ' +
      'IMPORTANT: to pass an entire array result use "$N.arrayProp" as the param value — ' +
      'do NOT join IDs into a comma-separated string. ' +
      'Example — reorder after batch_create_table: { "tableId": "$0.tableId", "columnIds": "$0.columnIds" }. ' +
      'Stops on first failure. Returns { results: [...] } with each op\'s result. ' +
      'Use this for ANY multi-step workflow: create tables + add relations, modify multiple columns, etc.',
    paramsSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description: 'Ordered operations. Each op reuses any existing action (add_table, add_column, batch_create_table, etc.)',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Action name (any action listed in this adapter)' },
              params: {
                type: 'object',
                description: 'Action params. String values like "$0.tableId" are resolved to previous op results.',
              },
            },
            required: ['action'],
          },
        },
        returnState: { type: 'boolean', default: false, description: 'If true, include full project state in the response after all ops complete' },
        dryRun: { type: 'boolean', default: false, description: 'If true, validate all ops without executing (checks action names, required params, variable refs)' },
      },
      required: ['ops'],
    },
  },
  // Connection binding
  {
    name: 'bind_connection',
    description: 'Programmatically bind this ER project to a database connection',
    paramsSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'number' },
        database: { type: 'string', description: 'Database name to bind' },
        schema: { type: 'string', description: 'Schema name (optional, for PostgreSQL)' },
      },
      required: ['connectionId', 'database'],
    },
  },
  {
    name: 'unbind_connection',
    description: 'Unbind this ER project from its database connection',
    paramsSchema: { type: 'object', properties: {} },
  },
]

// ── Helper: parse patch path like /tables/[id=5]/name ─────────────────────

// Maps nested patch paths to flat store field names
const FIELD_ALIASES: Record<string, Record<string, string>> = {
  table: { 'position/x': 'position_x', 'position/y': 'position_y' },
  column: {},
}

/**
 * Parse column shorthand string into a column definition object.
 * Format: "<name> <TYPE>[(length[,scale])] [PK] [AI] [NOT NULL] [UNIQUE] [UNSIGNED] [DEFAULT <val>] [COMMENT '<text>']"
 * Examples:
 *   "id BIGINT PK AI"
 *   "email VARCHAR(255) NOT NULL UNIQUE"
 *   "price DECIMAL(10,2) UNSIGNED DEFAULT '0.00'"
 *   "status ENUM NOT NULL DEFAULT 'active' COMMENT 'User status'"
 */
function parseColumnShorthand(input: string): Record<string, unknown> {
  const tokens = input.trim().split(/\s+/)
  if (tokens.length < 2) {
    throw new Error(`Column shorthand must have at least "<name> <type>": "${input}"`)
  }

  const name = tokens[0]
  let dataTypeRaw = tokens[1]
  let length: number | null = null
  let scale: number | null = null

  // Extract (length[,scale]) from type
  const parenMatch = dataTypeRaw.match(/^(\w+)\((\d+)(?:,(\d+))?\)$/)
  if (parenMatch) {
    dataTypeRaw = parenMatch[1]
    length = parseInt(parenMatch[2], 10)
    if (parenMatch[3]) scale = parseInt(parenMatch[3], 10)
  }

  const col: Record<string, unknown> = {
    name,
    data_type: dataTypeRaw.toUpperCase(),
  }
  if (length !== null) col.length = length
  if (scale !== null) col.scale = scale

  // Parse remaining flags (case-insensitive)
  const rest = tokens.slice(2).join(' ')
  const upper = rest.toUpperCase()

  if (upper.includes('PK')) col.is_primary_key = true
  if (upper.includes('AI')) col.is_auto_increment = true
  if (upper.includes('NOT NULL')) col.nullable = false
  if (upper.includes('UNIQUE')) col.is_unique = true
  if (upper.includes('UNSIGNED')) col.unsigned = true

  // Extract DEFAULT value
  const defaultMatch = rest.match(/DEFAULT\s+'([^']*)'/i) ?? rest.match(/DEFAULT\s+(\S+)/i)
  if (defaultMatch) col.default_value = defaultMatch[1]

  // Extract COMMENT
  const commentMatch = rest.match(/COMMENT\s+'([^']*)'/i)
  if (commentMatch) col.comment = commentMatch[1]

  return col
}

/** Normalize column definitions: accept both string shorthand and object format */
function normalizeColumns(columns: unknown[]): Record<string, unknown>[] {
  return columns.map((col, i) => {
    if (typeof col === 'string') return parseColumnShorthand(col)
    if (typeof col === 'object' && col !== null) return col as Record<string, unknown>
    throw new Error(`columns[${i}]: expected string shorthand or object, got ${typeof col}`)
  })
}

/** Normalize index columns: AI passes string[], store expects JSON string */
function normalizeIndexColumns(indexDef: { columns?: string[] | string }): void {
  if (Array.isArray(indexDef.columns)) {
    (indexDef as { columns: string }).columns = JSON.stringify(indexDef.columns)
  }
}

/** Validate that all index column names exist in the table's columns */
function validateIndexColumns(
  indexColumns: string[] | string | undefined,
  tableId: number,
  store: ReturnType<typeof useErDesignerStore.getState>,
): string | null {
  if (!indexColumns) return null
  const colNames: string[] = typeof indexColumns === 'string'
    ? JSON.parse(indexColumns)
    : indexColumns
  const existingNames = new Set(
    (store.columns[tableId] ?? []).map((c) => c.name),
  )
  const missing = colNames.filter((n) => !existingNames.has(n))
  if (missing.length > 0) {
    return `Index references non-existent column(s): ${missing.join(', ')}. Available columns: ${[...existingNames].join(', ') || '(none)'}`
  }
  return null
}

function resolveField(entity: 'table' | 'column', field: string): string {
  return FIELD_ALIASES[entity]?.[field] ?? field
}

// ── Static patch capabilities (cached, no allocation per call) ──────────

const ER_PATCH_CAPABILITIES: PatchCapability[] = [
  {
    pathPattern: '/tables/[<key>=<val>]/<field>',
    ops: ['replace'],
    description: 'Update table properties (name, comment, color, position/x, position/y)',
    addressableBy: ['id', 'name'],
  },
  {
    pathPattern: '/tables/[<key>=<val>]/columns/-',
    ops: ['add'],
    description: 'Append a column to a table',
    addressableBy: ['id', 'name'],
  },
  {
    pathPattern: '/tables/[<key>=<val>]/indexes/-',
    ops: ['add'],
    description: 'Append an index to a table',
    addressableBy: ['id', 'name'],
  },
  {
    pathPattern: '/columns/[id=<n>]/[tableId=<n>]',
    ops: ['remove'],
    description: 'Delete a column (requires tableId)',
    addressableBy: ['id'],
  },
  {
    pathPattern: '/indexes/[id=<n>]/[tableId=<n>]',
    ops: ['remove'],
    description: 'Delete an index (requires tableId)',
    addressableBy: ['id'],
  },
  {
    pathPattern: '/relations/[id=<n>]',
    ops: ['remove'],
    description: 'Delete a relation. To add/update relations, use ui_exec with add_relation/update_relation',
    addressableBy: ['id'],
  },
]

// ── ERCanvasAdapter ────────────────────────────────────────────────────────

export class ERCanvasAdapter implements UIObject {
  type = 'er_canvas'
  objectId: string
  title: string

  private _projectId: number

  constructor(objectId: string, title: string, projectId: number) {
    this.objectId = objectId
    this.title = title
    this._projectId = projectId
  }

  // Dynamically resolve connectionId from store (stays fresh after bind/unbind)
  get connectionId(): number | undefined {
    return useErDesignerStore.getState().projects.find(p => p.id === this._projectId)?.connection_id ?? undefined
  }

  private get _project() {
    return useErDesignerStore.getState().projects.find(p => p.id === this._projectId)
  }

  get patchCapabilities(): PatchCapability[] {
    return ER_PATCH_CAPABILITIES
  }

  // ── highlight helper ──────────────────────────────────────────────────

  private _highlight(paths: string[]) {
    if (paths.length > 0) {
      useHighlightStore.getState().addHighlights(this.objectId, paths)
    }
  }

  // ── read() ────────────────────────────────────────────────────────────

  read(mode: 'state' | 'schema' | 'actions' | 'full') {
    switch (mode) {
      case 'state':
        return this._readState()
      case 'schema':
        return { ...ER_CANVAS_STATE_SCHEMA, patchCapabilities: ER_PATCH_CAPABILITIES }
      case 'actions':
        return ER_CANVAS_ACTIONS
      case 'full':
        return {
          state: this._readState(),
          actions: ER_CANVAS_ACTIONS,
          schema: { ...ER_CANVAS_STATE_SCHEMA, patchCapabilities: ER_PATCH_CAPABILITIES },
        }
    }
  }

  private _readState() {
    const { projects, tables, columns, relations, indexes } = useErDesignerStore.getState()
    const project = projects.find(p => p.id === this._projectId)
    const projectTables = tables.filter(t => t.project_id === this._projectId)
    const projectTableIds = new Set(projectTables.map(t => t.id))

    return {
      projectId: this._projectId,
      projectName: project?.name ?? '',
      connectionId: project?.connection_id ?? null,
      tables: projectTables.map(t => ({
        id: t.id,
        name: t.name,
        position: { x: t.position_x, y: t.position_y },
        columns: (columns[t.id] ?? []).map(c => ({
          id: c.id,
          name: c.name,
          data_type: c.data_type,
          nullable: c.nullable,
          is_primary_key: c.is_primary_key,
          is_auto_increment: c.is_auto_increment,
          is_unique: c.is_unique,
          unsigned: c.unsigned,
          default_value: c.default_value,
          comment: c.comment,
          length: c.length,
          scale: c.scale,
          enum_values: c.enum_values,
          sort_order: c.sort_order,
        })),
        indexes: (indexes[t.id] ?? []).map(idx => {
          let parsedColumns: string[] = []
          try {
            parsedColumns = JSON.parse(idx.columns)
          } catch {
            parsedColumns = []
          }
          return {
            id: idx.id,
            name: idx.name,
            columns: parsedColumns,
            is_unique: idx.type === 'UNIQUE',
            index_type: idx.type ?? null,
          }
        }),
      })),
      relations: relations.filter(r => projectTableIds.has(r.source_table_id) && projectTableIds.has(r.target_table_id)).map(r => ({
        id: r.id,
        name: r.name,
        source_table_id: r.source_table_id,
        source_column_id: r.source_column_id,
        target_table_id: r.target_table_id,
        target_column_id: r.target_column_id,
        relation_type: r.relation_type,
        on_delete: r.on_delete,
        on_update: r.on_update,
      })),
    }
  }

  // ── patch() ───────────────────────────────────────────────────────────
  // ER canvas is design-time and all operations are reversible via undo/redo,
  // so we intentionally skip pending_confirm and apply directly.

  async patch(ops: JsonPatchOp[], _reason?: string): Promise<PatchResult> {
    const store = useErDesignerStore.getState()
    const hlPaths: string[] = []

    for (const op of ops) {
      try {
        switch (op.op) {
          case 'replace': {
            const segments = parsePath(op.path)
            if (segments.length < 2 || !segments[0].filters) {
              return patchError(
                `Cannot parse replace path "${op.path}"`,
                `/tables/[id=<n>]/<field> or /tables/[name=<s>]/<field> or /columns/[id=<n>]/<field>`,
              )
            }
            const entity = segments[0].field
            const filters = segments[0].filters
            const field = segments.slice(1).map(s => s.field).join('/')

            if (entity === 'tables') {
              const table = store.tables.find(t =>
                Object.entries(filters).every(([k, v]) => String((t as any)[k]) === v),
              )
              if (!table) {
                return patchError(
                  `Table not found: ${JSON.stringify(filters)}`,
                  `/tables/[id=<n>]/<field> or /tables/[name=<s>]/<field>`,
                )
              }
              const resolvedField = resolveField('table', field)
              await store.updateTable(table.id, { [resolvedField]: op.value })
              hlPaths.push(`table:${table.id}:${resolvedField}`)
            } else if (entity === 'columns') {
              const colId = Number(filters.id)
              if (!colId) {
                return patchError(
                  `Column addressing requires [id=<n>]`,
                  `/columns/[id=<n>]/<field>`,
                )
              }
              const resolvedField = resolveField('column', field)
              await store.updateColumn(colId, { [resolvedField]: op.value })
              // Find which table owns this column for highlight path
              const ownerTableId = Object.entries(store.columns).find(
                ([, cols]) => cols.some(c => c.id === colId)
              )?.[0]
              if (ownerTableId) hlPaths.push(`column:${ownerTableId}:${colId}`)
            } else {
              return patchError(
                `Cannot parse replace path "${op.path}"`,
                `/tables/[id=<n>]/<field> or /columns/[id=<n>]/<field>`,
              )
            }
            break
          }

          case 'add': {
            const segments = parsePath(op.path)
            // Expect: /tables/[filter]/collection/- where collection has isAppend
            const tableSegment = segments[0]
            const collSegment = segments.find(s => s.isAppend)
            if (!tableSegment?.filters || !collSegment) {
              return patchError(
                `Cannot parse add path "${op.path}"`,
                `/tables/[id=<n>]/columns/- or /tables/[name=<s>]/indexes/-`,
              )
            }
            const table = store.tables.find(t =>
              Object.entries(tableSegment.filters!).every(([k, v]) => String((t as any)[k]) === v),
            )
            if (!table) {
              return patchError(
                `Table not found: ${JSON.stringify(tableSegment.filters)}`,
                `/tables/[id=<n>]/columns/- or /tables/[name=<s>]/columns/-`,
              )
            }
            if (collSegment.field === 'columns') {
              const created = await store.addColumn(table.id, op.value)
              hlPaths.push(`column:${table.id}:${created.id}`)
            } else if (collSegment.field === 'indexes') {
              const indexDef = { ...op.value }
              normalizeIndexColumns(indexDef)
              const created = await store.addIndex(table.id, indexDef)
              hlPaths.push(`index:${table.id}:${created.id}`)
            } else {
              return patchError(
                `Cannot parse add path "${op.path}"`,
                `/tables/[id=<n>]/columns/- or /tables/[id=<n>]/indexes/-`,
              )
            }
            break
          }

          case 'remove': {
            const segments = parsePath(op.path)
            const entitySegment = segments[0]
            if (!entitySegment?.filters) {
              return patchError(
                `Cannot parse remove path "${op.path}"`,
                `/columns/[id=<n>]/[tableId=<n>], /indexes/[id=<n>]/[tableId=<n>], or /relations/[id=<n>]`,
              )
            }
            const entityId = Number(entitySegment.filters.id)
            const entity = entitySegment.field

            // Extract tableId from context segment (e.g. /[tableId=5])
            const ctxSegment = segments.find(s => s.field === '' && s.filters?.tableId)
            const tableId = ctxSegment ? Number(ctxSegment.filters!.tableId) : undefined

            if (entity === 'columns') {
              if (!tableId) {
                return patchError(
                  `remove /columns requires tableId`,
                  `/columns/[id=<n>]/[tableId=<n>]`,
                )
              }
              await store.deleteColumn(entityId, tableId)
              // Highlight parent table to indicate structural change
              hlPaths.push(`table:${tableId}`)
            } else if (entity === 'indexes') {
              if (!tableId) {
                return patchError(
                  `remove /indexes requires tableId`,
                  `/indexes/[id=<n>]/[tableId=<n>]`,
                )
              }
              await store.deleteIndex(entityId, tableId)
              hlPaths.push(`table:${tableId}`)
            } else if (entity === 'relations') {
              await store.deleteRelation(entityId)
              // relation removed — no visual target to highlight
            } else {
              return patchError(
                `Cannot parse remove path "${op.path}"`,
                `/columns/[id=<n>]/[tableId=<n>], /indexes/[id=<n>]/[tableId=<n>], or /relations/[id=<n>]`,
              )
            }
            break
          }

          default:
            return patchError(
              `Unsupported patch op "${op.op}"`,
              `er_canvas supports "replace", "add", and "remove"`,
              `Use ui_exec for complex operations like add_relation`,
            )
        }
      } catch (e) {
        return patchError(String(e))
      }
    }

    this._highlight(hlPaths)
    return { status: 'applied' }
  }

  // ── exec() ────────────────────────────────────────────────────────────

  /** Execute fn and return standardized result. Store's optimistic updates +
   *  ERCanvas useEffect sync handle ReactFlow state propagation automatically,
   *  so no full-project reload is needed. */
  private async withReload(fn: () => Promise<Record<string, unknown> | undefined | void>): Promise<ExecResult> {
    try {
      const data = await fn()
      return { success: true, ...(data ? { data } : {}) }
    } catch (e) {
      return execError(String(e))
    }
  }

  async exec(action: string, params?: any): Promise<ExecResult> {
    const store = useErDesignerStore.getState()

    switch (action) {
      // ── Table CRUD ──────────────────────────────────────────────────
      case 'add_table':
        return this.withReload(async () => {
          const position = params?.position ?? { x: 100, y: 100 }
          const table = await store.addTable(this._projectId, params.name, position)
          this._highlight([`table:${table.id}`])
          return { tableId: table.id }
        })

      case 'update_table':
        return this.withReload(async () => {
          await store.updateTable(params.tableId, params.updates)
          const fields = Object.keys(params.updates ?? {})
          this._highlight(fields.map(f => `table:${params.tableId}:${f}`))
        })

      case 'delete_table':
        return this.withReload(() => store.deleteTable(params.tableId))

      // ── Column CRUD ─────────────────────────────────────────────────
      case 'add_column': {
        if (!store.tables.find((t) => t.id === params.tableId)) {
          return { success: false, error: `Table ${params.tableId} does not exist` }
        }
        // Support string shorthand for column definition
        if (typeof params.column === 'string') {
          try { params.column = parseColumnShorthand(params.column) } catch (e) {
            return { success: false, error: `Column parse error: ${e instanceof Error ? e.message : String(e)}` }
          }
        }
        return this.withReload(async () => {
          const created = await store.addColumn(params.tableId, params.column)
          this._highlight([`column:${params.tableId}:${created.id}`])
          return { columnId: created.id }
        })
      }

      case 'update_column':
        return this.withReload(async () => {
          await store.updateColumn(params.columnId, params.updates)
          // Find table that owns this column
          const ownerTableId = Object.entries(store.columns).find(
            ([, cols]) => cols.some(c => c.id === params.columnId)
          )?.[0]
          if (ownerTableId) this._highlight([`column:${ownerTableId}:${params.columnId}`])
        })

      case 'delete_column':
        return this.withReload(async () => {
          await store.deleteColumn(params.columnId, params.tableId)
          this._highlight([`table:${params.tableId}`])
        })

      // ── Relation CRUD ───────────────────────────────────────────────
      case 'add_relation':
        return this.withReload(async () => {
          const created = await store.addRelation(this._projectId, params)
          this._highlight([`relation:${created.id}`])
          return { relationId: created.id }
        })

      case 'update_relation':
        return this.withReload(async () => {
          await store.updateRelation(params.relationId, params.updates)
          this._highlight([`relation:${params.relationId}`])
        })

      case 'delete_relation':
        return this.withReload(() => store.deleteRelation(params.relationId))

      // ── Index CRUD ──────────────────────────────────────────────────
      case 'add_index': {
        const colErr = validateIndexColumns(params.index?.columns, params.tableId, store)
        if (colErr) return { success: false, error: colErr }
        return this.withReload(async () => {
          const indexDef = { ...params.index }
          normalizeIndexColumns(indexDef)
          const created = await store.addIndex(params.tableId, indexDef)
          this._highlight([`index:${params.tableId}:${created.id}`])
          return { indexId: created.id }
        })
      }

      case 'update_index':
        return this.withReload(async () => {
          await store.updateIndex(params.indexId, params.updates)
          this._highlight([`index:${params.tableId}:${params.indexId}`])
        })

      case 'delete_index':
        return this.withReload(async () => {
          await store.deleteIndex(params.indexId, params.tableId)
          this._highlight([`table:${params.tableId}`])
        })

      // ── Batch replace ─────────────────────────────────────────────────
      case 'replace_columns':
        if (!store.tables.find((t) => t.id === params.tableId)) {
          return { success: false, error: `Table ${params.tableId} does not exist` }
        }
        // Support string shorthand for column definitions
        try {
          if (params.columns) params.columns = normalizeColumns(params.columns)
        } catch (e) {
          return { success: false, error: `Column parse error: ${e instanceof Error ? e.message : String(e)}` }
        }
        try {
          const rcTableId = params.tableId
          const existingCols = store.columns[rcTableId] ?? []
          for (let i = existingCols.length - 1; i >= 0; i--) {
            await store.deleteColumn(existingCols[i].id, rcTableId)
          }
          const colIds: number[] = []
          for (const colDef of params.columns) {
            const created = await store.addColumn(rcTableId, colDef)
            colIds.push(created.id)
          }
          this._highlight(colIds.map(cid => `column:${rcTableId}:${cid}`))
          return { success: true, data: { columnIds: colIds } }
        } catch (e) {
          await this._resyncProject()
          return execError(String(e))
        }

      case 'replace_indexes': {
        // 在删除旧索引前先校验所有新索引的列名
        const riStore = useErDesignerStore.getState()
        for (const idxDef of params.indexes ?? []) {
          const cols = idxDef.columns
          const riColErr = validateIndexColumns(cols, params.tableId, riStore)
          if (riColErr) return { success: false, error: riColErr }
        }
        try {
          const riTableId = params.tableId
          const existingIndexes = store.indexes[riTableId] ?? []
          for (const idx of existingIndexes) {
            await store.deleteIndex(idx.id, riTableId)
          }
          const idxIds: number[] = []
          for (const idxDef of params.indexes) {
            const indexDef = { ...idxDef }
            if (Array.isArray(indexDef.columns)) {
              indexDef.columns = JSON.stringify(indexDef.columns)
            }
            const created = await store.addIndex(riTableId, indexDef)
            idxIds.push(created.id)
          }
          this._highlight(idxIds.map(iid => `index:${riTableId}:${iid}`))
          return { success: true, data: { indexIds: idxIds } }
        } catch (e) {
          await this._resyncProject()
          return execError(String(e))
        }
      }

      // ── Text result operations (no canvas reload needed) ────────────
      case 'generate_ddl':
        try {
          const ddl = await store.generateDDL(this._projectId, params.dialect, {
            includeIndexes: params.includeIndexes ?? true,
            includeComments: params.includeComments ?? true,
            includeForeignKeys: params.includeForeignKeys ?? true,
            includeCommentRefs: params.includeCommentRefs ?? true,
          })
          return { success: true, data: { ddl, dialect: params.dialect } }
        } catch (e) {
          return { success: false, error: String(e) }
        }

      case 'diff_with_database':
        try {
          const diff = await store.diffWithDatabase(this._projectId)
          return { success: true, data: { diff } }
        } catch (e) {
          return { success: false, error: String(e) }
        }

      // ── Dialog triggers ─────────────────────────────────────────────
      case 'open_import_dialog':
        await emit('er-canvas-open-dialog', { projectId: this._projectId, dialog: 'import' })
        return { success: true }

      case 'open_bind_dialog':
        await emit('er-canvas-open-dialog', { projectId: this._projectId, dialog: 'bind' })
        return { success: true }

      case 'auto_layout':
        await emit('er-canvas-auto-layout', { projectId: this._projectId })
        return { success: true }

      // ── Column reorder ──────────────────────────────────────────────
      case 'reorder_columns':
        return this.withReload(() => store.reorderColumns(params.tableId, params.columnIds))

      // ── Connection binding ──────────────────────────────────────────
      case 'bind_connection':
        return this.withReload(() =>
          store.bindConnection(this._projectId, params.connectionId, params.database, params.schema)
        )

      case 'unbind_connection':
        return this.withReload(() => store.unbindConnection(this._projectId))

      // ── Batch operations ────────────────────────────────────────
      case 'batch_create_table':
        return this._batchCreateTable(store, params)

      case 'batch':
        return executeBatch(params, (a, p) => this.exec(a, p), {
          actionDefs: ER_CANVAS_ACTIONS,
          onPartialFailure: () => this._resyncProject(),
          returnState: params?.returnState,
          readState: () => this._readState(),
        })

      default: {
        const available = ER_CANVAS_ACTIONS.map(a => a.name).join(', ')
        return execError(`Unknown action: ${action}. Available: [${available}]`)
      }
    }
  }

  // ── Batch: single table with columns + indexes ─────────────────

  private async _batchCreateTable(
    store: ReturnType<typeof useErDesignerStore.getState>,
    params: any,
  ): Promise<ExecResult> {
    // Normalize columns: support string shorthand (e.g. "id BIGINT PK AI")
    try {
      if (params.columns) params.columns = normalizeColumns(params.columns)
    } catch (e) {
      return { success: false, error: `Column parse error: ${e instanceof Error ? e.message : String(e)}` }
    }

    // Pre-validate: index columns must reference columns defined in this batch
    const colNameSet = new Set((params.columns ?? []).map((c: any) => c.name))
    for (const idx of params.indexes ?? []) {
      let idxCols: string[]
      try {
        idxCols = Array.isArray(idx.columns)
          ? idx.columns
          : JSON.parse(idx.columns ?? '[]')
      } catch {
        return { success: false, error: `Index "${idx.name}" has malformed columns: ${idx.columns}` }
      }
      const missing = idxCols.filter((n: string) => !colNameSet.has(n))
      if (missing.length > 0) {
        return {
          success: false,
          error: `Index "${idx.name}" references non-existent column(s): ${missing.join(', ')}. Available: ${[...colNameSet].join(', ') || '(none)'}`,
        }
      }
    }

    try {
      const position = params.position ?? { x: 100, y: 100 }
      const table = await store.addTable(this._projectId, params.name, position)

      if (params.comment) {
        await store.updateTable(table.id, { comment: params.comment })
      }

      // Create columns sequentially to preserve order
      const columnIds: number[] = []
      const columnNameToId: Record<string, number> = {}
      for (const col of params.columns ?? []) {
        const created = await store.addColumn(table.id, col)
        columnIds.push(created.id)
        columnNameToId[col.name] = created.id
      }

      // Create indexes
      const indexIds: number[] = []
      for (const idx of params.indexes ?? []) {
        const indexDef = { ...idx }
        normalizeIndexColumns(indexDef)
        const created = await store.addIndex(table.id, indexDef)
        indexIds.push(created.id)
      }

      this._highlight([
        `table:${table.id}`,
        ...columnIds.map(cid => `column:${table.id}:${cid}`),
        ...indexIds.map(iid => `index:${table.id}:${iid}`),
      ])
      const data: Record<string, unknown> = { tableId: table.id, columnIds, columnMap: columnNameToId, indexIds }
      if (params?.returnState) {
        data.state = this._readState()
      }
      return { success: true, data }
    } catch (e) {
      await this._resyncProject()
      return { success: false, error: String(e) }
    }
  }

  /** 从后端重新加载项目数据，修复前后端状态不一致 */
  private async _resyncProject(): Promise<void> {
    try {
      await useErDesignerStore.getState().loadProject(this._projectId)
    } catch {
      // 重同步失败不应阻断错误返回
    }
  }
}
