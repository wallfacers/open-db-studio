use crate::datasource::{ConnectionConfig, DbStats, DriverCapabilities, QueryResult, SchemaInfo, TableMeta};
use crate::db::models::{Connection, CreateConnectionRequest, QueryHistory};
use crate::llm::{ChatContext, ChatMessage, AgentMessage, ToolDefinition};
use crate::{AppError, AppResult};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

// ============ 连接管理 ============

#[tauri::command]
pub async fn list_connections() -> AppResult<Vec<Connection>> {
    crate::db::list_connections()
}

#[tauri::command]
pub async fn create_connection(req: CreateConnectionRequest) -> AppResult<Connection> {
    crate::db::create_connection(&req)
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> AppResult<bool> {
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.test_connection().await?;
    Ok(true)
}

#[tauri::command]
pub async fn delete_connection(id: i64) -> AppResult<()> {
    invalidate_all_caches(id).await;
    crate::db::delete_connection(id)
}

#[tauri::command]
pub async fn update_connection(id: i64, req: crate::db::UpdateConnectionRequest) -> AppResult<crate::db::models::Connection> {
    invalidate_all_caches(id).await;
    crate::db::update_connection(id, &req)
}

async fn invalidate_all_caches(connection_id: i64) {
    crate::datasource::pool_cache::invalidate(connection_id).await;
    crate::llm::inline_complete::invalidate_meta_cache(connection_id).await;
    crate::llm::inline_complete::invalidate_timeout_tracker(connection_id).await;
}

/// 返回指定连接的明文密码（仅供编辑弹窗"小眼睛"功能使用）
#[tauri::command]
pub async fn get_connection_password(id: i64) -> AppResult<String> {
    crate::db::get_connection_password(id)
}

/// 返回指定连接的明文 Token（仅供编辑弹窗"小眼睛"功能使用）
#[tauri::command]
pub async fn get_connection_token(id: i64) -> AppResult<String> {
    crate::db::get_connection_token(id)
}

// ============ 查询执行 ============

#[tauri::command]
pub async fn execute_query(
    connection_id: i64,
    sql: String,
    database: Option<String>,
    schema: Option<String>,
) -> AppResult<QueryResult> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::pool_cache::get_or_create(
        connection_id,
        &config,
        database.as_deref().unwrap_or(""),
        schema.as_deref().unwrap_or(""),
    ).await?;

    let result = ds.execute(&sql).await;

    // 无论成功失败，都记录历史
    match &result {
        Ok(qr) => {
            let _ = crate::db::save_query_history(
                connection_id,
                &sql,
                qr.duration_ms as i64,
                Some(qr.row_count as i64),
                None,
            );
        }
        Err(e) => {
            let _ = crate::db::save_query_history(
                connection_id,
                &sql,
                0,
                None,
                Some(&e.to_string()),
            );
        }
    }

    // Auto-trigger schema graph refresh on DDL changes
    if result.is_ok() {
        let sql_upper = sql.trim().to_uppercase();
        if sql_upper.starts_with("CREATE")
            || sql_upper.starts_with("ALTER")
            || sql_upper.starts_with("DROP")
        {
            let conn_id = connection_id;
            let db = database.clone();
            tokio::spawn(async move {
                let _ = crate::graph::refresh_schema_graph(conn_id, db).await;
            });
        }
    }

    result
}

#[tauri::command]
pub async fn get_tables(connection_id: i64) -> AppResult<Vec<TableMeta>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_tables().await
}

#[tauri::command]
pub async fn get_schema(connection_id: i64) -> AppResult<SchemaInfo> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_schema().await
}

// ============ AI 代理 ============

fn parse_api_type(s: &str) -> crate::llm::ApiType {
    match s {
        "anthropic" => crate::llm::ApiType::Anthropic,
        _ => crate::llm::ApiType::Openai,
    }
}

/// 解析 LlmConfig 的有效 base_url：DB 有值就用 DB，否则从 opencode.json 读。
fn resolve_base_url(config: &crate::db::models::LlmConfig) -> String {
    if !config.base_url.is_empty() {
        return config.base_url.clone();
    }
    if !config.opencode_provider_id.is_empty() {
        if let Some(url) = crate::agent::config::resolve_opencode_base_url(&config.opencode_provider_id) {
            return url;
        }
    }
    String::new()
}

fn build_llm_client() -> AppResult<crate::llm::client::LlmClient> {
    let config = crate::db::get_default_llm_config()?
        .ok_or_else(|| crate::AppError::Other(
            "No AI model configured. Please add one in Settings → AI Model.".into()
        ))?;
    let api_type = parse_api_type(&config.api_type);
    let base_url = resolve_base_url(&config);
    Ok(crate::llm::client::LlmClient::new(
        config.api_key,
        Some(base_url),
        Some(config.model),
        Some(api_type),
    ))
}

#[tauri::command]
pub async fn ai_chat(message: String, context: ChatContext) -> AppResult<String> {
    let client = build_llm_client()?;
    let system_prompt = include_str!("../../prompts/chat_assistant.txt");
    let mut messages = vec![ChatMessage { role: "system".into(), content: system_prompt.to_string() }];
    messages.extend(context.history.clone());
    messages.push(ChatMessage { role: "user".into(), content: message });
    client.chat(messages).await
}

#[tauri::command]
pub async fn ai_chat_stream(
    message: String,
    context: ChatContext,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
) -> AppResult<()> {
    let client = build_llm_client()?;
    let system_prompt = include_str!("../../prompts/chat_assistant.txt");
    let mut messages = vec![ChatMessage { role: "system".into(), content: system_prompt.to_string() }];
    messages.extend(context.history.clone());
    messages.push(ChatMessage { role: "user".into(), content: message });
    client.chat_stream(messages, &channel).await
}

#[tauri::command]
pub async fn ai_generate_sql(prompt: String, connection_id: Option<i64>) -> AppResult<String> {
    let client = build_llm_client()?;

    let (schema_context, driver) = match connection_id {
        Some(id) if id > 0 => {
            let config = crate::db::get_connection_config(id)?;
            let ds = crate::datasource::create_datasource(&config).await?;
            let schema = ds.get_schema().await?;
            let ctx = schema.tables.iter()
                .map(|t| format!("Table: {}", t.name))
                .collect::<Vec<_>>()
                .join("\n");
            (ctx, config.driver)
        }
        _ => {
            // 无连接时，使用空 schema 上下文和默认 driver
            ("".to_string(), "mysql".to_string())
        }
    };

    client.generate_sql(&prompt, &schema_context, &driver).await
}

#[tauri::command]
pub async fn ai_explain_sql(sql: String, connection_id: Option<i64>) -> AppResult<String> {
    let client = build_llm_client()?;
    let driver = match connection_id {
        Some(id) if id > 0 => {
            let config = crate::db::get_connection_config(id)?;
            config.driver
        }
        _ => "mysql".to_string(), // 默认使用 mysql 方言
    };
    client.explain_sql(&sql, &driver).await
}

// ============ LLM 配置管理 ============

#[tauri::command]
pub async fn list_llm_configs() -> AppResult<Vec<crate::db::models::LlmConfig>> {
    let configs = crate::db::list_llm_configs()?;
    // api_key 仅在 Rust 内部使用，永不暴露到前端
    Ok(configs.into_iter().map(|mut c| { c.api_key = String::new(); c }).collect())
}

/// 返回指定 LLM 配置的明文 API Key（仅供编辑弹窗"小眼睛"功能使用）
#[tauri::command]
pub async fn get_llm_config_key(id: i64) -> AppResult<String> {
    crate::db::get_llm_config_by_id(id)?
        .map(|c| c.api_key)
        .ok_or_else(|| crate::AppError::Other(format!("LlmConfig {} not found", id)))
}

#[tauri::command]
pub async fn create_llm_config(
    state: tauri::State<'_, crate::AppState>,
    input: crate::db::models::CreateLlmConfigInput,
) -> AppResult<crate::db::models::LlmConfig> {
    let mut config = crate::db::create_llm_config(&input)?;
    sync_on_config_save(&config, &state).await;
    config.api_key = String::new();
    Ok(config)
}

#[tauri::command]
pub async fn update_llm_config(
    state: tauri::State<'_, crate::AppState>,
    id: i64,
    input: crate::db::models::UpdateLlmConfigInput,
) -> AppResult<crate::db::models::LlmConfig> {
    let mut config = crate::db::update_llm_config(id, &input)?;
    sync_on_config_save(&config, &state).await;
    config.api_key = String::new();
    Ok(config)
}

#[tauri::command]
pub async fn delete_llm_config(
    id: i64,
) -> AppResult<()> {
    crate::db::delete_llm_config(id)?;
    Ok(())
}

#[tauri::command]
pub async fn set_default_llm_config(
    id: i64,
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::db::set_default_llm_config(id)?;
    Ok(())
}


#[tauri::command]
pub async fn get_default_llm_config() -> AppResult<Option<crate::db::models::LlmConfig>> {
    let config = crate::db::get_default_llm_config()?;
    Ok(config.map(|mut c| { c.api_key = String::new(); c }))
}

#[tauri::command]
pub async fn set_llm_config_test_status(id: i64, status: String, error: Option<String>) -> AppResult<()> {
    crate::db::update_llm_config_test_status(id, &status, error.as_deref())
}

#[tauri::command]
pub async fn test_llm_config(
    id: i64,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::db::update_llm_config_test_status(id, "testing", None)?;
    let config = crate::db::get_llm_config_by_id(id)?
        .ok_or_else(|| crate::AppError::Other(format!("LlmConfig {} not found", id)))?;

    let result = if config.config_mode != "custom" {
        // opencode 模式：走 opencode serve sidecar 测试（与 Agent 对话同一链路）
        test_via_serve(
            state.serve_port,
            &config.model,
            &config.opencode_provider_id,
        ).await
    } else {
        // custom 模式：直连 LLM API
        let api_type = parse_api_type(&config.api_type);
        let base_url = resolve_base_url(&config);
        let client = crate::llm::client::LlmClient::new(
            config.api_key,
            Some(base_url),
            Some(config.model),
            Some(api_type),
        );
        let messages = vec![crate::llm::ChatMessage {
            role: "user".into(),
            content: "hi".into(),
        }];
        client.chat(messages).await.map(|_| ())
    };

    match result {
        Ok(()) => {
            crate::db::update_llm_config_test_status(id, "success", None)?;
        }
        Err(e) => {
            let err_msg = e.to_string();
            crate::db::update_llm_config_test_status(id, "fail", Some(&err_msg))?;
            return Err(e);
        }
    }
    Ok(())
}

/// 通过 opencode serve 测试连接：创建临时 session → 发 "hi" → 检查回复 → 清理。
async fn test_via_serve(
    port: u16,
    model_id: &str,
    provider_id: &str,
) -> AppResult<()> {
    let session_id = crate::agent::client::create_session(port, Some("__connection_test__"))
        .await
        .map_err(|e| crate::AppError::Other(format!(
            "opencode serve not available (is it running?): {}", e
        )))?;

    let result = crate::agent::stream::collect_text_via_global_events(
        port,
        &session_id,
        "hi",
        Some(model_id),
        Some(provider_id),
    ).await;

    // 清理临时 session（无论成功失败）
    cleanup_temp_sql_session(port, &session_id).await;

    match result {
        Ok(text) if text.trim().is_empty() => {
            Err(crate::AppError::Other("Model returned empty response".into()))
        }
        Ok(_) => Ok(()),
        Err(e) => Err(e),
    }
}

// ============ 历史 & 收藏 ============

#[tauri::command]
pub async fn get_query_history(connection_id: i64) -> AppResult<Vec<QueryHistory>> {
    crate::db::list_query_history(connection_id)
}

// ============ DB 管理 ============

#[tauri::command]
pub async fn get_table_detail(connection_id: i64, database: Option<String>, schema: Option<String>, table: String) -> AppResult<crate::datasource::TableDetail> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let schema_ref = schema.as_deref().filter(|s| !s.is_empty());
    let columns = ds.get_columns(&table, schema_ref).await?;
    let indexes = ds.get_indexes(&table, schema_ref).await?;
    let foreign_keys = ds.get_foreign_keys(&table, schema_ref).await?;
    Ok(crate::datasource::TableDetail { name: table, columns, indexes, foreign_keys })
}

#[tauri::command]
pub async fn get_full_schema(connection_id: i64) -> AppResult<crate::datasource::FullSchemaInfo> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.get_full_schema().await
}

#[tauri::command]
pub async fn get_table_ddl(connection_id: i64, table: String, database: Option<String>, schema: Option<String>) -> AppResult<String> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let schema_ref = schema.as_deref().filter(|s| !s.is_empty());
    ds.get_table_ddl_for_display(&table, schema_ref).await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableDataParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub table: String,
    pub schema: Option<String>,
    pub page: u32,
    pub page_size: u32,
    pub where_clause: Option<String>,
    pub order_clause: Option<String>,
    // 新增字段
    pub filter_column: Option<String>,
    pub filter_operator: Option<String>,
    pub filter_value: Option<String>,
    pub filter_data_type: Option<String>,
    pub sort_column: Option<String>,
    pub sort_direction: Option<String>,
}

