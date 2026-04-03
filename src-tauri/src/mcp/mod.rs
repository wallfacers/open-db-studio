pub(crate) mod tools;

use axum::{routing::{get, post}, Router, Json, extract::State};
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::{stream, StreamExt};
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
                "name": "list_connections",
                "description": "List all configured database connections (id, name, driver, host, database_name). Call this first when connection_id is unknown.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            },
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
                "name": "ui_read",
                "description": "Read the current state, schema, or available actions of a UI object.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "object": { "type": "string", "description": "Object type: query_editor, table_form, workspace, metric_form, seatunnel_job, db_tree, history, er_canvas" },
                        "target": { "type": "string", "description": "objectId or 'active'", "default": "active" },
                        "mode": { "type": "string", "enum": ["state", "schema", "actions"], "default": "state" }
                    },
                    "required": ["object"]
                }
            }),
            json!({
                "name": "ui_patch",
                "description": "Apply JSON Patch (RFC 6902) operations to a UI object's state. Use [name=xxx] addressing for array elements. IMPORTANT: Always batch ALL changes into a single ui_patch call with multiple ops. For table_form, set tableName AND add ALL columns in one call. Example: [{\"op\":\"replace\",\"path\":\"/tableName\",\"value\":\"users\"},{\"op\":\"add\",\"path\":\"/columns/-\",\"value\":{\"name\":\"id\",\"dataType\":\"INT\",...}},{\"op\":\"add\",\"path\":\"/columns/-\",\"value\":{\"name\":\"email\",\"dataType\":\"VARCHAR\",...}}] Tip: call ui_read(mode='schema') first to see supported patch paths and addressable keys for the target object.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "object": { "type": "string", "description": "Object type" },
                        "target": { "type": "string", "description": "objectId or 'active'", "default": "active" },
                        "ops": { "type": "array", "description": "Array of JSON Patch operations. Batch all changes into one call for best performance.", "items": { "type": "object" } },
                        "reason": { "type": "string", "description": "Human-readable reason for the change" }
                    },
                    "required": ["object", "ops"]
                }
            }),
            json!({
                "name": "ui_exec",
                "description": "Execute an action on a UI object (e.g. run_sql, save, preview_sql, format). Tip: call ui_read(mode='actions') first to see all available actions with parameter schemas.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "object": { "type": "string", "description": "Object type" },
                        "target": { "type": "string", "description": "objectId or 'active'", "default": "active" },
                        "action": { "type": "string", "description": "Action name" },
                        "params": { "type": "object", "description": "Action parameters" }
                    },
                    "required": ["object", "action"]
                }
            }),
            json!({
                "name": "ui_list",
                "description": "List all currently open UI objects, optionally filtered by type.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "filter": { "type": "object", "properties": { "type": { "type": "string" }, "keyword": { "type": "string" }, "connectionId": { "type": "integer" }, "database": { "type": "string" } } }
                    }
                }
            }),
            json!({
                "name": "init_table_form",
                "description": "Open a table design form for a CONNECTED DATABASE and populate it with columns/indexes. This is for editing real database tables (generates DDL). Do NOT use this for ER diagram design — use init_er_table instead. Requires connection_id and database.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "connection_id": { "type": "integer", "description": "Database connection ID" },
                        "database": { "type": "string", "description": "Target database name" },
                        "table_name": { "type": "string", "description": "Table name" },
                        "columns": {
                            "type": "array",
                            "description": "Column definitions",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string" },
                                    "dataType": { "type": "string" },
                                    "length": { "type": "string" },
                                    "isNullable": { "type": "boolean", "default": true },
                                    "defaultValue": { "type": "string" },
                                    "isPrimaryKey": { "type": "boolean", "default": false },
                                    "extra": { "type": "string" },
                                    "comment": { "type": "string" }
                                },
                                "required": ["name", "dataType"]
                            }
                        },
                        "indexes": {
                            "type": "array",
                            "description": "Index definitions (optional)",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string" },
                                    "columns": { "type": "array", "items": { "type": "string" } },
                                    "unique": { "type": "boolean", "default": false }
                                },
                                "required": ["name", "columns"]
                            }
                        },
                        "comment": { "type": "string", "description": "Table comment" },
                        "engine": { "type": "string", "default": "InnoDB" },
                        "charset": { "type": "string", "default": "utf8mb4" }
                    },
                    "required": ["connection_id", "database", "table_name", "columns"]
                }
            }),
            json!({
                "name": "init_er_table",
                "description": "Create ONE complete table with columns and indexes in the active ER diagram. For single-table creation this is the simplest choice. For multi-table + relations, use er_batch instead (supports variable binding across operations). This is for ER DESIGN projects (visual schema design), NOT for connected databases — use init_table_form for that.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "target": { "type": "string", "description": "ER canvas objectId. Use 'active' to target the currently open ER canvas." },
                        "table_name": { "type": "string", "description": "Table name" },
                        "comment": { "type": "string", "description": "Table comment" },
                        "position": {
                            "type": "object",
                            "properties": { "x": { "type": "number" }, "y": { "type": "number" } },
                            "description": "Canvas position (defaults to {x:100, y:100})"
                        },
                        "columns": {
                            "type": "array",
                            "description": "Column definitions",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string" },
                                    "data_type": { "type": "string", "description": "e.g. VARCHAR, BIGINT, DECIMAL, DATETIME, TEXT, ENUM" },
                                    "length": { "type": "integer" },
                                    "scale": { "type": "integer" },
                                    "nullable": { "type": "boolean", "default": true },
                                    "is_primary_key": { "type": "boolean", "default": false },
                                    "is_auto_increment": { "type": "boolean", "default": false },
                                    "is_unique": { "type": "boolean", "default": false },
                                    "unsigned": { "type": "boolean", "default": false },
                                    "default_value": { "type": "string" },
                                    "comment": { "type": "string" }
                                },
                                "required": ["name", "data_type"]
                            }
                        },
                        "indexes": {
                            "type": "array",
                            "description": "Index definitions",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string" },
                                    "columns": { "type": "array", "items": { "type": "string" }, "description": "Column names for the index" },
                                    "type": { "type": "string", "enum": ["INDEX", "UNIQUE", "FULLTEXT"], "default": "INDEX" }
                                },
                                "required": ["name", "columns"]
                            }
                        }
                    },
                    "required": ["table_name", "columns"]
                }
            }),
            json!({
                "name": "er_batch",
                "description": "Execute a sequence of ER canvas actions in one call with variable binding. Each op is {action, params}. Results from earlier ops can be referenced via \"$N.path\" syntax (e.g. \"$0.tableId\", \"$1.columnMap.user_id\", \"$2.columnIds[0]\"). Stops on first failure. Available actions: batch_create_table, add_table, update_table, delete_table, add_column, update_column, delete_column, add_relation, update_relation, delete_relation, add_index, update_index, delete_index, replace_columns, replace_indexes. Common patterns: create tables + relations (batch_create_table x N then add_relation), modify existing table (update_column/delete_column/add_column), rebuild columns (replace_columns).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "target": { "type": "string", "description": "ER canvas objectId. Use 'active' for the currently open canvas." },
                        "ops": {
                            "type": "array",
                            "description": "Ordered list of operations. Each reuses any existing er_canvas action.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "action": { "type": "string", "description": "Action name: add_table, add_column, batch_create_table, add_relation, update_column, delete_column, etc." },
                                    "params": { "type": "object", "description": "Action params. String values like \"$0.tableId\" resolve to previous op results." }
                                },
                                "required": ["action"]
                            }
                        }
                    },
                    "required": ["ops"]
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
                "description": "Search business metric nodes in the knowledge graph, returning metric names and calculation logic. This searches graph nodes (node_type=metric). To get ALL metrics for a specific table (e.g. '订单表有哪些指标'), pass table_name (exact English table name like 'orders') instead of keyword.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "keyword": { "type": "string", "description": "Fuzzy match against metric name/display_name. Mutually exclusive with table_name." },
                        "table_name": { "type": "string", "description": "Exact table name (e.g. 'orders'). Returns ALL metrics belonging to this table. Use when user asks 'what metrics does table X have'. Mutually exclusive with keyword." },
                        "connection_id": { "type": "integer", "description": "Database connection ID" }
                    },
                    "required": ["connection_id"]
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

