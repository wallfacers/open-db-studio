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
