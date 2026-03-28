// ── JSON Patch (RFC 6902) ──────────────────────────────────

export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy'
  path: string        // JSON Pointer (RFC 6901) or [key=value] extension
  value?: any          // required for add/replace
  from?: string        // required for move/copy
}

// ── MCP Request / Response ─────────────────────────────────

export interface UIRequest {
  tool: 'ui_read' | 'ui_patch' | 'ui_exec' | 'ui_list'
  object: string       // object type: query_editor, table_form, etc.
  target: string       // objectId or "active"
  payload: any         // tool-specific payload
}

export interface UIResponse {
  data?: any
  error?: string
  status?: 'applied' | 'pending_confirm'
  confirm_id?: string
}

// ── UIObject Interface ─────────────────────────────────────

export interface UIObject {
  type: string
  objectId: string
  title: string
  connectionId?: number

  read(mode: 'state' | 'schema' | 'actions'): any
  patch(ops: JsonPatchOp[], reason?: string): PatchResult | Promise<PatchResult>
  exec(action: string, params?: any): ExecResult | Promise<ExecResult>
}

export interface PatchResult {
  status: 'applied' | 'pending_confirm' | 'error'
  confirm_id?: string
  preview?: JsonPatchOp[]
  message?: string
}

export interface ExecResult {
  success: boolean
  data?: any
  error?: string
}

// ── Action Self-Description ────────────────────────────────

export interface ActionDef {
  name: string
  description: string
  paramsSchema?: Record<string, any>
}

// ── UIObject Info (for ui_list) ────────────────────────────

export interface UIObjectInfo {
  objectId: string
  type: string
  title: string
  connectionId?: number
  database?: string
}

// ── Patch Confirm Store ────────────────────────────────────

export interface PendingPatch {
  confirmId: string
  objectId: string
  objectType: string
  ops: JsonPatchOp[]
  reason?: string
  currentState: any
  onConfirm: () => void
  onReject?: () => void
}
