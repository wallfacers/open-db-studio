import React, { memo, useState } from 'react';
import { Handle, Position, BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react';
import type { NodeProps, EdgeProps } from '@xyflow/react';
import { Plus, Database, BarChart2, Hash, ArrowLeftRight, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../common/Tooltip';

export interface ColumnInfo {
  name: string;
  data_type?: string;
  is_primary_key?: boolean;
  is_nullable?: boolean;
}

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
  onHighlightLinks?: (nodeId: string) => void;
  linkCount?: number;
  tableColumns?: ColumnInfo[];
  isHighlighted?: boolean;
  isDimmed?: boolean;
  isPathFrom?: boolean;
  isPathTo?: boolean;
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

function NodeRoleBadge({ isPathFrom, isPathTo }: { isPathFrom?: boolean; isPathTo?: boolean }) {
  if (!isPathFrom && !isPathTo) return null;
  return (
    <div
      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold z-10"
      style={{ background: isPathFrom ? '#4ade80' : '#5eb2f7', color: 'var(--background-base)' }}
    >
      {isPathFrom ? 'S' : 'T'}
    </div>
  );
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
    <div
      className={`w-60 rounded-md border bg-[var(--background-panel)] shadow-lg ${borderClass} group relative transition-opacity ${
        data.isDimmed ? 'opacity-30' : ''
      } ${data.isHighlighted ? 'accent-glow' : ''}`}
    >
      <NodeRoleBadge isPathFrom={data.isPathFrom as boolean | undefined} isPathTo={data.isPathTo as boolean | undefined} />
      <Handle type="target" position={Position.Left} className="!bg-[var(--border-default)] !border-[var(--border-strong)]" />

      {/* Header: icon + name + counts */}
      <div className="px-3 py-2 border-b border-[var(--border-default)] flex items-center gap-2">
        <div className={`flex-shrink-0 ${badgeBgClass} p-1 rounded`}>
          <Icon size={13} />
        </div>
        <div className="flex-1 min-w-0">
          <Tooltip content={data.name} className="w-full">
            <p className="text-[var(--foreground-default)] text-xs font-semibold truncate">{data.name}</p>
          </Tooltip>
          <p className="text-[#3d5470] text-[9px]">Object Type · {badgeLabel.toUpperCase()}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {propCount > 0 && (
            <span className="text-[9px] text-[var(--foreground-muted)] bg-[var(--background-base)] px-1 rounded">{propCount}✦</span>
          )}
          {linkCount > 0 && (
            <Tooltip content={t('graphExplorer.highlightLinks')} className="contents">
              <button
                onClick={(e) => { e.stopPropagation(); data.onHighlightLinks?.(data.id); }}
                className="text-[9px] text-[var(--accent)] bg-[#0d1f1a] px-1 rounded hover:bg-[var(--accent)22] transition-colors"
              >
                {linkCount}⇌
              </button>
            </Tooltip>
          )}
          <Tooltip content={t('graphExplorer.addAlias')} className="contents">
            <button
              onClick={handleAddAlias}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-[var(--border-default)] text-[var(--foreground-muted)] hover:text-[var(--foreground-default)]"
            >
              <Plus size={11} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Key Properties */}
      {fields.length > 0 && (
        <div className="px-3 py-1.5 border-b border-[var(--border-default)]">
          {fields.map((f, i) => (
            <div key={i} className="flex items-center justify-between py-0.5">
              <span className="text-[var(--foreground-default)] text-[10px] font-mono truncate flex-1">
                {f.is_primary_key && <span className="text-[#f59e0b] mr-1">⬡</span>}
                {f.name}
              </span>
              {f.type && <span className="text-[var(--foreground-muted)] text-[9px] font-mono ml-2 flex-shrink-0">{f.type}</span>}
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

      <Handle type="source" position={Position.Right} className="!bg-[var(--border-default)] !border-[var(--border-strong)]" />
    </div>
  );
}

const COLS_PREVIEW = 4;

export const TableNodeComponent = memo(({ data }: NodeProps) => {
  const nodeData = data as GraphNodeData;
  const tableColumns = (nodeData.tableColumns as ColumnInfo[] | undefined) ?? [];
  const [colsExpanded, setColsExpanded] = useState(false);

  const shownCols = colsExpanded ? tableColumns : tableColumns.slice(0, COLS_PREVIEW);
  const hiddenCount = tableColumns.length - COLS_PREVIEW;

  return (
    <div
      className={`w-60 rounded-md border border-[#3794ff] bg-[var(--background-panel)] shadow-lg group relative transition-opacity ${
        nodeData.isDimmed ? 'opacity-30' : ''
      } ${nodeData.isHighlighted ? 'accent-glow' : ''}`}
    >
      <NodeRoleBadge isPathFrom={nodeData.isPathFrom as boolean | undefined} isPathTo={nodeData.isPathTo as boolean | undefined} />
      <Handle type="target" position={Position.Left} className="!bg-[var(--border-default)] !border-[var(--border-strong)]" />
      {/* 自引用 FK 额外 handles：to_link 从 Top 出发，from_link 从 Bottom 返回 */}
      <Handle type="source" position={Position.Top} id="top-source" className="!bg-[var(--border-default)] !border-[#f59e0b]" />
      <Handle type="target" position={Position.Bottom} id="bottom-target" className="!bg-[var(--border-default)] !border-[#f59e0b]" />

      {/* Header */}
      <div className="px-3 py-2 border-b border-[var(--border-default)] flex items-center gap-2">
        <div className="flex-shrink-0 bg-[#0d2a3d] text-[#3794ff] p-1 rounded">
          <Database size={13} />
        </div>
        <div className="flex-1 min-w-0">
          <Tooltip content={nodeData.name} className="w-full">
            <p className="text-[var(--foreground-default)] text-xs font-semibold truncate">{nodeData.name}</p>
          </Tooltip>
          <p className="text-[#3d5470] text-[9px]">Object Type · TABLE</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {tableColumns.length > 0 && (
            <span className="text-[9px] text-[var(--foreground-muted)] bg-[var(--background-base)] px-1 rounded">
              {tableColumns.length}✦
            </span>
          )}
          {(nodeData.linkCount as number ?? 0) > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); nodeData.onHighlightLinks?.(nodeData.id); }}
              className="text-[9px] text-[var(--accent)] bg-[#0d1f1a] px-1 rounded hover:bg-[var(--accent)22] transition-colors"
            >
              {nodeData.linkCount as number}⇌
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); nodeData.onAddAlias?.(nodeData.id); }}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-[var(--border-default)] text-[var(--foreground-muted)] hover:text-[var(--foreground-default)]"
          >
            <Plus size={11} />
          </button>
        </div>
      </div>

      {/* Columns */}
      {tableColumns.length > 0 && (
        <div className="border-b border-[var(--border-default)]">
          <div className="px-3 py-1.5">
            {shownCols.map((col, i) => (
              <div key={i} className="flex items-center justify-between py-0.5">
                <span className="text-[var(--foreground-default)] text-[10px] font-mono truncate flex-1">
                  {col.is_primary_key && <span className="text-[#f59e0b] mr-1">⬡</span>}
                  {col.name}
                </span>
                {col.data_type && (
                  <span className="text-[var(--foreground-muted)] text-[9px] font-mono ml-2 flex-shrink-0">
                    {col.data_type}
                  </span>
                )}
              </div>
            ))}
          </div>
          {tableColumns.length > COLS_PREVIEW && (
            <button
              onClick={(e) => { e.stopPropagation(); setColsExpanded(v => !v); }}
              className="w-full px-3 py-1 text-[9px] text-[#3794ff] hover:bg-[var(--background-base)] transition-colors text-left border-t border-[var(--border-default)]"
            >
              {colsExpanded
                ? '▲ 收起'
                : `▼ 还有 ${hiddenCount} 列...`}
            </button>
          )}
        </div>
      )}

      {/* Aliases */}
      {(() => {
        const aliases = (nodeData.aliases as string | null)
          ? (nodeData.aliases as string).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
          : [];
        return aliases.length > 0 ? (
          <div className="px-3 py-1.5 flex flex-wrap gap-1">
            {aliases.slice(0, 3).map(a => (
              <span key={a} className="text-[9px] text-[#a855f7] bg-[#1e0d2d] border border-[#a855f744] rounded px-1">
                #{a}
              </span>
            ))}
          </div>
        ) : null;
      })()}

      <Handle type="source" position={Position.Right} className="!bg-[var(--border-default)] !border-[var(--border-strong)]" />
    </div>
  );
});
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
  const isSelfRef = Boolean(meta.source_table && meta.source_table === meta.target_table);
  const isDimmed = Boolean(nodeData.isDimmed);
  const borderClass = isInferred
    ? 'border-dashed border-[var(--accent)]'
    : 'border-[var(--accent)]';

  return (
    <div
      className={`w-64 rounded-md border bg-[var(--background-panel)] shadow-lg ${borderClass} transition-opacity`}
      style={{ opacity: isDimmed ? 0.3 : 1 }}
    >
      {/* Handles: 自引用用 Top/Bottom 避免边交叉，普通用 Left/Right */}
      {isSelfRef ? (
        <Handle type="target" position={Position.Top} id="self-target" className="!bg-[var(--border-default)] !border-[#f59e0b]" />
      ) : (
        <Handle type="target" position={Position.Left} className="!bg-[var(--border-default)] !border-[var(--border-strong)]" />
      )}

      {/* Row 1: edge_type + cardinality */}
      <div className="px-3 py-1.5 border-b border-[var(--border-default)] flex items-center gap-2">
        {isSelfRef
          ? <RotateCcw size={12} className="text-[#f59e0b] flex-shrink-0" />
          : <ArrowLeftRight size={12} className="text-[var(--accent)] flex-shrink-0" />
        }
        <span className="text-[var(--accent)] text-[11px] font-semibold flex-1">
          {(meta.edge_type ?? 'fk').toUpperCase()}
          {isSelfRef && <span className="text-[#f59e0b] ml-1 text-[9px]">(self-ref)</span>}
        </span>
        {meta.cardinality && (
          <span className="text-[#f59e0b] text-[10px] font-mono">{meta.cardinality}</span>
        )}
      </div>

      {/* Row 2: via + on_delete（条件渲染，无内容时不显示） */}
      {(meta.via || meta.on_delete) && (
        <div className="px-3 py-1 border-b border-[var(--border-default)] flex items-center gap-1.5">
          {meta.via && (
            <span className="text-[var(--foreground-muted)] text-[9px]">
              via: <span className="text-[var(--foreground-default)] font-mono">{meta.via}</span>
            </span>
          )}
          {meta.on_delete && (
            <span className="text-[var(--foreground-muted)] text-[9px] ml-1">
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
        <div className="px-3 py-1 border-t border-[var(--border-default)]">
          <span className="text-[var(--foreground-muted)] text-[9px] italic truncate block">{meta.description}</span>
        </div>
      )}

      {isSelfRef ? (
        <Handle type="source" position={Position.Bottom} id="self-source" className="!bg-[var(--border-default)] !border-[#f59e0b]" />
      ) : (
        <Handle type="source" position={Position.Right} className="!bg-[var(--border-default)] !border-[var(--border-strong)]" />
      )}
    </div>
  );
});
LinkNodeComponent.displayName = 'LinkNodeComponent';

