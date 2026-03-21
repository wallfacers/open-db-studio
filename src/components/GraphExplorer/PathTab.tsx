import React, { useState } from 'react';
import { Loader2, X, RotateCcw, GitFork } from 'lucide-react';
import type { GraphNode } from './useGraphData';
import { usePathFinder } from './usePathFinder';
import { useReactFlow } from '@xyflow/react';

const MAX_PATHS_SHOWN = 20;

interface PathTabProps {
  connectionId: number | null;
  pathFrom: GraphNode | null;
  pathTo: GraphNode | null;
  onClearFrom: () => void;
  onClearTo: () => void;
  onHighlightPath: (nodeIds: Set<string>, edgeIds: Set<string>) => void;
  onEnterSubgraph: (nodeIds: Set<string>) => void;
  subgraphMode: boolean;
  onExitSubgraph: () => void;
}

export function PathTab({
  connectionId,
  pathFrom,
  pathTo,
  onClearFrom,
  onClearTo,
  onHighlightPath,
  onEnterSubgraph,
  subgraphMode,
  onExitSubgraph,
}: PathTabProps) {
  const [maxHops, setMaxHops] = useState(3);
  const [selectedPathIndex, setSelectedPathIndex] = useState<number | null>(null);
  const { loading, error, subgraph, findPath, reset, nodeDisplayMap } = usePathFinder();
  const { fitView } = useReactFlow();

  const sameNode = pathFrom && pathTo && pathFrom.id === pathTo.id;
  const canQuery = pathFrom && pathTo && !sameNode && connectionId !== null;

  const handleFindPath = async () => {
    if (!canQuery) return;
    setSelectedPathIndex(null);
    reset();
    await findPath(connectionId!, pathFrom!.id, pathTo!.id, maxHops);
  };

  const handleSelectPath = (pathIndex: number) => {
    if (!subgraph) return;
    const path = subgraph.join_paths[pathIndex];
    if (!path) return;
    setSelectedPathIndex(pathIndex);

    const pathNodeSet = new Set(path);
    const pathEdgeSet = new Set<string>(
      subgraph.edges
        .filter(e => pathNodeSet.has(e.from_node) && pathNodeSet.has(e.to_node))
        .map(e => e.id)
    );

    onHighlightPath(pathNodeSet, pathEdgeSet);
    fitView({ nodes: path.map(id => ({ id })), duration: 500, padding: 0.3, maxZoom: 1.5 });
  };

  const handleEnterSubgraph = () => {
    if (!subgraph) return;
    const allIds = new Set(subgraph.nodes.map(n => n.id));
    onEnterSubgraph(allIds);
  };

  const shownPaths = subgraph ? subgraph.join_paths.slice(0, MAX_PATHS_SHOWN) : [];
  const truncated = subgraph && subgraph.join_paths.length > MAX_PATHS_SHOWN;

  return (
    <div className="flex flex-col h-full">
      {/* Endpoint slots */}
      <div className="p-3 border-b border-[#1e2d42] space-y-2">
        <div className="flex items-center gap-2">
          <span
            className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: '#0a2010', color: '#4ade80', border: '1px solid #4ade8044' }}
          >
            FROM
          </span>
          {pathFrom ? (
            <div className="flex-1 flex items-center gap-1 min-w-0">
              <span className="text-[#c8daea] text-xs truncate flex-1">{pathFrom.name}</span>
              <button onClick={onClearFrom} className="flex-shrink-0 text-[#7a9bb8] hover:text-white">
                <X size={11} />
              </button>
            </div>
          ) : (
            <span className="text-[#3d5470] text-xs">在搜索结果中点击 [S] 设置</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span
            className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: '#0a1525', color: '#5eb2f7', border: '1px solid #5eb2f744' }}
          >
            TO
          </span>
          {pathTo ? (
            <div className="flex-1 flex items-center gap-1 min-w-0">
              <span className="text-[#c8daea] text-xs truncate flex-1">{pathTo.name}</span>
              <button onClick={onClearTo} className="flex-shrink-0 text-[#7a9bb8] hover:text-white">
                <X size={11} />
              </button>
            </div>
          ) : (
            <span className="text-[#3d5470] text-xs">在搜索结果中点击 [T] 设置</span>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <label className="text-[#7a9bb8] text-xs flex-shrink-0">最大跳数</label>
          <div className="flex items-stretch border border-[#1e2d42] rounded overflow-hidden focus-within:border-[#00a98f] transition-colors" style={{ width: '56px' }}>
            <input
              type="number"
              min={1}
              value={maxHops}
              onChange={e => setMaxHops(Math.max(1, Number(e.target.value) || 1))}
              className="flex-1 min-w-0 bg-[#111922] px-2 py-1 text-xs text-[#c8daea] focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <div className="flex flex-col border-l border-[#1e2d42] bg-[#111922]">
              <button type="button" onClick={() => setMaxHops(v => v + 1)}
                className="flex-1 flex items-center justify-center px-1 text-[#00c9a7] hover:text-[#29edd0] hover:bg-[#151d28] transition-colors border-b border-[#1e2d42]">
                <svg width="7" height="4" viewBox="0 0 8 5" fill="currentColor"><path d="M4 0L8 5H0Z"/></svg>
              </button>
              <button type="button" onClick={() => setMaxHops(v => Math.max(1, v - 1))}
                className="flex-1 flex items-center justify-center px-1 text-[#00c9a7] hover:text-[#29edd0] hover:bg-[#151d28] transition-colors">
                <svg width="7" height="4" viewBox="0 0 8 5" fill="currentColor"><path d="M4 5L0 0H8Z"/></svg>
              </button>
            </div>
          </div>
          <button
            onClick={handleFindPath}
            disabled={!canQuery || loading}
            title={sameNode ? '起点和终点不能相同' : undefined}
            className="flex-1 flex items-center justify-center gap-1 py-1 text-xs rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: '#0a1f18', color: '#00c9a7', borderColor: '#00a98f55' }}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <GitFork size={12} />}
            {loading ? '查找中...' : '查找路径'}
          </button>
        </div>

        {sameNode && (
          <p className="text-[#f43f5e] text-[10px]">起点和终点不能相同</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-3 p-2 rounded text-xs text-[#f43f5e] bg-[#2d1216] border border-[#f43f5e]/30">
            {error}
            <button
              onClick={handleFindPath}
              className="ml-2 underline underline-offset-2 hover:no-underline"
            >
              重试
            </button>
          </div>
        )}

        {subgraph && shownPaths.length === 0 && (
          <p className="text-[#7a9bb8] text-xs text-center mt-8 px-4">
            在 {maxHops} 跳范围内未找到路径，可尝试增大跳数
          </p>
        )}

        {truncated && (
          <p className="text-[#7a9bb8] text-[10px] text-center py-2 border-b border-[#1e2d42]">
            仅显示前 {MAX_PATHS_SHOWN} 条路径
          </p>
        )}

        {shownPaths.map((path, idx) => (
          <div
            key={idx}
            onClick={() => handleSelectPath(idx)}
            className={`px-3 py-2 cursor-pointer border-b border-[#1e2d42]/50 text-xs transition-colors ${
              selectedPathIndex === idx
                ? 'bg-[#003d2f] border-l-2 border-l-[#00c9a7]'
                : 'hover:bg-[#1a2639]'
            }`}
          >
            <p className="text-[#3d5470] text-[9px] mb-1">路径 {idx + 1} · {path.length} 节点</p>
            <p className="text-[#c8daea] leading-relaxed">
              {path.map((id, i) => (
                <span key={id}>
                  <span className={i === 0 ? 'text-[#4ade80]' : i === path.length - 1 ? 'text-[#5eb2f7]' : 'text-[#c8daea]'}>
                    {nodeDisplayMap[id] ?? id}
                  </span>
                  {i < path.length - 1 && <span className="text-[#3d5470] mx-1">→</span>}
                </span>
              ))}
            </p>
          </div>
        ))}

        {subgraph && shownPaths.length > 0 && (
          <div className="p-3 border-t border-[#1e2d42]">
            {subgraphMode ? (
              <button
                onClick={onExitSubgraph}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs rounded border transition-colors"
                style={{ background: '#1a2639', color: '#c8daea', borderColor: '#1e2d42' }}
              >
                <RotateCcw size={12} />
                恢复全图
              </button>
            ) : (
              <button
                onClick={handleEnterSubgraph}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs rounded border transition-colors"
                style={{ background: '#003d2f', color: '#00c9a7', borderColor: '#00a98f55' }}
              >
                <GitFork size={12} />
                提取子图
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
