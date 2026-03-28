use crate::llm::StreamEvent;
use crate::AppResult;
use futures_util::StreamExt;
use tauri::ipc::Channel;

// ── 公共辅助 ─────────────────────────────────────────────────────────────────

/// 从 SSE 行 `data: {...}` 提取 JSON payload。
/// opencode 事件格式：{ "directory": "...", "payload": { "type": "...", "properties": {...} } }
/// 返回 payload 对象（内含 type 和 properties）。
#[inline]
fn parse_sse_payload(line: &str) -> Option<serde_json::Value> {
    let data = line.trim().strip_prefix("data: ")?;
    let envelope: serde_json::Value = serde_json::from_str(data).ok()?;
    // payload 字段内含 type/properties；server.connected 等心跳事件无 directory
    let payload = envelope.get("payload")?.clone();
    Some(payload)
}

/// Auto-respond to permission requests to unblock the agent.
fn spawn_auto_permission_respond(port: u16, session_id: &str, permission_id: &str) {
    let port_copy = port;
    let sid = session_id.to_string();
    let pid = permission_id.to_string();
    tokio::spawn(async move {
        if let Err(e) = crate::agent::client::permission_respond(
            port_copy, &sid, &pid, "always", Some(true),
        )
        .await
        {
            log::warn!("[stream] auto permission_respond failed: {}", e);
        }
    });
}

// ── 标题生成（阻塞式，不需要流式）────────────────────────────────────────────

/// 通过 `GET /global/event` + `POST /session/:id/message` 收集完整回复文本。
/// 用于 AI 标题生成等不需要流式显示的场景。
pub async fn collect_text_via_global_events(
    port: u16,
    session_id: &str,
    message_text: &str,
    model_id: Option<&str>,
    provider_id: Option<&str>,
) -> AppResult<String> {
    // 1. 先建立 SSE 连接
    let sse_url = format!("http://127.0.0.1:{}/global/event", port);
    let sse_resp = crate::agent::client::client()
        .get(&sse_url)
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("SSE connect: {}", e)))?;

    // 2. 在后台发消息
    let msg_url = format!("http://127.0.0.1:{}/session/{}/message", port, session_id);
    let body = build_msg_body(message_text, model_id, provider_id, None);
    tokio::spawn(async move {
        let _ = crate::agent::client::client()
            .post(&msg_url)
            .json(&body)
            .send()
            .await;
    });

    // 3. 收集 SSE 中该 session 所有 text 块
    let mut line_buf = String::new();
    // key: part_id → 已发送字节偏移（供 message.part.updated 快照回退用）
    let mut part_offsets: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    // 本 session 的 part_id 集合（从 message.part.updated 注册）
    let mut session_part_ids: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut result = String::new();

    let mut stream = sse_resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| crate::AppError::Other(format!("SSE read: {}", e)))?;
        line_buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = line_buf.find('\n') {
            let line: String = line_buf.drain(..=pos).collect();
            let payload = match parse_sse_payload(&line) {
                Some(v) => v,
                None => continue,
            };
            let event_type = payload["type"].as_str().unwrap_or("");
            let props = &payload["properties"];

            match event_type {
                // 注册本 session 的 part（message.part.updated 是快照事件）
                "message.part.updated" => {
                    let part = &props["part"];
                    if part["sessionID"].as_str() == Some(session_id) {
                        let part_id = part["id"].as_str().unwrap_or("").to_string();
                        session_part_ids.insert(part_id.clone());

                        // 快照回退：若没有收到 delta 事件，也能从快照中提取增量
                        if part["type"].as_str() == Some("text") {
                            let full = part["text"].as_str().unwrap_or("");
                            let prev = *part_offsets.get(&part_id).unwrap_or(&0);
                            if full.len() > prev {
                                result.push_str(&full[prev..]);
                                part_offsets.insert(part_id, full.len());
                            }
                        }
                    }
                }
                // message.part.delta：真正的 token 级流式增量
                "message.part.delta" => {
                    let part_id = props["partID"].as_str().unwrap_or("");
                    if !session_part_ids.contains(part_id) {
                        continue;
                    }
                    if props["field"].as_str() == Some("text") {
                        let delta = props["delta"].as_str().unwrap_or("");
                        if !delta.is_empty() {
                            result.push_str(delta);
                            // 更新偏移，避免快照事件重复发送
                            let prev = *part_offsets.get(part_id).unwrap_or(&0);
                            part_offsets.insert(part_id.to_string(), prev + delta.len());
                        }
                    }
                }
                "session.idle" | "session.error" => {
                    if props["sessionID"].as_str() == Some(session_id) {
                        return Ok(result);
                    }
                }
                // permission.updated：自动回复以解除 agent 阻塞（标题生成无需展示）
                "permission.updated" => {
                    if props["sessionID"].as_str() != Some(session_id) {
                        continue;
                    }
                    let permission_id = props["id"].as_str().unwrap_or("");
                    if permission_id.is_empty() {
                        continue;
                    }
                    spawn_auto_permission_respond(port, session_id, permission_id);
                }
                _ => {}
            }
        }
    }

    Ok(result)
}

