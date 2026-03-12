use std::sync::Arc;
use std::process::Stdio;

use agent_client_protocol::{
    Agent, Client, ClientSideConnection, InitializeRequest, InitializeResponse,
    NewSessionRequest, NewSessionResponse, ProtocolVersion,
    RequestPermissionRequest, RequestPermissionResponse, RequestPermissionOutcome,
    SessionNotification, SessionUpdate, ContentBlock,
    McpServer, McpServerHttp,
};
use tokio::process::Command;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::llm::StreamEvent;

/// ACP client handler — receives session notifications from opencode and
/// forwards them as `StreamEvent` messages to the frontend channel.
pub struct AcpClientHandler {
    pub tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
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
                    let _ = self.tx.send(StreamEvent::ContentChunk { delta: t.text });
                }
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                if let ContentBlock::Text(t) = chunk.content {
                    let _ = self.tx.send(StreamEvent::ThinkingChunk { delta: t.text });
                }
            }
            SessionUpdate::ToolCall(tc) => {
                let _ = self.tx.send(StreamEvent::ToolCallRequest {
                    call_id: tc.tool_call_id.to_string(),
                    name: tc.title,
                    arguments: tc
                        .raw_input
                        .as_ref()
                        .map(|v| v.to_string())
                        .unwrap_or_default(),
                });
            }
            _ => {}
        }
        Ok(())
    }

    async fn request_permission(
        &self,
        req: RequestPermissionRequest,
    ) -> agent_client_protocol::Result<RequestPermissionResponse> {
        // Auto-approve: pick the first AllowOnce option; fall back to Cancelled
        // if no suitable option is found (edge case).
        use agent_client_protocol::PermissionOptionKind;
        let allow_option = req.options.iter().find(|o| {
            matches!(o.kind, PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways)
        });

        let outcome = if let Some(opt) = allow_option {
            RequestPermissionOutcome::Selected(
                agent_client_protocol::SelectedPermissionOutcome::new(opt.option_id.clone()),
            )
        } else {
            RequestPermissionOutcome::Cancelled
        };

        Ok(RequestPermissionResponse::new(outcome))
    }
}

/// Spawns `opencode acp`, completes the ACP handshake, injects the MCP server,
/// and returns the connection wrapped in `Arc<Mutex<...>>`, the session ID, and
/// the child process handle.
pub async fn start_acp_session(
    mcp_port: u16,
    cwd: &std::path::Path,
    tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
) -> crate::AppResult<(
    Arc<tokio::sync::Mutex<ClientSideConnection>>,
    String,
    tokio::process::Child,
)> {
    let mut child = Command::new("opencode")
        .arg("acp")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| crate::AppError::Other(format!("Failed to spawn opencode: {}", e)))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| crate::AppError::Other("No stdin handle from opencode process".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| crate::AppError::Other("No stdout handle from opencode process".into()))?;

    // Convert tokio AsyncRead/AsyncWrite to futures AsyncRead/AsyncWrite
    let outgoing = stdin.compat_write();
    let incoming = stdout.compat();

    let handler = AcpClientHandler { tx };

    // ClientSideConnection::new returns a !Send io_future (uses LocalBoxFuture internally).
    // We must spawn the io_future on a LocalSet; here we use spawn_local via tokio's
    // current-thread runtime (Tauri's async runtime is multi-thread, so we use
    // tokio::task::spawn_local inside a LocalSet that was set up by the caller,
    // or fall back to a dedicated thread with a LocalSet).
    let (connection, io_future) = ClientSideConnection::new(
        handler,
        outgoing,
        incoming,
        |fut| {
            // The io_future itself is !Send; spawn it on a new thread with its own LocalSet.
            tokio::task::spawn_local(fut);
        },
    );

    // Spawn the io_future on a dedicated thread that owns a LocalSet so that !Send
    // futures can run without requiring Send bounds.
    tokio::task::spawn_local(async move {
        if let Err(e) = io_future.await {
            eprintln!("[acp] io_future ended with error: {}", e);
        }
    });

    let connection = Arc::new(tokio::sync::Mutex::new(connection));

    // ACP handshake: initialize
    {
        let conn = connection.lock().await;
        let _: InitializeResponse = conn
            .initialize(InitializeRequest::new(ProtocolVersion::LATEST))
            .await
            .map_err(|e| crate::AppError::Other(format!("ACP initialize failed: {}", e)))?;
    }

    // Create a new session and inject our MCP server
    let mcp_url = format!("http://127.0.0.1:{}/mcp", mcp_port);
    let session_resp: NewSessionResponse = {
        let conn = connection.lock().await;
        conn.new_session(
            NewSessionRequest::new(cwd).mcp_servers(vec![McpServer::Http(
                McpServerHttp::new("db-tools", &mcp_url),
            )]),
        )
        .await
        .map_err(|e| crate::AppError::Other(format!("ACP new_session failed: {}", e)))?
    };

    let session_id = session_resp.session_id.to_string();
    Ok((connection, session_id, child))
}