/// 根据字段类型决定是否给值加单引号
/// 字符串/日期/时间戳类型加引号，数值/布尔类型不加引号，未知类型保守加引号
/// 安全兜底：即使 data_type 标记为数值类型，若值本身不像数字，仍加引号，
/// 防止因前端传入 data_type 不准确时生成残缺 SQL（如 WHERE col = wechat）
fn quote_filter_value(value: &str, data_type: &str) -> String {
    let dt = data_type.to_lowercase();
    // 判断值本身是否看起来像数字（整数或浮点数），用于兜底保护
    let looks_numeric = value.trim().parse::<f64>().is_ok();

    let needs_quote = if dt.contains("int") || dt.contains("float") || dt.contains("double")
        || dt.contains("decimal") || dt.contains("numeric") || dt.contains("real")
        || dt.contains("bool") || dt.contains("bit")
    {
        // 数值/布尔类型：仅当值确实是数字时才不加引号，否则兜底加引号
        !looks_numeric
    } else {
        // varchar, char, text, date, datetime, time, timestamp, string, unknown → 加引号
        true
    };

    if needs_quote {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quote_string_types() {
        assert_eq!(quote_filter_value("张三", "varchar"), "'张三'");
        assert_eq!(quote_filter_value("hello", "TEXT"), "'hello'");
        assert_eq!(quote_filter_value("it's", "char"), "'it''s'");
    }

    #[test]
    fn test_no_quote_numeric_types() {
        assert_eq!(quote_filter_value("42", "int"), "42");
        assert_eq!(quote_filter_value("3.14", "float"), "3.14");
        assert_eq!(quote_filter_value("100", "bigint"), "100");
        assert_eq!(quote_filter_value("9.9", "decimal"), "9.9");
    }

    #[test]
    fn test_quote_timestamp() {
        // timestamp 类型应加引号（UI 中通常输入 datetime 字符串）
        assert_eq!(quote_filter_value("2024-01-01 12:00:00", "timestamp"), "'2024-01-01 12:00:00'");
        // 纯数字的 Unix 时间戳：虽是 timestamp 类型，也加引号（保守策略）
        assert_eq!(quote_filter_value("1711123456", "timestamp"), "'1711123456'");
    }

    #[test]
    fn test_string_value_with_numeric_type_gets_quoted() {
        // 兜底保护：当 data_type 声明为数值但值本身不是数字时，仍应加引号
        // 防止因前端传入 data_type 不准确时生成 `col = wechat` 这样的残缺 SQL
        assert_eq!(quote_filter_value("wechat", "int"), "'wechat'");
        assert_eq!(quote_filter_value("active", "tinyint"), "'active'");
        assert_eq!(quote_filter_value("abc", "bigint"), "'abc'");
    }

    #[test]
    fn test_quote_date_types() {
        assert_eq!(quote_filter_value("2024-01-01", "date"), "'2024-01-01'");
        assert_eq!(quote_filter_value("2024-01-01 12:00:00", "datetime"), "'2024-01-01 12:00:00'");
        assert_eq!(quote_filter_value("12:00:00", "time"), "'12:00:00'");
    }

    #[test]
    fn test_unknown_type_defaults_to_quote() {
        assert_eq!(quote_filter_value("abc", "unknown_type"), "'abc'");
        assert_eq!(quote_filter_value("abc", ""), "'abc'");
    }
}

/// 将结构化过滤条件转为 SQL 片段（不含 WHERE 关键字）
/// 返回 None 表示无有效过滤条件（column 为空）
fn build_filter_part(
    column: &str,
    operator: &str,
    value: Option<&str>,
    data_type: &str,
    driver: &str,
) -> Option<String> {
    if column.trim().is_empty() {
        return None;
    }

    let col_escaped = if driver == "mysql" {
        format!("`{}`", column.replace('`', "``"))
    } else {
        format!("\"{}\"", column.replace('"', "\"\""))
    };

    let op_upper = operator.trim().to_uppercase();
    let fragment = match op_upper.as_str() {
        "IS NULL" => format!("{} IS NULL", col_escaped),
        "IS NOT NULL" => format!("{} IS NOT NULL", col_escaped),
        _ => {
            let raw_value = value.unwrap_or("");
            // 值为空时跳过，避免生成 `col = ` 这样的残缺 SQL（数值类型不加引号时尤其危险）
            if raw_value.is_empty() {
                return None;
            }
            let quoted = quote_filter_value(raw_value, data_type);
            format!("{} {} {}", col_escaped, op_upper, quoted)
        }
    };

    Some(fragment)
}

/// 合并结构化 filter_part 和手动 where_clause 文本，用 AND 连接
fn merge_where(filter_part: Option<String>, where_clause: Option<&str>) -> String {
    let where_text = where_clause.filter(|s| !s.trim().is_empty());
    match (filter_part, where_text) {
        (Some(fp), Some(wt)) => format!("{} AND ({})", fp, wt),
        (Some(fp), None) => fp,
        (None, Some(wt)) => wt.to_string(),
        (None, None) => String::new(),
    }
}

/// 合并列头排序和手动 order_clause 文本
/// 列头排序在前，手动文本追加在后
fn merge_order(
    sort_column: Option<&str>,
    sort_direction: Option<&str>,
    order_clause: Option<&str>,
    driver: &str,
) -> Result<String, String> {
    let sort_part = match (sort_column, sort_direction) {
        (Some(col), Some(dir)) if !col.trim().is_empty() => {
            let dir_upper = dir.trim().to_uppercase();
            if dir_upper != "ASC" && dir_upper != "DESC" {
                return Err(format!("Invalid sort direction: {}", dir));
            }
            let col_escaped = if driver == "mysql" {
                format!("`{}`", col.replace('`', "``"))
            } else {
                format!("\"{}\"", col.replace('"', "\"\""))
            };
            Some(format!("{} {}", col_escaped, dir_upper))
        }
        _ => None,
    };

    let order_text = order_clause.filter(|s| !s.trim().is_empty());
    let result = match (sort_part, order_text) {
        (Some(sp), Some(ot)) => format!("{}, {}", sp, ot),
        (Some(sp), None) => sp,
        (None, Some(ot)) => ot.to_string(),
        (None, None) => String::new(),
    };
    Ok(result)
}

/// 构建带 schema 前缀的表名（PG/Oracle 用）
fn qualified_table_pg(schema: Option<&str>, table: &str) -> String {
    match schema.filter(|s| !s.is_empty()) {
        Some(s) => format!("\"{}\".\"{}\"", s.replace('"', "\"\""), table.replace('"', "\"\"")),
        None => format!("\"{}\"", table.replace('"', "\"\"")),
    }
}

fn qualified_table_mysql(table: &str) -> String {
    format!("`{}`", table.replace('`', "``"))
}

fn qualified_table(driver: &str, schema: Option<&str>, table: &str) -> String {
    if driver == "mysql" {
        qualified_table_mysql(table)
    } else {
        qualified_table_pg(schema, table)
    }
}

/// get_table_data 的响应体，包含分页数据和总行数
#[derive(Debug, serde::Serialize)]
pub struct TableDataResponse {
    pub data: crate::datasource::QueryResult,
    pub total_rows: i64,
}

#[tauri::command]
pub async fn get_table_data(params: TableDataParams) -> AppResult<TableDataResponse> {
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };

    // 限制最大页面大小，防止大量数据查询耗尽内存
    if params.page_size > 10_000 {
        return Err(crate::AppError::Other(
            format!("page_size exceeds maximum allowed value (10000), got {}", params.page_size)
        ));
    }

    let offset = params.page.saturating_sub(1) * params.page_size;

    // 构建结构化 filter 片段
    let filter_part = params.filter_column.as_deref()
        .filter(|s| !s.trim().is_empty())
        .and_then(|col| build_filter_part(
            col,
            params.filter_operator.as_deref().unwrap_or("="),
            params.filter_value.as_deref(),
            params.filter_data_type.as_deref().unwrap_or(""),
            &config.driver,
        ));

    // 合并 WHERE
    // 安全说明：where_clause 是前端传入的自由文本，直接嵌入 SQL。
    // 这是设计决策：本应用为本地桌面工具，Tauri IPC 仅限本机访问，信任边界为本地用户。
    // 在实现网络化部署时必须改用参数绑定或 AST 白名单。
    let merged_where = merge_where(filter_part, params.where_clause.as_deref());
    let where_part = if merged_where.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", merged_where)
    };

    // 合并 ORDER BY
    let merged_order = merge_order(
        params.sort_column.as_deref(),
        params.sort_direction.as_deref(),
        params.order_clause.as_deref(),
        &config.driver,
    ).map_err(|e| crate::AppError::Other(e))?;
    let order_part = if merged_order.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", merged_order)
    };

    let tbl = qualified_table(&config.driver, params.schema.as_deref(), &params.table);

    // COUNT 查询：与数据查询共用同一 WHERE 条件，不含 ORDER BY / LIMIT
    let count_sql = format!("SELECT COUNT(*) FROM {}{}", tbl, where_part);
    let total_rows: i64 = ds.execute(&count_sql).await
        .ok()
        .and_then(|r| r.rows.into_iter().next())
        .and_then(|row| row.into_iter().next())
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_u64().map(|n| n as i64))
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0);

    let sql = format!("SELECT * FROM {}{}{} LIMIT {} OFFSET {}", tbl, where_part, order_part, params.page_size, offset);
    let data = ds.execute(&sql).await?;

    Ok(TableDataResponse { data, total_rows })
}

