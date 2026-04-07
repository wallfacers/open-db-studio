import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TableFormUIObject } from '../adapters/TableFormAdapter'
import { useTableFormStore } from '../../../store/tableFormStore'

vi.mock('../../../store/appStore', () => ({
  useAppStore: {
    getState: () => ({ autoMode: true }),
  },
}))

vi.mock('../../../store/patchConfirmStore', () => ({
  usePatchConfirmStore: {
    getState: () => ({ propose: vi.fn() }),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('../../../store/highlightStore', () => ({
  useHighlightStore: {
    getState: () => ({ addHighlights: vi.fn() }),
  },
}))

describe('TableFormUIObject', () => {
  const tabId = 'test_tab_1'

  beforeEach(() => {
    useTableFormStore.getState().initForm(tabId, {
      tableName: 'users',
      engine: 'InnoDB',
      charset: 'utf8mb4',
      comment: '',
      columns: [
        { id: 'c1', name: 'id', dataType: 'INT', isPrimaryKey: true, extra: 'auto_increment' },
        { id: 'c2', name: 'email', dataType: 'VARCHAR', length: '255' },
      ],
      indexes: [],
      foreignKeys: [],
    })
  })

  it('read state returns current form state', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const state = obj.read('state') as any
    expect(state.tableName).toBe('users')
    expect(state.columns).toHaveLength(2)
  })

  it('read schema returns JSON Schema', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const schema = obj.read('schema') as any
    expect(schema.properties.tableName).toBeDefined()
    expect(schema.properties.columns).toBeDefined()
    expect(schema.properties.columns.items['x-addressable-by']).toBe('name')
  })

  it('read actions returns action list', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const actions = obj.read('actions') as any[]
    expect(actions.map((a: any) => a.name)).toContain('preview_sql')
    expect(actions.map((a: any) => a.name)).toContain('save')
  })

  it('patch replaces tableName (auto mode)', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'replace', path: '/tableName', value: 'orders' },
    ])
    expect(result.status).toBe('applied')
    expect(useTableFormStore.getState().getForm(tabId)?.tableName).toBe('orders')
  })

  it('patch replaces column by [name=xxx]', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'replace', path: '/columns[name=email]/dataType', value: 'TEXT' },
    ])
    expect(result.status).toBe('applied')
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.columns.find(c => c.name === 'email')?.dataType).toBe('TEXT')
  })

  it('patch adds column to end', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'add', path: '/columns/-', value: { name: 'age', dataType: 'INT' } },
    ])
    expect(result.status).toBe('applied')
    expect(useTableFormStore.getState().getForm(tabId)?.columns).toHaveLength(3)
  })

  it('patch returns error for nonexistent form', () => {
    const obj = new TableFormUIObject('nonexistent', 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'replace', path: '/tableName', value: 'test' },
    ])
    expect(result.status).toBe('error')
  })
})

describe('TableFormUIObject - upsert on add', () => {
  const tabId = 'test_upsert'

  beforeEach(() => {
    useTableFormStore.getState().initForm(tabId, {
      tableName: 'users',
      engine: 'InnoDB',
      charset: 'utf8mb4',
      comment: '',
      columns: [
        { id: 'c1', name: 'id', dataType: 'INT', isPrimaryKey: true, extra: 'auto_increment', _isNew: true },
        { id: 'c2', name: 'email', dataType: 'VARCHAR', length: '255', _isNew: true },
      ],
      indexes: [],
      foreignKeys: [],
      isNewTable: true,
    })
  })

  it('add column with existing name upserts instead of duplicating', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'add', path: '/columns/-', value: { name: 'id', dataType: 'BIGINT', isPrimaryKey: true, extra: '' } },
    ])
    expect(result.status).toBe('applied')
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.columns).toHaveLength(2)
    expect(form.columns.find(c => c.name === 'id')?.dataType).toBe('BIGINT')
  })

  it('upsert preserves internal id and _isNew fields', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    obj.patchDirect([
      { op: 'add', path: '/columns/-', value: { name: 'id', dataType: 'BIGINT' } },
    ])
    const form = useTableFormStore.getState().getForm(tabId)!
    const idCol = form.columns.find(c => c.name === 'id')!
    expect(idCol.id).toBe('c1')
    expect(idCol._isNew).toBe(true)
  })

  it('add column with unique name appends normally', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'add', path: '/columns/-', value: { name: 'age', dataType: 'INT' } },
    ])
    expect(result.status).toBe('applied')
    expect(useTableFormStore.getState().getForm(tabId)!.columns).toHaveLength(3)
  })

  it('batch add with duplicate names in same patch upserts correctly', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'add', path: '/columns/-', value: { name: 'status', dataType: 'VARCHAR', length: '50' } },
      { op: 'add', path: '/columns/-', value: { name: 'status', dataType: 'INT' } },
    ])
    expect(result.status).toBe('applied')
    const form = useTableFormStore.getState().getForm(tabId)!
    const statusCols = form.columns.filter(c => c.name === 'status')
    expect(statusCols).toHaveLength(1)
    expect(statusCols[0].dataType).toBe('INT')
  })
})

