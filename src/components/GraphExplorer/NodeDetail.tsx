import React, { useState } from 'react';
import { X, Tag, Table2, BarChart2, Hash, Plus, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { AliasEditor } from './AliasEditor';
import type { GraphNode, GraphEdge } from './useGraphData';
import { parseAliases } from './graphUtils';

interface NodeDetailProps {
  node: GraphNode;
  edges: GraphEdge[];
  onClose: () => void;
  onAliasUpdated: () => void;
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
    { label: t('graphExplorer.nodeDetail.linkCardinality'), value: meta.cardinality ?? '-', color: '#f59e0b' },
    { label: t('graphExplorer.nodeDetail.linkVia'), value: meta.via ?? '-', color: '#3794ff' },
    { label: t('graphExplorer.nodeDetail.linkOnDelete'), value: meta.on_delete ?? '-' },
    { label: t('graphExplorer.nodeDetail.linkWeight'), value: meta.weight?.toFixed(2) ?? '-' },
  ];

  return (
    <div className="px-4 py-3 flex-1 overflow-y-auto">
      <p className="text-[#7a9bb8] text-[11px] uppercase tracking-wide mb-2">
        {t('graphExplorer.nodeDetail.linkProps')}
      </p>

      {/* 推断标记 */}
      <div className="mb-3">
        <span className={`text-[9px] px-2 py-0.5 rounded border ${
          meta.is_inferred !== false
            ? 'bg-[#0d2a3d] text-[#3794ff] border-[#3794ff]/30'
            : 'bg-[#1e2d42] text-[#7a9bb8] border-[#253347]'
        }`}>
          {meta.is_inferred !== false
            ? t('graphExplorer.nodeDetail.inferredBadge')
            : t('graphExplorer.nodeDetail.manualBadge')}
        </span>
      </div>

      {/* 属性行 */}
      <div className="space-y-1.5 mb-4">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between py-1 px-2 rounded hover:bg-[#0d1117]">
            <span className="text-[#7a9bb8] text-[10px]">{r.label}</span>
            <span className="text-[10px] font-mono text-[#c8daea]" style={r.color ? { color: r.color } : undefined}>{r.value}</span>
          </div>
        ))}
      </div>

      {/* Description 编辑 */}
      <div className="border-t border-[#1e2d42] pt-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[#7a9bb8] text-[11px] uppercase tracking-wide">
            {t('graphExplorer.nodeDetail.linkDescription')}
          </span>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-[10px] text-[#7a9bb8] hover:text-[#c8daea] px-1.5 py-0.5 rounded hover:bg-[#1e2d42]"
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
              className="w-full text-xs bg-[#0d1117] border border-[#2a3f5a] rounded p-2 text-[#c8daea] placeholder-[#3d5470] focus:outline-none focus:border-[#00c9a7]/50 resize-none"
              rows={3}
              placeholder={t('graphExplorer.nodeDetail.descriptionPlaceholder')}
            />
            <div className="flex gap-2 mt-1.5">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 text-[10px] py-1 bg-[#00c9a7] text-[#0d1117] rounded font-medium hover:bg-[#00c9a7]/80 disabled:opacity-50"
              >
                {saving ? t('graphExplorer.nodeDetail.saving') : t('graphExplorer.nodeDetail.save')}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="flex-1 text-[10px] py-1 bg-[#1e2d42] text-[#7a9bb8] rounded hover:bg-[#253347]"
              >
                {t('graphExplorer.nodeDetail.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[#c8daea] text-xs italic">
            {description || <span className="text-[#3d5470]">{t('graphExplorer.nodeDetail.noDescription')}</span>}
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
    case 'table': return <Table2 size={14} className="text-[#3794ff]" />;
    case 'metric': return <BarChart2 size={14} className="text-[#f59e0b]" />;
    case 'alias': return <Hash size={14} className="text-[#a855f7]" />;
    default: return <Tag size={14} className="text-[#7a9bb8]" />;
  }
}

function nodeTypeBadgeClass(nodeType: string): string {
  switch (nodeType) {
    case 'table': return 'bg-[#0d2a3d] text-[#3794ff] border border-[#3794ff]/30';
    case 'metric': return 'bg-[#2d1e0d] text-[#f59e0b] border border-[#f59e0b]/30';
    case 'alias': return 'bg-[#1e0d2d] text-[#a855f7] border border-[#a855f7]/30';
    default: return 'bg-[#1e2d42] text-[#7a9bb8] border border-[#253347]';
  }
}

function edgeTypeColor(edgeType: string): string {
  switch (edgeType) {
    case 'fk': return 'text-[#3794ff]';
    case 'alias_of': return 'text-[#a855f7]';
    case 'references': return 'text-[#f59e0b]';
    default: return 'text-[#7a9bb8]';
  }
}

export const NodeDetail: React.FC<NodeDetailProps> = ({
  node,
  edges,
  onClose,
  onAliasUpdated,
}) => {
  const { t } = useTranslation();
  const [showAliasEditor, setShowAliasEditor] = useState(false);

  const fields = parseMetadata(node.metadata);
  const aliases = parseAliases(node.aliases);

  // Edges related to this node
  const relatedEdges = edges.filter(
    (e) => e.from_node === node.id || e.to_node === node.id
  );

  const handleAliasSaved = () => {
    setShowAliasEditor(false);
    onAliasUpdated();
  };

  return (
    <>
      <div className="w-72 flex-shrink-0 h-full flex flex-col bg-[#111922] border-l border-[#1e2d42] overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-4 py-3 border-b border-[#1e2d42] flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {nodeTypeIcon(node.node_type)}
            <div className="min-w-0">
              <p className="text-[#c8daea] text-sm font-semibold truncate"
                title={node.node_type === 'link' ? (node.display_name || node.name) : node.name}>
                {node.node_type === 'link' ? (node.display_name || node.name) : node.name}
              </p>
              {node.node_type !== 'link' && node.display_name && node.display_name !== node.name && (
                <p className="text-[#7a9bb8] text-xs truncate mt-0.5" title={node.display_name}>
                  {node.display_name}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors p-1 rounded hover:bg-[#1e2d42] flex-shrink-0 ml-2"
          >
            <X size={15} />
          </button>
        </div>

        {/* Type badge */}
        <div className="px-4 py-2 border-b border-[#1e2d42] flex-shrink-0">
          <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-medium ${nodeTypeBadgeClass(node.node_type)}`}>
            {nodeTypeIcon(node.node_type)}
            {node.node_type}
          </span>
          {node.source && (
            <span className="ml-2 text-[10px] text-[#7a9bb8]">{t('graphExplorer.nodeDetail.source')}: {node.source}</span>
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
              <div className="px-4 py-3 border-b border-[#1e2d42]">
                <p className="text-[#7a9bb8] text-[11px] uppercase tracking-wide mb-2">{t('graphExplorer.nodeDetail.fields')}</p>
                <div className="space-y-1">
                  {fields.map((field, idx) => (
                    <div
                      key={`${field.name}-${idx}`}
                      className="flex items-center justify-between py-1 px-2 rounded hover:bg-[#0d1117] transition-colors"
                    >
                      <span className="text-[#c8daea] text-xs font-mono truncate flex-1">
                        {field.name}
                      </span>
                      {field.type && (
                        <span className="text-[#7a9bb8] text-[10px] font-mono ml-2 flex-shrink-0">
                          {field.type}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Aliases section */}
            <div className="px-4 py-3 border-b border-[#1e2d42]">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[#7a9bb8] text-[11px] uppercase tracking-wide">{t('graphExplorer.nodeDetail.semanticAliases')}</p>
                <button
                  onClick={() => setShowAliasEditor(true)}
                  className="flex items-center gap-0.5 text-[10px] text-[#7a9bb8] hover:text-[#c8daea] transition-colors px-1.5 py-0.5 rounded hover:bg-[#1e2d42]"
                >
                  <Plus size={11} />
                  {t('graphExplorer.aliasEditor.add')}
                </button>
              </div>
              {aliases.length === 0 ? (
                <p className="text-[#7a9bb8] text-xs italic">{t('graphExplorer.aliasEditor.noAliases')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {aliases.map((alias) => (
                    <span
                      key={alias}
                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#0d1117] border border-[#1e2d42] rounded text-[#c8daea] text-xs"
                    >
                      <Hash size={10} className="text-[#7a9bb8]" />
                      {alias}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Related edges */}
            {relatedEdges.length > 0 && (
              <div className="px-4 py-3">
                <p className="text-[#7a9bb8] text-[11px] uppercase tracking-wide mb-2">{t('graphExplorer.nodeDetail.relatedEdges')}</p>
                <div className="space-y-1">
                  {relatedEdges.map((edge) => (
                    <div
                      key={edge.id}
                      className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-[#0d1117] transition-colors"
                    >
                      <ArrowRight size={11} className={edgeTypeColor(edge.edge_type)} />
                      <span className={`text-[10px] font-medium ${edgeTypeColor(edge.edge_type)}`}>
                        {edge.edge_type}
                      </span>
                      <span className="text-[#7a9bb8] text-[10px] ml-auto flex-shrink-0">
                        w: {edge.weight.toFixed(2)}
                      </span>
                    </div>
                  ))}
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
