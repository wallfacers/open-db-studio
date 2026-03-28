import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { useTreeStore } from '../../../store/treeStore'

export class DbTreeAdapter implements UIObject {
  type = 'db_tree'
  objectId = 'db_tree'
  title = 'Database Tree'

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state': {
        const { nodes } = useTreeStore.getState()
        const items: any[] = []
        for (const [, node] of nodes) {
          items.push({
            id: node.id,
            label: node.label,
            nodeType: node.nodeType,
            connectionId: node.meta?.connectionId,
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
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  nodeType: { type: 'string' },
                  connectionId: { type: 'number' },
                },
              },
            },
          },
        }
      case 'actions':
        return [
          { name: 'search', description: 'Search tree nodes by keyword', paramsSchema: { keyword: 'string', type: 'string', connection_id: 'number' } },
          { name: 'refresh', description: 'Refresh tree data' },
        ]
    }
  }

  patch(_ops: JsonPatchOp[]): PatchResult {
    return { status: 'error', message: 'db_tree does not support patch' }
  }

  async exec(action: string, params?: any): Promise<ExecResult> {
    switch (action) {
      case 'search': {
        const { nodes } = useTreeStore.getState()
        const keyword = params?.keyword?.toLowerCase() ?? ''
        const type = params?.type
        const connId = params?.connection_id

        const results: any[] = []
        for (const [, node] of nodes) {
          if (type && node.nodeType !== type) continue
          if (connId && node.meta?.connectionId !== connId) continue
          if (keyword && !node.label.toLowerCase().includes(keyword)) continue
          results.push({
            id: node.id,
            label: node.label,
            nodeType: node.nodeType,
            connectionId: node.meta?.connectionId,
          })
        }
        return { success: true, data: results }
      }
      case 'refresh': {
        const { init } = useTreeStore.getState()
        await init()
        return { success: true }
      }
      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }
}
