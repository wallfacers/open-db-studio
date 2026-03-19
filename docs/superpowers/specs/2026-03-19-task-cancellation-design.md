# 任务取消（Backend Cancellation）设计文档

**日期**：2026-03-19
**状态**：待实现
**作者**：Claude Code + wushengzhou

---

## 背景

当前 `cancel_task` Tauri 命令（`commands.rs:1036`）仅将 SQLite 中的任务状态更新为 `cancelled`，后台的 tokio 异步任务（export、ai_generate_metrics 等）仍继续运行。前端 `cancelTask()`（`taskStore.ts:176`）在 invoke 返回后直接乐观更新 UI 状态为 `cancelled`，并不等待任务真正停止。

---

## 需求

1. 用户取消任务时，后端异步任务在下一个自然检查点真正停止
2. 取消后清理所有中间产物（临时文件、AI 指标部分写入），保证最终一致性
3. 方案必须通用，适用于所有现有及未来任务类型
4. 取消响应：尽力而为，在下一个自然检查点停止（秒级延迟可接受）

---

## 设计方案：CancellationToken Registry

### Cargo.toml 依赖

`CancellationToken` 位于 `tokio-util` 的 `sync` feature，当前配置仅有 `compat`，**必须添加**：

```toml
# 修改前
tokio-util = { version = "0.7", features = ["compat"] }
# 修改后
tokio-util = { version = "0.7", features = ["compat", "sync"] }
```

---

### AppError 扩展

为区分任务取消与真实失败，在 `crate::AppError` 中新增 `Cancelled` 变体。项目使用 `thiserror`（`error.rs` 中 `#[derive(Debug, Error)]`），**必须使用 `#[error(...)]` 属性，不能手写 `impl Display`**：

```rust
// error.rs — 在现有 AppError 枚举中新增
#[error("Task cancelled by user")]
Cancelled,
```

`do_generate`（及其他任务的内部函数）在检测到取消信号时返回 `Err(AppError::Cancelled)`，外层包装函数（如 `generate_metric_drafts`）匹配此变体写入 `cancelled` 状态而非 `failed`。

---

### 核心组件：CancellationRegistry

在 `AppState` 中新增 `CancellationRegistry`。

**使用 `std::sync::Mutex`（非 `tokio::sync::Mutex`）**：临界区只有 HashMap 的 insert/get/remove，是纯同步操作且极短，不需要跨 `.await` 持锁。`unwrap()` 中毒风险极低（持锁期间无可能 panic 的操作），可接受。

```rust
// src-tauri/src/state.rs
use tokio_util::sync::CancellationToken;
use std::collections::HashMap;
use std::sync::Mutex;  // 注意：不是 tokio::sync::Mutex

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

    /// 任务结束后移除（正常完成、取消完成、失败均须调用，防止 token 泄漏）
    pub fn remove(&self, task_id: &str) {
        self.tokens.lock().unwrap().remove(task_id);
    }
}
```

`AppState` 增加字段，同时更新 `lib.rs` 中的初始化字面量：

```rust
pub struct AppState {
    // ... 现有字段 ...
    pub cancellation_registry: CancellationRegistry,
}

// lib.rs 中 AppState 初始化处（app.manage(...) 块内）
AppState {
    // ... 现有字段 ...
    cancellation_registry: CancellationRegistry::new(),
}
```

---

### 任务生命周期

