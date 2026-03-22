mod tools;

use axum::{routing::{get, post}, Router, Json, extract::State};
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct JsonRpcRequest {
    #[serde(rename = "jsonrpc")]
    pub _jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

impl JsonRpcResponse {
    pub fn ok(id: Option<Value>, result: Value) -> Self {
        Self { jsonrpc: "2.0".into(), id, result: Some(result), error: None }
    }
    pub fn err(id: Option<Value>, code: i32, msg: &str) -> Self {
        Self {
            jsonrpc: "2.0".into(), id,
            result: None,
            error: Some(json!({ "code": code, "message": msg })),
        }
    }
}

#[derive(Serialize, Clone)]
struct DiffProposalPayload {
    original: String,
    modified: String,
    reason: String,
}

fn tool_definitions() -> Value {
    json!({
        "tools": [
            {
                "name": "list_databases",
                "description": "List all databases for a connection",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer", "description": "Connection ID" }
                    },
                    "required": ["connection_id"]
                }
            },
            {
                "name": "list_tables",
                "description": "List all tables in a database",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "database": { "type": "string" }
                    },
                    "required": ["connection_id", "database"]
                }
            },
            {
                "name": "get_table_schema",
                "description": "Get column definitions, indexes, and foreign keys for a table",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "table": { "type": "string" },
                        "database": { "type": "string" }
                    },
                    "required": ["connection_id", "table"]
                }
            },
            {
                "name": "get_table_sample",
                "description": "Get sample rows from a table (max 20 rows)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "table": { "type": "string" },
                        "database": { "type": "string" },
                        "limit": { "type": "integer" }
                    },
                    "required": ["connection_id", "table"]
                }
            },
            {
                "name": "execute_sql",
                "description": "Execute a read-only SQL query (SELECT/WITH/SHOW only, max 100 rows)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "sql": { "type": "string" },
                        "database": { "type": "string" }
                    },
                    "required": ["connection_id", "sql"]
                }
            },
            {
                "name": "propose_sql_diff",
                "description": "Propose a SQL modification to the active editor tab. Shows a diff preview that the user must confirm before it takes effect. Always call this after reading the current SQL to ensure 'original' matches exactly.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "original": {
                            "type": "string",
                            "description": "The exact original SQL statement text as it appears in the editor (must match precisely)"
                        },
                        "modified": {
                            "type": "string",
                            "description": "The new SQL statement text after modification"
                        },
                        "reason": {
                            "type": "string",
                            "description": "Brief explanation of why this change is being proposed (shown to user)"
                        }
                    },
                    "required": ["original", "modified", "reason"]
                }
            },
            json!({
                "name": "get_editor_sql",
                "description": "Get the current SQL content from the active editor tab. Returns the full SQL text as a plain string. Use this when you need to read the editor content during a multi-step agent loop.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }),
            json!({
                "name": "list_tasks",
                "description": "List import/export tasks with their status, progress, and error information. Use this to see what tasks are running, completed, or failed.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "description": "Filter by status: 'running', 'completed', 'failed', 'cancelled', 'pending'. Omit to list all tasks.",
                            "enum": ["running", "completed", "failed", "cancelled", "pending"]
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of tasks to return (default: 20, max: 100)"
                        }
                    },
                    "required": []
                }
            }),
            json!({
                "name": "get_task_detail",
                "description": "Get full details of a specific task including error message, error details (per-row failures), output path, and timing information. Use this to diagnose why a task failed.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "task_id": {
                            "type": "string",
                            "description": "The task ID (from list_tasks)"
                        }
                    },
                    "required": ["task_id"]
                }
            }),
            json!({
                "name": "search_db_metadata",
                "description": "Search database metadata from the cached tree (tables, views by name). Returns tables matching the keyword.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "keyword": { "type": "string", "description": "Table/view name to search (prefix or fuzzy match)" }
                    },
                    "required": ["keyword"]
                }
            }),
            json!({
                "name": "search_tabs",
                "description": "Search currently opened tabs by type or table name. Results include job_id for seatunnel_job tabs and metric_id for metric tabs.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "table_name": { "type": "string" },
                        "type": { "type": "string", "enum": ["query", "table", "table_structure", "metric", "metric_list", "seatunnel_job", "er_diagram"] }
                    },
                    "required": []
                }
            }),
            json!({
                "name": "get_tab_content",
                "description": "Get the content of a specific tab (SQL, table data, metric definition, etc.)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string" }
                    },
                    "required": ["tab_id"]
                }
            }),
            json!({
                "name": "focus_tab",
                "description": "Switch focus to a specific tab",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string" }
                    },
                    "required": ["tab_id"]
                }
            }),
            json!({
                "name": "open_tab",
                "description": "Open a new tab. For table_structure: requires connection_id + table_name. For metric: requires metric_id. For seatunnel_job: requires job_id. For query: requires connection_id. Waits for tab to be fully opened before returning.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer", "description": "Required for table_structure and query types" },
                        "type": { "type": "string", "enum": ["table_structure", "metric", "query", "seatunnel_job"] },
                        "table_name": { "type": "string", "description": "Required for table_structure" },
                        "database": { "type": "string" },
                        "metric_id": { "type": "integer", "description": "Required for metric type" },
                        "job_id": { "type": "integer", "description": "Required for seatunnel_job type" }
                    },
                    "required": ["type"]
                }
            }),
            json!({
                "name": "get_metric",
                "description": "Get metric definition by ID",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "metric_id": { "type": "integer" }
                    },
                    "required": ["metric_id"]
                }
            }),
            json!({
                "name": "update_metric_definition",
                "description": "Update a metric definition. Supports all core fields. Requires Auto mode ON. Only provided fields are updated; omitted fields remain unchanged.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "metric_id": { "type": "integer" },
                        "display_name": { "type": "string", "description": "Display name shown in UI" },
                        "description": { "type": "string", "description": "Metric description / business definition" },
                        "table_name": { "type": "string", "description": "Source table name" },
                        "column_name": { "type": "string", "description": "Target column for aggregation" },
                        "filter_sql": { "type": "string", "description": "Optional WHERE clause fragment" },
                        "aggregation": { "type": "string", "description": "Aggregation function, e.g. SUM / COUNT / AVG" }
                    },
                    "required": ["metric_id"]
                }
            }),
            json!({
                "name": "create_metric",
                "description": "Create a new metric definition",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "name": { "type": "string" },
                        "display_name": { "type": "string" },
                        "table_name": { "type": "string" },
                        "description": { "type": "string" }
                    },
                    "required": ["connection_id", "name", "display_name"]
                }
            }),
            json!({
                "name": "get_column_meta",
                "description": "Get column metadata for a table",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "table_name": { "type": "string" },
                        "database": { "type": "string" }
                    },
                    "required": ["connection_id", "table_name"]
                }
            }),
            json!({
                "name": "update_column_comment",
                "description": "Update a column's comment/description via ALTER TABLE. Requires Auto mode ON.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "table_name": { "type": "string" },
                        "column_name": { "type": "string" },
                        "comment": { "type": "string" },
                        "database": { "type": "string" }
                    },
                    "required": ["connection_id", "table_name", "column_name", "comment"]
                }
            }),
            json!({
                "name": "get_change_history",
                "description": "Get the change history for the current session",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "limit": { "type": "integer", "description": "Max records to return (default 10, max 50)" }
                    },
                    "required": []
                }
            }),
            json!({
                "name": "undo_last_change",
                "description": "Undo the last successful change in the current session (LIFO). Only undoes status=success records.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }),
            json!({
                "name": "list_metrics",
                "description": "List metric definitions for a connection. Supports filtering by status (draft/approved/rejected) and scoping by database/schema.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer", "description": "Connection ID" },
                        "status": {
                            "type": "string",
                            "description": "Filter by status. Omit to return all.",
                            "enum": ["draft", "approved", "rejected"]
                        },
                        "database": { "type": "string", "description": "Filter by scope_database" },
                        "schema": { "type": "string", "description": "Filter by scope_schema" },
                        "limit": { "type": "integer", "description": "Max records to return (default 50, max 200)" }
                    },
                    "required": ["connection_id"]
                }
            }),
            json!({
                "name": "search_metrics",
                "description": "Search approved metric definitions by keyword (matches name, display_name, or description).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer", "description": "Connection ID" },
                        "keyword": { "type": "string", "description": "Search keyword (space-separated terms are ANDed)" }
                    },
                    "required": ["connection_id", "keyword"]
                }
            }),
            json!({
                "name": "propose_seatunnel_job",
                "description": "AI-generated SeaTunnel Job configuration proposal. Creates or updates a Job config for data migration/sync and shows it to the user for confirmation. If job_id is provided, updates the existing job (use this when the user has a job tab open); otherwise creates a new job in the specified category.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job_name": { "type": "string", "description": "Name for the SeaTunnel Job" },
                        "config_json": { "type": "string", "description": "SeaTunnel Job configuration JSON (env + source + sink sections)" },
                        "job_id": { "type": "integer", "description": "Optional existing Job ID to update. Provide this when editing an already-open job tab." },
                        "category_id": { "type": "integer", "description": "Optional category ID to place the job in (only used when creating a new job)" },
                        "description": { "type": "string", "description": "Brief description of what this job does" }
                    },
                    "required": ["job_name", "config_json"]
                }
            }),
            json!({
                "name": "graph_query_context",
                "description": "当问题涉及多表关联、字段歧义或不确定表名时优先调用。基于 GraphExplorer 知识图谱，返回相关表列表、推断的 JOIN 路径、精简 DDL 和业务指标。获得结果后再按需调用细粒度工具深挖。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "question": { "type": "string", "description": "用户原始问题（用于实体提取）" },
                        "connection_id": { "type": "integer", "description": "数据库连接 ID" }
                    },
                    "required": ["question", "connection_id"]
                }
            }),
            json!({
                "name": "graph_search_tables",
                "description": "在知识图谱中按关键词模糊搜索表名、别名、display_name，返回匹配的表列表。与 list_tables 的区别：本工具搜索用户定义的业务别名，list_tables 返回数据库实际表名。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "question": { "type": "string", "description": "搜索关键词" },
                        "connection_id": { "type": "integer", "description": "数据库连接 ID" }
                    },
                    "required": ["question", "connection_id"]
                }
            }),
            json!({
                "name": "graph_find_join_paths",
                "description": "给定起点表和终点表，在知识图谱中查找通过 Link Node（两跳结构：table→link→table）连接的最短 JOIN 路径，支持多跳中间表穿越。返回包含 cardinality、via 字段、语义描述的结构化路径列表。首次调用有约 10ms 图加载耗时，后续调用 < 1ms。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "from_table": { "type": "string", "description": "起点表名" },
                        "to_table": { "type": "string", "description": "终点表名" },
                        "connection_id": { "type": "integer", "description": "数据库连接 ID" },
                        "max_depth": { "type": "integer", "description": "最大跳数，默认 4，最大 6" }
                    },
                    "required": ["from_table", "to_table", "connection_id"]
                }
            }),
            json!({
                "name": "graph_get_ddl",
                "description": "获取指定表的精简 DDL（仅包含字段名、类型、注释、外键），用于了解字段详情。与 get_table_schema 的区别：本工具输出 CREATE TABLE 文本，更适合直接插入 SQL 生成 prompt。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "table_name": { "type": "string", "description": "表名" },
                        "connection_id": { "type": "integer", "description": "数据库连接 ID" }
                    },
                    "required": ["table_name", "connection_id"]
                }
            }),
            json!({
                "name": "graph_search_metrics",
                "description": "在知识图谱中搜索业务指标节点，返回指标名称和计算逻辑定义。与 search_metrics 的区别：本工具搜索图谱节点（node_type=metric），search_metrics 搜索 MetricsExplorer 中 approved 的指标记录。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "keyword": { "type": "string", "description": "搜索关键词" },
                        "connection_id": { "type": "integer", "description": "数据库连接 ID" }
                    },
                    "required": ["keyword", "connection_id"]
                }
            })
        ]
    })
}

