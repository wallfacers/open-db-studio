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