// ── Relation Edge ──────────────────────────────────────────────────────────────

const EDGE_COLOR: Record<string, string> = {
  fk:         '#3794ff',
  references: '#f59e0b',
  alias_of:   '#a855f7',
  inferred:   'var(--accent)',
};

function edgeStroke(edgeType: string): string {
  return EDGE_COLOR[edgeType] ?? '#4a6380';
}

export const RelationEdge = memo(({
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data,
  markerEnd,
}: EdgeProps) => {
  const edgeType = String((data as Record<string, unknown>)?.edge_type ?? 'fk');
  const isHighlighted = Boolean((data as Record<string, unknown>)?.highlighted);
  const isDimmed = Boolean((data as Record<string, unknown>)?.dimmed);

  const baseStroke = edgeStroke(edgeType);
  const stroke = isHighlighted ? 'var(--accent)' : baseStroke;
  const strokeWidth = isHighlighted ? 3 : 1.5;
  const opacity = isDimmed ? 0.3 : (isHighlighted ? 1 : 0.75);

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 8,
  });

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth,
          opacity,
          transition: 'opacity 0.3s ease, stroke-width 0.3s ease',
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute pointer-events-none"
          style={{
            transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            opacity,
            transition: 'opacity 0.3s ease',
          }}
        >
          <span
            className="text-[9px] font-mono px-1.5 py-0.5 rounded border leading-none"
            style={{
              color: stroke,
              borderColor: `${stroke}55`,
              background: 'var(--background-base)cc',
              backdropFilter: 'blur(2px)',
            }}
          >
            {edgeType}
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
RelationEdge.displayName = 'RelationEdge';

