import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Plus } from 'lucide-react';

export interface GraphNodeData extends Record<string, unknown> {
  id: string;
  node_type: string;
  name: string;
  display_name: string | null;
  aliases: string | null;
  metadata: string | null;
  connection_id: number | null;
  is_deleted: number | null;
  source: string | null;
  onAddAlias?: (nodeId: string) => void;
}

function BaseNode({
  data,
  borderClass,
  badgeClass,
  badgeLabel,
}: {
  data: GraphNodeData;
  borderClass: string;
  badgeClass: string;
  badgeLabel: string;
}) {
  const displayName = data.display_name && data.display_name !== data.name
    ? data.display_name
    : null;

  const handleAddAlias = (e: React.MouseEvent) => {
    e.stopPropagation();
    data.onAddAlias?.(data.id);
  };

  return (
    <div
      className={`min-w-[160px] max-w-[240px] rounded-md border bg-[#111922] shadow-lg ${borderClass} group`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-[#1e2d42] !border-[#2a3f5a]"
      />

      {/* Header */}
      <div className="px-3 py-2 border-b border-[#1e2d42] flex items-center justify-between gap-2">
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${badgeClass}`}
        >
          {badgeLabel}
        </span>
        <button
          title="添加别名"
          onClick={handleAddAlias}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-[#1e2d42] text-[#7a9bb8] hover:text-[#c8daea] flex-shrink-0"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        <p className="text-[#c8daea] text-xs font-medium truncate" title={data.name}>
          {data.name}
        </p>
        {displayName && (
          <p className="text-[#7a9bb8] text-[10px] truncate mt-0.5" title={displayName}>
            {displayName}
          </p>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!bg-[#1e2d42] !border-[#2a3f5a]"
      />
    </div>
  );
}

export const TableNodeComponent = memo(({ data }: NodeProps) => (
  <BaseNode
    data={data as GraphNodeData}
    borderClass="border-[#3794ff]"
    badgeClass="bg-[#0d2a3d] text-[#3794ff] border border-[#3794ff]/30"
    badgeLabel="table"
  />
));
TableNodeComponent.displayName = 'TableNodeComponent';

export const MetricNodeComponent = memo(({ data }: NodeProps) => (
  <BaseNode
    data={data as GraphNodeData}
    borderClass="border-[#f59e0b]"
    badgeClass="bg-[#2d1e0d] text-[#f59e0b] border border-[#f59e0b]/30"
    badgeLabel="metric"
  />
));
MetricNodeComponent.displayName = 'MetricNodeComponent';

export const AliasNodeComponent = memo(({ data }: NodeProps) => (
  <BaseNode
    data={data as GraphNodeData}
    borderClass="border-[#a855f7]"
    badgeClass="bg-[#1e0d2d] text-[#a855f7] border border-[#a855f7]/30"
    badgeLabel="alias"
  />
));
AliasNodeComponent.displayName = 'AliasNodeComponent';
