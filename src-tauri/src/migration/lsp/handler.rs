use serde_json::Value;
use crate::error::{AppError, AppResult};

pub async fn handle_request(
    method: &str,
    params: Value,
    app: &tauri::AppHandle,
) -> AppResult<Value> {
    match method {
        "textDocument/diagnostic" => {
            let text = params["text"].as_str()
                .ok_or_else(|| AppError::Other("missing 'text' param".into()))?;
            let diagnostics = super::diagnostics::diagnose(text, app).await;
            Ok(serde_json::to_value(diagnostics)?)
        }
        "textDocument/formatting" => {
            let text = params["text"].as_str()
                .ok_or_else(|| AppError::Other("missing 'text' param".into()))?;
            let formatted = format_script(text);
            Ok(serde_json::to_value(formatted)?)
        }
        "textDocument/completion" => {
            let items = super::completion::complete(&params, app).await?;
            Ok(serde_json::to_value(items)?)
        }
        "textDocument/hover" => {
            let result = super::hover::hover(&params, app).await?;
            Ok(serde_json::to_value(result)?)
        }
        _ => Err(AppError::Other(format!("unknown LSP method: {method}"))),
    }
}

fn format_script(text: &str) -> Option<String> {
    let script = crate::migration::lang::parser::parse(text).ok()?;
    Some(crate::migration::lang::formatter::format(&script))
}
