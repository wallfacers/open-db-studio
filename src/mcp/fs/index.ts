// src/mcp/fs/index.ts
import { FsRouter } from './FsRouter'
import { QueryTabAdapter } from './adapters/QueryTabAdapter'

export const fsRouter = new FsRouter()

/**
 * 注册所有 FsAdapter。
 * 在 useMcpBridge 初始化时调用，设计为幂等（重复调用只是覆盖 Map 中的同 key）。
 * Phase 2 在此追加 TableTabAdapter、MetricTabAdapter。
 * Phase 3 在此追加 DbTreeAdapter、TaskCenterAdapter、LlmSettingsAdapter、ConnSettingsAdapter。
 */
export function registerFsAdapters(): void {
  fsRouter.register('tab.query', new QueryTabAdapter())
  // Phase 2: fsRouter.register('tab.table',  new TableTabAdapter())
  // Phase 2: fsRouter.register('tab.metric', new MetricTabAdapter())
  // Phase 3: fsRouter.register('panel.db-tree',   new DbTreeAdapter())
  // Phase 3: fsRouter.register('panel.tasks',      new TaskCenterAdapter())
  // Phase 3: fsRouter.register('settings.llm',     new LlmSettingsAdapter())
  // Phase 3: fsRouter.register('settings.conn',    new ConnSettingsAdapter())
}

export type {
  FsOp, FsAdapter, FsMcpRequest, FsReadResult, FsWriteResult,
  FsWritePatch, FsSearchFilter, FsSearchResult,
} from './types'