#[tauri::command]
pub async fn update_row(
    connection_id: i64,
    database: Option<String>,
    table: String,
    schema: Option<String>,
    pk_column: String,
    pk_value: String,
    column: String,
    new_value: String,
) -> AppResult<()> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let tbl = qualified_table(&config.driver, schema.as_deref(), &table);
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "UPDATE {} SET `{}` = '{}' WHERE `{}` = '{}'",
            tbl,
            column.replace('`', "``"),
            new_value.replace('\'', "\\'"),
            pk_column.replace('`', "``"),
            pk_value.replace('\'', "\\'")
        ),
        _ => format!(
            "UPDATE {} SET \"{}\" = '{}' WHERE \"{}\" = '{}'",
            tbl,
            column.replace('"', "\"\""),
            new_value.replace('\'', "''"),
            pk_column.replace('"', "\"\""),
            pk_value.replace('\'', "''")
        ),
    };
    let result = ds.execute(&sql).await?;
    if result.row_count == 0 {
        return Err(crate::AppError::Other(
            format!("No rows updated: pk_column='{}', pk_value='{}' not found in table '{}'", pk_column, pk_value, table)
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_row(
    connection_id: i64,
    database: Option<String>,
    table: String,
    schema: Option<String>,
    pk_column: String,
    pk_value: String,
) -> AppResult<()> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let tbl = qualified_table(&config.driver, schema.as_deref(), &table);
    let sql = match config.driver.as_str() {
        "mysql" => format!(
            "DELETE FROM {} WHERE `{}` = '{}'",
            tbl,
            pk_column.replace('`', "``"),
            pk_value.replace('\'', "\\'")
        ),
        _ => format!(
            "DELETE FROM {} WHERE \"{}\" = '{}'",
            tbl,
            pk_column.replace('"', "\"\""),
            pk_value.replace('\'', "''")
        ),
    };
    let result = ds.execute(&sql).await?;
    if result.row_count == 0 {
        return Err(crate::AppError::Other(
            format!("No rows deleted: pk_column='{}', pk_value='{}' not found in table '{}'", pk_column, pk_value, table)
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn insert_row(
    connection_id: i64,
    database: Option<String>,
    table: String,
    schema: Option<String>,
    columns: Vec<String>,
    values: Vec<Option<String>>,
) -> AppResult<()> {
    if columns.is_empty() {
        return Err(crate::AppError::Other("columns must not be empty".to_string()));
    }
    if columns.len() != values.len() {
        return Err(crate::AppError::Other(
            format!("columns({}) and values({}) length mismatch", columns.len(), values.len())
        ));
    }
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let tbl = qualified_table(&config.driver, schema.as_deref(), &table);
    let (col_list, val_list): (Vec<String>, Vec<String>) = columns
        .iter()
        .zip(values.iter())
        .map(|(col, val)| {
            let quoted_col = match config.driver.as_str() {
                "mysql" => format!("`{}`", col.replace('`', "``")),
                _ => format!("\"{}\"", col.replace('"', "\"\"")),
            };
            let quoted_val = match val {
                None => "NULL".to_string(),
                Some(v) => match config.driver.as_str() {
                    "mysql" => format!("'{}'", v.replace('\'', "\\'")),
                    _ => format!("'{}'", v.replace('\'', "''")),
                },
            };
            (quoted_col, quoted_val)
        })
        .unzip();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        tbl,
        col_list.join(", "),
        val_list.join(", ")
    );
    let result = ds.execute(&sql).await?;
    if result.row_count == 0 {
        return Err(crate::AppError::Other(
            format!("Insert into table '{}' affected 0 rows", table)
        ));
    }
    Ok(())
}

// ============ 数据导出 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub table: String,
    pub schema: Option<String>,
    pub format: String, // "csv" | "json" | "sql"
    pub where_clause: Option<String>,
    pub output_path: String,
    #[serde(default = "default_true")]
    pub include_header: bool,
    #[serde(default)]
    pub include_ddl: bool,
}

fn default_true() -> bool { true }

#[tauri::command]
pub async fn export_table_data(params: ExportParams) -> AppResult<String> {
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };

    let where_part = params.where_clause
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(" WHERE {}", s))
        .unwrap_or_default();

    let tbl = qualified_table(&config.driver, params.schema.as_deref(), &params.table);
    let sql = format!("SELECT * FROM {}{}", tbl, where_part);

    let result = ds.execute(&sql).await?;

    let quote_csv_field = |s: &str| -> String {
        if s.contains('"') || s.contains(',') || s.contains('\n') || s.contains('\r') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    };

    let content = match params.format.as_str() {
        "json" => serde_json::to_string_pretty(&result.rows)
            .map_err(|e| crate::AppError::Other(e.to_string()))?,
        "csv" => {
            let mut out = String::new();
            if params.include_header {
                out += &(result.columns.iter().map(|c| quote_csv_field(c)).collect::<Vec<_>>().join(",") + "\n");
            }
            for row in &result.rows {
                let line: Vec<String> = row.iter().map(|v| match v {
                    serde_json::Value::Null => String::new(),
                    serde_json::Value::String(s) => quote_csv_field(s),
                    other => other.to_string(),
                }).collect();
                out += &(line.join(",") + "\n");
            }
            out
        }
        "sql" => {
            let quoted_table = match config.driver.as_str() {
                "mysql" => format!("`{}`", params.table.replace('`', "``")),
                _ => format!("\"{}\"", params.table.replace('"', "\"\"")),
            };
            let col_list = result.columns.iter().map(|c| {
                match config.driver.as_str() {
                    "mysql" => format!("`{}`", c.replace('`', "``")),
                    _ => format!("\"{}\"", c.replace('"', "\"\"")),
                }
            }).collect::<Vec<_>>().join(", ");

            let mut out = String::new();

            // 包含 DDL：先写建表语句
            if params.include_ddl {
                match ds.get_table_ddl_for_display(&params.table, None).await {
                    Ok(ddl) => {
                        out += &format!("-- Table structure for `{}`\n", params.table);
                        out += "DROP TABLE IF EXISTS ";
                        out += &quoted_table;
                        out += ";\n";
                        out += &ddl;
                        out += ";\n\n";
                    }
                    Err(e) => {
                        out += &format!("-- Could not retrieve DDL: {}\n\n", e);
                    }
                }
            }

            out += &format!("-- Data for `{}`\n", params.table);
            for row in &result.rows {
                let values: Vec<String> = row.iter().map(|v| match v {
                    serde_json::Value::Null => "NULL".into(),
                    serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => if *b { "1".into() } else { "0".into() },
                    other => format!("'{}'", other.to_string().replace('\'', "''")),
                }).collect();
                out += &format!("INSERT INTO {} ({}) VALUES ({});\n", quoted_table, col_list, values.join(", "));
            }
            out
        }
        _ => return Err(crate::AppError::Other(format!("Unsupported format: {}", params.format))),
    };

    tokio::fs::write(&params.output_path, &content).await
        .map_err(|e| crate::AppError::Other(format!("Failed to write file: {}", e)))?;

    Ok(params.output_path)
}

// ============ 连接分组管理 ============

#[tauri::command]
pub async fn list_groups() -> AppResult<Vec<crate::db::models::ConnectionGroup>> {
    crate::db::list_groups()
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CreateGroupRequest {
    pub name: String,
    pub color: Option<String>,
}

#[tauri::command]
pub async fn create_group(req: CreateGroupRequest) -> AppResult<crate::db::models::ConnectionGroup> {
    crate::db::create_group(&req.name, req.color.as_deref())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct UpdateGroupRequest {
    pub name: String,
    pub color: Option<String>,
}

#[tauri::command]
pub async fn update_group(id: i64, req: UpdateGroupRequest) -> AppResult<crate::db::models::ConnectionGroup> {
    crate::db::update_group(id, &req.name, req.color.as_deref())
}

#[tauri::command]
pub async fn delete_group(id: i64) -> AppResult<()> {
    crate::db::delete_group(id)
}

#[tauri::command]
pub async fn move_connection_to_group(connection_id: i64, group_id: Option<i64>) -> AppResult<()> {
    crate::db::move_connection_to_group(connection_id, group_id)
}

#[tauri::command]
pub async fn reorder_connections(items: Vec<crate::db::models::ReorderItem>) -> AppResult<()> {
    crate::db::reorder_connections(&items)
}

#[tauri::command]
pub async fn reorder_groups(items: Vec<crate::db::models::ReorderItem>) -> AppResult<()> {
    crate::db::reorder_groups(&items)
}

// ============ AI 高级命令 ============

/// SQL 解释（旧 ACP 版本）：已迁移到 agent_explain_sql，此桩函数保留兼容性。
#[tauri::command]
pub async fn ai_explain_sql_acp(
    _sql: String,
    _connection_id: Option<i64>,
    _database: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let _ = channel.send(crate::llm::StreamEvent::Error {
        message: "ACP mode is deprecated. Please use serve mode (agent_explain_sql).".into(),
    });
    let _ = channel.send(crate::llm::StreamEvent::Done);
    Ok(())
}

/// 取消 SQL 解释 ACP session（旧版，已废弃）
#[tauri::command]
pub async fn cancel_explain_acp_session(
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    Ok(())
}

#[tauri::command]
pub async fn ai_create_table(description: String, connection_id: Option<i64>) -> AppResult<String> {
    let client = build_llm_client()?;
    let driver = match connection_id {
        Some(id) if id > 0 => {
            let config = crate::db::get_connection_config(id)?;
            config.driver
        }
        _ => "mysql".to_string(),
    };
    client.create_table_ddl(&description, &driver).await
}

#[tauri::command]
pub async fn ai_generate_table_schema(
    description: String,
    connection_id: i64,
) -> AppResult<crate::llm::client::TableSchemaResult> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    let driver = &config.driver;

    let result = client.generate_table_schema(&description, driver).await?;

    // 校验返回的 column_type 是否在合法枚举内（仅记录警告，不阻断）
    let valid_types: &[&str] = match driver.as_str() {
        "postgres" | "postgresql" => &[
            "INTEGER", "BIGINT", "SMALLINT", "VARCHAR", "TEXT", "TIMESTAMP",
            "DATE", "NUMERIC", "BOOLEAN", "BYTEA", "UUID", "JSONB", "SERIAL",
        ],
        _ => &[
            "INT", "BIGINT", "TINYINT", "SMALLINT", "VARCHAR", "TEXT", "LONGTEXT",
            "DATETIME", "DATE", "TIMESTAMP", "DECIMAL", "FLOAT", "DOUBLE", "BOOLEAN", "BLOB",
        ],
    };
    for col in &result.columns {
        if !valid_types.iter().any(|t| t.eq_ignore_ascii_case(&col.column_type)) {
            log::warn!(
                "[ai_generate_table_schema] column '{}' has non-standard type '{}', keeping as-is",
                col.name,
                col.column_type
            );
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn ai_diagnose_error(sql: String, error_msg: String, connection_id: Option<i64>) -> AppResult<String> {
    let client = build_llm_client()?;

    let (schema_context, driver) = match connection_id {
        Some(id) if id > 0 => {
            let config = crate::db::get_connection_config(id)?;
            let ds = crate::datasource::create_datasource(&config).await?;
            let schema = ds.get_schema().await?;
            let ctx = schema.tables.iter()
                .map(|t| format!("Table: {}", t.name))
                .collect::<Vec<_>>().join("\n");
            (ctx, config.driver)
        }
        _ => ("".to_string(), "mysql".to_string()),
    };

    client.diagnose_error(&sql, &error_msg, &schema_context, &driver).await
}

// ============ AI 内联补全 ============

#[tauri::command]
pub async fn ai_inline_complete(
    connection_id: i64,
    sql_before: String,
    sql_after: String,
    mentioned_tables: Vec<String>,
    current_schema: String,
    hint: String,
    database: Option<String>,
) -> Result<String, String> {
    use crate::llm::inline_complete;

    // 1. Check request deduplication — return cached result immediately (no slot needed)
    if let Some(cached) = inline_complete::check_duplicate_request(connection_id, &sql_before, &mentioned_tables).await {
        log::debug!("[ai_inline_complete] duplicate request, returning cached result (len={})", cached.len());
        return Ok(cached);
    }

    // 2. Check concurrency — only 1 in-flight request per connection
    if !inline_complete::acquire_slot(connection_id).await {
        return Ok(String::new());
    }

    let result = async {
        // 3. Check TimeoutTracker
        if inline_complete::should_skip(connection_id).await {
            log::debug!("[ai_inline_complete] skip: timeout backoff active for connection {}", connection_id);
            return Ok(String::new());
        }

        // 4. Get best LLM config (prefer tested+default, then any tested)
        let config = match crate::db::get_best_llm_config()
            .map_err(|e| e.to_string())?
        {
            Some(c) => c,
            None => {
                log::warn!("[ai_inline_complete] skip: no LLM config with test_status='success'");
                return Ok(String::new());
            }
        };

        // 5. Get dialect from connection config
        let conn_config = crate::db::get_connection_config(connection_id)
            .map_err(|e| e.to_string())?;
        let dialect = conn_config.driver.clone();

        // 6. Get DataSource for context assembly
        let ds = crate::datasource::pool_cache::get_or_create(
            connection_id,
            &conn_config,
            database.as_deref().unwrap_or(""),
            "",
        ).await.map_err(|e| e.to_string())?;

        // 7. Build layered context
        let ctx_t0 = std::time::Instant::now();
        let schema_context = inline_complete::build_layered_context(
            ds.as_ref(),
            &mentioned_tables,
            &current_schema,
            connection_id,
        ).await;
        log::debug!("[ai_inline_complete] context built in {:?}, len={}", ctx_t0.elapsed(), schema_context.len());

        // 8. Assemble prompt from template
        let mode_instruction = match hint.as_str() {
            "single_line" => "Complete the current line only. Do not add newlines.",
            _ => "Complete the full SQL statement from the cursor position. Use newlines for readability.",
        };

        let sql_before_trimmed = if sql_before.len() > 200 {
            let mut start = sql_before.len() - 200;
            while !sql_before.is_char_boundary(start) { start += 1; }
            &sql_before[start..]
        } else {
            &sql_before
        };
        let sql_after_trimmed = if sql_after.len() > 100 {
            let mut end = 100;
            while !sql_after.is_char_boundary(end) { end -= 1; }
            &sql_after[..end]
        } else {
            &sql_after
        };

        // Fast-path: statement already complete, skip LLM call
        if sql_before_trimmed.trim_end().ends_with(';') && sql_after_trimmed.trim().is_empty() {
            return Ok(String::new());
        }

        let prompt = include_str!("../../prompts/sql_inline_complete.txt")
            .replace("{{DIALECT}}", &dialect)
            .replace("{{MODE_INSTRUCTION}}", mode_instruction)
            .replace("{{SCHEMA_CONTEXT}}", &schema_context)
            .replace("{{SQL_BEFORE}}", sql_before_trimmed)
            .replace("{{SQL_AFTER}}", sql_after_trimmed);

        // 9. Create LLM client and call with 20s timeout
        let api_type = parse_api_type(&config.api_type);
        let base_url = resolve_base_url(&config);
        let client = crate::llm::client::LlmClient::new(
            config.api_key,
            Some(base_url),
            Some(config.model),
            Some(api_type),
        );

        match tokio::time::timeout(
            std::time::Duration::from_secs(20),
            client.inline_complete(prompt, &hint),
        ).await {
            Ok(Ok(raw)) => {
                inline_complete::record_success(connection_id).await;
                let processed = inline_complete::postprocess_completion(&raw, &sql_before);
                log::debug!("[ai_inline_complete] raw_len={} processed_len={} processed={:?}",
                    raw.len(), processed.len(), &processed[..processed.len().min(100)]);
                inline_complete::update_last_request(connection_id, sql_before.clone(), mentioned_tables.clone(), processed.clone()).await;
                Ok(processed)
            }
            Ok(Err(e)) => {
                log::warn!("[ai_inline_complete] LLM error: {}", e);
                inline_complete::record_timeout(connection_id).await;
                Ok(String::new())
            }
            Err(_) => {
                log::warn!("[ai_inline_complete] Request timed out (20s)");
                inline_complete::record_timeout(connection_id).await;
                Ok(String::new())
            }
        }
    }.await;

    // Always release the slot
    inline_complete::release_slot(connection_id).await;

    result
}

#[tauri::command]
pub async fn refresh_schema_graph(
    connection_id: i64,
    database: Option<String>,
) -> Result<(), String> {
    crate::graph::refresh_schema_graph(connection_id, database)
        .await
        .map_err(|e| e.to_string())
}

// ============ 导航树查询命令 ============

#[tauri::command]
pub async fn list_databases(connection_id: i64) -> AppResult<Vec<String>> {
    // 若用户在连接配置中显式指定了数据库名，直接返回该单一数据库
    if let Some(db) = crate::db::get_configured_database(connection_id)? {
        return Ok(vec![db]);
    }
    let config = crate::db::get_connection_config(connection_id)?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let ds = crate::datasource::pool_cache::get_or_create(connection_id, &config, "", "").await?;
        ds.list_databases().await
    }).await;
    match result {
        Ok(r) => r,
        Err(_) => Err(AppError::Datasource("获取数据库列表超时，请检查连接配置".into())),
    }
}

#[tauri::command]
pub async fn list_schemas(connection_id: i64, database: String) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::pool_cache::get_or_create(connection_id, &config, &database, "").await?;
    ds.list_schemas(&database).await
}

use crate::graph::SYSTEM_SCHEMAS;

#[tauri::command]
pub async fn list_databases_for_metrics(connection_id: i64) -> AppResult<Vec<String>> {
    // 若用户在连接配置中显式指定了数据库名，直接返回该单一数据库（跳过系统库过滤，用户库不可能是系统库）
    if let Some(db) = crate::db::get_configured_database(connection_id)? {
        return Ok(vec![db]);
    }
    let config = crate::db::get_connection_config(connection_id)?;
    // 带超时保护：避免连接创建或 SHOW DATABASES 长时间挂起导致前端 spinner 永转
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let ds = crate::datasource::pool_cache::get_or_create(connection_id, &config, "", "").await?;
        ds.list_databases().await
    }).await;
    match result {
        Ok(Ok(dbs)) => Ok(dbs.into_iter().filter(|d| !SYSTEM_SCHEMAS.contains(&d.as_str())).collect()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(AppError::Datasource("获取数据库列表超时，请检查连接配置".into())),
    }
}

#[tauri::command]
pub async fn list_schemas_for_metrics(
    connection_id: i64,
    database: String,
) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::pool_cache::get_or_create(connection_id, &config, &database, "").await?;
    let schemas = ds.list_schemas(&database).await?;
    Ok(schemas.into_iter().filter(|s| !SYSTEM_SCHEMAS.contains(&s.as_str())).collect())
}

#[tauri::command]
pub async fn get_metric(id: i64) -> AppResult<crate::metrics::Metric> {
    crate::metrics::crud::get_metric_pub(id)
}

#[tauri::command]
pub async fn list_metrics_by_node(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    status: Option<String>,
) -> AppResult<Vec<crate::metrics::Metric>> {
    crate::metrics::crud::list_metrics_by_node(
        connection_id,
        database.as_deref(),
        schema.as_deref(),
        status.as_deref(),
    )
}

#[derive(serde::Serialize)]
pub struct MetricPageResult {
    pub items: Vec<crate::metrics::Metric>,
    pub row_count: usize,   // 本页实际行数（items.len()）
    pub total_rows: i64,    // 满足过滤条件的总记录数
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn list_metrics_paged(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    status: Option<String>,
    page: u32,
    page_size: u32,
) -> Result<MetricPageResult, String> {
    let start = std::time::Instant::now();
    let (items, row_count, total_rows) = crate::metrics::crud::list_metrics_by_node_paged(
        connection_id,
        database.as_deref(),
        schema.as_deref(),
        status.as_deref(),
        page,
        page_size,
    ).map_err(|e| e.to_string())?;
    let duration_ms = start.elapsed().as_millis() as u64;
    Ok(MetricPageResult { items, row_count, total_rows, duration_ms })
}

#[tauri::command]
pub async fn count_metrics_batch(
    connection_id: i64,
    database: Option<String>,
) -> AppResult<std::collections::HashMap<String, i64>> {
    crate::metrics::crud::count_metrics_batch(connection_id, database.as_deref())
}

#[tauri::command]
pub async fn list_objects(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    category: String,
) -> AppResult<Vec<String>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let database_str = database.as_deref().unwrap_or("");
    let schema_str = schema.as_deref().unwrap_or("");
    let ds = crate::datasource::pool_cache::get_or_create(connection_id, &config, database_str, schema_str).await?;
    ds.list_objects(database_str, schema.as_deref(), &category).await
}

#[tauri::command]
pub async fn list_tables_with_stats(
    connection_id: i64,
    database: String,
    schema: Option<String>,
) -> AppResult<Vec<crate::datasource::TableStatInfo>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_db(&config, &database).await?;
    ds.list_tables_with_stats(&database, schema.as_deref()).await
}

#[tauri::command]
pub async fn ai_chat_stream_with_tools(
    messages: Vec<AgentMessage>,
    tools: Vec<ToolDefinition>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
) -> AppResult<()> {
    let client = build_llm_client()?;
    let system_msg = AgentMessage {
        role: "system".into(),
        content: Some(include_str!("../../prompts/chat_assistant.txt").to_string()),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    };
    let mut all_messages = vec![system_msg];
    all_messages.extend(messages);
    client.chat_stream_with_tools(all_messages, tools, &channel).await
}

#[tauri::command]
pub async fn ai_chat_continue(
    messages: Vec<AgentMessage>,
    tools: Vec<ToolDefinition>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
) -> AppResult<()> {
    let client = build_llm_client()?;
    // ai_chat_continue: messages already include system prompt from the loop
    client.chat_stream_with_tools(messages, tools, &channel).await
}

// ============ Agent 工具命令 ============

/// Agent 工具：获取表样本数据（最多 20 行）
#[tauri::command]
pub async fn agent_get_table_sample(
    connection_id: i64,
    table: String,
    schema: Option<String>,
    limit: Option<usize>,
) -> AppResult<QueryResult> {
    let safe_limit = limit.unwrap_or(5).min(20);
    let sql = match schema {
        Some(ref s) if !s.is_empty() => format!("SELECT * FROM \"{}\".\"{}\" LIMIT {}", s, table, safe_limit),
        _ => format!("SELECT * FROM \"{}\" LIMIT {}", table, safe_limit),
    };
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    ds.execute(&sql).await
}

/// Agent 工具：执行只读 SQL（仅 SELECT/WITH/SHOW，最多 100 行）
#[tauri::command]
pub async fn agent_execute_sql(
    connection_id: i64,
    sql: String,
    database: Option<String>,
    schema: Option<String>,
) -> AppResult<QueryResult> {
    let trimmed = sql.trim().to_uppercase();
    if !trimmed.starts_with("SELECT") && !trimmed.starts_with("WITH") && !trimmed.starts_with("SHOW") {
        return Err(crate::AppError::Other("agent_execute_sql only allows SELECT/WITH/SHOW queries".into()));
    }
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_context(
        &config,
        database.as_deref(),
        schema.as_deref(),
    ).await?;
    let mut result = ds.execute(&sql).await?;
    if result.rows.len() > 100 {
        result.rows.truncate(100);
        result.row_count = 100;
    }
    Ok(result)
}

// ============ ACP Agent 模式（旧版，已废弃，桩函数保留兼容性）============

/// AI 聊天 ACP 版本（旧版，已迁移到 agent_chat）
#[tauri::command]
pub async fn ai_chat_acp(
    _prompt: String,
    _tab_sql: Option<String>,
    _connection_id: Option<i64>,
    _config_id: Option<i64>,
    _session_id: String,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let _ = channel.send(crate::llm::StreamEvent::Error {
        message: "ACP mode is deprecated. Please use serve mode (agent_chat).".into(),
    });
    Ok(())
}

/// 取消 ACP session（旧版，已废弃）
#[tauri::command]
pub async fn cancel_acp_session(
    _session_id: String,
    _state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    Ok(())
}

// ============ 任务管理命令 ============

#[tauri::command]
pub async fn get_task_list(limit: Option<i32>) -> AppResult<Vec<crate::db::models::TaskRecord>> {
    let limit = limit.unwrap_or(100).min(100);
    crate::db::list_tasks(limit)
}

#[tauri::command]
pub async fn create_task(task: crate::db::models::CreateTaskInput) -> AppResult<crate::db::models::TaskRecord> {
    crate::db::create_task(&task)
}

#[tauri::command]
pub async fn update_task(id: String, updates: crate::db::models::UpdateTaskInput) -> AppResult<()> {
    crate::db::update_task(&id, &updates)
}

#[tauri::command]
pub async fn delete_task(id: String) -> AppResult<()> {
    crate::db::delete_task(&id)
}

#[tauri::command]
pub async fn get_task_by_id(id: String) -> AppResult<Option<crate::db::models::TaskRecord>> {
    crate::db::get_task_by_id(&id)
}

// ============ 任务取消与重试 ============

#[tauri::command]
pub async fn cancel_task(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    task_id: String,
) -> AppResult<()> {
    // 真正中断后台 tokio 任务（若存在）
    if let Some(abort_handle) = state.task_abort_handles.lock().unwrap().remove(&task_id) {
        abort_handle.abort();
    }
    let now = chrono::Utc::now().to_rfc3339();
    crate::db::update_task(&task_id, &crate::db::models::UpdateTaskInput {
        status: Some("cancelled".to_string()),
        completed_at: Some(now),
        ..Default::default()
    })?;
    // 通知前端任务已取消
    use tauri::Emitter;
    #[derive(serde::Serialize, Clone)]
    struct CancelEvent {
        task_id: String,
        status: String,
        progress: f32,
        processed_rows: i64,
        total_rows: Option<i64>,
        current_target: String,
        error: Option<String>,
        output_path: Option<String>,
        log_line: Option<()>,
        connection_id: Option<i64>,
        database: Option<String>,
        schema: Option<String>,
        metric_count: Option<i64>,
        skipped_count: Option<i64>,
    }
    let _ = app_handle.emit("task-progress", CancelEvent {
        task_id: task_id.clone(),
        status: "cancelled".to_string(),
        progress: 0.0,
        processed_rows: 0,
        total_rows: None,
        current_target: String::new(),
        error: None,
        output_path: None,
        log_line: None,
        connection_id: None,
        database: None,
        schema: None,
        metric_count: None,
        skipped_count: None,
    });
    Ok(())
}

