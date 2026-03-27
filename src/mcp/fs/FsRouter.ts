// src/mcp/fs/FsRouter.ts
import type {
  FsAdapter, FsMcpRequest, FsSearchFilter, FsSearchResult,
  FsWritePatch,
} from './types'

export class FsRouter {
  private adapters = new Map<string, FsAdapter>()

  register(resource: string, adapter: FsAdapter): void {
    this.adapters.set(resource, adapter)
  }

  async handle(req: FsMcpRequest): Promise<string> {
    if (req.op === 'search') {
      return this._handleSearch(req)
    }

    const adapter = this.adapters.get(req.resource)
    if (!adapter) {
      throw new Error(`Unknown resource: ${req.resource}`)
    }

    switch (req.op) {
      case 'read': {
        if (!adapter.read) throw new Error(`${req.resource} does not support read`)
        const mode = req.payload.mode as 'text' | 'struct'
        return JSON.stringify(await adapter.read(req.target, mode))
      }
      case 'write': {
        if (!adapter.write) throw new Error(`${req.resource} does not support write`)
        return JSON.stringify(await adapter.write(req.target, req.payload as unknown as FsWritePatch))
      }
      case 'open': {
        if (!adapter.open) throw new Error(`${req.resource} does not support open`)
        return JSON.stringify(await adapter.open(req.payload))
      }
      case 'exec': {
        if (!adapter.exec) throw new Error(`${req.resource} does not support exec`)
        const action = req.payload.action as string
        if (!adapter.capabilities.exec.includes(action)) {
          throw new Error(`Unsupported action: ${action}`)
        }
        const params = req.payload.params as Record<string, unknown> | undefined
        return JSON.stringify(await adapter.exec(req.target, action, params))
      }
      default:
        throw new Error(`Unknown op: ${(req as FsMcpRequest).op}`)
    }
  }

  private async _handleSearch(req: FsMcpRequest): Promise<string> {
    const pattern = req.resource
    const isGlob  = pattern.endsWith('.*')
    const prefix  = isGlob ? pattern.slice(0, -2) : null

    const matched = [...this.adapters.entries()].filter(([key]) =>
      isGlob
        ? key.startsWith(prefix! + '.') || key === prefix
        : key === pattern
    )

    const results: FsSearchResult[] = []
    for (const [, adapter] of matched) {
      if (adapter.search) {
        results.push(...await adapter.search(req.payload as FsSearchFilter))
      }
    }
    return JSON.stringify(results)
  }
}
