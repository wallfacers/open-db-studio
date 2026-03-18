use crate::AppResult;

/// Write `.opencode/config.json` with the MCP HTTP server configuration.
///
/// The MCP port is determined at runtime, so this function is called after
/// the MCP server has started and before spawning the serve process.
pub fn write_mcp_config(agent_dir: &std::path::Path, mcp_port: u16) -> AppResult<()> {
    let config_dir = agent_dir.join(".opencode");
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create .opencode dir: {}", e)))?;

    let config = serde_json::json!({
        "mcp": {
            "open-db-studio": {
                "type": "http",
                "url": format!("http://127.0.0.1:{}/mcp", mcp_port)
            }
        }
    });

    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| crate::AppError::Other(format!("Failed to serialize mcp config: {}", e)))?;

    let path = config_dir.join("config.json");
    std::fs::write(&path, json)
        .map_err(|e| crate::AppError::Other(format!("Failed to write .opencode/config.json: {}", e)))?;

    log::info!("Wrote .opencode/config.json to {:?}", path);
    Ok(())
}

/// Write agent prompt files for sql-explain and sql-optimize agents.
pub fn write_agent_prompts(agent_dir: &std::path::Path) -> AppResult<()> {
    let agents_dir = agent_dir.join(".opencode").join("agents");
    std::fs::create_dir_all(&agents_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create agents dir: {}", e)))?;

    let explain_content = r#"---
description: SQL 解释专家，分析 SQL 语句的执行逻辑与性能特征
---

你是一个专业的 SQL 解释专家。当用户提供 SQL 语句时，请：
1. 解释 SQL 的执行逻辑（每个子句的作用）
2. 指出潜在的性能问题（如全表扫描、N+1 查询等）
3. 说明预期的查询结果
4. 如有改进空间，给出简短建议

请用中文回答，保持简洁清晰。
"#;

    let optimize_content = r#"---
description: SQL 优化专家，提供 SQL 性能优化建议与改写
---

你是一个专业的 SQL 优化专家。当用户提供 SQL 语句时，请：
1. 分析当前 SQL 的性能瓶颈
2. 提供优化后的 SQL（如有）
3. 解释优化思路（索引使用、查询改写、执行计划等）
4. 给出索引建议（如适用）

请用中文回答，优化建议要具体可执行。
"#;

    let explain_path = agents_dir.join("sql-explain.md");
    std::fs::write(&explain_path, explain_content)
        .map_err(|e| crate::AppError::Other(format!("Failed to write sql-explain.md: {}", e)))?;

    let optimize_path = agents_dir.join("sql-optimize.md");
    std::fs::write(&optimize_path, optimize_content)
        .map_err(|e| crate::AppError::Other(format!("Failed to write sql-optimize.md: {}", e)))?;

    log::info!("Wrote agent prompt files to {:?}", agents_dir);
    Ok(())
}

/// 将自定义供应商合并写入 agent/opencode.json，不覆盖其他已有 provider。
/// 使用 tmp 文件 + rename 保证原子性。
/// `npm_pkg`：`"openai"` → `"@ai-sdk/openai"`；`"anthropic"` → `"@ai-sdk/anthropic"`
pub fn upsert_custom_provider(
    agent_dir: &std::path::Path,
    provider_id: &str,
    api_type: &str,
    base_url: &str,
    api_key: &str,
) -> AppResult<()> {
    std::fs::create_dir_all(agent_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create agent dir: {}", e)))?;

    let path = agent_dir.join("opencode.json");

    // 读取已有 JSON（不存在则从空对象开始）
    let mut root: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| crate::AppError::Other(format!("Failed to read opencode.json: {}", e)))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // 确保 provider 字段存在
    if !root.get("provider").map(|v| v.is_object()).unwrap_or(false) {
        root["provider"] = serde_json::json!({});
    }

    let npm_pkg = match api_type {
        "anthropic" => "@ai-sdk/anthropic",
        _ => "@ai-sdk/openai",
    };

    let provider_entry = serde_json::json!({
        "npm": npm_pkg,
        "options": {
            "apiKey": api_key,
            "baseURL": base_url
        }
    });

    root["provider"][provider_id] = provider_entry;

    // 原子写入：先写 tmp 文件，再 rename
    let tmp_path = agent_dir.join("opencode.json.tmp");
    let json_str = serde_json::to_string_pretty(&root)
        .map_err(|e| crate::AppError::Other(format!("Failed to serialize opencode.json: {}", e)))?;
    std::fs::write(&tmp_path, &json_str)
        .map_err(|e| crate::AppError::Other(format!("Failed to write opencode.json.tmp: {}", e)))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| crate::AppError::Other(format!("Failed to rename opencode.json.tmp: {}", e)))?;

    log::info!("Upserted custom provider '{}' in opencode.json", provider_id);
    Ok(())
}