#[tauri::command]
pub async fn retry_task(task_id: String) -> AppResult<()> {
    // MVP: 仅重置状态，实际重新执行留待后续版本
    // error: Some("".to_string()) 将 error 字段更新为空字符串 ——
    // update_task 的 SQL 逻辑对 Some(v) 一律 SET error = v，
    // 前端 `task.error && ...` 判断中，空字符串为 falsy，等同于无错误，行为正确。
    crate::db::update_task(&task_id, &crate::db::models::UpdateTaskInput {
        status: Some("pending".to_string()),
        progress: Some(0),
        error: Some("".to_string()),  // 清空错误文字
        completed_at: None,
        ..Default::default()
    })
}

// ============ 数据库管理 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateDatabaseOptions {
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub default_schema: Option<String>,
    pub tablespace: Option<String>,
}

#[tauri::command]
pub async fn create_database(
    connection_id: i64,
    name: String,
    options: CreateDatabaseOptions,
) -> AppResult<()> {
    // 验证名称安全（只允许 ASCII 字母、数字、下划线）
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other(
            format!("Invalid database name '{}': only alphanumeric and underscore allowed", name)
        ));
    }

    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

    let sql = match config.driver.as_str() {
        "mysql" => {
            let charset = options.charset.as_deref().unwrap_or("utf8mb4");
            let collation = options.collation.as_deref().unwrap_or("utf8mb4_general_ci");
            // 白名单验证：charset 和 collation 只允许 ASCII 字母数字和下划线
            let valid_charset = charset.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            let valid_collation = collation.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !valid_charset || !valid_collation {
                return Err(crate::AppError::Other(
                    "Invalid charset or collation: only alphanumeric and underscore allowed".to_string()
                ));
            }
            format!(
                "CREATE DATABASE `{}` CHARACTER SET {} COLLATE {}",
                name, charset, collation
            )
        }
        "postgres" => format!("CREATE DATABASE \"{}\"", name),
        _ => format!("CREATE DATABASE \"{}\"", name),
    };

    ds.execute(&sql).await?;
    Ok(())
}

#[tauri::command]
pub async fn drop_database(
    connection_id: i64,
    name: String,
) -> AppResult<()> {
    // 验证名称安全（只允许 ASCII 字母、数字、下划线）
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other(
            format!("Invalid database name '{}': only alphanumeric and underscore allowed", name)
        ));
    }

    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

    let sql = match config.driver.as_str() {
        "mysql" => format!("DROP DATABASE `{}`", name),
        _ => format!("DROP DATABASE \"{}\"", name),
    };

    ds.execute(&sql).await?;
    Ok(())
}

// ============ 多表导出（流式进度） ============

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiExportOptions {
    pub include_header: bool,
    pub include_ddl: bool,
    pub where_clause: Option<String>,
    pub encoding: String,
    pub delimiter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiExportParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub tables: Vec<String>,
    pub format: String,
    pub output_dir: String,
    pub options: MultiExportOptions,
    #[serde(default)]
    pub file_name: String,    // 输出文件名（不含后缀），Rust 侧拼接后缀
    #[serde(default)]
    pub export_all: bool,     // true 时忽略 tables，自动查全量表
}

#[derive(Clone, Serialize)]
pub struct TaskProgressPayload {
    pub task_id: String,
    pub status: String,
    pub progress: u8,
    pub processed_rows: u64,
    pub total_rows: Option<u64>,
    pub current_target: String,
    pub error: Option<String>,
    pub output_path: Option<String>,
}

#[tauri::command]
pub async fn export_tables(
    params: MultiExportParams,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    use tauri::Emitter;

    // Early return if no tables specified
    if !params.export_all && params.tables.is_empty() {
        return Err(crate::AppError::Other("No tables specified for export".to_string()));
    }

    // 解析最终要导出的表名列表
    let tables_to_export: Vec<String> = if params.export_all {
        // 查询数据库全量表名
        let config = crate::db::get_connection_config(params.connection_id)?;
        let db_name = params.database.as_deref().unwrap_or("");
        let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
            Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
            None => crate::datasource::create_datasource(&config).await?,
        };
        ds.list_objects(db_name, params.schema.as_deref(), "tables").await
            .map_err(|e| crate::AppError::Other(format!("Failed to list tables: {}", e)))?
    } else {
        params.tables.clone()
    };

    // 1. 创建任务记录
    let title = if tables_to_export.len() == 1 {
        format!("导出 {} 表", tables_to_export[0])
    } else {
        format!("导出 {} 个表", tables_to_export.len())
    };

    // 生成 Markdown 描述（供 LLM/MCP 读取）
    let description = {
        let conn_info = crate::db::get_connection_by_id(params.connection_id)
            .ok()
            .flatten();
        let conn_line = if let Some(ref c) = conn_info {
            let host_part = match (&c.host, &c.port) {
                (Some(h), Some(p)) => format!(" · {}:{}", h, p),
                (Some(h), None) => format!(" · {}", h),
                _ => String::new(),
            };
            format!("**连接**: {} (ID: {} · {}{})", c.name, c.id, c.driver.to_uppercase(), host_part)
        } else {
            format!("**连接 ID**: {}", params.connection_id)
        };

        let db_line = params.database.as_deref()
            .map(|db| {
                let schema_part = params.schema.as_deref()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(".{}", s))
                    .unwrap_or_default();
                format!("\n**数据库**: `{}{}`", db, schema_part)
            })
            .unwrap_or_default();

        let format_detail = {
            let mut parts = vec![params.format.to_uppercase()];
            if params.format == "csv" {
                parts.push(params.options.encoding.clone());
                parts.push(format!("分隔符 `{}`", params.options.delimiter));
                if params.options.include_header { parts.push("含表头".into()); }
            }
            if params.format == "sql" && params.options.include_ddl {
                parts.push("含 DDL".into());
            }
            parts.join(" · ")
        };

        let where_line = params.options.where_clause.as_deref()
            .filter(|s| !s.is_empty())
            .map(|w| format!("\n**筛选条件**: `{}`", w))
            .unwrap_or_default();

        let table_list = tables_to_export.iter()
            .map(|t| format!("- `{}`", t))
            .collect::<Vec<_>>()
            .join("\n");

        format!(
            "## 导出任务\n\n{}{}\n**格式**: {}{}\n**输出目录**: `{}`\n\n### 导出表（{} 个）\n{}",
            conn_line, db_line,
            format_detail, where_line,
            params.output_dir,
            tables_to_export.len(), table_list
        )
    };

    let task = crate::db::create_task(&crate::db::models::CreateTaskInput {
        type_: "export".to_string(),
        status: "running".to_string(),
        title,
        params: Some(serde_json::to_string(&params).unwrap_or_default()),
        progress: Some(0),
        processed_rows: Some(0),
        total_rows: None,
        current_target: Some(tables_to_export.first().cloned().unwrap_or_default()),
        error: None,
        error_details: None,
        output_path: Some(params.output_dir.clone()),
        description: Some(description),
        connection_id: None,
        scope_database: None,
        scope_schema: None,
    })?;

    let task_id = task.id.clone();

    let is_zip = tables_to_export.len() > 1 || params.export_all;
    let file_name = if params.file_name.is_empty() {
        tables_to_export.first().cloned().unwrap_or_else(|| "export".to_string())
    } else {
        params.file_name.clone()
    };

    let total = tables_to_export.len() as u64;

    // 克隆供 async move 使用
    let tables_for_task = tables_to_export.clone();
    let params_clone = params.clone();

    // 2. 后台执行（不阻塞前端）
    let task_id_clone = task_id.clone();
    tokio::spawn(async move {
        use std::path::Path;
        use std::fs::File;
        use std::io::Write;

        if is_zip {
            // ---- ZIP 分支 ----
            let zip_path = Path::new(&params_clone.output_dir)
                .join(format!("{}.zip", file_name));

            let zip_file = match File::create(&zip_path) {
                Ok(f) => f,
                Err(e) => {
                    let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                        status: Some("failed".to_string()),
                        error: Some(e.to_string()),
                        completed_at: Some(chrono::Utc::now().to_rfc3339()),
                        ..Default::default()
                    });
                    return;
                }
            };
            let mut zip = zip::ZipWriter::new(zip_file);
            let zip_options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            let mut processed = 0u64;
            for (i, table_name) in tables_for_task.iter().enumerate() {
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone.clone(),
                    status: "running".to_string(),
                    progress: ((i as f64 / total as f64) * 100.0) as u8,
                    processed_rows: processed,
                    total_rows: Some(total),
                    current_target: table_name.clone(),
                    error: None,
                    output_path: Some(zip_path.to_string_lossy().to_string()),
                });

                // 导出单表到临时文件
                let tmp_path = Path::new(&params_clone.output_dir)
                    .join(format!("_tmp_{}.{}", table_name, &params_clone.format));
                let single_params = ExportParams {
                    connection_id: params_clone.connection_id,
                    database: params_clone.database.clone(),
                    table: table_name.clone(),
                    schema: params_clone.schema.clone(),
                    format: params_clone.format.clone(),
                    where_clause: None,
                    output_path: tmp_path.to_string_lossy().to_string(),
                    include_header: params_clone.options.include_header,
                    include_ddl: params_clone.options.include_ddl,
                };

                if let Err(e) = export_table_data(single_params).await {
                    let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                        status: Some("failed".to_string()),
                        error: Some(e.to_string()),
                        completed_at: Some(chrono::Utc::now().to_rfc3339()),
                        ..Default::default()
                    });
                    let _ = app_handle.emit("task-progress", TaskProgressPayload {
                        task_id: task_id_clone.clone(),
                        status: "failed".to_string(),
                        progress: 0,
                        processed_rows: processed,
                        total_rows: Some(total),
                        current_target: table_name.clone(),
                        error: Some(e.to_string()),
                        output_path: None,
                    });
                    // 清理临时文件
                    let _ = std::fs::remove_file(&tmp_path);
                    return;
                }

                // 将临时文件内容写入 ZIP
                let entry_name = format!("{}.{}", table_name, &params_clone.format);
                if zip.start_file(&entry_name, zip_options).is_ok() {
                    if let Ok(content) = std::fs::read(&tmp_path) {
                        let _ = zip.write_all(&content);
                    }
                }
                let _ = std::fs::remove_file(&tmp_path);
                processed += 1;
            }

            let _ = zip.finish();

            let out_path_str = zip_path.to_string_lossy().to_string();
            let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                status: Some("completed".to_string()),
                progress: Some(100),
                processed_rows: Some(processed as i64),
                total_rows: Some(total as i64),
                output_path: Some(out_path_str.clone()),
                completed_at: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            });
            let _ = app_handle.emit("task-progress", TaskProgressPayload {
                task_id: task_id_clone,
                status: "completed".to_string(),
                progress: 100,
                processed_rows: processed,
                total_rows: Some(total),
                current_target: String::new(),
                error: None,
                output_path: Some(out_path_str),
            });

        } else {
            // ---- 单文件分支（保持原逻辑，但使用 file_name） ----
            let table_name = tables_for_task.first().cloned().unwrap_or_default();
            let output_file = Path::new(&params_clone.output_dir)
                .join(format!("{}.{}", file_name, &params_clone.format));

            let single_params = ExportParams {
                connection_id: params_clone.connection_id,
                database: params_clone.database.clone(),
                table: table_name.clone(),
                schema: params_clone.schema.clone(),
                format: params_clone.format.clone(),
                where_clause: params_clone.options.where_clause.clone(),
                output_path: output_file.to_string_lossy().to_string(),
                include_header: params_clone.options.include_header,
                include_ddl: params_clone.options.include_ddl,
            };

            if let Err(e) = export_table_data(single_params).await {
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("failed".to_string()),
                    error: Some(e.to_string()),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone,
                    status: "failed".to_string(),
                    progress: 0,
                    processed_rows: 0,
                    total_rows: Some(1),
                    current_target: table_name,
                    error: Some(e.to_string()),
                    output_path: None,
                });
                return;
            }

            let out_path_str = output_file.to_string_lossy().to_string();
            let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                status: Some("completed".to_string()),
                progress: Some(100),
                processed_rows: Some(1),
                total_rows: Some(1),
                output_path: Some(out_path_str.clone()),
                completed_at: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            });
            let _ = app_handle.emit("task-progress", TaskProgressPayload {
                task_id: task_id_clone,
                status: "completed".to_string(),
                progress: 100,
                processed_rows: 1,
                total_rows: Some(1),
                current_target: String::new(),
                error: None,
                output_path: Some(out_path_str),
            });
        }
    });

    Ok(task_id)
}

// ============ 数据导入 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub file_path: String,
    pub file_type: String,   // csv/json/excel/sql
    pub field_mapping: std::collections::HashMap<String, String>,
    pub error_strategy: String,  // "StopOnError" | "SkipAndContinue"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnInfoForImport {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub is_pk: bool,
    pub nullable: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableColumnsResponse {
    pub columns: Vec<ColumnInfoForImport>,
}

/// 获取表列信息用于导入字段映射
#[tauri::command]
pub async fn get_table_columns_for_import(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    table: String,
) -> AppResult<TableColumnsResponse> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let schema_ref = schema.as_deref().filter(|s| !s.is_empty());
    let cols = ds.get_columns(&table, schema_ref).await?;
    let columns = cols.into_iter().map(|c| ColumnInfoForImport {
        type_: c.data_type.clone(),
        is_pk: c.is_primary_key,
        nullable: c.is_nullable,
        name: c.name,
    }).collect();
    Ok(TableColumnsResponse { columns })
}

/// 预览导入文件（返回前5行的文本预览 + 列名）
#[tauri::command]
pub async fn preview_import_file(
    file_path: String,
    file_type: String,
) -> AppResult<serde_json::Value> {
    let content = tokio::fs::read_to_string(&file_path).await
        .map_err(|e| crate::AppError::Other(format!("Failed to read file: {}", e)))?;

    match file_type.as_str() {
        "csv" => {
            let lines: Vec<&str> = content.lines().take(6).collect();
            let columns = lines.first()
                .map(|h| h.split(',').map(|s| s.trim().trim_matches('"').to_string()).collect::<Vec<_>>())
                .unwrap_or_default();
            let preview_rows: Vec<String> = lines.iter().take(6).map(|s| s.to_string()).collect();
            Ok(serde_json::json!({ "columns": columns, "preview_rows": preview_rows }))
        }
        "json" => {
            let parsed: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| crate::AppError::Other(format!("Invalid JSON: {}", e)))?;
            let (columns, preview_rows) = if let Some(arr) = parsed.as_array() {
                let cols = arr.first()
                    .and_then(|v| v.as_object())
                    .map(|o| o.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                let rows = arr.iter().take(5)
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>();
                (cols, rows)
            } else {
                (vec![], vec![parsed.to_string()])
            };
            Ok(serde_json::json!({ "columns": columns, "preview_rows": preview_rows }))
        }
        _ => Ok(serde_json::json!({
            "columns": [],
            "preview_rows": [format!("预览不支持 {} 格式，请直接导入", file_type)]
        })),
    }
}

