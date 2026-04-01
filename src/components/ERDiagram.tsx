import { useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus, Download, LayoutTemplate } from 'lucide-react';
import dagre from 'dagre';
import { toPng } from 'html-to-image';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';

import TableNode from './TableNode';
import { initialNodes, initialEdges } from '../data/initialElements';
import { useConnectionStore } from '../store';
import type { FullSchemaInfo } from '../types';

const nodeTypes = {
  table: TableNode,
};

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const getLayoutedElements = (nodes: any[], edges: any[], direction = 'LR') => {
  dagreGraph.setGraph({ rankdir: direction, ranksep: 200, nodesep: 50 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: node.measured?.width ?? 250, height: node.measured?.height ?? 200 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const newNode = { ...node };
    newNode.position = {
      x: nodeWithPosition.x - (node.measured?.width ?? 250) / 2,
      y: nodeWithPosition.y - (node.measured?.height ?? 200) / 2,
    };
    return newNode;
  });

  return { nodes: newNodes, edges };
};

export default function ERDiagram() {
  const { t } = useTranslation();
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<any>(null);

  useEffect(() => {
    if (activeConnectionId == null) {
      setNodes([...initialNodes]);
      setEdges([...initialEdges]);
      return;
    }

    invoke<FullSchemaInfo>('get_full_schema', { connectionId: activeConnectionId })
      .then((schema) => {
        const newNodes = schema.tables.map((t, i) => ({
          id: t.name,
          type: 'table' as const,
          position: { x: (i % 4) * 300, y: Math.floor(i / 4) * 250 },
          data: {
            tableName: t.name,
            columns: t.columns.map((c) => ({
              name: c.name,
              type: c.data_type,
              isPrimary: c.is_primary_key,
              isForeign: t.foreign_keys.some((fk) => fk.column === c.name),
            })),
          },
        }));

        const tableNames = new Set(schema.tables.map((t) => t.name));
        const newEdges: Edge[] = [];
        schema.tables.forEach((t) => {
          t.foreign_keys.forEach((fk) => {
            if (!tableNames.has(fk.referenced_table)) return;
            newEdges.push({
              id: fk.constraint_name,
              source: fk.referenced_table,
              sourceHandle: `${fk.referenced_column}-source`,
              target: t.name,
              targetHandle: `${fk.column}-target`,
              type: 'smoothstep',
              animated: false,
              style: { stroke: 'var(--edge-fk)', strokeWidth: 1.5 },
              label: fk.constraint_name,
            });
          });
        });

        setNodes(newNodes);
        setEdges(newEdges);
      })
      .catch(() => {
        setNodes([...initialNodes]);
        setEdges([...initialEdges]);
      });
  }, [activeConnectionId, setNodes, setEdges]);

  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const onLayout = useCallback(() => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      nodes,
      edges,
      'LR'
    );
    setNodes([...layoutedNodes]);
    setEdges([...layoutedEdges]);
    setTimeout(() => {
      rfInstance.current?.fitView({ duration: 800, padding: 0.2, maxZoom: 0.8 });
    }, 50);
  }, [nodes, edges, setNodes, setEdges]);

  const onAddTable = useCallback(() => {
    const newNodeId = `table_${Date.now()}`;
    const x = Math.random() * 200 + 100;
    const y = Math.random() * 200 + 100;

    const newNode = {
      id: newNodeId,
      type: 'table',
      position: { x, y },
      data: {
        tableName: `NewTable_${nodes.length + 1}`,
        columns: [
          { name: 'id', type: 'INT', isPrimary: true },
          { name: 'created_at', type: 'DATETIME' }
        ],
      },
    };
    setNodes((nds) => [...nds, newNode]);
  }, [nodes.length, setNodes]);

  const onDownload = useCallback(() => {
    if (reactFlowWrapper.current) {
      const element = reactFlowWrapper.current.querySelector('.react-flow') as HTMLElement;
      if (!element) return;
      
      toPng(element, {
        backgroundColor: 'var(--background-void)',
        filter: (node) => {
          if (
            node?.classList?.contains('react-flow__minimap') ||
            node?.classList?.contains('react-flow__controls') ||
            node?.classList?.contains('react-flow__panel')
          ) {
            return false;
          }
          return true;
        },
      }).then((dataUrl) => {
        const link = document.createElement('a');
        link.download = 'er-diagram.png';
        link.href = dataUrl;
        link.click();
      });
    }
  }, []);

  return (
    <div className="w-full h-full bg-[var(--background-void)]" ref={reactFlowWrapper}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onInit={(instance) => { rfInstance.current = instance; }}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ maxZoom: 0.8, padding: 0.2 }}
        deleteKeyCode={['Backspace', 'Delete']}
        selectionKeyCode={['Shift', 'Meta', 'Control']}
        defaultEdgeOptions={{ type: 'bezier', animated: false, style: { stroke: '#8bafc9', strokeWidth: 2 }, interactionWidth: 20 }}
        className="bg-[var(--background-void)]"
      >
        <Background color="var(--border-default)" gap={20} size={1} />
        <Controls 
          showZoom={false} 
          className="!bg-[var(--background-panel)] border border-[var(--border-strong)] shadow-lg rounded-md overflow-hidden [&_button]:!bg-[var(--background-panel)] [&_button]:!border-b [&_button]:!border-[var(--border-strong)] [&_button:last-child]:!border-b-0 [&_button]:!fill-[var(--foreground-default)] hover:[&_button]:!bg-[var(--border-default)] hover:[&_button]:!fill-[var(--foreground)] hover:[&_button_svg]:text-[var(--foreground)] [&_button_svg]:text-[var(--foreground-default)]"
        >
          <ControlButton onClick={onAddTable} title={t('erDiagram.addTable')}>
            <Plus size={16} strokeWidth={2.5} />
          </ControlButton>
          <ControlButton onClick={onLayout} title={t('erDiagram.autoLayout')}>
            <LayoutTemplate size={16} strokeWidth={2} />
          </ControlButton>
          <ControlButton onClick={onDownload} title={t('erDiagram.exportImage')}>
            <Download size={16} strokeWidth={2} />
          </ControlButton>
        </Controls>
      </ReactFlow>
    </div>
  );
}
