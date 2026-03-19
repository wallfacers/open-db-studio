# 知识图谱模块重构设计规格

**日期：** 2026-03-19
**状态：** 已批准
**范围：** graph/ 模块重构 + Graph Explorer 前端 + AI Pipeline 增强

---

## 背景与目标

现有 V2 知识图谱（`graph/`）已完成基础骨架，但存在以下不足：

1. **全量重建**：每次 `build_schema_graph` 都全量扫描 information_schema，无增量更新能力
2. **LIKE 检索**：`search_graph` 使用 LIKE 查询，语义搜索能力弱，无法支持别名模糊匹配
3. **无任务进度反馈**：图谱构建为阻塞式调用，用户无法感知进度
4. **无可视化**：图谱数据存在 SQLite 中，没有前端可视化浏览界面
5. **AI Pipeline 未集成**：图谱未接入 Text-to-SQL 流程，实体消歧能力尚未实现

本次重构目标：

- 实现 **LightRAG 三步增量更新**（局部提取 → Set Union 合并 → 增量 FTS5 Upsert）
- 构建 **Graph Explorer**（基于 @xyflow/react，已在项目中）可视化图谱浏览
- 接入 **bgTaskStore** 任务进度体系，与指标 AI 生成交互体验一致
- 将图谱检索结果注入 **Text-to-SQL Prompt 上下文**，消除实体歧义

---

## 架构总览

```
触发层
  ├── 连接数据库时自动触发
  ├── 用户手动点击"刷新图谱"
  └── （未来）定时检测 Schema 变更
        ↓
schema_change_log（事件日志表）
  processed: false → 待处理事件队列
        ↓ 事件消费
三层知识图谱（graph_nodes + graph_edges）
  ├── 结构层（自动）：table / column / fk / index 节点
  ├── 指标层（手动/AI）：metric 节点 + metric_ref 边
  └── 语义层（AI/用户）：alias 节点 + alias_of 边
        ↓
graph_nodes_fts（FTS5 增量全文索引）
        ↓ 两个出口
  ├── Graph Explorer（@xyflow/react 可视化）
  └── AI Pipeline（Text-to-SQL 上下文注入）
```

**集成策略：混合方案**
- 核心图谱用 Rust 原生实现（零外部依赖，完全本地）
- LightRAG 作为可选插件（用户安装 Python 后启用，接管语义层向量检索）

---

## 第一节：数据模型变更

### 现有表改造

`graph_nodes` 新增 `source` 字段：

```sql
ALTER TABLE graph_nodes ADD COLUMN source TEXT DEFAULT 'schema';
-- 'schema' = 自动构建（information_schema）
-- 'user'   = 用户手动标注（不被自动更新覆盖）
-- 'ai'     = AI 生成（可被自动更新）
```

Set Union 合并规则：`source='user'` 的节点在图谱更新时**跳过覆盖**，保护用户手动标注。

### 新增表

#### `schema_change_log`（LightRAG 步骤1 的核心）

```sql
CREATE TABLE IF NOT EXISTS schema_change_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  event_type    TEXT NOT NULL,
  -- 'ADD_TABLE' | 'DROP_TABLE' | 'ADD_COLUMN' | 'DROP_COLUMN' | 'ADD_FK'
  database      TEXT,
  schema        TEXT,
  table_name    TEXT NOT NULL,
  column_name   TEXT,           -- NULL 表示表级事件
  metadata      TEXT,           -- JSON：列类型、FK target 等
  processed     INTEGER DEFAULT 0,  -- 0=待处理 1=已处理
  created_at    TEXT NOT NULL,
  processed_at  TEXT
);

CREATE INDEX idx_change_log_pending
  ON schema_change_log(connection_id, processed);
```

所有触发路径（连接时自动、手动刷新、未来定时检测）统一写入此表，图谱处理器只消费 `processed=0` 的事件，实现真正的增量处理。

