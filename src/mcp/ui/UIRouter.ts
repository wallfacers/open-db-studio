import type { UIObject, UIRequest, UIResponse, UIObjectInfo, ActionDef, PatchResult } from './types'
import { patchError, execError } from './errors'
import { matchPathPattern } from './pathResolver'

export class UIRouter {
  private instances = new Map<string, UIObject>()
  private _getActiveTabId: (() => string | null) | null = null

  /** Inject a function that returns the currently active tab ID. Avoids circular deps with store. */
  setActiveTabIdProvider(fn: () => string | null) {
    this._getActiveTabId = fn
  }

  registerInstance(objectId: string, instance: UIObject) {
    this.instances.set(objectId, instance)
  }

  unregisterInstance(objectId: string) {
    this.instances.delete(objectId)
  }

  async handle(req: UIRequest): Promise<UIResponse> {
    if (req.tool === 'ui_list') {
      return this.handleList(req.payload?.filter)
    }

    // Try to resolve target; if not found and target is a specific objectId (not 'active'/singleton),
    // retry with backoff to handle race where React component hasn't mounted yet.
    let instance = this.resolveTarget(req.object, req.target)
    if (!instance && req.target && req.target !== 'active' && req.object !== 'workspace') {
      instance = await this.resolveTargetWithRetry(req.object, req.target, 2000, 100)
    }
    if (!instance) {
      return { error: `No ${req.object} found for target '${req.target}'` }
    }

    try {
      switch (req.tool) {
        case 'ui_read': {
          const data = instance.read(req.payload?.mode ?? 'state')
          return { data }
        }
        case 'ui_patch':
          return this.handlePatch(instance, req.payload)
        case 'ui_exec':
          return this.handleExec(instance, req.payload)
        default:
          return { error: `Unknown tool: ${req.tool}` }
      }
    } catch (e) {
      return { error: String(e) }
    }
  }

  // ── Patch pre-check ───────────────────────────────────────

  private patchResponse(result: PatchResult): UIResponse {
    return {
      data: result,
      status: result.status === 'error' ? undefined : result.status,
      confirm_id: result.confirm_id,
      error: result.status === 'error' ? result.message : undefined,
    }
  }

  private async handlePatch(instance: UIObject, payload: any): Promise<UIResponse> {
    const ops = payload?.ops ?? []
    const capabilities = instance.patchCapabilities

    // No capabilities declared → passthrough (backward compatible)
    if (!capabilities?.length) {
      const result = await instance.patch(ops, payload?.reason)
      return this.patchResponse(result)
    }

    // Validate each op against declared capabilities
    for (const op of ops) {
      const match = capabilities.find(
        cap => cap.ops.includes(op.op) && matchPathPattern(op.path, cap.pathPattern),
      )
      if (!match) {
        const supported = capabilities
          .map(c => `${c.ops.join('/')} ${c.pathPattern}`)
          .join(', ')
        const result = patchError(
          `Unsupported: ${op.op} ${op.path}`,
          `Supported paths: [${supported}]`,
          `Use ui_read(mode='actions') for operations not available via patch`,
        )
        return { error: result.message }
      }
    }

    const result = await instance.patch(ops, payload?.reason)
    return this.patchResponse(result)
  }

  // ── Exec pre-check ────────────────────────────────────────

  private async handleExec(instance: UIObject, payload: any): Promise<UIResponse> {
    const action = payload?.action ?? ''
    const params = payload?.params

    // Get action definitions for validation
    const rawActions = instance.read('actions')

    // Only validate if the adapter declares actions as an array
    if (Array.isArray(rawActions) && rawActions.length > 0) {
      const actions: ActionDef[] = rawActions

      // Check action exists
      const def = actions.find(a => a.name === action)
      if (!def) {
        const available = actions.map(a => a.name).join(', ')
        const result = execError(
          `Unknown action '${action}'`,
          `Available actions: [${available}]`,
        )
        return { data: result, error: result.error }
      }

      // Check required params
      const required = def.paramsSchema?.required ?? []
      const missing = required.filter(key => params?.[key] === undefined)
      if (missing.length) {
        const result = execError(
          `Missing required params: ${missing.join(', ')}`,
          `Schema: ${JSON.stringify(def.paramsSchema)}`,
        )
        return { data: result, error: result.error }
      }
    }

    // Forward to adapter
    const result = await instance.exec(action, params)
    return { data: result, error: result.success ? undefined : result.error }
  }

  private resolveTargetWithRetry(
    objectType: string, target: string, timeoutMs: number, intervalMs: number,
  ): Promise<UIObject | null> {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs
      const poll = () => {
        const inst = this.resolveTarget(objectType, target)
        if (inst) return resolve(inst)
        if (Date.now() >= deadline) return resolve(null)
        setTimeout(poll, intervalMs)
      }
      setTimeout(poll, intervalMs)
    })
  }

  private resolveTarget(objectType: string, target: string): UIObject | null {
    if (target && target !== 'active') {
      return this.instances.get(target) ?? null
    }
    // "active" → use injected provider to find the currently active tab
    const activeTabId = this._getActiveTabId?.()
    if (activeTabId) {
      const instance = this.instances.get(activeTabId)
      if (instance && (!objectType || instance.type === objectType)) return instance
    }
    // fallback: find first instance of matching type
    for (const [, obj] of this.instances) {
      if (!objectType || obj.type === objectType) return obj
    }
    return null
  }

  private handleList(filter?: { type?: string; keyword?: string; connectionId?: number; database?: string }): UIResponse {
    const results: UIObjectInfo[] = []
    for (const [, obj] of this.instances) {
      if (filter?.type && obj.type !== filter.type) continue
      if (filter?.connectionId != null && obj.connectionId !== filter.connectionId) continue
      if (filter?.keyword) {
        const haystack = `${obj.title} ${obj.objectId}`.toLowerCase()
        if (!haystack.includes(filter.keyword.toLowerCase())) continue
      }
      results.push({
        objectId: obj.objectId,
        type: obj.type,
        title: obj.title,
        connectionId: obj.connectionId,
      })
    }
    return { data: results }
  }
}

export const uiRouter = new UIRouter()