```
启动任务命令（如 export_tables）
  │
  ├─ 创建 task_record（DB）
  ├─ token = state.cancellation_registry.register(&task_id)
  │   注意：state 参数有生命周期限制，不能 move 进 spawn 闭包
  │   → 在 spawn 之前调用 register，token 可以 move 进闭包
  │   → spawn 闭包内通过 app_handle.state::<AppState>() 访问 registry.remove()
  └─ tokio::spawn(async move { run_task(token, app_handle, params).await })
       │
       ├─ [循环每次迭代开头] if token.is_cancelled() → return Err(AppError::Cancelled)
       │
       ├─ [正常处理] emit task-progress(running, ...)
       │
       ├─ [完成 Ok(())] 更新 DB status=completed
       │     → emit task-progress(completed)
       │     → app_handle.state::<AppState>().cancellation_registry.remove(&task_id)
       │
       ├─ [取消 Err(AppError::Cancelled)]
       │     → cleanup()          // 删除文件 or 回滚 DB 写入
       │     → 更新 DB status=cancelled
       │     → emit task-progress(cancelled)
       │     → app_handle.state::<AppState>().cancellation_registry.remove(&task_id)
       │
       └─ [失败 Err(其他)]
             → 更新 DB status=failed
             → emit task-progress(failed)
             → app_handle.state::<AppState>().cancellation_registry.remove(&task_id)
```

**关键**：`tauri::State<'_, AppState>` 有生命周期，**不能 move 进 `tokio::spawn` 闭包**。在 spawn 前用 `state.cancellation_registry.register(...)` 获取 token（可 move），spawn 内部用 `app_handle.state::<AppState>()` 调用 `remove()`。

---

### 取消命令改动

当前 `cancel_task`（`commands.rs:1036`）只写 DB，改为触发信号：

```rust
#[tauri::command]
pub async fn cancel_task(
    task_id: String,
    state: tauri::State<'_, crate::AppState>,  // 新增参数
) -> AppResult<()> {
    // 仅触发取消信号；任务自行负责清理和 DB 更新
    // 若任务已完成（token 不存在），cancel() 返回 false，静默忽略
    state.cancellation_registry.cancel(&task_id);
    Ok(())
}
```

---

### Export 任务改动

`export_tables` 命令签名增加 `state` 参数：

```rust
pub async fn export_tables(
    params: MultiExportParams,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,  // 新增
) -> AppResult<String>
```

在 `tokio::spawn` 之前注册 token，spawn 内部使用 `app_handle.state::<AppState>()` 访问 registry：

```rust
// spawn 之前（state 参数可用）
let token = state.cancellation_registry.register(&task_id);
let task_id_clone = task_id.clone();
let app_clone = app_handle.clone();

tokio::spawn(async move {
    let mut completed_files: Vec<String> = vec![];

    for (i, table) in tables_to_export.iter().enumerate() {
        // 检查点
        if token.is_cancelled() {
            // cleanup：删除已写出的文件
            for file in &completed_files {
                if let Err(e) = std::fs::remove_file(file) {
                    tracing::warn!("cleanup failed for {}: {}", file, e);
                }
            }
            // 注意：ZIP 模式下需同时删除部分 ZIP 文件
            let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                status: Some("cancelled".to_string()),
                completed_at: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            });
            let _ = app_clone.emit("task-progress", cancelled_payload(&task_id_clone));
            // 使用 app_handle 访问 registry（非 state 参数，因其生命周期不可 move）
            app_clone.state::<crate::AppState>().cancellation_registry.remove(&task_id_clone);
            return;
        }

        // 正常导出逻辑...
        let file_path = do_export_table(table, &params).await;
        completed_files.push(file_path);
        let _ = app_clone.emit("task-progress", running_payload(&task_id_clone, i, total));
    }

    // 正常完成
    let _ = crate::db::update_task(&task_id_clone, &completed_update());
    let _ = app_clone.emit("task-progress", completed_payload(&task_id_clone, &params.output_dir));
    app_clone.state::<crate::AppState>().cancellation_registry.remove(&task_id_clone);
    // failed 路径同样必须调用 registry.remove()，防止 token 泄漏
});
```

**关于 ZIP 分支**：export 支持 ZIP 输出时，取消 cleanup 除删除各表的临时文件外，还需删除部分写入的 ZIP 文件（ZIP 文件在循环前打开，取消时需关闭并删除）。

---

### AI 指标任务改动

#### generate_metric_drafts 外层包装

