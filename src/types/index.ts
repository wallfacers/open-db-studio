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
  | 'er_diagram'
  | 'table_structure'   // 从 App.tsx TabData 迁移
  | 'metric'
  | 'metric_list';

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
  isNewTable?: boolean;        // table_structure Tab 专用
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

/** SQL 语句解析结果（含偏移量，用于消歧） */
export interface SqlStatementInfo {
  text: string;
  startOffset: number;  // 在完整编辑器内容中的起始字符偏移
  endOffset: number;    // 结束字符偏移（不含末尾分号）
  startLine: number;    // 0-based 行号（语句起始）
  endLine: number;      // 0-based 行号（语句结束）
}

/** AI 提出的 SQL 修改提案（等待用户确认） */
export interface SqlDiffProposal {
  original: string;     // 原始 SQL（单条语句）
  modified: string;     // 修改后的 SQL
  reason: string;       // 修改原因（AI 说明）
  tabId: string;        // 目标 Tab
  startOffset: number;  // 原始语句在编辑器中的起始位置
  endOffset: number;    // 原始语句在编辑器中的结束位置
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

// ── ACP Elicitation / Permission 类型 ─────────────────────────────────────

/** 文字检测路径的单个选项 */
export interface ElicitationOption {
  value: string
  label: string
  description?: string
}

/** 文字检测路径的 elicitation 请求（AI 消息结束后由前端构造） */
export interface ElicitationRequest {
  id: string              // 随机 UUID，仅用于 React key
  sessionId: string
  source: 'text'
  type: 'select'
  message: string         // 提示语（解析自消息末尾问句）
  options: ElicitationOption[]
}

/** ACP session/elicitation 路径的请求（ext_method 桥接，来自 Rust StreamEvent） */
export interface AcpElicitationRequest {
  id: string                       // elicitation_id（Rust 生成的 UUID）
  sessionId: string
  source: 'acp-elicitation'
  mode: 'form' | 'url'
  message: string
  schema: Record<string, unknown>  // requestedSchema JSON（ACP 规范的受限 JSON Schema）
}

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
  row_count: number;   // 本页实际行数（items.length），非总记录数
  duration_ms: number;
}
