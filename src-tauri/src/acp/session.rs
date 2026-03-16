//! 持久化 ACP session 管理
//!
//! `spawn_acp_session_thread` 启动一个专用线程，该线程：
//! 1. 写 opencode.json → 启动 opencode-cli → ACP 握手
//! 2. 握手成功后删除 opencode.json（进程已读取，无需保留明文 key）
//! 3. 进入循环：等待 AcpRequest → 设 event_tx → prompt → 清 event_tx → 发 done
//! 4. request_tx 全部 drop 后退出循环，kill 子进程

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

use agent_client_protocol::{Agent, ContentBlock, PromptRequest, TextContent};

use crate::error::{AppError, AppResult};
use crate::llm::StreamEvent;
use crate::state::{AcpRequest, PersistentAcpSession};

/// 启动持久化 ACP session 线程。
///
/// 函数会阻塞直到 ACP 握手完成（或失败）。
/// 成功后返回 `PersistentAcpSession`，调用方可通过其 `request_tx` 发送 prompt 请求。
pub async fn spawn_acp_session_thread(
    api_key: String,
    base_url: String,
    model: String,
    api_type: String,
    preset: Option<String>,
    config_id: i64,
    mcp_url: String,
    cwd: PathBuf,
    // 用于在 session 建立阶段向前端发送进度通知（可为 None）
    status_tx: Option<tokio::sync::mpsc::UnboundedSender<StreamEvent>>,
) -> AppResult<PersistentAcpSession> {
    // 写 opencode.json（进程启动后会读取它）
    crate::acp::config::write_opencode_config(
        &api_key,
        Some(&base_url),
        &model,
        &api_type,
        preset.as_deref(),
        &cwd,
    )?;

    // 创建 prompt 请求 channel（tx 存入 AppState，rx 传入线程）
    let (request_tx, request_rx) = tokio::sync::mpsc::unbounded_channel::<AcpRequest>();

    // 取消信号 channel：abort_tx 存入 AppState，drop 时触发 session kill child
    let (abort_tx, abort_rx) = tokio::sync::oneshot::channel::<()>();

    // 用于等待线程完成握手的 oneshot channel
    let (setup_tx, setup_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("acp session local runtime");
        let local = tokio::task::LocalSet::new();

        local.block_on(&rt, async move {
            session_loop(mcp_url, cwd, request_rx, abort_rx, setup_tx, status_tx).await;
        });
    });

    // 等待握手结果
    setup_rx
        .await
        .map_err(|_| AppError::Other("ACP session thread died before setup completed".into()))??;

    Ok(PersistentAcpSession { config_id, config_fingerprint: String::new(), request_tx, abort_tx })
}

/// 向前端发送 StatusUpdate 事件（status_tx 为 None 时静默跳过）
fn send_status(tx: &Option<UnboundedSender<StreamEvent>>, msg: &str) {
    if let Some(ref t) = tx {
        let _ = t.send(StreamEvent::StatusUpdate { message: msg.to_string() });
    }
}

/// session 线程主循环（在专用 current-thread 运行时 + LocalSet 内执行）
async fn session_loop(
    mcp_url: String,
    cwd: PathBuf,
    mut request_rx: tokio::sync::mpsc::UnboundedReceiver<AcpRequest>,
    abort_rx: tokio::sync::oneshot::Receiver<()>,
    setup_tx: tokio::sync::oneshot::Sender<AppResult<()>>,
    status_tx: Option<UnboundedSender<StreamEvent>>,
) {
    // 共享 event sender：每次 prompt 前由循环设置，prompt 后清空
    let shared_event_tx: Arc<Mutex<Option<UnboundedSender<StreamEvent>>>> =
        Arc::new(Mutex::new(None));

    // 启动 ACP session（握手）— 内部会发送细粒度状态通知
    let t_total = std::time::Instant::now();
    let (connection, session_id, mut child) =
        match crate::acp::client::start_acp_session(
            &mcp_url,
            &cwd,
            Arc::clone(&shared_event_tx),
            status_tx.as_ref(),
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                let _ = setup_tx.send(Err(e));
                return;
            }
        };
    log::info!("[acp] session fully ready ({:.1}s total)", t_total.elapsed().as_secs_f32());

    // 握手成功，删除含明文 API key 的 opencode.json
    let config_path = cwd.join("opencode.json");
    if let Err(e) = std::fs::remove_file(&config_path) {
        log::warn!("[acp] Failed to delete opencode.json after session start: {}", e);
    } else {
        log::info!("[acp] Deleted opencode.json after session start");
    }

    send_status(&status_tx, "连接就绪");

    // 通知调用方握手成功
    let _ = setup_tx.send(Ok(()));

    log::info!("[acp] Persistent session ready (session_id={})", session_id);

    // 将 abort_rx 包成 fuse，方便在 select! 中多次使用
    let mut abort_rx = std::pin::pin!(abort_rx);

    // Prompt 处理循环
    loop {
        tokio::select! {
            // 取消信号（abort_tx drop 或 send 均触发）
            _ = &mut abort_rx => {
                log::info!("[acp] Session aborted by user, killing opencode-cli");
                let _ = child.kill().await;
                return;
            }
            maybe_req = request_rx.recv() => {
                let req = match maybe_req {
                    Some(r) => r,
                    None => break, // request_tx 全部 drop，正常退出
                };

                // 设置当前请求的 event sender
                *shared_event_tx.lock().unwrap() = Some(req.event_tx);

                // 执行 prompt，同时监听取消信号
                let content_blocks = vec![ContentBlock::Text(TextContent::new(req.prompt_text))];
                let result = tokio::select! {
                    _ = &mut abort_rx => {
                        log::info!("[acp] Prompt aborted mid-flight, killing opencode-cli");
                        let _ = child.kill().await;
                        *shared_event_tx.lock().unwrap() = None;
                        // done_tx dropped here，调用方 done_rx.await 返回 Err
                        return;
                    }
                    r = async {
                        let conn = connection.lock().await;
                        conn.prompt(PromptRequest::new(session_id.clone(), content_blocks)).await
                    } => r,
                };

                // 清空 event sender
                *shared_event_tx.lock().unwrap() = None;

                let outcome = match result {
                    Ok(resp) => {
                        log::info!("[acp] Prompt done, stop_reason: {:?}", resp.stop_reason);
                        Ok(())
                    }
                    Err(e) => Err(AppError::Other(format!("ACP prompt failed: {}", e))),
                };
                let _ = req.done_tx.send(outcome);
            }
        }
    }

    // request_tx 全部 drop 后退出循环，清理进程
    log::info!("[acp] Session loop exiting, killing opencode-cli");
    let _ = child.kill().await;
}
