# 多数据源扩展设计 — SQLite / Apache Doris / ClickHouse / TiDB

**日期**：2026-03-23
**状态**：待实现
**优先级**：SQLite → Apache Doris → ClickHouse → TiDB

---

## 1. 背景与目标

open-db-studio 当前支持 MySQL、PostgreSQL、Oracle、SQL Server 四种数据源。
本 spec 描述将以下四种数据库纳入统一数据源框架的完整设计：

| 数据库 | 优先级 | 特点 |
|--------|--------|------|
| SQLite | 1 | 本地文件，无需网络，rusqlite 已是依赖 |
| Apache Doris | 2 | MySQL 协议兼容，OLAP 场景 |
| ClickHouse | 3 | 列存 OLAP，独立驱动，独有函数方言 |
| TiDB | 4 | MySQL 协议兼容，分布式 HTAP |

> 达梦（DM）因无成熟 Rust 驱动，本期不支持。

---

## 2. 驱动选型与架构变更

### 2.1 驱动选型

| 数据库 | Rust 驱动 | 复用策略 |
|--------|-----------|---------|
| SQLite | `rusqlite`（已有）| 新建 `datasource/sqlite.rs` |
| Apache Doris | `sqlx` MySQL（已有）| 复用 `mysql.rs`，加 `Dialect::Doris` 分支 |
| ClickHouse | `clickhouse-rs`（新增）| 新建 `datasource/clickhouse.rs` |
| TiDB | `sqlx` MySQL（已有）| 复用 `mysql.rs`，加 `Dialect::TiDB` 分支 |

### 2.2 ConnectionConfig 扩展

```rust
pub struct ConnectionConfig {
    // 现有字段保持不变
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
    pub extra_params: Option<String>,
    // 新增字段
    pub dialect: Option<String>,      // "doris" | "tidb" | "clickhouse" | None
    pub file_path: Option<String>,    // SQLite 专用，替代 host/port/database
}
```

### 2.3 数据源工厂函数扩展

`datasource/mod.rs` 中 `create_datasource()` 新增分支：

```rust
pub async fn create_datasource(config: &ConnectionConfig) -> AppResult<Arc<dyn DataSource>> {
    match config.driver.as_str() {
        "mysql"       => MysqlDataSource::new(config).await,
        "postgres"    => PostgresDataSource::new(config).await,
        "sqlserver"   => SqlServerDataSource::new(config).await,
        "oracle"      => OracleDataSource::new(config).await,
        "sqlite"      => SqliteDataSource::new(config).await,                          // 新增
        "doris"       => MysqlDataSource::new_with_dialect(config, Dialect::Doris).await, // 新增
        "tidb"        => MysqlDataSource::new_with_dialect(config, Dialect::TiDB).await,  // 新增
        "clickhouse"  => ClickHouseDataSource::new(config).await,                      // 新增
        _             => Err(AppError::UnsupportedDriver(config.driver.clone())),
    }
}
```

### 2.4 MySQL 方言枚举

`mysql.rs` 内部新增方言标记，处理 Doris/TiDB 与标准 MySQL 的差异：

```rust
pub enum Dialect {
    MySQL,
    Doris,
    TiDB,
}
```

**Doris 差异处理**：
- `get_table_ddl()`：Doris 不支持 `SHOW CREATE TABLE`，改用 `information_schema` 手工拼接
- `list_tables_with_stats()`：`TABLE_ROWS` 不准确，改查 `information_schema.TABLES` 的 `DATA_LENGTH`
- `list_objects()` category：不返回 triggers/events/procedures

**TiDB 差异处理**：
- `list_objects()` category：不返回 triggers/procedures（返回空列表）
- `get_table_ddl()`：直接透传 `SHOW CREATE TABLE`（TiDB 兼容此语法）

### 2.5 schema/init.sql 变更

```sql
-- connections 表 driver CHECK 约束扩展
driver TEXT CHECK(driver IN (
    'mysql', 'postgres', 'oracle', 'sqlserver',
    'sqlite', 'doris', 'tidb', 'clickhouse'
))
```

### 2.6 新增文件

```
src-tauri/src/datasource/
├── sqlite.rs       # 新增：SQLite 完整实现
└── clickhouse.rs   # 新增：ClickHouse 完整实现
```

---

## 3. DataSource Trait 扩展

### 3.1 DriverCapabilities（新增）

在 `datasource/mod.rs` 新增能力声明结构体，各驱动自报支持项：

