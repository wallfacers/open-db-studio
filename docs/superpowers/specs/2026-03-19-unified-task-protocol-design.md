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

    // 新增：日志行（仅当本次事件携带日志时有值）
    pub log_line: Option<TaskLogLine>,

    // 新增：scope（ai_generate_metrics 任务专用）
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
- 每条日志 → 发一次 `task-progress`（填 `log_line`，`status` 保持 `running`）
- 任务完成 → 发一次 `task-progress`（`status=completed/failed`，附带 `metric_count` 等）

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

## taskStore 变更

### 新增 `appendLog` action

```typescript
interface TaskState {
  // 新增
  appendLog(id: string, log: TaskLog): void;
}
```

### `_handleProgressEvent` 扩展

```typescript
_handleProgressEvent(event: TaskProgressEvent): void {
  // 1. 携带日志行时追加（内存）
  if (event.log_line) {
    get().appendLog(event.task_id, {
      timestamp: event.log_line.timestamp_ms,
      level: event.log_line.level as TaskLog['level'],
      message: event.log_line.message,
    });
  }

  // 2. 更新任务状态（现有逻辑）
  const updates: Partial<Task> = {
    status: parseStatus(event.status),
    progress: event.progress,
    processedRows: event.processed_rows,
    totalRows: event.total_rows,
    currentTarget: event.current_target,
    error: event.error,
    outputPath: event.output_path,
  };

  // 3. 完成时附加 scope 结果字段
  if (event.status === 'completed' || event.status === 'failed') {
    updates.endTime = new Date().toISOString();
    if (event.metric_count != null) updates.metricCount = event.metric_count;
    if (event.skipped_count != null) updates.skippedCount = event.skipped_count;
  }

  get().updateTask(event.task_id, updates);
}
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

### 修改 `ActivityBar`

删除 `TaskBar` 组件的渲染，移除底部状态栏区域。

---

## MetricListPanel 迁移

从订阅 `useBgTaskStore` 改为订阅 `useTaskStore`：

```typescript
useEffect(() => {
  const respondedIds = new Set<string>();
  return useTaskStore.subscribe((state) => {
    const relevant = state.tasks.find(t =>
      t.type === 'ai_generate_metrics' &&
      t.status !== 'running' &&
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

### TaskItem 日志区域

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

日志展示逻辑复用现有 `TaskLogPanel` 的样式，移植到 `TaskItem` 内部。

---

## Rust 侧实现要点

1. `ai_generate_metrics` 命令在启动时调用现有 `create_task` 写入 SQLite
2. 执行过程中每条日志通过 `task-progress` 事件发送（携带 `log_line`）
3. 完成时发送最终 `task-progress`（`status=completed/failed` + `metric_count` 等）
4. 删除 `bg_task_log` 和 `bg_task_done` 事件的发送代码

---

## 影响范围

| 文件 | 变更类型 |
|------|---------|
| `src-tauri/src/llm/` (ai_generate_metrics 相关) | 修改：统一用 task-progress 事件 |
| `src-tauri/src/commands.rs` | 修改：ai 任务写 SQLite |
| `src/store/taskStore.ts` | 扩展：新增字段和 appendLog |
| `src/store/bgTaskStore.ts` | 删除 |
| `src/components/TaskBar/` | 删除 |
| `src/components/TaskCenter/TaskItem.tsx` | 扩展：日志区域 |
| `src/components/MetricsExplorer/MetricListPanel.tsx` | 修改：改订阅 taskStore |
| `src/components/MetricsExplorer/MetricsSidebar.tsx` | 检查清理 bgTaskStore 引用 |
| `src/components/MetricsExplorer/index.tsx` | 检查清理 bgTaskStore 引用 |
| `src/components/ActivityBar/index.tsx` | 修改：删除 TaskBar |
| `src/App.tsx` | 修改：删除 initBgTaskListeners |
