import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the stores and tauri before importing the adapter
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockStore = {
  projects: [{ id: 1, name: 'Test', connection_id: null }],
  tables: [
    { id: 10, name: 'users', position_x: 0, position_y: 0 },
    { id: 20, name: 'orders', position_x: 100, position_y: 100 },
  ],
  columns: {
    10: [{ id: 100, name: 'id', data_type: 'INT', nullable: false, is_primary_key: true, is_auto_increment: true, is_unique: false, unsigned: false, default_value: null, comment: null, length: null, scale: null, enum_values: null, sort_order: 0 }],
    20: [{ id: 200, name: 'id', data_type: 'INT', nullable: false, is_primary_key: true, is_auto_increment: true, is_unique: false, unsigned: false, default_value: null, comment: null, length: null, scale: null, enum_values: null, sort_order: 0 }],
  },
  relations: [],
  indexes: { 10: [], 20: [] },
  updateTable: vi.fn(),
  updateColumn: vi.fn(),
  addColumn: vi.fn().mockResolvedValue({ id: 999 }),
  addIndex: vi.fn().mockResolvedValue({ id: 888 }),
  addTable: vi.fn(),
  addRelation: vi.fn(),
  deleteColumn: vi.fn(),
  deleteIndex: vi.fn(),
  deleteRelation: vi.fn(),
}

vi.mock('../../../store/erDesignerStore', () => ({
  useErDesignerStore: { getState: () => mockStore },
}))

import { ERCanvasAdapter } from '../adapters/ERCanvasAdapter'

describe('ERCanvasAdapter', () => {
  let adapter: ERCanvasAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new ERCanvasAdapter('project_1', 'Test Project', 1)
  })

  describe('patchCapabilities', () => {
    it('declares at least 6 capabilities', () => {
      expect(adapter.patchCapabilities).toBeDefined()
      expect(adapter.patchCapabilities!.length).toBeGreaterThanOrEqual(6)
    })

    it('every capability has pathPattern, ops, and description', () => {
      for (const cap of adapter.patchCapabilities!) {
        expect(cap.pathPattern).toBeTruthy()
        expect(cap.ops.length).toBeGreaterThan(0)
        expect(cap.description).toBeTruthy()
      }
    })
  })

  describe('read("schema") includes patchCapabilities', () => {
    it('includes patchCapabilities in schema response', () => {
      const schema = adapter.read('schema') as any
      expect(schema.patchCapabilities).toBeDefined()
      expect(schema.patchCapabilities.length).toBeGreaterThanOrEqual(6)
    })
  })

  describe('patch with name addressing', () => {
    it('replaces table field via [name=users]', async () => {
      const result = await adapter.patch([
        { op: 'replace', path: '/tables/[name=users]/comment', value: 'User accounts' },
      ])
      expect(result.status).toBe('applied')
      expect(mockStore.updateTable).toHaveBeenCalledWith(10, { comment: 'User accounts' })
    })

    it('returns descriptive error for non-existent table name', async () => {
      const result = await adapter.patch([
        { op: 'replace', path: '/tables/[name=nonexistent]/comment', value: 'x' },
      ])
      expect(result.status).toBe('error')
      expect(result.message).toContain('nonexistent')
      expect(result.message).toContain('Expected')
    })

    it('still supports [id=N] addressing', async () => {
      const result = await adapter.patch([
        { op: 'replace', path: '/tables/[id=10]/comment', value: 'Updated' },
      ])
      expect(result.status).toBe('applied')
      expect(mockStore.updateTable).toHaveBeenCalledWith(10, { comment: 'Updated' })
    })
  })

  describe('patch error messages use standardized format', () => {
    it('unsupported op includes Expected hint', async () => {
      const result = await adapter.patch([
        { op: 'move', path: '/tables/[id=10]', from: '/tables/[id=20]' } as any,
      ])
      expect(result.status).toBe('error')
      expect(result.message).toContain('Expected')
    })
  })

  describe('exec add_table uses adapter projectId', () => {
    it('calls store.addTable with this._projectId as first arg', async () => {
      const addTableMock = vi.fn().mockResolvedValue({
        id: 1, project_id: 1, name: 'foo', position_x: 100, position_y: 100,
        comment: null, color: null,
      })
      mockStore.addTable = addTableMock

      const result = await adapter.exec('add_table', { name: 'foo', position: { x: 100, y: 100 } })

      expect(result.success).toBe(true)
      expect(addTableMock).toHaveBeenCalledWith(1, 'foo', { x: 100, y: 100 })
    })
  })

  describe('exec add_relation uses adapter projectId', () => {
    it('calls store.addRelation with this._projectId as first arg', async () => {
      const addRelationMock = vi.fn().mockResolvedValue({ id: 5, project_id: 1 })
      mockStore.addRelation = addRelationMock

      const result = await adapter.exec('add_relation', {
        source_table_id: 10, source_column_id: 100,
        target_table_id: 20, target_column_id: 200,
        relation_type: 'one_to_many',
      })

      expect(result.success).toBe(true)
      expect(addRelationMock).toHaveBeenCalledWith(1, {
        source_table_id: 10, source_column_id: 100,
        target_table_id: 20, target_column_id: 200,
        relation_type: 'one_to_many',
      })
    })
  })
})
