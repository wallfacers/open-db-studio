import dagre from 'dagre'
import type { Node, Edge } from '@xyflow/react'

const DAGRE_CONFIG = {
  rankdir: 'TB',
  nodesep: 50,
  ranksep: 50,
  edgesep: 20,
} as const

const DEFAULT_NODE_SIZE = { width: 200, height: 150 }

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
    g.setNode(node.id, {
      width: node.width || DEFAULT_NODE_SIZE.width,
      height: node.height || DEFAULT_NODE_SIZE.height,
    })
  }

  if (edges) {
    for (const edge of edges) {
      g.setEdge(edge.source, edge.target)
    }
  }

  dagre.layout(g)

  return nodes.map((node) => {
    const gNode = g.node(node.id)
    if (gNode) {
      return {
        ...node,
        position: {
          x: gNode.x - (gNode.width ?? DEFAULT_NODE_SIZE.width) / 2,
          y: gNode.y - (gNode.height ?? DEFAULT_NODE_SIZE.height) / 2,
        },
      }
    }
    return node
  })
}
