import type { UIObject, PatchResult, ExecResult, JsonPatchOp } from '../types'
import { useQueryStore } from '../../../store/queryStore'

export class WorkspaceAdapter implements UIObject {
  type = 'workspace'
  objectId = 'workspace'
  title = 'Workspace'

  read(mode: 'state' | 'schema' | 'actions') {
    if (mode === 'actions') {
      return [
        { name: 'open', description: 'Open a new tab', paramsSchema: { type: 'string', connection_id: 'number', database: 'string', table: 'string', metric_id: 'number', project_id: 'number', job_id: 'number' } },
        { name: 'close', description: 'Close a tab', paramsSchema: { target: 'string' } },
        { name: 'focus', description: 'Focus/switch to a tab', paramsSchema: { target: 'string' } },
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
        const beforeIds = new Set(store.tabs.map(t => t.id))

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

        const newTab = useQueryStore.getState().tabs.find(t => !beforeIds.has(t.id))
        return { success: true, data: { objectId: newTab?.id ?? null } }
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
