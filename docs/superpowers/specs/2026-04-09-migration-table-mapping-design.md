# Migration Center: Table Mapping, Incremental Sync & Structured Config

**Date**: 2026-04-09
**Status**: Approved
**Scope**: 迁移中心功能增强——多表映射、目标端数据库选择、增量迁移、结构化配置

---

## 1. 背景与目标

现有迁移中心支持"单源 SQL → 单目标表"的全量迁移。本次增强目标：

1. **源端多表选择** → 表映射面板，支持一对一、多对一、一对多三种映射模式
2. **目标端数据库选择** → 补全 连接→数据库 选择链路
3. **条件路由** → 一对多场景通过 WHERE 过滤拆分数据
4. **增量迁移** → DataX 式轻量增量（基于时间戳/自增ID，记录位点）
5. **自动建表** → 源表 schema 推导 DDL，字段映射可覆盖
6. **AI 字段映射推荐** → 有 AI 配置时自动调用，无 AI 则全手动
7. **结构化配置** → 配置 JSON 自描述，为后续 AI 自动生成迁移任务做准备

---

## 2. 结构化配置模型（核心）

所有 UI 和 Pipeline 围绕此配置展开。AI 可根据用户自然语言直接生成完整 JSON。

### 2.1 TypeScript 类型

```typescript
interface MigrationJobConfig {
  // 迁移模式
  syncMode: 'full' | 'incremental'

  // 增量配置（syncMode=incremental 时必填）
  incrementalConfig?: {
    field: string                         // 增量字段名（如 updated_at, id）
    fieldType: 'timestamp' | 'numeric'    // 字段类型
    lastValue?: string                    // 上次同步位点（运行后自动回写）
  }

  // 源端
  source: {
    connectionId: number
    database: string
    queryMode: 'auto' | 'custom'
    tables: string[]          // auto 模式：用户选择的表列表
    customQuery?: string      // custom 模式：用户手写 SQL
  }

  // 表映射
  tableMappings: TableMapping[]

  // 管道性能参数
  pipeline: PipelineConfig
}

interface TableMapping {
  sourceTable: string       // auto 模式引用 source.tables，custom 模式为 "custom_query"
  target: {
    connectionId: number
    database: string
    table: string
    conflictStrategy: 'INSERT' | 'UPSERT' | 'REPLACE' | 'SKIP'
    createIfNotExists: boolean
    upsertKeys: string[]
  }
  filterCondition?: string  // 条件路由 WHERE 子句（不含 WHERE 关键字）
  columnMappings: ColumnMapping[]
}

interface ColumnMapping {
  sourceExpr: string    // 源字段名或表达式
  targetCol: string     // 目标列名
  targetType: string    // 目标列类型（方言相关）
}

interface PipelineConfig {
  readBatchSize: number       // 默认 10000
  writeBatchSize: number      // 默认 1000
  parallelism: number         // 默认 1
  speedLimitRps?: number      // 可选限速
  errorLimit: number          // 默认 0
}
```

### 2.2 Rust 结构体

```rust
pub struct MigrationJobConfig {
    pub sync_mode: SyncMode,
    pub incremental_config: Option<IncrementalConfig>,
    pub source: SourceConfig,
    pub table_mappings: Vec<TableMapping>,
    pub pipeline: PipelineConfig,
}

pub enum SyncMode { Full, Incremental }

pub struct IncrementalConfig {
    pub field: String,
    pub field_type: IncrementalFieldType,
    pub last_value: Option<String>,
}

pub enum IncrementalFieldType { Timestamp, Numeric }

pub struct SourceConfig {
    pub connection_id: i64,
    pub database: String,
    pub query_mode: QueryMode,
    pub tables: Vec<String>,
    pub custom_query: Option<String>,
}

pub struct TableMapping {
    pub source_table: String,
    pub target: TargetConfig,
    pub filter_condition: Option<String>,
    pub column_mappings: Vec<ColumnMapping>,
}

pub struct TargetConfig {
    pub connection_id: i64,
    pub database: String,
    pub table: String,
    pub conflict_strategy: ConflictStrategy,
    pub create_if_not_exists: bool,
    pub upsert_keys: Vec<String>,
}
```

### 2.3 设计要点

- **AI 友好**：所有字段有明确类型和枚举值，AI 可直接生成完整 JSON
- **自由映射**：`tableMappings` 数组自然表达一对一、多对一、一对多
- **增量位点自动管理**：`lastValue` 由引擎运行后回写，用户无需手动维护
- **每条映射行的 target 独立**：支持跨库跨连接迁移
- **向后兼容**：现有单表迁移是 `tableMappings` 只有一条的特例

---

## 3. UI 流程设计

### 3.1 配置面板布局

