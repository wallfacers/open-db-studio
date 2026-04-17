import React, { useState } from 'react';
import { X, Tag, Table2, BarChart2, Hash, Plus, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { AliasEditor } from './AliasEditor';
import type { GraphNode, GraphEdge } from './useGraphData';
import { parseAliases } from './graphUtils';
import { Tooltip } from '../common/Tooltip';
import { useConfirmStore } from '../../store/confirmStore';

interface NodeDetailProps {
  node: GraphNode;
  edges: GraphEdge[];
  nodeNameMap: Record<string, string>;
  onClose: () => void;
  onAliasUpdated: () => void;
  onNodeClick?: (nodeId: string) => void;
  onRefresh?: () => void;
}

function SourceBadge({ source }: { source: string }) {
  const badges: Record<string, { label: string; color: string }> = {
    comment: { label: '注释推断', color: 'var(--node-metric)' },
    user:    { label: '✏️ 用户自定义', color: 'var(--node-alias)' },
    schema:  { label: '数据库外键', color: 'var(--node-table)' },
  };
  const badge = badges[source] ?? badges.schema;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 11,
      border: `1px solid ${badge.color}`,
      color: badge.color,
      backgroundColor: badge.color + '22',
      marginBottom: 8,
    }}>
      {badge.label}
    </span>
  );
}

interface LinkMeta {
  edge_type?: string;
  cardinality?: string;
  via?: string;
  on_delete?: string;
  description?: string;
  weight?: number;
  is_inferred?: boolean;
  source_table?: string;
  target_table?: string;
}

function LinkDetail({ node, onMetaUpdated }: { node: GraphNode; onMetaUpdated: () => void }) {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  let meta: LinkMeta = {};
  try { meta = JSON.parse(node.metadata || '{}'); } catch { /* ignore */ }

  // 同步初始 description
  React.useEffect(() => {
    let m: LinkMeta = {};
    try { m = JSON.parse(node.metadata || '{}'); } catch { /* ignore */ }
    setDescription(m.description ?? '');
  }, [node.metadata]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = { ...meta, description };
      await invoke('update_graph_node_metadata', {
        nodeId: node.id,
        metadata: JSON.stringify(updated),
      });
      setEditing(false);
      onMetaUpdated();
    } catch (err) {
      console.warn('[LinkDetail] save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const rows: { label: string; value: string; color?: string }[] = [
    { label: t('graphExplorer.nodeDetail.linkDirection'), value: `${meta.source_table ?? ''} → ${meta.target_table ?? ''}` },
    { label: t('graphExplorer.nodeDetail.linkCardinality'), value: meta.cardinality ?? '-', color: 'var(--edge-reference)' },
    { label: t('graphExplorer.nodeDetail.linkVia'), value: meta.via ?? '-', color: 'var(--edge-fk)' },
    { label: t('graphExplorer.nodeDetail.linkOnDelete'), value: meta.on_delete ?? '-' },
    { label: t('graphExplorer.nodeDetail.linkWeight'), value: meta.weight?.toFixed(2) ?? '-' },
  ];

  return (
    <div className="px-4 py-3 flex-1 overflow-y-auto">
      <p className="text-foreground-muted text-[11px] uppercase tracking-wide mb-2">
        {t('graphExplorer.nodeDetail.linkProps')}
      </p>

      {/* 推断标记 */}
      <div className="mb-3">
        <span className={`text-[9px] px-2 py-0.5 rounded border ${
          meta.is_inferred !== false
            ? 'bg-node-table-bg text-node-table border-node-table/30'
            : 'bg-border-default text-foreground-muted border-border-strong'
        }`}>
          {meta.is_inferred !== false
            ? t('graphExplorer.nodeDetail.inferredBadge')
            : t('graphExplorer.nodeDetail.manualBadge')}
        </span>
      </div>

      {/* 属性行 */}
      <div className="space-y-1.5 mb-4">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between py-1 px-2 rounded hover:bg-background-base transition-colors duration-150">
            <span className="text-foreground-muted text-[10px]">{r.label}</span>
            <span className="text-[10px] font-mono text-foreground-default" style={r.color ? { color: r.color } : undefined}>{r.value}</span>
          </div>
        ))}
      </div>

      {/* Description 编辑 */}
      <div className="border-t border-border-default pt-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-foreground-muted text-[11px] uppercase tracking-wide">
            {t('graphExplorer.nodeDetail.linkDescription')}
          </span>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-[10px] text-foreground-muted hover:text-foreground-default px-1.5 py-0.5 rounded hover:bg-border-default transition-colors duration-200"
            >
              {t('graphExplorer.nodeDetail.editBtn')}
            </button>
          )}
        </div>
        {editing ? (
          <div>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full text-xs bg-background-base border border-border-strong rounded p-2 text-foreground-default placeholder-foreground-ghost focus:outline-none focus:border-accent/50 resize-none"
              rows={3}
              placeholder={t('graphExplorer.nodeDetail.descriptionPlaceholder')}
            />
            <div className="flex gap-2 mt-1.5">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 text-[10px] py-1 bg-accent text-background-base rounded font-medium hover:bg-accent/80 disabled:opacity-50 transition-colors duration-200"
              >
                {saving ? t('graphExplorer.nodeDetail.saving') : t('graphExplorer.nodeDetail.save')}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="flex-1 text-[10px] py-1 bg-border-default text-foreground-muted rounded hover:bg-border-strong transition-colors duration-200"
              >
                {t('graphExplorer.nodeDetail.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-foreground-default text-xs italic">
            {description || <span className="text-foreground-ghost">{t('graphExplorer.nodeDetail.noDescription')}</span>}
          </p>
        )}
      </div>
    </div>
  );
}

