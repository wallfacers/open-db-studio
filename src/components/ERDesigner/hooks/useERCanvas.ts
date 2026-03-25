import { useMemo, useCallback, useEffect } from 'react';
import { useNodesState, useEdgesState, addEdge, type Connection, type Edge, type Node } from '@xyflow/react';
import dagre from 'dagre';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import type { ErTable, ErColumn, ErRelation } from '../../../types';

interface NodeData {
  table: ErTable;
  columns: ErColumn[];
  onUpdateTable: (updates: Partial<ErTable>) => void;
  onAddColumn: () => void;
  onUpdateColumn: (colId: number, updates: Partial<ErColumn>) => void;
  onDeleteColumn: (colId: number) => void;
  [key: string]: unknown;
}

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const nodeWidth = 280;
const nodeHeight = 200;

/**
 * ER Canvas 自定义 Hook
 * 管理 ReactFlow 节点/边与 erDesignerStore 的同步
 */
export function useERCanvas() {
  const {
    tables,
    columns,
    relations,
    activeProjectId,
    updateTable,
    addColumn,
    updateColumn,
    deleteColumn,
    addRelation,
  } = useErDesignerStore();

  // 将 tables 转换为 ReactFlow nodes
  const initialNodes: Node<NodeData>[] = useMemo(() => {
    return tables.map((table) => ({
      id: `table-${table.id}`,
      type: 'erTable',
      position: { x: table.position_x, y: table.position_y },
      data: {
        table,
        columns: columns[table.id] || [],
        onUpdateTable: (updates: Partial<ErTable>) => updateTable(table.id, updates),
        onAddColumn: () => addColumn(table.id, {
          name: `column_${(columns[table.id]?.length || 0) + 1}`,
          data_type: 'VARCHAR',
          nullable: true,
          default_value: null,
          is_primary_key: false,
          is_auto_increment: false,
          comment: null,
          sort_order: columns[table.id]?.length || 0,
        }),
        onUpdateColumn: (colId: number, updates: Partial<ErColumn>) => updateColumn(colId, updates),
        onDeleteColumn: (colId: number) => deleteColumn(colId, table.id),
      },
    }));
  }, [tables, columns, updateTable, addColumn, updateColumn, deleteColumn]);

  // 将 relations 转换为 ReactFlow edges
  const initialEdges: Edge[] = useMemo(() => {
    return relations.map((rel) => ({
      id: `edge-${rel.id}`,
      source: `table-${rel.source_table_id}`,
      sourceHandle: `${rel.source_column_id}-source`,
      target: `table-${rel.target_table_id}`,
      targetHandle: `${rel.target_column_id}-target`,
      type: 'erEdge',
      data: {
        relation_type: rel.relation_type,
        source_type: rel.source as 'schema' | 'comment' | 'designer',
      },
    }));
  }, [relations]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // 同步 store 数据到 nodes/edges
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // 连接创建处理
  const onConnect = useCallback(
    (connection: Connection) => {
      const sourceMatch = connection.source?.match(/^table-(\d+)$/);
      const targetMatch = connection.target?.match(/^table-(\d+)$/);

      if (!sourceMatch || !targetMatch || !activeProjectId) return;

      const sourceTableId = parseInt(sourceMatch[1]);
      const targetTableId = parseInt(targetMatch[1]);

      const sourceHandle = connection.sourceHandle || '';
      const targetHandle = connection.targetHandle || '';
      const sourceColumnId = parseInt(sourceHandle.replace('-source', ''));
      const targetColumnId = parseInt(targetHandle.replace('-target', ''));

      // 创建关系
      addRelation({
        project_id: activeProjectId,
        source_table_id: sourceTableId,
        source_column_id: sourceColumnId,
        target_table_id: targetTableId,
        target_column_id: targetColumnId,
        relation_type: 'one_to_many',
        source: 'designer',
        on_delete: 'NO ACTION',
        on_update: 'NO ACTION',
      });
    },
    [activeProjectId, addRelation]
  );

  // 节点拖拽结束处理
  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      const match = node.id.match(/^table-(\d+)$/);
      if (!match) return;

      const tableId = parseInt(match[1]);
      updateTable(tableId, {
        position_x: node.position.x,
        position_y: node.position.y,
      });
    },
    [updateTable]
  );

  // dagre 自动布局
  const autoLayout = useCallback(() => {
    dagreGraph.setGraph({ rankdir: 'LR', nodesep: 80, ranksep: 120 });

    nodes.forEach((node) => {
      dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
    });

    edges.forEach((edge) => {
      dagreGraph.setEdge(edge.source, edge.target);
    });

    dagre.layout(dagreGraph);

    const layoutedNodes = nodes.map((node) => {
      const nodeWithPosition = dagreGraph.node(node.id);
      const match = node.id.match(/^table-(\d+)$/);
      if (match && nodeWithPosition) {
        const tableId = parseInt(match[1]);
        updateTable(tableId, {
          position_x: nodeWithPosition.x - nodeWidth / 2,
          position_y: nodeWithPosition.y - nodeHeight / 2,
        });
      }
      return {
        ...node,
        position: {
          x: nodeWithPosition.x - nodeWidth / 2,
          y: nodeWithPosition.y - nodeHeight / 2,
        },
      };
    });

    setNodes(layoutedNodes);
  }, [nodes, edges, setNodes, updateTable]);

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onNodeDragStop,
    autoLayout,
  };
}
