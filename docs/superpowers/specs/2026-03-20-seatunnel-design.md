<!-- STATUS: ✅ 已实现 -->
# SeaTunnel 迁移中心 设计文档

**日期：** 2026-03-20
**状态：** ✅ 已实现
**实现日期：** 2026-03-26
**替换模块：** `MigrationWizard`（现有数据迁移向导完全移除）
**目标 SeaTunnel 版本：** >= 2.3.3（Zeta Engine，统一使用 `/api/v1/` REST 路径）

---

## 一、背景与目标

open-db-studio V3 阶段引入 SeaTunnel 外部引擎接入，将现有的「数据迁移」模块升级为功能完整的「迁移中心」。

核心目标：
- 管理多个 SeaTunnel 集群连接（REST API 方式）
- 用户自定义分类管理 Job 目录树（最大嵌套深度 3 层）
- 可视化 Builder（Source → Transform → Sink）与 JSON 脚本编辑器双向切换
- 实时流式日志与状态同步（含网络中断降级策略）
- AI 生成 Job 配置 + 上下文感知问答

---

## 二、整体布局

```
ActivityBar | SeaTunnelSidebar (左树) | MainContent Tab区 | Assistant (右)
            |                         |                   |
            | [迁移中心]               | [job1] [job2] ... | AI 助手
            | ├─ 📁 生产环境任务        | ┌─────────────────┐|
            | │  ├─ mysql→pg_orders   | │ 可视化 | 脚本    ││
            | │  └─ ods_sync          | │ Source → Sink   ││
            | ├─ 📁 测试任务            | │ 状态/日志区      ││
            | └─ + 新建分类            | └─────────────────┘|
```

- ActivityBar `migration` 入口重命名为「迁移中心」，图标换为 `Workflow`
- `SeaTunnelSidebar` 挂载方式与 `MetricsSidebar` 完全一致（`hidden={activeActivity !== 'seatunnel'}`）
- `MainContent` 通过 `tabType === 'seatunnel_job'` 分叉渲染 `<SeaTunnelJobTab />`

---

## 三、新增文件结构

```
src/components/SeaTunnelExplorer/
  ├── index.tsx                    # SeaTunnelSidebar 入口（含搜索框、标题栏操作）
  ├── SeaTunnelJobTree.tsx         # 分类+Job 平铺虚拟列表（对齐 MetricsTree 规范）
  ├── SeaTunnelConnectionModal.tsx # 集群连接 CRUD 弹窗
  └── CategoryEditModal.tsx        # 分类新建/重命名弹窗

src/components/SeaTunnelJobTab/
  ├── index.tsx                    # Tab 主体（工具栏、模式切换、日志面板）
  ├── VisualBuilder.tsx            # 可视化 Source→Transform→Sink 构建器
  ├── JsonEditor.tsx               # Monaco JSON 编辑器封装
  └── JobLogPanel.tsx              # 实时日志流面板

src/store/seaTunnelStore.ts        # 分类/Job/连接 Zustand store

src-tauri/src/seatunnel/
  ├── mod.rs                       # 模块入口（pub mod seatunnel; 加入 lib.rs）
  ├── client.rs                    # SeaTunnel REST API 封装（reqwest）
  └── commands.rs                  # Tauri 命令实现

# 修改文件
src/types/index.ts                 # 追加 TabType + Tab 专属字段（见第六节）
src/store/queryStore.ts            # 追加 openSeaTunnelJobTab / closeSeaTunnelJobTab
src-tauri/src/lib.rs               # mod seatunnel + generate_handler![] 注册（见第五节）
schema/init.sql                    # 追加三张新表 DDL
src/components/ActivityBar/index.tsx # migration → seatunnel
src/App.tsx                        # SeaTunnelSidebar 挂载 + activeActivity 分支
```

---

## 四、数据模型（SQLite）

### 新增 DDL（追加至 schema/init.sql）

现有 `run_migrations` 使用 `execute_batch(SCHEMA)` 执行 `schema/init.sql`，所有语句带 `IF NOT EXISTS` 保证幂等，对存量数据库安全。

