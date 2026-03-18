use crate::AppResult;

/// Upsert the `mcp` key inside `opencode.json`.
///
/// The MCP port is determined at runtime, so this function is called after
/// the MCP server has started and before spawning the serve process.
/// We merge into the same `opencode.json` used for provider config so that
/// `OPENCODE_CONFIG` pointing to a single file is sufficient.
pub fn write_mcp_config(opencode_dir: &std::path::Path, mcp_port: u16) -> AppResult<()> {
    std::fs::create_dir_all(opencode_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create opencode dir: {}", e)))?;

    let path = opencode_dir.join("opencode.json");

    let mut root: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| crate::AppError::Other(format!("Failed to read opencode.json: {}", e)))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    root["mcp"] = serde_json::json!({
        "open-db-studio": {
            "type": "remote",
            "url": format!("http://127.0.0.1:{}/mcp", mcp_port),
            "enabled": true
        }
    });

    let tmp_path = opencode_dir.join("opencode.json.tmp");
    let json = serde_json::to_string_pretty(&root)
        .map_err(|e| crate::AppError::Other(format!("Failed to serialize opencode.json: {}", e)))?;
    std::fs::write(&tmp_path, &json)
        .map_err(|e| crate::AppError::Other(format!("Failed to write opencode.json.tmp: {}", e)))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| crate::AppError::Other(format!("Failed to rename opencode.json.tmp: {}", e)))?;

    log::info!("Wrote mcp config into opencode.json at {:?}", path);
    Ok(())
}