interface ParsedField {
  name: string;
  type?: string;
  comment?: string;
}

function parseMetadata(raw: string): ParsedField[] {
  if (!raw || !raw.trim()) return [];
  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj)) {
      return obj.map((f: unknown) => {
        if (typeof f === 'object' && f !== null) {
          const field = f as Record<string, unknown>;
          return {
            name: String(field.name ?? field.column_name ?? ''),
            type: field.data_type ? String(field.data_type) : field.type ? String(field.type) : undefined,
            comment: field.comment ? String(field.comment) : undefined,
          };
        }
        return { name: String(f) };
      }).filter((f) => f.name);
    }
    if (typeof obj === 'object' && obj !== null) {
      const o = obj as Record<string, unknown>;
      if (o.columns && Array.isArray(o.columns)) {
        return parseMetadata(JSON.stringify(o.columns));
      }
    }
  } catch {
    // ignore
  }
  return [];
}

function nodeTypeIcon(nodeType: string) {
  switch (nodeType) {
    case 'table': return <Table2 size={14} className="text-node-table" />;
    case 'metric': return <BarChart2 size={14} className="text-node-metric" />;
    case 'alias': return <Hash size={14} className="text-node-alias" />;
    default: return <Tag size={14} className="text-foreground-muted" />;
  }
}

function nodeTypeBadgeClass(nodeType: string): string {
  switch (nodeType) {
    case 'table': return 'bg-node-table-bg text-node-table border border-node-table/30';
    case 'metric': return 'bg-node-metric-bg text-node-metric border border-node-metric/30';
    case 'alias': return 'bg-node-alias-bg text-node-alias border border-node-alias/30';
    default: return 'bg-border-default text-foreground-muted border border-border-strong';
  }
}

function edgeTypeColor(edgeType: string): string {
  switch (edgeType) {
    case 'fk': return 'text-edge-fk';
    case 'alias_of': return 'text-edge-alias';
    case 'references': return 'text-edge-reference';
    default: return 'text-foreground-muted';
  }
}

