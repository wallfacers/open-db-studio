<!-- STATUS: ✅ 已实现 -->
# 统一任务事件协议设计

**日期**：2026-03-19
**状态**：待实现
**关联模块**：bgTaskStore、taskStore、TaskBar、TaskCenter、MetricListPanel

---

## 背景

项目当前存在两套独立的任务管理系统：

| 系统 | Store | 存储 | 事件 | UI |
|------|-------|------|------|----|
| 后台任务 | `bgTaskStore` | 内存 | `bg_task_log` / `bg_task_done` | 底部 TaskBar + 弹出面板 |
| 我的任务 | `taskStore` | SQLite | `task-progress` | 侧边栏 TaskCenter |

两套系统维护成本高，用户体验割裂。目标是完全合并为单一任务系统，统一事件协议。

---

## 目标

1. 废弃 `bgTaskStore`，所有任务类型统一走 `taskStore`
2. 废弃 `bg_task_log` / `bg_task_done` 事件，统一用 `task-progress`
3. 删除底部 `TaskBar` 组件
4. `TaskCenter` 扩展支持 `ai_generate_metrics` 类型，包含实时日志展示
5. 保留 `MetricListPanel` 的 scope 自动刷新能力

---

## 数据结构变更

### Rust 侧：统一 `TaskProgressEvent`

废弃 `bg_task_log` 和 `bg_task_done`，扩展现有 `task-progress` 事件结构：

```rust
#[derive(Serialize, Clone)]
pub struct TaskProgressEvent {
    // 现有字段（不变）
    pub task_id: String,
    pub status: String,           // pending/running/completed/failed/cancelled
    pub progress: f32,
    pub processed_rows: i64,
    pub total_rows: Option<i64>,
    pub current_target: String,
    pub error: Option<String>,
    pub output_path: Option<String>,

    // 新增：日志行（Some 时表示本条事件为日志事件，前端只追加日志，不更新进度字段）
    pub log_line: Option<TaskLogLine>,

    // 新增：scope（ai_generate_metrics 任务专用，其他类型为 None）
    pub connection_id: Option<i64>,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub metric_count: Option<i64>,
    pub skipped_count: Option<i64>,
}

#[derive(Serialize, Clone)]
pub struct TaskLogLine {
    pub level: String,            // info/warn/error
    pub message: String,
    pub timestamp_ms: i64,
}
```

**事件发送规则**：

| 场景 | `log_line` | `status` | 其他字段 |
|------|-----------|---------|---------|
| 日志行 | `Some(...)` | `running` | 全部为默认值（0 / None / ""），前端忽略 |
| 进度更新 | `None` | `running` | 正常填写 progress / processed_rows 等 |
| 任务完成 | `None` | `completed` / `failed` | 填 metric_count / skipped_count 等 |

**前端分支判断规则**：`_handleProgressEvent` 以 `log_line` 是否为 `Some` 作为唯一判断依据：
- `log_line` 有值 → 只追加日志，不更新其他字段
- `log_line` 无值 → 正常更新进度 / 状态字段，不处理日志

### 前端侧：扩展 Task 类型

```typescript
// TaskType 新增
export type TaskType = 'export' | 'import' | 'migration' | 'seatunnel' | 'ai_generate_metrics';

// Task 新增字段
export interface Task {
  // ...现有字段不变...
  logs?: TaskLog[];          // 内存日志，不写 SQLite，重启清空
  connectionId?: number;    // scope（ai_generate_metrics 专用）
  database?: string;
  schema?: string;
  metricCount?: number;
  skippedCount?: number;
}

export interface TaskLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

// TaskProgressEvent 新增字段
export interface TaskProgressEvent {
  // ...现有字段不变...
  log_line?: { level: string; message: string; timestamp_ms: number };
  connection_id?: number;
  database?: string | null;
  schema?: string | null;
  metric_count?: number;
  skipped_count?: number;
}
```

---

## SQLite 迁移（DB Migration）

`task_records` 表需新增三列存储 scope 信息。在 `src-tauri/src/db/migrations.rs` 中追加迁移语句：

```sql
-- Migration: add scope columns to task_records
ALTER TABLE task_records ADD COLUMN connection_id INTEGER;
ALTER TABLE task_records ADD COLUMN scope_database TEXT;
ALTER TABLE task_records ADD COLUMN scope_schema TEXT;
```

`CreateTaskInput` 结构体对应新增字段：

