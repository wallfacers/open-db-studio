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

  const canQuery = pathFrom && pathTo && connectionId !== null;

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
      <div className="p-3 border-b border-[var(--border-default)] space-y-2">
        <div className="flex items-center gap-2">
          <span
            className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: 'var(--accent-subtle)', color: 'var(--success)', border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)' }}
          >
            FROM
          </span>
          {pathFrom ? (
            <div className="flex-1 flex items-center gap-1 min-w-0">
              <span className="text-[var(--foreground-default)] text-xs truncate flex-1">{pathFrom.name}</span>
              <button onClick={onClearFrom} className="flex-shrink-0 text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                <X size={11} />
              </button>
            </div>
          ) : (
            <span className="text-[var(--foreground-ghost)] text-xs">在搜索结果中点击 [S] 设置</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span
            className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: 'var(--primary-subtle)', color: 'var(--info)', border: '1px solid color-mix(in srgb, var(--info) 25%, transparent)' }}
          >
            TO
          </span>
          {pathTo ? (
            <div className="flex-1 flex items-center gap-1 min-w-0">
              <span className="text-[var(--foreground-default)] text-xs truncate flex-1">{pathTo.name}</span>
              <button onClick={onClearTo} className="flex-shrink-0 text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                <X size={11} />
              </button>
            </div>
          ) : (
            <span className="text-[var(--foreground-ghost)] text-xs">在搜索结果中点击 [T] 设置</span>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <label className="text-[var(--foreground-muted)] text-xs flex-shrink-0">最大跳数</label>
          <div className="flex items-stretch border border-[var(--border-default)] rounded overflow-hidden focus-within:border-[var(--accent-hover)] transition-colors" style={{ width: '56px' }}>
            <input
              type="number"
              min={1}
              value={maxHops}
              onChange={e => setMaxHops(Math.max(1, Number(e.target.value) || 1))}
              className="flex-1 min-w-0 bg-[var(--background-panel)] px-2 py-1 text-xs text-[var(--foreground-default)] focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <div className="flex flex-col border-l border-[var(--border-default)] bg-[var(--background-panel)]">
              <button type="button" onClick={() => setMaxHops(v => v + 1)}
                className="flex-1 flex items-center justify-center px-1 text-[var(--accent)] hover:text-[var(--accent)] hover:bg-[var(--background-elevated)] transition-colors border-b border-[var(--border-default)]">
                <svg width="7" height="4" viewBox="0 0 8 5" fill="currentColor"><path d="M4 0L8 5H0Z"/></svg>
              </button>
              <button type="button" onClick={() => setMaxHops(v => Math.max(1, v - 1))}
                className="flex-1 flex items-center justify-center px-1 text-[var(--accent)] hover:text-[var(--accent)] hover:bg-[var(--background-elevated)] transition-colors">
                <svg width="7" height="4" viewBox="0 0 8 5" fill="currentColor"><path d="M4 5L0 0H8Z"/></svg>
              </button>
            </div>
          </div>
          <button
            onClick={handleFindPath}
            disabled={!canQuery || loading}
            title={undefined}
            className="flex-1 flex items-center justify-center gap-1 py-1 text-xs rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent-hover) 33%, transparent)' }}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <GitFork size={12} />}
            {loading ? '查找中...' : '查找路径'}
          </button>
        </div>

      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-3 p-2 rounded text-xs text-[var(--error)] bg-[var(--error-subtle)] border border-[var(--error)]/30">
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
          <p className="text-[var(--foreground-muted)] text-xs text-center mt-8 px-4">
            在 {maxHops} 跳范围内未找到路径，可尝试增大跳数
          </p>
        )}

        {truncated && (
          <p className="text-[var(--foreground-muted)] text-[10px] text-center py-2 border-b border-[var(--border-default)]">
            仅显示前 {MAX_PATHS_SHOWN} 条路径
          </p>
        )}

        {shownPaths.map((path, idx) => (
          <div
            key={idx}
            onClick={() => handleSelectPath(idx)}
            className={`px-3 py-2 cursor-pointer border-b border-[var(--border-default)]/50 text-xs transition-colors ${
              selectedPathIndex === idx
                ? 'bg-[var(--accent-subtle)] border-l-2 border-l-[var(--accent)]'
                : 'hover:bg-[var(--background-hover)]'
            }`}
          >
            <p className="text-[var(--foreground-ghost)] text-[9px] mb-1">路径 {idx + 1} · {path.length} 节点</p>
            <p className="text-[var(--foreground-default)] leading-relaxed">
              {path.map((id, i) => (
                <span key={id}>
                  <span className={i === 0 ? 'text-[var(--success)]' : i === path.length - 1 ? 'text-[var(--info)]' : 'text-[var(--foreground-default)]'}>
                    {nodeDisplayMap[id] ?? id}
                  </span>
                  {i < path.length - 1 && <span className="text-[var(--foreground-ghost)] mx-1">→</span>}
                </span>
              ))}
            </p>
          </div>
        ))}

        {subgraph && shownPaths.length > 0 && (
          <div className="p-3 border-t border-[var(--border-default)]">
            {subgraphMode ? (
              <button
                onClick={onExitSubgraph}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs rounded border transition-colors"
                style={{ background: 'var(--background-hover)', color: 'var(--foreground-default)', borderColor: 'var(--border-default)' }}
              >
                <RotateCcw size={12} />
                恢复全图
              </button>
            ) : (
              <button
                onClick={handleEnterSubgraph}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs rounded border transition-colors"
                style={{ background: 'var(--accent-subtle)', color: 'var(--accent)', borderColor: 'var(--accent-hover)55' }}
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