fn optimize_tool_definitions() -> Value {
    json!({
        "tools": [
            {
                "name": "list_databases",
                "description": "List all databases for a connection",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer", "description": "Connection ID" }
                    },
                    "required": ["connection_id"]
                }
            },
            {
                "name": "list_tables",
                "description": "List all tables in a database",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "database": { "type": "string" }
                    },
                    "required": ["connection_id", "database"]
                }
            },
            {
                "name": "get_table_schema",
                "description": "Get column definitions, indexes, and foreign keys for a table",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "table": { "type": "string" },
                        "database": { "type": "string" }
                    },
                    "required": ["connection_id", "table"]
                }
            },
            {
                "name": "get_table_sample",
                "description": "Get sample rows from a table (max 20 rows)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "table": { "type": "string" },
                        "database": { "type": "string" },
                        "limit": { "type": "integer" }
                    },
                    "required": ["connection_id", "table"]
                }
            }
        ]
    })
}

async fn call_tool(handle: Arc<tauri::AppHandle>, name: &str, args: Value, session_id: String) -> crate::AppResult<String> {
    match name {
        "list_databases" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource(&config).await?;
            let dbs = ds.list_databases().await?;
            Ok(serde_json::to_string_pretty(&dbs).unwrap_or_default())
        }
        "list_tables" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let database = args["database"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing database".into()))?;
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource_with_db(&config, database).await?;
            let tables = ds.list_objects(database, None, "tables").await?;
            Ok(serde_json::to_string_pretty(&tables).unwrap_or_default())
        }
        "get_table_schema" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let table = args["table"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing table".into()))?;
            // 验证表名只含合法字符（防止 SQL 注入）
            if !table.chars().all(|c| c.is_alphanumeric() || c == '_') {
                return Err(crate::AppError::Other("Invalid table name".into()));
            }
            let database = args["database"].as_str();
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = match database.filter(|s| !s.is_empty()) {
                Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
                None => crate::datasource::create_datasource(&config).await?,
            };
            let columns = ds.get_columns(table, None).await?;
            let indexes = ds.get_indexes(table, None).await?;
            let foreign_keys = ds.get_foreign_keys(table, None).await?;
            let detail = crate::datasource::TableDetail {
                name: table.to_string(),
                columns,
                indexes,
                foreign_keys,
            };
            Ok(serde_json::to_string_pretty(&detail).unwrap_or_default())
        }
        "get_table_sample" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let table = args["table"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing table".into()))?;
            // 验证表名只含合法字符（防止 SQL 注入）
            if !table.chars().all(|c| c.is_alphanumeric() || c == '_') {
                return Err(crate::AppError::Other("Invalid table name".into()));
            }
            let database = args["database"].as_str();
            let limit = args["limit"].as_u64().unwrap_or(5).min(20);
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = match database.filter(|s| !s.is_empty()) {
                Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
                None => crate::datasource::create_datasource(&config).await?,
            };
            let sql = format!("SELECT * FROM `{}` LIMIT {}", table, limit);
            let result = ds.execute(&sql).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "execute_sql" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let sql = args["sql"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing sql".into()))?;
            let database = args["database"].as_str();
            let trimmed = sql.trim().to_uppercase();
            if !trimmed.starts_with("SELECT")
                && !trimmed.starts_with("WITH")
                && !trimmed.starts_with("SHOW") {
                return Err(crate::AppError::Other("Only SELECT/WITH/SHOW allowed".into()));
            }
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = match database.filter(|s| !s.is_empty()) {
                Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
                None => crate::datasource::create_datasource(&config).await?,
            };
            let mut result = ds.execute(sql).await?;
            result.rows.truncate(100);
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "propose_sql_diff" => {
            use tauri::{Emitter, Manager};
            let original = args["original"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing original".into()))?
                .to_string();
            let modified = args["modified"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing modified".into()))?
                .to_string();
            let reason = args["reason"].as_str()
                .unwrap_or("")
                .to_string();

            // 创建 oneshot channel，rx 在此等待用户响应
            let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
            {
                let app_state = handle.state::<crate::AppState>();
                let mut pending = app_state.pending_diff_response.lock().await;
                // 若上一个 diff 尚未响应则丢弃（只允许一个 pending diff）
                *pending = Some(tx);
            }

            handle.emit("sql-diff-proposal", DiffProposalPayload { original, modified, reason })
                .map_err(|e| crate::AppError::Other(e.to_string()))?;

            // 阻塞等待前端通过 mcp_diff_respond 命令回复，超时 5 分钟
            match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
                Ok(Ok(true))  => Ok(r#"{"confirmed":true,"message":"用户已确认，SQL 修改已应用到编辑器"}"#.to_string()),
                Ok(Ok(false)) => Ok(r#"{"confirmed":false,"message":"用户已取消，SQL 修改未应用"}"#.to_string()),
                Ok(Err(_))    => Err(crate::AppError::Other("diff response channel dropped".into())),
                Err(_)        => {
                    // 超时：清空 pending（tx 已在 AppState 中，drop 即可）
                    let app_state = handle.state::<crate::AppState>();
                    app_state.pending_diff_response.lock().await.take();
                    Err(crate::AppError::Other("等待用户确认超时（5分钟）".into()))
                }
            }
        }
        "get_editor_sql" => {
            use tauri::Manager;
            let app_state = handle.state::<crate::AppState>();
            let last_id = app_state.last_active_session_id.lock().await.clone();
            let sql = if let Some(sid) = last_id {
                let map = app_state.editor_sql_map.lock().await;
                map.get(&sid).cloned().flatten()
            } else {
                None
            };
            match sql {
                Some(s) if !s.trim().is_empty() => Ok(s),
                _ => Ok("(编辑器为空)".to_string()),
            }
        }
        "list_tasks" => {
            let limit = args["limit"].as_i64().unwrap_or(20).min(100) as i32;
            let status_filter = args["status"].as_str();
            let tasks = crate::db::list_tasks(limit)?;
            let filtered: Vec<_> = match status_filter {
                Some(s) => tasks.into_iter().filter(|t| t.status == s).collect(),
                None => tasks,
            };
            // 返回摘要信息（不含 params 字段，减少噪音）
            let summary: Vec<serde_json::Value> = filtered.iter().map(|t| json!({
                "id": t.id,
                "type": t.type_,
                "status": t.status,
                "title": t.title,
                "progress": t.progress,
                "processed_rows": t.processed_rows,
                "total_rows": t.total_rows,
                "current_target": t.current_target,
                "error": t.error,
                "output_path": t.output_path,
                "created_at": t.created_at,
                "completed_at": t.completed_at,
            })).collect();
            Ok(serde_json::to_string_pretty(&summary).unwrap_or_default())
        }
        "get_task_detail" => {
            let task_id = args["task_id"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing task_id".into()))?;
            match crate::db::get_task_by_id(task_id)? {
                None => Ok(format!("Task '{}' not found", task_id)),
                Some(t) => {
                    // 解析 error_details JSON 字符串为数组（方便 AI 阅读）
                    let error_details: serde_json::Value = t.error_details
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(serde_json::Value::Array(vec![]));
                    let detail = json!({
                        "id": t.id,
                        "type": t.type_,
                        "status": t.status,
                        "title": t.title,
                        "progress": t.progress,
                        "processed_rows": t.processed_rows,
                        "total_rows": t.total_rows,
                        "current_target": t.current_target,
                        "error": t.error,
                        "error_details": error_details,
                        "output_path": t.output_path,
                        "created_at": t.created_at,
                        "updated_at": t.updated_at,
                        "completed_at": t.completed_at,
                    });
                    Ok(serde_json::to_string_pretty(&detail).unwrap_or_default())
                }
            }
        }
        "search_db_metadata" => {
            tools::db_read::search_db_metadata(Arc::clone(&handle), args).await
        }
        "search_tabs" => {
            tools::tab_control::search_tabs(Arc::clone(&handle), args).await
        }
        "get_tab_content" => {
            tools::tab_control::get_tab_content(Arc::clone(&handle), args).await
        }
        "focus_tab" => {
            tools::tab_control::focus_tab(Arc::clone(&handle), args).await
        }
        "open_tab" => {
            tools::tab_control::open_tab(Arc::clone(&handle), args).await
        }
        "get_metric" => {
            tools::metric_edit::get_metric(Arc::clone(&handle), args).await
        }
        "update_metric_definition" => {
            tools::metric_edit::update_metric_definition(Arc::clone(&handle), args, session_id).await
        }
        "create_metric" => {
            tools::metric_edit::create_metric(Arc::clone(&handle), args).await
        }
        "list_metrics" => {
            tools::metric_edit::list_metrics(Arc::clone(&handle), args).await
        }
        "search_metrics" => {
            tools::metric_edit::search_metrics(Arc::clone(&handle), args).await
        }
        "get_column_meta" => {
            tools::table_edit::get_column_meta(Arc::clone(&handle), args).await
        }
        "update_column_comment" => {
            tools::table_edit::update_column_comment(Arc::clone(&handle), args, session_id).await
        }
        "get_change_history" => {
            tools::history::get_change_history(Arc::clone(&handle), args, session_id).await
        }
        "undo_last_change" => {
            tools::history::undo_last_change(Arc::clone(&handle), args, session_id).await
        }
        "propose_seatunnel_job" => {
            tools::seatunnel::propose_seatunnel_job(Arc::clone(&handle), args).await
        }
        "graph_query_context" => {
            tools::graph::query_context::handle(Arc::clone(&handle), args).await
        }
        "graph_search_tables" => {
            tools::graph::search_tables::handle(Arc::clone(&handle), args).await
        }
        "graph_find_join_paths" => {
            tools::graph::find_join_paths::handle(Arc::clone(&handle), args).await
        }
        "graph_get_ddl" => {
            tools::graph::get_ddl::handle(Arc::clone(&handle), args).await
        }
        "graph_search_metrics" => {
            tools::graph::search_metrics::handle(Arc::clone(&handle), args).await
        }
        _ => Err(crate::AppError::Other(format!("Unknown tool: {}", name))),
    }
}

/// GET /mcp — SSE endpoint for Streamable HTTP transport.
///
/// The MCP Streamable HTTP spec (2025-03-26) allows clients to open a GET SSE
/// connection to receive server-initiated events. This server never pushes events,
/// but we must respond to GET immediately (with a keep-alive SSE stream) so that
/// opencode-cli does not wait for a timeout before falling back to POST-only mode.
async fn handle_mcp_sse() -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    Sse::new(stream::pending()).keep_alive(KeepAlive::default())
}

async fn handle_mcp(
    State(handle): State<Arc<tauri::AppHandle>>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<JsonRpcResponse> {
    let id = req.id.clone();
    match req.method.as_str() {
        // MCP 握手：必须在 tools/list 之前完成，否则客户端会重试/超时
        "initialize" => Json(JsonRpcResponse::ok(id, json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "open-db-studio", "version": "0.1.0" }
        }))),
        // 通知类型（无 id），客户端不等响应，返回空 result 即可
        "notifications/initialized" => Json(JsonRpcResponse::ok(id, json!(null))),
        "tools/list" => Json(JsonRpcResponse::ok(id, tool_definitions())),
        "tools/call" => {
            let params = req.params.unwrap_or(Value::Null);
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = params["arguments"].clone();
            // 获取 session_id
            let session_id = {
                use tauri::Manager;
                let app_state = handle.state::<crate::AppState>();
                let x = app_state.last_active_session_id.lock().await.clone().unwrap_or_else(|| "default".into()); x
            };
            match call_tool(Arc::clone(&handle), &name, args, session_id).await {
                Ok(text) => Json(JsonRpcResponse::ok(id, json!({
                    "content": [{ "type": "text", "text": text }]
                }))),
                Err(e) => Json(JsonRpcResponse::err(id, -32000, &e.to_string())),
            }
        }
        _ => Json(JsonRpcResponse::err(id, -32601, "Method not found")),
    }
}

async fn handle_optimize_mcp_sse() -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    Sse::new(stream::pending()).keep_alive(KeepAlive::default())
}

async fn handle_optimize_mcp(
    State(handle): State<Arc<tauri::AppHandle>>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<JsonRpcResponse> {
    let id = req.id.clone();
    match req.method.as_str() {
        "initialize" => Json(JsonRpcResponse::ok(id, json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "open-db-studio-optimize", "version": "0.1.0" }
        }))),
        "notifications/initialized" => Json(JsonRpcResponse::ok(id, json!(null))),
        "tools/list" => Json(JsonRpcResponse::ok(id, optimize_tool_definitions())),
        "tools/call" => {
            let params = req.params.unwrap_or(Value::Null);
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = params["arguments"].clone();
            // 白名单校验：只允许 4 个只读工具
            let allowed = ["list_databases", "list_tables", "get_table_schema", "get_table_sample"];
            if !allowed.contains(&name.as_str()) {
                return Json(JsonRpcResponse::err(id, -32601, "Tool not available in optimize mode"));
            }
            match call_tool(Arc::clone(&handle), &name, args, "default".to_string()).await {
                Ok(text) => Json(JsonRpcResponse::ok(id, json!({
                    "content": [{ "type": "text", "text": text }]
                }))),
                Err(e) => Json(JsonRpcResponse::err(id, -32000, &e.to_string())),
            }
        }
        _ => Json(JsonRpcResponse::err(id, -32601, "Method not found")),
    }
}

pub async fn start_mcp_server(app_handle: tauri::AppHandle) -> crate::AppResult<u16> {
    // 优先使用固定端口便于调试；若已被占用则退回随机端口
    let listener = TcpListener::bind("127.0.0.1:19876")
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .map_err(|e| crate::AppError::Other(format!("MCP server bind failed: {}", e)))?;
    let port = listener.local_addr()
        .map_err(|e| crate::AppError::Other(e.to_string()))?.port();

    let app = Router::new()
        .route("/mcp", get(handle_mcp_sse))
        .route("/mcp", post(handle_mcp))
        .route("/mcp/optimize", get(handle_optimize_mcp_sse))
        .route("/mcp/optimize", post(handle_optimize_mcp))
        .with_state(Arc::new(app_handle));

    listener.set_nonblocking(true)
        .map_err(|e| crate::AppError::Other(format!("MCP set_nonblocking failed: {}", e)))?;
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).expect("listener convert");
        axum::serve(listener, app).await.expect("MCP server failed");
    });

    log::info!("MCP server started on port {}", port);
    Ok(port)
}