describe('TableFormUIObject - remove column by name', () => {
  const tabId = 'test_remove'

  beforeEach(() => {
    useTableFormStore.getState().initForm(tabId, {
      tableName: 'orders',
      engine: 'InnoDB',
      charset: 'utf8mb4',
      comment: '',
      columns: [
        { id: 'c1', name: 'id', dataType: 'INT', isPrimaryKey: true, _isNew: true },
        { id: 'c2', name: 'amount', dataType: 'DECIMAL', length: '10,2', _isNew: true },
      ],
      indexes: [],
      foreignKeys: [],
      isNewTable: true,
    })
  })

  it('remove new column by name physically removes it', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'remove', path: '/columns[name=amount]' },
    ])
    expect(result.status).toBe('applied')
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.columns).toHaveLength(1)
    expect(form.columns[0].name).toBe('id')
  })

  it('remove existing column by name soft-deletes it', () => {
    // Set up as existing (not _isNew) column
    useTableFormStore.getState().initForm(tabId, {
      tableName: 'orders',
      engine: 'InnoDB',
      charset: 'utf8mb4',
      comment: '',
      columns: [
        { id: 'c1', name: 'id', dataType: 'INT', isPrimaryKey: true },
        { id: 'c2', name: 'amount', dataType: 'DECIMAL', length: '10,2' },
      ],
      originalColumns: [
        { id: 'c1', name: 'id', dataType: 'INT', isPrimaryKey: true },
        { id: 'c2', name: 'amount', dataType: 'DECIMAL', length: '10,2' },
      ],
      indexes: [],
      foreignKeys: [],
      isNewTable: false,
    })
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = obj.patchDirect([
      { op: 'remove', path: '/columns[name=amount]' },
    ])
    expect(result.status).toBe('applied')
    const form = useTableFormStore.getState().getForm(tabId)!
    // Column still in array but soft-deleted
    expect(form.columns).toHaveLength(2)
    expect(form.columns.find(c => c.name === 'amount')?._isDeleted).toBe(true)
  })
})

