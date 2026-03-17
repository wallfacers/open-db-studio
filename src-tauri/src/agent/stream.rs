use crate::llm::{PermissionOption, StreamEvent};
use crate::AppResult;
use futures_util::StreamExt;
use tauri::ipc::Channel;

/// 解析 SSE 流并将事件通过 channel 发送到前端。
///
/// SSE 格式（标准 text/event-stream）：
/// ```
/// event: message.part.delta
/// data: {"type":"text","delta":"hello world"}
///
/// event: message.completed
/// data: {}
/// ```
///
/// 连接断开（无更多数据）视为正常结束，自动发送 Done。
pub async fn consume_sse_stream(
    response: reqwest::Response,
    channel: &Channel<StreamEvent>,
) -> AppResult<()> {
    let mut stream = response.bytes_stream();

    let mut current_event: Option<String> = None;
    let mut current_data: Option<String> = None;
    // 用于跨 chunk 拼接不完整行
    let mut line_buf = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[sse] Stream read error: {}", e);
                break;
            }
        };

        let text = match std::str::from_utf8(&chunk) {
            Ok(s) => s,
            Err(_) => {
                log::warn!("[sse] Non-UTF8 chunk, skipping");
                continue;
            }
        };

        // 追加到 line_buf，然后按行处理
        line_buf.push_str(text);

        // 反复处理已有换行符的行
        loop {
            if let Some(pos) = line_buf.find('\n') {
                let line = line_buf[..pos].trim_end_matches('\r').to_string();
                line_buf = line_buf[pos + 1..].to_string();

                process_sse_line(&line, &mut current_event, &mut current_data, channel);
            } else {
                break;
            }
        }
    }

    // 流结束，发送 Done
    let _ = channel.send(StreamEvent::Done);
    Ok(())
}

fn process_sse_line(
    line: &str,
    current_event: &mut Option<String>,
    current_data: &mut Option<String>,
    channel: &Channel<StreamEvent>,
) {
    if line.is_empty() {
        // 空行表示一个事件结束，触发处理
        if let (Some(event_type), Some(data_str)) = (current_event.take(), current_data.take()) {
            dispatch_sse_event(&event_type, &data_str, channel);
        } else {
            // 只有 data 没有 event，或者只有 event 没有 data，跳过
            current_event.take();
            current_data.take();
        }
    } else if let Some(rest) = line.strip_prefix("event:") {
        *current_event = Some(rest.trim().to_string());
    } else if let Some(rest) = line.strip_prefix("data:") {
        *current_data = Some(rest.trim().to_string());
    } else if line.starts_with(':') {
        // SSE comment，忽略
    }
    // 其余行（如 id: 或不认识的字段）也忽略
}

fn dispatch_sse_event(event_type: &str, data_str: &str, channel: &Channel<StreamEvent>) {
    // 解析 JSON，失败时跳过不 panic
    let json: serde_json::Value = match serde_json::from_str(data_str) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[sse] Failed to parse data JSON for event '{}': {}", event_type, e);
            return;
        }
    };

    match event_type {
        "message.part.delta" => {
            handle_part_delta(&json, channel);
        }
        "session.permission.requested" => {
            handle_permission_requested(&json, channel);
        }
        "message.completed" => {
            // Done 由流结束时统一发送，这里不重复发送
            // 但如果需要立即通知，可以发送 Done
            let _ = channel.send(StreamEvent::Done);
        }
        "error" => {
            let message = json["message"]
                .as_str()
                .unwrap_or("Unknown error")
                .to_string();
            let _ = channel.send(StreamEvent::Error { message });
        }
        other => {
            log::debug!("[sse] Unhandled event type: '{}'", other);
        }
    }
}

fn handle_part_delta(json: &serde_json::Value, channel: &Channel<StreamEvent>) {
    let part_type = json["type"].as_str().unwrap_or("");
    match part_type {
        "text" => {
            let delta = json["delta"].as_str().unwrap_or("").to_string();
            let _ = channel.send(StreamEvent::ContentChunk { delta });
        }
        "thinking" => {
            let delta = json["delta"].as_str().unwrap_or("").to_string();
            let _ = channel.send(StreamEvent::ThinkingChunk { delta });
        }
        "tool_use" => {
            let call_id = json["id"].as_str().unwrap_or("").to_string();
            let name = json["name"].as_str().unwrap_or("").to_string();
            let arguments = match &json["input"] {
                serde_json::Value::String(s) => s.clone(),
                v if !v.is_null() => v.to_string(),
                _ => String::new(),
            };
            let _ = channel.send(StreamEvent::ToolCallRequest {
                call_id,
                name,
                arguments,
            });
        }
        other => {
            log::debug!("[sse] Unhandled part delta type: '{}'", other);
        }
    }
}

fn handle_permission_requested(json: &serde_json::Value, channel: &Channel<StreamEvent>) {
    let permission_id = json["permissionID"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let message = json["message"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let options: Vec<PermissionOption> = match json.get("options") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .map(|opt| PermissionOption {
                option_id: opt.to_string(),
                label: opt.to_string(),
                kind: "allow_once".to_string(),
            })
            .collect(),
        _ => vec![],
    };

    let _ = channel.send(StreamEvent::PermissionRequest {
        permission_id,
        message,
        options,
    });
}
