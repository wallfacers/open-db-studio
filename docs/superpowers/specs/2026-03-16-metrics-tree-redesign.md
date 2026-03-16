# 业务指标模块重构设计文档

**日期**：2026-03-16
**状态**：已批准
**作者**：Claude Code + 用户协作

---

## 1. 背景与目标

### 现状
当前业务指标模块（`MetricsPanel`）是一个简单的扁平列表，通过 ActivityBar 切换展示，按状态过滤，依赖当前活跃 Tab 的 `connectionId` 获取数据。

### 问题
- 无法按数据库/Schema 组织和浏览指标
- 缺少树形导航，用户无法快速定位特定库下的指标
- 不支持原子指标与复合指标的区分
- 缺少字段：分类标签、数据口径说明、版本号

### 目标
将业务指标模块重构为**树形导航 + Tab 编辑器**的模式，与数据库浏览器体验一致，同时支持原子指标和复合指标两种类型。

---

## 2. 整体架构

### 方案选型
**方案 C**：MetricsTree 独立加载连接/数据库/Schema 数据 + 新建指标视图层

- MetricsTree 通过相同的 Tauri 命令（`list_connections`、`list_databases`、`list_schemas`）独立加载树节点，不依赖 `treeStore` 的已加载状态（避免用户未展开 DBTree 时出现空树问题）
- 新建 `metricsTreeStore` 管理指标树所有状态
- `TreeNode.tsx` 渲染组件直接复用
- 不改动现有 `DBTree` 代码，零干扰

### 文件结构

```
src/
├── components/
│   ├── Explorer/
│   │   ├── DBTree.tsx           (不动)
│   │   ├── TreeNode.tsx         (复用，不动)
│   │   └── index.tsx            (不动)
│   └── MetricsExplorer/         (新建)
│       ├── index.tsx            (容器：搜索栏 + MetricsTree)
│       ├── MetricsTree.tsx      (主树组件)
│       ├── MetricTab.tsx        (指标 Tab 页：表单 + SQL 编辑器)
│       └── MetricListPanel.tsx  (指标列表管理页 Tab)
├── store/
│   └── metricsTreeStore.ts      (新建)
└── types/index.ts               (扩展 Metric 类型 + Tab 类型)
```

### 状态划分

```
metricsTreeStore（新建，自包含）
  ├─ nodes: Map<nodeId, MetricsTreeNode>    所有树节点（连接/数据库/Schema/指标）
  ├─ expandedIds: Set<string>               展开状态
  ├─ selectedId: string | null              选中节点
  ├─ metricCounts: Map<nodeId, number>      各节点指标计数
  ├─ loadedMetrics: Map<nodeId, Metric[]>   已加载的指标列表（按节点缓存）
  └─ loadingIds: Set<string>               加载中状态
```

---

## 3. 树结构设计

### 层级

```
Connection (数据库连接图标 + 连接名)
  └─ Database (数据库图标 + 库名 + [指标数])
      └─ Schema (仅 PG/Oracle，Layers图标 + schema名 + [指标数])
          ├─ 📊 原子指标显示名   (BarChart2 图标)
          └─ 🔗 复合指标显示名   (GitMerge 图标)
```

对于无 Schema 的数据库（MySQL）：

```
Connection
  └─ Database [指标数]
      ├─ 📊 原子指标
      └─ 🔗 复合指标
```

### 节点展开行为

| 展开层级 | 触发动作 |
|----------|----------|
| Connection | 调用 `list_databases(connectionId)`，过滤系统库，渲染数据库节点 |
| Database | 若有 Schema（PG/Oracle），调用 `list_schemas(connectionId, database)` 过滤系统 schema；否则直接调用 `list_metrics_by_node` 加载指标 |
| Schema | 调用 `list_metrics_by_node(connectionId, database, schema)` 加载指标 |

### 系统库过滤

过滤在 Rust 层处理，`list_databases` 和 `list_schemas` 命令内部过滤，前端无感知：

```rust
const SYSTEM_SCHEMAS: &[&str] = &[
    "information_schema", "pg_catalog",
    "performance_schema", "sys", "mysql",
];
// 同样适用于 database 级别的系统库过滤
```

### 右键菜单

**Connection 节点：**
```
┌──────────┐
│ 🔄 刷新   │
└──────────┘
```

**Database / Schema 节点：**
```
┌──────────────────┐
│ 📋 打开指标列表   │
│ ────────────── │
│ 🔄 刷新          │
└──────────────────┘
```

