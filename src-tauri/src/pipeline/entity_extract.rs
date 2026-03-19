use crate::AppResult;

pub(super) fn build_llm_client() -> AppResult<crate::llm::LlmClient> {
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

pub async fn extract_entities(question: &str, connection_id: i64) -> AppResult<Vec<String>> {
    // 从图谱获取已知表名
    let table_names: Vec<String> = {
        let conn = crate::db::get().lock().map_err(|_| crate::AppError::Other("DB lock poisoned".into()))?;
        let mut stmt = conn.prepare(
            "SELECT name FROM graph_nodes WHERE connection_id=?1 AND node_type='table' AND (is_deleted IS NULL OR is_deleted=0)"
        )?;
        let result = stmt.query_map([connection_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        result
    };

    let client = match build_llm_client() {
        Ok(c) => c,
        Err(_) => return Ok(vec![]),  // 无 LLM 配置时降级为空实体
    };

    let system = format!(
        "数据库中已知的表有: {}。从用户问题中提取涉及的表名、字段名或业务术语，\
         以 JSON 字符串数组返回，只返回数组，不要其他内容。",
        table_names.join(", ")
    );

    let messages = vec![
        crate::llm::ChatMessage { role: "system".into(), content: system },
        crate::llm::ChatMessage { role: "user".into(), content: format!("用户问题: {}", question) },
    ];

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client.chat(messages),
    )
    .await
    .map_err(|_| log::warn!("[entity_extract] LLM request timeout"))
    .ok()
    .and_then(|r| r.map_err(|e| log::warn!("[entity_extract] LLM call failed: {}", e)).ok())
    .unwrap_or_default();

    let json_str = if let Some(s) = response.find('[') {
        if let Some(e) = response.rfind(']') {
            response[s..=e].to_string()
        } else { "[]".into() }
    } else { "[]".into() };

    Ok(serde_json::from_str::<Vec<String>>(&json_str).unwrap_or_default())
}