// ── Self-Loop Edge (自引用 FK) ────────────────────────────────────────────────

export const SelfLoopEdge = memo(({
  sourceX, sourceY,
  data,
  markerEnd,
}: EdgeProps) => {
  const edgeType = String((data as Record<string, unknown>)?.edge_type ?? 'fk');
  const isHighlighted = Boolean((data as Record<string, unknown>)?.highlighted);
  const isDimmed = Boolean((data as Record<string, unknown>)?.dimmed);

  const baseStroke = edgeStroke(edgeType);
  const stroke = isHighlighted ? 'var(--accent)' : baseStroke;
  const strokeWidth = isHighlighted ? 3 : 1.5;
  const opacity = isDimmed ? 0.3 : (isHighlighted ? 1 : 0.75);

  // 从节点右侧 Handle 出发，绕上方画弧线回到左侧 Handle
  const loopRadius = 50;
  const edgePath = `M ${sourceX} ${sourceY} C ${sourceX + loopRadius * 1.6} ${sourceY - loopRadius * 2}, ${sourceX - loopRadius * 1.6} ${sourceY - loopRadius * 2}, ${sourceX} ${sourceY}`;
  const labelX = sourceX;
  const labelY = sourceY - loopRadius * 1.6;

  return (
    <>
      <path
        d={edgePath}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        style={{
          opacity,
          transition: 'opacity 0.3s ease, stroke-width 0.3s ease',
        }}
        markerEnd={markerEnd as string}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute pointer-events-none"
          style={{
            transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            opacity,
            transition: 'opacity 0.3s ease',
          }}
        >
          <span
            className="text-[9px] font-mono px-1.5 py-0.5 rounded border leading-none"
            style={{
              color: stroke,
              borderColor: `${stroke}55`,
              background: 'var(--background-base)cc',
              backdropFilter: 'blur(2px)',
            }}
          >
            self-ref
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
SelfLoopEdge.displayName = 'SelfLoopEdge';