```sql
-- SeaTunnel 集群连接
CREATE TABLE IF NOT EXISTS seatunnel_connections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,        -- REST API base URL, e.g. http://host:5801
  auth_token_enc TEXT,             -- AES-256-GCM 加密存储（_enc 后缀对齐现有 password_enc/api_key_enc 命名规范，禁止明文写入）
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 用户自定义分类（最大嵌套深度 3 层，由前端 CategoryEditModal 校验）
CREATE TABLE IF NOT EXISTS seatunnel_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES seatunnel_categories(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- SeaTunnel Job 定义
CREATE TABLE IF NOT EXISTS seatunnel_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  category_id   INTEGER REFERENCES seatunnel_categories(id) ON DELETE SET NULL,
  connection_id INTEGER REFERENCES seatunnel_connections(id) ON DELETE SET NULL,
  config_json   TEXT NOT NULL DEFAULT '{}',
  last_job_id   TEXT,              -- SeaTunnel 返回的 jobId（字符串）
  last_status   TEXT,              -- RUNNING / FINISHED / FAILED / CANCELLED
  submitted_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

### 注意：task_records 表无需变更

现有 `task_records.type` CHECK 约束已包含 `'seatunnel'` 值（预埋），无需额外迁移。

---

## 五、Tauri 命令清单与注册

### 命令列表

| 命令 | 说明 |
|------|------|
| `list_st_connections` | 列出所有 SeaTunnel 集群连接 |
| `create_st_connection` | 新建连接（token AES-256-GCM 加密） |
| `update_st_connection` | 编辑连接 |
| `delete_st_connection` | 删除连接 |
| `list_st_categories` | 获取全部分类（含层级） |
| `create_st_category` | 新建分类 |
| `rename_st_category` | 重命名分类 |
| `delete_st_category` | 删除分类（级联删除子分类） |
| `move_st_category` | 移动分类位置 |
| `list_st_jobs` | 列出所有 Job |
| `create_st_job` | 新建 Job |
| `update_st_job` | 保存 Job 配置 |
| `delete_st_job` | 删除 Job |
| `move_st_job` | 移动 Job 到其他分类 |
| `submit_st_job` | 提交 Job 到 SeaTunnel REST API |
| `stop_st_job` | 停止运行中的 Job（POST /api/v1/job/stop） |
| `get_st_job_status` | 查询 Job 当前状态 |
| `stream_st_job_logs` | 流式拉取日志（Tauri Event emit，注册 AbortHandle） |
| `cancel_st_job_stream` | 取消日志流（通过 task_abort_handles 中断） |

### lib.rs 注册（必须）

```rust
// src-tauri/src/lib.rs — 将 mod seatunnel 插入第1-14行的 mod 声明块内（与其他 mod 声明并列）
mod seatunnel;

// generate_handler![] — 追加到现有 invoke_handler 列表末尾（commands::agent_summarize_session 之后）
seatunnel::commands::list_st_connections,
seatunnel::commands::create_st_connection,
seatunnel::commands::update_st_connection,
seatunnel::commands::delete_st_connection,
seatunnel::commands::list_st_categories,
seatunnel::commands::create_st_category,
seatunnel::commands::rename_st_category,
seatunnel::commands::delete_st_category,
seatunnel::commands::move_st_category,
seatunnel::commands::list_st_jobs,
seatunnel::commands::create_st_job,
seatunnel::commands::update_st_job,
seatunnel::commands::delete_st_job,
seatunnel::commands::move_st_job,
seatunnel::commands::submit_st_job,
seatunnel::commands::stop_st_job,
seatunnel::commands::get_st_job_status,
seatunnel::commands::stream_st_job_logs,
seatunnel::commands::cancel_st_job_stream,
```

---

## 六、前端状态管理

### 6.1 types/index.ts 扩展

```ts
// 追加到 TabType 联合类型（src/types/index.ts 第107行）
export type TabType =
  | 'query'
  | 'table'
  | 'er_diagram'
  | 'table_structure'
  | 'metric'
  | 'metric_list'
  | 'seatunnel_job';   // 新增

// Tab 接口追加专属字段（src/types/index.ts Tab interface）
export interface Tab {
  id: string;
  type: TabType;
  title: string;
  connectionId?: number;
  metricId?: number;
  metricScope?: MetricScope;
  db?: string;
  schema?: string;
  queryContext?: QueryContext;
  isNewTable?: boolean;
  stJobId?: number;           // seatunnel_job Tab 专用
  stConnectionId?: number;    // seatunnel_job Tab 专用
}
```

### 6.2 seaTunnelStore（Zustand）

```ts
interface STTreeNode {
  id: string                      // "cat_1" | "job_5"
  nodeType: 'category' | 'job'
  label: string
  parentId: string | null
  meta: {
    categoryId?: number
    jobId?: number
    connectionId?: number
    status?: string               // 最后一次提交状态
    sortOrder?: number
    depth?: number                // 嵌套深度（0-based），最大 2（3层）
  }
  hasChildren: boolean
  loaded: boolean
}

