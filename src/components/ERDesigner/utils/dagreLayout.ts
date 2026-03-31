import dagre from 'dagre'
import type { Node, Edge } from '@xyflow/react'

const DAGRE_CONFIG = {
  rankdir: 'LR',
  nodesep: 80,
  ranksep: 200,
  edgesep: 40,
} as const

const DEFAULT_NODE_SIZE = { width: 260, height: 120 }

/**
 * Run dagre auto-layout on a set of nodes (and optional edges),
 * returning a new array of nodes with updated positions.
 *
 * The function is not generic on node data type — callers should
 * cast the return value when they need a specific `Node<T>`.
 */
export function layoutNodesWithDagre(
  nodes: Node[],
  edges?: Edge[],
): Node[] {
  if (nodes.length === 0) return nodes

  const g = new dagre.graphlib.Graph()
  g.setGraph(DAGRE_CONFIG)
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of nodes) {
    const width = node.measured?.width ?? node.width ?? DEFAULT_NODE_SIZE.width;
    const height = node.measured?.height ?? node.height ?? DEFAULT_NODE_SIZE.height;
    g.setNode(node.id, {
      width,
      height,
    });
  }

  if (edges) {
    for (const edge of edges) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const gNode = g.node(node.id);
    if (gNode) {
      const width = node.measured?.width ?? node.width ?? DEFAULT_NODE_SIZE.width;
      const height = node.measured?.height ?? node.height ?? DEFAULT_NODE_SIZE.height;
      return {
        ...node,
        position: {
          x: gNode.x - width / 2,
          y: gNode.y - height / 2,
        },
      };
    }
    return node;
  });
}