```rust
pub struct DriverCapabilities {
    pub has_schemas: bool,
    pub has_foreign_keys: bool,
    pub has_stored_procedures: bool,
    pub has_triggers: bool,
    pub has_materialized_views: bool,
    pub has_multi_database: bool,
    pub has_partitions: bool,
    pub sql_dialect: SqlDialect,
}

pub enum SqlDialect {
    Standard,    // MySQL / TiDB / SQLite / PostgreSQL
    Doris,       // Apache Doris 专有函数
    ClickHouse,  // ClickHouse 专有函数（arrayJoin、groupArray 等）
}
```

DataSource trait 新增方法（提供默认实现，已有驱动无需改动）：

```rust
fn capabilities(&self) -> DriverCapabilities {
    DriverCapabilities::default()  // 返回最保守的能力集
}
```

各新驱动实现对应的 `capabilities()`。

### 3.2 DbStats（新增）

```rust
pub struct DbStats {
    pub tables: Vec<TableStat>,
    pub db_summary: DbSummary,
}

pub struct TableStat {
    pub name: String,
    pub row_count: Option<i64>,
    pub data_size_bytes: Option<i64>,
    pub index_size_bytes: Option<i64>,
}

pub struct DbSummary {
    pub total_tables: usize,
    pub total_size_bytes: Option<i64>,
    pub db_version: Option<String>,
}
```

DataSource trait 新增方法：

```rust
async fn get_db_stats(&self) -> AppResult<DbStats>;
```

---

## 4. 各库驱动实现要点

### 4.1 SQLite（`datasource/sqlite.rs`）

- 连接：`rusqlite::Connection::open(file_path)`，包装为异步（`tokio::task::spawn_blocking`）
- 无连接池（文件锁），每次操作开新连接或持有单连接
- 元数据来源：
  - 表列表：`SELECT name FROM sqlite_master WHERE type='table'`
  - 列信息：`PRAGMA table_info(table_name)`
  - 索引：`PRAGMA index_list` + `PRAGMA index_info`
  - 外键：`PRAGMA foreign_key_list(table_name)`
  - 触发器：`SELECT name FROM sqlite_master WHERE type='trigger'`
  - DDL：`SELECT sql FROM sqlite_master WHERE name=?`
- `list_databases()`：返回空（单文件无多库）
- `get_db_stats()`：`PRAGMA page_count`、`PRAGMA page_size`，行数实时 COUNT

### 4.2 Apache Doris（`mysql.rs` + `Dialect::Doris`）

- 连接：复用 sqlx MySqlPool，port 默认 9030（FE Query Port）
- DDL：`information_schema.COLUMNS` 手工拼接，不用 `SHOW CREATE TABLE`
- 物化视图：`list_objects()` 新增 `materialized_views` category，查 `information_schema.MATERIALIZED_VIEWS`
- 统计信息：`information_schema.TABLES`（DATA_LENGTH/INDEX_LENGTH）
- 不支持：外键、触发器、存储过程

### 4.3 ClickHouse（`datasource/clickhouse.rs`）

- 驱动：`clickhouse-rs`（HTTP 接口，port 默认 8123）
- 元数据来源：
  - 数据库列表：`SHOW DATABASES`
  - 表列表：`system.tables WHERE database=?`
  - 列信息：`system.columns WHERE database=? AND table=?`
  - DDL：`SHOW CREATE TABLE db.table`
  - 字典：`system.dictionaries`
- `get_db_stats()`：`system.tables`（total_rows、total_bytes）
- 不支持：外键、schema、存储过程、触发器
- SQL 方言：`SqlDialect::ClickHouse`，AI prompt 附加 ClickHouse 函数说明

### 4.4 TiDB（`mysql.rs` + `Dialect::TiDB`）

- 连接：复用 sqlx MySqlPool，port 默认 4000
- 与 MySQL 高度兼容，差异极小：
  - 无触发器、存储过程（`list_objects()` 对应 category 返回空）
  - `SHOW CREATE TABLE` 正常支持
- 统计信息：与 MySQL 一致（`information_schema.TABLES`）
- SQL 方言：`SqlDialect::Standard`

---

## 5. DBTree 树操作

### 5.1 树层级结构

| 数据库 | 层级 |
|--------|------|
| SQLite | 连接 → 表 / 视图 / 触发器 |
| Apache Doris | 连接 → 数据库 → 表 / 视图 / 物化视图 |
| ClickHouse | 连接 → 数据库 → 表 / 视图 / 字典 |
| TiDB | 连接 → 数据库 → 表 / 视图 |

树节点渲染逻辑：前端从 `get_driver_capabilities()` 获取能力声明，动态决定显示哪些类别节点。

### 5.2 右键菜单

**连接节点（通用）**：新建查询、刷新、编辑连接、删除连接

**SQLite 连接节点（特有）**：打开文件（重新选择 .sqlite 路径）、导入 SQL 文件

**表节点差异**：

