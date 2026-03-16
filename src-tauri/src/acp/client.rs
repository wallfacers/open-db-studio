use std::sync::Arc;
use std::process::Stdio;

use agent_client_protocol::{
    Agent, Client, ClientSideConnection, InitializeRequest, InitializeResponse,
    NewSessionRequest, NewSessionResponse, ProtocolVersion,
    RequestPermissionRequest, RequestPermissionResponse, RequestPermissionOutcome,
    SelectedPermissionOutcome, PermissionOptionKind,
    SessionNotification, SessionUpdate, ContentBlock,
    McpServer, McpServerHttp,
};
use tokio::process::Command;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::llm::StreamEvent;

/// ACP client handler — receives session notifications from opencode and
/// forwards them as `StreamEvent` messages to the current request's event channel.
///
/// `tx` 是共享的可替换 sender：
/// - session 线程在每次 prompt 前将其设为当前请求的 event_tx
/// - session 线程在 prompt 完成后将其清为 None
/// - 使用 std::sync::Mutex（不跨 await 持锁，性能足够）
pub struct AcpClientHandler {
    pub(crate) tx: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<StreamEvent>>>>,
    pub(crate) pending_permissions: std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<
                String,
                tokio::sync::oneshot::Sender<crate::state::PermissionReply>,
            >,
        >,
    >,
}

