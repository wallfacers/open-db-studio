use crate::AppResult;
use super::crud::{CreateMetricInput, save_metric, Metric};

fn build_llm_client() -> AppResult<crate::llm::LlmClient> {
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

pub async fn generate_metric_drafts(connection_id: i64) -> AppResult<Vec<Metric>> {
    // 1. 获取 Schema 概要
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let schema = ds.get_schema().await?;

    let mut schema_desc = String::new();
    for table in &schema.tables {
        schema_desc.push_str(&format!("表: {}\n", table.name));
        let cols = ds.get_columns(&table.name, None).await.unwrap_or_default();
        for col in &cols {
            schema_desc.push_str(&format!(
                "  - {} {} {}\n",
                col.name, col.data_type,
                if col.is_primary_key { "(PK)" } else { "" }
            ));
        }
    }

    // 2. 构建 Prompt
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

    // 3. 调用 LLM
    let client = build_llm_client()?;
    let messages = vec![
        crate::llm::ChatMessage { role: "user".into(), content: prompt },
    ];
    let response = client.chat(messages).await?;

    // 4. 解析 JSON 响应
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

    // 5. 批量写入 draft 状态指标
    let mut results = Vec::new();
    for item in items {
        let input = CreateMetricInput {
            connection_id,
            name: item.name,
            display_name: item.display_name,
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
            scope_database: None,
            scope_schema: None,
        };
        match save_metric(&input) {
            Ok(m) => results.push(m),
            Err(e) => log::warn!("[metrics] Failed to save draft: {}", e),
        }
    }

    Ok(results)
}

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
