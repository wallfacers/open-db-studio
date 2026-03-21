import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GraphNode, GraphEdge } from './useGraphData';

export interface SubGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  join_paths: string[][];
}

interface UsePathFinderResult {
  loading: boolean;
  error: string | null;
  subgraph: SubGraph | null;
  findPath: (
    connectionId: number,
    fromNodeId: string,
    toNodeId: string,
    maxHops: number,
  ) => Promise<void>;
  reset: () => void;
  nodeDisplayMap: Record<string, string>;
}

export function usePathFinder(): UsePathFinderResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subgraph, setSubgraph] = useState<SubGraph | null>(null);
  const [nodeDisplayMap, setNodeDisplayMap] = useState<Record<string, string>>({});

  const findPath = useCallback(async (
    connectionId: number,
    fromNodeId: string,
    toNodeId: string,
    maxHops: number,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const sg = await invoke<SubGraph>('find_subgraph', {
        connectionId,
        fromNodeId,
        toNodeId,
        maxHops,
      });
      setSubgraph(sg);
      const map: Record<string, string> = {};
      sg.nodes.forEach(n => { map[n.id] = n.display_name || n.name; });
      setNodeDisplayMap(map);
    } catch (e) {
      setError(String(e));
      setSubgraph(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setSubgraph(null);
    setError(null);
    setNodeDisplayMap({});
  }, []);

  return { loading, error, subgraph, findPath, reset, nodeDisplayMap };
}
