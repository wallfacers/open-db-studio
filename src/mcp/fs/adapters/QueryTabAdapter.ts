// src/mcp/fs/adapters/QueryTabAdapter.ts
import { emit } from '@tauri-apps/api/event'
import { useQueryStore } from '../../../store/queryStore'
import { useAppStore }   from '../../../store/appStore'
import type {
  FsAdapter, FsReadResult, FsWriteResult, FsWritePatch,
  FsSearchFilter, FsSearchResult,
} from '../types'

function resolveTabId(target: string): string {
  if (target === 'active') return useQueryStore.getState().activeTabId
  return target
}

function buildLines(content: string): Array<{ no: number; text: string }> {
  return content.split('\n').map((text, i) => ({ no: i + 1, text }))
}

function applyTextPatch(original: string, patch: FsWritePatch): string {
  const lines = original.split('\n')

  switch (patch.op) {
    case 'replace_all':
      return patch.content ?? ''

    case 'replace': {
      if (!patch.range) return patch.content ?? ''
      const [from, to] = patch.range  // 1-indexed
      const before   = lines.slice(0, from - 1)
      const after    = lines.slice(to)
      const newLines = (patch.content ?? '').split('\n')
      return [...before, ...newLines, ...after].join('\n')
    }

    case 'insert_after': {
      const lineNo   = patch.line ?? 0  // 1-indexed：在第 lineNo 行后插入
      const before   = lines.slice(0, lineNo)
      const after    = lines.slice(lineNo)
      const newLines = (patch.content ?? '').split('\n')
      return [...before, ...newLines, ...after].join('\n')
    }

    default:
      return patch.content ?? original
  }
}

export class QueryTabAdapter implements FsAdapter {
  capabilities = {
    read:   true,
    write:  true,
    search: true,
    open:   true,
    exec:   ['focus', 'run_sql', 'undo', 'confirm_write'],
  }

  async read(target: string, mode: 'text' | 'struct'): Promise<FsReadResult> {
    const tabId = resolveTabId(target)
    const { tabs, sqlContent } = useQueryStore.getState()
    const tab = tabs.find(t => t.id === tabId)
    if (!tab) throw new Error(`Tab not found: ${target}`)

    if (mode === 'struct') {
      return {
        type:          'query',
        tab_id:        tab.id,
        title:         tab.title,
        connection_id: tab.connectionId ?? null,
        db:            tab.db ?? null,
      }
    }

    // text 模式
    const content = sqlContent[tabId] ?? ''
    return {
      content,
      lines:          buildLines(content),
      cursor_line:    null,
      selected_range: null,
      statements:     content ? [content] : [],
    }
  }

  async write(target: string, patch: FsWritePatch): Promise<FsWriteResult> {
    const tabId = resolveTabId(target)
    const { tabs, sqlContent, proposeSqlDiff, setSql } = useQueryStore.getState()
    const tab = tabs.find(t => t.id === tabId)
    if (!tab) throw new Error(`Tab not found: ${target}`)

    const original = sqlContent[tabId] ?? ''
    const modified = applyTextPatch(original, patch)
    const { autoMode } = useAppStore.getState()

    if (autoMode) {
      setSql(tabId, modified)
      return { status: 'applied' }
    }

    // 非 Auto 模式：走 proposeSqlDiff → DiffPanel
    // NOTE: startOffset/endOffset 设为全文范围（replace_all 语义）
    proposeSqlDiff({
      tabId,
      original,
      modified,
      reason: patch.reason ?? '',
      startOffset: 0,
      endOffset: original.length,
    })
    return { status: 'pending_confirm', confirm_id: `${tabId}-diff` }
  }

  async search(filter: FsSearchFilter): Promise<FsSearchResult[]> {
    const { tabs } = useQueryStore.getState()
    const kw = filter.keyword?.toLowerCase()

    return tabs
      .filter(t => t.type === 'query')
      .filter(t => !kw || t.title.toLowerCase().includes(kw))
      .map(t => ({
        resource: 'tab.query',
        target:   t.id,
        label:    `query · ${t.title}`,
        meta:     { connection_id: t.connectionId, db: t.db ?? null },
      }))
  }

  async open(params: Record<string, unknown>): Promise<{ target: string }> {
    const connId   = params.connection_id as number
    const label    = (params.label as string | undefined) ?? `Connection #${connId}`
    const database = params.database as string | undefined

    const { openQueryTab } = useQueryStore.getState()
    const beforeIds = new Set(useQueryStore.getState().tabs.map(t => t.id))

    openQueryTab(connId, label, database)

    // 等待 store 微任务更新
    await Promise.resolve()

    const { tabs: after } = useQueryStore.getState()
    const newTab = after.find(t => t.type === 'query' && !beforeIds.has(t.id))
    if (!newTab) throw new Error('openQueryTab did not produce a new tab')
    return { target: newTab.id }
  }

  async exec(target: string, action: string, _params?: Record<string, unknown>): Promise<unknown> {
    const tabId = resolveTabId(target)

    switch (action) {
      case 'focus':
        useQueryStore.getState().setActiveTabId(tabId)
        return { ok: true }

      case 'run_sql':
        await emit('run-sql-request', { tab_id: tabId })
        return { ok: true }

      case 'undo':
        await emit('undo-request', { tab_id: tabId })
        return { ok: true }

      case 'confirm_write':
        // DiffPanel 通过 store 的 proposeSqlDiff 流程自行处理确认，此处为 stub
        return { ok: true }

      default:
        throw new Error(`Unknown action: ${action}`)
    }
  }
}