修改 `ai_draft.rs` 中 `generate_metric_drafts` 对错误的处理，区分 `Cancelled` 与真实失败：

```rust
pub async fn generate_metric_drafts(
    app_handle: tauri::AppHandle,
    task_id: String,
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    table_names: Vec<String>,
    token: CancellationToken,  // 新增参数
) {
    let now = chrono::Utc::now().to_rfc3339();
    match do_generate(&app_handle, &task_id, connection_id, database.clone(), schema.clone(), table_names, token).await {
        Ok(()) => {
            let _ = crate::db::update_task(&task_id, &UpdateTaskInput {
                status: Some("completed".to_string()),
                progress: Some(100),
                completed_at: Some(now),
                ..Default::default()
            });
        }
        Err(crate::AppError::Cancelled) => {
            // 取消：cleanup 已在 do_generate 内部执行
            let _ = crate::db::update_task(&task_id, &UpdateTaskInput {
                status: Some("cancelled".to_string()),
                completed_at: Some(now),
                ..Default::default()
            });
            use tauri::Emitter;
            let _ = app_handle.emit("task-progress", cancelled_event(&task_id, connection_id, &database, &schema));
            // registry.remove() 必须在此处调用（spawn 是 fire-and-forget，commands.rs 没有 post-spawn 回调）
            app_handle.state::<crate::AppState>().cancellation_registry.remove(&task_id);
        }
        Err(e) => {
            // 真实失败（原有逻辑不变）
            emit_log(&app_handle, &task_id, "error", &e.to_string());
            let _ = crate::db::update_task(&task_id, &UpdateTaskInput {
                status: Some("failed".to_string()),
                error: Some(e.to_string()),
                completed_at: Some(now),
                ..Default::default()
            });
            // ... emit failed event ...
            app_handle.state::<crate::AppState>().cancellation_registry.remove(&task_id);
        }
    }
    // Ok 路径同样需要 remove（在 update_task completed 之后）
    app_handle.state::<crate::AppState>().cancellation_registry.remove(&task_id);
    // 注意：上面三个 arm 各自 return 后，此行只在 Ok 路径执行
    // 更清晰的写法是在每个 arm 内都显式调用 remove()，如 Cancelled 和 Err 分支所示
}
```

#### do_generate 内部取消检查

取消处理分两个阶段，关注点分离：

**阶段 1：HTTP 请求期间**（耗时 10–30 秒，当前无 DB 写入）

使用 `select!` 提升响应性，此时无需 cleanup：

```rust
let response = tokio::select! {
    _ = token.cancelled() => {
        return Err(crate::AppError::Cancelled);
        // 外层 generate_metric_drafts 统一处理 DB 状态更新
        // reqwest Future 被 drop，TCP 连接安全中止，无中间 DB 写入
    }
    resp = ai_client.chat(messages) => resp?,
};
```

**阶段 2：逐条写入 SQLite 期间**（response 返回后，每条指标 save 前）

此阶段有 DB 写入，取消时需回滚：

```rust
for metric in parsed_metrics {
    if token.is_cancelled() {
        // cleanup：删除本任务已写入的所有指标
        cleanup_ai_metrics(&task_id);
        return Err(crate::AppError::Cancelled);
    }
    save_metric(&CreateMetricInput { task_id: Some(task_id.to_string()), /* 其他字段 */ })?;
}
```

```rust
fn cleanup_ai_metrics(task_id: &str) {
    // 使用项目现有的同步 rusqlite 访问模式
    // 安全说明：此函数只在取消检查点处调用，此时 do_generate 内部的其他
    // DB 锁（dedup 查询、save_metric）均已释放（它们是作用域内的局部锁）。
    // 若未来将此检查点移入持锁区域内，需重新评估死锁风险。
    let conn = crate::db::get().lock().unwrap();
    if let Err(e) = conn.execute("DELETE FROM metrics WHERE task_id = ?1", [task_id]) {
        tracing::warn!("cleanup_ai_metrics failed for task {}: {}", task_id, e);
    }
}
```

