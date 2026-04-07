import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'
import { patchError, execError } from '../errors'
import { useTreeStore } from '../../../store/treeStore'
import { connNodeId as connNid, dbNodeId, schemaNodeId, catNodeId, objectNodeId } from '../../../utils/nodeId'

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
          {
            name: 'search',
            description: 'Search tree nodes by keyword and optional type/connection filter',
            paramsSchema: {
              type: 'object',
              properties: {
                keyword: { type: 'string', description: 'Search keyword' },
                type: { type: 'string', description: 'Node type filter: table, view, procedure' },
                connection_id: { type: 'number', description: 'Limit search to a specific connection' },
              },
              required: ['keyword'],
            },
          },
          {
            name: 'refresh',
            description: 'Refresh tree data (reload all connections)',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'expand',
            description: 'Expand a tree node by its ID (loads children if needed)',
            paramsSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: 'Tree node ID to expand' },
              },
              required: ['nodeId'],
            },
          },
          {
            name: 'select',
            description: 'Select/highlight a tree node by its ID',
            paramsSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: 'Tree node ID to select' },
              },
              required: ['nodeId'],
            },
          },
          {
            name: 'locate_table',
            description: 'Expand the tree path to a specific table and select it. Loads all ancestor nodes automatically.',
            paramsSchema: {
              type: 'object',
              properties: {
                connection_id: { type: 'number', description: 'Database connection ID' },
                database: { type: 'string', description: 'Database name' },
                table: { type: 'string', description: 'Table name' },
                schema: { type: 'string', description: 'Schema name (optional, for postgres/oracle)' },
              },
              required: ['connection_id', 'table'],
            },
          },
        ]
    }
  }

  patch(_ops: JsonPatchOp[]): PatchResult {
    return patchError('db_tree does not support patch')
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
        const connNidVal = connNid(connId)
        const expandAndLoad = async (nodeId: string): Promise<string | true> => {
          const s = useTreeStore.getState()
          if (!s.nodes.has(nodeId)) return `Node not found: ${nodeId}`
          if (!s.expandedIds.has(nodeId)) {
            s.toggleExpand(nodeId)
            await new Promise<void>((resolve) => {
              if (!useTreeStore.getState().loadingIds.has(nodeId)) { resolve(); return }
              const timeout = setTimeout(() => { unsub(); resolve() }, 10000)
              const unsub = useTreeStore.subscribe((state) => {
                if (!state.loadingIds.has(nodeId)) { unsub(); clearTimeout(timeout); resolve() }
              })
            })
          } else if (!s.nodes.get(nodeId)!.loaded) {
            await s.loadChildren(nodeId)
          }
          return true
        }

        let result = await expandAndLoad(connNidVal)
        if (result !== true) return { success: false, error: `Connection node not found: ${connNidVal}` }

        let parentId = connNidVal
        if (database) {
          const dbNid = dbNodeId(connNidVal, database)
          result = await expandAndLoad(dbNid)
          if (result !== true) return { success: false, error: `Database not found: ${database}` }
          parentId = dbNid
        }

        if (schema) {
          const schemaNid = schemaNodeId(parentId, schema)
          result = await expandAndLoad(schemaNid)
          if (result !== true) return { success: false, error: `Schema not found: ${schema}` }
          parentId = schemaNid
        }

        const catNid = catNodeId(parentId, 'tables')
        result = await expandAndLoad(catNid)
        if (result !== true) return { success: false, error: `Tables category not found under ${parentId}` }

        const tableNodeId = objectNodeId(catNid, 'table', table)
        if (!useTreeStore.getState().nodes.has(tableNodeId)) {
          return { success: false, error: `Table node not found: ${table}` }
        }
        useTreeStore.getState().selectNode(tableNodeId)
        return { success: true, data: { nodeId: tableNodeId } }
      }
      default:
        return execError(`Unknown action: ${action}`, 'Available actions: search, refresh, expand, select, locate_table')
    }
  }
}