```rust
pub struct CreateTaskInput {
    // ...现有字段不变...
    pub connection_id: Option<i64>,
    pub scope_database: Option<String>,
    pub scope_schema: Option<String>,
}
```

`ai_generate_metrics` 之外的任务类型不填这三列（为 NULL）。

---

## taskStore 变更

### 新增 `appendLog` action

```typescript
interface TaskState {
  // 新增
  appendLog(id: string, log: TaskLog): void;
}

// 实现：只更新目标任务的 logs，不触发其他字段变化
appendLog: (id, log) =>
  set((state) => ({
    tasks: state.tasks.map((t) =>
      t.id === id ? { ...t, logs: [...(t.logs ?? []), log] } : t
    ),
  })),
```

### `_handleProgressEvent` 扩展

```typescript
_handleProgressEvent(event: TaskProgressEvent): void {
  // 日志事件：只追加日志，不更新进度字段
  if (event.log_line) {
    get().appendLog(event.task_id, {
      timestamp: event.log_line.timestamp_ms,
      level: event.log_line.level as TaskLog['level'],
      message: event.log_line.message,
    });
    return;  // 提前返回，不执行后续进度更新
  }

  // 进度 / 状态更新事件（原有逻辑）
  const updates: Partial<Task> = {
    status: parseStatus(event.status),
    progress: event.progress,
    processedRows: event.processed_rows,
    totalRows: event.total_rows,
    currentTarget: event.current_target,
    error: event.error,
    outputPath: event.output_path,
  };

  // 完成时附加 scope 结果字段
  if (event.status === 'completed' || event.status === 'failed') {
    updates.endTime = new Date().toISOString();
    if (event.metric_count != null) updates.metricCount = event.metric_count;
    if (event.skipped_count != null) updates.skippedCount = event.skipped_count;
  }

  get().updateTask(event.task_id, updates);
}
```

### `loadTasks` merge 策略（防止覆盖内存日志）

`loadTasks` 从 SQLite 拉取任务列表后，对 `running` 状态的任务保留内存中已有的 `logs`：

```typescript
loadTasks: async () => {
  const rows = await invoke<Task[]>('get_task_list', { limit: 100 });
  set((state) => ({
    tasks: rows.map((row) => {
      const existing = state.tasks.find((t) => t.id === row.id);
      // 保留内存日志（running 任务的 logs 字段来自 task-progress 事件，SQLite 不存）
      return existing?.logs ? { ...row, logs: existing.logs } : row;
    }),
    isLoading: false,
  }));
},
```

### `addTask` 支持 scope 字段

```typescript
await taskStore.addTask({
  type: 'ai_generate_metrics',
  title: `AI 生成指标 · ${dbName}`,
  connectionId: scope.connectionId,
  database: scope.database,
  schema: scope.schema,
  status: 'running',
  progress: 0,
  processedRows: 0,
  totalRows: null,
  currentTarget: '',
  error: null,
  errorDetails: [],
  outputPath: null,
  description: null,
});
```

---

## Rust 侧：`ai_generate_metrics` 命令改造

当前 `commands.rs::ai_generate_metrics` 只生成 UUID 并 `tokio::spawn`，不写 SQLite。改造步骤：

1. 调用 `create_task` 写入 SQLite，传入 `connection_id` / `scope_database` / `scope_schema`
2. 生成 `task_id` 后立即返回给前端（前端调用 `taskStore.addTask`）
3. `tokio::spawn` 的闭包中，将每条日志改为发送 `task-progress` 事件（携带 `log_line`，`status=running`，进度字段为默认值）
4. 完成时发送最终 `task-progress`（`status=completed/failed`，`metric_count` / `skipped_count`）
5. 删除 `emit(bg_task_log)` 和 `emit(bg_task_done)` 的调用

`generate_metric_drafts` 函数签名不需要变更，日志回调改为发 Tauri 事件即可。

**同步修改 `db/mod.rs`**：
- `create_task()` 的 INSERT 语句新增 `connection_id`、`scope_database`、`scope_schema` 三列
- `list_tasks()` 的 SELECT 语句同步新增这三列，并映射到 `TaskRecord` 结构体

---

## 删除内容

### 删除文件
- `src/store/bgTaskStore.ts`
- `src/components/TaskBar/index.tsx`
- `src/components/TaskBar/TaskLogPanel.tsx`

### 修改 `App.tsx`

