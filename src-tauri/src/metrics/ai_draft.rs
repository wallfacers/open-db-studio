use serde::Serialize;
use super::crud::{CreateMetricInput, save_metric};

// ─── 事件结构 ───────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct BgTaskLogEvent {
    task_id: String,
    level: String,       // "info" | "warn" | "error"
    message: String,
    timestamp_ms: u64,
}

#[derive(Serialize, Clone)]
struct BgTaskDoneEvent {
    task_id: String,
    success: bool,
    error: Option<String>,
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    metric_count: Option<usize>,
    skipped_count: Option<usize>,
}

// ─── 辅助：emit 日志 ─────────────────────────────────────────────────────────

fn emit_log(app: &tauri::AppHandle, task_id: &str, level: &str, message: &str) {
    use tauri::Emitter;
    let _ = app.emit("bg_task_log", BgTaskLogEvent {
        task_id: task_id.to_string(),
        level: level.to_string(),
        message: message.to_string(),
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    });
}

// ─── LLM client builder ──────────────────────────────────────────────────────

fn build_llm_client() -> crate::AppResult<crate::llm::LlmClient> {
    let config = crate::db::get_default_llm_config()?
        .ok_or_else(|| crate::AppError::Other("No AI model configured".into()))?;
    let api_type = match config.api_type.as_str() {
        "anthropic" => crate::llm::ApiType::Anthropic,
        _ => crate::llm::ApiType::Openai,
    };
    Ok(crate::llm::LlmClient::new(
        config.api_key,
        Some(config.base_url),
        Some(config.model),
        Some(api_type),
    ))
}

// ─── 公开入口：无返回值，错误通过 emit 传递 ──────────────────────────────────

pub async fn generate_metric_drafts(
    app_handle: tauri::AppHandle,
    task_id: String,
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    table_names: Vec<String>,
) {
    if let Err(e) = do_generate(
        &app_handle,
        &task_id,
        connection_id,
        database.clone(),
        schema.clone(),
        table_names,
    )
    .await
    {
        use tauri::Emitter;
        emit_log(&app_handle, &task_id, "error", &format!("{}", e));
        let _ = app_handle.emit(
            "bg_task_done",
            BgTaskDoneEvent {
                task_id: task_id.clone(),
                success: false,
                error: Some(e.to_string()),
                connection_id,
                database,
                schema,
                metric_count: None,
                skipped_count: None,
            },
        );
    }
}

// ─── 主逻辑 ──────────────────────────────────────────────────────────────────

