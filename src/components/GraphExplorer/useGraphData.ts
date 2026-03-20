import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface GraphNode {
  id: string;
  node_type: string;
  name: string;
  display_name: string;
  aliases: string;
  metadata: string;
  connection_id: number;
  is_deleted: number;
  source: string;
}

export interface GraphEdge {
  id: string;
  from_node: string;
  to_node: string;
  edge_type: string;
  weight: number;
  source: string;
}

interface UseGraphDataResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useGraphData(connectionId: number | null): UseGraphDataResult {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (connectionId === null) {
      setNodes([]);
      setEdges([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const fetchedNodes = await invoke<GraphNode[]>('get_graph_nodes', {
        connectionId,
      });

      setNodes(fetchedNodes);

      if (fetchedNodes.length === 0) {
        setEdges([]);
        return;
      }

      const nodeIds = fetchedNodes.map((n) => n.id);
      const fetchedEdges = await invoke<GraphEdge[]>('get_graph_edges', {
        connectionId,
        nodeIds,
      });

      setEdges(fetchedEdges);
    } catch (err) {
      const msg = typeof err === 'string' ? err : (err as Error)?.message ?? '加载图谱数据失败';
      setError(msg);
      console.warn('[useGraphData] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { nodes, edges, loading, error, refetch: fetchData };
}
