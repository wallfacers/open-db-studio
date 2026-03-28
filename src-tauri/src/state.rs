use std::collections::HashMap;

/// MCP UI 操作（focus_tab/open_tab）的回调响应
#[derive(Debug)]
pub struct UiActionResponse {
    pub success: bool,
    pub data: Option<serde_json::Value>,
    pub error: Option<String>,
}

/// 全局应用状态（注入 Tauri manage）
pub struct AppState {
    pub mcp_port: u16,
    /// 应用数据目录（%APPDATA%\com.open-db-studio.app），启动时设置，不可变
    pub app_data_dir: std::path::PathBuf,

    // ── Serve 模式（opencode HTTP Serve）────────────────────────────────────
    /// opencode HTTP Serve 子进程句柄
    pub serve_child: tokio::sync::Mutex<Option<tokio::process::Child>>,
    /// opencode serve 监听端口（从 app_settings 读取，默认 4096）
    pub serve_port: u16,
    /// 当前 SQL 解释专用的 opencode session ID
    pub current_explain_session_id: tokio::sync::Mutex<Option<String>>,

    // ── 共享字段 ─────────────────────────────────────────────────────────────
    /// 编辑器 SQL per session，供 MCP get_editor_sql 工具读取
    pub editor_sql_map: tokio::sync::Mutex<HashMap<String, Option<String>>>,
    /// 最近活跃的 session_id（MCP 工具调用时用于查找对应 SQL）
    pub last_active_session_id: tokio::sync::Mutex<Option<String>>,
    /// propose_sql_diff 阻塞等待用户确认的 oneshot channel sender
    /// MCP 工具调用时存入，前端调用 mcp_diff_respond 命令时取出并发送结果
    pub pending_diff_response: tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
    /// MCP UI 操作 (focus_tab/open_tab) 的 oneshot channel，key=request_id
    pub pending_ui_actions: tokio::sync::Mutex<
        std::collections::HashMap<String, tokio::sync::oneshot::Sender<UiActionResponse>>
    >,
    /// MCP 读查询 (ui-request/mcp_query_respond) 的 oneshot channel，key=request_id
    pub pending_queries: tokio::sync::Mutex<
        std::collections::HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>
    >,
    /// Auto 模式：true=自动执行写操作，false=需要确认
    pub auto_mode: tokio::sync::Mutex<bool>,

    /// 运行中任务的取消句柄（task_id → AbortHandle），用于真正中断后台 tokio 任务
    pub task_abort_handles: std::sync::Mutex<HashMap<String, tokio::task::AbortHandle>>,

    /// 图谱内存缓存（懒加载，按 connection_id 键）
    pub graph_cache: crate::graph::GraphCacheStore,
}
