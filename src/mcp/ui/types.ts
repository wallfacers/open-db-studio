// ── JSON Patch (RFC 6902) ──────────────────────────────────

export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'
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
  database?: string

  /** Declare supported patch paths. If present, UIRouter validates before forwarding. */
  patchCapabilities?: PatchCapability[]

  read(mode: 'state' | 'schema' | 'actions' | 'full'): any
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

// ── JSON Schema (subset for ActionDef) ────────────────────
export interface JsonSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
}

// ── Patch Capability Declaration ──────────────────────────
export interface PatchCapability {
  /** Path pattern, e.g. "/tables/[id=<n>]/<field>" */
  pathPattern: string
  /** Supported ops for this path */
  ops: ('replace' | 'add' | 'remove')[]
  /** Human-readable description */
  description: string
  /** Keys usable in [key=value] addressing, e.g. ['id', 'name'] */
  addressableBy?: string[]
}

export interface ActionDef {
  name: string
  description: string
  paramsSchema: JsonSchema
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
  createdAt: number          // Date.now() — used by PatchConfirmPanel to auto-reject expired patches
  onConfirm: () => void
  onReject?: () => void
}
