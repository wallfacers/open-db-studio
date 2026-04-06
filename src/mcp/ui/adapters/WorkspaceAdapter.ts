import type { UIObject, PatchResult, ExecResult, JsonPatchOp } from '../types'
import { useQueryStore } from '../../../store/queryStore'

export class WorkspaceAdapter implements UIObject {
  type = 'workspace'
  objectId = 'workspace'
  title = 'Workspace'

  read(mode: 'state' | 'schema' | 'actions') {
    if (mode === 'actions') {
      return [
        {
          name: 'open', description: 'Open a new tab',
          paramsSchema: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['query_editor', 'table_form', 'metric_form', 'er_canvas', 'seatunnel_job'] },
              connection_id: { type: 'number' },
              database: { type: 'string' },
              table: { type: 'string' },
              metric_id: { type: 'number' },
              project_id: { type: 'number' },
              job_id: { type: 'number' },
            },
            required: ['type'],
          },
        },
        { name: 'close', description: 'Close a tab', paramsSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
        { name: 'focus', description: 'Focus/switch to a tab', paramsSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
      ]
    }
    return { error: 'workspace does not support read' }
  }

  patch(_ops: JsonPatchOp[]): PatchResult {
    return { status: 'error', message: 'workspace does not support patch' }
  }

  async exec(action: string, params?: any): Promise<ExecResult> {
    const store = useQueryStore.getState()

    switch (action) {
      case 'open': {
        const { type, connection_id, database, table, metric_id, project_id, job_id } = params ?? {}

        switch (type) {
          case 'query_editor':
            store.openQueryTab(connection_id, `Query`, database)
            break
          case 'table_form':
            store.openTableStructureTab(connection_id, database, undefined, table || undefined)
            break
          case 'metric_form':
            if (metric_id) store.openMetricTab(metric_id, `Metric #${metric_id}`)
            break
          case 'er_canvas':
            if (project_id) store.openERDesignTab(project_id, `ER #${project_id}`)
            break
          case 'seatunnel_job':
            if (job_id != null) store.openSeaTunnelJobTab(job_id, `Job #${job_id}`)
            break
          default:
            return { success: false, error: `Unknown tab type: ${type}` }
        }

        // Use activeTabId — the store always sets it for both new and deduplicated tabs
        const objectId = useQueryStore.getState().activeTabId
        return { success: true, data: { objectId } }
      }

      case 'close': {
        const tabId = params?.target
        if (tabId) store.closeTab(tabId)
        return { success: true }
      }

      case 'focus': {
        const tabId = params?.target
        if (tabId) store.setActiveTabId(tabId)
        return { success: true }
      }

      default:
        return { success: false, error: `Unknown workspace action: ${action}` }
    }
  }
}
