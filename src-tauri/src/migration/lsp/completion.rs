use serde::Serialize;
use serde_json::Value;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize)]
pub struct CompletionItem {
    pub label: String,
    pub kind: String,
    pub detail: Option<String>,
    pub insert_text: Option<String>,
}

pub async fn complete(
    params: &Value,
    _app: &tauri::AppHandle,
) -> AppResult<Vec<CompletionItem>> {
    let text = params["text"].as_str().unwrap_or("");
    let line = params["position"]["line"].as_u64().unwrap_or(0) as usize;
    let col = params["position"]["column"].as_u64().unwrap_or(0) as usize;

    let context = analyze_cursor_context(text, line, col);
    let items = match context {
        CursorContext::AfterConflict => strategy_completions(),
        CursorContext::AfterSet => parameter_completions(),
        CursorContext::AfterTypeCast => type_completions(),
        CursorContext::LineStart | CursorContext::Unknown => keyword_completions(),
        CursorContext::AfterFrom | CursorContext::AfterInto => keyword_completions(),
    };

    Ok(items)
}

#[derive(Debug)]
enum CursorContext {
    AfterFrom,
    AfterInto,
    AfterConflict,
    AfterSet,
    AfterTypeCast,
    LineStart,
    Unknown,
}

fn analyze_cursor_context(text: &str, line: usize, col: usize) -> CursorContext {
    let lines: Vec<&str> = text.lines().collect();
    if line >= lines.len() {
        return CursorContext::LineStart;
    }

    let current_line = lines[line];
    let before_cursor = if col <= current_line.len() {
        &current_line[..col]
    } else {
        current_line
    };

    let trimmed = before_cursor.trim();
    let upper = trimmed.to_uppercase();

    if upper.ends_with("FROM ") || upper.ends_with("FROM") {
        return CursorContext::AfterFrom;
    }
    if upper.ends_with("INTO ") || upper.ends_with("INTO") {
        return CursorContext::AfterInto;
    }
    if upper.ends_with("CONFLICT ") || upper.ends_with("CONFLICT") {
        return CursorContext::AfterConflict;
    }
    if upper.starts_with("SET ") || trimmed.ends_with(',') {
        return CursorContext::AfterSet;
    }
    if trimmed.ends_with("::") || trimmed.ends_with(":: ") {
        return CursorContext::AfterTypeCast;
    }
    if trimmed.is_empty() {
        return CursorContext::LineStart;
    }

    CursorContext::Unknown
}

fn strategy_completions() -> Vec<CompletionItem> {
    ["UPSERT", "REPLACE", "SKIP", "INSERT", "OVERWRITE"].iter().map(|s| CompletionItem {
        label: s.to_string(),
        kind: "keyword".into(),
        detail: Some(match *s {
            "UPSERT" => "Insert or update on conflict",
            "REPLACE" => "Delete and re-insert on conflict",
            "SKIP" => "Skip rows that conflict",
            "INSERT" => "Insert only, error on conflict",
            "OVERWRITE" => "Truncate target, then insert",
            _ => "",
        }.into()),
        insert_text: Some(s.to_string()),
    }).collect()
}

fn parameter_completions() -> Vec<CompletionItem> {
    vec![
        ("parallelism", "Concurrent workers (1-16)"),
        ("read_batch", "Rows per read batch (1-50000)"),
        ("write_batch", "Rows per write batch (1-5000)"),
        ("error_limit", "Max dirty rows before abort (0=unlimited)"),
        ("speed_limit_rps", "Max rows/sec (empty=unlimited)"),
        ("channel_capacity", "Pipeline buffer size (default 16)"),
        ("shard_count", "Number of shards for parallel read"),
    ].into_iter().map(|(name, desc)| CompletionItem {
        label: name.into(),
        kind: "parameter".into(),
        detail: Some(desc.into()),
        insert_text: Some(format!("{name} = ")),
    }).collect()
}

fn type_completions() -> Vec<CompletionItem> {
    ["INT", "BIGINT", "SMALLINT", "BOOLEAN", "VARCHAR", "TEXT",
     "NUMERIC", "DECIMAL", "FLOAT", "DOUBLE", "DATE", "TIME",
     "TIMESTAMP", "TIMESTAMPTZ", "JSON", "JSONB", "BYTEA", "BLOB",
     "UUID"].iter().map(|t| CompletionItem {
        label: t.to_string(),
        kind: "type".into(),
        detail: None,
        insert_text: Some(t.to_string()),
    }).collect()
}

fn keyword_completions() -> Vec<CompletionItem> {
    vec![
        ("MIGRATE FROM", "Start a migration statement"),
        ("USE", "Declare a connection alias"),
        ("SET", "Configure pipeline parameters"),
        ("--", "Single-line comment"),
    ].into_iter().map(|(kw, desc)| CompletionItem {
        label: kw.into(),
        kind: "keyword".into(),
        detail: Some(desc.into()),
        insert_text: Some(if kw == "MIGRATE FROM" { "MIGRATE FROM ".into() } else { format!("{kw} ") }),
    }).collect()
}

pub async fn complete_inline(
    params: &serde_json::Value,
    _app: &tauri::AppHandle,
) -> crate::error::AppResult<Option<String>> {
    let text = params["text"].as_str().unwrap_or("");
    let cursor_line = params["position"]["line"].as_u64().unwrap_or(0) as u32;

    // Build context with referenced connection schemas
    let partial_ast = crate::migration::lang::parser::parse_partial(text);
    let mut schema_info = String::new();

    for stmt in &partial_ast.statements {
        if let crate::migration::lang::ast::Statement::Use(u) = stmt {
            if let Ok(Some(id)) = crate::db::find_connection_id_by_name(&u.connection_name) {
                schema_info.push_str(&format!("Connection '{}' (id: {id})\n", u.connection_name));
            }
        }
    }

    // Build LLM client from default config
    let config = match crate::db::get_default_llm_config() {
        Ok(Some(c)) => c,
        _ => return Ok(None), // No AI configured, silently skip
    };
    let api_type = match config.api_type.as_str() {
        "anthropic" => crate::llm::ApiType::Anthropic,
        _ => crate::llm::ApiType::Openai,
    };
    let base_url = if !config.base_url.is_empty() {
        config.base_url.clone()
    } else if !config.opencode_provider_id.is_empty() {
        crate::agent::config::resolve_opencode_base_url(&config.opencode_provider_id)
            .unwrap_or_default()
    } else {
        String::new()
    };
    let llm = crate::llm::client::LlmClient::new(
        config.api_key,
        Some(base_url),
        Some(config.model),
        Some(api_type),
    );

    // Build prompt from template
    let template = include_str!("../../../../prompts/migration_ghost_text.md");
    let prompt = template
        .replace("{{schemas}}", &schema_info)
        .replace("{{current_script}}", text)
        .replace("{{cursor_line}}", &cursor_line.to_string());

    let messages = vec![crate::llm::client::ChatMessage {
        role: "user".to_string(),
        content: prompt,
    }];

    let params = crate::llm::client::ChatParams {
        temperature: Some(0.1),
        max_tokens: Some(500),
        stop: None,
    };

    match llm.chat_with_params(messages, params).await {
        Ok(suggestion) => Ok(Some(suggestion.trim().to_string())),
        Err(_) => Ok(None),
    }
}