#[async_trait::async_trait(?Send)]
impl Client for AcpClientHandler {
    async fn session_notification(
        &self,
        notif: SessionNotification,
    ) -> agent_client_protocol::Result<()> {
        match notif.update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                if let ContentBlock::Text(t) = chunk.content {
                    let tx_opt = { self.tx.lock().unwrap().clone() };
                    if let Some(ref tx) = tx_opt {
                        if tx.send(StreamEvent::ContentChunk { delta: t.text }).is_err() {
                            log::debug!("[acp] tx send failed, receiver dropped");
                        }
                    }
                }
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                if let ContentBlock::Text(t) = chunk.content {
                    let tx_opt = { self.tx.lock().unwrap().clone() };
                    if let Some(ref tx) = tx_opt {
                        if tx.send(StreamEvent::ThinkingChunk { delta: t.text }).is_err() {
                            log::debug!("[acp] tx send failed, receiver dropped");
                        }
                    }
                }
            }
            SessionUpdate::ToolCall(tc) => {
                let ev = StreamEvent::ToolCallRequest {
                    call_id: tc.tool_call_id.to_string(),
                    name: tc.title,
                    arguments: tc
                        .raw_input
                        .as_ref()
                        .map(|v| v.to_string())
                        .unwrap_or_default(),
                };
                let tx_opt = { self.tx.lock().unwrap().clone() };
                if let Some(ref tx) = tx_opt {
                    if tx.send(ev).is_err() {
                        log::debug!("[acp] tx send failed, receiver dropped");
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn request_permission(
        &self,
        req: RequestPermissionRequest,
    ) -> agent_client_protocol::Result<RequestPermissionResponse> {
        let permission_id = uuid::Uuid::new_v4().to_string();

        // 1. 构建选项列表（单次 match 同时解构 label/kind，避免对非 Copy 枚举二次移动）
        // PermissionOptionKind 是 #[non_exhaustive]，需保留 `_` 通配分支
        let options: Vec<crate::llm::PermissionOption> = req.options.iter().map(|o| {
            let (label, kind) = match o.kind {
                PermissionOptionKind::AllowOnce   => ("允许一次", "allow_once"),
                PermissionOptionKind::AllowAlways => ("总是允许", "allow_always"),
                PermissionOptionKind::RejectOnce  => ("拒绝一次", "reject_once"),
                PermissionOptionKind::RejectAlways => ("总是拒绝", "reject_always"),
                _                                 => ("拒绝",     "deny"),
            };
            crate::llm::PermissionOption {
                option_id: o.option_id.to_string(),
                label: label.to_string(),
                kind: kind.to_string(),
            }
        }).collect();

        // 2. 创建 oneshot channel，tx 存入 pending map（短暂持锁，不跨 await）
        let (tx, rx) = tokio::sync::oneshot::channel::<crate::state::PermissionReply>();
        {
            self.pending_permissions
                .lock().unwrap()
                .insert(permission_id.clone(), tx);
        }

        // 3. 构建工具描述信息（从 tool_call.fields.title 中获取）
        let message = req.tool_call.fields.title
            .as_deref()
            .unwrap_or("工具执行")
            .to_string();

        // 4. 发送 PermissionRequest 事件给前端（短暂持锁，不跨 await）
        {
            let tx_opt = self.tx.lock().unwrap().clone();
            if let Some(ref event_tx) = tx_opt {
                let _ = event_tx.send(crate::llm::StreamEvent::PermissionRequest {
                    permission_id: permission_id.clone(),
                    message,
                    options,
                });
            }
        }

        // 5. 等待用户响应
        // LocalSet 内 rx.await 的安全性：
        // - rx.await 挂起当前 task，LocalSet 继续轮询 io_future 等其他 task
        // - Tauri 命令（多线程 runtime）调用 tx.send()，oneshot::Sender 是 Send 可跨线程
        // - tx.send() 触发 waker，LocalSet 下次轮询时恢复此 future
        let reply = rx.await.unwrap_or(crate::state::PermissionReply {
            selected_option_id: String::new(),
            cancelled: true,
        });

        // 6. 兜底清理（正常情况 rx.await 已消费，此处防止异常泄漏）
        self.pending_permissions.lock().unwrap().remove(&permission_id);

        // 7. 转换为 ACP 响应
        let outcome = if reply.cancelled {
            RequestPermissionOutcome::Cancelled
        } else {
            RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(reply.selected_option_id),
            )
        };
        Ok(RequestPermissionResponse::new(outcome))
    }
}

/// A boxed `!Send` future with `'static` lifetime, matching `LocalBoxFuture<'static, ()>`.
type LocalFutureBox = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'static>>;

/// Newtype that makes a `!Send` local future sendable across the mpsc channel boundary.
///
/// SAFETY: The future is only ever polled on the dedicated single-threaded local runtime;
/// it is never sent to another executor.  The channel is solely used to transfer ownership
/// from the spawning thread (which creates the future) to the dedicated local thread.
struct SendableLocalFuture(LocalFutureBox);

// SAFETY: see above — the future is only polled on the dedicated local thread.
#[allow(unsafe_code)]
unsafe impl Send for SendableLocalFuture {}

/// Runs all `!Send` ACP futures on a dedicated current-thread runtime with a `LocalSet`.
///
/// `ClientSideConnection` uses `Rc` / `LocalBoxFuture` internally, so neither the
/// io_future nor the internal spawn callbacks are `Send`.  Tauri uses a multi-thread
/// tokio runtime that has no ambient `LocalSet`, so calling `spawn_local` there would
/// panic.  Instead we funnel every `LocalBoxFuture` through a `tokio::sync::mpsc`
/// channel to a dedicated thread that owns a single-threaded runtime + `LocalSet`.
///
/// IMPORTANT: must use async `rx.recv().await` (not blocking `rx.recv()`) so the
/// LocalSet executor can poll already-spawned futures (e.g. io_future) while waiting
/// for the next task.  Using a synchronous blocking recv would deadlock the executor.
fn spawn_local_thread() -> tokio::sync::mpsc::UnboundedSender<SendableLocalFuture> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SendableLocalFuture>();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("acp local runtime");
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async move {
            // Drain the channel asynchronously, yielding between receives so that
            // already-spawned local futures (io_future, dispatch loop) can be polled.
            while let Some(wrapped) = rx.recv().await {
                tokio::task::spawn_local(wrapped.0);
            }
        });
    });

    tx
}

