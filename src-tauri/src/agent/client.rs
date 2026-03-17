use once_cell::sync::OnceCell;
use reqwest::Client;
use crate::AppResult;

static HTTP_CLIENT: OnceCell<Client> = OnceCell::new();

fn client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .build()
            .expect("Failed to build reqwest client")
    })
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{}", port)
}

/// 创建 session，返回 session_id（opencode 分配的 UUID）
/// POST /session { "title": "..." }
pub async fn create_session(port: u16, title: Option<&str>) -> AppResult<String> {
    let url = format!("{}/session", base_url(port));
    let mut body = serde_json::json!({});
    if let Some(t) = title {
        body["title"] = serde_json::Value::String(t.to_string());
    }
    let resp = client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("create_session request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Other(format!(
            "create_session failed: {} — {}",
            status, text
        )));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| crate::AppError::Other(format!("create_session parse error: {}", e)))?;

    let id = json["id"]
        .as_str()
        .ok_or_else(|| crate::AppError::Other("create_session: missing 'id' field".into()))?
        .to_string();

    Ok(id)
}

/// 删除 session
/// DELETE /session/:id
pub async fn delete_session(port: u16, session_id: &str) -> AppResult<()> {
    let url = format!("{}/session/{}", base_url(port), session_id);
    let resp = client()
        .delete(&url)
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("delete_session request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Other(format!(
            "delete_session failed: {} — {}",
            status, text
        )));
    }
    Ok(())
}

/// 发送消息（返回 Response 供 stream.rs 使用 SSE 流）
/// POST /session/:id/message { "parts": [{"type":"text","text":"..."}], "model": "...", "agent": "..." }
pub async fn send_message(
    port: u16,
    session_id: &str,
    text: &str,
    model: Option<&str>,
    agent: Option<&str>,
) -> AppResult<reqwest::Response> {
    let url = format!("{}/session/{}/message", base_url(port), session_id);
    let mut body = serde_json::json!({
        "parts": [{ "type": "text", "text": text }]
    });
    if let Some(m) = model {
        body["model"] = serde_json::Value::String(m.to_string());
    }
    if let Some(a) = agent {
        body["agent"] = serde_json::Value::String(a.to_string());
    }

    let resp = client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("send_message request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Other(format!(
            "send_message failed: {} — {}",
            status, text
        )));
    }

    Ok(resp)
}

/// 获取 session 消息历史
/// GET /session/:id/message
pub async fn get_messages(port: u16, session_id: &str) -> AppResult<serde_json::Value> {
    let url = format!("{}/session/{}/message", base_url(port), session_id);
    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("get_messages request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Other(format!(
            "get_messages failed: {} — {}",
            status, text
        )));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| crate::AppError::Other(format!("get_messages parse error: {}", e)))?;
    Ok(json)
}

/// 列出所有 session
/// GET /session
pub async fn list_sessions_api(port: u16) -> AppResult<Vec<serde_json::Value>> {
    let url = format!("{}/session", base_url(port));
    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("list_sessions_api request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Other(format!(
            "list_sessions_api failed: {} — {}",
            status, text
        )));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| crate::AppError::Other(format!("list_sessions_api parse error: {}", e)))?;

    let arr = json
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(arr)
}

/// abort session
/// POST /session/:id/abort
pub async fn abort_session(port: u16, session_id: &str) -> AppResult<()> {
    let url = format!("{}/session/{}/abort", base_url(port), session_id);
    let resp = client()
        .post(&url)
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("abort_session request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Other(format!(
            "abort_session failed: {} — {}",
            status, text
        )));
    }
    Ok(())
}

/// permission respond
/// POST /session/:id/permissions/:permissionID { "response": "...", "remember": bool }
pub async fn permission_respond(
    port: u16,
    session_id: &str,
    permission_id: &str,
    response: &str,
    remember: Option<bool>,
) -> AppResult<()> {
    let url = format!(
        "{}/session/{}/permissions/{}",
        base_url(port),
        session_id,
        permission_id
    );
    let mut body = serde_json::json!({ "response": response });
    if let Some(r) = remember {
        body["remember"] = serde_json::Value::Bool(r);
    }

    let resp = client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("permission_respond request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Other(format!(
            "permission_respond failed: {} — {}",
            status, text
        )));
    }
    Ok(())
}

/// 热更新模型配置
/// PATCH /config { "model": "...", "provider": "..." }
pub async fn patch_config(port: u16, model: &str, provider: &str) -> AppResult<()> {
    let url = format!("{}/config", base_url(port));
    let body = serde_json::json!({ "model": model, "provider": provider });

    let resp = client()
        .patch(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::AppError::Other(format!("patch_config request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::AppError::Other(format!(
            "patch_config failed: {} — {}",
            status, text
        )));
    }
    Ok(())
}
