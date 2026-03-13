use tokio::sync::mpsc::UnboundedSender;
use crate::llm::StreamEvent;

/// 一条 ACP prompt 请求，通过 channel 发往 session 线程
pub struct AcpRequest {
    /// 已构建好的完整 prompt 文本（含 SQL 上下文）
    pub prompt_text: String,
    /// 流式事件回传通道（ContentChunk / ThinkingChunk / ToolCallRequest）
    pub event_tx: UnboundedSender<StreamEvent>,
    /// 请求完成信号（Ok = 成功，Err = 失败消息）
    pub done_tx: tokio::sync::oneshot::Sender<crate::error::AppResult<()>>,
}

/// 持久化 ACP session 句柄，存于 AppState
pub struct PersistentAcpSession {
    /// 创建此 session 时使用的 LLM 配置 ID
    pub config_id: i64,
    /// 创建此 session 时的配置内容指纹（检测同 ID 配置被修改的情况）
    pub config_fingerprint: String,
    /// 向 session 线程发送 prompt 请求
    pub request_tx: UnboundedSender<AcpRequest>,
}

/// 全局应用状态（注入 Tauri manage）
pub struct AppState {
    /// MCP HTTP Server 监听端口
    pub mcp_port: u16,
    /// 当前持久化 ACP session（None = 尚未建立）
    /// 使用 tokio::sync::Mutex 以便在 async 函数中跨 await 持锁
    pub acp_session: tokio::sync::Mutex<Option<PersistentAcpSession>>,
    /// 最近一次 ai_chat_acp 传入的编辑器 SQL（供 MCP get_editor_sql 工具读取）
    /// MVP：全局单一字段，仅支持单一活跃 Tab 场景
    pub current_editor_sql: tokio::sync::Mutex<Option<String>>,
}
