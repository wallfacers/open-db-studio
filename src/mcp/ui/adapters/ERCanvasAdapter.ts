import type { UIObject, JsonPatchOp, PatchResult, ExecResult } from '../types'

export class ERCanvasAdapter implements UIObject {
  type = 'er_canvas'
  objectId: string
  title: string
  connectionId?: number

  constructor(objectId: string, title: string) {
    this.objectId = objectId
    this.title = title
  }

  read(mode: 'state' | 'schema' | 'actions') {
    switch (mode) {
      case 'state':
        return { nodes: [], edges: [] }
      case 'schema':
        return {
          type: 'object',
          properties: {
            nodes: { type: 'array', items: { type: 'object' } },
            edges: { type: 'array', items: { type: 'object' } },
          },
        }
      case 'actions':
        return []
    }
  }

  patch(_ops: JsonPatchOp[]): PatchResult {
    return { status: 'error', message: 'er_canvas is not yet implemented' }
  }

  async exec(_action: string): Promise<ExecResult> {
    return { success: false, error: 'er_canvas is not yet implemented' }
  }
}