**Metric 节点：**
```
┌──────────┐
│ 📂 打开   │
│ ✏️  编辑   │
│ ─────── │
│ 🗑️  删除   │
└──────────┘
```

### 指标计数徽标（P2）

数据库/Schema 节点名称右侧显示指标数，颜色 `#7a9bb8`（与现有设计一致）：

```
mydb  [12]
  └─ public  [8]
  └─ analytics  [4]
```

**计数加载策略**：展开 Connection 时，调用 `count_metrics_batch(connectionId)` 一次性获取该连接下所有数据库的指标计数（避免 N 次请求）。展开 Database 时，调用 `count_metrics_batch(connectionId, database)` 获取所有 Schema 的计数。

---

## 4. Tab 页设计

### Tab 类型扩展

```typescript
// types/index.ts 追加
export type TabType = 'query' | 'table' | 'er_diagram' | 'metric' | 'metric_list';

export interface Tab {
  // ...现有字段不变...
  metricId?: number;        // 新增：metric Tab 使用
  metricScope?: {           // 新增：metric_list Tab 使用
    connectionId: number;
    database?: string;
    schema?: string;
  };
}
```

### 4.1 原子指标 Tab（MetricTab - atomic）

Tab 标题为指标显示名，`tabType: 'metric'`，`metricId` 对应指标 ID。

**执行预览 SQL 模板**（点击"执行预览"时生成）：
```sql
SELECT {aggregation}({column_name}) AS {name}
FROM {table_name}
{filter_sql}   -- 若有 filter_sql，直接追加（需以 WHERE 开头）
LIMIT 100
```
若 `column_name` 为空（如 COUNT(*)），则生成 `{aggregation}(*)`。

**布局（上下分割）：**

```
┌─────────────────────────────────────────────┐
│  [指标显示名]                    [保存] [关闭] │
├─────────────────────────────────────────────┤
│  上半区：元数据表单（约 40%）                   │
│                                             │
│  指标类型     ● 原子指标  ○ 复合指标            │
│  显示名称 *   [________________]             │
│  英文标识 *   [________________]             │
│  关联表   *   [________________]             │
│  关联列       [________________]             │
│  聚合方式     [SUM ▼]                        │
│  分类标签     [________________]             │
│  版本号       [________________]  格式：semver │
│  描述         [________________________________]│
│  数据口径说明  [________________________________]│
│                                             │
├─────────────────────────────────────────────┤
│  下半区：filter_sql 编辑器（约 60%）            │
│                                             │
│  -- WHERE 条件（不含 WHERE 关键字）             │
│  created_at >= '2024-01-01'                 │
│                                             │
│                              [执行预览]      │
├─────────────────────────────────────────────┤
│  执行结果区（可折叠，默认折叠）                  │
└─────────────────────────────────────────────┘
```

### 4.2 复合指标 Tab（MetricTab - composite）

选择"复合指标"后，SQL 编辑区替换为组合器：

```
┌─────────────────────────────────────────────┐
│  指标类型   ○ 原子指标   ● 复合指标            │
├─────────────────────────────────────────────┤
│  参与指标（仅可引用原子指标）：                 │
│  [日活用户数 ×]  [总用户数 ×]  [+ 添加指标]    │
│                                             │
│  可视化组合：                                │
│  [日活用户数 ▼]  [÷ ▼]  [总用户数 ▼]  [+ 添加] │
│                                             │
│  自动生成 SQL 预览：                          │
│  (SELECT COUNT(*) FROM users WHERE ...) /   │
│  (SELECT COUNT(*) FROM users) * 100         │
│                                             │
│  ──────── 或 手动输入公式 ────────            │
│  [daily_active_users / total_users * 100  ] │
│   支持引用：英文标识 或 显示名称               │
│                                             │
│  公式解析预览：                              │
│  (SELECT COUNT(*) FROM users WHERE ...) /   │
│  (SELECT COUNT(*) FROM users) * 100         │
│                              [执行预览]      │
└─────────────────────────────────────────────┘
```

**公式引用规则：**
- 英文标识引用：`daily_active_users / total_users * 100`
- 显示名引用：`日活用户数 / 总用户数 * 100`
- 两种方式均支持，Rust 解析时先尝试 `name` 匹配，再尝试 `display_name` 匹配
- **限制：复合指标只能引用原子指标**，不支持引用其他复合指标（防止循环引用）
- 后端保存时校验：若引用了复合指标，返回错误 `COMPOSITE_CANNOT_REFERENCE_COMPOSITE`
- 后端保存时校验：若引用了自身，返回错误 `COMPOSITE_SELF_REFERENCE`

