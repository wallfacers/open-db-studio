use std::collections::HashMap;
use tokio::sync::mpsc::UnboundedSender;
use crate::llm::StreamEvent;

/// 一条 ACP prompt 请求，通过 channel 发往 session 线程
pub struct AcpRequest {
    pub prompt_text: String,
    pub event_tx: UnboundedSender<StreamEvent>,
    pub done_tx: tokio::sync::oneshot::Sender<crate::error::AppResult<()>>,
}

/// 持久化 ACP session 句柄，存于 AppState
pub struct PersistentAcpSession {
    pub config_id: i64,
    pub config_fingerprint: String,
    pub request_tx: UnboundedSender<AcpRequest>,
}

/// 全局应用状态（注入 Tauri manage）
pub struct AppState {
    pub mcp_port: u16,
    /// key = frontend_session_id（UUID 字符串），每个前端 session 独立 ACP 进程
    pub acp_sessions: tokio::sync::Mutex<HashMap<String, PersistentAcpSession>>,
    /// 编辑器 SQL per session，供 MCP get_editor_sql 工具读取
    pub editor_sql_map: tokio::sync::Mutex<HashMap<String, Option<String>>>,
    /// 最近活跃的 session_id（MCP 工具调用时用于查找对应 SQL）
    pub last_active_session_id: tokio::sync::Mutex<Option<String>>,
}
