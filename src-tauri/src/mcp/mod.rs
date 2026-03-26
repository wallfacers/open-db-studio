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
                "name": "list_views",
                "description": "List all views in a database",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "database":      { "type": "string" }
                    },
                    "required": ["connection_id", "database"]
                }
            },
            {
                "name": "list_procedures",
                "description": "List all stored procedures/functions in a database",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer" },
                        "database":      { "type": "string" }
                    },
                    "required": ["connection_id", "database"]
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
                "name": "search_tabs",
                "description": "Search currently opened tabs by type or table name. Results include is_active=true for the currently active tab, job_id for seatunnel_job tabs, and metric_id for metric tabs. Use this to find the active tab.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "table_name": { "type": "string" },
                        "type": { "type": "string", "enum": ["query", "table", "table_structure", "metric", "metric_list", "seatunnel_job", "er_design"] }
                    },
                    "required": []
                }
            }),
            json!({
                "name": "graph_query_context",
                "description": "Call this first when the question involves multi-table joins, ambiguous field names, or uncertain table names. Uses the GraphExplorer knowledge graph to return relevant tables, inferred JOIN paths, condensed DDL, and business metrics. Use fine-grained tools for deeper exploration after getting results.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "question": { "type": "string", "description": "The user's original question (used for entity extraction)" },
                        "connection_id": { "type": "integer", "description": "Database connection ID" }
                    },
                    "required": ["question", "connection_id"]
                }
            }),
            json!({
                "name": "graph_search_tables",
                "description": "Fuzzy-search table names, aliases, and display_names in the knowledge graph. Unlike list_tables (which returns actual DB table names), this tool searches user-defined business aliases.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "question": { "type": "string", "description": "Search keyword" },
                        "connection_id": { "type": "integer", "description": "Database connection ID" }
                    },
                    "required": ["question", "connection_id"]
                }
            }),
            json!({
                "name": "graph_find_join_paths",
                "description": "Find the shortest JOIN path between two tables via Link Nodes (two-hop structure: table→link→table) in the knowledge graph, supporting multi-hop traversal. Returns structured paths with cardinality, via fields, and semantic descriptions. First call ~10ms graph load; subsequent calls <1ms.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "from_table": { "type": "string", "description": "Source table name" },
                        "to_table": { "type": "string", "description": "Target table name" },
                        "connection_id": { "type": "integer", "description": "Database connection ID" },
                        "max_depth": { "type": "integer", "description": "Maximum hops, default 4, max 6" }
                    },
                    "required": ["from_table", "to_table", "connection_id"]
                }
            }),
            json!({
                "name": "graph_get_ddl",
                "description": "Get condensed DDL for a table (column names, types, comments, and foreign keys only). Unlike get_table_schema, this outputs CREATE TABLE text suitable for direct inclusion in SQL generation prompts.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "table_name": { "type": "string", "description": "Table name" },
                        "connection_id": { "type": "integer", "description": "Database connection ID" }
                    },
                    "required": ["table_name", "connection_id"]
                }
            }),
            json!({
                "name": "graph_search_metrics",
                "description": "Search business metric nodes in the knowledge graph, returning metric names and calculation logic. Unlike fs_search('tab.metric'), this searches graph nodes (node_type=metric); fs_search searches approved MetricsExplorer records.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "keyword": { "type": "string", "description": "Search keyword" },
                        "connection_id": { "type": "integer", "description": "Database connection ID" }
                    },
                    "required": ["keyword", "connection_id"]
                }
            }),
            json!({
                "name": "graph_debug_links",
                "description": "Diagnostic tool: inspect all Link Nodes and their metadata (source_table, target_table, via, etc.) for a connection. Use this to diagnose why graph_find_join_paths returns empty paths. Optionally filter by table name.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer", "description": "Database connection ID" },
                        "table_name": { "type": "string", "description": "Optional: filter to only return Link Nodes involving this table" }
                    },
                    "required": ["connection_id"]
                }
            }),
            json!({
                "name": "fs_read",
                "description": "Read content from any tab or panel. mode=text→SQL with line info; mode=struct→structured JSON; mode=error→last SQL error; mode=history→recent query history.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "resource": { "type": "string", "description": "tab.query | tab.table | tab.metric | tab.seatunnel | panel.db-tree | panel.history" },
                        "target":   { "type": "string", "description": "tab.query: active|tab_id. tab.table: table@conn:N. tab.metric: <metric_id>. tab.seatunnel: <job_id>. panel.history: active" },
                        "mode":     { "type": "string", "description": "tab.query: text|struct|error|history. tab.table/metric/history: struct" }
                    },
                    "required": ["resource", "target", "mode"]
                }
            }),
            json!({
                "name": "fs_write",
                "description": "Write or patch tab content. SQL editor writes show diff unless Auto mode is on. Requires Auto mode ON for tab.metric and tab.table writes.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "resource": { "type": "string", "description": "tab.query | tab.metric | tab.table | tab.seatunnel" },
                        "target":   { "type": "string", "description": "tab.query: active|tab_id. tab.metric: <metric_id>. tab.table: table@conn:N. tab.seatunnel: <job_id>" },
                        "patch": {
                            "type": "object",
                            "description": "tab.query: {mode:'text',op:'replace_all',content:'...',reason:'...'}. tab.metric: {mode:'struct',path:'/field',value:...}. tab.table comment: {column_name,comment}. tab.table modify: {action:'modify_column',column_name,changes:{name?,data_type?,length?,is_nullable?,default_value?,extra?,comment?}}"
                        }
                    },
                    "required": ["resource", "target", "patch"]
                }
            }),
            json!({
                "name": "fs_search",
                "description": "Search tabs or panels. tab.*=all open tabs; tab.metric=list/search metrics; panel.db-tree=search cached DB tree.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "resource_pattern": { "type": "string", "description": "tab.* | tab.query | tab.metric | panel.db-tree" },
                        "filter": { "type": "object", "description": "tab.query/tab.*: {keyword?}. tab.metric: {connection_id, keyword?, status?, limit?}. panel.db-tree: {keyword, type?, connection_id?}" }
                    },
                    "required": ["resource_pattern"]
                }
            }),
            json!({
                "name": "fs_open",
                "description": "Open a new tab. Returns { target: tab_id }.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "resource": { "type": "string", "description": "tab.query | tab.metric | tab.table | tab.seatunnel" },
                        "params":   { "type": "object", "description": "tab.query: {connection_id,label?,database?}. tab.metric: {metric_id}. tab.table: {table,database,connection_id}. tab.seatunnel: {job_id}" }
                    },
                    "required": ["resource"]
                }
            }),
            json!({
                "name": "fs_exec",
                "description": "Execute an action on a resource target.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "resource": { "type": "string", "description": "tab.query | tab.metric | tab.table | tab.seatunnel | panel.history" },
                        "target":   { "type": "string", "description": "active | tab_id | new" },
                        "action":   { "type": "string", "description": "tab.query: focus|run_sql|undo|confirm_write. tab.metric: create. tab.table: create_table|add_column|drop_column. tab.seatunnel: create. panel.history: undo" },
                        "params":   { "type": "object" }
                    },
                    "required": ["resource", "target", "action"]
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
        "list_views" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let database = args["database"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing database".into()))?;
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource_with_db(&config, database).await?;
            let views = ds.list_objects(database, None, "views").await?;
            Ok(serde_json::to_string_pretty(&views).unwrap_or_default())
        }
        "list_procedures" => {
            let conn_id = args["connection_id"].as_i64()
                .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;
            let database = args["database"].as_str()
                .ok_or_else(|| crate::AppError::Other("missing database".into()))?;
            let config = crate::db::get_connection_config(conn_id)?;
            let ds = crate::datasource::create_datasource_with_db(&config, database).await?;
            let procs = ds.list_objects(database, None, "procedures").await?;
            Ok(serde_json::to_string_pretty(&procs).unwrap_or_default())
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
            // Validate table name contains only safe characters (prevent SQL injection)
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
            // Validate table name contains only safe characters (prevent SQL injection)
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
        "list_tasks" => {
            let limit = args["limit"].as_i64().unwrap_or(20).min(100) as i32;
            let status_filter = args["status"].as_str();
            let tasks = crate::db::list_tasks(limit)?;
            let filtered: Vec<_> = match status_filter {
                Some(s) => tasks.into_iter().filter(|t| t.status == s).collect(),
                None => tasks,
            };
            // Return summary (omit params field to reduce noise)
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
                    // Parse error_details JSON string into array for easier AI consumption
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
        "search_tabs" => {
            tools::tab_control::search_tabs(Arc::clone(&handle), args).await
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
        "graph_debug_links" => {
            tools::graph::debug_links::handle(Arc::clone(&handle), args).await
        }
        "fs_read" | "fs_write" | "fs_search" | "fs_open" | "fs_exec" => {
            let op = name.strip_prefix("fs_").unwrap_or(name);
            let resource = args
                .get("resource").or_else(|| args.get("resource_pattern"))
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            let target = args.get("target")
                .and_then(|v| v.as_str()).unwrap_or("active").to_string();
            let payload = match op {
                "search" => args.get("filter").cloned().unwrap_or(json!({})),
                "write"  => args.get("patch").cloned().unwrap_or(json!({})),
                "open"   => args.get("params").cloned().unwrap_or(json!({})),
                "exec"   => json!({
                    "action": args.get("action").and_then(|v| v.as_str()).unwrap_or(""),
                    "params": args.get("params").cloned().unwrap_or(json!({}))
                }),
                _        => json!({
                    "mode": args.get("mode").and_then(|v| v.as_str()).unwrap_or("struct")
                }),
            };

            // Dispatch by resource: handle in backend vs forward to frontend FsRouter
            match resource.as_str() {
                // ── Handled directly in backend (no frontend roundtrip) ──────────────────────────
                r if r.starts_with("tab.metric") => {
                    tools::fs_metric::handle(Arc::clone(&handle), op, &target, payload, session_id).await
                }
                r if r.starts_with("tab.table") => {
                    tools::fs_table::handle(Arc::clone(&handle), op, &target, payload, session_id).await
                }
                r if r.starts_with("tab.seatunnel") => {
                    tools::fs_seatunnel::handle(Arc::clone(&handle), op, &target, payload, session_id).await
                }
                "panel.history" => {
                    tools::fs_history::handle(Arc::clone(&handle), op, &target, payload, session_id).await
                }
                // ── Handled by frontend FsRouter (tab.query → QueryTabAdapter, panel.db-tree → DbTreeAdapter)
                _ => {
                    let result = crate::mcp::tools::tab_control::query_frontend(
                        &handle,
                        "fs_request",
                        json!({ "op": op, "resource": resource, "target": target, "payload": payload }),
                    ).await?;
                    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
                }
            }
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
        // MCP handshake: must complete before tools/list or clients will retry/timeout
        "initialize" => Json(JsonRpcResponse::ok(id, json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "open-db-studio", "version": "0.1.0" }
        }))),
        // Notification (no id), client doesn't wait for response — return empty result
        "notifications/initialized" => Json(JsonRpcResponse::ok(id, json!(null))),
        "tools/list" => Json(JsonRpcResponse::ok(id, tool_definitions())),
        "tools/call" => {
            let params = req.params.unwrap_or(Value::Null);
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = params["arguments"].clone();
            // Resolve session_id
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
            // Allowlist: only 4 read-only tools permitted
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
    // Prefer fixed port for easier debugging; fall back to random port if occupied
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
