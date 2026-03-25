import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

interface EREdgeProps extends EdgeProps {
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  data?: {
    relation_type?: string;
    source_type?: 'schema' | 'comment' | 'designer';
  };
}

export default function EREdge({ id, sourceX, sourceY, targetX, targetY, data, style }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  const sourceType = data?.source_type || 'schema';
  const relationType = data?.relation_type || '1:N';

  // 根据源类型设置样式
  const getEdgeStyle = () => {
    switch (sourceType) {
      case 'schema':
        return {
          stroke: '#3794ff',
          strokeWidth: 2,
          strokeDasharray: undefined,
        };
      case 'comment':
        return {
          stroke: '#f59e0b',
          strokeWidth: 1.5,
          strokeDasharray: '4 2',
        };
      case 'designer':
        return {
          stroke: '#a855f7',
          strokeWidth: 1.5,
          strokeDasharray: '2 2',
        };
      default:
        return {
          stroke: '#3794ff',
          strokeWidth: 2,
          strokeDasharray: undefined,
        };
    }
  };

  const edgeStyle = getEdgeStyle();

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...edgeStyle,
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="bg-[#111922] border border-[#253347] px-2 py-0.5 rounded text-xs text-gray-300 font-mono shadow-sm"
        >
          {relationType}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
