use crate::AppResult;
use tauri::{Emitter, Manager};

const HEALTH_POLL_INTERVAL_MS: u64 = 500;
const HEALTH_POLL_MAX_ATTEMPTS: u32 = 20; // 10 seconds total

/// Find the first available TCP port starting from `base_port`.
/// Tries up to 20 consecutive ports; returns `base_port` as fallback if all are busy.
pub fn find_available_port(base_port: u16) -> u16 {
    for offset in 0u16..20 {
        let port = base_port.saturating_add(offset);
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    base_port
}

/// Check whether the serve process is already running by hitting the health endpoint.
/// Accepts a shared `reqwest::Client` to avoid per-call allocation.
async fn check_health(client: &reqwest::Client, port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/global/health", port);
    client
        .get(&url)
        .timeout(std::time::Duration::from_millis(800))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Poll health endpoint until success or timeout (10 s / 20 attempts).
/// Accepts a shared `reqwest::Client` to avoid per-call allocation.
async fn wait_for_health(client: &reqwest::Client, port: u16) -> bool {
    for _ in 0..HEALTH_POLL_MAX_ATTEMPTS {
        if check_health(client, port).await {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
    }
    false
}

/// Spawn `opencode-cli serve --port {port}` and return the child handle.
fn spawn_child(
    agent_dir: &std::path::Path,
    port: u16,
) -> std::io::Result<tokio::process::Child> {
    tokio::process::Command::new("opencode-cli")
        .args(["serve", "--port", &port.to_string()])
        .current_dir(agent_dir)
        .kill_on_drop(false) // we manage lifecycle explicitly
        .spawn()
}

/// Core logic: attempt to start serve once.
/// Returns Ok(Some(child)) when a new process was spawned,
/// Ok(None) when opencode is already running externally,
/// Err on failure.
async fn try_start(
    agent_dir: &std::path::Path,
    port: u16,
) -> AppResult<Option<tokio::process::Child>> {
    // Fix I1: create the client once and reuse across health checks.
    let client = reqwest::Client::new();

    // Fix C2: when already running, return None instead of a sentinel child.
    if check_health(&client, port).await {
        log::info!(
            "opencode serve already running on port {}; skipping spawn",
            port
        );
        return Ok(None);
    }

    // Ensure the agent directory exists.
    std::fs::create_dir_all(agent_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create agent dir: {}", e)))?;

    let child = spawn_child(agent_dir, port)
        .map_err(|e| crate::AppError::Other(format!("Failed to spawn opencode-cli: {}", e)))?;

    if !wait_for_health(&client, port).await {
        return Err(crate::AppError::Other(
            "opencode serve did not become healthy within 10s. \
             Please check that opencode-cli is installed and accessible in PATH."
                .to_string(),
        ));
    }

    log::info!("opencode serve started successfully on port {}", port);
    Ok(Some(child))
}

/// Background task that monitors the serve child process and restarts it on crash.
async fn crash_monitor(app_handle: tauri::AppHandle, agent_dir: std::path::PathBuf, port: u16) {
    let mut retry_count: u32 = 0;

    loop {
        // Fix C1: take the child out of the Mutex *before* calling wait(),
        // so the lock is released while we block on the child.
        let maybe_child = {
            let state = app_handle.state::<crate::AppState>();
            let mut guard = state.serve_child.lock().await;

            // Fix C2: None means an external process — no crash monitoring needed.
            if guard.is_none() {
                drop(guard);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }

            guard.take() // moves child out; lock released when guard drops here
        };

        if let Some(mut child) = maybe_child {
            match child.wait().await {
                Ok(status) => {
                    log::warn!("opencode serve exited with status: {}", status);
                }
                Err(e) => {
                    log::warn!("opencode serve wait error: {}", e);
                }
            }
        }

        // Fix I4: attempt restart first, then check the retry budget.
        log::info!(
            "Attempting to restart opencode serve (attempt {})...",
            retry_count + 1
        );
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        match try_start(&agent_dir, port).await {
            Ok(new_child_opt) => {
                let state = app_handle.state::<crate::AppState>();
                let mut guard = state.serve_child.lock().await;
                *guard = new_child_opt;
                retry_count = 0;
                log::info!("opencode serve restarted successfully");
                let _ = app_handle.emit("serve_restarted", ());
            }
            Err(e) => {
                log::error!("Failed to restart opencode serve: {}", e);
                retry_count += 1;
                if retry_count >= 3 {
                    log::error!(
                        "opencode serve failed to restart {} time(s); giving up",
                        retry_count
                    );
                    let _ = app_handle.emit("serve_failed", ());
                    break;
                }
            }
        }
    }
}

/// Start the opencode HTTP serve process.
///
/// Called once during app setup. Failure only emits a warning so users without
/// opencode-cli can still use other app features.
pub async fn start_serve(
    app_handle: tauri::AppHandle,
    app_data_dir: &std::path::Path,
    port: u16,
) -> AppResult<()> {
    let agent_dir = app_data_dir.join("agent");

    match try_start(&agent_dir, port).await {
        Ok(child_opt) => {
            {
                let state = app_handle.state::<crate::AppState>();
                let mut guard = state.serve_child.lock().await;
                *guard = child_opt;
            }

            // Spawn crash monitor in background.
            let handle_clone = app_handle.clone();
            let dir_clone = agent_dir.clone();
            tauri::async_runtime::spawn(async move {
                crash_monitor(handle_clone, dir_clone, port).await;
            });

            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Stop the opencode serve child process (called on app exit).
pub async fn stop_serve(app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<crate::AppState>();
    let mut guard = state.serve_child.lock().await;
    if let Some(mut child) = guard.take() {
        if let Err(e) = child.kill().await {
            log::warn!("Failed to kill opencode serve process: {}", e);
        } else {
            log::info!("opencode serve process killed on app exit");
        }
    }
}
