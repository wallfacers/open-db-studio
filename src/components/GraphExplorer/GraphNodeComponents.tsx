import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Plus, Database, BarChart2, Hash, ArrowLeftRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
  onHighlightLinks?: (nodeId: string) => void;  // 新增：点击 linkCount 徽章时触发
  linkCount?: number;                            // 新增：与该节点关联的 Link Node 数量
}

interface NodeField { name: string; type?: string; is_primary_key?: boolean; }

function parseNodeFields(metadata: string | null): NodeField[] {
  if (!metadata) return [];
  try {
    const obj = JSON.parse(metadata);
    if (Array.isArray(obj)) {
      return obj.slice(0, 3).map((f: Record<string, unknown>) => ({
        name: String(f.name ?? f.column_name ?? ''),
        type: f.data_type ? String(f.data_type) : f.type ? String(f.type) : undefined,
        is_primary_key: Boolean(f.is_primary_key),
      })).filter(f => f.name);
    }
  } catch { /* ignore */ }
  return [];
}

function BaseNode({
  data,
  borderClass,
  badgeBgClass,
  badgeLabel,
  icon: Icon,
}: {
  data: GraphNodeData;
  borderClass: string;
  badgeBgClass: string;  // 仅背景+文字色，如 "bg-[#0d2a3d] text-[#3794ff]"
  badgeLabel: string;
  icon: React.ElementType;
}) {
  const { t } = useTranslation();
  const fields = parseNodeFields(data.metadata as string | null);
  const aliases = (data.aliases as string | null)
    ? (data.aliases as string).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
    : [];
  const propCount = fields.length;
  const linkCount = (data.linkCount as number) ?? 0;

  const handleAddAlias = (e: React.MouseEvent) => {
    e.stopPropagation();
    data.onAddAlias?.(data.id);
  };

  return (
    <div className={`w-60 rounded-md border bg-[#111922] shadow-lg ${borderClass} group`}>
      <Handle type="target" position={Position.Left} className="!bg-[#1e2d42] !border-[#2a3f5a]" />

      {/* Header: icon + name + counts */}
      <div className="px-3 py-2 border-b border-[#1e2d42] flex items-center gap-2">
        <div className={`flex-shrink-0 ${badgeBgClass} p-1 rounded`}>
          <Icon size={13} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[#c8daea] text-xs font-semibold truncate" title={data.name}>{data.name}</p>
          <p className="text-[#3d5470] text-[9px]">Object Type · {badgeLabel.toUpperCase()}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {propCount > 0 && (
            <span className="text-[9px] text-[#7a9bb8] bg-[#0d1117] px-1 rounded">{propCount}✦</span>
          )}
          {linkCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); data.onHighlightLinks?.(data.id); }}
              className="text-[9px] text-[#00c9a7] bg-[#0d1f1a] px-1 rounded hover:bg-[#00c9a722] transition-colors"
              title={t('graphExplorer.highlightLinks')}
            >
              {linkCount}⇌
            </button>
          )}
          <button
            title={t('graphExplorer.addAlias')}
            onClick={handleAddAlias}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-[#1e2d42] text-[#7a9bb8] hover:text-[#c8daea]"
          >
            <Plus size={11} />
          </button>
        </div>
      </div>

      {/* Key Properties */}
      {fields.length > 0 && (
        <div className="px-3 py-1.5 border-b border-[#1e2d42]">
          {fields.map((f, i) => (
            <div key={i} className="flex items-center justify-between py-0.5">
              <span className="text-[#c8daea] text-[10px] font-mono truncate flex-1">
                {f.is_primary_key && <span className="text-[#f59e0b] mr-1">⬡</span>}
                {f.name}
              </span>
              {f.type && <span className="text-[#7a9bb8] text-[9px] font-mono ml-2 flex-shrink-0">{f.type}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Aliases */}
      {aliases.length > 0 && (
        <div className="px-3 py-1.5 flex flex-wrap gap-1">
          {aliases.slice(0, 3).map(a => (
            <span key={a} className="text-[9px] text-[#a855f7] bg-[#1e0d2d] border border-[#a855f744] rounded px-1">
              #{a}
            </span>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!bg-[#1e2d42] !border-[#2a3f5a]" />
    </div>
  );
}

export const TableNodeComponent = memo(({ data }: NodeProps) => (
  <BaseNode
    data={data as GraphNodeData}
    borderClass="border-[#3794ff]"
    badgeBgClass="bg-[#0d2a3d] text-[#3794ff]"
    badgeLabel="table"
    icon={Database}
  />
));
TableNodeComponent.displayName = 'TableNodeComponent';

export const MetricNodeComponent = memo(({ data }: NodeProps) => (
  <BaseNode
    data={data as GraphNodeData}
    borderClass="border-[#f59e0b]"
    badgeBgClass="bg-[#2d1e0d] text-[#f59e0b]"
    badgeLabel="metric"
    icon={BarChart2}
  />
));
MetricNodeComponent.displayName = 'MetricNodeComponent';

export const AliasNodeComponent = memo(({ data }: NodeProps) => (
  <BaseNode
    data={data as GraphNodeData}
    borderClass="border-[#a855f7]"
    badgeBgClass="bg-[#1e0d2d] text-[#a855f7]"
    badgeLabel="alias"
    icon={Hash}
  />
));
AliasNodeComponent.displayName = 'AliasNodeComponent';

interface LinkMetadata {
  edge_type?: string;
  cardinality?: string;
  via?: string;
  on_delete?: string;
  description?: string;
  is_inferred?: boolean;
  source_table?: string;
  target_table?: string;
}

export const LinkNodeComponent = memo(({ data }: NodeProps) => {
  const nodeData = data as GraphNodeData;
  let meta: LinkMetadata = {};
  try { meta = JSON.parse((nodeData.metadata as string) || '{}'); } catch { /* ignore */ }

  const isInferred = Boolean(meta.is_inferred);
  const borderClass = isInferred
    ? 'border-dashed border-[#00c9a7]'
    : 'border-[#00c9a7]';

  return (
    <div className={`w-64 rounded-md border bg-[#111922] shadow-lg ${borderClass}`}>
      <Handle type="target" position={Position.Left} className="!bg-[#1e2d42] !border-[#2a3f5a]" />

      {/* Row 1: edge_type + cardinality */}
      <div className="px-3 py-1.5 border-b border-[#1e2d42] flex items-center gap-2">
        <ArrowLeftRight size={12} className="text-[#00c9a7] flex-shrink-0" />
        <span className="text-[#00c9a7] text-[11px] font-semibold flex-1">
          {(meta.edge_type ?? 'fk').toUpperCase()}
        </span>
        {meta.cardinality && (
          <span className="text-[#f59e0b] text-[10px] font-mono">{meta.cardinality}</span>
        )}
      </div>

      {/* Row 2: via + on_delete（条件渲染，无内容时不显示） */}
      {(meta.via || meta.on_delete) && (
        <div className="px-3 py-1 border-b border-[#1e2d42] flex items-center gap-1.5">
          {meta.via && (
            <span className="text-[#7a9bb8] text-[9px]">
              via: <span className="text-[#c8daea] font-mono">{meta.via}</span>
            </span>
          )}
          {meta.on_delete && (
            <span className="text-[#7a9bb8] text-[9px] ml-1">
              · <span className="text-[#f59e0b]">{meta.on_delete}</span>
            </span>
          )}
        </div>
      )}

      {/* Row 3: direction */}
      <div className="px-3 py-1 flex items-center">
        <span className="text-[#3d5470] text-[9px] truncate">
          {nodeData.display_name || `${meta.source_table ?? ''} → ${meta.target_table ?? ''}`}
        </span>
        {isInferred && (
          <span className="ml-auto text-[8px] text-[#3d5470] flex-shrink-0">AI</span>
        )}
      </div>

      {/* Row 4 (optional): description */}
      {meta.description && (
        <div className="px-3 py-1 border-t border-[#1e2d42]">
          <span className="text-[#7a9bb8] text-[9px] italic truncate block">{meta.description}</span>
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!bg-[#1e2d42] !border-[#2a3f5a]" />
    </div>
  );
});
LinkNodeComponent.displayName = 'LinkNodeComponent';