/// Spawns `opencode acp`, completes the ACP handshake, injects the MCP server,
/// and returns the connection wrapped in `Arc<Mutex<...>>`, the session ID, and
/// the child process handle.
///
/// # Errors
/// Returns an error if the opencode process cannot be spawned, or if the ACP
/// handshake (initialize / new_session) fails.  On failure the child process is
/// killed before returning so no orphan processes are left behind.
pub async fn start_acp_session(
    mcp_url: &str,
    cwd: &std::path::Path,
    shared_event_tx: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<StreamEvent>>>>,
    status_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamEvent>>,
) -> crate::AppResult<(
    Arc<tokio::sync::Mutex<ClientSideConnection>>,
    String,
    tokio::process::Child,
    std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<crate::state::PermissionReply>>>>,
)> {
    let config_path = cwd.join("opencode.json");

    let send_status = |msg: &str| {
        if let Some(tx) = status_tx {
            let _ = tx.send(StreamEvent::StatusUpdate { message: msg.to_string() });
        }
    };

    send_status("正在启动 AI 引擎...");
    let t0 = std::time::Instant::now();

    let mut child = Command::new("opencode-cli")
        .arg("acp")
        .current_dir(cwd)
        .env("OPENCODE_CONFIG", &config_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| crate::AppError::Other(format!("Failed to spawn opencode-cli: {}", e)))?;
    log::info!("[acp] opencode-cli spawned ({:.1}s)", t0.elapsed().as_secs_f32());

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| crate::AppError::Other("No stdin handle from opencode process".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| crate::AppError::Other("No stdout handle from opencode process".into()))?;

    // Convert tokio AsyncRead/AsyncWrite to futures AsyncRead/AsyncWrite required by
    // ClientSideConnection (which uses the `futures` crate traits, not tokio's).
    let outgoing = stdin.compat_write();
    let incoming = stdout.compat();

    // Start the dedicated local thread.  We keep the sender alive for the lifetime
    // of the session; dropping it will cause the thread to exit.
    let local_tx = spawn_local_thread();
    let local_tx_for_spawn = local_tx.clone();

    let pending_permissions_arc = Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let handler = AcpClientHandler {
        tx: shared_event_tx,
        pending_permissions: Arc::clone(&pending_permissions_arc),
    };

    // The spawn callback is called synchronously inside ClientSideConnection::new
    // (via handle_incoming) to schedule the internal message-dispatch loop.
    // We forward every LocalBoxFuture to the dedicated local thread.
    let (connection, io_future) = ClientSideConnection::new(
        handler,
        outgoing,
        incoming,
        move |fut| {
            if local_tx_for_spawn.send(SendableLocalFuture(fut)).is_err() {
                log::error!("[acp] local thread channel closed unexpectedly");
            }
        },
    );

    // Also send the io_future (the I/O read/write loop) to the local thread.
    let io_fut_wrapped: LocalFutureBox = Box::pin(async move {
        if let Err(e) = io_future.await {
            log::error!("[acp] io_future ended with error: {}", e);
        }
    });
    if local_tx.send(SendableLocalFuture(io_fut_wrapped)).is_err() {
        // Kill the child to avoid an orphan process before returning the error.
        let _ = child.kill().await;
        return Err(crate::AppError::Other(
            "ACP local thread channel closed before io_future could be sent".into(),
        ));
    }

    let connection = Arc::new(tokio::sync::Mutex::new(connection));

    // Helper macro: on any handshake error, kill the child to avoid orphan processes,
    // then return the error.  `child` remains owned by this scope until the Ok return.
    macro_rules! handshake {
        ($result:expr, $msg:literal) => {
            match $result {
                Ok(v) => v,
                Err(e) => {
                    let _ = child.kill().await;
                    return Err(crate::AppError::Other(format!("{}: {}", $msg, e)));
                }
            }
        };
    }

    // ── ACP handshake: initialize ──────────────────────────────────────────────
    send_status("正在握手...");
    let t_init = std::time::Instant::now();
    {
        let conn = connection.lock().await;
        let _: InitializeResponse = handshake!(
            conn.initialize(InitializeRequest::new(ProtocolVersion::LATEST)).await,
            "ACP initialize failed"
        );
    }
    log::info!("[acp] initialize done ({:.1}s)", t_init.elapsed().as_secs_f32());

    // ── ACP handshake: new_session (injects MCP server) ───────────────────────
    // NOTE: new_session triggers listTools() on the MCP server, which may take
    // several seconds on first call (transport negotiation + tool discovery).
    send_status("正在加载数据库工具...");
    let t_sess = std::time::Instant::now();
    let session_resp: NewSessionResponse = {
        let conn = connection.lock().await;
        handshake!(
            conn.new_session(
                NewSessionRequest::new(cwd).mcp_servers(vec![McpServer::Http(
                    McpServerHttp::new("db-tools", mcp_url),
                )]),
            )
            .await,
            "ACP new_session failed"
        )
    };
    log::info!("[acp] new_session done ({:.1}s, total from spawn: {:.1}s)",
        t_sess.elapsed().as_secs_f32(), t0.elapsed().as_secs_f32());

    let session_id = session_resp.session_id.to_string();
    Ok((connection, session_id, child, pending_permissions_arc))
}
