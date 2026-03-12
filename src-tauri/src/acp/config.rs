use serde_json::json;
use std::path::PathBuf;

/// 将 LLM 配置写入 opencode.json，供 opencode 读取
pub fn write_opencode_config(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    api_type: &str,  // "openai" | "anthropic"
    preset: Option<&str>,
    cwd: &PathBuf,
) -> crate::AppResult<()> {
    let config = build_provider_config(api_key, base_url, model, api_type, preset);

    let config_path = cwd.join("opencode.json");

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| crate::AppError::Other(format!("Config serialize error: {}", e)))?;
    std::fs::write(&config_path, &content)
        .map_err(|e| crate::AppError::Other(format!("Config write error: {}", e)))?;

    eprintln!("[acp] Wrote opencode.json to {:?}\n{}", config_path, content);
    log::info!("Wrote opencode.json to {:?}", config_path);
    Ok(())
}

/// 按 api_type 构建包含完整 credentials 的 provider 配置
fn build_provider_config(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    api_type: &str,
    preset: Option<&str>,
) -> serde_json::Value {
    let has_custom_url = base_url.map(|u| !u.is_empty()).unwrap_or(false);

    match api_type {
        "anthropic" if has_custom_url => {
            // 自定义 Anthropic 兼容端点（如阿里云百炼）：
            // 必须用 custom provider + 显式声明模型，否则 opencode 找不到模型会 fallback 到默认
            let provider_name = match preset {
                Some("alicloud") => "bailian-coding-plan",
                Some(p) => p,
                None => "custom",
            };
            let model_str = if model.contains('/') {
                model.to_string()
            } else {
                format!("{}/{}", provider_name, model)
            };
            // 确保 baseURL 以 /v1 结尾（百炼文档要求）
            let raw_url = base_url.unwrap();
            let url_owned;
            let url = if raw_url.ends_with("/v1") {
                raw_url
            } else {
                url_owned = format!("{}/v1", raw_url.trim_end_matches('/'));
                &url_owned
            };

            // json! 宏不支持变量 key，用 Map 手动构建
            let mut models = serde_json::Map::new();
            models.insert(model.to_string(), json!({ "name": model }));

            let mut provider_map = serde_json::Map::new();
            provider_map.insert(provider_name.to_string(), json!({
                "npm": "@ai-sdk/anthropic",
                "name": provider_name,
                "options": {
                    "baseURL": url,
                    "apiKey": api_key
                },
                "models": serde_json::Value::Object(models)
            }));

            json!({
                "model": model_str,
                "provider": serde_json::Value::Object(provider_map)
            })
        }
        "anthropic" => {
            // 标准 Anthropic 端点
            let model_str = if model.contains('/') {
                model.to_string()
            } else {
                format!("anthropic/{}", model)
            };
            json!({
                "model": model_str,
                "provider": {
                    "anthropic": {
                        "options": { "apiKey": api_key }
                    }
                }
            })
        }
        _ => {
            // openai 兼容
            let model_str = if model.contains('/') {
                model.to_string()
            } else {
                format!("openai/{}", model)
            };
            let mut options = json!({ "apiKey": api_key });
            if let Some(url) = base_url {
                if !url.is_empty() {
                    options["baseURL"] = json!(url);
                }
            }
            json!({
                "model": model_str,
                "provider": {
                    "openai": { "options": options }
                }
            })
        }
    }
}