/// Write agent prompt files for sql-explain and sql-optimize agents.
pub fn write_agent_prompts(opencode_dir: &std::path::Path) -> AppResult<()> {
    let agents_dir = opencode_dir.join("agents");
    std::fs::create_dir_all(&agents_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create opencode/agents dir: {}", e)))?;

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

    log::info!("Wrote agent prompt files to opencode/agents at {:?}", agents_dir);
    Ok(())
}

/// 将自定义供应商合并写入 opencode/opencode.json，不覆盖其他已有 provider。
/// 使用 tmp 文件 + rename 保证原子性。
/// `npm_pkg`：`"openai"` → `"@ai-sdk/openai"`；`"anthropic"` → `"@ai-sdk/anthropic"`
pub fn upsert_custom_provider(
    opencode_dir: &std::path::Path,
    provider_id: &str,
    api_type: &str,
    base_url: &str,
    api_key: &str,
) -> AppResult<()> {
    std::fs::create_dir_all(opencode_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create opencode dir: {}", e)))?;

    let path = opencode_dir.join("opencode.json");

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

    // @ai-sdk/anthropic 直接在 baseURL 后拼 /messages，
    // 而 LlmClient（测试连接）在 base_url 后拼 /v1/messages。
    // 因此写入 opencode.json 时，anthropic 类型需补上 /v1。
    let effective_base_url = if api_type == "anthropic" {
        let trimmed = base_url.trim_end_matches('/');
        if trimmed.ends_with("/v1") {
            trimmed.to_string()
        } else {
            format!("{}/v1", trimmed)
        }
    } else {
        base_url.trim_end_matches('/').to_string()
    };

    let provider_entry = serde_json::json!({
        "npm": npm_pkg,
        "options": {
            "apiKey": api_key,
            "baseURL": effective_base_url
        }
    });

    root["provider"][provider_id] = provider_entry;

    // 原子写入：先写 tmp 文件，再 rename
    let tmp_path = opencode_dir.join("opencode.json.tmp");
    let json_str = serde_json::to_string_pretty(&root)
        .map_err(|e| crate::AppError::Other(format!("Failed to serialize opencode.json: {}", e)))?;
    std::fs::write(&tmp_path, &json_str)
        .map_err(|e| crate::AppError::Other(format!("Failed to write opencode.json.tmp: {}", e)))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| crate::AppError::Other(format!("Failed to rename opencode.json.tmp: {}", e)))?;

    log::info!("Upserted custom provider '{}' in opencode/opencode.json", provider_id);
    Ok(())
}

/// 启动时将 DB 中所有 custom LlmConfig 同步到 opencode.json 的 provider.models。
///
/// 策略：
/// - 按 opencode_provider_id 分组，每组写一个 provider 条目
/// - models 键为 model ID，值保留文件中已有的 options/modalities 等字段，只更新 name
/// - provider 下不在 DB 中的 model 条目会被移除（保持文件与配置一致）
/// - opencode 模式（config_mode != "custom"）的配置跳过
pub fn sync_all_providers(
    opencode_dir: &std::path::Path,
    configs: &[crate::db::models::LlmConfig],
) -> AppResult<()> {
    std::fs::create_dir_all(opencode_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create opencode dir: {}", e)))?;

    let path = opencode_dir.join("opencode.json");

    let mut root: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| crate::AppError::Other(format!("Failed to read opencode.json: {}", e)))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !root.get("provider").map(|v| v.is_object()).unwrap_or(false) {
        root["provider"] = serde_json::json!({});
    }

    // 按 provider_id 分组，只处理 custom 模式且有 provider_id 的配置
    let mut by_provider: std::collections::HashMap<String, Vec<&crate::db::models::LlmConfig>> =
        std::collections::HashMap::new();
    for cfg in configs {
        if cfg.config_mode == "custom" && !cfg.opencode_provider_id.is_empty() {
            by_provider.entry(cfg.opencode_provider_id.clone()).or_default().push(cfg);
        }
    }

    for (provider_id, cfgs) in &by_provider {
        let npm_pkg = match cfgs[0].api_type.as_str() {
            "anthropic" => "@ai-sdk/anthropic",
            _ => "@ai-sdk/openai",
        };
        // 优先用 is_default 配置的凭证，否则取第一个
        let primary = cfgs.iter().find(|c| c.is_default).unwrap_or(&cfgs[0]);

        // 读取文件中已有的 models，保留 options/modalities 等额外字段
        let existing_models = root["provider"][provider_id.as_str()]["models"]
            .as_object()
            .cloned()
            .unwrap_or_default();

        // 保留已有 provider 的 name 字段（若有），不强制覆盖
        let provider_name = root["provider"][provider_id.as_str()]["name"]
            .as_str()
            .map(|s| serde_json::json!(s))
            .unwrap_or(serde_json::json!(serde_json::Value::Null));

        let effective_base_url = if cfgs[0].api_type == "anthropic" {
            let trimmed = primary.base_url.trim_end_matches('/');
            if trimmed.ends_with("/v1") {
                trimmed.to_string()
            } else {
                format!("{}/v1", trimmed)
            }
        } else {
            primary.base_url.trim_end_matches('/').to_string()
        };

        // 模型条目：合并 DB 新字段 + 文件已有字段
        let mut models = serde_json::Map::new();
        for cfg in cfgs {
            // 以文件中已有条目为基础，保留 modalities / options 等
            let mut entry = existing_models
                .get(&cfg.model)
                .cloned()
                .unwrap_or(serde_json::json!({}));

            // 展示名：优先用 opencode_display_name，否则用 name
            let display_name = if cfg.opencode_display_name.is_empty() {
                cfg.name.clone()
            } else {
                cfg.opencode_display_name.clone()
            };
            entry["name"] = serde_json::json!(display_name);

            // 合并 opencode_model_options（modalities / options.thinking 等）
            if !cfg.opencode_model_options.is_empty() {
                if let Ok(extra) = serde_json::from_str::<serde_json::Value>(&cfg.opencode_model_options) {
                    if let Some(obj) = extra.as_object() {
                        for (k, v) in obj {
                            entry[k] = v.clone();
                        }
                    }
                }
            }

            models.insert(cfg.model.clone(), entry);
        }

        // provider 展示名：优先用 DB opencode_provider_name，否则保留文件中已有的
        let resolved_provider_name = if !primary.opencode_provider_name.is_empty() {
            serde_json::json!(primary.opencode_provider_name)
        } else {
            provider_name
        };

        let mut provider_entry = serde_json::json!({
            "npm": npm_pkg,
            "options": {
                "apiKey": primary.api_key,
                "baseURL": effective_base_url
            },
            "models": serde_json::Value::Object(models)
        });
        if !resolved_provider_name.is_null() {
            provider_entry["name"] = resolved_provider_name;
        }

        root["provider"][provider_id.as_str()] = provider_entry;
    }

    let tmp_path = opencode_dir.join("opencode.json.tmp");
    let json_str = serde_json::to_string_pretty(&root)
        .map_err(|e| crate::AppError::Other(format!("Failed to serialize opencode.json: {}", e)))?;
    std::fs::write(&tmp_path, &json_str)
        .map_err(|e| crate::AppError::Other(format!("Failed to write opencode.json.tmp: {}", e)))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| crate::AppError::Other(format!("Failed to rename opencode.json.tmp: {}", e)))?;

    log::info!("Synced {} provider(s) with {} config(s) into opencode.json", by_provider.len(), configs.len());
    Ok(())
}
