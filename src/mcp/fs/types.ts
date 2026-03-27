// src/mcp/fs/types.ts

export type FsOp = 'read' | 'write' | 'search' | 'open' | 'exec'

export interface FsMcpRequest {
  op:       FsOp
  resource: string                        // 精确类型，如 "tab.query"
  target:   string                        // "active" | "list" | tab_id | 名称
  payload:  Record<string, unknown>
}

export interface FsReadResult {
  [key: string]: unknown
}

export interface FsWriteResult {
  status:      'applied' | 'pending_confirm' | 'error'
  confirm_id?: string
  preview?:    string
  message?:    string
}

export interface FsSearchFilter {
  keyword?:       string
  type?:          string
  connection_id?: number
  [key: string]:  unknown
}

export interface FsSearchResult {
  resource: string
  target:   string
  label:    string
  meta:     Record<string, unknown>
}

export type TextPatchOp = 'replace' | 'insert_after' | 'replace_all'

export interface FsWritePatch {
  mode:     'text' | 'struct'
  // text 模式
  op?:      TextPatchOp
  range?:   [number, number]   // [fromLine, toLine]，1-indexed
  line?:    number             // insert_after 用
  content?: string
  // struct 模式
  path?:    string             // JSON path，如 "/columns/1/comment"
  value?:   unknown
  // 通用
  reason?:  string
}

export interface FsAdapter {
  capabilities: {
    read:   boolean
    write:  boolean
    search: boolean
    open:   boolean
    exec:   string[]           // 支持的 action 名列表
  }

  read?(target: string, mode: 'text' | 'struct'): Promise<FsReadResult>
  write?(target: string, patch: FsWritePatch): Promise<FsWriteResult>
  search?(filter: FsSearchFilter): Promise<FsSearchResult[]>
  open?(params: Record<string, unknown>): Promise<{ target: string }>
  exec?(target: string, action: string, params?: Record<string, unknown>): Promise<unknown>
}
