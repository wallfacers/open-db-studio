// src/mcp/fs/index.ts
import { FsRouter } from './FsRouter'
import { QueryTabAdapter } from './adapters/QueryTabAdapter'
import { DbTreeAdapter } from './adapters/DbTreeAdapter'

export const fsRouter = new FsRouter()

/**
 * 注册所有 FsAdapter。
 * 在 useMcpBridge 初始化时调用，设计为幂等（重复调用只是覆盖 Map 中的同 key）。
 *
 * 已注册（Phase 1）：
 *   tab.query     → QueryTabAdapter（读写SQL、搜索查询Tab、执行/聚焦/撤销）
 *   panel.db-tree → DbTreeAdapter（搜索已缓存树节点，替代旧 search_db_metadata）
 *
 * tab.metric / tab.table / panel.history 由 Rust 侧直接路由处理（无前端 roundtrip）。
 *
 * 待注册（Phase 3）：
 *   panel.tasks       → TaskCenterAdapter
 *   settings.llm      → LlmSettingsAdapter
 *   settings.conn     → ConnSettingsAdapter
 */
export function registerFsAdapters(): void {
  fsRouter.register('tab.query',      new QueryTabAdapter())
  fsRouter.register('panel.db-tree',  new DbTreeAdapter())
  // Phase 3: fsRouter.register('panel.tasks',   new TaskCenterAdapter())
  // Phase 3: fsRouter.register('settings.llm',  new LlmSettingsAdapter())
  // Phase 3: fsRouter.register('settings.conn', new ConnSettingsAdapter())
}

export type {
  FsOp, FsAdapter, FsMcpRequest, FsReadResult, FsWriteResult,
  FsWritePatch, FsSearchFilter, FsSearchResult,
} from './types'
