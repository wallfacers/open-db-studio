import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Search } from 'lucide-react';
import type { GraphNode } from './useGraphData';
import { useGraphSearch } from './useGraphSearch';
import { useReactFlow } from '@xyflow/react';
import { Tooltip } from '../common/Tooltip';

interface SearchTabProps {
  connectionId: number | null;
  visibleNodeIds: Set<string>;
  onSetPathFrom: (node: GraphNode) => void;
  onSetPathTo: (node: GraphNode) => void;
  onHighlightNode: (nodeId: string) => void;
  onSwitchToPath: () => void;
}

export function SearchTab({
  connectionId,
  visibleNodeIds,
  onSetPathFrom,
  onSetPathTo,
  onHighlightNode,
  onSwitchToPath,
}: SearchTabProps) {
  const { t } = useTranslation();
  const { keyword, setKeyword, results, loading, searched } = useGraphSearch(connectionId);
  const { fitView } = useReactFlow();

  const handleItemClick = (node: GraphNode) => {
    onHighlightNode(node.id);
    fitView({ nodes: [{ id: node.id }], duration: 500, padding: 0.3, maxZoom: 1.5 });
  };

  const handleSetFrom = (e: React.MouseEvent, node: GraphNode) => {
    e.stopPropagation();
    onSetPathFrom(node);
    onSwitchToPath();
  };

  const handleSetTo = (e: React.MouseEvent, node: GraphNode) => {
    e.stopPropagation();
    onSetPathTo(node);
    onSwitchToPath();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search Input */}
      <div className="p-3 border-b border-[var(--border-default)]">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)] pointer-events-none" />
          {loading && (
            <Loader2 size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)] animate-spin" />
          )}
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder={t('graphExplorer.searchTab.searchPlaceholder')}
            className="w-full pl-7 pr-7 py-1.5 text-xs bg-[var(--background-panel)] border border-[var(--border-default)] rounded text-[var(--foreground-default)] placeholder-[var(--foreground-ghost)] focus:outline-none focus:border-[var(--accent-hover)] transition-colors"
          />
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {!searched && !loading && (
          <p className="text-[var(--foreground-ghost)] text-xs text-center mt-8 px-4">{t('graphExplorer.searchTab.searchHint')}</p>
        )}

        {searched && results.length === 0 && !loading && (
          <p className="text-[var(--foreground-muted)] text-xs text-center mt-8 px-4">{t('graphExplorer.searchTab.noResults')}</p>
        )}

        {results.map(node => {
          const isTable = node.node_type === 'table';
          const isHidden = !visibleNodeIds.has(node.id);
          return (
            <div
              key={node.id}
              onClick={() => handleItemClick(node)}
              className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--background-hover)] border-b border-[var(--border-default)]/50 group"
            >
              <span
                className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded font-mono"
                style={{
                  background: node.node_type === 'table' ? 'var(--node-table-bg)'
                    : node.node_type === 'metric' ? 'var(--node-metric-bg)'
                    : 'var(--node-alias-bg)',
                  color: node.node_type === 'table' ? 'var(--node-table)'
                    : node.node_type === 'metric' ? 'var(--node-metric)'
                    : 'var(--node-alias)',
                }}
              >
                {node.node_type.toUpperCase()}
              </span>

              <div className="flex-1 min-w-0">
                <p className="text-[var(--foreground-default)] text-xs truncate">{node.name}</p>
                {node.display_name && node.display_name !== node.name && (
                  <p className="text-[var(--foreground-ghost)] text-[10px] truncate">{node.display_name}</p>
                )}
                {isHidden && (
                  <p className="text-[var(--warning)] text-[9px]">{t('graphExplorer.searchTab.filteredHidden')}</p>
                )}
              </div>

              <div className="flex-shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Tooltip content={isTable ? t('graphExplorer.searchTab.setAsStart') : t('graphExplorer.searchTab.tableOnly')} className="contents">
                  <button
                    onClick={e => handleSetFrom(e, node)}
                    disabled={!isTable}
                    className="w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ background: 'var(--accent-subtle)', color: 'var(--success)', border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)' }}
                  >
                    S
                  </button>
                </Tooltip>
                <Tooltip content={isTable ? t('graphExplorer.searchTab.setAsEnd') : t('graphExplorer.searchTab.tableOnly')} className="contents">
                  <button
                    onClick={e => handleSetTo(e, node)}
                    disabled={!isTable}
                    className="w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ background: 'var(--primary-subtle)', color: 'var(--info)', border: '1px solid color-mix(in srgb, var(--info) 25%, transparent)' }}
                  >
                    T
                  </button>
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
