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
  file_path: string | null;
  auth_type: string | null;
  ssl_mode: string | null;
  ssl_ca_path: string | null;
  ssl_cert_path: string | null;
  ssl_key_path: string | null;
  connect_timeout_secs: number | null;
  read_timeout_secs: number | null;
  pool_max_connections: number | null;
  pool_idle_timeout_secs: number | null;
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
  file_path?: string;
  auth_type?: string;
  token?: string;
  ssl_mode?: string;
  ssl_ca_path?: string;
  ssl_cert_path?: string;
  ssl_key_path?: string;
  connect_timeout_secs?: number;
  read_timeout_secs?: number;
  pool_max_connections?: number;
  pool_idle_timeout_secs?: number;
}

export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  row_count: number;
  duration_ms: number;
  /** 前端附加：select=查询结果, dml-report=DML聚合报告, error=执行错误 */
  kind?: 'select' | 'dml-report' | 'error';
  /** 前端附加：产生该结果的原始 SQL */
  sql?: string;
  /** 前端附加：错误信息（仅 kind='error' 时存在） */
  error_message?: string;
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
export type ConfigMode = 'opencode' | 'custom';

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
  opencode_provider_id: string;
  config_mode: ConfigMode;
  opencode_display_name: string;
  opencode_model_options: string;
  opencode_provider_name: string;
}

export interface CreateLlmConfigInput {
  name?: string;
  api_key: string;
  base_url: string;
  model: string;
  api_type: ApiType;
  preset?: string | null;
  opencode_provider_id: string;
  config_mode: ConfigMode;
  opencode_display_name?: string;
  opencode_model_options?: string;
  opencode_provider_name?: string;
}

export interface UpdateLlmConfigInput {
  name?: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  api_type?: ApiType;
  preset?: string | null;
  opencode_provider_id?: string;
  config_mode?: ConfigMode;
  opencode_display_name?: string;
  opencode_model_options?: string;
  opencode_provider_name?: string;
}

export type TabType =
  | 'query'
  | 'table'
  | 'er_design'
  | 'table_structure'   // 从 App.tsx TabData 迁移
  | 'metric'
  | 'metric_list'
  | 'seatunnel_job';

export interface MetricScope {
  connectionId: number;
  database?: string;
  schema?: string;
}

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
  metricId?: number;           // metric Tab 专用
  metricScope?: MetricScope;   // metric_list Tab 专用
  db?: string;
  schema?: string;
  queryContext?: QueryContext;
  stJobId?: number;            // seatunnel_job Tab 专用
  stConnectionId?: number;     // seatunnel_job Tab 专用
  erProjectId?: number;        // er_design Tab 专用
  ghostTextEnabled?: boolean;  // undefined = use global default
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

