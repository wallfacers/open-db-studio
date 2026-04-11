import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useQueryStore } from '../store/queryStore';
import { uiRouter } from '../mcp/ui'
import { WorkspaceAdapter } from '../mcp/ui/adapters/WorkspaceAdapter'
import { DbTreeAdapter } from '../mcp/ui/adapters/DbTreeAdapter'
import { HistoryAdapter } from '../mcp/ui/adapters/HistoryAdapter'
import { MigrationExplorerAdapter } from '../mcp/ui/adapters/MigrationExplorerAdapter'

interface UIRequestPayload {
  request_id: string;
  query_type: string;
  params: {
    tool: 'ui_read' | 'ui_patch' | 'ui_exec' | 'ui_list';
    object: string;
    target: string;
    payload: any;
  };
}

export function useMcpBridge() {
  // Register singleton UI adapters (idempotent)
  uiRouter.registerInstance('workspace', new WorkspaceAdapter())
  uiRouter.registerInstance('db_tree', new DbTreeAdapter())
  uiRouter.registerInstance('history', new HistoryAdapter())
  uiRouter.registerInstance('migration_explorer', new MigrationExplorerAdapter())
  // Inject active tab provider (avoids circular dep between UIRouter and queryStore)
  uiRouter.setActiveTabIdProvider(() => useQueryStore.getState().activeTabId)

  useEffect(() => {
    // Listen for UI Object Protocol requests (ui_read, ui_patch, ui_exec, ui_list)
    const unlistenUIRequest = listen<UIRequestPayload>('mcp://ui-request', async (event) => {
      const { request_id, params } = event.payload;
      const { tool, object, target, payload } = params;
      try {
        const result = await uiRouter.handle({ tool, object, target, payload });
        await invoke('mcp_query_respond', {
          requestId: request_id,
          data: result,
        });
      } catch (e) {
        await invoke('mcp_query_respond', {
          requestId: request_id,
          data: { error: String(e) },
        });
      }
    });

    return () => {
      unlistenUIRequest.then(fn => fn());
    };
  }, []); // 只挂载一次，内部通过 getState() 读取最新 store
}