// ── 主流式接口 ────────────────────────────────────────────────────────────────

/// 订阅 `GET /global/event` SSE 并将该 session 的实时事件转发给前端 channel。
///
/// opencode SSE 事件格式：
/// `{ "directory": "...", "payload": { "type": "...", "properties": {...} } }`
///
/// 关键事件：
/// - `message.part.delta`   → 真正的 token 级增量（主路径）
/// - `message.part.updated` → 快照（回退路径，当 delta 不可用时）
/// - `session.idle`         → Done，退出
/// - `session.error`        → Error，退出
pub async fn stream_global_events(
    port: u16,
    session_id: &str,
    message_text: &str,
    model_id: Option<&str>,
    provider_id: Option<&str>,
    agent: Option<&str>,
    channel: &Channel<StreamEvent>,
) -> AppResult<()> {
    // 1. 先建立 SSE 连接，避免漏事件
    let sse_url = format!("http://127.0.0.1:{}/global/event", port);
    let sse_resp = crate::agent::client::client()
        .get(&sse_url)
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("SSE connect: {}", e)))?;

    // 2. 后台发消息（fire-and-forget）
    let msg_url = format!("http://127.0.0.1:{}/session/{}/message", port, session_id);
    let body = build_msg_body(message_text, model_id, provider_id, agent);
    tokio::spawn(async move {
        if let Err(e) = crate::agent::client::client()
            .post(&msg_url)
            .json(&body)
            .send()
            .await
        {
            log::warn!("[stream] background message send failed: {}", e);
        }
    });

    // 3. 处理 SSE 事件
    let mut line_buf = String::new();
    // key: part_id → 已发送字节偏移（delta 事件和快照事件共用，防重复）
    let mut part_offsets: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    // 本 session 的 part_id → part_type 映射（从 message.part.updated 注册）
    let mut session_parts: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    let mut stream = sse_resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| crate::AppError::Other(format!("SSE read: {}", e)))?;
        line_buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = line_buf.find('\n') {
            let line: String = line_buf.drain(..=pos).collect();
            let payload = match parse_sse_payload(&line) {
                Some(v) => v,
                None => continue,
            };
            let event_type = payload["type"].as_str().unwrap_or("");
            let props = &payload["properties"];

            match event_type {
                // 注册本 session 的 part，同时作为快照回退路径
                "message.part.updated" => {
                    let part = &props["part"];
                    if part["sessionID"].as_str() != Some(session_id) {
                        continue;
                    }
                    let part_id = part["id"].as_str().unwrap_or("").to_string();
                    let part_type = part["type"].as_str().unwrap_or("").to_string();

                    // 注册 part（供后续 delta 事件过滤使用）
                    session_parts.insert(part_id.clone(), part_type.clone());

                    // tool-use 没有 delta 事件，必须从快照读取
                    // text/reasoning 由 message.part.delta 负责流式，这里不重复发送
                    match part_type.as_str() {
                        "tool-use" | "tool_use" => {
                            let call_id = part["id"].as_str().unwrap_or("").to_string();
                            let name = part["name"]
                                .as_str()
                                .or_else(|| part["tool"].as_str())
                                .unwrap_or("")
                                .to_string();
                            let arguments = match &part["input"] {
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
                        _ => {}
                    }
                }

                // message.part.delta：token 级真实增量（主路径）
                "message.part.delta" => {
                    let part_id = props["partID"].as_str().unwrap_or("");
                    let part_type = match session_parts.get(part_id) {
                        Some(t) => t.as_str(),
                        None => continue, // 不属于本 session 的 part
                    };
                    let field = props["field"].as_str().unwrap_or("");
                    let delta = props["delta"].as_str().unwrap_or("");
                    if delta.is_empty() {
                        continue;
                    }

                    match (part_type, field) {
                        ("text", "text") => {
                            let _ = channel.send(StreamEvent::ContentChunk {
                                delta: delta.to_string(),
                            });
                            // 同步偏移，防止快照事件重复发送
                            let prev = *part_offsets.get(part_id).unwrap_or(&0);
                            part_offsets.insert(part_id.to_string(), prev + delta.len());
                        }
                        ("reasoning", "text") => {
                            let _ = channel.send(StreamEvent::ThinkingChunk {
                                delta: delta.to_string(),
                            });
                            let prev = *part_offsets.get(part_id).unwrap_or(&0);
                            part_offsets.insert(part_id.to_string(), prev + delta.len());
                        }
                        _ => {}
                    }
                }

                "session.error" => {
                    if props["sessionID"].as_str() == Some(session_id) {
                        let err_msg = props["error"]["data"]["message"]
                            .as_str()
                            .or_else(|| props["error"]["message"].as_str())
                            .unwrap_or("Unknown error");
                        let _ = channel.send(StreamEvent::Error {
                            message: err_msg.to_string(),
                        });
                        return Ok(());
                    }
                }

                "session.idle" => {
                    if props["sessionID"].as_str() == Some(session_id) {
                        let _ = channel.send(StreamEvent::Done);
                        return Ok(());
                    }
                }

                // permission.updated：将 title 作为普通文本展示，并自动回复解除 agent 阻塞
                "permission.updated" => {
                    let perm_session = props["sessionID"].as_str().unwrap_or("");
                    if perm_session != session_id {
                        continue;
                    }
                    let permission_id = props["id"].as_str().unwrap_or("");
                    let title = props["title"].as_str().unwrap_or("Tool permission requested");
                    if permission_id.is_empty() {
                        continue;
                    }

                    // 1. 将 permission title 作为普通文本发送给前端
                    let display = format!("\n> [Permission] {}\n\n", title);
                    let _ = channel.send(StreamEvent::ContentChunk {
                        delta: display,
                    });

                    // 2. 自动回复 "always" 以解除 agent 阻塞
                    spawn_auto_permission_respond(port, session_id, permission_id);
                }

                // question.asked：AI agent 请求用户输入
                "question.asked" => {
                    let q_session = props["sessionID"].as_str().unwrap_or("");
                    if q_session != session_id {
                        continue;
                    }
                    let question_id = props["id"].as_str().unwrap_or("");
                    if question_id.is_empty() {
                        continue;
                    }
                    let _ = channel.send(StreamEvent::QuestionRequest {
                        question_id: question_id.to_string(),
                        session_id: session_id.to_string(),
                        questions: props["questions"].clone(),
                    });
                }

                _ => {}
            }
        }
    }

    // SSE 连接意外断开
    let _ = channel.send(StreamEvent::Done);
    Ok(())
}

// ── 内部工具 ──────────────────────────────────────────────────────────────────

fn build_msg_body(
    text: &str,
    model_id: Option<&str>,
    provider_id: Option<&str>,
    agent: Option<&str>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "parts": [{ "type": "text", "text": text }]
    });
    if let Some(m) = model_id {
        let mut model_obj = serde_json::json!({ "modelID": m });
        if let Some(p) = provider_id {
            model_obj["providerID"] = serde_json::Value::String(p.to_string());
        }
        body["model"] = model_obj;
    }
    if let Some(a) = agent {
        body["agent"] = serde_json::Value::String(a.to_string());
    }
    body
}
