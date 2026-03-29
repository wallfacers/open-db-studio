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
          { name: 'expand', description: 'Expand a tree node by its ID (loads children if needed)', paramsSchema: { nodeId: 'string' } },
          { name: 'select', description: 'Select/highlight a tree node by its ID', paramsSchema: { nodeId: 'string' } },
          {
            name: 'locate_table',
            description: 'Expand the tree path to a specific table and select it. Loads all ancestor nodes automatically.',
            paramsSchema: { connection_id: 'number', database: 'string', table: 'string', schema: 'string (optional, for postgres/oracle)' },
          },
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
      case 'expand': {
        const nodeId = params?.nodeId
        if (!nodeId) return { success: false, error: 'nodeId is required' }
        const store = useTreeStore.getState()
        if (!store.nodes.has(nodeId)) return { success: false, error: `Node not found: ${nodeId}` }
        if (!store.expandedIds.has(nodeId)) {
          store.toggleExpand(nodeId)
        }
        return { success: true }
      }
      case 'select': {
        const nodeId = params?.nodeId
        if (!nodeId) return { success: false, error: 'nodeId is required' }
        const store = useTreeStore.getState()
        if (!store.nodes.has(nodeId)) return { success: false, error: `Node not found: ${nodeId}` }
        store.selectNode(nodeId)
        return { success: true }
      }
      case 'locate_table': {
        const connId = params?.connection_id
        const database = params?.database
        const table = params?.table
        const schema = params?.schema
        if (!connId || !table) return { success: false, error: 'connection_id and table are required' }

        // Build the expected node path and expand each ancestor
        const connNodeId = `conn_${connId}`
        const expandAndLoad = async (nodeId: string) => {
          const s = useTreeStore.getState()
          if (!s.nodes.has(nodeId)) return false
          if (!s.expandedIds.has(nodeId)) {
            s.toggleExpand(nodeId)
            // Wait for children to load (with 10s timeout)
            await new Promise<void>((resolve) => {
              let elapsed = 0
              const check = () => {
                if (!useTreeStore.getState().loadingIds.has(nodeId) || elapsed >= 10000) { resolve(); return }
                elapsed += 50
                setTimeout(check, 50)
              }
              check()
            })
          } else if (!s.nodes.get(nodeId)!.loaded) {
            await s.loadChildren(nodeId)
          }
          return true
        }

        // 1. Expand connection
        if (!(await expandAndLoad(connNodeId))) return { success: false, error: `Connection node not found: ${connNodeId}` }

        // 2. Expand database (if provided)
        let parentId = connNodeId
        if (database) {
          const dbNodeId = `${connNodeId}/db_${database}`
          if (!useTreeStore.getState().nodes.has(dbNodeId)) {
            return { success: false, error: `Database not found: ${database}` }
          }
          if (!(await expandAndLoad(dbNodeId))) return { success: false, error: `Failed to expand database: ${database}` }
          parentId = dbNodeId
        }

        // 3. Expand schema (if provided, for postgres/oracle)
        if (schema) {
          const schemaNodeId = `${parentId}/schema_${schema}`
          if (!useTreeStore.getState().nodes.has(schemaNodeId)) {
            return { success: false, error: `Schema not found: ${schema}` }
          }
          if (!(await expandAndLoad(schemaNodeId))) return { success: false, error: `Failed to expand schema: ${schema}` }
          parentId = schemaNodeId
        }

        // 4. Expand "Tables" category
        const catNodeId = `${parentId}/cat_tables`
        if (!(await expandAndLoad(catNodeId))) return { success: false, error: `Tables category not found under ${parentId}` }

        // 5. Select the table node
        const tableNodeId = `${catNodeId}/table_${table}`
        if (!useTreeStore.getState().nodes.has(tableNodeId)) {
          return { success: false, error: `Table node not found: ${table}` }
        }
        useTreeStore.getState().selectNode(tableNodeId)
        return { success: true, data: { nodeId: tableNodeId } }
      }
      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }
}