---

### metrics 表和 CRUD 改动

**1. `schema/init.sql`**：`metrics` 表新增 `task_id` 字段：

```sql
CREATE TABLE IF NOT EXISTS metrics (
    -- ... 现有字段 ...
    task_id TEXT,  -- 新增：关联 task_records.id，用于取消时按任务回滚
    -- ...
);
```

**2. `migrations.rs`**：在现有 `migration_stmts` 数组末尾新增（使用与现有条目相同的 `let _ = conn.execute(stmt, [])` 模式，静默忽略重复列错误，不使用 `execute_batch` 带错误检查的 `alter_stmts` 模式）：

```rust
let migration_stmts = [
    // ... 现有语句 ...
    "ALTER TABLE metrics ADD COLUMN task_id TEXT",  // 新增
];
for stmt in &migration_stmts {
    let _ = conn.execute(stmt, []);  // 静默忽略 "duplicate column" 错误
}
```

**3. `src-tauri/src/metrics/crud.rs`**：`CreateMetricInput` 新增 `task_id` 字段，`save_metric` 的 INSERT SQL 新增此列：

```rust
pub struct CreateMetricInput {
    // ... 现有字段 ...
    pub task_id: Option<String>,  // 新增
}

// save_metric INSERT SQL 新增 task_id 列和对应参数
"INSERT INTO metrics (connection_id, ..., scope_schema, task_id)
 VALUES (?1, ..., ?17, ?18)"
// params 末尾加 input.task_id
```

---

### 应用启动时清理孤儿任务

**位置**：`src-tauri/src/lib.rs` 的 `setup` 闭包中，在 `crate::db::init(...)` 调用之后（`init()` 内部已完成 migrations，返回后 `crate::db::get()` 可用）。

**不放在 `migrations.rs`**：migrations 是幂等 DDL；孤儿清理是有状态 DML，放入 migrations 会在多次调用时错误重置任务。

```rust
// lib.rs setup 闭包
crate::db::init(&app_data_dir.to_string_lossy())?;  // 现有调用

// 启动时将上次未完成的任务标记为失败（同步调用，rusqlite，无 .await）
{
    let conn = crate::db::get().lock().unwrap();
    let _ = conn.execute(
        "UPDATE task_records SET status='failed', error='应用重启，任务中断', \
         completed_at=datetime('now'), updated_at=datetime('now') WHERE status='running'",
        [],
    );
}
```

---

### 前端改动

#### `taskStore.ts`：cancelTask 完整替换

**现有实现**（`taskStore.ts:176-188`）在 invoke 返回后立即 set 状态为 `'cancelled'`，**完整替换为**：

```typescript
cancelTask: async (id) => {
  // 1. 立即设置本地 UI 状态为 'cancelling'（前端 sentinel，后端不会发出此状态）
  set((s) => ({
    tasks: s.tasks.map((t) =>
      t.id === id ? { ...t, status: 'cancelling' as TaskStatus } : t
    ),
  }));

  try {
    // 2. 通知后端触发取消信号（命令立即返回，不等任务真正停止）
    await invoke('cancel_task', { taskId: id });
    // 3. 真实的 'cancelled' 状态由后端 task-progress 事件驱动覆盖
    //    _handleProgressEvent 收到 status=cancelled 时覆盖 'cancelling'
  } catch (e) {
    console.error('Failed to cancel task:', e);
    // invoke 失败时恢复为 running，允许用户重试
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id && t.status === 'cancelling'
          ? { ...t, status: 'running' as TaskStatus }
          : t
      ),
    }));
    throw e;
  }
},
```

#### TaskStatus 类型扩展

```typescript
export type TaskStatus = 'pending' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
// 注意：'cancelling' 是前端 sentinel，后端 task-progress 事件不会发出此值
// TaskProgressEvent.status 使用的是后端枚举（不含 'cancelling'）
```