```
+-----------------------------------------------------+
| [全量 v ]  迁移模式选择（全量/增量）                    |
| +- 增量配置（仅增量模式显示）---------------------+    |
| | 增量字段: [updated_at] 类型: [timestamp v]     |    |
| +------------------------------------------------+    |
+----------------------+------------------------------+
| 源端                  | 目标端（默认）                 |
| 连接: [MySQL-prod v]  | 连接: [PG-warehouse v]       |
| 数据库: [orders v]    | 数据库: [analytics v]        |
| 模式: [表选择|自定义SQL]|                              |
| [x] users            |                              |
| [x] orders           |                              |
| [ ] products         |                              |
+----------------------+------------------------------+
| 表映射                              [AI 推荐映射]    |
| +-----------+-----------+----------+--------------+  |
| | 源表       | 目标表     | 条件过滤  | 操作         |  |
| +-----------+-----------+----------+--------------+  |
| | users     | t_users   |          | [v]          |  |
| | orders    | t_orders  |          | [v]          |  |
| +-----------+-----------+----------+--------------+  |
| [+ 添加映射行]                                       |
+-----------------------------------------------------+
| 性能参数  读批次:[10000] 写批次:[1000] 并发:[1]        |
|          限速:[不限] 容错:[0]                         |
+-----------------------------------------------------+
```

### 3.2 多对一场景

多条映射行的目标表改为同一个表名：

```
+-----------+------------+----------+--------------+
| 源表       | 目标表      | 条件过滤  | 操作         |
+-----------+------------+----------+--------------+
| users     | combined v |          | [v]          |
| orders    | combined v |          | [v]          |
+-----------+------------+----------+--------------+
! users、orders 指向同一目标表 combined，请确认字段映射兼容
```

- 目标表名可下拉选择已有表，也可手动输入新表名
- 检测到多对一时显示黄色提示

### 3.3 一对多场景（条件路由）

通过操作菜单"复制行"创建同源表的多条映射，分别配置不同目标表和过滤条件：

```
+-----------+------------+-----------------+-------+
| 源表       | 目标表      | 条件过滤         | 操作  |
+-----------+------------+-----------------+-------+
| users     | t_users    |                 | [v]   |
| orders    | active_ord | status='active' | [v]   |
| orders    | arch_ord   | status='done'   | [v]   |
+-----------+------------+-----------------+-------+
i orders 被路由到 2 张目标表（条件路由模式）

操作列 [v] 下拉菜单：
  +----------------+
  | 字段映射        |  <- 展开字段映射子面板
  | 复制行          |  <- 复制当前行（用于一对多）
  | 删除            |
  +----------------+
```

- 检测到同一源表出现多次时显示蓝色提示"条件路由模式"
- 条件过滤列直接内联编辑，输入 WHERE 子句（不含 WHERE 关键字）

### 3.4 字段映射展开态

点击"字段映射"后，该行下方内联展开子面板：

```
+-----------+------------+----------+--------------+
| users     | t_users    |          | [^]          |
+-----------+------------+----------+--------------+
| +-- users -> t_users 字段映射 -----------------+ |
| | [AI 推荐]  [源表推导]                         | |
| |                                              | |
| |  源表达式        | 目标列名   | 目标类型  | 操作| |
| |  ----------------+----------+---------+----| |
| |  id              | id       | BIGINT  | [x]| |
| |  name            | user_name| VARCHAR | [x]| |
| |  email           | email    | TEXT    | [x]| |
| |                                              | |
| | [+ 添加字段]                                  | |
| | 自动创建: [x]  冲突策略: [INSERT v]            | |
| | UPSERT Keys: [id]（仅 UPSERT 时显示）         | |
| +----------------------------------------------+ |
+-----------+------------+----------+--------------+
| orders    | active_ord | status=..| [v]          |
+-----------+------------+----------+--------------+
```

- **有 AI 配置时**：展开后自动调用 AI 推荐，loading 态显示骨架屏
- **无 AI 时**：隐藏"AI 推荐"按钮，用户点"源表推导"做 1:1 同名映射，或完全手动

### 3.5 交互联动逻辑

| 用户操作 | 联动效果 |
|---------|---------|
| 源端切换连接 | 清空 database、tables、tableMappings |
| 源端切换数据库 | 清空 tables、tableMappings |
| 源端勾选/取消表 | 自动增删 tableMappings 对应行（保留已有映射行配置） |
| 目标端默认连接变更 | 所有未单独修改过的映射行继承新连接 |
| 目标端默认数据库变更 | 同上，继承新数据库 |
| 切换 syncMode | 全量->增量：展开增量配置区；增量->全量：折叠并清空增量配置 |

---

## 4. Pipeline 执行引擎改造

### 4.1 执行编排

从"单管道"改为"按映射行逐条执行的编排循环"：

```
run_migration_job(config)
  |
  +- 1. 预检查（所有映射行的连接可达性）
  |
  +- 2. 遍历 tableMappings
  |     |
  |     +- mapping[0]: users -> t_users
  |     |   +- 构建源 SQL（全量: SELECT * / 增量: + WHERE field > lastValue）
  |     |   +- 如有 filterCondition，追加 AND 条件
  |     |   +- 自动建表（如需）：读源 schema -> DDL 转换 -> CREATE TABLE IF NOT EXISTS
  |     |   +- 执行 Pipeline（Reader -> Writer）
  |     |   +- 更新该行统计
  |     |
  |     +- mapping[1]: orders -> active_ord (WHERE status='active')
  |     |   +- 同上
  |     |
  |     +- mapping[2]: orders -> arch_ord (WHERE status='done')
  |         +- 同上
  |
  +- 3. 增量模式：回写 lastValue（取所有源表增量字段的最大值）
  |
  +- 4. 汇总统计，写入 run_history
```

