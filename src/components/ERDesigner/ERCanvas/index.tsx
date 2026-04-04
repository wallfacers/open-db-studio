import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
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
  type EdgeChange,
  type ReactFlowInstance,
  type Viewport,
  ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useErDesignerStore } from '../../../store/erDesignerStore'
import ERTableNode from './ERTableNode'
import ERTableContextMenu from './ERTableContextMenu'
import EREdge from './EREdge'
import ERToolbar from './ERToolbar'
import ERPropertyDrawer from '../ERPropertyDrawer'
import { DDLPreviewDialog } from '../dialogs/DDLPreviewDialog'
import { ProjectSettingsDialog } from '../dialogs/ProjectSettingsDialog'
import { DiffReportDialog } from '../dialogs/DiffReportDialog'
import { BindConnectionDialog } from '../dialogs/BindConnectionDialog'
import { ImportTableDialog } from '../dialogs/ImportTableDialog'
import { useERKeyboard } from '../hooks/useERKeyboard'
import { useUIObjectRegistry } from '../../../mcp/ui/useUIObjectRegistry'
import { ERCanvasAdapter } from '../../../mcp/ui/adapters/ERCanvasAdapter'
import { layoutNodesWithDagre } from '../utils/dagreLayout'
import type { ErTable, ErColumn, ErRelation } from '../../../types'
import { erTableNodeId, erEdgeNodeId, parseErTableNodeId, parseErEdgeNodeId } from '../../../utils/nodeId'
import { useQueryStore } from '../../../store/queryStore'

