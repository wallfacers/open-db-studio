import type { UIObject, UIRequest, UIResponse, UIObjectInfo } from './types'

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

    const instance = this.resolveTarget(req.object, req.target)
    if (!instance) {
      return { error: `No ${req.object} found for target '${req.target}'` }
    }

    try {
      switch (req.tool) {
        case 'ui_read': {
          const data = instance.read(req.payload?.mode ?? 'state')
          return { data }
        }
        case 'ui_patch': {
          const result = await instance.patch(
            req.payload?.ops ?? [],
            req.payload?.reason
          )
          return {
            data: result,
            status: result.status === 'error' ? undefined : result.status,
            confirm_id: result.confirm_id,
            error: result.status === 'error' ? result.message : undefined,
          }
        }
        case 'ui_exec': {
          const result = await instance.exec(
            req.payload?.action ?? '',
            req.payload?.params
          )
          return { data: result, error: result.success ? undefined : result.error }
        }
        default:
          return { error: `Unknown tool: ${req.tool}` }
      }
    } catch (e) {
      return { error: String(e) }
    }
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