#### `graph_nodes_fts`（FTS5 全文检索，LightRAG 步骤3）

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts
USING fts5(
  node_id    UNINDEXED,   -- 关联 graph_nodes.id
  name,
  display_name,
  aliases,                -- semantic_aliases 聚合文本，支持别名模糊搜索
  content='graph_nodes',
  content_rowid='rowid'
);
```

替代现有 `search_graph` 的 LIKE 查询，支持中文别名模糊匹配，仅对变更节点增量更新，无需重建全量索引。

### 变更汇总

| 操作 | 对象 | 说明 |
|------|------|------|
| ALTER | `graph_nodes` | 新增 `source` 字段 |
| CREATE | `schema_change_log` | 事件日志，驱动增量更新 |
| CREATE | `graph_nodes_fts` | FTS5 全文检索虚拟表 |

现有 V2 表（`graph_edges`、`metrics`、`semantic_aliases` 等）**不变**。

---

## 第二节：Rust 模块架构

### 文件变更对照

```
graph/
├── mod.rs           — 暴露 GraphEngine + 公共类型（改造）
├── change_detector.rs  ← 新增：与 information_schema 对比，写 change_log
├── event_processor.rs  ← 新增：消费 change_log，执行三步增量更新
├── builder.rs       — 首次全量构建 + 触发初始事件写入（改造）
├── traversal.rs     — BFS JOIN 路径推断（不变）
└── query.rs         — 改用 FTS5 检索（改造，原为 LIKE）
```

### change_detector.rs

对比当前 information_schema 与 `graph_nodes` 中已有的结构层节点，生成差量事件写入 `schema_change_log`：

```rust
pub async fn detect_and_log_changes(
    db: &SqlitePool,
    conn_id: i64,
    current_schema: &SchemaInfo,  // 从 information_schema 拉取
) -> Result<usize>  // 返回写入的事件数
```

检测维度：新增表、删除表、新增列、删除列、新增外键。

### event_processor.rs — LightRAG 三步核心

```rust
pub async fn process_pending_events(
    app: &tauri::AppHandle,
    db: &SqlitePool,
    conn_id: i64,
    task_id: &str,
) -> Result<ProcessStats>
```

**步骤1：局部提取**
- 查询 `schema_change_log WHERE processed=0 AND connection_id=?`
- 按 `table_name` 分组，只拉取涉及表的完整结构
- 开销 O(Δ) 而非 O(全量)

**步骤2：Set Union 合并**

```
新节点        → INSERT INTO graph_nodes
已有节点（source='schema'） → UPDATE（更新 metadata）
已有节点（source='user'）   → 跳过（保护用户标注）
已有节点（source='ai'）     → UPDATE
删除事件      → 标记节点 deleted，保留 user-source 节点并打⚠️标记
```

**步骤3：增量 FTS5 Upsert**
- 仅对变更节点执行 FTS5 `DELETE` + `INSERT`（内容表触发器模式）
- 不重建全量索引

**步骤4：标记完成**
- `UPDATE schema_change_log SET processed=1, processed_at=now() WHERE id IN (...)`

### bgTaskStore 集成

`build_schema_graph` 命令改造为异步返回 `task_id`，与指标 AI 生成完全相同的模式：

```rust
#[tauri::command]
pub async fn build_schema_graph(
    app_handle: tauri::AppHandle,
    connection_id: i64,
) -> AppResult<String> {  // 返回 task_id
    let task_id = uuid::Uuid::new_v4().to_string();
    tokio::spawn(async move {
        crate::graph::run_graph_build(app_handle, task_id, connection_id).await;
    });
    Ok(task_id)
}
```

日志阶段示例（通过 `bg_task_log` 事件推送）：

```
INFO  连接数据库 orders_db (MySQL)
INFO  检测到 3 张新表，1 列变更
INFO  构建节点：orders(12列), users(9列), cities(6列)
INFO  发现外键关系：orders→users(user_id), orders→cities(city_id)
INFO  更新 FTS5 索引（27 个节点）
INFO  ✅ 完成，新增 27 节点，更新 3 节点，跳过 42 节点（未变更）
```

### 新增 / 改造 Tauri Commands

| Command | 类型 | 说明 |
|---------|------|------|
| `build_schema_graph` | 改造 | 返回 task_id，后台 emit bg_task_log/done |
| `search_graph` | 改造 | 改用 FTS5 检索（原为 LIKE） |
| `get_graph_edges` | 新增 | 获取指定节点的关联边，供 Graph Explorer 渲染 |
| `update_node_alias` | 新增 | 用户手动添加/编辑语义别名（source='user'） |

所有命令在 `lib.rs` 的 `generate_handler![]` 中注册。

---

## 第三节：Graph Explorer 前端

### 技术选型

使用 **@xyflow/react@^12.10.1**（已在项目中，零新增依赖）。

### 组件结构

```
src/components/GraphExplorer/
├── index.tsx          — 主面板（React Flow 画布 + 顶部工具栏）
├── NodeDetail.tsx     — 右侧节点详情面板（字段列表、别名、关联指标）
├── AliasEditor.tsx    — 添加/编辑语义别名（触发 update_node_alias）
├── nodeTypes.ts       — 自定义节点类型（TableNode / MetricNode / AliasNode）
└── useGraphData.ts    — 数据获取 Hook（get_graph_nodes + get_graph_edges）
```

### 布局设计

```
┌─────────────────────────────────────────────────┐
│ 知识图谱          [● 表][● 指标][● 别名] [🔍][🔄] │  ← 顶部工具栏
├─────────────────────────────────────────────────┤
│                                    │             │
│   [React Flow 画布]                │  节点详情   │
│   力导向布局，可拖拽缩放            │  NodeDetail │
│   左下角 MiniMap                   │             │
│                                    │             │
└─────────────────────────────────────────────────┘
```

### 颜色规范（严格遵循 DESIGN.md）

| 元素 | Tailwind 类 | 颜色值 |
|------|------------|--------|
| 背景（画布） | `bg-[#0d1117]` | `#0d1117` |
| 面板背景 | `bg-[#111922]` | `#111922` |
| 边框 | `border-[#1e2d42]` | `#1e2d42` |
| 主文字 | `text-[#c8daea]` | `#c8daea` |
| 次要文字 | `text-[#7a9bb8]` | `#7a9bb8` |
| 表节点描边 | `stroke-[#3794ff]` | `#3794ff` |
| 指标节点描边 | `stroke-[#f59e0b]` | `#f59e0b` |
| 别名节点描边 | `stroke-[#a855f7]` | `#a855f7` |
| 成功/完成 | `text-[#00c9a7]` | `#00c9a7` |

> 所有样式通过 Tailwind 类名，禁止内联 style（遵循 DESIGN.md 约定）。React Flow 的 CSS 变量（`--xy-*`）通过全局 CSS 覆盖对齐主题色。

### 节点交互

- **点击节点** → 右侧 NodeDetail 面板展示字段列表、语义别名、关联指标/边
- **悬停边** → Tooltip 显示边类型（foreign_key / metric_ref / alias_of）及 weight
- **双击空白** → 关闭 NodeDetail 面板
- **顶部筛选器** → 按层级（表/指标/别名）过滤节点显示
- **刷新按钮** → 触发 `build_schema_graph`，接入 bgTaskStore（底部 TaskBar 显示进度）
- **节点 > + 添加别名** → 打开 AliasEditor，保存后触发 `update_node_alias`

### ActivityBar 入口

在现有 ActivityBar 中新增图谱图标，点击展开 GraphExplorer 侧边栏面板。

---

## 第四节：AI Pipeline 集成

### Text-to-SQL v2 流程

```
用户输入自然语言问题
  ↓
[步骤1] pipeline/entity_extract.rs
  LLM 从问题中识别实体关键词
  "销售额" → 候选别名列表 → ["revenue", "销售额 metric"]
  "城市"   → 候选别名列表 → ["cities", "city"]

  ↓
[步骤2] graph/query.rs（FTS5）
  用实体词检索 graph_nodes_fts
  命中：cities(table), revenue(metric), orders(table)
  → BFS 推断 JOIN 路径：orders.city_id = cities.id

  ↓
[步骤3] pipeline/context_builder.rs
  组装 Prompt 上下文注入：
  - 相关表 Schema（orders, cities 的列定义）
  - JOIN 路径（orders.city_id = cities.id）
  - 指标定义（销售额 = SUM(orders.amount)）

  ↓
[步骤4] LLM 生成 SQL → sql_validator.rs 语法校验

  ↓
[步骤5] AI 助手界面
  展示折叠块"▸ 参考了以下知识图谱上下文"（可展开查看）
  SQL 插入编辑器
```

### 多义实体消歧

FTS5 检索返回多个候选节点时，按以下优先级选择：
1. `weight` 值高的节点（外键关联越多 weight 越高）
2. `source='user'` 的节点优先于 `source='schema'`
3. 有 metric 关联的 table 节点优先

### 降级策略

| 场景 | 降级行为 |
|------|---------|
| LLM 实体提取失败 | 降级为关键词直接匹配 FTS5 |
| FTS5 无命中 | 只注入直接相关表 Schema，不注入 JOIN 路径 |
| 图谱为空（未构建） | 行为与旧 `ai_generate_sql` 完全一致 |

---

## 第五节：错误处理

| 场景 | 处理方式 |
|------|---------|
| 图谱构建失败（无法连接数据库） | bgTask 标记失败，TaskBar 红色警告，Graph Explorer 空状态 + 重试按钮 |
| Schema 无变更 | event_processor 跳过，日志"无变更，跳过更新" |
| FTS5 索引更新失败 | 降级为 LIKE 查询，Toast 提示"语义搜索暂不可用" |
| user-source 节点与 schema 冲突 | 保留 user-source，节点显示 ⚠️ 标记提示用户确认 |
| React Flow 节点过多（>200） | 自动启用聚类（按 database/schema 折叠），防止性能问题 |

---

## 第六节：分阶段交付

```
阶段 1 — 数据层（约 1 周）
  ├── schema/init.sql：新增 schema_change_log + graph_nodes_fts
  ├── graph_nodes 追加 source 字段
  └── graph/change_detector.rs — 与 information_schema 对比生成事件

阶段 2 — 增量更新核心（约 1.5 周）
  ├── graph/event_processor.rs — LightRAG 三步增量更新
  ├── graph/query.rs 改造 — LIKE → FTS5
  └── build_schema_graph 改造 — 返回 task_id，接入 bgTaskStore

阶段 3 — Graph Explorer 前端（约 1.5 周，可与阶段2并行）
  ├── GraphExplorer/index.tsx — React Flow 画布（力导向布局）
  ├── GraphExplorer/NodeDetail.tsx — 右侧详情面板
  ├── GraphExplorer/AliasEditor.tsx — 语义别名编辑
  ├── get_graph_edges / update_node_alias 命令
  └── ActivityBar 新增图谱入口

阶段 4 — AI Pipeline 增强（约 1 周）
  ├── pipeline/entity_extract.rs — LLM 实体提取
  ├── pipeline/context_builder.rs — 图谱上下文注入 Prompt
  └── ai_generate_sql_v2 接入图谱，展示折叠上下文块
```

**依赖关系**：
- 阶段3 可在阶段2 完成后立即并行启动
- 阶段4 依赖阶段2 的 `query.rs` FTS5 接口

---

## 不在本次范围内

- LightRAG Python sidecar 实现（可选插件，后续版本）
- 定时 Schema 变更检测（架构已预留，后续版本）
- 图谱节点手动拖拽位置持久化
- 图谱导出（PNG / JSON）

---

## 文件变更清单

| 文件 | 类型 |
|------|------|
| `schema/init.sql` | 改动（追加 2 张新表） |
| `src-tauri/src/graph/change_detector.rs` | 新增 |
| `src-tauri/src/graph/event_processor.rs` | 新增 |
| `src-tauri/src/graph/builder.rs` | 改动 |
| `src-tauri/src/graph/query.rs` | 改动（FTS5） |
| `src-tauri/src/graph/mod.rs` | 改动 |
| `src-tauri/src/commands.rs` | 改动（build_schema_graph + 新增2命令） |
| `src-tauri/src/lib.rs` | 改动（注册新命令） |
| `src/components/GraphExplorer/index.tsx` | 新增 |
| `src/components/GraphExplorer/NodeDetail.tsx` | 新增 |
| `src/components/GraphExplorer/AliasEditor.tsx` | 新增 |
| `src/components/GraphExplorer/nodeTypes.ts` | 新增 |
| `src/components/GraphExplorer/useGraphData.ts` | 新增 |
| `src/store/bgTaskStore.ts` | 改动（新增 task type） |
