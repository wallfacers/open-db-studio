# SeaTunnel 迁移中心 设计文档

**日期：** 2026-03-20
**状态：** 已审批
**替换模块：** `MigrationWizard`（现有数据迁移向导完全移除）

---

## 一、背景与目标

open-db-studio V3 阶段引入 SeaTunnel 外部引擎接入，将现有的「数据迁移」模块升级为功能完整的「迁移中心」。

核心目标：
- 管理多个 SeaTunnel 集群连接（REST API 方式）
- 用户自定义分类管理 Job 目录树
- 可视化 Builder（Source → Transform → Sink）与 JSON 脚本编辑器双向切换
- 实时流式日志与状态同步
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
- `SeaTunnelSidebar` 挂载方式与 `MetricsSidebar` 完全一致
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
  ├── mod.rs                       # 模块入口
  ├── client.rs                    # SeaTunnel REST API 封装（reqwest）
  └── commands.rs                  # Tauri 命令实现
```

---

## 四、数据模型（SQLite）

```sql
-- SeaTunnel 集群连接
CREATE TABLE IF NOT EXISTS seatunnel_connections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,        -- REST API base URL, e.g. http://host:5801
  auth_token TEXT,                 -- AES-256-GCM 加密存储
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 用户自定义分类（支持无限嵌套）
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
  last_job_id   TEXT,              -- SeaTunnel 返回的 jobId
  last_status   TEXT,              -- RUNNING / FINISHED / FAILED / CANCELLED
  submitted_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

---

## 五、Tauri 命令清单

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
| `get_st_job_status` | 查询 Job 当前状态 |
| `stream_st_job_logs` | 流式拉取日志（Tauri Event emit） |

---

## 六、前端状态管理

### seaTunnelStore（Zustand）

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
  }
  hasChildren: boolean
  loaded: boolean
}

interface SeaTunnelStore {
  nodes: Map<string, STTreeNode>
  expandedIds: Set<string>
  selectedId: string | null
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

### queryStore 扩展（最小改动）

```ts
// 新增 Tab 类型
type TabType = 'query' | 'table_data' | 'table_structure'
             | 'metric' | 'metric_list'
             | 'seatunnel_job'   // 新增

// 新增 actions
openSeaTunnelJobTab: (jobId: number, title: string) => void
closeSeaTunnelJobTab: (jobId: number) => void
```

---

## 七、SeaTunnelJobTab 布局

```
┌──────────────────────────────────────────────────────────────┐
│  job名称  [集群连接 ▾]  [● FINISHED]  [▶ 提交]  [💾 保存]   │  工具栏
├──────────────────────────────────────────────────────────────┤
│  [可视化模式]  [脚本模式]                                      │  模式切换
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   可视化 Builder 或 Monaco JSON 编辑器（占主体高度）            │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  ▾ 运行日志                           [清空] [↓滚动到底]      │  可折叠日志
│  [10:32:01] Job submitted: abc123                            │
└──────────────────────────────────────────────────────────────┘
```

---

## 八、可视化 Builder + JSON 双向转换

### 支持的 Connector（V1 范围）

| 类型 | Source | Sink |
|------|--------|------|
| MySQL | ✓ | ✓ |
| PostgreSQL | ✓ | ✓ |
| SQL Server | ✓ | ✓ |
| Oracle | ✓ | ✓ |
| File (CSV/JSON) | ✓ | ✓ |
| Console | — | ✓ |

Transform（可选）：`FieldMapper`、`Filter`、`ReplaceString`

### 双向转换

```ts
// 可视化 → JSON
builderStateToConfig(state: BuilderState): string

// JSON → 可视化（含高级字段丢失提示）
configToBuilderState(json: string): BuilderState | null
```

切换到可视化模式时，若 JSON 包含 Builder 未知字段，弹出确认对话框：「存在高级配置，切换后将丢失自定义字段，确认继续？」

---

## 九、SeaTunnel REST API 集成

### 对接端点（SeaTunnel 2.3+ Zeta Engine）

| 操作 | HTTP | 路径 |
|------|------|------|
| 提交 Job | POST | `/hazelcast/rest/maps/submitJob` |
| 查询状态 | GET | `/api/v1/job/detail/{jobId}` |
| 停止 Job | POST | `/api/v1/job/stop` |
| 拉取日志 | GET | `/api/v1/job/logging/{jobId}` |

### 实时日志流

```rust
#[tauri::command]
async fn stream_st_job_logs(
    app: tauri::AppHandle,
    connection_id: i64,
    job_id: String,
) -> Result<(), String> {
    let client = get_st_client(connection_id).await?;
    let mut stream = client.stream_logs(&job_id).await?;
    while let Some(chunk) = stream.next().await {
        let line = chunk.map_err(|e| e.to_string())?;
        app.emit("st_job_log", StLogEvent { job_id: job_id.clone(), line }).ok();
    }
    Ok(())
}
```

### 提交流程

```
用户点击「提交」
  → 先调用 update_st_job 保存最新配置
  → 调用 submit_st_job → POST /submitJob → 返回 jobId
  → Tab 工具栏状态更新为 RUNNING
  → 调用 stream_st_job_logs 开始拉取日志
  → 日志流结束时 emit st_job_finished 事件
  → 前端更新状态为 FINISHED / FAILED
  → seaTunnelStore.updateJobStatus 同步左树状态徽章
```

---

## 十、AI 集成

### 上下文注入

`SeaTunnelJobTab` 作为标准 Tab，Tab 的 `content` 字段包含当前 job 配置文本：

```
[SeaTunnel Job: mysql→pg_orders]
Connection: prod-cluster (http://192.168.1.10:5801)
Status: FINISHED

Config:
{ "env": {...}, "source": [...], "sink": [...] }
```

现有 AI 助手读取活跃 Tab 内容的机制自动生效，无需额外开发。

### AI 生成 Job（/gen-job 指令）

```
用户: /gen-job 把 MySQL 的 orders 表同步到 PostgreSQL 的 dw_orders 表
  → AI 返回完整 SeaTunnel JSON 配置（包裹在 <seatunnel-job> 标签内）
  → MCP 工具 propose_seatunnel_job 触发前端确认面板
  → 用户确认后自动新建 Job Tab 并填入配置
```

新增 MCP 工具 `propose_seatunnel_job`，类比现有 `propose_sql_diff` 实现。

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

树节点行高、字号、缩进、右键菜单样式完全对齐 `MetricsTree`。

---

## 十二、移除项

- `src/components/MigrationWizard/index.tsx` — 整体删除
- `App.tsx` 中 `activeActivity === 'migration'` 分支 — 替换为 `seatunnel`
- ActivityBar 中「数据迁移」入口 — 替换为「迁移中心」