async fn call_tool(handle: Arc<tauri::AppHandle>, name: &str, args: Value, _session_id: String) -> crate::AppResult<String> {
    match name {
        "list_connections" => {
            let connections = crate::db::list_connections()?;
            Ok(serde_json::to_string_pretty(&connections).unwrap_or_default())
        }
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
        "init_table_form" => {
            // Single-IPC fast path: open a table_form tab and populate it with a complete definition.
            // Step 1: Ask frontend to open a new table_form tab via workspace.exec('open')
            let conn_id = args["connection_id"].as_i64().unwrap_or(0);
            let database = args["database"].as_str().unwrap_or("");
            let open_payload = json!({
                "tool": "ui_exec",
                "object": "workspace",
                "target": "workspace",
                "payload": {
                    "action": "open",
                    "params": {
                        "type": "table_form",
                        "connection_id": conn_id,
                        "database": database
                    }
                }
            });
            let open_result = crate::mcp::tools::tab_control::query_frontend(
                &handle, "mcp://ui-request", "ui_request", open_payload,
            ).await?;

            let object_id = open_result["data"]["objectId"].as_str().unwrap_or("").to_string();
            if object_id.is_empty() {
                return Err(crate::AppError::Other("Failed to open table_form tab".into()));
            }

            // Step 2: Build a single batch patch with tableName + all columns + indexes
            let mut ops: Vec<Value> = Vec::new();
            ops.push(json!({"op": "replace", "path": "/tableName", "value": args["table_name"]}));
            if let Some(comment) = args.get("comment").and_then(|v| v.as_str()) {
                ops.push(json!({"op": "replace", "path": "/comment", "value": comment}));
            }
            if let Some(engine) = args.get("engine").and_then(|v| v.as_str()) {
                ops.push(json!({"op": "replace", "path": "/engine", "value": engine}));
            }
            if let Some(charset) = args.get("charset").and_then(|v| v.as_str()) {
                ops.push(json!({"op": "replace", "path": "/charset", "value": charset}));
            }
            if let Some(columns) = args["columns"].as_array() {
                for col in columns {
                    ops.push(json!({"op": "add", "path": "/columns/-", "value": col}));
                }
            }
            if let Some(indexes) = args["indexes"].as_array() {
                for idx in indexes {
                    ops.push(json!({"op": "add", "path": "/indexes/-", "value": idx}));
                }
            }

            let patch_payload = json!({
                "tool": "ui_patch",
                "object": "table_form",
                "target": object_id,
                "payload": {
                    "ops": ops,
                    "reason": "init_table_form: batch initialization"
                }
            });
            let patch_result = crate::mcp::tools::tab_control::query_frontend(
                &handle, "mcp://ui-request", "ui_request", patch_payload,
            ).await?;

            let result = json!({
                "objectId": object_id,
                "table_name": args["table_name"],
                "columns_count": args["columns"].as_array().map(|a| a.len()).unwrap_or(0),
                "patch_status": patch_result.get("data").and_then(|d| d.get("status")).unwrap_or(&json!("unknown")),
            });
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "init_er_table" => {
            // Convenience wrapper: single ui_exec call to batch_create_table on er_canvas
            let target = args.get("target").and_then(|v| v.as_str()).unwrap_or("active");
            let exec_params = json!({
                "name": args["table_name"],
                "comment": args.get("comment"),
                "position": args.get("position"),
                "columns": args.get("columns").cloned().unwrap_or(json!([])),
                "indexes": args.get("indexes").cloned().unwrap_or(json!([])),
            });
            let payload = json!({
                "tool": "ui_exec",
                "object": "er_canvas",
                "target": target,
                "payload": {
                    "action": "batch_create_table",
                    "params": exec_params
                }
            });
            let result = crate::mcp::tools::tab_control::query_frontend(
                &handle, "mcp://ui-request", "ui_request", payload,
            ).await?;

            if let Some(err) = result.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                return Err(crate::AppError::Other(format!("init_er_table failed: {}", err)));
            }
            Ok(serde_json::to_string_pretty(&result.get("data").unwrap_or(&json!({}))).unwrap_or_default())
        }
        "er_batch" => {
            // Forward ops array to er_canvas batch action (variable binding resolved on frontend)
            let target = args.get("target").and_then(|v| v.as_str()).unwrap_or("active");
            let payload = json!({
                "tool": "ui_exec",
                "object": "er_canvas",
                "target": target,
                "payload": {
                    "action": "batch",
                    "params": {
                        "ops": args.get("ops").cloned().unwrap_or(json!([]))
                    }
                }
            });
            let result = crate::mcp::tools::tab_control::query_frontend(
                &handle, "mcp://ui-request", "ui_request", payload,
            ).await?;

            if let Some(err) = result.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                return Err(crate::AppError::Other(format!("er_batch failed: {}", err)));
            }
            Ok(serde_json::to_string_pretty(&result.get("data").unwrap_or(&json!({}))).unwrap_or_default())
        }
        "ui_read" | "ui_patch" | "ui_exec" | "ui_list" => {
            let payload = json!({
                "tool":    name,
                "object":  args.get("object").and_then(|v| v.as_str()).unwrap_or(""),
                "target":  args.get("target").and_then(|v| v.as_str()).unwrap_or("active"),
                "payload": match name {
                    "ui_read"  => json!({ "mode": args.get("mode").and_then(|v| v.as_str()).unwrap_or("state") }),
                    "ui_patch" => json!({ "ops": args.get("ops").cloned().unwrap_or(json!([])), "reason": args.get("reason") }),
                    "ui_exec"  => json!({ "action": args.get("action").and_then(|v| v.as_str()).unwrap_or(""), "params": args.get("params").cloned().unwrap_or(json!({})) }),
                    "ui_list"  => json!({ "filter": args.get("filter").cloned().unwrap_or(json!({})) }),
                    _ => json!({})
                }
            });
            let result = crate::mcp::tools::tab_control::query_frontend(
                &handle,
                "mcp://ui-request",
                "ui_request",
                payload,
            ).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
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
        _ => Err(crate::AppError::Other(format!("Unknown tool: {}", name))),
    }
}

/// GET /mcp — SSE endpoint compatible with both legacy SSE transport and
/// Streamable HTTP transport.
///
/// Legacy MCP SSE transport requires the server to emit an `endpoint` event
/// containing the POST URL for JSON-RPC messages. Without this event, clients
/// like opencode-cli will hang waiting for the endpoint announcement.
async fn handle_mcp_sse(
    req: axum::extract::Request,
) -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    // Build the POST URL from the incoming request's Host header (or default)
    let host = req.headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1");
    let post_url = format!("http://{}/mcp", host);

    // Emit the `endpoint` event first (required by legacy SSE transport),
    // then keep the stream alive for any future server-initiated events.
    let initial = stream::once(async move {
        Ok(Event::default().event("endpoint").data(post_url))
    });
    let tail = stream::pending();
    Sse::new(initial.chain(tail)).keep_alive(KeepAlive::default())
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

async fn handle_optimize_mcp_sse(
    req: axum::extract::Request,
) -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let host = req.headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1");
    let post_url = format!("http://{}/mcp/optimize", host);
    let initial = stream::once(async move {
        Ok(Event::default().event("endpoint").data(post_url))
    });
    Sse::new(initial.chain(stream::pending())).keep_alive(KeepAlive::default())
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
