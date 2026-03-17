use crate::llm::{PermissionOption, StreamEvent};
use crate::AppResult;
use futures_util::StreamExt;
use tauri::ipc::Channel;

/// 消费 SSE 流，收集所有 ContentChunk 的文本内容，合并返回。
///
/// 遇到 `message.completed` 事件时提前返回；流结束时也返回已收集的内容。
pub async fn collect_text_from_sse(response: reqwest::Response) -> AppResult<String> {
    let mut stream = response.bytes_stream();
    let mut current_event: Option<String> = None;
    let mut current_data: Option<String> = None;
    let mut line_buf = String::new();
    let mut result = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[sse] collect_text_from_sse stream error: {}", e);
                break;
            }
        };
        let text = match std::str::from_utf8(&chunk) {
            Ok(s) => s,
            Err(_) => {
                log::warn!("[sse] collect_text_from_sse: non-UTF8 chunk, skipping");
                continue;
            }
        };
        line_buf.push_str(text);

        loop {
            if let Some(pos) = line_buf.find('\n') {
                let line = line_buf[..pos].trim_end_matches('\r').to_string();
                line_buf = line_buf[pos + 1..].to_string();

                if line.is_empty() {
                    if let (Some(ev), Some(data)) = (current_event.take(), current_data.take()) {
                        if ev == "message.part.delta" {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) {
                                if json["type"].as_str() == Some("text") {
                                    if let Some(delta) = json["delta"].as_str() {
                                        result.push_str(delta);
                                    }
                                }
                            }
                        } else if ev == "message.completed" {
                            return Ok(result);
                        }
                    } else {
                        current_event.take();
                        current_data.take();
                    }
                } else if let Some(rest) = line.strip_prefix("event:") {
                    current_event = Some(rest.trim().to_string());
                } else if let Some(rest) = line.strip_prefix("data:") {
                    current_data = Some(rest.trim().to_string());
                }
            } else {
                break;
            }
        }
    }

    Ok(result)
}

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
        let mut stop = false;
        loop {
            if let Some(pos) = line_buf.find('\n') {
                let line = line_buf[..pos].trim_end_matches('\r').to_string();
                line_buf = line_buf[pos + 1..].to_string();

                if process_sse_line(&line, &mut current_event, &mut current_data, channel) {
                    stop = true;
                    break;
                }
            } else {
                break;
            }
        }
        if stop {
            // message.completed 已在 dispatch 中发送 Done，提前退出
            return Ok(());
        }
    }

    // 流结束兜底，发送 Done（message.completed 提前 return 时不会到达此处）
    let _ = channel.send(StreamEvent::Done);
    Ok(())
}

/// 处理一行 SSE 文本。返回 true 表示流应立即结束（message.completed 已收到）。
fn process_sse_line(
    line: &str,
    current_event: &mut Option<String>,
    current_data: &mut Option<String>,
    channel: &Channel<StreamEvent>,
) -> bool {
    if line.is_empty() {
        // 空行表示一个事件结束，触发处理
        if let (Some(event_type), Some(data_str)) = (current_event.take(), current_data.take()) {
            return dispatch_sse_event(&event_type, &data_str, channel);
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
    false
}

/// 分发 SSE 事件。返回 true 表示流应立即结束（message.completed 已收到）。
fn dispatch_sse_event(event_type: &str, data_str: &str, channel: &Channel<StreamEvent>) -> bool {
    // 解析 JSON，失败时跳过不 panic
    let json: serde_json::Value = match serde_json::from_str(data_str) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[sse] Failed to parse data JSON for event '{}': {}", event_type, e);
            return false;
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
            // 发送 Done 并通知调用方立即退出，避免流结束时重复发送
            let _ = channel.send(StreamEvent::Done);
            return true;
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
    false
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
        Some(serde_json::Value::Array(arr)) => {
            let mut parsed = Vec::with_capacity(arr.len());
            let mut parse_ok = true;
            for v in arr.iter() {
                if let Some(s) = v.as_str() {
                    // 字符串数组格式
                    parsed.push(PermissionOption {
                        option_id: s.to_string(),
                        label: s.to_string(),
                        kind: "allow".to_string(),
                    });
                } else if v.is_object() {
                    // 对象数组格式：提取 id / label / kind 字段
                    let option_id = v["id"].as_str().unwrap_or("").to_string();
                    let label = v["label"].as_str().unwrap_or(&option_id).to_string();
                    let kind = v["kind"].as_str().unwrap_or("allow").to_string();
                    parsed.push(PermissionOption { option_id, label, kind });
                } else {
                    // 未知格式，记录警告并放弃整个 options
                    log::warn!("[sse] permission options: unexpected element format: {:?}", v);
                    parse_ok = false;
                    break;
                }
            }
            if parse_ok { parsed } else { vec![] }
        }
        Some(other) => {
            log::warn!("[sse] permission options: unexpected type: {:?}", other);
            vec![]
        }
        None => vec![],
    };

    let _ = channel.send(StreamEvent::PermissionRequest {
        permission_id,
        message,
        options,
    });
}