/// 导入文件到表（异步后台执行，通过 task-progress 事件推进度）
#[tauri::command]
pub async fn import_to_table(
    params: ImportParams,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    use tauri::Emitter;
    let title = format!("导入到 {} 表", params.table);

    // 生成 Markdown 描述（供 LLM/MCP 读取）
    let description = {
        let conn_info = crate::db::get_connection_by_id(params.connection_id)
            .ok()
            .flatten();
        let conn_line = if let Some(ref c) = conn_info {
            let host_part = match (&c.host, &c.port) {
                (Some(h), Some(p)) => format!(" · {}:{}", h, p),
                (Some(h), None) => format!(" · {}", h),
                _ => String::new(),
            };
            format!("**连接**: {} (ID: {} · {}{})", c.name, c.id, c.driver.to_uppercase(), host_part)
        } else {
            format!("**连接 ID**: {}", params.connection_id)
        };

        let db_line = params.database.as_deref()
            .map(|db| {
                let schema_part = params.schema.as_deref()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(".{}", s))
                    .unwrap_or_default();
                format!("\n**数据库**: `{}{}`", db, schema_part)
            })
            .unwrap_or_default();

        let mapping_lines = params.field_mapping.iter()
            .map(|(src, dst)| format!("- `{}` → `{}`", src, dst))
            .collect::<Vec<_>>()
            .join("\n");

        format!(
            "## 导入任务\n\n{}{}\n**目标表**: `{}`\n**文件**: `{}`\n**格式**: {}\n**错误策略**: {}\n\n### 字段映射\n{}",
            conn_line, db_line,
            params.table,
            params.file_path,
            params.file_type.to_uppercase(),
            if params.error_strategy == "StopOnError" { "遇错停止" } else { "跳过错误行继续" },
            if mapping_lines.is_empty() { "（自动匹配）".to_string() } else { mapping_lines }
        )
    };

    let task = crate::db::create_task(&crate::db::models::CreateTaskInput {
        type_: "import".to_string(),
        status: "running".to_string(),
        title,
        params: Some(serde_json::to_string(&params).unwrap_or_default()),
        progress: Some(0),
        processed_rows: Some(0),
        total_rows: None,
        current_target: Some(params.table.clone()),
        error: None,
        error_details: None,
        output_path: Some(params.file_path.clone()),
        description: Some(description),
        connection_id: None,
        scope_database: None,
        scope_schema: None,
    })?;
    let task_id = task.id.clone();
    let task_id_clone = task_id.clone();

    tokio::spawn(async move {
        let result = run_import(&params, &task_id_clone, &app_handle).await;
        match result {
            Ok(count) => {
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("completed".to_string()),
                    progress: Some(100),
                    processed_rows: Some(count as i64),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone,
                    status: "completed".to_string(),
                    progress: 100,
                    processed_rows: count,
                    total_rows: None,
                    current_target: String::new(),
                    error: None,
                    output_path: None,
                });
            }
            Err(e) => {
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("failed".to_string()),
                    error: Some(e.to_string()),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone,
                    status: "failed".to_string(),
                    progress: 0,
                    processed_rows: 0,
                    total_rows: None,
                    current_target: String::new(),
                    error: Some(e.to_string()),
                    output_path: None,
                });
            }
        }
    });

    Ok(task_id)
}

async fn run_import(
    params: &ImportParams,
    task_id: &str,
    app_handle: &tauri::AppHandle,
) -> AppResult<u64> {
    use tauri::Emitter;
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };

    let content = tokio::fs::read_to_string(&params.file_path).await
        .map_err(|e| crate::AppError::Other(format!("Failed to read file: {}", e)))?;

    let rows: Vec<std::collections::HashMap<String, serde_json::Value>> = match params.file_type.as_str() {
        "csv" => {
            // MVP 限制：简单 split(',') 解析，不支持字段内包含逗号（RFC 4180）
            // 如有需要，后续可引入 csv crate 进行完整解析
            let mut lines = content.lines();
            let headers: Vec<String> = lines.next()
                .ok_or_else(|| crate::AppError::Other("Empty CSV file".into()))?
                .split(',')
                .map(|s| s.trim().trim_matches('"').to_string())
                .collect();
            lines.map(|line| {
                let vals: Vec<&str> = line.split(',').collect();
                headers.iter().enumerate().map(|(i, h)| {
                    let v = vals.get(i).copied().unwrap_or("").trim().trim_matches('"');
                    (h.clone(), serde_json::Value::String(v.to_string()))
                }).collect()
            }).collect()
        }
        "json" => {
            let parsed: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| crate::AppError::Other(format!("Invalid JSON: {}", e)))?;
            parsed.as_array()
                .ok_or_else(|| crate::AppError::Other("JSON must be an array".into()))?
                .iter()
                .filter_map(|v| v.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()))
                .collect()
        }
        _ => return Err(crate::AppError::Other(format!("Import format '{}' not yet supported", params.file_type))),
    };

    let total = rows.len() as u64;
    let batch_size = 100;
    let tbl = qualified_table(&config.driver, params.schema.as_deref(), &params.table);
    let mut success_count = 0u64;
    let stop_on_error = params.error_strategy == "StopOnError";

    for (batch_idx, chunk) in rows.chunks(batch_size).enumerate() {
        let progress = if total > 0 { ((batch_idx * batch_size) as f64 / total as f64 * 100.0) as u8 } else { 0 };
        let _ = app_handle.emit("task-progress", TaskProgressPayload {
            task_id: task_id.to_string(),
            status: "running".to_string(),
            progress,
            processed_rows: success_count,
            total_rows: Some(total),
            current_target: params.table.clone(),
            error: None,
            output_path: None,
        });

        for row in chunk {
            let mapped: Vec<(String, Option<String>)> = params.field_mapping.iter()
                .filter_map(|(src, dst)| {
                    row.get(src).map(|v| {
                        let val = match v {
                            serde_json::Value::Null => None,
                            serde_json::Value::String(s) => Some(s.clone()),
                            other => Some(other.to_string()),
                        };
                        (dst.clone(), val)
                    })
                })
                .collect();

            if mapped.is_empty() { continue; }

            let (col_list, val_list): (Vec<String>, Vec<String>) = mapped.iter()
                .map(|(col, val)| {
                    let qcol = match config.driver.as_str() {
                        "mysql" => format!("`{}`", col.replace('`', "``")),
                        _ => format!("\"{}\"", col.replace('"', "\"\"")),
                    };
                    let qval = match val {
                        None => "NULL".to_string(),
                        Some(v) => match config.driver.as_str() {
                            "mysql" => format!("'{}'", v.replace('\'', "''")),
                            _ => format!("'{}'", v.replace('\'', "''")),
                        },
                    };
                    (qcol, qval)
                })
                .unzip();

            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                tbl, col_list.join(", "), val_list.join(", ")
            );

            match ds.execute(&sql).await {
                Ok(_) => success_count += 1,
                Err(e) => {
                    if stop_on_error {
                        return Err(e);
                    }
                }
            }
        }
    }

    Ok(success_count)
}

// ============ 数据库备份 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupParams {
    pub connection_id: i64,
    pub database: String,
    pub output_path: String,      // 完整文件路径（含文件名和后缀）
    pub include_schema: bool,
    pub include_data: bool,
    pub compress: bool,           // MySQL: -C
    pub custom_format: bool,      // PG only: --format=c → 输出 .dump
}

#[tauri::command]
pub async fn backup_database(params: BackupParams) -> Result<(), String> {
    use std::process::Command;

    let config = crate::db::get_connection_config(params.connection_id)
        .map_err(|e| e.to_string())?;

    let host = config.host.as_deref().unwrap_or("");
    let port = config.port.unwrap_or(0);
    let user = config.username.as_deref().unwrap_or("");
    let password = config.password.as_deref().unwrap_or("");

    let driver = config.driver.to_lowercase();

    let mut cmd = if driver == "mysql" {
        let mut c = Command::new("mysqldump");
        c.arg(format!("-h{}", host))
         .arg(format!("-P{}", port))
         .arg(format!("-u{}", user))
         .arg(format!("-p{}", password));
        if params.compress { c.arg("-C"); }
        if !params.include_data { c.arg("--no-data"); }
        if !params.include_schema { c.arg("--no-create-info"); }
        c.arg("--databases").arg(&params.database);
        c
    } else {
        // PostgreSQL
        let mut c = Command::new("pg_dump");
        c.arg("-h").arg(host)
         .arg("-p").arg(port.to_string())
         .arg("-U").arg(user)
         .arg("-d").arg(&params.database);
        if !params.include_schema { c.arg("--data-only"); }
        if !params.include_data { c.arg("--schema-only"); }
        if params.custom_format { c.arg("--format=c"); }
        c.env("PGPASSWORD", password);
        c
    };

    // 将 stdout 重定向到输出文件
    let output_file = std::fs::File::create(&params.output_path)
        .map_err(|e| format!("无法创建输出文件：{}", e))?;
    cmd.stdout(output_file);

    let status = cmd.status().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            let tool = if driver == "mysql" { "mysqldump" } else { "pg_dump" };
            format!("未找到 {}，请确认已安装并添加到 PATH", tool)
        } else {
            e.to_string()
        }
    })?;

    if !status.success() {
        return Err(format!("备份命令退出码非零：{:?}", status.code()));
    }

    Ok(())
}

/// 获取数据库版本字符串（供前端缓存，失败时返回空字符串）
#[tauri::command]
pub async fn get_db_version(connection_id: i64) -> AppResult<String> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await
        .map_err(|_| crate::AppError::Other("connect failed".into()))?;
    let result = ds.execute("SELECT VERSION()").await
        .unwrap_or_else(|_| crate::datasource::QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            duration_ms: 0,
        });
    let version = result.rows
        .first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(version)
}

/// 在系统文件管理器中打开指定路径（文件或目录）
#[tauri::command]
pub async fn show_in_folder(path: String) -> AppResult<()> {
    let p = std::path::Path::new(&path);
    let is_dir = p.is_dir();

    #[cfg(target_os = "windows")]
    {
        if is_dir {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| crate::AppError::Other(format!("Failed to open folder: {}", e)))?;
        } else {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", path))
                .spawn()
                .map_err(|e| crate::AppError::Other(format!("Failed to open folder: {}", e)))?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if is_dir {
            std::process::Command::new("open")
                .arg(&path)
                .spawn()
                .map_err(|e| crate::AppError::Other(format!("Failed to open folder: {}", e)))?;
        } else {
            std::process::Command::new("open")
                .args(["-R", &path])
                .spawn()
                .map_err(|e| crate::AppError::Other(format!("Failed to open folder: {}", e)))?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let open_path = if is_dir {
            path.clone()
        } else {
            p.parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(path.clone())
        };
        std::process::Command::new("xdg-open")
            .arg(&open_path)
            .spawn()
            .map_err(|e| crate::AppError::Other(format!("Failed to open folder: {}", e)))?;
    }
    Ok(())
}

// ============ 指标管理 ============

#[tauri::command]
pub async fn list_metrics(
    connection_id: i64,
    status: Option<String>,
) -> AppResult<Vec<crate::metrics::Metric>> {
    crate::metrics::list_metrics(connection_id, status.as_deref())
}

#[tauri::command]
pub async fn save_metric(
    input: crate::metrics::CreateMetricInput,
) -> AppResult<crate::metrics::Metric> {
    crate::metrics::save_metric(&input)
}

#[tauri::command]
pub async fn update_metric(
    id: i64,
    input: crate::metrics::UpdateMetricInput,
) -> AppResult<crate::metrics::Metric> {
    crate::metrics::crud::update_metric(id, &input)
}

#[tauri::command]
pub async fn delete_metric(id: i64) -> AppResult<()> {
    crate::metrics::delete_metric(id)
}

#[tauri::command]
pub async fn approve_metric(id: i64, status: String) -> AppResult<crate::metrics::Metric> {
    if status != "approved" && status != "rejected" {
        return Err(crate::AppError::Other("status must be 'approved' or 'rejected'".into()));
    }
    crate::metrics::set_metric_status(id, &status)
}

// ============ 知识图谱 ============

/// 异步构建知识图谱，返回 task_id；前端通过 task-progress 事件监听进度
#[tauri::command]
pub async fn build_schema_graph(
    app_handle: tauri::AppHandle,
    connection_id: i64,
    database: Option<String>,
) -> AppResult<String> {
    // 先写 SQLite，让任务中心可以持久化显示
    let task_record = crate::db::create_task(&crate::db::models::CreateTaskInput {
        type_: "build_schema_graph".to_string(),
        status: "running".to_string(),
        title: format!("构建知识图谱 (连接 {})", connection_id),
        params: None,
        progress: Some(0),
        processed_rows: Some(0),
        total_rows: None,
        current_target: None,
        error: None,
        error_details: None,
        output_path: None,
        description: None,
        connection_id: Some(connection_id),
        scope_database: database.clone(),
        scope_schema: None,
    })?;
    let task_id = task_record.id.clone();
    let task_id_clone = task_id.clone();
    tokio::spawn(async move {
        crate::graph::run_graph_build(app_handle, task_id_clone, connection_id, database).await;
    });
    Ok(task_id)
}

#[tauri::command]
pub async fn get_graph_nodes(
    connection_id: i64,
    node_type: Option<String>,
    database: Option<String>,
) -> AppResult<Vec<crate::graph::GraphNode>> {
    crate::graph::query::get_nodes_filtered(
        connection_id,
        node_type.as_deref(),
        database.as_deref(),
    )
}

#[tauri::command]
pub async fn search_graph(
    connection_id: i64,
    keyword: String,
) -> AppResult<Vec<crate::graph::GraphNode>> {
    crate::graph::search_graph(connection_id, &keyword)
}

/// 查询指定节点集合的关联边
#[tauri::command]
pub async fn get_graph_edges(
    connection_id: i64,
    node_ids: Vec<String>,
) -> AppResult<Vec<crate::graph::GraphEdge>> {
    let _ = connection_id; // 边的过滤通过 node_ids 中的节点 ID（已含 connection_id 前缀）实现
    if node_ids.is_empty() {
        return Ok(vec![]);
    }
    let conn = crate::db::get().lock().unwrap();
    // 构建 IN 占位符（?1 .. ?N），from_node 和 to_node 各自独立绑定相同 ID 集合
    let n = node_ids.len();
    let ph1: String = (1..=n).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(",");
    let ph2: String = (n + 1..=2 * n).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT e.id, e.from_node, e.to_node, e.edge_type, e.weight, e.metadata, e.source
         FROM graph_edges e
         WHERE e.from_node IN ({ph1}) OR e.to_node IN ({ph2})",
        ph1 = ph1,
        ph2 = ph2
    );
    // 参数绑定：node_ids 出现两次（from_node IN + to_node IN）
    let params: Vec<Box<dyn rusqlite::ToSql>> = node_ids
        .iter()
        .chain(node_ids.iter())
        .map(|id| Box::new(id.clone()) as Box<dyn rusqlite::ToSql>)
        .collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        let meta_str: Option<String> = row.get(5)?;
        Ok(crate::graph::GraphEdge {
            id: row.get(0)?,
            from_node: row.get(1)?,
            to_node: row.get(2)?,
            edge_type: row.get(3)?,
            weight: row.get(4)?,
            metadata: meta_str.and_then(|s| serde_json::from_str(&s).ok()),
            source: row.get(6)?,
        })
    })?;
    let mut edges: Vec<crate::graph::GraphEdge> = rows.collect::<Result<Vec<_>, _>>()?;
    edges.sort_by(|a, b| a.id.cmp(&b.id));
    edges.dedup_by_key(|e| e.id.clone());
    Ok(edges)
}

/// 更新节点别名，并将 source 改为 'user'，同步更新 FTS5 索引
#[tauri::command]
pub async fn update_node_alias(
    node_id: String,
    aliases: String,
) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE graph_nodes SET aliases = ?1, source = 'user' WHERE id = ?2",
        rusqlite::params![aliases, node_id],
    )?;
    // 同步更新 FTS5
    let rowid: Option<i64> = conn.query_row(
        "SELECT rowid FROM graph_nodes WHERE id = ?1",
        [&node_id],
        |row| row.get(0),
    ).optional()?;
    if let Some(r) = rowid {
        conn.execute("DELETE FROM graph_nodes_fts WHERE rowid = ?1", [r])?;
        conn.execute(
            "INSERT INTO graph_nodes_fts(rowid, id, name, display_name, aliases)
             SELECT rowid, id, name, display_name, aliases
             FROM graph_nodes WHERE rowid = ?1",
            [r],
        )?;
    }
    Ok(())
}

/// 更新图谱节点的 metadata（用于 Link Node description 编辑）
#[tauri::command]
pub async fn update_graph_node_metadata(
    node_id: String,
    metadata: String,
) -> AppResult<()> {
    if node_id.is_empty() {
        return Err(crate::AppError::Other("node_id cannot be empty".into()));
    }
    let conn = crate::db::get().lock().unwrap();
    let rows_affected = conn.execute(
        "UPDATE graph_nodes SET metadata = ?1 WHERE id = ?2",
        rusqlite::params![metadata, node_id],
    )?;
    if rows_affected == 0 {
        return Err(crate::AppError::Other(
            format!("Node with id '{}' not found", node_id),
        ));
    }
    Ok(())
}

// ============ 图谱节点坐标持久化 ============

