use crate::AppResult;
use tauri::{Emitter, Manager};

const HEALTH_POLL_INTERVAL_MS: u64 = 500;
const HEALTH_POLL_MAX_ATTEMPTS: u32 = 20; // 10 seconds total

/// Check whether the serve process is already running by hitting the health endpoint.
async fn check_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/global/health", port);
    reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_millis(800))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Poll health endpoint until success or timeout (10 s / 20 attempts).
async fn wait_for_health(port: u16) -> bool {
    for _ in 0..HEALTH_POLL_MAX_ATTEMPTS {
        if check_health(port).await {
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
    tokio::process::Command::new("opencode")
        .args(["serve", "--port", &port.to_string()])
        .current_dir(agent_dir)
        .kill_on_drop(false) // we manage lifecycle explicitly
        .spawn()
}

/// Core logic: attempt to start serve once.
/// Returns Ok(child) on success, Err on failure.
async fn try_start(
    agent_dir: &std::path::Path,
    port: u16,
) -> AppResult<tokio::process::Child> {
    // If already running (dev/debug scenario), reuse without spawning.
    if check_health(port).await {
        log::info!("opencode serve already running on port {}", port);
        // Return a dummy sentinel: we need something in the Mutex.
        // Spawn a no-op child that exits immediately so the crash monitor
        // does not trigger false positives. We use a platform-safe command.
        #[cfg(target_os = "windows")]
        let child = tokio::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()?;
        #[cfg(not(target_os = "windows"))]
        let child = tokio::process::Command::new("true").spawn()?;
        return Ok(child);
    }

    // Ensure the agent directory exists.
    std::fs::create_dir_all(agent_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create agent dir: {}", e)))?;

    let child = spawn_child(agent_dir, port)
        .map_err(|e| crate::AppError::Other(format!("Failed to spawn opencode-cli: {}", e)))?;

    if !wait_for_health(port).await {
        return Err(crate::AppError::Other(
            "opencode serve did not become healthy within 10s. \
             Please check that opencode-cli is installed and accessible in PATH."
                .to_string(),
        ));
    }

    log::info!("opencode serve started successfully on port {}", port);
    Ok(child)
}

/// Background task that monitors the serve child process and restarts it on crash.
async fn crash_monitor(app_handle: tauri::AppHandle, agent_dir: std::path::PathBuf, port: u16) {
    let mut retry_count: u32 = 0;

    loop {
        // Wait until the current child exits.
        {
            let state = app_handle.state::<crate::AppState>();
            let mut guard = state.serve_child.lock().await;
            if let Some(child) = guard.as_mut() {
                match child.wait().await {
                    Ok(status) => {
                        log::warn!("opencode serve exited with status: {}", status);
                    }
                    Err(e) => {
                        log::warn!("opencode serve wait error: {}", e);
                    }
                }
                // Clear the stale child handle.
                *guard = None;
            } else {
                // No child to monitor; sleep and check again.
                drop(guard);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
        }

        // Child exited — decide whether to restart.
        retry_count += 1;
        if retry_count > 3 {
            log::error!("opencode serve failed {} times; giving up", retry_count);
            let _ = app_handle.emit("serve_failed", ());
            break;
        }

        log::info!("Restarting opencode serve (attempt {})...", retry_count);
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        match try_start(&agent_dir, port).await {
            Ok(new_child) => {
                let state = app_handle.state::<crate::AppState>();
                let mut guard = state.serve_child.lock().await;
                *guard = Some(new_child);
                retry_count = 0;
                log::info!("opencode serve restarted successfully");
                let _ = app_handle.emit("serve_restarted", ());
            }
            Err(e) => {
                log::error!("Failed to restart opencode serve: {}", e);
                // Loop will increment retry_count on next iteration.
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
        Ok(child) => {
            {
                let state = app_handle.state::<crate::AppState>();
                let mut guard = state.serve_child.lock().await;
                *guard = Some(child);
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