### 4.3 指标列表管理 Tab（MetricListPanel）

右键数据库/Schema 节点 → "打开指标列表"，Tab 标题为 `{库名} 指标列表`，`tabType: 'metric_list'`，`metricScope` 记录范围。

调用 `list_metrics_by_node`（新命令）而非现有 `list_metrics`（后者仅按 connectionId 过滤）。

```
┌─────────────────────────────────────────────┐
│  mydb 指标列表                               │
├─────────────────────────────────────────────┤
│  [全部] [草稿] [已通过] [已拒绝]       搜索🔍  │
│                         [新增指标] [AI生成]  │
├──┬──────────┬────────┬──────┬──────┬────────┤
│☐ │ 显示名称  │ 关联表  │ 聚合 │ 类型 │ 状态   │ 操作  │
├──┼──────────┼────────┼──────┼──────┼────────┤
│☐ │ 日活用户数 │ users  │COUNT │原子  │✅已通过 │打开 编辑 删除│
│☐ │ 订单总额  │ orders │ SUM  │原子  │📝草稿  │打开 编辑 删除│
│☐ │ DAU占比   │  -     │  -   │复合  │✅已通过 │打开 编辑 删除│
├──┴──────────┴────────┴──────┴──────┴────────┤
│  已选 2 项  [批量删除] [批量通过] [批量拒绝]    │
└─────────────────────────────────────────────┘
```

---

## 5. 数据模型变更

### 5.1 前端类型扩展（types/index.ts）

```typescript
export type MetricType = 'atomic' | 'composite';

export interface CompositeComponent {
  metric_id: number;
  metric_name: string;      // 英文标识
  display_name: string;     // 显示名称
}

export interface Metric {
  id: number;
  connection_id: number;
  name: string;                          // 英文标识（蛇形）
  display_name: string;                  // 中文显示名
  table_name: string;
  column_name?: string;
  aggregation?: string;                  // SUM/COUNT/AVG/MAX/MIN
  filter_sql?: string;
  description?: string;
  status: 'draft' | 'approved' | 'rejected';
  source: 'ai' | 'manual';
  metric_type: MetricType;               // 新增
  composite_components?: CompositeComponent[]; // 新增（复合指标，存为 JSON）
  composite_formula?: string;            // 新增（复合指标公式字符串）
  category?: string;                     // 新增：分类标签
  data_caliber?: string;                 // 新增：数据口径说明
  version?: string;                      // 新增：版本号（建议 semver，如 v1.0.0）
  scope_database?: string;               // 新增：所属数据库（避免与连接字段 database_name 冲突）
  scope_schema?: string;                 // 新增：所属 Schema
  created_at: string;
  updated_at: string;
}
```

### 5.2 SQLite 迁移

**`schema/init.sql` 同步更新**，新增所有字段到 `CREATE TABLE metrics` 语句。

同时在应用启动时执行迁移脚本（`IF NOT EXISTS` 检查），兼容存量数据库：

```sql
-- 存量数据库迁移（init.sql 同步更新新列定义）
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS metric_type TEXT NOT NULL DEFAULT 'atomic';
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS composite_components TEXT;  -- JSON: CompositeComponent[]
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS composite_formula TEXT;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS data_caliber TEXT;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS version TEXT;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS scope_database TEXT;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS scope_schema TEXT;

-- 修正 source 字段 CHECK 约束（旧值 'user' 统一更新为 'manual'）
UPDATE metrics SET source = 'manual' WHERE source = 'user';

-- 查询性能索引
CREATE INDEX IF NOT EXISTS idx_metrics_node
  ON metrics(connection_id, scope_database, scope_schema);
```

**`composite_components` JSON 约定**：
- 存储格式：`[{"metric_id": 1, "metric_name": "dau", "display_name": "日活用户数"}, ...]`
- 反序列化：前端 `JSON.parse`，Rust `serde_json::from_str::<Vec<CompositeComponent>>`
- 删除原子指标时：若有复合指标引用它，阻止删除并返回错误列表（不级联删除）

### 5.3 Rust 结构体扩展