#[tauri::command]
pub async fn save_graph_node_position(
    node_id: String,
    x: f64,
    y: f64,
) -> AppResult<()> {
    crate::graph::query::save_node_position(&node_id, x, y)
}

#[tauri::command]
pub async fn clear_graph_node_positions(
    connection_id: i64,
    database: Option<String>,
) -> AppResult<()> {
    crate::graph::query::clear_node_positions(connection_id, database.as_deref())
}

// ============ 跨数据源迁移 ============

#[allow(dead_code)]
#[tauri::command]
pub async fn create_migration_task(
    name: String,
    src_connection_id: i64,
    dst_connection_id: i64,
    config: crate::migration::MigrationConfig,
) -> AppResult<crate::migration::MigrationTask> {
    crate::migration::create_task(&name, src_connection_id, dst_connection_id, &config)
}

#[allow(dead_code)]
#[tauri::command]
pub async fn list_migration_tasks() -> AppResult<Vec<crate::migration::MigrationTask>> {
    crate::migration::list_tasks()
}

#[allow(dead_code)]
#[tauri::command]
pub async fn run_migration_precheck(
    task_id: i64,
) -> AppResult<crate::migration::precheck::PreCheckResult> {
    crate::migration::precheck::run_precheck(task_id).await
}

#[allow(dead_code)]
#[tauri::command]
pub async fn get_precheck_report(
    task_id: i64,
) -> AppResult<crate::migration::precheck::PreCheckResult> {
    crate::migration::precheck::get_precheck_result(task_id)
}

#[allow(dead_code)]
#[tauri::command]
pub async fn pause_migration(task_id: i64) -> AppResult<()> {
    crate::migration::pause_migration(task_id)
}

#[allow(dead_code)]
#[tauri::command]
pub async fn get_migration_progress(
    task_id: i64,
) -> AppResult<Option<crate::migration::task_mgr::MigrationProgress>> {
    let task = crate::migration::get_task(task_id)?;
    Ok(task.progress)
}

// ============ AI 指标草稿 + Text-to-SQL v2 ============

#[tauri::command]
pub async fn ai_generate_metrics(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    table_names: Vec<String>,
) -> AppResult<String> {
    // 先写 SQLite，让 taskStore 可以持久化
    let db_name = database.clone().unwrap_or_else(|| "default".to_string());
    let title = format!("AI 生成指标 · {}", db_name);
    let task_record = crate::db::create_task(&crate::db::models::CreateTaskInput {
        type_: "ai_generate_metrics".to_string(),
        status: "running".to_string(),
        title,
        params: None,
        progress: Some(0),
        processed_rows: Some(0),
        total_rows: None,
        current_target: None,
        error: None,
        error_details: None,
        output_path: None,
        description: None,
        connection_id: Some(connection_id),
        scope_database: database.clone(),
        scope_schema: schema.clone(),
    })?;
    let task_id = task_record.id.clone();
    let task_id_clone = task_id.clone();
    let task_id_reg = task_id.clone();
    let handle = tokio::spawn(async move {
        crate::metrics::ai_draft::generate_metric_drafts(
            app_handle,
            task_id_clone,
            connection_id,
            database,
            schema,
            table_names,
        )
        .await;
    });
    // 注册取消句柄，供 cancel_task 使用
    state.task_abort_handles.lock().unwrap().insert(task_id_reg, handle.abort_handle());
    Ok(task_id)
}

#[derive(serde::Serialize)]
pub struct TableWithColumnCount {
    pub name: String,
    pub column_count: usize,
}

#[tauri::command]
pub async fn list_tables_with_column_count(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
) -> AppResult<Vec<TableWithColumnCount>> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource_with_context(
        &config,
        database.as_deref(),
        schema.as_deref(),
    )
    .await?;
    let schema_info = ds.get_schema().await?;

    // 为每张表创建独立的 datasource 实例，使用 join_all 并发拉取列数，避免 N+1 串行超时
    let config = std::sync::Arc::new(config);
    let futures: Vec<_> = schema_info.tables.into_iter().map(|table| {
        let config = config.clone();
        let db = database.clone();
        let sc = schema.clone();
        async move {
            let ds = crate::datasource::create_datasource_with_context(
                &config,
                db.as_deref(),
                sc.as_deref(),
            )
            .await?;
            let cols = ds
                .get_columns(&table.name, sc.as_deref())
                .await
                .unwrap_or_default();
            Ok::<TableWithColumnCount, crate::AppError>(TableWithColumnCount {
                name: table.name,
                column_count: cols.len(),
            })
        }
    }).collect();

    let results = futures_util::future::join_all(futures).await;
    Ok(results.into_iter().filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn ai_generate_sql_v2(
    question: String,
    connection_id: i64,
    history: Option<Vec<crate::llm::ChatMessage>>,
) -> AppResult<crate::pipeline::TextToSqlResult> {
    let hist = history.unwrap_or_default();
    crate::pipeline::generate_sql_v2(&question, connection_id, &hist).await
}

// ============ 数据迁移 — 启动 & 查询 ============

#[allow(dead_code)]
#[tauri::command]
pub async fn start_migration(
    task_id: i64,
    app_handle: tauri::AppHandle,
) -> AppResult<()> {
    crate::migration::start_migration(task_id, app_handle).await
}

#[allow(dead_code)]
#[tauri::command]
pub fn get_migration_task(task_id: i64) -> AppResult<crate::migration::MigrationTask> {
    crate::migration::get_task(task_id)
}

// ============ ACP Elicitation — 权限确认回传（旧版，已废弃，桩函数保留兼容性）============

/// ACP 权限确认回传（旧版，已迁移到 agent_permission_respond）
#[tauri::command]
pub async fn acp_permission_respond(
    _session_id: String,
    _permission_id: String,
    _selected_option_id: String,
    _cancelled: bool,
    _state: tauri::State<'_, crate::AppState>,
) -> crate::AppResult<()> {
    Ok(())
}

/// ACP Elicitation 回传（旧版，已废弃）
#[tauri::command]
pub async fn acp_elicitation_respond(
    _session_id: String,
    _elicitation_id: String,
    _action: String,
    _content: Option<serde_json::Value>,
    _state: tauri::State<'_, crate::AppState>,
) -> crate::AppResult<()> {
    Ok(())
}

// ============ UI 状态持久化 ============

#[tauri::command]
pub async fn get_ui_state(key: String) -> AppResult<Option<String>> {
    let conn = crate::db::get().lock().unwrap();
    let result = conn
        .query_row(
            "SELECT value FROM ui_state WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| crate::AppError::Other(e.to_string()))?;
    Ok(result)
}

#[tauri::command]
pub async fn set_ui_state(key: String, value: String) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "INSERT INTO ui_state (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value],
    )
    .map_err(|e| crate::AppError::Other(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_ui_state(key: String) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "DELETE FROM ui_state WHERE key = ?1",
        rusqlite::params![key],
    )
    .map_err(|e| crate::AppError::Other(e.to_string()))?;
    Ok(())
}

/// 通过连接 ID 测试连接是否可用（从 SQLite 读取配置并解密密码），3 秒超时。
#[tauri::command]
pub async fn test_connection_by_id(connection_id: i64) -> AppResult<bool> {
    let config = crate::db::get_connection_config(connection_id)?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        async {
            let ds = crate::datasource::create_datasource(&config).await?;
            ds.test_connection().await?;
            Ok::<bool, crate::AppError>(true)
        },
    )
    .await;
    match result {
        Ok(Ok(_)) => Ok(true),
        _ => Ok(false),
    }
}

// ============ Tab SQL 文件管理 ============

fn tabs_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let dir = data_dir.join("tabs");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

