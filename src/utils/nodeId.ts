// ============================================================
// Node ID 集中化构造与解析工具
// ============================================================

// ---- 共享 ID（跨树通用） ----

export function connNodeId(id: number): string { return `conn_${id}`; }

export function groupNodeId(id: number): string { return `group_${id}`; }
export function parseGroupNodeId(nodeId: string): number { return parseInt(nodeId.replace('group_', ''), 10); }

// ---- 主树（treeStore）— 路径式 ID ----

export function dbNodeId(parentId: string, name: string): string { return `${parentId}/db_${name}`; }
export function schemaNodeId(parentId: string, name: string): string { return `${parentId}/schema_${name}`; }
export function catNodeId(parentId: string, category: string): string { return `${parentId}/cat_${category}`; }
export function objectNodeId(parentId: string, type: string, name: string): string { return `${parentId}/${type}_${name}`; }
export function colNodeId(parentId: string, name: string): string { return `${parentId}/col_${name}`; }
export function metricsFolderNodeId(parentId: string): string { return `${parentId}/metrics_folder`; }
export function treeMetricNodeId(parentId: string, id: number): string { return `${parentId}/metric_${id}`; }

// ---- 指标树（metricsTreeStore）— 扁平 ID ----

export function metricsDbNodeId(connectionId: number, dbName: string): string { return `db_${connectionId}_${dbName}`; }
export function metricsSchemaNodeId(connectionId: number, database: string, schema: string): string { return `schema_${connectionId}_${database}_${schema}`; }
export function metricsMetricNodeId(id: number): string { return `metric_${id}`; }

// ---- SeaTunnel 树 — 扁平 ID ----

export function stCatNodeId(id: number): string { return `cat_${id}`; }
export function stJobNodeId(id: number): string { return `job_${id}`; }

// ---- ER 设计器 — 连字符 ID ----

export function erTableNodeId(id: number): string { return `table-${id}`; }
export function parseErTableNodeId(nodeId: string): number | null {
  const m = nodeId.match(/^table-(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

export function erEdgeNodeId(id: number): string { return `edge-${id}`; }
export function parseErEdgeNodeId(nodeId: string): number | null {
  const m = nodeId.match(/^edge-(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// ---- Tab ID（queryStore） ----

export function queryTabId(connId: number, ts: number): string { return `query_${connId}_${ts}`; }
export function tableDataTabId(connectionId: number, dbName: string, schema: string, tableName: string): string { return `table_${connectionId}_${dbName}_${schema}_${tableName}`; }
export function tableStructureTabId(connectionId: number, dbName: string, schema: string, tableName: string): string { return `table_structure_${connectionId}_${dbName}_${schema}_${tableName}`; }
export function newTableStructureTabId(connectionId: number, dbName: string, schema: string, ts: number): string { return `table_structure_new_${connectionId}_${dbName}_${schema}_${ts}`; }
export function metricTabId(metricId: number, ts: number): string { return `metric_${metricId}_${ts}`; }
export function newMetricTabId(ts: number): string { return `metric_new_${ts}`; }
export function metricListTabId(connectionId: number, database: string, schema: string): string { return `ml_${connectionId}_${database}_${schema}`; }
export function stJobTabId(jobId: number, ts: number): string { return `st_job_${jobId}_${ts}`; }
export function erDesignTabId(projectId: number, ts: number): string { return `er_design_${projectId}_${ts}`; }
