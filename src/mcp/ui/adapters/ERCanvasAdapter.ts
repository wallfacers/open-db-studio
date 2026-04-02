import { emit } from '@tauri-apps/api/event'
import type { UIObject, JsonPatchOp, PatchResult, ExecResult, ActionDef } from '../types'
import { useErDesignerStore } from '../../../store/erDesignerStore'

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
    description: 'Add a column to an existing table',
    paramsSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'number' },
        column: {
          type: 'object',
          description: 'Column definition (name, data_type, nullable, is_primary_key, etc.)',
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

interface ParsedPath {
  entity: 'table' | 'column'
  entityId: number
  field: string
}

// Maps nested patch paths to flat store field names
const FIELD_ALIASES: Record<string, Record<string, string>> = {
  table: { 'position/x': 'position_x', 'position/y': 'position_y' },
  column: {},
}

function resolveField(entity: 'table' | 'column', field: string): string {
  return FIELD_ALIASES[entity]?.[field] ?? field
}

function parsePatchPath(path: string): ParsedPath | null {
  const tableMatch = path.match(/^\/tables\/\[id=(\d+)\]\/(.+)$/)
  if (tableMatch) {
    return { entity: 'table', entityId: Number(tableMatch[1]), field: tableMatch[2] }
  }
  const columnMatch = path.match(/^\/columns\/\[id=(\d+)\]\/(.+)$/)
  if (columnMatch) {
    return { entity: 'column', entityId: Number(columnMatch[1]), field: columnMatch[2] }
  }
  return null
}

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

  // ── read() ────────────────────────────────────────────────────────────

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state':
        return this._readState()
      case 'schema':
        return ER_CANVAS_STATE_SCHEMA
      case 'actions':
        return ER_CANVAS_ACTIONS
    }
  }

  private _readState() {
    const { projects, tables, columns, relations, indexes } = useErDesignerStore.getState()
    const project = projects.find(p => p.id === this._projectId)

    return {
      projectId: this._projectId,
      projectName: project?.name ?? '',
      connectionId: project?.connection_id ?? null,
      tables: tables.map(t => ({
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
      relations: relations.map(r => ({
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
    for (const op of ops) {
      if (op.op !== 'replace') {
        return {
          status: 'error',
          message: `Unsupported patch op "${op.op}" — er_canvas patch only supports "replace"`,
        }
      }

      const parsed = parsePatchPath(op.path)
      if (!parsed) {
        return {
          status: 'error',
          message: `Cannot parse patch path "${op.path}". Expected format: /tables/[id=<n>]/<field> or /columns/[id=<n>]/<field>`,
        }
      }

      const field = resolveField(parsed.entity, parsed.field)
      const store = useErDesignerStore.getState()
      try {
        if (parsed.entity === 'table') {
          await store.updateTable(parsed.entityId, { [field]: op.value })
        } else {
          await store.updateColumn(parsed.entityId, { [field]: op.value })
        }
      } catch (e) {
        return { status: 'error', message: String(e) }
      }
    }

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
      return { success: false, error: String(e) }
    }
  }

  async exec(action: string, params?: any): Promise<ExecResult> {
    const store = useErDesignerStore.getState()

    switch (action) {
      // ── Table CRUD ──────────────────────────────────────────────────
      case 'add_table':
        return this.withReload(async () => {
          const position = params?.position ?? { x: 100, y: 100 }
          const table = await store.addTable(params.name, position)
          return { tableId: table.id }
        })

      case 'update_table':
        return this.withReload(() => store.updateTable(params.tableId, params.updates))

      case 'delete_table':
        return this.withReload(() => store.deleteTable(params.tableId))

      // ── Column CRUD ─────────────────────────────────────────────────
      case 'add_column':
        return this.withReload(async () => {
          const created = await store.addColumn(params.tableId, params.column)
          return { columnId: created.id }
        })

      case 'update_column':
        return this.withReload(() => store.updateColumn(params.columnId, params.updates))

      case 'delete_column':
        return this.withReload(() => store.deleteColumn(params.columnId, params.tableId))

      // ── Relation CRUD ───────────────────────────────────────────────
      case 'add_relation':
        return this.withReload(async () => {
          const created = await store.addRelation(params)
          return { relationId: created.id }
        })

      case 'update_relation':
        return this.withReload(() => store.updateRelation(params.relationId, params.updates))

      case 'delete_relation':
        return this.withReload(() => store.deleteRelation(params.relationId))

      // ── Index CRUD ──────────────────────────────────────────────────
      case 'add_index':
        return this.withReload(async () => {
          // AI passes columns as string[]; store expects JSON string
          const indexDef = { ...params.index }
          if (Array.isArray(indexDef.columns)) {
            indexDef.columns = JSON.stringify(indexDef.columns)
          }
          const created = await store.addIndex(params.tableId, indexDef)
          return { indexId: created.id }
        })

      case 'update_index':
        return this.withReload(() => store.updateIndex(params.indexId, params.updates))

      case 'delete_index':
        return this.withReload(() => store.deleteIndex(params.indexId, params.tableId))

      // ── Text result operations (no canvas reload needed) ────────────
      case 'generate_ddl':
        try {
          const ddl = await store.generateDDL(this._projectId, params.dialect, {
            includeIndexes: params.includeIndexes ?? true,
            includeComments: params.includeComments ?? true,
            includeForeignKeys: params.includeForeignKeys ?? true,
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

      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }
}
