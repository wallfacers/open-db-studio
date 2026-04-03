import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

import { invoke } from '@tauri-apps/api/core'
import { useErDesignerStore } from './erDesignerStore'

describe('erDesignerStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useErDesignerStore.setState({
      tables: [],
      columns: {},
      indexes: {},
      undoStack: [],
      redoStack: [],
    })
  })

  describe('addTable', () => {
    it('传入显式 projectId 而非读取 activeProjectId', async () => {
      const mockTable = {
        id: 1, project_id: 99, name: 'foo',
        position_x: 10, position_y: 20,
        comment: null, color: null,
      }
      vi.mocked(invoke).mockResolvedValue(mockTable)

      await useErDesignerStore.getState().addTable(99, 'foo', { x: 10, y: 20 })

      expect(invoke).toHaveBeenCalledWith('er_create_table', {
        req: { project_id: 99, name: 'foo', position_x: 10, position_y: 20 },
      })
    })
  })

  describe('addRelation', () => {
    it('传入显式 projectId 而非读取 activeProjectId', async () => {
      const mockRelation = {
        id: 5, project_id: 42,
        source_table_id: 1, source_column_id: 10,
        target_table_id: 2, target_column_id: 20,
        relation_type: 'one_to_many', name: null,
        on_delete: 'NO ACTION', on_update: 'NO ACTION', source: 'designer',
      }
      vi.mocked(invoke).mockResolvedValue(mockRelation)

      await useErDesignerStore.getState().addRelation(42, {
        source_table_id: 1, source_column_id: 10,
        target_table_id: 2, target_column_id: 20,
        relation_type: 'one_to_many',
      })

      expect(invoke).toHaveBeenCalledWith('er_create_relation', {
        req: {
          project_id: 42,
          source_table_id: 1, source_column_id: 10,
          target_table_id: 2, target_column_id: 20,
          relation_type: 'one_to_many',
        },
      })
    })
  })
})