#[tauri::command]
pub async fn read_tab_file(
    app_handle: tauri::AppHandle,
    tab_id: String,
) -> Result<Option<String>, String> {
    let path = tabs_dir(&app_handle)?.join(format!("{}.sql", tab_id));
    if path.exists() {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn write_tab_file(
    app_handle: tauri::AppHandle,
    tab_id: String,
    content: String,
) -> Result<(), String> {
    let path = tabs_dir(&app_handle)?.join(format!("{}.sql", tab_id));
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_tab_file(
    app_handle: tauri::AppHandle,
    tab_id: String,
) -> Result<(), String> {
    let path = tabs_dir(&app_handle)?.join(format!("{}.sql", tab_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_tab_files(
    app_handle: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    let dir = tabs_dir(&app_handle)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let ids: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".sql").map(|s| s.to_string())
        })
        .collect();
    Ok(ids)
}

// ============ Auto 模式 ============

#[tauri::command]
pub async fn get_auto_mode(state: tauri::State<'_, crate::AppState>) -> AppResult<bool> {
    let mode = state.auto_mode.lock().await;
    Ok(*mode)
}

#[tauri::command]
pub async fn set_auto_mode(
    state: tauri::State<'_, crate::AppState>,
    enabled: bool,
) -> AppResult<()> {
    {
        let mut mode = state.auto_mode.lock().await;
        *mode = enabled;
    }
    // 持久化到 app_settings
    crate::db::set_app_setting("auto_mode", if enabled { "true" } else { "false" })?;
    Ok(())
}

#[tauri::command]
pub async fn mcp_query_respond(
    state: tauri::State<'_, crate::AppState>,
    request_id: String,
    data: serde_json::Value,
) -> AppResult<()> {
    let tx = {
        let mut pending = state.pending_queries.lock().await;
        pending.remove(&request_id)
    };
    if let Some(tx) = tx {
        let _ = tx.send(data);
    }
    Ok(())
}

// ============ Agent Serve 模式命令 ============

/// Agent session 记录（从 SQLite agent_sessions 表返回）
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentSessionRecord {
    pub id: String,
    pub title: Option<String>,
    pub config_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// OpenCode 消息解析结果（用于前端展示）
#[derive(Debug, Serialize)]
pub struct ParsedChatMessage {
    pub role: String,
    pub content: String,
    pub thinking_content: Option<String>,
}

/// 从 OpenCode GET /session/:id/message 响应解析 ChatMessage 列表。
/// OpenCode 消息格式：[{ "role": "user"|"assistant", "parts": [{ "type": "text"|"reasoning", "text": "..." }] }]
/// 从 user 消息文本中分离注入的上下文前缀和用户原始输入。
///
/// 注入顺序（见 agent_chat_inner）：
/// 1. `当前数据库连接 ID: {N}\n\n{prompt}`
/// 2. `当前编辑器 SQL：\n```sql\n{sql}\n```\n\n{prev}`
///
/// 返回 `(context_summary, user_input)`：
/// - `context_summary`：上下文摘要（连接 ID / SQL 标记），为空表示无前缀
/// - `user_input`：用户实际输入
fn split_user_context(text: &str) -> (String, &str) {
    let mut s = text;

    // 剥离 SQL 代码块前缀，记录是否存在
    let has_sql = s.contains("当前编辑器 SQL：");
    if let Some(pos) = s.find("\n```\n\n") {
        s = &s[pos + 6..];
    }

    // 剥离连接 ID 前缀，提取 ID 值
    let mut conn_line: Option<String> = None;
    if s.starts_with("当前数据库连接 ID:") {
        if let Some(pos) = s.find("\n\n") {
            conn_line = Some(s[..pos].trim().to_string());
            s = &s[pos + 2..];
        }
    }

    // 构建上下文摘要
    let summary = match (conn_line, has_sql) {
        (Some(conn), true)  => format!("{} | 含编辑器 SQL", conn),
        (Some(conn), false) => conn,
        (None, true)        => "含编辑器 SQL".to_string(),
        (None, false)       => String::new(),
    };

    (summary, s)
}

fn parse_opencode_messages(raw: &serde_json::Value) -> Vec<ParsedChatMessage> {
    let arr = match raw.as_array() {
        Some(a) => a,
        None => return vec![],
    };

    let mut result = Vec::new();
    for msg in arr {
        let role = msg["info"]["role"].as_str().unwrap_or("assistant");
        if role == "system" {
            continue;
        }

        let mut content = String::new();
        let mut thinking = String::new();

        if let Some(parts) = msg["parts"].as_array() {
            for part in parts {
                match part["type"].as_str().unwrap_or("") {
                    "text" => {
                        if let Some(t) = part["text"].as_str() {
                            content.push_str(t);
                        }
                    }
                    "reasoning" => {
                        if let Some(t) = part["text"].as_str() {
                            thinking.push_str(t);
                        }
                    }
                    _ => {}
                }
            }
        }

        // 跳过 tool-use only 消息（没有文本内容的 assistant 消息）
        if content.is_empty() && role != "user" {
            continue;
        }

        if role == "user" {
            // 剥离注入的上下文前缀，只保留用户实际输入
            let (_, user_input) = split_user_context(&content);
            if !user_input.is_empty() {
                result.push(ParsedChatMessage {
                    role: "user".to_string(),
                    content: user_input.to_string(),
                    thinking_content: None,
                });
            }
        } else {
            result.push(ParsedChatMessage {
                role: role.to_string(),
                content,
                thinking_content: if thinking.is_empty() { None } else { Some(thinking) },
            });
        }
    }

    // 合并相邻 assistant 消息（OpenCode 每次工具调用会产生独立 assistant turn，
    // 但流式期间前端将所有内容累积为一条消息，重载时须保持一致）
    let mut merged: Vec<ParsedChatMessage> = Vec::new();
    for msg in result {
        if msg.role == "assistant" {
            if let Some(last) = merged.last_mut() {
                if last.role == "assistant" {
                    if !msg.content.is_empty() {
                        if !last.content.is_empty() {
                            last.content.push('\n');
                        }
                        last.content.push_str(&msg.content);
                    }
                    if let Some(t) = msg.thinking_content {
                        match &mut last.thinking_content {
                            Some(existing) => {
                                existing.push('\n');
                                existing.push_str(&t);
                            }
                            None => last.thinking_content = Some(t),
                        }
                    }
                    continue;
                }
            }
        }
        merged.push(msg);
    }
    merged
}

/// 创建 agent session
/// 1. 如果 config_id 指定，获取 LLM 配置并调用 patch_config
/// 2. POST /session → 获取 session_id
/// 3. 写入 SQLite agent_sessions 表（is_temp=0）
/// 4. 返回 session_id
#[tauri::command]
pub async fn agent_create_session(
    config_id: Option<i64>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<String> {
    // 如果指定了 config_id，写入 opencode.json 并热更新
    if let Some(id) = config_id {
        let cfg = crate::db::get_llm_config_by_id(id)?
            .ok_or_else(|| AppError::Other(format!("LLM config {} not found", id)))?;
        let opencode_dir = state.app_data_dir.join("opencode");
        // 自定义模式：写入 provider 配置
        if cfg.config_mode == "custom" && !cfg.opencode_provider_id.is_empty() {
            if let Err(e) = crate::agent::config::upsert_custom_provider(
                &opencode_dir,
                &cfg.opencode_provider_id,
                &cfg.api_type,
                &cfg.base_url,
                &cfg.api_key,
            ) {
                log::warn!("[agent_create_session] upsert_custom_provider failed: {}", e);
            }
        }
        if let Err(e) = crate::agent::client::patch_config(
            state.serve_port, &cfg.model, &cfg.opencode_provider_id,
        ).await {
            log::warn!("[agent_create_session] patch_config failed: {}", e);
        }
    }

    let session_id = crate::agent::client::create_session(state.serve_port, None).await?;
    crate::db::insert_agent_session(&session_id, None, config_id, false)?;
    Ok(session_id)
}

/// 删除 agent session
/// DELETE /session/:id + 从 agent_sessions 表删除
#[tauri::command]
pub async fn agent_delete_session(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    if let Err(e) = crate::agent::client::delete_session(state.serve_port, &session_id).await {
        log::warn!("[agent_delete_session] HTTP delete failed (ignored): {}", e);
    }
    crate::db::delete_agent_session(&session_id)?;
    Ok(())
}

/// 删除所有 agent sessions（包括临时 session）
/// 逐一调用 DELETE /session/:id（忽略个别失败），清空 agent_sessions 表
#[tauri::command]
pub async fn agent_delete_all_sessions(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let records = crate::db::list_agent_sessions(true)?;
    for record in &records {
        if let Err(e) = crate::agent::client::delete_session(state.serve_port, &record.id).await {
            log::warn!("[agent_delete_all_sessions] Failed to delete session {}: {}", record.id, e);
        }
    }
    crate::db::delete_all_agent_sessions()?;
    Ok(())
}

/// 列出所有 agent sessions：优先从 OpenCode API 获取，再用 SQLite 补充 config_id / title
#[tauri::command]
pub async fn agent_list_sessions(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Vec<AgentSessionRecord>> {
    // 尝试从 OpenCode API 获取 session 列表
    let oc_result = crate::agent::client::list_sessions(state.serve_port).await;

    // 从 SQLite 获取补充信息（config_id / title）
    let db_sessions = crate::db::list_agent_sessions(false).unwrap_or_default();
    let db_map: std::collections::HashMap<String, &AgentSessionRecord> =
        db_sessions.iter().map(|r| (r.id.clone(), r)).collect();

    match oc_result {
        Ok(json) => {
            // OpenCode 返回值可能是 array 或 { sessions: [...] } 等形式，兼容处理
            let arr = if let Some(a) = json.as_array() {
                a.clone()
            } else if let Some(a) = json.get("sessions").and_then(|v| v.as_array()) {
                a.clone()
            } else {
                log::warn!("[agent_list_sessions] Unexpected OpenCode response shape, falling back to SQLite");
                return crate::db::list_agent_sessions(false);
            };

            let mut result: Vec<AgentSessionRecord> = Vec::new();
            for sess in &arr {
                let id = match sess["id"].as_str() {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => continue,
                };

                // SQLite 是 session 存在性的权威来源：不在 SQLite 中的 session（已删除）直接跳过
                let db_record = match db_map.get(&id) {
                    Some(r) => r,
                    None => continue,
                };

                // title：优先 SQLite（用户/AI 已生成），其次 OpenCode 返回值
                let title = db_record.title.clone()
                    .or_else(|| sess["title"].as_str().map(|s| s.to_string()));

                let config_id = db_record.config_id;

                // 时间戳：OpenCode 可能用 time.created / createdAt / created_at 等字段
                let created_at = sess["time"]["created"]
                    .as_i64()
                    .and_then(|ms| {
                        chrono::DateTime::<chrono::Utc>::from_timestamp(ms / 1000, 0)
                            .map(|dt| dt.to_rfc3339())
                    })
                    .or_else(|| sess["createdAt"].as_str().map(|s| s.to_string()))
                    .or_else(|| sess["created_at"].as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| db_record.created_at.clone());

                let updated_at = sess["time"]["updated"]
                    .as_i64()
                    .and_then(|ms| {
                        chrono::DateTime::<chrono::Utc>::from_timestamp(ms / 1000, 0)
                            .map(|dt| dt.to_rfc3339())
                    })
                    .or_else(|| sess["updatedAt"].as_str().map(|s| s.to_string()))
                    .or_else(|| sess["updated_at"].as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| db_record.updated_at.clone());

                result.push(AgentSessionRecord { id, title, config_id, created_at, updated_at });
            }

            log::info!("[agent_list_sessions] Loaded {} sessions from OpenCode", result.len());
            Ok(result)
        }
        Err(e) => {
            log::warn!("[agent_list_sessions] OpenCode unavailable ({}), falling back to SQLite", e);
            crate::db::list_agent_sessions(false)
        }
    }
}

/// 获取 session 消息历史，解析为前端可用的 ChatMessage 列表
/// GET /session/:id/message
#[tauri::command]
pub async fn agent_get_session_messages(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Vec<ParsedChatMessage>> {
    let raw = crate::agent::client::get_messages(state.serve_port, &session_id).await?;
    Ok(parse_opencode_messages(&raw))
}

/// 清除 session 历史（删除旧 session 并创建新 session）
/// 1. DELETE /session/:id + 从 agent_sessions 表删除
/// 2. POST /session → 获取新 session_id
/// 3. 写入 agent_sessions 表
/// 4. 返回新 session_id
#[tauri::command]
pub async fn agent_clear_session_history(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<String> {
    // 先获取旧 session 的 config_id，以便新 session 继承
    let old_records = crate::db::list_agent_sessions(true)?;
    let old_config_id = old_records.iter()
        .find(|r| r.id == session_id)
        .and_then(|r| r.config_id);

    if let Err(e) = crate::agent::client::delete_session(state.serve_port, &session_id).await {
        log::warn!("[agent_clear_session_history] HTTP delete failed (ignored): {}", e);
    }
    crate::db::delete_agent_session(&session_id)?;

    let new_id = crate::agent::client::create_session(state.serve_port, None).await?;
    crate::db::insert_agent_session(&new_id, None, old_config_id, false)?;
    Ok(new_id)
}

/// 取消（abort）agent session
/// POST /session/:id/abort
#[tauri::command]
pub async fn agent_cancel_session(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::abort_session(state.serve_port, &session_id).await
}

/// 权限请求回复
/// POST /session/:id/permissions/:permissionID { response, remember? }
#[tauri::command]
pub async fn agent_permission_respond(
    session_id: String,
    permission_id: String,
    response: String,
    remember: Option<bool>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::permission_respond(
        state.serve_port,
        &session_id,
        &permission_id,
        &response,
        remember,
    )
    .await
}

/// Reply to a question from the AI agent.
/// answers: array of arrays, e.g. [["选项1"], ["自定义输入"]]
#[tauri::command]
pub async fn agent_question_reply(
    question_id: String,
    answers: serde_json::Value,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::question_reply(state.serve_port, &question_id, answers).await
}

/// Reject a question from the AI agent.
#[tauri::command]
pub async fn agent_question_reject(
    question_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::question_reject(state.serve_port, &question_id).await
}

/// Agent 对话（Serve 模式）
/// 1. 写入 editor_sql_map 和 last_active_session_id
/// 2. 构建 prompt_text
/// 3. 获取 model 字段
/// 4. POST /session/:id/message 并解析 SSE 流 → channel
#[tauri::command]
pub async fn agent_chat(
    prompt: String,
    tab_sql: Option<String>,
    connection_id: Option<i64>,
    config_id: Option<i64>,
    session_id: String,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = agent_chat_inner(
        prompt, tab_sql, connection_id, config_id, session_id, &channel, &state,
    )
    .await;
    if let Err(ref e) = result {
        let _ = channel.send(crate::llm::StreamEvent::Error {
            message: e.to_string(),
        });
    }
    result
}

/// 新增/编辑模型配置时同步到 opencode：
/// 1. 更新 opencode.json 文件（两种模式都写）
/// 2. PATCH /config 热更新运行时 provider 配置
async fn sync_on_config_save(
    cfg: &crate::db::models::LlmConfig,
    state: &tauri::State<'_, crate::AppState>,
) {
    let opencode_dir = state.app_data_dir.join("opencode");

    let provider_id = if cfg.opencode_provider_id.is_empty() {
        cfg.api_type.clone()
    } else {
        cfg.opencode_provider_id.clone()
    };
    if provider_id.is_empty() {
        return;
    }

    // 1. 全量同步（保证同 provider 下所有 model 条目完整，含 opencode 和 custom 两种模式）
    let mut root_after_sync: Option<serde_json::Value> = None;
    match crate::db::list_llm_configs() {
        Ok(all_configs) => {
            match crate::agent::config::sync_all_providers(&opencode_dir, &all_configs) {
                Ok(root) => { root_after_sync = Some(root); }
                Err(e) => log::warn!("[sync_on_config_save] sync_all_providers failed: {}", e),
            }
        }
        Err(e) => log::warn!("[sync_on_config_save] list_llm_configs failed: {}", e),
    }

    // 2. 获取 provider 条目用于 PATCH 热更新
    let full_entry = if !cfg.opencode_provider_id.is_empty() {
        // sync_all_providers 已处理该 provider，直接从返回的 root 中提取
        root_after_sync
            .as_ref()
            .map(|r| r["provider"][&provider_id].clone())
            .filter(|v| !v.is_null())
    } else {
        // opencode_provider_id 为空，降级到 api_type，sync_all_providers 未处理，需单独 upsert
        let entry = build_provider_entry_for_json(cfg);
        match crate::agent::config::upsert_provider_entry(&opencode_dir, &provider_id, &entry) {
            Ok(provider_val) => Some(provider_val).filter(|v| !v.is_null()),
            Err(e) => { log::warn!("[sync_on_config_save] upsert_provider_entry failed: {}", e); None }
        }
    };

    // 3. PATCH /config 热更新运行时配置
    if !cfg.model.is_empty() {
        if let Some(entry) = full_entry {
            let body = serde_json::json!({ "provider": { &provider_id: entry } });
            if let Err(e) = crate::agent::client::patch_config_json(state.serve_port, &body).await {
                log::warn!("[sync_on_config_save] patch_config_json failed (ignored): {}", e);
            }
        }
    }
}

/// 构建 provider 条目（用于写入 opencode.json 或 PATCH /config）
fn build_provider_entry_for_json(cfg: &crate::db::models::LlmConfig) -> serde_json::Value {
    let npm_pkg = if cfg.api_type == "anthropic" {
        "@ai-sdk/anthropic"
    } else {
        "@ai-sdk/openai"
    };

    let effective_base_url = if cfg.api_type == "anthropic" {
        let trimmed = cfg.base_url.trim_end_matches('/');
        if trimmed.ends_with("/v1") {
            trimmed.to_string()
        } else {
            format!("{}/v1", trimmed)
        }
    } else {
        cfg.base_url.trim_end_matches('/').to_string()
    };

    // 构建 model 条目
    let display_name = if cfg.opencode_display_name.is_empty() {
        &cfg.name
    } else {
        &cfg.opencode_display_name
    };
    let mut model_entry = serde_json::json!({ "name": display_name });
    if !cfg.opencode_model_options.is_empty() {
        if let Ok(extra) = serde_json::from_str::<serde_json::Value>(&cfg.opencode_model_options) {
            if let Some(obj) = extra.as_object() {
                for (k, v) in obj {
                    model_entry[k] = v.clone();
                }
            }
        }
    }

    if cfg.config_mode == "custom" {
        serde_json::json!({
            "npm": npm_pkg,
            "options": { "apiKey": cfg.api_key, "baseURL": effective_base_url },
            "models": { &cfg.model: model_entry }
        })
    } else {
        // opencode 预定义 provider：只更新 apiKey 和 model 选项
        serde_json::json!({
            "options": { "apiKey": cfg.api_key },
            "models": { &cfg.model: model_entry }
        })
    }
}

/// 将 LLM 配置应用到 opencode（写入自定义供应商文件 + 热更新模型/供应商）。
/// 返回 (model, effective_provider_id)。
/// 当 opencode_provider_id 为空时降级到 api_type，保持对旧配置的向后兼容。
async fn apply_llm_config_to_opencode(
    cfg: &crate::db::models::LlmConfig,
    state: &tauri::State<'_, crate::AppState>,
) -> (String, String) {
    let effective_provider = if cfg.opencode_provider_id.is_empty() {
        cfg.api_type.clone()
    } else {
        cfg.opencode_provider_id.clone()
    };

    if cfg.config_mode == "custom" && !effective_provider.is_empty() {
        let opencode_dir = state.app_data_dir.join("opencode");
        if let Err(e) = crate::agent::config::upsert_custom_provider(
            &opencode_dir,
            &effective_provider,
            &cfg.api_type,
            &cfg.base_url,
            &cfg.api_key,
        ) {
            log::warn!("[apply_llm_config] upsert_custom_provider failed: {}", e);
        }
    }

    if !cfg.model.is_empty() && !effective_provider.is_empty() {
        // 写入 opencode.json（深合并保留已有 npm/baseURL/其他 models），返回值即完整 provider 条目
        let opencode_dir = state.app_data_dir.join("opencode");
        let entry = build_provider_entry_for_json(cfg);
        match crate::agent::config::upsert_provider_entry(&opencode_dir, &effective_provider, &entry) {
            Ok(full_entry) => {
                if !full_entry.is_null() {
                    let body = serde_json::json!({ "provider": { &effective_provider: full_entry } });
                    if let Err(e) = crate::agent::client::patch_config_json(state.serve_port, &body).await {
                        log::warn!("[apply_llm_config] patch_config_json failed: {}", e);
                    }
                }
            }
            Err(e) => log::warn!("[apply_llm_config] upsert_provider_entry failed: {}", e),
        }

        if let Err(e) = crate::agent::client::patch_config(
            state.serve_port, &cfg.model, &effective_provider,
        ).await {
            log::warn!("[apply_llm_config] patch_config failed: {}", e);
        }
    }

    (cfg.model.clone(), effective_provider)
}

async fn agent_chat_inner(
    prompt: String,
    tab_sql: Option<String>,
    connection_id: Option<i64>,
    config_id: Option<i64>,
    session_id: String,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    // 1. 写入编辑器 SQL 到 per-session map，并更新 last_active_session_id
    {
        let mut map = state.editor_sql_map.lock().await;
        map.insert(session_id.clone(), tab_sql.clone());
    }
    {
        let mut last = state.last_active_session_id.lock().await;
        *last = Some(session_id.clone());
    }

    // 2. 构建 prompt 文本（复用现有逻辑）
    let mut prompt_text = prompt;
    if let Some(conn_id) = connection_id {
        prompt_text = format!("当前数据库连接 ID: {}\n\n{}", conn_id, prompt_text);
    }
    if let Some(ref sql) = tab_sql {
        if !sql.trim().is_empty() {
            prompt_text = format!(
                "当前编辑器 SQL：\n```sql\n{}\n```\n\n{}",
                sql, prompt_text
            );
        }
    }

    // 3. 获取 model/provider 字段，并确保 opencode 配置正确（含 API Key 热写入）
    let (model_str, provider_str) = match config_id {
        Some(id) => {
            let cfg = crate::db::get_llm_config_by_id(id)?
                .ok_or_else(|| AppError::Other(format!("LLM config {} not found", id)))?;
            apply_llm_config_to_opencode(&cfg, state).await
        }
        None => {
            match crate::db::get_default_llm_config()? {
                Some(cfg) => apply_llm_config_to_opencode(&cfg, state).await,
                None => (String::new(), String::new()),
            }
        }
    };

    // 4. 通过 /event SSE 实现真正流式（先订阅 SSE，再后台发消息）
    let model_opt = if model_str.is_empty() { None } else { Some(model_str.as_str()) };
    let provider_opt = if provider_str.is_empty() { None } else { Some(provider_str.as_str()) };
    crate::agent::stream::stream_global_events(
        state.serve_port,
        &session_id,
        &prompt_text,
        model_opt,
        provider_opt,
        None,
        channel,
    )
    .await
}

/// 请求 AI 生成标题（使用临时 session）
/// 1. POST /session { title: "temp-title" } → 临时 session_id，is_temp=1
/// 2. 发送单条消息（根据 context 生成标题）
/// 3. 收集 SSE 流的所有 ContentChunk 合并为完整文本
/// 4. DELETE /session/:id（finally 路径）
/// 5. 返回标题文本
#[tauri::command]
pub async fn agent_request_ai_title(
    session_id: String,
    context: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<String> {
    let _ = session_id; // 仅用于上下文，不直接使用

    // 1. 创建临时 session
    let temp_id = crate::agent::client::create_session(state.serve_port, Some("temp-title")).await?;
    crate::db::insert_agent_session(&temp_id, Some("temp-title"), None, true)?;

    // 2. 发送消息
    let prompt = format!(
        "请根据以下内容，生成一个简洁的对话标题，不超过20个字，只返回标题文本，不要解释：\n\n{}",
        context
    );

    // 3. 通过 /event SSE 收集完整回复（标题生成，无需流式显示）
    let title = crate::agent::stream::collect_text_via_global_events(
        state.serve_port,
        &temp_id,
        &prompt,
        None,
        None,
    )
    .await
    .unwrap_or_default();

    // 4. 清理临时 session（finally 路径）
    if let Err(e) = crate::agent::client::delete_session(state.serve_port, &temp_id).await {
        log::warn!("[agent_request_ai_title] Failed to delete temp session: {}", e);
    }
    let _ = crate::db::delete_agent_session(&temp_id);

    // 5. 返回标题
    Ok(title.trim().to_string())
}


/// 应用 LLM 配置到 opencode serve（写盘 + 热更新）
#[tauri::command]
pub async fn agent_apply_config(
    config_id: i64,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let cfg = crate::db::get_llm_config_by_id(config_id)?
        .ok_or_else(|| AppError::Other(format!("LLM config {} not found", config_id)))?;

    let opencode_dir = state.app_data_dir.join("opencode");

    // 自定义模式：先写入 opencode.json 的 provider 配置
    if cfg.config_mode == "custom" && !cfg.opencode_provider_id.is_empty() {
        if let Err(e) = crate::agent::config::upsert_custom_provider(
            &opencode_dir,
            &cfg.opencode_provider_id,
            &cfg.api_type,
            &cfg.base_url,
            &cfg.api_key,
        ) {
            log::warn!("[agent_apply_config] upsert_custom_provider failed: {}", e);
        }
    }

    // 两种模式统一用 opencode_provider_id 热更新
    if let Err(e) = crate::agent::client::patch_config(
        state.serve_port, &cfg.model, &cfg.opencode_provider_id,
    ).await {
        log::warn!("[agent_apply_config] patch_config failed (ignored): {}", e);
    }

    Ok(())
}

// ── OpenCode Provider 类型（用于 agent_list_providers 命令）──────────────
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeProviderModel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeProvider {
    pub id: String,
    pub name: String,
    pub source: String,
    pub models: Vec<OpenCodeProviderModel>,
}

/// 从 opencode serve 获取可用供应商和模型列表。
/// 失败时返回空列表（opencode 未运行时降级）。
#[tauri::command]
pub async fn agent_list_providers(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Vec<OpenCodeProvider>> {
    let port = state.serve_port;
    let url = format!("http://127.0.0.1:{}/config/providers", port);
    let client = reqwest::Client::new();
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[agent_list_providers] Request failed (opencode not running?): {}", e);
            return Ok(vec![]);
        }
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[agent_list_providers] Failed to parse response: {}", e);
            return Ok(vec![]);
        }
    };
    let arr = match json["providers"].as_array() {
        Some(a) => a.clone(),
        None => {
            log::warn!("[agent_list_providers] Unexpected response format (no 'providers' array)");
            return Ok(vec![]);
        }
    };
    let providers = arr.into_iter().filter_map(|p| {
        let id = p["id"].as_str()?.to_string();
        let name = p["name"].as_str().unwrap_or(&id).to_string();
        let source = p["source"].as_str().unwrap_or("").to_string();
        let models = p["models"].as_object()
            .map(|m| m.iter().map(|(k, v)| OpenCodeProviderModel {
                id: k.clone(),
                name: v["name"].as_str().unwrap_or(k).to_string(),
            }).collect::<Vec<_>>())
            .unwrap_or_default();
        Some(OpenCodeProvider { id, name, source, models })
    }).collect();
    Ok(providers)
}

/// 无状态连接测试，直接接收配置参数，不写 DB。
/// 仅适用于自定义模式（opencode 模式无需 api_key，opencode 自行管理认证）。
#[tauri::command]
pub async fn test_llm_config_inline(
    model: String,
    api_type: String,
    base_url: String,
    api_key: String,
) -> AppResult<()> {
    let parsed_api_type = parse_api_type(&api_type);
    let client = crate::llm::client::LlmClient::new(
        api_key,
        Some(base_url),
        Some(model),
        Some(parsed_api_type),
    );
    let messages = vec![crate::llm::ChatMessage {
        role: "user".into(),
        content: "hi".into(),
    }];
    client.chat(messages).await.map(|_| ())
}


// === SQL 解释/优化（新版，使用 serve 模式临时 session）===

/// 辅助函数：清理临时 explain/optimize session（abort + delete HTTP + delete DB）
async fn cleanup_temp_sql_session(port: u16, session_id: &str) {
    let _ = crate::agent::client::abort_session(port, session_id).await;
    let _ = crate::agent::client::delete_session(port, session_id).await;
    let _ = crate::db::delete_agent_session(session_id);
}

#[tauri::command]
pub async fn agent_explain_sql(
    sql: String,
    connection_id: Option<i64>,
    database: Option<String>,
    channel: tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let result = agent_explain_sql_inner(sql, connection_id, database, &channel, &state).await;
    if let Err(ref e) = result {
        let _ = channel.send(crate::llm::StreamEvent::Error { message: e.to_string() });
    }
    result
}

async fn agent_explain_sql_inner(
    sql: String,
    connection_id: Option<i64>,
    database: Option<String>,
    channel: &tauri::ipc::Channel<crate::llm::StreamEvent>,
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let port = state.serve_port;

    // 1. 并发处理：若上次请求仍在进行，先 abort 旧 session
    {
        let mut guard = state.current_explain_session_id.lock().await;
        if let Some(old_id) = guard.take() {
            log::info!("[agent_explain_sql] Aborting previous explain session: {}", old_id);
            cleanup_temp_sql_session(port, &old_id).await;
        }
    }

    // 2. 获取当前 LLM 配置
    let config = crate::db::get_default_llm_config()?
        .ok_or_else(|| AppError::Other("No default LLM config found".into()))?;

    // 3. 构建 prompt_text（与旧版格式相同）
    let conn_context = if let Some(conn_id) = connection_id {
        let driver = crate::db::get_connection_config(conn_id)
            .map(|c| c.driver)
            .unwrap_or_else(|_| "mysql".to_string());
        let db_line = match &database {
            Some(db) if !db.is_empty() => format!("当前数据库: {}\n", db),
            _ => String::new(),
        };
        format!("当前数据库连接 ID: {}\n数据库类型: {}\n{}\n", conn_id, driver, db_line)
    } else {
        String::new()
    };
    let prompt_text = format!("{}请分析以下 SQL：\n\n{}", conn_context, sql);

    // 4. 创建临时 session，写入 agent_sessions(is_temp=1)
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let title = format!("sql-explain-{}", ts);
    let session_id = crate::agent::client::create_session(port, Some(&title)).await?;
    crate::db::insert_agent_session(&session_id, Some(&title), None, true)?;

    // 5. 存入 AppState
    {
        let mut guard = state.current_explain_session_id.lock().await;
        *guard = Some(session_id.clone());
    }

    // 6. 通过 /event SSE 流式输出（先订阅 SSE，再后台发消息）
    let (model_str, provider_str) = apply_llm_config_to_opencode(&config, state).await;
    let model_opt = if model_str.is_empty() { None } else { Some(model_str.as_str()) };
    let provider_opt = if provider_str.is_empty() { None } else { Some(provider_str.as_str()) };
    let stream_result = crate::agent::stream::stream_global_events(
        port,
        &session_id,
        &prompt_text,
        model_opt,
        provider_opt,
        Some("sql-explain"),
        channel,
    )
    .await;

    // 8. finally 路径：无论成功/失败，清理 session
    cleanup_temp_sql_session(port, &session_id).await;
    {
        let mut guard = state.current_explain_session_id.lock().await;
        if guard.as_deref() == Some(&session_id) {
            *guard = None;
        }
    }

    stream_result
}

#[tauri::command]
pub async fn cancel_explain_sql(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    let session_id = {
        let mut guard = state.current_explain_session_id.lock().await;
        guard.take()
    };
    if let Some(id) = session_id {
        log::info!("[cancel_explain_sql] Cancelling explain session: {}", id);
        // 忽略错误：取消操作失败不影响后续使用
        cleanup_temp_sql_session(state.serve_port, &id).await;
    }
    Ok(())
}

// ============ Agent Session 操作（undo / redo / compact）============

/// 撤销最后一轮对话
#[tauri::command]
pub async fn agent_revert_message(
    session_id: String,
    message_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::revert_message(state.serve_port, &session_id, &message_id).await
}

/// 恢复被撤销的对话
#[tauri::command]
pub async fn agent_unrevert_message(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::unrevert_message(state.serve_port, &session_id).await
}

/// 压缩会话 context
#[tauri::command]
pub async fn agent_summarize_session(
    session_id: String,
    model_id: String,
    provider_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<()> {
    crate::agent::client::summarize_session(state.serve_port, &session_id, &provider_id, &model_id).await
}

/// 获取最后一条 user 消息的 ID
/// GET /session/:id/message → 找最后一条 role=="user" 的顶层 id 字段
#[tauri::command]
pub async fn agent_get_last_user_message_id(
    session_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<String> {
    let json = crate::agent::client::get_messages(state.serve_port, &session_id).await?;
    let arr = json
        .as_array()
        .ok_or_else(|| crate::AppError::Other("get_messages: expected array".into()))?;
    let last_user_id = arr
        .iter()
        .rev()
        .find(|msg| msg.get("role").and_then(|r| r.as_str()) == Some("user"))
        .and_then(|msg| msg.get("id").and_then(|id| id.as_str()))
        .ok_or_else(|| crate::AppError::Other("No user message found".into()))?
        .to_string();
    Ok(last_user_id)
}

// ─── 虚拟关系手动编辑命令 ──────────────────────────────────────────────────

#[tauri::command]
pub async fn add_user_node(
    connection_id: i64,
    name: String,
    display_name: Option<String>,
    node_type: String,
) -> AppResult<String> {
    let allowed_types = ["table", "metric", "alias"];
    if !allowed_types.contains(&node_type.as_str()) {
        return Err(crate::AppError::Other(format!(
            "node_type '{}' 不允许手动创建，仅支持: table, metric, alias", node_type
        )));
    }
    let node_id = format!("{}:user:{}:{}", connection_id, node_type, name);
    let disp = display_name.unwrap_or_else(|| name.clone());
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "INSERT INTO graph_nodes (id, node_type, connection_id, name, display_name, source, is_deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, 'user', 0)
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, is_deleted = 0",
        rusqlite::params![node_id, node_type, connection_id, name, disp],
    )?;
    Ok(node_id)
}

#[tauri::command]
pub async fn delete_graph_node(node_id: String) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let source: Option<String> = conn.query_row(
        "SELECT source FROM graph_nodes WHERE id = ?1",
        [&node_id],
        |r| r.get(0),
    ).ok();
    match source.as_deref() {
        Some("user") => {
            // 软删除节点
            conn.execute(
                "UPDATE graph_nodes SET is_deleted = 1 WHERE id = ?1",
                [&node_id],
            )?;
            // 物理删除该节点相关的 user/comment 边（避免悬空边）
            conn.execute(
                "DELETE FROM graph_edges
                 WHERE (from_node = ?1 OR to_node = ?1)
                   AND source IN ('user', 'comment')",
                [&node_id],
            )?;
            Ok(())
        }
        Some(s) => Err(crate::AppError::Other(format!(
            "节点 source='{}' 不允许删除，仅允许删除 source='user' 节点", s
        ))),
        None => Err(crate::AppError::Other(format!("节点 '{}' 不存在", node_id))),
    }
}

#[tauri::command]
pub async fn add_user_edge(
    from_node: String,
    to_node: String,
    edge_type: String,
    weight: Option<f64>,
) -> AppResult<String> {
    let allowed_edge_types = ["join_path", "user_defined"];
    if !allowed_edge_types.contains(&edge_type.as_str()) {
        return Err(crate::AppError::Other(format!(
            "edge_type '{}' 不合法，允许值: join_path, user_defined", edge_type
        )));
    }
    let w = weight.unwrap_or(1.0);
    let edge_id = format!("{}=>{}:user", from_node, to_node);
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "INSERT INTO graph_edges (id, from_node, to_node, edge_type, weight, source)
         VALUES (?1, ?2, ?3, ?4, ?5, 'user')
         ON CONFLICT(id) DO UPDATE SET edge_type = excluded.edge_type, weight = excluded.weight",
        rusqlite::params![edge_id, from_node, to_node, edge_type, w],
    )?;
    Ok(edge_id)
}

#[tauri::command]
pub async fn delete_graph_edge(edge_id: String) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let source: Option<String> = conn.query_row(
        "SELECT source FROM graph_edges WHERE id = ?1",
        [&edge_id],
        |r| r.get(0),
    ).ok();
    match source.as_deref() {
        Some("user") | Some("comment") => {
            conn.execute("DELETE FROM graph_edges WHERE id = ?1", [&edge_id])?;
            Ok(())
        }
        Some(s) => Err(crate::AppError::Other(format!(
            "边 source='{}' 不允许删除，仅允许 source='user' 或 'comment'", s
        ))),
        None => Err(crate::AppError::Other(format!("边 '{}' 不存在", edge_id))),
    }
}

#[tauri::command]
pub async fn update_graph_edge(
    edge_id: String,
    edge_type: Option<String>,
    weight: Option<f64>,
) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let source: Option<String> = conn.query_row(
        "SELECT source FROM graph_edges WHERE id = ?1",
        [&edge_id],
        |r| r.get(0),
    ).ok();
    match source.as_deref() {
        Some("user") | Some("comment") => {
            let is_comment = source.as_deref() == Some("comment");
            if is_comment && edge_type.is_some() {
                return Err(crate::AppError::Other(
                    "comment 来源的边不允许修改 edge_type".to_string()
                ));
            }
            if let Some(ref et) = edge_type {
                let allowed = ["join_path", "user_defined"];
                if !allowed.contains(&et.as_str()) {
                    return Err(crate::AppError::Other(format!(
                        "edge_type '{}' 不合法", et
                    )));
                }
            }
            // 使用事务确保两次 UPDATE 的原子性
            conn.execute_batch("BEGIN")?;
            let result = (|| -> AppResult<()> {
                if let Some(ref et) = edge_type {
                    conn.execute(
                        "UPDATE graph_edges SET edge_type = ?1 WHERE id = ?2",
                        rusqlite::params![et, edge_id],
                    )?;
                }
                if let Some(w) = weight {
                    conn.execute(
                        "UPDATE graph_edges SET weight = ?1 WHERE id = ?2",
                        rusqlite::params![w, edge_id],
                    )?;
                }
                Ok(())
            })();
            match &result {
                Ok(_)  => { let _ = conn.execute_batch("COMMIT"); }
                Err(_) => { let _ = conn.execute_batch("ROLLBACK"); }
            }
            result
        }
        Some(s) => Err(crate::AppError::Other(format!(
            "边 source='{}' 不允许修改", s
        ))),
        None => Err(crate::AppError::Other(format!("边 '{}' 不存在", edge_id))),
    }
}

// ============ 图谱路径查询 ============

#[tauri::command]
pub async fn find_subgraph(
    _app: tauri::AppHandle,
    connection_id: i64,
    from_node_id: String,
    to_node_id: String,
    max_hops: u8,
) -> AppResult<crate::graph::query::SubGraph> {
    // 1. 查询起点节点
    let (from_type, from_name): (String, String) = {
        let conn = crate::db::get().lock().unwrap();
        conn.query_row(
            "SELECT node_type, name FROM graph_nodes WHERE id=?1 AND is_deleted=0",
            [&from_node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| AppError::Other(format!("节点 {} 不存在", from_node_id)))?
    };

    // 2. 查询终点节点
    let (to_type, to_name): (String, String) = {
        let conn = crate::db::get().lock().unwrap();
        conn.query_row(
            "SELECT node_type, name FROM graph_nodes WHERE id=?1 AND is_deleted=0",
            [&to_node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| AppError::Other(format!("节点 {} 不存在", to_node_id)))?
    };

    // 3. 限制：仅支持 table 节点
    if from_type != "table" || to_type != "table" {
        return Err(AppError::Other(
            "路径查询仅支持表节点（node_type='table'）".to_string(),
        ));
    }

    // 4. 复用现有 BFS + LRU 缓存
    let entities = vec![from_name, to_name];
    crate::graph::query::find_relevant_subgraph(connection_id, &entities, max_hops).await
}

// ============ 多数据源扩展命令 ============

/// 返回驱动能力声明，前端用于控制 DBTree 菜单显隐
#[tauri::command]
pub async fn get_driver_capabilities(connection_id: i64) -> AppResult<DriverCapabilities> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::pool_cache::get_or_create(connection_id, &config, "", "").await?;
    Ok(ds.capabilities())
}

/// 返回库级 + 表级统计信息，用于性能监控图表
#[tauri::command]
pub async fn get_db_stats(connection_id: i64, database: Option<String>) -> AppResult<DbStats> {
    let config = crate::db::get_connection_config(connection_id)?;
    let db = database.as_deref().unwrap_or("");
    let ds = crate::datasource::pool_cache::get_or_create(connection_id, &config, db, "").await?;
    ds.get_db_stats(database.as_deref()).await
}

/// 读取文本文件内容（用于 JSON 导入）
#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    std::fs::read_to_string(&path).map_err(|e| crate::error::AppError::Other(e.to_string()))
}
