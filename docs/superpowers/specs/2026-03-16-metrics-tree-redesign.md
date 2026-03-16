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
**方案 C**：MetricsTree 复用 `treeStore` 数据 + 新建指标视图层

- `treeStore` 中已有的连接/数据库/Schema 节点数据直接复用，不重复请求
- 新建 `metricsTreeStore` 管理指标特有状态
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
└── types/index.ts               (扩展 Metric 类型)
```

### 状态划分

```
treeStore（已有，只读）
  └─ 提供：connections / databases / schemas 节点数据

metricsTreeStore（新建）
  ├─ expandedIds: Set<string>               展开状态
  ├─ selectedId: string | null              选中节点
  ├─ metricCounts: Map<nodeId, number>      各节点指标计数
  ├─ loadedMetrics: Map<nodeId, Metric[]>   已加载的指标列表
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
| Connection | 复用 treeStore 已有数据库列表，无需重新请求 |
| Database | 若有 Schema（PG/Oracle），加载 Schema 列表；否则直接加载指标列表 + 计数 |
| Schema | 加载该 Schema 下指标列表 + 计数 |

### 系统库过滤

过滤在 Rust 层处理，前端无感知：

```rust
const SYSTEM_SCHEMAS: &[&str] = &[
    "information_schema", "pg_catalog",
    "performance_schema", "sys", "mysql",
];
// 同样适用于 database 级别的系统库过滤
```

### 右键菜单

**Connection / Database / Schema 节点（极简）：**
```
┌──────────┐
│ 🔄 刷新   │
└──────────┘
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

### 指标计数徽标

数据库/Schema 节点名称右侧显示指标数，颜色 `#7a9bb8`（与现有设计一致）：

```
mydb  [12]
  └─ public  [8]
  └─ analytics  [4]
```

---

## 4. Tab 页设计

### 4.1 原子指标 Tab（MetricTab - atomic）

Tab 标题为指标显示名，复用 `queryStore` Tab 机制，新增 `tabType: 'metric'`。

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
│  版本号       [________________]             │
│  描述         [________________________________]│
│  数据口径说明  [________________________________]│
│                                             │
├─────────────────────────────────────────────┤
│  下半区：filter_sql 编辑器（约 60%）            │
│                                             │
│  -- filter SQL (WHERE 条件)                  │
│  WHERE created_at >= '2024-01-01'           │
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
│  参与指标：                                  │
│  [日活用户数 ×]  [总用户数 ×]  [+ 添加指标]    │
│                                             │
│  可视化组合：                                │
│  [日活用户数 ▼]  [÷ ▼]  [总用户数 ▼]  [+ 添加] │
│                                             │
│  自动生成 SQL 预览：                          │
│  SUM(CASE...) / COUNT(*) AS dau_ratio       │
│                                             │
│  ──────── 或 手动输入公式 ────────            │
│  [daily_active_users / total_users * 100  ] │
│   支持引用：英文标识 或 显示名称               │
│                                             │
│  公式解析预览：                              │
│  SELECT SUM(...) / COUNT(...) * 100 AS ...  │
│                              [执行预览]      │
└─────────────────────────────────────────────┘
```

**公式引用规则：**
- 英文标识引用：`daily_active_users / total_users * 100`
- 显示名引用：`日活用户数 / 总用户数 * 100`
- 两种方式均支持，系统自动识别并转换为 SQL

### 4.3 指标列表管理 Tab（MetricListPanel）

右键数据库/Schema 节点 → "打开指标列表"，Tab 标题为 `{库名} 指标列表`。

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
  composite_components?: CompositeComponent[]; // 新增（复合指标）
  composite_formula?: string;            // 新增（复合指标公式）
  category?: string;                     // 新增：分类标签
  data_caliber?: string;                 // 新增：数据口径说明
  version?: string;                      // 新增：版本号
  database?: string;                     // 新增：所属数据库
  schema?: string;                       // 新增：所属 Schema
  created_at: string;
  updated_at: string;
}
```

### 5.2 SQLite 迁移

```sql
-- 新增字段（应用启动时自动执行，IF NOT EXISTS 检查）
ALTER TABLE metrics ADD COLUMN metric_type TEXT NOT NULL DEFAULT 'atomic';
ALTER TABLE metrics ADD COLUMN composite_components TEXT;  -- JSON
ALTER TABLE metrics ADD COLUMN composite_formula TEXT;
ALTER TABLE metrics ADD COLUMN category TEXT;
ALTER TABLE metrics ADD COLUMN data_caliber TEXT;
ALTER TABLE metrics ADD COLUMN version TEXT;
ALTER TABLE metrics ADD COLUMN database_name TEXT;
ALTER TABLE metrics ADD COLUMN schema_name TEXT;
```

### 5.3 Rust Metric 结构体扩展

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
    pub composite_components: Option<String>,   // 新增（JSON）
    pub composite_formula: Option<String>,      // 新增
    pub category: Option<String>,               // 新增
    pub data_caliber: Option<String>,           // 新增
    pub version: Option<String>,                // 新增
    pub database_name: Option<String>,          // 新增
    pub schema_name: Option<String>,            // 新增
    pub created_at: String,
    pub updated_at: String,
}
```

---

## 6. 新增 Tauri 命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `count_metrics_by_node` | `connection_id: i64, database?: string, schema?: string` | `i64` | 节点下指标计数（树徽标用） |
| `list_metrics_by_node` | `connection_id: i64, database?: string, schema?: string, status?: string` | `Vec<Metric>` | 按节点范围查询指标 |

现有命令保持不变，新命令支持更细粒度的 `database` + `schema` 过滤。

---

## 7. 系统库过滤规则

过滤逻辑在 Rust 层处理，指标树的 `list_databases` 和 `list_schemas` 结果自动排除：

| 驱动 | 过滤的系统库/Schema |
|------|-------------------|
| MySQL | `information_schema`, `performance_schema`, `sys`, `mysql` |
| PostgreSQL | `information_schema`, `pg_catalog` |
| 通用 | `information_schema` |

---

## 8. 实现优先级

1. **P0**：metricsTreeStore + MetricsTree 基础树（连接/数据库/Schema/指标节点展示）
2. **P0**：系统库过滤（Rust 层）
3. **P0**：数据库 schema 迁移（新增字段）
4. **P1**：MetricTab 原子指标编辑（表单 + filter_sql 编辑器）
5. **P1**：MetricListPanel（指标列表管理页）
6. **P2**：MetricTab 复合指标组合器（可视化 + 公式）
7. **P2**：指标计数徽标

---

## 9. 不在本次范围内

- 修改现有 DBTree / treeStore 任何代码
- 指标审批工作流的变更
- AI 生成指标逻辑的变更（现有 `ai_generate_metrics` 命令复用）
- 连接管理、分组管理等数据库操作功能
