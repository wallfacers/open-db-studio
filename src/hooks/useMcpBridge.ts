import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useQueryStore } from '../store/queryStore';
import { useTreeStore } from '../store/treeStore';

interface UiActionPayload {
  request_id: string;
  action: 'focus_tab' | 'open_tab';
  params: Record<string, unknown>;
}

interface QueryRequestPayload {
  request_id: string;
  query_type: 'search_tabs' | 'get_tab_content' | 'search_db_metadata';
  params: Record<string, unknown>;
}

export function useMcpBridge() {
  const { tabs, activeTabId, setActiveTabId, sqlContent, openTableStructureTab, openMetricTab, openQueryTab } = useQueryStore();
  const treeNodes = useTreeStore((s) => s.nodes);

  useEffect(() => {
    // 监听 UI 操作（写方向）
    const unlistenUiAction = listen<UiActionPayload>('mcp://ui-action', async (event) => {
      const { request_id, action, params } = event.payload;
      try {
        if (action === 'focus_tab') {
          const tabId = params.tab_id as string;
          const tab = useQueryStore.getState().tabs.find(t => t.id === tabId);
          if (!tab) {
            await invoke('mcp_ui_action_respond', {
              requestId: request_id, success: false, data: null,
              error: `Tab ${tabId} not found`
            });
            return;
          }
          setActiveTabId(tabId);
          await invoke('mcp_ui_action_respond', {
            requestId: request_id, success: true,
            data: { tab_id: tabId }, error: null
          });
        } else if (action === 'open_tab') {
          const { connection_id, type, table_name, database, metric_id } = params as {
            connection_id: number; type: string; table_name?: string;
            database?: string; metric_id?: number;
          };
          let newTabId: string | null = null;

          if (type === 'table_structure' && table_name) {
            openTableStructureTab(connection_id, database, undefined, table_name);
            // 等一帧让 store 更新
            await new Promise(resolve => setTimeout(resolve, 100));
            const newTab = useQueryStore.getState().tabs.find(
              t => t.type === 'table_structure' && t.connectionId === connection_id
            );
            newTabId = newTab?.id ?? null;
          } else if (type === 'metric' && metric_id) {
            openMetricTab(metric_id, `Metric #${metric_id}`);
            await new Promise(resolve => setTimeout(resolve, 100));
            const newTab = useQueryStore.getState().tabs.find(
              t => t.type === 'metric' && t.metricId === metric_id
            );
            newTabId = newTab?.id ?? null;
          } else if (type === 'query') {
            openQueryTab(connection_id, `Connection #${connection_id}`, database);
            await new Promise(resolve => setTimeout(resolve, 100));
            const stateTabs = useQueryStore.getState().tabs;
            const newTab = stateTabs[stateTabs.length - 1];
            newTabId = newTab?.id ?? null;
          }

          if (newTabId) {
            setActiveTabId(newTabId);
            await invoke('mcp_ui_action_respond', {
              requestId: request_id, success: true,
              data: { tab_id: newTabId }, error: null
            });
          } else {
            await invoke('mcp_ui_action_respond', {
              requestId: request_id, success: false, data: null,
              error: 'Failed to open tab'
            });
          }
        }
      } catch (e) {
        await invoke('mcp_ui_action_respond', {
          requestId: request_id, success: false, data: null,
          error: String(e)
        }).catch(() => {});
      }
    });

    // 监听查询请求（读方向）
    const unlistenQueryRequest = listen<QueryRequestPayload>('mcp://query-request', async (event) => {
      const { request_id, query_type, params } = event.payload;
      try {
        let data: unknown = null;
        const currentTabs = useQueryStore.getState().tabs;
        const currentSqlContent = useQueryStore.getState().sqlContent;

        if (query_type === 'search_tabs') {
          const { table_name, type: tabType } = params as { table_name?: string; type?: string };
          data = currentTabs.filter(t => {
            if (tabType && t.type !== tabType) return false;
            if (table_name) {
              const titleMatch = t.title.toLowerCase().includes(table_name.toLowerCase());
              return titleMatch;
            }
            return true;
          }).map(t => ({
            tab_id: t.id,
            type: t.type,
            title: t.title,
            connection_id: t.connectionId,
            db: t.db,
          }));
        } else if (query_type === 'get_tab_content') {
          const tabId = (params as { tab_id?: string }).tab_id;
          const tab = currentTabs.find(t => t.id === tabId);
          if (tab) {
            data = {
              tab_id: tab.id,
              type: tab.type,
              title: tab.title,
              connection_id: tab.connectionId,
              db: tab.db,
              sql_content: currentSqlContent[tab.id] ?? null,
            };
          } else {
            data = null;
          }
        } else if (query_type === 'search_db_metadata') {
          const keyword = (params as { keyword?: string }).keyword ?? '';
          // 从 treeNodes（Zustand treeStore）搜索已缓存节点（Map<string, TreeNode>）
          const nodes = useTreeStore.getState().nodes;
          const results: Array<{ node_id: string; name: string; type: string; connection_id?: number }> = [];
          const kw = keyword.toLowerCase();
          for (const [nodeId, node] of nodes.entries()) {
            if (node.label.toLowerCase().includes(kw)) {
              results.push({
                node_id: nodeId,
                name: node.label,
                type: node.nodeType,
                connection_id: node.meta?.connectionId,
              });
            }
          }
          data = results;
        }

        await invoke('mcp_query_respond', { requestId: request_id, data });
      } catch (e) {
        await invoke('mcp_query_respond', { requestId: request_id, data: null }).catch(() => {});
      }
    });

    return () => {
      unlistenUiAction.then(fn => fn());
      unlistenQueryRequest.then(fn => fn());
    };
  }, []); // 只挂载一次，内部通过 getState() 读取最新 store
}
