use std::sync::Arc;
use tokio::sync::Mutex;

/// 全局应用状态（注入 Tauri manage）
pub struct AppState {
    /// MCP HTTP Server 监听的端口
    pub mcp_port: u16,
    /// 当前活跃的 ACP 会话
    pub acp_session: Arc<Mutex<Option<AcpSession>>>,
    /// 当前活跃的 opencode ACP 进程 PID（None = 无活跃会话）
    pub active_acp_pid: Arc<std::sync::Mutex<Option<u32>>>,
}

/// ACP 会话上下文
pub struct AcpSession {
    pub session_id: String,
    pub connection: Arc<Mutex<agent_client_protocol::ClientSideConnection>>,
    pub child_handle: tokio::process::Child,
}
