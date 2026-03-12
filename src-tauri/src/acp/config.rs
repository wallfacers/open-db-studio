use serde_json::json;
use std::path::PathBuf;

/// 将 LLM 配置写入 opencode.json，供 opencode 读取
pub fn write_opencode_config(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    api_type: &str,  // "openai" | "anthropic"
    cwd: &PathBuf,
) -> crate::AppResult<()> {
    let config = match api_type {
        "anthropic" => {
            let model_str = if model.contains('/') {
                model.to_string()
            } else {
                format!("anthropic/{}", model)
            };
            json!({
                "model": model_str,
                "providers": {
                    "anthropic": {
                        "apiKey": api_key
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
            let mut provider = json!({ "apiKey": api_key });
            if let Some(url) = base_url {
                if !url.is_empty() {
                    provider["baseURL"] = json!(url);
                }
            }
            json!({
                "model": model_str,
                "providers": {
                    "openai": provider
                }
            })
        }
    };

    let config_path = cwd.join("opencode.json");
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| crate::AppError::Other(format!("Config serialize error: {}", e)))?;
    std::fs::write(&config_path, content)
        .map_err(|e| crate::AppError::Other(format!("Config write error: {}", e)))?;

    log::info!("Wrote opencode.json to {:?}", config_path);
    Ok(())
}
