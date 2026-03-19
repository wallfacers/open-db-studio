# 任务取消（Backend Cancellation）设计文档

**日期**：2026-03-19
**状态**：待实现
**作者**：Claude Code + wushengzhou

---

## 背景

当前 `cancel_task` Tauri 命令仅将 SQLite 中的任务状态更新为 `cancelled`，但后台的 tokio 异步任务（export、ai_generate_metrics 等）仍继续运行，直到自然结束。用户点击取消后任务不会真正停止，造成资源浪费和用户体验问题。

---

## 需求

1. 用户取消任务时，后端异步任务必须在下一个自然检查点真正停止
2. 取消后清理所有中间产物（临时文件、部分写入数据），保证最终一致性
3. 方案必须通用，适用于所有现有及未来任务类型
4. 取消响应：尽力而为，在下一个自然检查点停止（秒级延迟可接受）

---

## 设计方案：CancellationToken Registry

### 核心组件

在 `AppState` 中新增 `CancellationRegistry`：

```rust
use tokio_util::sync::CancellationToken;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct CancellationRegistry {
    tokens: Mutex<HashMap<String, CancellationToken>>,
}

impl CancellationRegistry {
    pub fn new() -> Self {
        Self { tokens: Mutex::new(HashMap::new()) }
    }

    /// 为新任务注册并返回 token
    pub fn register(&self, task_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.tokens.lock().unwrap().insert(task_id.to_string(), token.clone());
        token
    }

    /// 触发取消信号，返回 false 表示任务不存在（已完成或未注册）
    pub fn cancel(&self, task_id: &str) -> bool {
        if let Some(token) = self.tokens.lock().unwrap().get(task_id) {
            token.cancel();
            true
        } else {
            false
        }
    }

    /// 任务结束后移除（正常完成或取消完成均调用）
    pub fn remove(&self, task_id: &str) {
        self.tokens.lock().unwrap().remove(task_id);
    }
}
```

`AppState` 增加字段：

```rust
pub struct AppState {
    // ... 现有字段 ...
    pub cancellation_registry: CancellationRegistry,
}
```

---

### 任务生命周期

```
启动任务命令（如 export_tables）
  │
  ├─ 创建 task_record（DB）
  ├─ token = registry.register(task_id)
  └─ tokio::spawn(run_task(token, app_handle, params))
       │
       ├─ [循环每次迭代开头] if token.is_cancelled() → cleanup → return Cancelled
       ├─ [正常处理] emit task-progress(running, ...)
       └─ [完成] emit task-progress(completed, ...)
            │
            └─ registry.remove(task_id)

用户点击取消
  │
  ├─ invoke('cancel_task', { taskId })
  ├─ registry.cancel(task_id)  // 触发信号，立即返回
  └─ [异步] 任务感知 → cleanup() → 更新 DB status=cancelled → emit task-progress(cancelled) → registry.remove()
```

### 取消命令改动

当前 `cancel_task` 只写 DB，改为：

```rust
#[tauri::command]
pub async fn cancel_task(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // 触发取消信号（任务自行负责清理和更新 DB）
    state.cancellation_registry.cancel(&task_id);
    // 不在这里更新 DB，由任务完成 cleanup 后自行更新
    Ok(())
}
```

---

### 任务实现约定

所有任务遵循统一模式：

```rust
async fn run_export_task(
    token: CancellationToken,
    task_id: String,
    app_handle: AppHandle,
    params: ExportParams,
) {
    let mut completed_files: Vec<PathBuf> = vec![];

    for (i, table) in params.tables.iter().enumerate() {
        // 检查点：每处理一张表前检查
        if token.is_cancelled() {
            cleanup_export(&completed_files).await;
            update_task_cancelled(&task_id, &app_handle).await;
            app_handle.emit("task-progress", TaskProgressPayload {
                task_id: task_id.clone(),
                status: "cancelled".to_string(),
                ..Default::default()
            }).ok();
            app_handle.state::<AppState>().cancellation_registry.remove(&task_id);
            return;
        }

        // 正常处理...
        let file = export_table(table, &params).await;
        completed_files.push(file);

        app_handle.emit("task-progress", TaskProgressPayload {
            task_id: task_id.clone(),
            status: "running".to_string(),
            progress: ((i + 1) as f64 / params.tables.len() as f64 * 100.0) as u8,
            ..Default::default()
        }).ok();
    }

    // 正常完成
    update_task_completed(&task_id, &app_handle).await;
    app_handle.state::<AppState>().cancellation_registry.remove(&task_id);
}

async fn cleanup_export(files: &[PathBuf]) {
    for file in files {
        if let Err(e) = tokio::fs::remove_file(file).await {
            tracing::warn!("cleanup failed for {:?}: {}", file, e);
        }
    }
}
```

对于 AI 类任务，在每次 HTTP 请求前检查（也可用 `select!` 实现更快响应）：

```rust
// 方式1：检查点
if token.is_cancelled() { ... return; }
let response = ai_client.request(...).await;

// 方式2：select!（更快响应，不等待当前请求完成）
tokio::select! {
    _ = token.cancelled() => { cleanup(); return; }
    response = ai_client.request(...) => { handle(response); }
}
```

---

### 应用启动时清理孤儿任务

Rust 应用启动时，将所有 `status=running` 的记录重置为 `failed`：

```sql
UPDATE task_records
SET status = 'failed',
    error = '应用重启，任务中断',
    completed_at = datetime('now'),
    updated_at = datetime('now')
WHERE status = 'running';
```

在 `db/migrations.rs` 的启动逻辑中执行（非 schema migration，而是运行时初始化）。

---

### 前端改动

**`src/store/taskStore.ts`** 改动极小：

- `cancelTask()` 调用 `invoke('cancel_task', ...)` 不变
- 移除乐观更新（不立即设置本地状态为 cancelled）
- UI 状态由后端发回的 `task-progress(cancelled)` 事件驱动更新
- 这与现有事件机制完全一致，无需特殊处理

---

## 边界情况

| 场景 | 处理方式 |
|------|----------|
| 取消已完成任务 | `registry.cancel()` 返回 false，命令直接返回，无操作 |
| 完成与取消信号竞争 | 任务先完成则 `registry.remove()` 已执行，cancel 调用无效；前端以先到事件为准 |
| cleanup IO 失败 | 记录 `warn` 日志，任务仍标记为 cancelled（尽力而为） |
| 应用重启孤儿任务 | 启动时 SQL 将 running 重置为 failed |
| 嵌套 AI HTTP 请求 | 使用 `tokio::select!` 在等待响应期间监听取消 |

---

## 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src-tauri/src/state.rs` | 新增或修改 | 新增 `CancellationRegistry`，并入 `AppState` |
| `src-tauri/Cargo.toml` | 确认依赖 | 确认 `tokio-util` 含 `CancellationToken` |
| `src-tauri/src/commands.rs` | 修改 | `cancel_task` 触发信号；各任务命令注册 token、加检查点 |
| `src-tauri/src/metrics/ai_draft.rs` | 修改 | 接收 token 参数，加取消检查点 |
| `src-tauri/src/db/mod.rs` | 修改 | 新增启动时孤儿任务清理逻辑 |
| `src/store/taskStore.ts` | 小改 | 移除乐观更新，依赖事件驱动 |

---

## 不在本次范围内

- 任务暂停/恢复（pause/resume）
- 取消后自动重试
- 部分结果保留（本次统一丢弃）
