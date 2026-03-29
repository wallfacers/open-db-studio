<!-- STATUS: ❌ 未实现 -->
# 指标 AI 生成功能重构设计规格

**日期：** 2026-03-19
**状态：** 已批准
**范围：** MetricListPanel AI 生成按钮 + 全局后台任务队列

---

## 背景与问题

当前 AI 生成指标功能存在三个问题：

1. **黑盒体验**：点击"AI 生成"后按钮变成"生成中..."，10-30 秒内无任何过程反馈
2. **全量扫描浪费**：扫描整个连接的所有表，包含日志表、系统表，token 消耗大、速度慢
3. **重复生成**：重复点击或多次执行会创建相同的指标草稿，无去重机制

---

## 目标

- 提供实时流式日志，让用户清楚看到 AI 生成的每个阶段
- 支持选择性扫描表，减少无效 token 消耗
- 自动跳过重复指标，生成结果明确告知新增数量与跳过数量
- AI 生成任务非阻塞，用户触发后可继续操作其他功能

---

## 架构方案：Tauri Event 推送

使用 Tauri 的 `app_handle.emit()` 机制实现后端→前端实时推送，不引入新的通信协议。

### 数据流

```
用户点击"AI 生成"（选表后确认）
      │
      ▼
invoke('ai_generate_metrics', { connectionId, database, schema, tableNames })
      │ 立即返回 task_id（不阻塞）
      ▼
taskStore.addTask(task_id, title)
      │
      ▼（Rust 后台 tokio::spawn 异步执行）
app_handle.emit("bg_task_log", { task_id, level, message, timestamp_ms })
      │ 重复多次
      ▼
前端 listen("bg_task_log") → taskStore.appendLog()
      │
      ▼
app_handle.emit("bg_task_done", { task_id, success, connection_id, database, schema, metric_count, skipped_count })
      │
      ▼
taskStore.completeTask()
MetricListPanel 订阅 taskStore，当 scope 匹配的任务完成时调用 load() 刷新
MetricsTree sidebar 同步刷新 metricCounts
```

> 事件名使用 `bg_task_log` / `bg_task_done` 前缀，避免与现有 `task-progress` 事件冲突。

---

## 前端改动

### 新增文件

#### `src/store/bgTaskStore.ts`（注意：非 taskStore，避免命名冲突）

采用与现有 `initTaskProgressListener` 相同的模式：store 不在模块级直接调用 `listen()`，而是 export 一个 `initBgTaskListeners()` 函数，由 `App.tsx` 的 `useEffect` 调用，保证 Tauri IPC 就绪后再注册。

```typescript
interface TaskLog {
  timestamp: number;    // unix ms
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface BackgroundTask {
  id: string;
  type: 'ai_generate_metrics';
  title: string;          // e.g. "AI 生成指标 · orders_db"
  status: 'running' | 'success' | 'error';
  logs: TaskLog[];
  startedAt: number;
  finishedAt?: number;
  connectionId?: number;  // 供 MetricListPanel 精确匹配
  database?: string;
  schema?: string;
  metricCount?: number;   // 新增数量
  skippedCount?: number;  // 跳过数量
}

interface BgTaskStore {
  tasks: BackgroundTask[];
  addTask: (id: string, type: BackgroundTask['type'], title: string, scope: { connectionId: number; database?: string; schema?: string }) => void;
  appendLog: (id: string, log: TaskLog) => void;
  completeTask: (id: string, success: boolean, extra?: Partial<BackgroundTask>) => void;
  removeTask: (id: string) => void;
  clearCompleted: () => void;
}
```

`initBgTaskListeners()` 内部用 `initialized` guard 防止重复注册：

```typescript
let initialized = false;
export function initBgTaskListeners() {
  if (initialized) return;
  initialized = true;
  listen('bg_task_log', ({ payload }) => { /* appendLog */ });
  listen('bg_task_done', ({ payload }) => { /* completeTask */ });
}
```

#### `src/components/TaskBar/index.tsx`（底部状态栏）

常驻底部，高度 24px，颜色规范（遵循项目实际使用的蓝黑主题）：
- 容器背景：`bg-[#0d1117]`，上边框：`border-t border-[#1e2d42]`
- 运行中：旋转图标 `text-[#00c9a7]` + 文字"N 个任务运行中"
- 有失败任务：`text-[#f87171]` 警告图标 + "N 个任务失败"
- 全部成功：`text-[#00c9a7]` 勾选图标 + "上次任务成功 HH:mm"
- 无任务：状态栏内容为空（组件仍渲染，高度保留）

点击状态栏任意区域展开 `TaskLogPanel`。

#### `src/components/TaskBar/TaskLogPanel.tsx`（日志面板）

