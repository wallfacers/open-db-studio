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
    /// 发送取消信号：drop 或 send 均会触发 session 线程 kill child process
    pub abort_tx: tokio::sync::oneshot::Sender<()>,
    /// 待处理的权限确认请求，key = permission_id（UUID）
    /// Arc 与 AcpClientHandler 中的字段共享同一实例
    pub pending_permissions: std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<
                String,
                tokio::sync::oneshot::Sender<PermissionReply>,
            >,
        >,
    >,
}

/// 用户对权限请求的回复（内部类型，避免与 ACP crate 命名冲突）
pub struct PermissionReply {
    pub selected_option_id: String, // 用户选择的 option_id；取消时为空字符串
    pub cancelled: bool,            // true = 用户关闭面板（取消）
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
    /// SQL 优化专用 ACP session（每次优化创建新 session，存储仅用于取消）
    pub optimize_acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
    /// SQL 解释专用 ACP session（每次解释创建新 session，存储仅用于取消）
    pub explain_acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
}