#### `TaskItem.tsx`：cancelling 状态显示

在现有状态渲染逻辑中增加 `cancelling` 分支：
- 显示灰色 spinner（类似 running 但颜色更暗）
- 状态文字："正在取消…"
- 隐藏取消按钮（防止重复点击）

---

## 边界情况

| 场景 | 处理方式 |
|------|----------|
| 取消已完成任务 | `registry.cancel()` 返回 false，命令静默返回，不操作 DB |
| 完成与取消信号竞争 | 任务先完成则 token 已移除，cancel 无效；前端以先到事件为准 |
| cleanup IO 失败 | 记录 `warn` 日志，任务仍标记为 cancelled（尽力而为） |
| 应用重启孤儿任务 | `lib.rs` setup 将 running 重置为 failed（同步 SQL） |
| AI HTTP 请求中取消 | `select!` 中止 reqwest Future，TCP 连接安全关闭，无中间 DB 写入，无需 cleanup |
| AI 写入循环中取消 | 检查点触发，调用同步 `cleanup_ai_metrics()` 按 task_id DELETE 回滚 |
| failed 路径 registry 泄漏 | failed 分支必须调用 `registry.remove()`（见生命周期图） |
| cancel_task invoke 失败 | 前端 catch 中恢复 status 为 'running'，用户可重试 |
| ZIP 分支取消 | cleanup 需额外删除部分写入的 ZIP 文件 |
| 重试取消任务 | retry 不重新启动执行，registry 无 token，为已知 MVP 限制 |

---

## 改动文件清单

| 文件 | 改动类型 | 关键变更 |
|------|----------|----------|
| `src-tauri/Cargo.toml` | 修改 | `tokio-util` 增加 `sync` feature |
| `src-tauri/src/lib.rs` 或 `error.rs` | 修改 | `AppError` 新增 `Cancelled` 变体 |
| `src-tauri/src/state.rs` | 修改 | 新增 `CancellationRegistry` 结构体 |
| `src-tauri/src/lib.rs` | 修改 | `AppState` 初始化增加 `cancellation_registry: CancellationRegistry::new()`；`crate::db::init()` 后新增孤儿任务清理同步 SQL |
| `src-tauri/src/commands.rs` | 修改 | `cancel_task` 增加 `state` 参数，改为触发信号；`export_tables` 增加 `state` 参数，spawn 前注册 token，循环内加检查点，所有退出路径调用 `app_handle.state::<AppState>().cancellation_registry.remove()` |
| `src-tauri/src/metrics/ai_draft.rs` | 修改 | `generate_metric_drafts` 增加 `token` 参数，match Cancelled 变体写 cancelled 状态；`do_generate` 增加 `token` 参数，HTTP 用 `select!`，写入循环加检查点，新增同步 `cleanup_ai_metrics()` |
| `src-tauri/src/metrics/crud.rs` | 修改 | `CreateMetricInput` 增加 `task_id: Option<String>`；`save_metric` INSERT SQL 增加 `task_id` 列 |
| `src-tauri/src/db/migrations.rs` | 修改 | `migration_stmts` 末尾增加 `"ALTER TABLE metrics ADD COLUMN task_id TEXT"`（使用现有 `let _ = conn.execute(stmt, [])` 模式） |
| `schema/init.sql` | 修改 | `metrics` 表增加 `task_id TEXT` 字段 |
| `src/store/taskStore.ts` | 修改 | `TaskStatus` 增加 `'cancelling'`；`cancelTask` 完整替换（前置 cancelling sentinel，移除 invoke 后的乐观 set，错误时恢复 running） |
| `src/components/TaskCenter/TaskItem.tsx` | 修改 | 新增 `cancelling` 状态显示 |

---

## 不在本次范围内

- 任务暂停/恢复（pause/resume）
- 取消后自动重试
- retry 的后端重新执行（当前 MVP 存根）
