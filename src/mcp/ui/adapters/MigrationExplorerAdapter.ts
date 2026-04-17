import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { execError } from '../errors'
import { useMigrationStore } from '../../../store/migrationStore'

export class MigrationExplorerAdapter implements UIObject {
  type = 'migration_explorer'
  objectId = 'migration_explorer'
  title = 'Migration Explorer'

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state': {
        const { nodes } = useMigrationStore.getState()
        const items: any[] = []
        for (const [, node] of nodes) {
          const numericId = node.nodeType === 'category'
            ? Number(node.id.replace('cat_', ''))
            : Number(node.id.replace('job_', ''))
          const numericParentId = node.parentId
            ? Number(node.parentId.replace('cat_', ''))
            : null
          items.push({
            nodeType: node.nodeType,
            id: numericId,
            label: node.label,
            parentId: numericParentId,
            ...(node.nodeType === 'job' ? { jobId: node.jobId, status: node.status } : {}),
          })
        }
        return { nodes: items }
      }
      case 'schema':
        return {
          type: 'object',
          properties: {
            nodes: {
              type: 'array',
              description: 'All migration categories and jobs in the sidebar tree',
              items: {
                type: 'object',
                properties: {
                  nodeType: { type: 'string', enum: ['category', 'job'] },
                  id: { type: 'number', description: 'Numeric ID used in exec actions' },
                  label: { type: 'string' },
                  parentId: { type: ['number', 'null'], description: 'Parent category ID, null = root' },
                  jobId: { type: 'number', description: 'Job ID (job nodes only)' },
                  status: { type: 'string', description: 'Last run status (job nodes only)' },
                },
              },
            },
          },
        }
      case 'actions':
        return [
          {
            name: 'create_category',
            description: 'Create a new migration category',
            paramsSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Category name' },
                parent_id: { type: 'number', description: 'Parent category ID (omit for root)' },
              },
              required: ['name'],
            },
          },
          {
            name: 'rename_category',
            description: 'Rename a migration category',
            paramsSchema: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'Category ID' },
                name: { type: 'string', description: 'New name' },
              },
              required: ['id', 'name'],
            },
          },
          {
            name: 'delete_category',
            description: 'Delete a migration category (must be empty)',
            paramsSchema: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'Category ID' },
              },
              required: ['id'],
            },
          },
          {
            name: 'create_job',
            description: 'Create a new migration job',
            paramsSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Job name' },
                category_id: { type: 'number', description: 'Parent category ID (omit for root)' },
              },
              required: ['name'],
            },
          },
          {
            name: 'rename_job',
            description: 'Rename a migration job',
            paramsSchema: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'Job ID' },
                name: { type: 'string', description: 'New name' },
              },
              required: ['id', 'name'],
            },
          },
          {
            name: 'delete_job',
            description: 'Delete a migration job',
            paramsSchema: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'Job ID' },
              },
              required: ['id'],
            },
          },
          {
            name: 'move_job',
            description: 'Move a job to a category or to root',
            paramsSchema: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'Job ID' },
                category_id: { type: ['number', 'null'], description: 'Target category ID; null or omit to move to root' },
              },
              required: ['id'],
            },
          },
          {
            name: 'move_category',
            description: 'Move a category to another parent or to root',
            paramsSchema: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'Category ID' },
                parent_id: { type: ['number', 'null'], description: 'Target parent category ID; null or omit to move to root' },
              },
              required: ['id'],
            },
          },
        ]
    }
  }

  patch(_ops: JsonPatchOp[]): PatchResult {
    return { status: 'error', message: 'migration_explorer does not support patch; use ui_exec instead' }
  }

  async exec(action: string, params?: any): Promise<ExecResult> {
    const store = useMigrationStore.getState()
    try {
      switch (action) {
        case 'create_category': {
          await store.createCategory(params.name, params.parent_id ?? undefined)
          return { success: true }
        }
        case 'rename_category': {
          await store.renameCategory(params.id, params.name)
          return { success: true }
        }
        case 'delete_category': {
          await store.deleteCategory(params.id)
          return { success: true }
        }
        case 'create_job': {
          const jobId = await store.createJob(params.name, params.category_id ?? undefined)
          return { success: true, data: { job_id: jobId } }
        }
        case 'rename_job': {
          await store.renameJob(params.id, params.name)
          return { success: true }
        }
        case 'delete_job': {
          await store.deleteJob(params.id)
          return { success: true }
        }
        case 'move_job': {
          await store.moveJob(params.id, params.category_id ?? null)
          return { success: true }
        }
        case 'move_category': {
          await store.moveCategory(params.id, params.parent_id ?? null)
          return { success: true }
        }
        default:
          return execError(
            `Unknown action: ${action}`,
            'Available: create_category, rename_category, delete_category, create_job, rename_job, delete_job, move_job, move_category',
          )
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
}
