import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type ReactFlowInstance,
  ReactFlowProvider,
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
import { erTableNodeId, erEdgeNodeId, parseErTableNodeId, parseErEdgeNodeId } from '../../../utils/nodeId'

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

function ERCanvasInner({ projectId, tabId }: ERCanvasProps) {
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
  const relations = useErDesignerStore(s => s.relations)
  const columns = useErDesignerStore(s => s.columns)

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
        n.id === erTableNodeId(table.id)
          ? { ...n, data: { ...n.data, columns: (n.data.columns as ErColumn[]).filter(c => c.id !== colId) } }
          : n
      ))
    },
    onDeleteTable: () => {
      deleteTable(table.id)
      setNodes(nds => nds.filter(n => n.id !== erTableNodeId(table.id)))
      setEdges(eds => eds.filter(e =>
        e.source !== erTableNodeId(table.id) && e.target !== erTableNodeId(table.id)
      ))
    },
  }), [updateTable, addColumn, updateColumn, deleteColumn, deleteTable, setNodes, setEdges])

  const reloadCanvas = useCallback(() => {
    loadProject(projectId).then(() => {
      const state = useErDesignerStore.getState()
      const newNodes: Node<NodeData>[] = state.tables.map((table) => ({
        id: erTableNodeId(table.id),
        type: 'erTable',
        position: { x: table.position_x, y: table.position_y },
        data: buildNodeData(table, state.columns[table.id] || []),
      }))
      const newEdges = state.relations.map((rel) => ({
        id: erEdgeNodeId(rel.id),
        source: erTableNodeId(rel.source_table_id),
        sourceHandle: `${rel.source_column_id}-source`,
        target: erTableNodeId(rel.target_table_id),
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

  // Sync store changes to ReactFlow nodes/edges (for sidebar operations)
  useEffect(() => {
    // Only sync when we have loaded data (activeProjectId matches)
    const state = useErDesignerStore.getState()
    if (state.activeProjectId !== projectId) return

    // Update nodes based on current tables (sync table name, columns, etc.)
    setNodes(nds => {
      const currentTableIds = new Set(tables.map(t => t.id))
      // Update existing nodes and remove deleted ones
      const updated = nds
        .filter(n => currentTableIds.has(parseErTableNodeId(n.id)!))
        .map(n => {
          const tableId = parseErTableNodeId(n.id)!
          const table = tables.find(t => t.id === tableId)
          if (!table) return n
          const cols = columns[tableId] || []
          // Update node data with latest table and columns
          return {
            ...n,
            position: { x: table.position_x, y: table.position_y },
            data: {
              ...n.data,
              table,
              columns: cols,
            },
          }
        })
      // Add new nodes for tables not yet on canvas
      const existingIds = new Set(updated.map(n => n.id))
      const newNodes = tables
        .filter(t => !existingIds.has(erTableNodeId(t.id)))
        .map(table => ({
          id: erTableNodeId(table.id),
          type: 'erTable',
          position: { x: table.position_x, y: table.position_y },
          data: buildNodeData(table, columns[table.id] || []),
        }))
      return [...updated, ...newNodes]
    })

    // Update edges based on current relations
    setEdges(eds => {
      const currentRelIds = new Set(relations.map(r => r.id))
      const currentTableIds = new Set(tables.map(t => t.id))
      // Remove edges for deleted relations or deleted tables
      const filtered = eds.filter(e =>
        currentRelIds.has(parseInt(e.id)) &&
        currentTableIds.has(parseErTableNodeId(e.source)!) &&
        currentTableIds.has(parseErTableNodeId(e.target)!)
      )
      // Add edges for new relations
      const existingIds = new Set(filtered.map(e => e.id))
      const newEdges = relations
        .filter(r => !existingIds.has(erEdgeNodeId(r.id)))
        .map(rel => ({
          id: erEdgeNodeId(rel.id),
          source: erTableNodeId(rel.source_table_id),
          sourceHandle: `${rel.source_column_id}-source`,
          target: erTableNodeId(rel.target_table_id),
          targetHandle: `${rel.target_column_id}-target`,
          type: 'erEdge',
          data: { relation_type: rel.relation_type, source_type: rel.source },
        }))
      return [...filtered, ...newEdges]
    })
  }, [projectId, tables, relations, columns, buildNodeData, setNodes, setEdges])

  // Refs for nodes/edges so MCP event listeners don't re-subscribe on every render
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  // MCP-triggered canvas operations via Tauri events
  useEffect(() => {
    let mounted = true
    const unlistenFns: UnlistenFn[] = []

    // MCP adapter emits this after any CRUD operation
    listen('er-canvas-reload', (event: { payload: { projectId: number } }) => {
      if (event.payload.projectId === projectId) {
        reloadCanvas()
      }
    }).then(unlisten => {
      if (mounted) {
        unlistenFns.push(unlisten)
      } else {
        unlisten()
      }
    })

    // MCP adapter triggers dialog opening
    listen('er-canvas-open-dialog', (event: { payload: { projectId: number; dialog: string } }) => {
      if (event.payload.projectId === projectId) {
        if (event.payload.dialog === 'import') setShowImport(true)
        else if (event.payload.dialog === 'bind') setShowBind(true)
      }
    }).then(unlisten => {
      if (mounted) {
        unlistenFns.push(unlisten)
      } else {
        unlisten()
      }
    })

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
    }).then(unlisten => {
      if (mounted) {
        unlistenFns.push(unlisten)
      } else {
        unlisten()
      }
    })

    return () => {
      mounted = false
      unlistenFns.forEach(fn => fn())
    }
  }, [projectId, reloadCanvas, setNodes])

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    const tableId = parseErTableNodeId(node.id)!
    updateTable(tableId, { position_x: node.position.x, position_y: node.position.y })
  }, [updateTable])

  // Sync edge deletion to store/backend
  const deleteRelation = useErDesignerStore(s => s.deleteRelation)
  const onEdgesDelete = useCallback((deletedEdges: Edge[]) => {
    for (const edge of deletedEdges) {
      const relationId = parseErEdgeNodeId(edge.id)
      if (relationId != null) {
        deleteRelation(relationId)
      }
    }
  }, [deleteRelation])

  // IMPORTANT: relation_type must be 'one_to_many' (not '1:N')
  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) => addEdge({
      ...connection,
      type: 'erEdge',
      data: { relation_type: 'one_to_many', source_type: 'designer' }
    }, eds))
    const sourceColumnId = parseInt(connection.sourceHandle!.replace('-source', ''))
    const targetColumnId = parseInt(connection.targetHandle!.replace('-target', ''))
    const sourceTableId = parseErTableNodeId(connection.source!)!
    const targetTableId = parseErTableNodeId(connection.target!)!
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
      id: erTableNodeId(table.id),
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

  // Listen for sidebar context menu requesting bind dialog
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.projectId === projectId) {
        setShowBind(true)
      }
    }
    window.addEventListener('er-open-bind-dialog', handler)
    return () => window.removeEventListener('er-open-bind-dialog', handler)
  }, [projectId])

  // connectionInfo for DiffReportDialog
  const connectionInfo = activeProject?.connection_id
    ? { name: `Connection ${activeProject.connection_id}`, database: activeProject.database_name ?? '' }
    : null

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0d1117]">
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
      <div className="flex-1 overflow-hidden relative graph-canvas-container">
        <ReactFlow
          className="graph-canvas-container"
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onEdgesDelete={onEdgesDelete}
          onInit={(i) => { rfInstance.current = i }}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
        >
          <Background id="er-canvas-bg" variant={BackgroundVariant.Dots} color="#1e2d42" bgColor="#0d1117" gap={20} size={1} />
          <Controls />
        </ReactFlow>
      </div>

      <DDLPreviewDialog
        visible={showDDL}
        projectId={projectId}
        hasConnection={hasConnection}
        onClose={() => setShowDDL(false)}
        onExecute={async (ddl) => {
          if (!activeProject?.connection_id) return
          try {
            await invoke('execute_query', {
              connectionId: activeProject.connection_id,
              sql: ddl,
              database: activeProject.database_name ?? null,
              schema: activeProject.schema_name ?? null,
            })
          } catch (e) {
            console.error('Failed to execute DDL:', e)
          }
        }}
      />
      <DiffReportDialog
        visible={showDiff}
        projectId={projectId}
        connectionInfo={connectionInfo}
        onClose={() => setShowDiff(false)}
        onSyncToDb={(_changes) => {
          // Phase 3: requires backend er_sync_to_database command
          console.warn('Sync to database is not yet implemented')
        }}
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

export default function ERCanvas(props: ERCanvasProps) {
  return (
    <ReactFlowProvider>
      <ERCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