从底部向上展开，固定高度 320px：
- 面板背景：`bg-[#080d12]`，边框：`border border-[#1e2d42]`
- 标题栏：`bg-[#0d1117]`，文字：`text-[#c8daea]`
- 日志区背景：`bg-[#050a0e]`（深黑，类终端）
- `info` 日志：`text-[#7a9bb8]`
- `warn` 日志：`text-[#f59e0b]`
- `error` 日志：`text-[#f87171]`
- 时间戳：`text-[#4a6a8a]`
- 成功标记 ✅：`text-[#00c9a7]`

任务卡片交互：
- 运行中：日志区默认展开，自动滚动到底部，不可关闭
- 已完成：默认折叠，点击展开日志，右上角 `[✕]` 可关闭
- 顶部操作："清除已完成"按钮清除所有非 running 任务

#### `src/components/MetricsExplorer/TablePickerModal.tsx`（选表弹窗）

触发"AI 生成"后先弹出此弹窗，颜色规范：
- 弹窗背景：`bg-[#0d1117]`，边框：`border border-[#2a3f5a]`
- 表名文字：`text-[#c8daea]`，列数文字：`text-[#7a9bb8]`
- checkbox：`accent-[#00c9a7]`
- 确认按钮：`bg-[#00c9a7] text-black`，取消按钮：`bg-[#1a2a3a] text-[#7a9bb8]`

```
┌─────────────────────────────────────────┐
│  选择要分析的表            [✕]          │
├─────────────────────────────────────────┤
│  database > schema                      │
│  [✓] orders        (12列)               │
│  [✓] order_items   (8列)                │
│  [ ] logs          (5列)                │
│  [✓] users         (9列)                │
│  [ ] schema_migrations (3列)            │
├─────────────────────────────────────────┤
│  已选 3 张表    [全选] [取消全选]        │
│                    [取消]  [开始生成]   │
└─────────────────────────────────────────┘
```

表列表通过新增的 `list_tables_with_column_count` 命令获取（见后端改动）。

### 改动文件

#### `src/components/MetricsExplorer/MetricListPanel.tsx`

- 移除 `aiLoading` 状态和旧的阻塞式 `doAiGenerate` 函数
- **删除**旧的 `invoke('ai_generate_metrics', { connectionId })` 调用
- "AI 生成"按钮点击后打开 `TablePickerModal`，选表确认后调用新签名 `invoke('ai_generate_metrics', { connectionId, database, schema, tableNames })`，拿到 task_id 后调用 `bgTaskStore.addTask()`
- 按钮始终可点击，支持并发触发多个任务
- 在 `useEffect` 中订阅 `bgTaskStore`，当有 scope 匹配（connectionId + database + schema）的任务状态变为 `success` 或 `error` 时，调用 `load()` 刷新列表，同时调用 `useMetricsTreeStore.getState().refreshNode(parentNodeId)` 同步左侧树的指标计数

```typescript
// parentNodeId 复用组件顶部已有计算逻辑（MetricListPanel.tsx 第 34-38 行）：
// const parentNodeId = scope.schema
//   ? `schema_${scope.connectionId}_${scope.database}_${scope.schema}`
//   : scope.database ? `db_${scope.connectionId}_${scope.database}` : null;

// 订阅 bgTaskStore，仅响应当前 scope 的任务完成
// 使用 respondedTaskIds ref 避免同一任务完成后重复触发刷新
useEffect(() => {
  const respondedIds = new Set<string>();
  return useBgTaskStore.subscribe((state) => {
    const relevant = state.tasks.find(t =>
      t.status !== 'running' &&
      !respondedIds.has(t.id) &&
      t.connectionId === scope.connectionId &&
      t.database === (scope.database ?? undefined) &&
      t.schema === (scope.schema ?? undefined)
    );
    if (relevant) {
      respondedIds.add(relevant.id);
      load();
      if (parentNodeId) useMetricsTreeStore.getState().refreshNode(parentNodeId);
    }
  });
}, [scope.connectionId, scope.database, scope.schema]);
```

#### `src/App.tsx`

- 加入 `<TaskBar />` 组件（在根布局底部）
- 在 `useEffect` 中调用 `initBgTaskListeners()`，与现有 `initTaskProgressListener()` 同位置调用

---

## 后端改动

### `src-tauri/src/commands.rs`

#### 修改 `ai_generate_metrics`（旧签名完全替换）

```rust
#[tauri::command]
pub async fn ai_generate_metrics(
    app_handle: tauri::AppHandle,
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    table_names: Vec<String>,   // 用户选中的表名列表
) -> AppResult<String> {        // 返回 task_id
    let task_id = uuid::Uuid::new_v4().to_string();
    let task_id_clone = task_id.clone();
    tokio::spawn(async move {
        crate::metrics::ai_draft::generate_metric_drafts(
            app_handle, task_id_clone, connection_id,
            database, schema, table_names
        ).await;
    });
    Ok(task_id)
}
```

