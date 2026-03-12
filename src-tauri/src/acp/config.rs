use serde_json::json;
use std::path::PathBuf;

/// preset → opencode provider 名称的映射表
/// key: app 内存储的 preset id，value: opencode 全局配置中对应的 provider 名称
const PRESET_PROVIDER_MAP: &[(&str, &str)] = &[
    ("alicloud", "bailian-coding-plan"),
];

/// 将 LLM 配置写入 opencode.json，供 opencode 读取
///
/// preset 处理逻辑：
/// - 已知 preset（如 "alicloud"）→ 直接写 `"model": "{provider}/{model}"`，
///   不写 provider credentials（依赖 opencode 全局配置中已有的 provider 定义）
/// - 无 preset / 未知 preset → 写 openai 或 anthropic provider + credentials
pub fn write_opencode_config(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    api_type: &str,  // "openai" | "anthropic"
    preset: Option<&str>,
    cwd: &PathBuf,
) -> crate::AppResult<()> {
    // model 字段：若已含 '/' 则直接用，否则根据 preset 或 api_type 加前缀
    let config = if let Some(p) = preset {
        // 查找 preset 对应的 opencode provider 名称
        if let Some(&(_, provider)) = PRESET_PROVIDER_MAP.iter().find(|&&(id, _)| id == p) {
            let model_str = if model.contains('/') {
                model.to_string()
            } else {
                format!("{}/{}", provider, model)
            };
            // 只写 model，不写 credentials（全局 opencode 配置已有该 provider）
            json!({ "model": model_str })
        } else {
            // 未知 preset，降级走 api_type 逻辑
            build_provider_config(api_key, base_url, model, api_type)
        }
    } else {
        build_provider_config(api_key, base_url, model, api_type)
    };

    let config_path = cwd.join("opencode.json");

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| crate::AppError::Other(format!("Config serialize error: {}", e)))?;
    std::fs::write(&config_path, content)
        .map_err(|e| crate::AppError::Other(format!("Config write error: {}", e)))?;

    log::info!("Wrote opencode.json to {:?}", config_path);
    Ok(())
}

/// 无 preset 时按 api_type 构建包含 credentials 的 provider 配置
fn build_provider_config(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    api_type: &str,
) -> serde_json::Value {
    match api_type {
        "anthropic" => {
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