### 4.2 关键设计决策

- **串行执行映射行**：本次不做并行，避免对源库造成过大压力，后续可加 `tokio::spawn` 并发
- **统计汇总**：每条映射行 rows_read/written/failed 独立统计，最终汇总到 job 级别
- **错误策略**：某条映射行失败后继续执行剩余行（不整体中止），最终状态标记为 `PARTIAL_FAILED`
- **日志隔离**：每条映射行的日志带 `[users->t_users]` 前缀，便于区分
- **增量位点**：全部映射行执行完成后统一回写 `incrementalConfig.lastValue`

### 4.3 新增状态

现有：`RUNNING | FINISHED | FAILED | STOPPED`

新增：`PARTIAL_FAILED`（部分映射行成功，部分失败）

### 4.4 前端事件扩展

`MigrationStatsEvent` 新增字段：

```typescript
interface MigrationStatsEvent {
  // ... 现有字段
  currentMapping?: string    // 当前执行的映射标识 "users->t_users"
  mappingProgress?: {
    total: number            // 总映射行数
    completed: number        // 已完成行数
    current: number          // 当前第几行
  }
}
```

---

## 5. 数据模型变更

### 5.1 与现有模型差异

| 字段 | 现有 | 变更 |
|------|------|------|
| `sync_mode` | 无 | 新增 |
| `incremental_config` | 无 | 新增 |
| `source.database` | 无 | 新增 |
| `source.tables` | 无 | 新增 |
| `table_mappings` | 无 | 新增，替代顶层 target + column_mapping |
| `target` | 顶层字段 | 下沉到每条 TableMapping 内 |
| `target.database` | 无 | 新增 |
| `column_mapping` | 顶层数组 | 下沉到每条 TableMapping 内 |
| `filter_condition` | 无 | 新增 |

### 5.2 SQLite Schema 变更

`migration_jobs` 表不需要改（config_json 是 JSON 存储）。

`migration_run_history` 的 `status` 增加 `PARTIAL_FAILED` 值。

### 5.3 配置迁移策略

旧配置（顶层 target + column_mapping）自动兼容：

- 检测到旧格式（有顶层 `target` 无 `table_mappings`）-> 自动转换为单条 `tableMappings`
- 转换后回写 config_json，一次性升级

---

## 6. 新增 Tauri 命令与 AI 集成

### 6.1 新增命令

| 命令 | 用途 |
|------|------|
| `list_databases` | 列出指定连接下所有数据库（目标端选择器） |
| `get_table_schema` | 获取表的列信息（列名、类型、主键），用于字段映射推导和自动建表 |
| `ai_recommend_column_mappings` | 调用 AI 推荐字段映射 |

### 6.2 `list_databases` 方言实现

- MySQL: `SHOW DATABASES`
- PostgreSQL: `SELECT datname FROM pg_database WHERE datistemplate = false`
- SQLite: 不适用（单文件即数据库）

### 6.3 `ai_recommend_column_mappings`

**入参**：

```typescript
{
  sourceSchema: { tableName: string, columns: Column[] },
  targetSchema?: { tableName: string, columns: Column[] },
  targetDbDriver: string
}
```

**逻辑**：
- 目标表存在：AI 根据两端 schema 推荐最佳映射（名称相似度 + 类型兼容性）
- 目标表不存在：AI 根据源 schema + 目标方言推荐目标列名和类型

**返回**：`ColumnMapping[]`

**降级**：AI 不可用时隐藏按钮，返回格式异常时提示用户手动配置

---

## 7. 前端状态管理

### 7.1 ConfigTab 组件局部状态

```typescript
// 当前展开字段映射的映射行索引
const [expandedMappingIndex, setExpandedMappingIndex] = useState<number | null>(null)

// 目标端数据库列表缓存（按 connectionId）
const [targetDatabases, setTargetDatabases] = useState<Record<number, string[]>>({})

// AI 推荐 loading 状态（按映射行索引）
const [aiLoadingMap, setAiLoadingMap] = useState<Record<number, boolean>>({})
```

### 7.2 LogTab 进度显示

```
[2/3] 正在迁移 orders -> active_ord ...
```

---

## 8. 测试策略

- **配置序列化/反序列化**：验证新旧格式兼容、JSON 往返一致性
- **映射模式覆盖**：一对一、多对一、一对多各一个端到端用例
- **增量迁移**：验证 WHERE 条件拼接、位点回写和恢复
- **自动建表**：验证 DDL 跨方言转换（MySQL->PG、PG->MySQL）
- **AI 推荐降级**：无 AI 配置时 UI 隐藏按钮、AI 返回异常时优雅降级
- **旧配置迁移**：验证现有单表任务在新代码下正常加载和运行