export const NodeDetail: React.FC<NodeDetailProps> = ({
  node,
  edges,
  nodeNameMap,
  onClose,
  onAliasUpdated,
  onNodeClick,
  onRefresh,
}) => {
  const { t } = useTranslation();
  const [showAliasEditor, setShowAliasEditor] = useState(false);

  const fields = parseMetadata(node.metadata);
  const aliases = parseAliases(node.aliases);

  // Edges related to this node
  const rawRelatedEdges = edges.filter(
    (e) => e.from_node === node.id || e.to_node === node.id
  );

  // Deduplicate edges: for self-links, we might see both to_link and from_link
  // pointing to the same LinkNode. We only need to show it once per peer.
  const seenPeers = new Set<string>();
  const relatedEdges = rawRelatedEdges.filter(edge => {
    const isOutgoing = edge.from_node === node.id;
    const peerId = isOutgoing ? edge.to_node : edge.from_node;
    if (seenPeers.has(peerId)) return false;
    seenPeers.add(peerId);
    return true;
  });

  const handleAliasSaved = () => {
    setShowAliasEditor(false);
    onAliasUpdated();
  };

  return (
    <>
      <div className="w-72 flex-shrink-0 h-full flex flex-col bg-background-panel border-l border-border-default overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-4 py-3 border-b border-border-default flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {nodeTypeIcon(node.node_type)}
            <div className="min-w-0">
              <Tooltip content={node.node_type === 'link' ? (node.display_name || node.name) : node.name} className="w-full">
                <p className="text-foreground-default text-sm font-semibold truncate">
                  {node.node_type === 'link' ? (node.display_name || node.name) : node.name}
                </p>
              </Tooltip>
              {node.node_type !== 'link' && node.display_name && node.display_name !== node.name && (
                <Tooltip content={node.display_name} className="w-full">
                  <p className="text-foreground-muted text-xs truncate mt-0.5">
                    {node.display_name}
                  </p>
                </Tooltip>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-foreground-muted hover:text-foreground-default transition-colors p-1 rounded hover:bg-border-default flex-shrink-0 ml-2"
          >
            <X size={15} />
          </button>
        </div>

        {/* Type badge + source badge */}
        <div className="px-4 py-2 border-b border-border-default flex-shrink-0">
          <div className="flex items-center mb-1.5">
            <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-medium ${nodeTypeBadgeClass(node.node_type)}`}>
              {nodeTypeIcon(node.node_type)}
              {node.node_type}
            </span>
          </div>
          <div>
            <SourceBadge source={node.source ?? 'schema'} />
          </div>
          {node.source === 'user' && (
            <button
              onClick={async () => {
                const ok = await useConfirmStore.getState().confirm({
                  title: '删除节点',
                  message: `确认删除用户节点「${node.display_name || node.name}」？该节点相关的自定义边也将一并删除。`,
                  confirmLabel: '删除',
                  cancelLabel: '取消',
                  variant: 'danger',
                });
                if (!ok) return;
                try {
                  await invoke('delete_graph_node', { nodeId: node.id });
                } catch (e) {
                  console.error('删除节点失败', e);
                  alert(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
                  return;
                }
                onClose();
                onRefresh?.();
              }}
              style={{
                marginTop: 8,
                padding: '4px 12px',
                border: '1px solid var(--error)',
                borderRadius: 4,
                color: 'var(--error)',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              删除此节点
            </button>
          )}
        </div>

        {/* 主体内容：Link Node 走独立路径 */}
        {node.node_type === 'link' ? (
          <LinkDetail node={node} onMetaUpdated={onAliasUpdated} />
        ) : (
          /* 现有的 Fields / Aliases / Related Edges 区块，保持不变 */
          <div className="flex-1 overflow-y-auto">
            {/* Fields section */}
            {fields.length > 0 && (
              <div className="px-4 py-3 border-b border-border-default">
                <p className="text-foreground-muted text-[11px] uppercase tracking-wide mb-2">{t('graphExplorer.nodeDetail.fields')}</p>
                <div className="space-y-1">
                  {fields.map((field, idx) => (
                    <div
                      key={`${field.name}-${idx}`}
                      className="flex items-center justify-between py-1 px-2 rounded hover:bg-background-base transition-colors"
                    >
                      <span className="text-foreground-default text-xs font-mono truncate flex-1">
                        {field.name}
                      </span>
                      {field.type && (
                        <span className="text-foreground-muted text-[10px] font-mono ml-2 flex-shrink-0">
                          {field.type}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Aliases section */}
            <div className="px-4 py-3 border-b border-border-default">
              <div className="flex items-center justify-between mb-2">
                <p className="text-foreground-muted text-[11px] uppercase tracking-wide">{t('graphExplorer.nodeDetail.semanticAliases')}</p>
                <button
                  onClick={() => setShowAliasEditor(true)}
                  className="flex items-center gap-0.5 text-[10px] text-foreground-muted hover:text-foreground-default transition-colors px-1.5 py-0.5 rounded hover:bg-border-default"
                >
                  <Plus size={11} />
                  {t('graphExplorer.aliasEditor.add')}
                </button>
              </div>
              {aliases.length === 0 ? (
                <p className="text-foreground-muted text-xs italic">{t('graphExplorer.aliasEditor.noAliases')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {aliases.map((alias) => (
                    <span
                      key={alias}
                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-background-base border border-border-default rounded text-foreground-default text-xs"
                    >
                      <Hash size={10} className="text-foreground-muted" />
                      {alias}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Related edges */}
            {relatedEdges.length > 0 && (
              <div className="px-4 py-3">
                <p className="text-foreground-muted text-[11px] uppercase tracking-wide mb-2">{t('graphExplorer.nodeDetail.relatedEdges')}</p>
                <div className="space-y-1">
                  {relatedEdges.map((edge) => {
                    const isOutgoing = edge.from_node === node.id;
                    const peerId = isOutgoing ? edge.to_node : edge.from_node;
                    const peerName = nodeNameMap[peerId] ?? peerId.split(':').slice(-1)[0];
                    return (
                      <div
                        key={edge.id}
                        onClick={() => onNodeClick?.(peerId)}
                        className="flex items-center gap-1.5 py-1.5 px-2 rounded hover:bg-background-hover transition-colors flex-wrap cursor-pointer group/edge"
                      >
                        <ArrowRight
                          size={11}
                          className={`flex-shrink-0 transition-transform group-hover/edge:translate-x-0.5 ${edgeTypeColor(edge.edge_type)}`}
                          style={isOutgoing ? undefined : { transform: 'rotate(180deg)' }}
                        />
                        <span className={`text-[10px] font-medium flex-shrink-0 ${edgeTypeColor(edge.edge_type)}`}>
                          {edge.edge_type}
                        </span>
                        <Tooltip content={peerName} className="truncate flex-1">
                          <span className="text-foreground-default text-[10px] font-mono truncate group-hover/edge:text-accent">
                            {peerName}
                          </span>
                        </Tooltip>
                        {edge.source && edge.source !== 'schema' && (
                          <SourceBadge source={edge.source} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showAliasEditor && (
        <AliasEditor
          nodeId={node.id}
          nodeName={node.name}
          currentAliases={node.aliases}
          onSave={handleAliasSaved}
          onClose={() => setShowAliasEditor(false)}
        />
      )}
    </>
  );
};