```typescript
// 删除以下两行
import { initBgTaskListeners } from './store/bgTaskStore';
initBgTaskListeners();

// 保留（不变）
initTaskProgressListener();
```

### 修改 `ActivityBar`（`src/components/ActivityBar/index.tsx`）

删除 `TaskBar` 组件的 import 和渲染，移除底部状态栏区域。

### 修改 `src/store/index.ts`

删除 `useBgTaskStore` 和 `initBgTaskListeners` 的 re-export。

---

## MetricListPanel 迁移

从订阅 `useBgTaskStore` 改为订阅 `useTaskStore`。

**注意**：`bgTaskStore` 的完成状态为 `'success'`/`'error'`，`taskStore` 对应为 `'completed'`/`'failed'`，迁移时需同步更新判断条件：

```typescript
useEffect(() => {
  const respondedIds = new Set<string>();
  return useTaskStore.subscribe((state) => {
    const relevant = state.tasks.find(t =>
      t.type === 'ai_generate_metrics' &&
      (t.status === 'completed' || t.status === 'failed') &&  // 注意：不是 'success'/'error'
      !respondedIds.has(t.id) &&
      t.connectionId === scope.connectionId &&
      (t.database ?? undefined) === (scope.database ?? undefined) &&
      (t.schema ?? undefined) === (scope.schema ?? undefined)
    );
    if (relevant) {
      respondedIds.add(relevant.id);
      load();
      if (parentNodeId)
        useMetricsTreeStore.getState().refreshNode(parentNodeId);
    }
  });
}, [scope.connectionId, scope.database, scope.schema]);
```

---

## UI 变更：TaskCenter 扩展

### TaskItem：操作按钮限制

`ai_generate_metrics` 类型任务不支持取消/重试（Rust 侧无 cancellation token）。`TaskItem` 中对该类型隐藏"取消"和"重试"按钮：

```typescript
const canCancel = task.status === 'running' && task.type !== 'ai_generate_metrics';
const canRetry = task.status === 'failed' && task.type !== 'ai_generate_metrics';
```

### TaskItem：日志区域

`ai_generate_metrics` 任务展开后新增日志区域：

```
┌─────────────────────────────────────┐
│ ● AI 生成指标 · orders_db    2m 30s │
│ ████████████████░░░░  80%           │
│ ▼ 详情                              │
│   类型: ai_generate_metrics         │
│   新增指标: 42  跳过: 3             │
│                                     │
│   日志                              │
│   [10:23:01] INFO 分析表 orders...  │
│   [10:23:05] INFO 分析表 users...   │
│   [10:23:08] WARN 跳过视图 v_tmp    │
└─────────────────────────────────────┘
```

日志展示逻辑复用现有 `TaskLogPanel` 的样式，移植到 `TaskItem` 内部，仅在 `task.logs` 有值时渲染。

---

## 影响范围

| 文件 | 变更类型 |
|------|---------|
| `src-tauri/src/db/migrations.rs` | 新增：task_records 表 scope 列 migration |
| `src-tauri/src/db/task.rs`（或 tasks.rs） | 修改：CreateTaskInput 新增 scope 字段 |
| `src-tauri/src/db/mod.rs` | 修改：create_task INSERT + list_tasks SELECT 新增 scope 列 |
| `src-tauri/src/llm/` (ai_generate_metrics 相关) | 修改：统一用 task-progress 事件，写 SQLite |
| `src-tauri/src/commands.rs` | 修改：ai_generate_metrics 命令调用 create_task |
| `src/store/taskStore.ts` | 扩展：新增字段、appendLog、loadTasks merge 策略 |
| `src/store/bgTaskStore.ts` | 删除 |
| `src/store/index.ts` | 修改：删除 bgTaskStore re-export |
| `src/components/TaskBar/` | 删除（2 个文件） |
| `src/components/TaskCenter/TaskItem.tsx` | 扩展：日志区域 + 按钮限制 |
| `src/components/MetricsExplorer/MetricListPanel.tsx` | 修改：改订阅 taskStore，状态值更新 |
| `src/components/MetricsExplorer/MetricsSidebar.tsx` | 检查清理 bgTaskStore 引用 |
| `src/components/MetricsExplorer/index.tsx` | 检查清理 bgTaskStore 引用 |
| `src/components/ActivityBar/index.tsx` | 修改：删除 TaskBar |
| `src/App.tsx` | 修改：删除 initBgTaskListeners |
