pub mod context_builder;
pub mod entity_extract;
pub mod sql_validator;

pub use entity_extract::extract_entities;
pub use context_builder::build_sql_context;
pub use sql_validator::validate_sql;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SqlContext {
    pub relevant_tables: Vec<String>,
    pub join_paths: Vec<String>,
    pub metrics: Vec<String>,
    pub schema_ddl: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextToSqlResult {
    pub sql: String,
    /// 图谱上下文；图谱为空或无命中时为 None
    pub graph_context: Option<SqlContext>,
    pub validation_ok: bool,
    pub validation_warning: Option<String>,
}

/// 检查指定连接的 graph_nodes 是否已填充（图谱是否已构建）
fn graph_is_empty(connection_id: i64) -> bool {
    let conn = match crate::db::get().lock() {
        Ok(c) => c,
        Err(_) => return true,
    };
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM graph_nodes WHERE connection_id=?1 AND is_deleted=0",
            [connection_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    count == 0
}

/// 降级策略12：图谱为空时，回退到旧 ai_generate_sql 的行为（直接注入 schema 表名列表）
async fn generate_sql_legacy(
    question: &str,
    connection_id: i64,
    history: &[crate::llm::ChatMessage],
) -> crate::AppResult<TextToSqlResult> {
    let client = entity_extract::build_llm_client()?;

    // 与旧 ai_generate_sql 一致：从 datasource 获取所有表名
    let conn_config = crate::db::get_connection_config(connection_id)?;
    let schema_context = match crate::datasource::create_datasource(&conn_config).await {
        Ok(ds) => match ds.get_schema().await {
            Ok(schema) => schema
                .tables
                .iter()
                .map(|t| format!("Table: {}", t.name))
                .collect::<Vec<_>>()
                .join("\n"),
            Err(_) => String::new(),
        },
        Err(_) => String::new(),
    };

    let sql = client
        .generate_sql(question, &schema_context, &conn_config.driver)
        .await
        .map_err(|e| { log::warn!("[pipeline] LLM call failed: {}", e); e })?;

    // 包装成 TextToSqlResult，graph_context 为 None（图谱尚未构建）
    let warning = validate_sql(&sql, &conn_config.driver).unwrap_or(None);
    Ok(TextToSqlResult {
        validation_ok: warning.is_none(),
        validation_warning: warning,
        sql,
        graph_context: None,
    })
}

pub async fn generate_sql_v2(
    question: &str,
    connection_id: i64,
    history: &[crate::llm::ChatMessage],
) -> crate::AppResult<TextToSqlResult> {
    // 降级策略12：图谱为空时直接走旧逻辑
    if graph_is_empty(connection_id) {
        return generate_sql_legacy(question, connection_id, history).await;
    }

    // 1. LLM 提取实体（失败时返回空）
    let entity_keywords = extract_entities(question, connection_id).await
        .unwrap_or_default();

    // 降级策略10：实体提取失败或返回空时，用 question 分词作关键词做 FTS5 匹配
    let effective_keywords = if entity_keywords.is_empty() {
        question
            .split_whitespace()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
    } else {
        entity_keywords
    };

    // 2. 组装上下文（内含降级策略11：无命中时注入直接 Schema）
    let context = build_sql_context(connection_id, &effective_keywords).await?;

    // 3. 构建高质量 Prompt
    let system_prompt = build_system_prompt(&context);

    // 4. 获取 LLM client
    let client = entity_extract::build_llm_client()?;

    let mut messages = vec![
        crate::llm::ChatMessage { role: "system".into(), content: system_prompt }
    ];
    messages.extend_from_slice(history);
    messages.push(crate::llm::ChatMessage {
        role: "user".into(),
        content: question.to_string(),
    });

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client.chat(messages),
    )
    .await
    .map_err(|_| { log::warn!("[pipeline] LLM timeout"); crate::AppError::Other("LLM request timeout".into()) })?
    .map_err(|e| { log::warn!("[pipeline] LLM error: {}", e); e })?;

    // 5. 提取 SQL
    let sql = extract_sql_from_response(&response);

    // 6. 语法校验
    let conn_config = crate::db::get_connection_config(connection_id)?;
    let warning = validate_sql(&sql, &conn_config.driver).unwrap_or(None);

    // graph_context 为 None 当图谱检索无命中（relevant_tables 为空且无 schema_ddl）
    let graph_context = if context.relevant_tables.is_empty()
        && context.join_paths.is_empty()
        && context.metrics.is_empty()
    {
        None
    } else {
        Some(context)
    };

    Ok(TextToSqlResult {
        validation_ok: warning.is_none(),
        validation_warning: warning,
        sql,
        graph_context,
    })
}

fn build_system_prompt(ctx: &SqlContext) -> String {
    let mut prompt = "你是一个 SQL 专家。根据用户问题生成精准的 SQL 查询。\n\n".to_string();
    if !ctx.schema_ddl.is_empty() {
        prompt.push_str("## 相关表结构\n");
        prompt.push_str(&ctx.schema_ddl);
        prompt.push('\n');
    }
    if !ctx.join_paths.is_empty() {
        prompt.push_str("## 推断的 JOIN 路径\n");
        for p in &ctx.join_paths { prompt.push_str(&format!("- {}\n", p)); }
        prompt.push('\n');
    }
    if !ctx.metrics.is_empty() {
        prompt.push_str("## 业务指标定义\n");
        for m in &ctx.metrics { prompt.push_str(&format!("- {}\n", m)); }
        prompt.push('\n');
    }
    prompt.push_str("只返回 SQL，不要解释。用 ```sql ``` 包裹。");
    prompt
}

fn extract_sql_from_response(response: &str) -> String {
    if let Some(start_marker) = response.find("```sql") {
        let after_marker = &response[start_marker + 6..];
        let content_start = after_marker
            .find('\n')
            .map(|i| start_marker + 6 + i + 1)
            .unwrap_or(start_marker + 6);
        if let Some(end_offset) = response[content_start..].find("```") {
            return response[content_start..content_start + end_offset].trim().to_string();
        }
    }
    if let Some(start_marker) = response.find("```") {
        let after_marker = &response[start_marker + 3..];
        let content_start = after_marker
            .find('\n')
            .map(|i| start_marker + 3 + i + 1)
            .unwrap_or(start_marker + 3);
        if let Some(end_offset) = response[content_start..].find("```") {
            return response[content_start..content_start + end_offset].trim().to_string();
        }
    }
    response.trim().to_string()
}
