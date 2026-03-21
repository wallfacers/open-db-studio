import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { GraphNode } from './useGraphData';
import { SearchTab } from './SearchTab';
import { PathTab } from './PathTab';

type PanelTab = 'search' | 'path';

interface GraphSearchPanelProps {
  connectionId: number | null;
  visibleNodeIds: Set<string>;
  pathFrom: GraphNode | null;
  pathTo: GraphNode | null;
  subgraphMode: boolean;
  onClose: () => void;
  onSetPathFrom: (node: GraphNode) => void;
  onSetPathTo: (node: GraphNode) => void;
  onClearPathFrom: () => void;
  onClearPathTo: () => void;
  onHighlightNode: (nodeId: string) => void;
  onHighlightPath: (nodeIds: Set<string>, edgeIds: Set<string>) => void;
  onEnterSubgraph: (nodeIds: Set<string>) => void;
  onExitSubgraph: () => void;
}

export function GraphSearchPanel({
  connectionId,
  visibleNodeIds,
  pathFrom,
  pathTo,
  subgraphMode,
  onClose,
  onSetPathFrom,
  onSetPathTo,
  onClearPathFrom,
  onClearPathTo,
  onHighlightNode,
  onHighlightPath,
  onEnterSubgraph,
  onExitSubgraph,
}: GraphSearchPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('search');

  return (
    <div
      className="flex flex-col border-l border-[#1e2d42] bg-[#0d1117] flex-shrink-0"
      style={{ width: 280 }}
    >
      {/* Panel header with tabs */}
      <div className="flex items-center border-b border-[#1e2d42] flex-shrink-0">
        {(['search', 'path'] as PanelTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === tab
                ? 'border-[#00c9a7] text-[#e8f4ff]'
                : 'border-transparent text-[#7a9bb8] hover:text-[#c8daea]'
            }`}
          >
            {tab === 'search' ? '搜索' : '路径'}
          </button>
        ))}
        <button
          onClick={onClose}
          className="px-2 py-2 text-[#7a9bb8] hover:text-white transition-colors flex-shrink-0"
          aria-label="关闭搜索面板"
        >
          <X size={14} />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'search' ? (
          <SearchTab
            connectionId={connectionId}
            visibleNodeIds={visibleNodeIds}
            onSetPathFrom={onSetPathFrom}
            onSetPathTo={onSetPathTo}
            onHighlightNode={onHighlightNode}
            onSwitchToPath={() => setActiveTab('path')}
          />
        ) : (
          <PathTab
            connectionId={connectionId}
            pathFrom={pathFrom}
            pathTo={pathTo}
            onClearFrom={onClearPathFrom}
            onClearTo={onClearPathTo}
            onHighlightPath={onHighlightPath}
            onEnterSubgraph={onEnterSubgraph}
            subgraphMode={subgraphMode}
            onExitSubgraph={onExitSubgraph}
          />
        )}
      </div>
    </div>
  );
}
