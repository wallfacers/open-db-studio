import { useCallback, useRef } from 'react';
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

import TableNode from './TableNode';
import { initialNodes, initialEdges } from '../data/initialElements';

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
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);

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
        backgroundColor: '#0f0f11',
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
    <div className="w-full h-full bg-[#0f0f11]" ref={reactFlowWrapper}>
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
        defaultEdgeOptions={{ type: 'bezier', animated: false, style: { stroke: '#a1a1aa', strokeWidth: 2 }, interactionWidth: 20 }}
        className="bg-[#0f0f11]"
      >
        <Background color="#333" gap={16} />
        <Controls 
          showZoom={false} 
          className="!bg-[#1e1e1e] border border-[#3c3c3c] shadow-lg rounded-md overflow-hidden [&_button]:!bg-[#1e1e1e] [&_button]:!border-b [&_button]:!border-[#3c3c3c] [&_button:last-child]:!border-b-0 [&_button]:!fill-[#d4d4d4] hover:[&_button]:!bg-[#2b2b2b] hover:[&_button]:!fill-white hover:[&_button_svg]:text-white [&_button_svg]:text-[#d4d4d4]"
        >
          <ControlButton onClick={onAddTable} title="添加表">
            <Plus size={16} strokeWidth={2.5} />
          </ControlButton>
          <ControlButton onClick={onLayout} title="自动布局">
            <LayoutTemplate size={16} strokeWidth={2} />
          </ControlButton>
          <ControlButton onClick={onDownload} title="导出图片">
            <Download size={16} strokeWidth={2} />
          </ControlButton>
        </Controls>
      </ReactFlow>
    </div>
  );
}