interface SeaTunnelStore {
  nodes: Map<string, STTreeNode>
  expandedIds: Set<string>
  selectedId: string | null
  isInitializing: boolean          // 驱动骨架屏，对齐 metricsTreeStore（isInitializing 字段）
  error: string | null             // 初始化/加载错误（metricsTreeStore 无此字段，此处为扩展）
  // actions
  init: () => Promise<void>
  toggleExpand: (id: string) => void
  createCategory: (name: string, parentId?: number) => Promise<void>
  renameCategory: (id: number, name: string) => Promise<void>
  deleteCategory: (id: number) => Promise<void>
  createJob: (name: string, categoryId?: number) => Promise<number>
  deleteJob: (id: number) => Promise<void>
  moveJob: (jobId: number, categoryId: number | null) => Promise<void>
  updateJobStatus: (jobId: number, status: string) => void
}
```

### 6.3 expandedIds 持久化（对齐 metricsTreeStore 规范）

```ts
// 防抖 800ms 写入（对齐 flushMetricsPersist 模式）
// key: 'seatunnel_tree_expanded_ids'
// 通过现有 set_ui_state / get_ui_state Tauri 命令持久化
// App.tsx beforeunload 中调用 flushSeaTunnelPersist()
```

### 6.4 queryStore 扩展

```ts
// src/store/queryStore.ts 追加
openSeaTunnelJobTab: (jobId: number, title: string, connectionId?: number) => void
closeSeaTunnelJobTab: (jobId: number) => void
```

---

## 七、SeaTunnelJobTab 布局

```
┌──────────────────────────────────────────────────────────────────┐
│  job名称  [集群连接 ▾]  [● RUNNING]  [▶ 提交]  [■ 停止]  [💾 保存] │  工具栏
│           （RUNNING 时显示停止按钮，非运行时隐藏）                  │
├──────────────────────────────────────────────────────────────────┤
│  [可视化模式]  [脚本模式]                                          │  模式切换
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   可视化 Builder 或 Monaco JSON 编辑器（占主体高度）                │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  ▾ 运行日志                             [清空] [↓滚动到底]        │  可折叠日志
│  [10:32:01] Job submitted: abc123                                │
│  [10:32:03] Source: MySQL reading...                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 八、可视化 Builder + JSON 双向转换

### 8.1 BuilderState 类型定义

```ts
// src/components/SeaTunnelJobTab/VisualBuilder.tsx

type ConnectorType =
  | 'MySQL' | 'PostgreSQL' | 'SQLServer' | 'Oracle'
  | 'FileCSV' | 'FileJSON' | 'Console'

interface ConnectorField {
  key: string        // SeaTunnel config key
  label: string      // 显示名称
  required: boolean
  type: 'text' | 'password' | 'number' | 'select'
  options?: string[] // select 类型的选项
}

// 每种 Connector 的必填字段定义
const CONNECTOR_FIELDS: Record<ConnectorType, ConnectorField[]> = {
  MySQL: [
    { key: 'url', label: 'JDBC URL', required: true, type: 'text' },
    { key: 'driver', label: 'Driver', required: true, type: 'text' },
    { key: 'user', label: '用户名', required: true, type: 'text' },
    { key: 'password', label: '密码', required: false, type: 'password' },
    { key: 'query', label: 'SQL Query', required: false, type: 'text' },  // Source 专用
    { key: 'database', label: 'Database', required: false, type: 'text' },
    { key: 'table', label: 'Table', required: false, type: 'text' },      // Sink 专用
  ],
  PostgreSQL: [ /* 同 MySQL 字段集 */ ],
  // ... 其他 Connector 类似
}

interface ConnectorConfig {
  type: ConnectorType
  fields: Record<string, string>   // key → value
}

type TransformType = 'FieldMapper' | 'Filter' | 'ReplaceString'

interface TransformConfig {
  type: TransformType
  fields: Record<string, string>
}

interface EnvConfig {
  jobName: string
  parallelism: number
}

interface BuilderState {
  env: EnvConfig
  source: ConnectorConfig
  transforms: TransformConfig[]
  sink: ConnectorConfig
}
```