async fn do_generate(
    app: &tauri::AppHandle,
    task_id: &str,
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    table_names: Vec<String>,
) -> crate::AppResult<()> {
    use tauri::Emitter;

    // 1. 读取连接配置
    let config = crate::db::get_connection_config(connection_id)?;
    emit_log(
        app,
        task_id,
        "info",
        &format!("连接数据库 {} ({})", config.database, config.driver),
    );

    // 2. 创建数据源
    let ds = crate::datasource::create_datasource_with_context(
        &config,
        database.as_deref(),
        schema.as_deref(),
    )
    .await?;

    // 3. 确定要处理的表列表
    let tables_to_process: Vec<String> = if table_names.is_empty() {
        let schema_info = ds.get_schema().await?;
        schema_info.tables.into_iter().map(|t| t.name).collect()
    } else {
        table_names
    };

    // 4. 串行拉取每张表的字段（datasource 不支持 Clone）
    let mut schema_desc = String::new();
    let mut total_cols = 0usize;

    let mut col_counts: Vec<(String, usize)> = Vec::new();
    for table_name in &tables_to_process {
        let cols = ds
            .get_columns(table_name, schema.as_deref())
            .await
            .unwrap_or_default();
        let n = cols.len();
        total_cols += n;
        col_counts.push((table_name.clone(), n));

        schema_desc.push_str(&format!("表: {}\n", table_name));
        for col in &cols {
            schema_desc.push_str(&format!(
                "  - {} {} {}\n",
                col.name,
                col.data_type,
                if col.is_primary_key { "(PK)" } else { "" }
            ));
        }
    }

    // 构造日志：读取字段日志
    let col_summary = col_counts
        .iter()
        .map(|(n, c)| format!("{} ({}列)", n, c))
        .collect::<Vec<_>>()
        .join(", ");
    emit_log(
        app,
        task_id,
        "info",
        &format!("读取字段：{}", col_summary),
    );

    // 5. 构建 Prompt
    let prompt = format!(
        r#"你是一个数据分析专家。根据以下数据库 Schema，推断出 3-8 个最有业务价值的指标。

Schema:
{}

请以 JSON 数组格式返回，每个元素包含：
- name: 英文标识（蛇形命名）
- display_name: 中文名称
- table_name: 来源表名
- column_name: 来源字段名（COUNT 时可为空）
- aggregation: SUM/COUNT/AVG/MAX/MIN
- description: 业务含义（一句话）

只返回 JSON 数组，不要其他内容。"#,
        schema_desc
    );

    emit_log(
        app,
        task_id,
        "info",
        &format!(
            "Prompt 构建完成（共 {} 张表，{} 个字段）",
            tables_to_process.len(),
            total_cols
        ),
    );

    // 6. 调用 LLM
    let llm_config = crate::db::get_default_llm_config()?
        .ok_or_else(|| crate::AppError::Other("No AI model configured".into()))?;
    let model_name = llm_config.model.clone();

    emit_log(
        app,
        task_id,
        "info",
        &format!("调用 AI 模型 {}，等待响应...", model_name),
    );

    let client = build_llm_client()?;
    let messages = vec![crate::llm::ChatMessage {
        role: "user".into(),
        content: prompt,
    }];
    let response = client.chat(messages).await?;

    // 7. 解析 JSON 响应
    #[derive(serde::Deserialize)]
    struct DraftItem {
        name: String,
        display_name: String,
        table_name: String,
        column_name: Option<String>,
        aggregation: Option<String>,
        description: Option<String>,
    }

    let json_str = extract_json(&response);
    let items: Vec<DraftItem> = serde_json::from_str(&json_str)
        .map_err(|e| crate::AppError::Other(format!("LLM 返回格式错误: {}", e)))?;

    emit_log(
        app,
        task_id,
        "info",
        &format!("解析到 {} 个指标草稿", items.len()),
    );

    // 8. 逐条去重后写入
    let total = items.len();
    let mut saved_count = 0usize;
    let mut skipped_count = 0usize;

    for (idx, item) in items.into_iter().enumerate() {
        let pos = idx + 1;

        // 去重查询（使用 NULL 安全比较）
        let exists = {
            let conn = crate::db::get().lock().unwrap();
            let result: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM metrics \
                     WHERE connection_id=?1 \
                       AND table_name=?2 \
                       AND name=?3 \
                       AND (column_name=?4 OR (column_name IS NULL AND ?4 IS NULL)) \
                       AND (aggregation=?5 OR (aggregation IS NULL AND ?5 IS NULL)) \
                       AND (scope_database=?6 OR (scope_database IS NULL AND ?6 IS NULL)) \
                       AND (scope_schema=?7 OR (scope_schema IS NULL AND ?7 IS NULL))",
                    rusqlite::params![
                        connection_id,
                        item.table_name,
                        item.name,
                        item.column_name,
                        item.aggregation,
                        database,
                        schema,
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0;
            // 重要：显式释放锁，避免后续 save_metric 死锁
            drop(conn);
            result
        };

        if exists {
            emit_log(
                app,
                task_id,
                "warn",
                &format!(
                    "跳过 {}/{}：{} — 已存在相同指标",
                    pos, total, item.display_name
                ),
            );
            skipped_count += 1;
            continue;
        }

        let input = CreateMetricInput {
            connection_id,
            name: item.name.clone(),
            display_name: item.display_name.clone(),
            table_name: Some(item.table_name),
            column_name: item.column_name,
            aggregation: item.aggregation,
            filter_sql: None,
            description: item.description,
            source: Some("ai".into()),
            metric_type: None,
            composite_components: None,
            composite_formula: None,
            category: None,
            data_caliber: None,
            version: None,
            scope_database: database.clone(),
            scope_schema: schema.clone(),
        };

        match save_metric(&input) {
            Ok(_) => {
                emit_log(
                    app,
                    task_id,
                    "info",
                    &format!(
                        "保存 {}/{}：{} ({})",
                        pos, total, item.display_name, item.name
                    ),
                );
                saved_count += 1;
            }
            Err(e) => {
                emit_log(
                    app,
                    task_id,
                    "warn",
                    &format!(
                        "保存 {}/{} 失败：{} — {}",
                        pos, total, item.display_name, e
                    ),
                );
                skipped_count += 1;
            }
        }
    }

    // 9. 完成
    emit_log(
        app,
        task_id,
        "info",
        &format!("✅ 完成，新增 {} 个，跳过 {} 个重复", saved_count, skipped_count),
    );

    let _ = app.emit(
        "bg_task_done",
        BgTaskDoneEvent {
            task_id: task_id.to_string(),
            success: true,
            error: None,
            connection_id,
            database,
            schema,
            metric_count: Some(saved_count),
            skipped_count: Some(skipped_count),
        },
    );

    Ok(())
}

// ─── JSON 提取工具函数 ────────────────────────────────────────────────────────

fn extract_json(text: &str) -> String {
    if let Some(start) = text.find("```json") {
        if let Some(end) = text[start + 7..].find("```") {
            return text[start + 7..start + 7 + end].trim().to_string();
        }
    }
    if let Some(start) = text.find('[') {
        if let Some(end) = text.rfind(']') {
            return text[start..=end].to_string();
        }
    }
    text.to_string()
}