| 操作 | SQLite | Doris | ClickHouse | TiDB |
|------|--------|-------|------------|------|
| 查看数据 | ✅ | ✅ | ✅ | ✅ |
| 查看 DDL | ✅ | ✅ | ✅ | ✅ |
| 截断表 | ✅ | ✅ | ✅ | ✅ |
| 删除表 | ✅ | ✅ | ✅ | ✅ |
| 查看分区 | ❌ | ✅ | ✅ | ✅ |
| 优化表 | ❌ | ✅ | ✅ | ❌ |

不支持的操作菜单项：隐藏（不置灰），由 `DriverCapabilities` 控制。

### 5.3 连接弹窗变更

新增 4 个驱动选项及默认端口：

| 驱动 | 显示名 | 默认端口 |
|------|--------|---------|
| sqlite | SQLite | — |
| doris | Apache Doris | 9030 |
| clickhouse | ClickHouse | 8123 |
| tidb | TiDB | 4000 |

SQLite 特殊 UI：选择 `sqlite` 驱动时，隐藏 host/port/username/password 字段，改为文件路径输入框 + "浏览..."按钮（调用 Tauri `dialog::open()` 文件选择器）。

---

## 6. 兼容性矩阵（全库）

详见 [`docs/database-compatibility.md`](../database-compatibility.md)，该文档包含所有已支持及规划中数据库的完整功能兼容性矩阵，README.md 引用此文档。

---

## 7. GraphRAG 知识图谱适配

GraphRAG 依赖 `get_full_schema()` 构建实体关系图：

| 数据库 | 节点 | 边（外键）| 降级策略 |
|--------|------|----------|---------|
| SQLite | ✅ 表+列 | ✅ `PRAGMA foreign_key_list` | — |
| Apache Doris | ✅ 表+列 | ❌ | 列名相似度推断（现有逻辑）|
| ClickHouse | ✅ 表+列 | ❌ | 列名相似度推断（现有逻辑）|
| TiDB | ✅ 表+列 | ✅ `KEY_COLUMN_USAGE` | — |

无外键时 GraphRAG 自动降级为列名相似度推断，现有代码已支持，无需额外开发。

---

## 8. 性能监控图表

新增 Tauri 命令 `get_db_stats(connection_id)`，前端在 DBTree 连接节点点击后的右侧面板新增"数据库概览"Tab，展示：

- 库级饼图：各表磁盘占用分布
- 表行数 Top 10 柱状图
- 表磁盘占用 Top 10 柱状图

各库统计数据来源：

| 数据库 | 行数 | 磁盘大小 |
|--------|------|---------|
| SQLite | 实时 `SELECT COUNT(*)` | `page_count × page_size`（PRAGMA）|
| Apache Doris | `information_schema.TABLES.TABLE_ROWS` | `DATA_LENGTH + INDEX_LENGTH` |
| ClickHouse | `system.tables.total_rows` | `system.tables.total_bytes` |
| TiDB | `information_schema.TABLES.TABLE_ROWS` | `DATA_LENGTH + INDEX_LENGTH` |

---

## 9. 文档变更

### 新增文件
- `docs/database-compatibility.md`：所有数据库（含已有 MySQL/PG/Oracle/SQL Server）完整功能兼容矩阵

### README.md 变更
- "数据库支持"表格中将 ClickHouse/TiDB/Apache Doris/SQLite 从"规划中"移至"已支持"
- 新增引用链接：`> 完整功能兼容性矩阵见 [docs/database-compatibility.md](./docs/database-compatibility.md)`

---

## 10. 新增 Tauri 命令

| 命令 | 说明 |
|------|------|
| `get_driver_capabilities(connection_id)` | 返回驱动能力声明，前端用于控制菜单显隐 |
| `get_db_stats(connection_id, database?)` | 返回库级/表级统计信息，用于性能监控图表 |

所有新命令须在 `lib.rs` 的 `generate_handler![]` 中注册。

---

## 11. 实现顺序

按以下顺序独立实现，每库完成后可独立发布：

1. **SQLite**：新建 `sqlite.rs` + 连接弹窗文件模式 + 树操作
2. **Apache Doris**：`mysql.rs` 加 Dialect 分支 + 物化视图树节点
3. **ClickHouse**：新建 `clickhouse.rs` + 字典树节点 + AI 方言提示
4. **TiDB**：`mysql.rs` 加 TiDB Dialect（改动最小）

横切关注点（可在第 1 步并行完成）：
- `DriverCapabilities` trait 方法 + `get_driver_capabilities` 命令
- `DbStats` 结构体 + `get_db_stats` 命令框架
- `docs/database-compatibility.md` 文档
- README.md 更新