### 8.2 支持的 Connector（V1 范围）

| 类型 | Source | Sink |
|------|--------|------|
| MySQL | ✓ | ✓ |
| PostgreSQL | ✓ | ✓ |
| SQL Server | ✓ | ✓ |
| Oracle | ✓ | ✓ |
| File (CSV/JSON) | ✓ | ✓ |
| Console | — | ✓ |

Transform（可选）：`FieldMapper`、`Filter`、`ReplaceString`

### 8.3 双向转换函数

```ts
// 可视化 → JSON（生成标准 SeaTunnel HOCON 兼容 JSON）
function builderStateToConfig(state: BuilderState): string

// JSON → 可视化（返回 null 表示无法解析）
function configToBuilderState(json: string): BuilderState | null
```

切换到可视化模式时，若 JSON 包含 Builder 未知字段，弹出 `ConfirmDialog`（复用现有组件）：
「存在高级配置，切换后将丢失自定义字段，确认继续？」

---

## 九、SeaTunnel REST API 集成

### 9.1 REST API 端点（SeaTunnel >= 2.3.3，统一 /api/v1/ 路径）

| 操作 | HTTP | 路径 |
|------|------|------|
| 提交 Job | POST | `/api/v1/job/submit` |
| 查询状态 | GET | `/api/v1/job/detail/{jobId}` |
| 停止 Job | POST | `/api/v1/job/stop` |
| 拉取日志 | GET | `/api/v1/job/logging/{jobId}` |

### 9.2 实时日志流（含取消机制）

```rust
// src-tauri/src/seatunnel/commands.rs
#[tauri::command]
async fn stream_st_job_logs(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: i64,
    job_id: String,
) -> Result<(), String> {
    // 先取消同 job_id 的已有流
    // ⚠️ 注意：task_abort_handles 使用 std::sync::Mutex（非 tokio::sync::Mutex），
    // 必须在大括号块作用域内加锁，确保 MutexGuard 在任何 .await 点之前已 drop，
    // 禁止跨 .await 持有锁，否则会在 async 上下文中引发 panic 或死锁。
    {
        let mut handles = state.task_abort_handles.lock().unwrap();
        let key = format!("st_log_{}", job_id);
        if let Some(h) = handles.remove(&key) { h.abort(); }
    }  // ← MutexGuard 在此 drop，之后的 .await 安全

    let client = get_st_client(&state, connection_id).await?;
    let job_id_clone = job_id.clone();
    let app_clone = app.clone();

    let handle = tokio::spawn(async move {
        let mut stream = match client.stream_logs(&job_id_clone).await {
            Ok(s) => s,
            Err(e) => {
                app_clone.emit("st_job_log", StLogEvent {
                    job_id: job_id_clone.clone(), line: format!("[ERROR] {}", e),
                }).ok();
                return;
            }
        };
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(line) => { app_clone.emit("st_job_log", StLogEvent { job_id: job_id_clone.clone(), line }).ok(); }
                Err(e) => {
                    // 流中断：emit 错误事件，前端触发降级轮询
                    app_clone.emit("st_job_stream_error", StStreamErrorEvent {
                        job_id: job_id_clone.clone(), reason: e.to_string(),
                    }).ok();
                    return;
                }
            }
        }
        app_clone.emit("st_job_finished", StJobFinishedEvent { job_id: job_id_clone }).ok();
    });

    // 注册 AbortHandle（对齐 task_abort_handles 模式）
    // ⚠️ 同上，必须用块作用域保证 MutexGuard 在返回前 drop
    {
        let mut handles = state.task_abort_handles.lock().unwrap();
        handles.insert(format!("st_log_{}", job_id), handle.abort_handle());
    }  // ← MutexGuard drop
    Ok(())
}

#[tauri::command]
async fn cancel_st_job_stream(
    state: tauri::State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let mut handles = state.task_abort_handles.lock().unwrap();
    if let Some(h) = handles.remove(&format!("st_log_{}", job_id)) { h.abort(); }
    Ok(())
}
```

### 9.3 提交流程

```
用户点击「提交」
  → update_st_job 保存最新配置
  → submit_st_job → POST /api/v1/job/submit → 返回 jobId
  → Tab 工具栏状态更新为 RUNNING（显示停止按钮）
  → stream_st_job_logs(jobId) 开始拉取日志
  → 正常结束：emit st_job_finished → 更新状态为 FINISHED/FAILED
  → 网络中断：emit st_job_stream_error → 前端每 10s 轮询 get_st_job_status
    直到状态变为终态（FINISHED/FAILED/CANCELLED）
  → seaTunnelStore.updateJobStatus 同步左树状态徽章
```

