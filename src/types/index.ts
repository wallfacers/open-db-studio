export interface Connection {
  id: number;
  name: string;
  group_id: number | null;
  driver: string;
  host: string | null;
  port: number | null;
  database_name: string | null;
  username: string | null;
  extra_params: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateConnectionRequest {
  name: string;
  driver: string;
  host?: string;
  port?: number;
  database_name?: string;
  username?: string;
  password?: string;
  extra_params?: string;
  group_id?: number | null;
}

export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  row_count: number;
  duration_ms: number;
  /** 前端附加：select=查询结果, dml-report=DML聚合报告 */
  kind?: 'select' | 'dml-report';
  /** 前端附加：产生该结果的原始 SQL */
  sql?: string;
}

export interface TableMeta {
  schema: string | null;
  name: string;
  table_type: string;
}

export interface QueryHistory {
  id: number;
  connection_id: number | null;
  sql: string;
  executed_at: string;
  duration_ms: number | null;
  row_count: number | null;
  error_msg: string | null;
}

export type ApiType = 'openai' | 'anthropic';
export type TestStatus = 'untested' | 'testing' | 'success' | 'fail';

export interface LlmConfig {
  id: number;
  name: string;
  api_key: string;
  base_url: string;
  model: string;
  api_type: ApiType;
  preset: string | null;
  is_default: boolean;
  test_status: TestStatus;
  test_error: string | null;
  tested_at: string | null;
  created_at: string;
}

export interface CreateLlmConfigInput {
  name?: string;
  api_key: string;
  base_url: string;
  model: string;
  api_type: ApiType;
  preset?: string | null;
}

export interface UpdateLlmConfigInput {
  name?: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  api_type?: ApiType;
  preset?: string | null;
}

export type TabType = 'query' | 'table' | 'er_diagram';

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
}

export interface ColumnMeta {
  name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  is_primary_key: boolean;
  extra: string | null;
}

export interface IndexMeta {
  index_name: string;
  is_unique: boolean;
  columns: string[];
}

export interface ForeignKeyMeta {
  constraint_name: string;
  column: string;
  referenced_table: string;
  referenced_column: string;
}

export interface TableDetail {
  name: string;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
  foreign_keys: ForeignKeyMeta[];
}

export interface TableDataParams {
  connection_id: number;
  table: string;
  page: number;
  page_size: number;
  where_clause?: string | null;
  order_clause?: string | null;
}

export interface ViewMeta {
  name: string;
  definition: string | null;
}

export interface ProcedureMeta {
  name: string;
  routine_type: 'PROCEDURE' | 'FUNCTION' | 'Unknown';
}

export interface FullSchemaInfo {
  tables: TableDetail[];
  views: ViewMeta[];
  procedures: ProcedureMeta[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinkingContent?: string;   // 思考模型的推理过程
  isStreaming?: boolean;      // 是否正在流式输出
}

// ============ 导航树类型 ============

export type NodeType =
  | 'group'
  | 'connection'
  | 'database'
  | 'schema'
  | 'category'
  | 'table'
  | 'view'
  | 'function'
  | 'procedure'
  | 'trigger'
  | 'event'
  | 'sequence'
  | 'column';

export type CategoryKey = 'tables' | 'views' | 'functions' | 'procedures' | 'triggers' | 'events' | 'sequences';

export interface NodeMeta {
  connectionId?: number;
  driver?: string;
  database?: string;
  schema?: string;
  objectName?: string;
  color?: string | null;
  sortOrder?: number;
}

export interface TreeNode {
  id: string;           // 路径式唯一 ID: "conn_1/db_mydb/schema_public/cat_tables/table_users"
  nodeType: NodeType;
  label: string;
  parentId: string | null;
  hasChildren: boolean;
  loaded: boolean;      // 子节点是否已从后端加载
  meta: NodeMeta;
}

export interface ConnectionGroup {
  id: number;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
}

export interface QueryContext {
  connectionId: number | null;
  database: string | null;
  schema: string | null;
}
