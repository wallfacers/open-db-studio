/// 全局应用状态（注入 Tauri manage）
pub struct AppState {
    /// MCP HTTP Server 监听的端口
    pub mcp_port: u16,
    /// 当前活跃的 opencode ACP 进程 PID（None = 无活跃会话）
    pub active_acp_pid: std::sync::Arc<std::sync::Mutex<Option<u32>>>,
}