### 9.4 网络中断降级策略

前端监听 `st_job_stream_error` 事件后，启动降级轮询：

```ts
// JobLogPanel.tsx
listen('st_job_stream_error', ({ payload }) => {
  if (payload.job_id !== jobId) return
  appendLog('[WARN] 日志流中断，切换为状态轮询...')
  const timer = setInterval(async () => {
    const status = await invoke<string>('get_st_job_status', { jobId })
    if (['FINISHED', 'FAILED', 'CANCELLED'].includes(status)) {
      clearInterval(timer)
      onStatusChange(status)
    }
  }, 10_000)
})
```

---

## 十、AI 集成

### 10.1 上下文注入（复用现有机制）

`SeaTunnelJobTab` Tab 的 `content` 字段（由现有 AI 助手 Tab 读取机制使用）包含：

```
[SeaTunnel Job: mysql→pg_orders]
Connection: prod-cluster (http://192.168.1.10:5801)
Status: FINISHED

Config:
{ "env": {...}, "source": [...], "sink": [...] }
```

无需额外开发，现有 AI 助手读取活跃 Tab 内容机制自动生效。

### 10.2 AI 生成 Job（/gen-job 指令）

交互协议（对齐 `propose_sql_diff` 的双向握手模式）：

```
1. 用户在 AI 助手输入: /gen-job 把 MySQL orders 表同步到 PostgreSQL dw_orders
2. AI 返回 JSON 配置（包裹在 <seatunnel-job> 标签内）
3. Rust MCP 工具 propose_seatunnel_job 通过 send_ui_action 发出事件
4. useMcpBridge 钩子注册对应 handler，前端弹出确认面板（含配置预览）
5. 用户确认 → 调用 createJob → openSeaTunnelJobTab → 填入配置
6. 前端调用 Tauri 命令 `respond_ui_action`（复用现有命令，payload 含 action_id + accepted: bool）
   向 Rust 返回 "accepted" / "rejected"，Rust 侧通过 pending_ui_actions oneshot channel 接收
```

新增 MCP 工具 `propose_seatunnel_job`（`src-tauri/src/mcp/tools/` 下新建文件，
注册到 MCP tool catalog，对齐 `propose_sql_diff` 的 30s 超时握手实现）。
前端响应命令统一使用已有的 `respond_ui_action` Tauri 命令，无需新建专用响应命令。

---

## 十一、主题色规范

所有新组件严格遵循现有主题色：

| 用途 | 色值 |
|------|------|
| 最深背景 | `#0d1117` |
| 面板背景 | `#111922` |
| 悬停/选中背景 | `#1a2639` / `#1e2d42` |
| 边框 | `#253347` |
| 主色调（强调/激活） | `#00c9a7` |
| 主文字 | `#c8daea` |
| 次要文字 | `#7a9bb8` |
| 错误 | `text-red-400` |
| 警告 | `text-yellow-400` |

树节点行高、字号、缩进、右键菜单样式完全对齐 `MetricsTree`（平铺虚拟列表 + `paddingLeft` 缩进）。

---

## 十二、移除项

### 前端

- `src/components/MigrationWizard/index.tsx` — 整体删除
- `App.tsx` 中 `activeActivity === 'migration'` 分支 — 替换为 `seatunnel`
- ActivityBar 中「数据迁移」入口 — 替换为「迁移中心」，图标 `ArrowLeftRight` → `Workflow`

### Rust 后端（保留数据，移除前端入口）

- `src-tauri/src/migration/` — **保留**（历史迁移任务数据不删除）
- `lib.rs` 的 `generate_handler![]` 中移除旧命令注册（对照 lib.rs migration 相关行逐一核查）：
  - `migration::commands::create_migration_task`
  - `migration::commands::run_migration_precheck`
  - `migration::commands::start_migration`
  - `migration::commands::pause_migration`
  - `migration::commands::get_migration_task`
  - `migration::commands::list_migration_tasks`
  - `migration::commands::get_precheck_report`
  - `migration::commands::get_migration_progress`
- SQLite 表 `migration_tasks`、`migration_checks` — **保留**（历史数据）
- `task_records.type` CHECK 约束 — **无需变更**（已包含 'migration' 和 'seatunnel'）