const buildEdgeData = (rel: ErRelation) => ({
  relation_type: rel.relation_type,
  source_type: rel.source,
  constraint_method: rel.constraint_method,
  comment_format: rel.comment_format,
})

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

  const savedViewport = useErDesignerStore(s => s.viewports[projectId] ?? null)
  const storeSetViewport = useErDesignerStore(s => s.setViewport)

  const [showDDL, setShowDDL] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showBind, setShowBind] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tableId: number } | null>(null)
  const isActiveTab = useQueryStore(s => s.activeTabId === tabId)

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
  const projectTables = useErDesignerStore(useShallow(s => s.tables.filter(t => t.project_id === projectId)))
  const projectRelations = useErDesignerStore(useShallow(s => {
    const tableIds = new Set(s.tables.filter(t => t.project_id === projectId).map(t => t.id))
    return s.relations.filter(r => tableIds.has(r.source_table_id) && tableIds.has(r.target_table_id))
  }))
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

  const onMoveEnd = useCallback((_: unknown, viewport: Viewport) => {
    storeSetViewport(projectId, viewport)
  }, [projectId, storeSetViewport])

  const reloadCanvas = useCallback(() => {
    loadProject(projectId).then(() => {
      const state = useErDesignerStore.getState()
      const reloadTables = state.tables.filter(t => t.project_id === projectId)
      const tableIdSet = new Set(reloadTables.map(t => t.id))
      const newNodes: Node<NodeData>[] = reloadTables.map((table) => ({
        id: erTableNodeId(table.id),
        type: 'erTable',
        position: { x: table.position_x, y: table.position_y },
        data: buildNodeData(table, state.columns[table.id] || []),
      }))
      const newEdges = state.relations
        .filter(r => tableIdSet.has(r.source_table_id) && tableIdSet.has(r.target_table_id))
        .map((rel) => ({
          id: erEdgeNodeId(rel.id),
          source: erTableNodeId(rel.source_table_id),
          sourceHandle: `${rel.source_column_id}-source`,
          target: erTableNodeId(rel.target_table_id),
          targetHandle: `${rel.target_column_id}-target`,
          type: 'erEdge',
          data: buildEdgeData(rel),
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
    const tableIdSet = new Set(projectTables.map(t => t.id))

    setNodes(nds => {
      const currentTableIds = new Set(projectTables.map(t => t.id))
      const updated = nds
        .filter(n => currentTableIds.has(parseErTableNodeId(n.id)!))
        .map(n => {
          const tableId = parseErTableNodeId(n.id)!
          const table = projectTables.find(t => t.id === tableId)
          if (!table) return n
          const cols = columns[tableId] || []
          return {
            ...n,
            position: { x: table.position_x, y: table.position_y },
            data: { ...n.data, table, columns: cols },
          }
        })
      const existingIds = new Set(updated.map(n => n.id))
      const newNodes = projectTables
        .filter(t => !existingIds.has(erTableNodeId(t.id)))
        .map(table => ({
          id: erTableNodeId(table.id),
          type: 'erTable',
          position: { x: table.position_x, y: table.position_y },
          data: buildNodeData(table, columns[table.id] || []),
        }))
      return [...updated, ...newNodes]
    })

    setEdges(eds => {
      const currentRelIds = new Set(projectRelations.map(r => r.id))
      const filtered = eds.filter(e => {
        const relId = parseErEdgeNodeId(e.id)
        return relId != null &&
          currentRelIds.has(relId) &&
          tableIdSet.has(parseErTableNodeId(e.source)!) &&
          tableIdSet.has(parseErTableNodeId(e.target)!)
      })
      const existingIds = new Set(filtered.map(e => e.id))
      const newEdges = projectRelations
        .filter(r => !existingIds.has(erEdgeNodeId(r.id)))
        .map(rel => ({
          id: erEdgeNodeId(rel.id),
          source: erTableNodeId(rel.source_table_id),
          sourceHandle: `${rel.source_column_id}-source`,
          target: erTableNodeId(rel.target_table_id),
          targetHandle: `${rel.target_column_id}-target`,
          type: 'erEdge',
          data: buildEdgeData(rel),
        }))
      return [...filtered, ...newEdges]
    })
  }, [projectTables, projectRelations, columns, buildNodeData, setNodes, setEdges])

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

        const positions = layoutedNodes.map(node => {
          const tableId = parseErTableNodeId(node.id)
          return tableId ? { id: tableId, x: node.position.x, y: node.position.y } : null
        }).filter((p): p is NonNullable<typeof p> => p !== null)
        
        useErDesignerStore.getState().updateTablePositions(positions)
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

  const onNodeDragStop = useCallback((_: unknown, __: Node, draggedNodes: Node[]) => {
    const positions = draggedNodes.map(n => {
      const tableId = parseErTableNodeId(n.id)
      return tableId ? { id: tableId, x: n.position.x, y: n.position.y } : null
    }).filter((p): p is NonNullable<typeof p> => p !== null)
    
    if (positions.length > 0) {
      useErDesignerStore.getState().updateTablePositions(positions)
    }
  }, [])

  // Elevate selected edge to top (zIndex) so it renders above others
  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    onEdgesChange(changes)
    if (changes.some(c => c.type === 'select')) {
      setEdges(eds => eds.map(e => ({ ...e, zIndex: e.selected ? 1000 : 0 })))
    }
  }, [onEdgesChange, setEdges])

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

  // Sync node deletion to store/backend
  const onNodesDelete = useCallback((deletedNodes: Node[]) => {
    for (const node of deletedNodes) {
      const tableId = parseErTableNodeId(node.id)
      if (tableId != null) {
        deleteTable(tableId)
      }
    }
  }, [deleteTable])

  // IMPORTANT: relation_type must be 'one_to_many' (not '1:N')
  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) => addEdge({
      ...connection,
      type: 'erEdge',
      data: { relation_type: 'one_to_many', source_type: 'designer', constraint_method: null, comment_format: null }
    }, eds))
    const sourceColumnId = parseInt(connection.sourceHandle!.replace('-source', ''))
    const targetColumnId = parseInt(connection.targetHandle!.replace('-target', ''))
    const sourceTableId = parseErTableNodeId(connection.source!)!
    const targetTableId = parseErTableNodeId(connection.target!)!
    addRelation(projectId, {
      source_table_id: sourceTableId,
      source_column_id: sourceColumnId,
      target_table_id: targetTableId,
      target_column_id: targetColumnId,
      relation_type: 'one_to_many',
      source: 'designer'
    })
  }, [setEdges, addRelation, projectId])

  const handleTableAdded = useCallback((table: ErTable) => {
    setNodes(nds => [...nds, {
      id: erTableNodeId(table.id),
      type: 'erTable',
      position: { x: table.position_x, y: table.position_y },
      data: buildNodeData(table, []),
    }])
  }, [setNodes, buildNodeData])

  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0) return
    try {
      const layoutedNodes = layoutNodesWithDagre(nodes, edges) as Node<NodeData>[]
      setNodes(layoutedNodes)
      
      const positions = layoutedNodes.map(node => {
        const tableId = parseErTableNodeId(node.id)
        return tableId ? { id: tableId, x: node.position.x, y: node.position.y } : null
      }).filter((p): p is NonNullable<typeof p> => p !== null)
      
      useErDesignerStore.getState().updateTablePositions(positions)
    } catch (e) {
      console.error('Auto layout failed:', e)
    }
  }, [nodes, edges, setNodes])

  const selectedNodes = useMemo(() => nodes.filter(n => n.selected), [nodes])
  const selectedEdges = useMemo(() => edges.filter(e => e.selected), [edges])

  // Custom keyboard shortcuts
  useERKeyboard({
    projectId,
    nodes,
    edges,
    selectedNodes,
    selectedEdges,
    onAutoLayout: handleAutoLayout,
    onExportDDL: () => setShowDDL(true),
    enabled: isActiveTab,
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

  // Listen for table node context menu (from MoreVertical button or right-click)
  useEffect(() => {
    const handler = (e: Event) => {
      const { tableId, x, y } = (e as CustomEvent).detail
      setContextMenu({ x, y, tableId })
    }
    window.addEventListener('er-table-context-menu', handler)
    return () => window.removeEventListener('er-table-context-menu', handler)
  }, [])

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault()
    const tableId = parseErTableNodeId(node.id)
    if (tableId == null) return
    setContextMenu({ x: event.clientX, y: event.clientY, tableId })
  }, [])

  const onPaneClick = useCallback(() => {
    setContextMenu(null)
  }, [])

  // connectionInfo for DiffReportDialog
  const connectionInfo = activeProject?.connection_id
    ? { name: `Connection ${activeProject.connection_id}`, database: activeProject.database_name ?? '' }
    : null

  return (
    <div className="flex-1 flex min-h-0 relative">
    <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-background-base">
      <ERToolbar
        projectId={projectId}
        onOpenDDL={() => setShowDDL(true)}
        onOpenDiff={() => { if (hasConnection) setShowDiff(true) }}
        onOpenImport={() => setShowImport(true)}
        onOpenBind={() => setShowBind(true)}
        onTableAdded={handleTableAdded}
        setNodes={setNodes as (nodes: Node[]) => void}
        nodes={nodes}
        edges={edges}
        tables={projectTables}
        onAutoLayout={handleAutoLayout}
        hasConnection={hasConnection}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div className="flex-1 overflow-hidden relative graph-canvas-container" style={{ visibility: isActiveTab ? 'visible' : 'hidden', pointerEvents: isActiveTab ? 'auto' : 'none' }}>
        <ReactFlow
          className="graph-canvas-container"
          nodes={nodes}
          edges={edges}
          panActivationKeyCode={isActiveTab ? 'Space' : null}
          selectionKeyCode={isActiveTab ? 'Shift' : null}
          multiSelectionKeyCode={isActiveTab ? 'Meta' : null}
          zoomActivationKeyCode={isActiveTab ? 'Meta' : null}
          onNodesChange={onNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onEdgesDelete={onEdgesDelete}
          onNodesDelete={onNodesDelete}
          onNodeContextMenu={onNodeContextMenu}
          onPaneClick={onPaneClick}
          onInit={(i) => {
            rfInstance.current = i
            if (savedViewport) {
              i.setViewport(savedViewport)
            }
          }}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          deleteKeyCode={['Backspace', 'Delete']}
          // fitView and onInit.setViewport are mutually exclusive: when savedViewport exists, fitView is suppressed and onInit restores the exact position
          fitView={savedViewport === null}
          fitViewOptions={savedViewport === null ? { maxZoom: 1, padding: 0.2 } : undefined}
          onMoveEnd={onMoveEnd}
          minZoom={0.1}
          maxZoom={2}
        >
          <Background id="er-canvas-bg" variant={BackgroundVariant.Dots} color="var(--border-default)" bgColor="var(--background-base)" gap={20} size={1} />
          <Controls />
        </ReactFlow>
      </div>

      {contextMenu && (
        <ERTableContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          tableId={contextMenu.tableId}
          onClose={() => setContextMenu(null)}
        />
      )}

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
      <ProjectSettingsDialog
        visible={showSettings}
        projectId={projectId}
        onClose={() => setShowSettings(false)}
      />
    </div>
    <ERPropertyDrawer />
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
