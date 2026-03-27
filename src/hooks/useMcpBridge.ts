import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useQueryStore } from '../store/queryStore';
import { useAppStore } from '../store/appStore';
import { useConfirmStore } from '../store/confirmStore';
import { useSeaTunnelStore } from '../store/seaTunnelStore';
import { fsRouter, registerFsAdapters } from '../mcp/fs'
import type { FsOp } from '../mcp/fs'

interface UiActionPayload {
  request_id: string;
  action: 'open_tab' | 'propose_seatunnel_job';
  params: Record<string, unknown>;
}

interface QueryRequestPayload {
  request_id: string;
  query_type: 'search_tabs' | 'get_tab_content' | 'fs_request';
  params: Record<string, unknown>;
}

export function useMcpBridge() {
  const { tabs, activeTabId, setActiveTabId, sqlContent, openTableStructureTab, openMetricTab, openQueryTab, openSeaTunnelJobTab } = useQueryStore();

  // 注册所有 FsAdapter（幂等，可重复调用）
  registerFsAdapters()

  useEffect(() => {
    // 监听 UI 操作（写方向）
    const unlistenUiAction = listen<UiActionPayload>('mcp://ui-action', async (event) => {
      const { request_id, action, params } = event.payload;
      try {
        if (action === 'propose_seatunnel_job') {
          const { job_name, config_json, category_id, description, job_id } = params as {
            job_name: string; config_json: string;
            category_id?: number; description?: string; job_id?: number;
          };
          const { autoMode } = useAppStore.getState();
          const isUpdate = job_id != null;

          let confirmed = false;
          if (autoMode) {
            confirmed = true;
          } else {
            confirmed = await useConfirmStore.getState().confirm({
              title: isUpdate
                ? `更新 SeaTunnel Job：${job_name}`
                : `创建 SeaTunnel Job：${job_name}`,
              message: description
                ? `${description}\n\n是否确认${isUpdate ? '更新' : '创建'}此迁移任务？`
                : `是否确认${isUpdate ? '更新' : '创建'} SeaTunnel Job「${job_name}」？`,
              confirmLabel: isUpdate ? '确认更新' : '确认创建',
              variant: 'default',
            });
          }

          if (!confirmed) {
            await invoke('mcp_ui_action_respond', {
              requestId: request_id, success: false, data: null,
              error: `用户取消了 Job ${isUpdate ? '更新' : '创建'}`
            });
            return;
          }

          try {
            if (isUpdate) {
              // 更新已有 Job：写 DB + 更新 store（已打开的 Tab 会订阅到变化）
              await invoke('update_st_job', {
                id: job_id,
                name: job_name ?? null,
                categoryId: null,
                connectionId: null,
                configJson: config_json,
              });
              useSeaTunnelStore.getState().setStJobContent(job_id!, config_json);
              await invoke('mcp_ui_action_respond', {
                requestId: request_id, success: true,
                data: { job_id, job_name }, error: null
              });
            } else {
              // 创建新 Job
              const newJobId = await invoke<number>('create_st_job', {
                name: job_name,
                categoryId: category_id ?? null,
                connectionId: null,
              });
              await invoke('update_st_job', {
                id: newJobId,
                name: null,
                categoryId: null,
                connectionId: null,
                configJson: config_json,
              });
              await invoke('mcp_ui_action_respond', {
                requestId: request_id, success: true,
                data: { job_id: newJobId, job_name }, error: null
              });
            }
          } catch (createErr) {
            await invoke('mcp_ui_action_respond', {
              requestId: request_id, success: false, data: null,
              error: String(createErr)
            });
          }
        } else if (action === 'open_tab') {
          const { connection_id, type, table_name, database, metric_id, job_id, initial_columns, initial_table_name } = params as {
            connection_id?: number; type: string; table_name?: string;
            database?: string; metric_id?: number; job_id?: number;
            initial_columns?: import('../types').Tab['initialColumns'];
            initial_table_name?: string;
          };
          let newTabId: string | null = null;

          if (type === 'table_structure' && connection_id != null) {
            // table_name 为 null/undefined 时为新建表模式（支持 initial_columns 预填）
            openTableStructureTab(connection_id, database, undefined, table_name || undefined, initial_columns, initial_table_name);
            await new Promise(resolve => setTimeout(resolve, 100));
            const expectedTitle = initial_table_name || table_name || '新建表';
            const newTab = useQueryStore.getState().tabs.find(
              t => t.type === 'table_structure' && t.connectionId === connection_id && t.title === expectedTitle
            );
            newTabId = newTab?.id ?? null;
          } else if (type === 'metric' && metric_id) {
            openMetricTab(metric_id, `Metric #${metric_id}`);
            await new Promise(resolve => setTimeout(resolve, 100));
            const newTab = useQueryStore.getState().tabs.find(
              t => t.type === 'metric' && t.metricId === metric_id
            );
            newTabId = newTab?.id ?? null;
          } else if (type === 'seatunnel_job' && job_id != null) {
            const label = useSeaTunnelStore.getState().nodes.get(`job_${job_id}`)?.label ?? `Job #${job_id}`;
            openSeaTunnelJobTab(job_id, label);
            await new Promise(resolve => setTimeout(resolve, 100));
            const newTab = useQueryStore.getState().tabs.find(
              t => t.type === 'seatunnel_job' && t.stJobId === job_id
            );
            newTabId = newTab?.id ?? null;
          } else if (type === 'query' && connection_id != null) {
            const beforeIds = new Set(useQueryStore.getState().tabs.map(t => t.id));
            openQueryTab(connection_id, `Connection #${connection_id}`, database);
            await new Promise(resolve => setTimeout(resolve, 100));
            const newTab = useQueryStore.getState().tabs.find(
              t => t.type === 'query' && t.connectionId === connection_id && !beforeIds.has(t.id)
            );
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
          const currentActiveTabId = useQueryStore.getState().activeTabId;
          data = currentTabs.filter(t => {
            if (tabType && t.type !== tabType) return false;
            if (table_name) {
              return t.title.toLowerCase().includes(table_name.toLowerCase());
            }
            return true;
          }).map(t => ({
            tab_id: t.id,
            type: t.type,
            title: t.title,
            connection_id: t.connectionId,
            db: t.db,
            is_active: t.id === currentActiveTabId,
            // 附带专属 ID，便于 AI 直接引用
            ...(t.metricId != null && { metric_id: t.metricId }),
            ...(t.stJobId != null && { job_id: t.stJobId }),
          }));
        } else if (query_type === 'get_tab_content') {
          const tabId = (params as { tab_id?: string }).tab_id;
          const tab = currentTabs.find(t => t.id === tabId);
          if (tab) {
            const base = {
              tab_id: tab.id,
              type: tab.type,
              title: tab.title,
              connection_id: tab.connectionId,
              db: tab.db,
              sql_content: currentSqlContent[tab.id] ?? null,
            };
            if (tab.type === 'seatunnel_job' && tab.stJobId != null) {
              const configJson = useSeaTunnelStore.getState().stJobContent.get(tab.stJobId) ?? null;
              data = { ...base, config_json: configJson, job_id: tab.stJobId };
            } else if (tab.type === 'table_structure' && tab.connectionId != null) {
              // Gap #3：直接从 DB 读列定义填充
              try {
                const columns = await invoke('get_column_meta', {
                  connectionId: tab.connectionId,
                  tableName: tab.title,
                  database: tab.db ?? null,
                });
                data = { ...base, columns };
              } catch {
                data = base;
              }
            } else if (tab.type === 'metric' && tab.metricId != null) {
              // Gap #4：直接从 DB 读指标定义填充
              try {
                const metricDef = await invoke('get_metric', { metricId: tab.metricId });
                data = { ...base, metric: metricDef, metric_id: tab.metricId };
              } catch {
                data = { ...base, metric_id: tab.metricId };
              }
            } else {
              data = base;
            }
          } else {
            data = null;
          }
        } else if (query_type === 'fs_request') {
          const { op, resource, target, payload: fsPayload } = params as {
            op: FsOp; resource: string; target: string; payload: Record<string, unknown>
          }
          try {
            const resultStr = await fsRouter.handle({ op, resource, target, payload: fsPayload })
            data = JSON.parse(resultStr) as unknown
          } catch (fsErr) {
            data = { error: fsErr instanceof Error ? fsErr.message : String(fsErr) }
          }
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