describe('TableFormUIObject - exec FK and index actions', () => {
  const tabId = 'test_exec_fk'

  beforeEach(() => {
    useTableFormStore.getState().initForm(tabId, {
      tableName: 'orders',
      engine: 'InnoDB',
      charset: 'utf8mb4',
      comment: '',
      columns: [
        { id: 'c1', name: 'id', dataType: 'BIGINT', isPrimaryKey: true, _isNew: true },
        { id: 'c2', name: 'user_id', dataType: 'BIGINT', _isNew: true },
      ],
      indexes: [
        { id: 'i1', name: 'idx_user_id', type: 'INDEX', columns: '[{"name":"user_id","order":"ASC"}]', _isNew: true },
        { id: 'i2', name: 'idx_status', type: 'INDEX', columns: '[{"name":"status","order":"ASC"}]' }, // existing (no _isNew)
      ],
      foreignKeys: [
        { id: 'fk1', constraintName: 'fk_orders_user_id', column: 'user_id', referencedTable: 'users', referencedColumn: 'id', onDelete: 'NO ACTION', onUpdate: 'NO ACTION', _isNew: true },
        { id: 'fk2', constraintName: 'fk_orders_product_id', column: 'product_id', referencedTable: 'products', referencedColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' }, // existing
      ],
      isNewTable: true,
    })
  })

  // ── add_foreign_key ────────────────────────────────────────────

  it('add_foreign_key adds FK with auto-generated constraintName', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_foreign_key', {
      column: 'category_id',
      referencedTable: 'categories',
      referencedColumn: 'id',
    })
    expect(result.success).toBe(true)
    expect(result.data.constraintName).toBe('fk_orders_category_id')
    const form = useTableFormStore.getState().getForm(tabId)!
    const fk = form.foreignKeys.find(f => f.constraintName === 'fk_orders_category_id')
    expect(fk).toBeDefined()
    expect(fk!.referencedTable).toBe('categories')
    expect(fk!.onDelete).toBe('NO ACTION')
    expect(fk!._isNew).toBe(true)
  })

  it('add_foreign_key uses explicit constraintName when provided', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_foreign_key', {
      constraintName: 'my_custom_fk',
      column: 'category_id',
      referencedTable: 'categories',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
    })
    expect(result.success).toBe(true)
    expect(result.data.constraintName).toBe('my_custom_fk')
    const form = useTableFormStore.getState().getForm(tabId)!
    const fk = form.foreignKeys.find(f => f.constraintName === 'my_custom_fk')!
    expect(fk.onDelete).toBe('CASCADE')
  })

  it('add_foreign_key returns error when required params missing', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_foreign_key', { column: 'category_id' })
    expect(result.success).toBe(false)
  })

  // ── update_foreign_key ─────────────────────────────────────────

  it('update_foreign_key changes onDelete on an existing FK', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_foreign_key', {
      constraintName: 'fk_orders_user_id',
      onDelete: 'CASCADE',
    })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.foreignKeys.find(f => f.constraintName === 'fk_orders_user_id')!.onDelete).toBe('CASCADE')
  })

  it('update_foreign_key returns error when constraintName missing', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_foreign_key', { onDelete: 'CASCADE' })
    expect(result.success).toBe(false)
  })

  it('update_foreign_key returns error when no valid fields provided', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_foreign_key', { constraintName: 'fk_orders_user_id' })
    expect(result.success).toBe(false)
  })

  it('update_foreign_key returns error when constraintName not found', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_foreign_key', {
      constraintName: 'nonexistent_fk',
      onDelete: 'CASCADE',
    })
    expect(result.success).toBe(false)
  })

  // ── remove_foreign_key ─────────────────────────────────────────

  it('remove_foreign_key physically removes a _isNew FK', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_foreign_key', { constraintName: 'fk_orders_user_id' })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.foreignKeys.find(f => f.constraintName === 'fk_orders_user_id')).toBeUndefined()
  })

  it('remove_foreign_key soft-deletes an existing FK (no _isNew)', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_foreign_key', { constraintName: 'fk_orders_product_id' })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    const fk = form.foreignKeys.find(f => f.constraintName === 'fk_orders_product_id')
    expect(fk).toBeDefined()
    expect(fk!._isDeleted).toBe(true)
  })

  it('remove_foreign_key returns error for unknown constraintName', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_foreign_key', { constraintName: 'nonexistent_fk' })
    expect(result.success).toBe(false)
  })

  // ── add_index ──────────────────────────────────────────────────

  it('add_index adds index with auto-generated name', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_index', {
      columns: ['email', 'status'],
    })
    expect(result.success).toBe(true)
    expect(result.data.name).toBe('idx_email_status')
    const form = useTableFormStore.getState().getForm(tabId)!
    const idx = form.indexes.find(i => i.name === 'idx_email_status')!
    expect(idx).toBeDefined()
    expect(idx.type).toBe('INDEX')
    expect(idx._isNew).toBe(true)
    // columns stored as JSON string
    const cols = JSON.parse(idx.columns)
    expect(cols[0].name).toBe('email')
    expect(cols[1].name).toBe('status')
  })

  it('add_index uses explicit name and type', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_index', {
      name: 'idx_email_unique',
      columns: ['email'],
      type: 'UNIQUE',
    })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    const idx = form.indexes.find(i => i.name === 'idx_email_unique')!
    expect(idx.type).toBe('UNIQUE')
  })

  it('add_index returns error when columns missing', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_index', { name: 'idx_test' })
    expect(result.success).toBe(false)
  })

  // ── update_index ───────────────────────────────────────────────

  it('update_index changes type', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_index', {
      name: 'idx_user_id',
      type: 'UNIQUE',
    })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.indexes.find(i => i.name === 'idx_user_id')!.type).toBe('UNIQUE')
  })

  it('update_index changes columns (converts string[] to JSON string)', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_index', {
      name: 'idx_user_id',
      columns: ['user_id', 'created_at'],
    })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    const idx = form.indexes.find(i => i.name === 'idx_user_id')!
    const cols = JSON.parse(idx.columns)
    expect(cols).toHaveLength(2)
    expect(cols[0].name).toBe('user_id')
    expect(cols[1].name).toBe('created_at')
  })

  it('update_index returns error when name missing', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_index', { type: 'UNIQUE' })
    expect(result.success).toBe(false)
  })

  it('update_index returns error when name not found', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_index', {
      name: 'nonexistent_idx',
      type: 'UNIQUE',
    })
    expect(result.success).toBe(false)
  })

  // ── remove_index ───────────────────────────────────────────────

  it('remove_index physically removes a _isNew index', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_index', { name: 'idx_user_id' })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.indexes.find(i => i.name === 'idx_user_id')).toBeUndefined()
  })

  it('remove_index soft-deletes an existing index (no _isNew)', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_index', { name: 'idx_status' })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    const idx = form.indexes.find(i => i.name === 'idx_status')
    expect(idx).toBeDefined()
    expect(idx!._isDeleted).toBe(true)
  })

  it('remove_index returns error for unknown index name', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_index', { name: 'nonexistent_idx' })
    expect(result.success).toBe(false)
  })

  // ── read actions includes all 8 actions ────────────────────────

  it('read actions includes all 8 actions including 6 new ones', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const actions = obj.read('actions') as any[]
    const names = actions.map((a: any) => a.name)
    expect(names).toContain('preview_sql')
    expect(names).toContain('save')
    expect(names).toContain('add_foreign_key')
    expect(names).toContain('update_foreign_key')
    expect(names).toContain('remove_foreign_key')
    expect(names).toContain('add_index')
    expect(names).toContain('update_index')
    expect(names).toContain('remove_index')
  })
})