#### 新增 `list_tables_with_column_count`

现有 `list_tables_with_stats` 返回 `row_count` / `size`，缺少 `column_count`，不能直接复用。新增独立命令，避免修改现有命令的返回类型：

```rust
#[derive(Serialize)]
pub struct TableWithColumnCount {
    pub name: String,
    pub column_count: usize,
}

#[tauri::command]
pub async fn list_tables_with_column_count(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
) -> AppResult<Vec<TableWithColumnCount>> {
    // 1. 调用 get_schema 获取表名列表（O(1) 次查询）
    // 2. 对每张表调用 get_columns，收集列数
    // 注意：使用 join_all 并发执行，避免 N+1 串行超时
}
```

> `get_columns` 使用 `futures::future::join_all` 并发拉取，避免逐表串行导致超时。

### `src-tauri/src/metrics/ai_draft.rs`

#### 事件类型

```rust
#[derive(Serialize, Clone)]
struct BgTaskLogEvent {
    task_id: String,
    level: String,       // "info" | "warn" | "error"
    message: String,
    timestamp_ms: u64,
}

#[derive(Serialize, Clone)]
struct BgTaskDoneEvent {
    task_id: String,
    success: bool,
    error: Option<String>,
    connection_id: i64,         // 供前端 scope 匹配
    database: Option<String>,
    schema: Option<String>,
    metric_count: Option<usize>,
    skipped_count: Option<usize>,
}
```

#### 执行阶段与日志

| 阶段 | 日志示例 |
|------|---------|
| 读取连接配置 | `INFO 连接数据库 orders_db (MySQL)` |
| 读取选中表的字段 | `INFO 读取字段：orders (12列), users (9列)（并发拉取）` |
| 构建 Prompt | `INFO Prompt 构建完成（共 3 张表，29 个字段）` |
| 调用 LLM | `INFO 调用 AI 模型 gpt-4o，等待响应...` |
| 解析响应 | `INFO 解析到 6 个指标草稿` |
| 写入（新增） | `INFO 保存 1/6：订单总金额 (order_amount)` |
| 写入（重复跳过） | `WARN 跳过 2/6：订单数量 — 已存在相同指标` |
| 完成 | `INFO ✅ 完成，新增 5 个，跳过 1 个重复` |
| 任意阶段失败 | `ERROR 调用 AI 模型超时: connection timeout` |

#### 去重逻辑

在 `save_metric` 前查询数据库，去重条件：
- `connection_id + table_name + column_name + aggregation + scope_database + scope_schema`
- **注意 NULL 处理**：`column_name` 在 COUNT 类指标时为 NULL，SQL 查询必须用 `(column_name = ? OR (column_name IS NULL AND ? IS NULL))` 形式，避免 `NULL = NULL` 恒为 false 导致 COUNT 类指标重复写入
- 去重范围包含 `scope_database` 和 `scope_schema`，确保不同数据库下同名表的同名指标互不干扰

---

## 新增/修改 Tauri 命令汇总

| 命令 | 类型 | 说明 |
|------|------|------|
| `ai_generate_metrics` | 修改 | 新增 `database`、`schema`、`table_names` 参数，返回类型改为 `String`（task_id） |
| `list_tables_with_column_count` | 新增 | 返回表名+列数，供选表弹窗使用，内部并发拉取避免超时 |

两个命令均需在 `lib.rs` 的 `generate_handler![]` 中注册（修改现有注册项 + 新增一项）。

---

## 不在本次范围内

- 取消正在运行的任务（cancel）
- 任务历史持久化到磁盘（关闭应用后清除）
- 其他类型的后台任务接入（迁移任务等，架构已预留 `type` 字段）

---

## 文件变更清单

| 文件 | 类型 |
|------|------|
| `src/store/bgTaskStore.ts` | 新增 |
| `src/components/TaskBar/index.tsx` | 新增 |
| `src/components/TaskBar/TaskLogPanel.tsx` | 新增 |
| `src/components/MetricsExplorer/TablePickerModal.tsx` | 新增 |
| `src/components/MetricsExplorer/MetricListPanel.tsx` | 改动（删除旧 invoke、接入 bgTaskStore、补充 MetricsTree 刷新） |
| `src/App.tsx` | 改动（加入 TaskBar + initBgTaskListeners） |
| `src-tauri/src/metrics/ai_draft.rs` | 改动（注入 AppHandle、emit 事件、去重逻辑） |
| `src-tauri/src/commands.rs` | 改动（修改 ai_generate_metrics 签名、新增 list_tables_with_column_count） |
| `src-tauri/src/lib.rs` | 改动（更新 generate_handler! 注册） |
