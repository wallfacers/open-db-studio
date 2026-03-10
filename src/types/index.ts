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
}

export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  row_count: number;
  duration_ms: number;
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

export interface LlmSettings {
  api_key: string;
  base_url: string;
  model: string;
  api_type: ApiType;
  preset: string | null;
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
  role: 'user' | 'assistant';
  content: string;
}
