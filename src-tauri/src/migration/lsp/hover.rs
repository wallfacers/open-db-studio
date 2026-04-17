use serde::Serialize;
use serde_json::Value;
use crate::error::AppResult;
use crate::migration::lang::{ast::*, parser};

#[derive(Debug, Clone, Serialize)]
pub struct HoverInfo {
    pub contents: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

pub async fn hover(
    params: &Value,
    _app: &tauri::AppHandle,
) -> AppResult<Option<HoverInfo>> {
    let text = params["text"].as_str().unwrap_or("");
    let line = params["position"]["line"].as_u64().unwrap_or(0) as u32;
    let col = params["position"]["column"].as_u64().unwrap_or(0) as u32;

    let script = parser::parse_partial(text);

    let word = word_at_position(text, line, col);
    if word.is_empty() {
        return Ok(None);
    }

    if let Some(info) = hover_set_param(&word) {
        return Ok(Some(info));
    }

    for stmt in &script.statements {
        if let Statement::Use(u) = stmt {
            if u.alias == word {
                return Ok(Some(HoverInfo {
                    contents: format!("**Alias** `{}` -> connection `{}`", u.alias, u.connection_name),
                    start_line: line, start_col: col,
                    end_line: line, end_col: col + word.len() as u32,
                }));
            }
        }
    }

    if let Ok(Some(id)) = crate::db::find_connection_id_by_name(&word) {
        return Ok(Some(HoverInfo {
            contents: format!("**Connection** `{word}` (id: {id})"),
            start_line: line, start_col: col,
            end_line: line, end_col: col + word.len() as u32,
        }));
    }

    Ok(None)
}

fn word_at_position(text: &str, line: u32, col: u32) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if line as usize >= lines.len() { return String::new(); }
    let line_text = lines[line as usize];
    let col = col as usize;
    if col >= line_text.len() { return String::new(); }

    let start = line_text[..col].rfind(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
        .map(|i| i + 1).unwrap_or(0);
    let end = line_text[col..].find(|c: char| !c.is_alphanumeric() && c != '_')
        .map(|i| col + i).unwrap_or(line_text.len());

    line_text[start..end].to_string()
}

fn hover_set_param(word: &str) -> Option<HoverInfo> {
    let desc = match word {
        "parallelism" => "**parallelism** `1-16`\n\nNumber of concurrent read/write workers.",
        "read_batch" | "read_batch_size" => "**read_batch** `1-50000` (default: 10000)\n\nRows fetched per read batch from source.",
        "write_batch" | "write_batch_size" => "**write_batch** `1-5000` (default: 1000)\n\nRows written per batch to target.",
        "error_limit" => "**error_limit** `0+` (default: 0)\n\nMax dirty rows before aborting. 0 = unlimited.",
        "speed_limit_rps" => "**speed_limit_rps** (optional)\n\nMax rows per second. Omit for unlimited.",
        "channel_capacity" => "**channel_capacity** (default: 16)\n\nPipeline backpressure buffer size in batches.",
        "shard_count" => "**shard_count** (optional)\n\nForce N shards for parallel reads (auto-detected by default).",
        "transaction_batch" | "txn_batch" => "**transaction_batch** `1-100` (default: 10)\n\nNumber of write batches grouped into a single COMMIT. Higher values reduce disk fsync count.",
        "write_pause_ms" => "**write_pause_ms** (optional)\n\nCooldown in milliseconds between transaction commits. Gives disk I/O breathing room.",
        _ => return None,
    };
    Some(HoverInfo {
        contents: desc.into(),
        start_line: 0, start_col: 0, end_line: 0, end_col: 0,
    })
}
