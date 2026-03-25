import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import ERTableNode from './ERTableNode';
import EREdge from './EREdge';
import type { ErTable, ErColumn, ErRelation } from '../../../types';

const nodeTypes = {
  erTable: ERTableNode,
};

const edgeTypes = {
  erEdge: EREdge,
};

interface NodeData {
  table: ErTable;
  columns: ErColumn[];
  onUpdateTable: (updates: Partial<ErTable>) => void;
  onAddColumn: () => void;
  onUpdateColumn: (colId: number, updates: Partial<ErColumn>) => void;
  onDeleteColumn: (colId: number) => void;
}

export default function ERCanvas() {
  const { tables, columns, relations, updateTable, addColumn, updateColumn, deleteColumn } = useErDesignerStore();

  // 将 tables 转换为 ReactFlow nodes
  const initialNodes: Node<NodeData>[] = useMemo(() => {
    return tables.map((table) => ({
      id: `table-${table.id}`,
      type: 'erTable',
      position: { x: table.position_x, y: table.position_y },
      data: {
        table,
        columns: columns[table.id] || [],
        onUpdateTable: (updates) => updateTable(table.id, updates),
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
        onUpdateColumn: (colId, updates) => updateColumn(colId, updates),
        onDeleteColumn: (colId) => deleteColumn(colId, table.id),
      },
    }));
  }, [tables, columns, updateTable, addColumn, updateColumn, deleteColumn]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

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

  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // 当 tables/columns/relations 变化时更新 nodes/edges
  const syncState = useCallback(() => {
    const newNodes: Node<NodeData>[] = tables.map((table) => ({
      id: `table-${table.id}`,
      type: 'erTable',
      position: { x: table.position_x, y: table.position_y },
      data: {
        table,
        columns: columns[table.id] || [],
        onUpdateTable: (updates) => updateTable(table.id, updates),
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
        onUpdateColumn: (colId, updates) => updateColumn(colId, updates),
        onDeleteColumn: (colId) => deleteColumn(colId, table.id),
      },
    }));

    const newEdges: Edge[] = relations.map((rel) => ({
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

    setNodes(newNodes);
    setEdges(newEdges);
  }, [tables, columns, relations, updateTable, addColumn, updateColumn, deleteColumn, setNodes, setEdges]);

  // 监听数据变化同步状态
  useMemo(() => {
    syncState();
  }, [syncState]);

  // 连接创建处理
  const onConnect = useCallback(
    (connection: Connection) => {
      // 从 connection 中提取信息创建关系
      const sourceMatch = connection.source?.match(/^table-(\d+)$/);
      const targetMatch = connection.target?.match(/^table-(\d+)$/);

      if (!sourceMatch || !targetMatch) return;

      const sourceTableId = parseInt(sourceMatch[1]);
      const targetTableId = parseInt(targetMatch[1]);

      // 从 sourceHandle 和 targetHandle 中提取 column ID
      const sourceHandle = connection.sourceHandle || '';
      const targetHandle = connection.targetHandle || '';
      const sourceColumnId = parseInt(sourceHandle.replace('-source', ''));
      const targetColumnId = parseInt(targetHandle.replace('-target', ''));

      // 这里应该调用 store 的 addRelation
      // 暂时只是创建边，实际关系创建需要更多信息（关系类型等）
      const newEdge: Edge = {
        id: `edge-${Date.now()}`,
        source: connection.source!,
        sourceHandle: connection.sourceHandle,
        target: connection.target!,
        targetHandle: connection.targetHandle,
        type: 'erEdge',
        data: {
          relation_type: '1:N', // 默认关系类型
          source_type: 'designer',
        },
      };
      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges]
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

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'erEdge',
          data: {
            relation_type: '1:N',
            source_type: 'designer',
          },
        }}
      >
        <Background color="#253347" gap={20} />
        <Controls />
        <MiniMap
          nodeColor="#111922"
          nodeStroke="#253347"
          maskColor="rgba(0, 0, 0, 0.8)"
        />
      </ReactFlow>
    </div>
  );
}
