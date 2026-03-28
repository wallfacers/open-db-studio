import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
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
import { useERKeyboard } from '../hooks/useERKeyboard'
import { useUIObjectRegistry } from '../../../mcp/ui/useUIObjectRegistry'
import { ERCanvasAdapter } from '../../../mcp/ui/adapters/ERCanvasAdapter'
import { layoutNodesWithDagre } from '../utils/dagreLayout'
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

interface ERCanvasProps {
  projectId: number;
  tabId?: string;
}

export default function ERCanvas({ projectId, tabId }: ERCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const rfInstance = useRef<ReactFlowInstance<Node<NodeData>, Edge> | null>(null)

  const [showDDL, setShowDDL] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showBind, setShowBind] = useState(false)

  // Register UIObject for MCP ui_list discovery
  const projectName = useErDesignerStore(s => s.projects.find(p => p.id === projectId)?.name)
  const erUIObject = useMemo(() => {
    if (!tabId) return null
    return new ERCanvasAdapter(tabId, projectName ?? `ER Project #${projectId}`, projectId)
  }, [tabId, projectId, projectName])
  useUIObjectRegistry(erUIObject)

  // Select only the actions and state values needed (stable references for actions)
  const loadProject = useErDesignerStore(s => s.loadProject)
  const updateTable = useErDesignerStore(s => s.updateTable)
  const addColumn = useErDesignerStore(s => s.addColumn)
  const updateColumn = useErDesignerStore(s => s.updateColumn)
  const deleteColumn = useErDesignerStore(s => s.deleteColumn)
  const deleteTable = useErDesignerStore(s => s.deleteTable)
  const addRelation = useErDesignerStore(s => s.addRelation)
  const syncFromDatabase = useErDesignerStore(s => s.syncFromDatabase)

  // State values for rendering
  const projects = useErDesignerStore(s => s.projects)
  const tables = useErDesignerStore(s => s.tables)

  const activeProject = projects.find(p => p.id === projectId) ?? null
  const hasConnection = !!activeProject?.connection_id

  // deps: ONLY stable action refs, setNodes, setEdges — NOT table or cols (they're function params)
  const buildNodeData = useCallback((table: ErTable, cols: ErColumn[]): NodeData => ({
    table,
    columns: cols,
    onUpdateTable: (updates: Partial<ErTable>) => updateTable(table.id, updates),
    onAddColumn: () => addColumn(table.id, {
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
      updateColumn(colId, updates),
    onDeleteColumn: (colId: number) => {
      deleteColumn(colId, table.id)
      setNodes(nds => nds.map(n =>
        n.id === `table-${table.id}`
          ? { ...n, data: { ...n.data, columns: (n.data.columns as ErColumn[]).filter(c => c.id !== colId) } }
          : n
      ))
    },
    onDeleteTable: () => {
      deleteTable(table.id)
      setNodes(nds => nds.filter(n => n.id !== `table-${table.id}`))
      setEdges(eds => eds.filter(e =>
        e.source !== `table-${table.id}` && e.target !== `table-${table.id}`
      ))
    },
  }), [updateTable, addColumn, updateColumn, deleteColumn, deleteTable, setNodes, setEdges])

  const reloadCanvas = useCallback(() => {
    loadProject(projectId).then(() => {
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
  }, [projectId, buildNodeData, setNodes, setEdges, loadProject])

  useEffect(() => {
    reloadCanvas()
  }, [reloadCanvas])

  // Refs for nodes/edges so MCP event listeners don't re-subscribe on every render
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  // Ref-based listener cleanup to handle async unregistration correctly
  const unlistenFns = useRef<UnlistenFn[]>([])

  // MCP-triggered canvas operations via Tauri events
  useEffect(() => {
    // Cleanup previous listeners before registering new ones
    unlistenFns.current.forEach(fn => fn())
    unlistenFns.current = []

    // MCP adapter emits this after any CRUD operation
    listen('er-canvas-reload', (event: { payload: { projectId: number } }) => {
      if (event.payload.projectId === projectId) {
        reloadCanvas()
      }
    }).then(fn => { unlistenFns.current.push(fn) })

    // MCP adapter triggers dialog opening
    listen('er-canvas-open-dialog', (event: { payload: { projectId: number; dialog: string } }) => {
      if (event.payload.projectId === projectId) {
        if (event.payload.dialog === 'import') setShowImport(true)
        else if (event.payload.dialog === 'bind') setShowBind(true)
      }
    }).then(fn => { unlistenFns.current.push(fn) })

    // MCP adapter triggers auto-layout via shared dagre utility
    listen('er-canvas-auto-layout', (event: { payload: { projectId: number } }) => {
      if (event.payload.projectId !== projectId) return

      const currentNodes = nodesRef.current
      const currentEdges = edgesRef.current
      if (currentNodes.length === 0) return

      try {
        const layoutedNodes = layoutNodesWithDagre(currentNodes, currentEdges) as Node<NodeData>[]
        setNodes(layoutedNodes)
      } catch (e) {
        console.error('MCP auto layout failed:', e)
      }
    }).then(fn => { unlistenFns.current.push(fn) })

    return () => {
      unlistenFns.current.forEach(fn => fn())
      unlistenFns.current = []
    }
  }, [projectId, reloadCanvas, setNodes])

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    const tableId = parseInt(node.id.replace('table-', ''))
    updateTable(tableId, { position_x: node.position.x, position_y: node.position.y })
  }, [updateTable])

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
    addRelation({
      source_table_id: sourceTableId,
      source_column_id: sourceColumnId,
      target_table_id: targetTableId,
      target_column_id: targetColumnId,
      relation_type: 'one_to_many',
      source: 'designer'
    })
  }, [setEdges, addRelation])

  const handleTableAdded = useCallback((table: ErTable) => {
    setNodes(nds => [...nds, {
      id: `table-${table.id}`,
      type: 'erTable',
      position: { x: table.position_x, y: table.position_y },
      data: buildNodeData(table, []),
    }])
  }, [setNodes, buildNodeData])

  // Integrate keyboard shortcuts
  useERKeyboard({
    nodes,
    edges,
    selectedNodes: [],
    selectedEdges: [],
    onAutoLayout: () => {},
    onExportDDL: () => setShowDDL(true),
  })

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
        tables={tables}
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
        onSyncFromDb={(_changes) => { syncFromDatabase(projectId).then(reloadCanvas) }}
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