**`Metric` 输出结构体：**

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Metric {
    pub id: i64,
    pub connection_id: i64,
    pub name: String,
    pub display_name: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub source: String,
    pub metric_type: String,                    // 新增
    pub composite_components: Option<String>,   // 新增（JSON 字符串）
    pub composite_formula: Option<String>,      // 新增
    pub category: Option<String>,               // 新增
    pub data_caliber: Option<String>,           // 新增
    pub version: Option<String>,                // 新增
    pub scope_database: Option<String>,         // 新增
    pub scope_schema: Option<String>,           // 新增
    pub created_at: String,
    pub updated_at: String,
}
```

**`CreateMetricInput` 输入结构体（同步更新）：**

```rust
#[derive(Debug, Deserialize)]
pub struct CreateMetricInput {
    pub connection_id: i64,
    pub name: String,
    pub display_name: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub metric_type: Option<String>,            // 新增，默认 "atomic"
    pub composite_components: Option<String>,   // 新增（JSON）
    pub composite_formula: Option<String>,      // 新增
    pub category: Option<String>,               // 新增
    pub data_caliber: Option<String>,           // 新增
    pub version: Option<String>,                // 新增
    pub scope_database: Option<String>,         // 新增
    pub scope_schema: Option<String>,           // 新增
    pub source: Option<String>,                 // 默认 "manual"
}
```

**`UpdateMetricInput` 输入结构体（同步更新）：**

```rust
#[derive(Debug, Deserialize)]
pub struct UpdateMetricInput {
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub table_name: Option<String>,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub metric_type: Option<String>,            // 新增
    pub composite_components: Option<String>,   // 新增（JSON）
    pub composite_formula: Option<String>,      // 新增
    pub category: Option<String>,               // 新增
    pub data_caliber: Option<String>,           // 新增
    pub version: Option<String>,                // 新增
    pub scope_database: Option<String>,         // 新增
    pub scope_schema: Option<String>,           // 新增
}
```

**`row_to_metric` 反序列化函数**：现有函数读取 13 列（索引 0–12），更新后读取 21 列（索引 0–20），对应新增的 8 个字段。`SELECT_COLS` 常量同步更新。

---

## 6. Tauri 命令

### 新增命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `list_metrics_by_node` | `connection_id: i64, database?: string, schema?: string, status?: string` | `Vec<Metric>` | 按节点范围查询指标（MetricListPanel 和指标树使用） |
| `count_metrics_batch` | `connection_id: i64, database?: string` | `HashMap<String, i64>` | 批量获取节点下指标计数（`database` 为 None 时返回各数据库计数；有值时返回各 Schema 计数） |

### 现有命令用途调整

| 命令 | 调整说明 |
|------|---------|
| `list_metrics` | 仅保留向后兼容，MetricsExplorer 全部改用 `list_metrics_by_node` |
| `save_metric` | 参数结构对应新 `CreateMetricInput`，需同步更新 |
| `update_metric` | 参数结构对应新 `UpdateMetricInput`，需同步更新 |
| `delete_metric` | 新增：删除前检查是否被复合指标引用，若有则返回错误 |

---

## 7. 系统库过滤规则

过滤逻辑在 Rust 命令层处理，MetricsTree 调用 `list_databases`/`list_schemas` 的结果自动过滤：

| 驱动 | 过滤的系统库/Schema |
|------|-------------------|
| MySQL | `information_schema`, `performance_schema`, `sys`, `mysql` |
| PostgreSQL | `information_schema`, `pg_catalog` |
| 通用兜底 | `information_schema` |

---

## 8. 实现优先级

1. **P0**：SQLite schema 迁移 + `init.sql` 更新 + `source` CHECK 约束修正
2. **P0**：Rust 结构体更新（`Metric`、`CreateMetricInput`、`UpdateMetricInput`、`row_to_metric`）
3. **P0**：新增 `list_metrics_by_node` 和 `count_metrics_batch` Tauri 命令
4. **P0**：`metricsTreeStore` + `MetricsTree` 基础树（连接/数据库/Schema/指标节点展示，含系统库过滤）
5. **P1**：`MetricTab` 原子指标编辑（表单 + filter_sql 编辑器 + 执行预览）
6. **P1**：`MetricListPanel`（指标列表管理页，含批量操作）
7. **P2**：`MetricTab` 复合指标组合器（可视化 + 公式 + 循环引用校验）
8. **P2**：指标计数徽标（`count_metrics_batch` 驱动）

---

## 9. 不在本次范围内

- 修改现有 DBTree / treeStore 任何代码
- 指标审批工作流的变更
- AI 生成指标逻辑的变更（现有 `ai_generate_metrics` 命令复用）
- 连接管理、分组管理等数据库操作功能
- 版本历史记录（version 字段仅作展示，不追踪历史快照）