export interface ChatSession {
  id: string;
  title: string;             // AI 生成的标题，初始为第一条消息的截断
  messages: ChatMessage[];
  createdAt: number;         // Unix timestamp ms
  updatedAt: number;
  titleGenerated: boolean;   // AI 标题是否已生成
  configId: number | null;   // 该 session 使用的模型配置 ID（null = 使用全局默认）
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
  | 'materialized_view'
  | 'dictionary'
  | 'column'
  | 'metrics_folder'
  | 'metric';

export type CategoryKey = 'tables' | 'views' | 'functions' | 'procedures' | 'triggers' | 'events' | 'sequences' | 'materialized_views' | 'dictionaries';

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

/** SQL 语句解析结果（含偏移量，用于消歧） */
export interface SqlStatementInfo {
  text: string;
  startOffset: number;  // 在完整编辑器内容中的起始字符偏移
  endOffset: number;    // 结束字符偏移（不含末尾分号）
  startLine: number;    // 0-based 行号（语句起始）
  endLine: number;      // 0-based 行号（语句结束）
}

/** Monaco 编辑器光标/选区信息（由 MainContent 实时写入） */
export interface EditorInfo {
  cursorOffset: number;       // 光标在全文中的字符偏移
  selectedText: string | null; // 当前选中的文本，无选区为 null
  cursorLine: number;         // 光标所在行（0-based）
  cursorColumn: number;       // 光标所在列（0-based）
  selectionStartLine: number; // 选区起始行（0-based）
  selectionEndLine: number;   // 选区结束行（0-based）
}

// ============ Metric 相关类型 ============

export type MetricType = 'atomic' | 'composite';
export type MetricStatus = 'draft' | 'approved' | 'rejected';
export type MetricSource = 'manual' | 'ai';

export interface CompositeComponent {
  metric_id: number;
  metric_name: string;    // 英文标识
  display_name: string;   // 显示名称
}

export interface Metric {
  id: number;
  connection_id: number;
  name: string;
  display_name: string;
  table_name: string;
  column_name?: string;
  aggregation?: string;
  filter_sql?: string;
  description?: string;
  status: MetricStatus;
  source: MetricSource;
  metric_type: MetricType;
  composite_components?: CompositeComponent[];
  composite_formula?: string;
  category?: string;
  data_caliber?: string;
  version?: string;
  scope_database?: string;
  scope_schema?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateMetricPayload {
  connection_id: number;
  name: string;
  display_name: string;
  table_name?: string;
  column_name?: string;
  aggregation?: string;
  filter_sql?: string;
  description?: string;
  metric_type?: MetricType;
  composite_components?: string; // JSON string
  composite_formula?: string;
  category?: string;
  data_caliber?: string;
  version?: string;
  scope_database?: string;
  scope_schema?: string;
}

export interface UpdateMetricPayload {
  name?: string;
  display_name?: string;
  table_name?: string;
  column_name?: string;
  aggregation?: string;
  filter_sql?: string;
  description?: string;
  metric_type?: MetricType;
  composite_components?: string;
  composite_formula?: string;
  category?: string;
  data_caliber?: string;
  version?: string;
  scope_database?: string;
  scope_schema?: string;
}

// ── ACP Permission 类型 ───────────────────────────────────────────────────

/** ACP request_permission 路径的权限确认请求（来自 Rust StreamEvent） */
export interface PermissionRequest {
  id: string              // permission_id（Rust 生成的 UUID）
  sessionId: string
  source: 'acp'
  message: string         // 工具名称 + 操作描述
  options: Array<{
    option_id: string
    label: string         // "允许一次" | "总是允许" | "拒绝一次" | "总是拒绝"
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'deny'
  }>
}

/** OpenCode question.asked — AI agent 请求用户回答选择题/自定义输入 */
export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean    // 默认 true，允许自定义输入
}

export interface QuestionRequest {
  question_id: string
  session_id: string
  questions: QuestionInfo[]
}

export interface OpenCodeProviderModel {
  id: string;
  name: string;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  source: string;  // "api" | "config" | "custom"
  models: OpenCodeProviderModel[];
}

export interface MetricPageResult {
  items: Metric[];
  row_count: number;   // 本页实际行数（items.length）
  total_rows: number;  // 满足过滤条件的总记录数
  duration_ms: number;
}

// ============ ER 设计器类型 ============

export interface ErProject {
  id: number;
  name: string;
  description: string | null;
  connection_id: number | null;
  database_name: string | null;
  schema_name: string | null;
  viewport_x: number;
  viewport_y: number;
  viewport_zoom: number;
  created_at: string;
  updated_at: string;
}

export interface ErTable {
  id: number;
  project_id: number;
  name: string;
  comment: string | null;
  position_x: number;
  position_y: number;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface ErColumn {
  id: number;
  table_id: number;
  name: string;
  data_type: string;
  nullable: boolean;
  default_value: string | null;
  is_primary_key: boolean;
  is_auto_increment: boolean;
  comment: string | null;
  // 扩展属性
  length: number | null;
  scale: number | null;
  is_unique: boolean;
  unsigned: boolean;
  charset: string | null;
  collation: string | null;
  on_update: string | null;
  enum_values: string[] | null;  // 前端用数组，Rust 传 JSON 字符串
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ErRelation {
  id: number;
  project_id: number;
  name: string | null;
  source_table_id: number;
  source_column_id: number;
  target_table_id: number;
  target_column_id: number;
  relation_type: string;
  on_delete: string;
  on_update: string;
  source: string;  // 'schema' | 'comment' | 'designer'
  comment_marker: string | null;
  created_at: string;
  updated_at: string;
}

export interface ErIndex {
  id: number;
  table_id: number;
  name: string;
  type: string;  // 'INDEX' | 'UNIQUE' | 'FULLTEXT'
  columns: string;  // JSON array of column names
  created_at: string;
}

export interface ErTableFull {
  table: ErTable;
  columns: ErColumn[];
  indexes: ErIndex[];
}

export interface ErProjectFull {
  project: ErProject;
  tables: ErTableFull[];
  relations: ErRelation[];
}

export interface DiffResult {
  added_tables: TableDiff[];
  removed_tables: TableDiff[];
  modified_tables: TableModDiff[];
}

export interface TableDiff {
  table_name: string;
  columns: { name: string; data_type: string; nullable: boolean; is_primary_key: boolean }[];
}

export interface TableModDiff {
  table_name: string;
  added_columns: ColumnDiff[];
  removed_columns: ColumnDiff[];
  modified_columns: ColumnModDiff[];
  added_indexes: IndexDiff[];
  removed_indexes: IndexDiff[];
}

export interface ColumnDiff {
  name: string;
  data_type: string;
  nullable: boolean;
}

export interface ColumnModDiff {
  name: string;
  er_type: string;
  db_type: string;
  er_nullable: boolean;
  db_nullable: boolean;
  type_changed: boolean;
  nullable_changed: boolean;
}

export interface IndexDiff {
  name: string;
  index_type: string;
  columns: string[];
}

export interface SyncExecutionResult {
  statement: string;
  success: boolean;
  error: string | null;
}
