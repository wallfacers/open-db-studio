import { useRef, useState, useEffect, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useErDesignerStore } from '../../../store/erDesignerStore'
import ERTableNode from './ERTableNode'
import EREdge from './EREdge'
import ERToolbar from './ERToolbar'
import { DDLPreviewDialog } from '../dialogs/DDLPreviewDialog'
import { DiffReportDialog } from '../dialogs/DiffReportDialog'
import { BindConnectionDialog } from '../dialogs/BindConnectionDialog'
import { ImportTableDialog } from '../dialogs/ImportTableDialog'
import type { ErTable, ErColumn } from '../../../types'

const nodeTypes = {
  erTable: ERTableNode,
}

const edgeTypes = {
  erEdge: EREdge,
}

interface NodeData {
  table: ErTable
  columns: ErColumn[]
  onUpdateTable: (updates: Partial<ErTable>) => void
  onAddColumn: () => void
  onUpdateColumn: (colId: number, updates: Partial<ErColumn>) => void
  onDeleteColumn: (colId: number) => void
  onDeleteTable: () => void
  [key: string]: unknown
}

export default function ERCanvas({ projectId }: { projectId: number }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const rfInstance = useRef<ReactFlowInstance<Node<NodeData>, Edge> | null>(null)

  const [showDDL, setShowDDL] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showBind, setShowBind] = useState(false)

  const store = useErDesignerStore()
  const activeProject = store.projects.find(p => p.id === projectId) ?? null
  const hasConnection = !!activeProject?.connection_id

  // deps: ONLY store, setNodes, setEdges — NOT table or cols (they're function params)
  const buildNodeData = useCallback((table: ErTable, cols: ErColumn[]): NodeData => ({
    table,
    columns: cols,
    onUpdateTable: (updates: Partial<ErTable>) => store.updateTable(table.id, updates),
    onAddColumn: () => store.addColumn(table.id, {
      name: `column_${(cols.length || 0) + 1}`,
      data_type: 'VARCHAR',
      nullable: true,
      default_value: null,
      is_primary_key: false,
      is_auto_increment: false,
      comment: null,
      sort_order: cols.length || 0,
    }),
    onUpdateColumn: (colId: number, updates: Partial<ErColumn>) =>
      store.updateColumn(colId, updates),
    onDeleteColumn: (colId: number) => {
      store.deleteColumn(colId, table.id)
      setNodes(nds => nds.map(n =>
        n.id === `table-${table.id}`
          ? { ...n, data: { ...n.data, columns: (n.data.columns as ErColumn[]).filter(c => c.id !== colId) } }
          : n
      ))
    },
    onDeleteTable: () => {
      store.deleteTable(table.id)
      setNodes(nds => nds.filter(n => n.id !== `table-${table.id}`))
      setEdges(eds => eds.filter(e =>
        e.source !== `table-${table.id}` && e.target !== `table-${table.id}`
      ))
    },
  }), [store, setNodes, setEdges])  // ← ONLY these deps

  const reloadCanvas = useCallback(() => {
    store.loadProject(projectId).then(() => {
      const state = useErDesignerStore.getState()
      const newNodes: Node<NodeData>[] = state.tables.map((table) => ({
        id: `table-${table.id}`,
        type: 'erTable',
        position: { x: table.position_x, y: table.position_y },
        data: buildNodeData(table, state.columns[table.id] || []),
      }))
      const newEdges = state.relations.map((rel) => ({
        id: `edge-${rel.id}`,
        source: `table-${rel.source_table_id}`,
        sourceHandle: `${rel.source_column_id}-source`,
        target: `table-${rel.target_table_id}`,
        targetHandle: `${rel.target_column_id}-target`,
        type: 'erEdge',
        data: { relation_type: rel.relation_type, source_type: rel.source },
      }))
      setNodes(newNodes)
      setEdges(newEdges)
    })
  }, [projectId, buildNodeData, setNodes, setEdges, store])

  useEffect(() => {
    reloadCanvas()
  }, [reloadCanvas])

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    const tableId = parseInt(node.id.replace('table-', ''))
    store.updateTable(tableId, { position_x: node.position.x, position_y: node.position.y })
  }, [store])

  // IMPORTANT: relation_type must be 'one_to_many' (not '1:N')
  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) => addEdge({
      ...connection,
      type: 'erEdge',
      data: { relation_type: 'one_to_many', source_type: 'designer' }
    }, eds))
    const sourceColumnId = parseInt(connection.sourceHandle!.replace('-source', ''))
    const targetColumnId = parseInt(connection.targetHandle!.replace('-target', ''))
    const sourceTableId = parseInt(connection.source!.replace('table-', ''))
    const targetTableId = parseInt(connection.target!.replace('table-', ''))
    store.addRelation({
      source_table_id: sourceTableId,
      source_column_id: sourceColumnId,
      target_table_id: targetTableId,
      target_column_id: targetColumnId,
      relation_type: 'one_to_many',
      source: 'designer'
    })
  }, [setEdges, store])

  const handleTableAdded = useCallback((table: ErTable) => {
    setNodes(nds => [...nds, {
      id: `table-${table.id}`,
      type: 'erTable',
      position: { x: table.position_x, y: table.position_y },
      data: buildNodeData(table, []),
    }])
  }, [setNodes, buildNodeData])

  // connectionInfo for DiffReportDialog
  const connectionInfo = activeProject?.connection_id
    ? { name: `Connection ${activeProject.connection_id}`, database: activeProject.database_name ?? '' }
    : null

  return (
    <div className="w-full h-full flex flex-col">
      <ERToolbar
        projectId={projectId}
        onOpenDDL={() => setShowDDL(true)}
        onOpenDiff={() => { if (hasConnection) setShowDiff(true) }}
        onOpenImport={() => setShowImport(true)}
        onOpenBind={() => setShowBind(true)}
        onTableAdded={handleTableAdded}
        setNodes={setNodes as (nodes: Node[]) => void}
        nodes={nodes}
        tables={store.tables}
      />
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onInit={(i) => { rfInstance.current = i }}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
        >
          <Background color="#253347" gap={20} />
          <Controls />
          <MiniMap nodeColor="#111922" nodeStrokeColor="#253347" />
        </ReactFlow>
      </div>

      <DDLPreviewDialog
        visible={showDDL}
        projectId={projectId}
        hasConnection={hasConnection}
        onClose={() => setShowDDL(false)}
        onExecute={(_ddl) => { /* TODO: invoke execute_query */ }}
      />
      <DiffReportDialog
        visible={showDiff}
        projectId={projectId}
        connectionInfo={connectionInfo}
        onClose={() => setShowDiff(false)}
        onSyncToDb={(_changes) => { /* Phase 3 stub */ }}
        onSyncFromDb={(_changes) => { store.syncFromDatabase(projectId).then(reloadCanvas) }}
      />
      <BindConnectionDialog
        visible={showBind}
        projectId={projectId}
        onClose={() => setShowBind(false)}
        onBound={() => setShowBind(false)}
      />
      <ImportTableDialog
        visible={showImport}
        projectId={projectId}
        connectionId={activeProject?.connection_id ?? null}
        databaseName={activeProject?.database_name ?? null}
        onClose={() => setShowImport(false)}
        onImported={() => { setShowImport(false); reloadCanvas() }}
      />
    </div>
  )
}
