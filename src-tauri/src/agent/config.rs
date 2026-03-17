use crate::AppResult;

/// Generate opencode.json and write it to `agent_dir/opencode.json`.
pub fn write_opencode_json(
    agent_dir: &std::path::Path,
    model: &str,
    provider: &str,
    api_key: &str,
    base_url: Option<&str>,
) -> AppResult<()> {
    std::fs::create_dir_all(agent_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create agent dir: {}", e)))?;

    let json = build_opencode_json(model, provider, api_key, base_url)?;

    let path = agent_dir.join("opencode.json");
    std::fs::write(&path, json)
        .map_err(|e| crate::AppError::Other(format!("Failed to write opencode.json: {}", e)))?;

    log::info!("Wrote opencode.json to {:?}", path);
    Ok(())
}

fn build_opencode_json(
    model: &str,
    provider: &str,
    api_key: &str,
    base_url: Option<&str>,
) -> AppResult<String> {
    let value = match provider {
        "anthropic" => {
            serde_json::json!({
                "model": format!("anthropic/{}", model),
                "provider": {
                    "anthropic": {
                        "options": {
                            "apiKey": api_key
                        }
                    }
                }
            })
        }
        "openai" => {
            serde_json::json!({
                "model": format!("openai/{}", model),
                "provider": {
                    "openai": {
                        "options": {
                            "apiKey": api_key
                        }
                    }
                }
            })
        }
        _ => {
            // Custom endpoint
            let url = base_url.unwrap_or("https://api.openai.com/v1");
            serde_json::json!({
                "model": format!("custom/{}", model),
                "provider": {
                    "openai": {
                        "options": {
                            "apiKey": api_key,
                            "baseURL": url
                        }
                    }
                }
            })
        }
    };

    serde_json::to_string_pretty(&value)
        .map_err(|e| crate::AppError::Other(format!("Failed to serialize opencode.json: {}", e)))
}

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
