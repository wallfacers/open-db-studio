// src/mcp/fs/adapters/DbTreeAdapter.ts
import { useTreeStore } from '../../../store/treeStore'
import type { FsAdapter, FsSearchFilter, FsSearchResult } from '../types'

/**
 * DbTreeAdapter — 处理 resource="panel.db-tree" 的所有操作。
 *
 * 支持：
 *   fs_search("panel.db-tree", { keyword, type?, connection_id? })
 *     → 搜索前端已缓存的树节点（useTreeStore.nodes）
 *     → 替代旧的 search_db_metadata MCP 工具
 *
 * 不支持（暂未实现）：
 *   fs_read / fs_write / fs_open / fs_exec（会抛出 Unsupported 错误）
 */
export class DbTreeAdapter implements FsAdapter {
  readonly capabilities = {
    read:   false as const,
    write:  false as const,
    search: true as const,
    open:   false as const,
    exec:   [] as string[],
  }

  async search(filter: FsSearchFilter): Promise<FsSearchResult[]> {
    const nodes = useTreeStore.getState().nodes
    const kw   = filter.keyword?.toLowerCase() ?? ''
    const type = (filter as Record<string, unknown>)['type'] as string | undefined
    const connId = (filter as Record<string, unknown>)['connection_id'] as number | undefined

    const results: FsSearchResult[] = []

    for (const [nodeId, node] of nodes.entries()) {
      if (kw && !node.label.toLowerCase().includes(kw)) continue
      if (type && node.nodeType !== type) continue
      if (connId !== undefined && node.meta?.connectionId !== connId) continue

      results.push({
        resource: 'panel.db-tree',
        target:   nodeId,
        label:    `${node.nodeType} · ${node.label}`,
        meta: {
          node_id:       nodeId,
          name:          node.label,
          type:          node.nodeType,
          connection_id: node.meta?.connectionId,
        },
      })
    }

    return results
  }
}
