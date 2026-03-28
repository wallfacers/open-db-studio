# DB2 & GaussDB 数据源扩展设计

**日期**: 2026-03-28
**状态**: 已批准
**范围**: 新增 IBM DB2 和华为 GaussDB 两个数据库驱动

## 背景

项目已支持 8 种数据库（MySQL、PostgreSQL、SQLite、SQL Server、ClickHouse、Oracle、Apache Doris、TiDB）。本次扩展新增 IBM DB2 和华为 GaussDB，采用**方案 A**：GaussDB 用专用 crate，DB2 通过 ODBC 桥接。

### Doris 评估结论

Apache Doris 前后端实现完整（约 95-98% 完成度），无需额外工作：
- 后端：复用 MySQL 协议，`Dialect::Doris` 分支处理
- 前端：连接表单、数据库树、物化视图均已支持
- AI：特殊 DDL 重构避免 OLAP 语法干扰 LLM

## GaussDB 驱动设计

### 技术选型

| 项目 | 选择 |
|------|------|
| Crate | `tokio-gaussdb`（华为官方，async/tokio 原生，纯 Rust） |
| 协议 | PostgreSQL 线协议（扩展版） |
| 默认端口 | 8000 |
| 复用程度 | 可复用 `postgres.rs` 约 70-80% 逻辑 |
| 连接模型 | 单连接 + `Arc` 共享（与 ClickHouse/Oracle 一致） |

### 为什么不用 sqlx PgPool 直连

GaussDB/openGauss 默认使用 SHA256 认证握手，标准 PostgreSQL 驱动（包括 sqlx）不支持。必须使用 `tokio-gaussdb` 专用 crate。

### 文件结构

```
src-tauri/src/datasource/gaussdb.rs   # 新增
```

### 核心结构

```rust
pub struct GaussDbDataSource {
    client: Arc<tokio_gaussdb::Client>,
    database: String,
    schema: String,         // 默认 "public"
    _conn_handle: JoinHandle<()>,  // 后台连接任务
}
```

### 构造函数

提供两个构造函数，与 PostgreSQL 驱动对齐：

```rust
impl GaussDbDataSource {
    pub async fn new(config: &ConnectionConfig) -> AppResult<Self> { ... }
    pub async fn new_with_schema(config: &ConnectionConfig, schema: &str) -> AppResult<Self> { ... }
}
```

`create_datasource_with_context` 工厂函数中 `"gaussdb"` 分支调用 `new_with_schema`，确保跨 schema 导航正常工作。

### 连接生命周期

`tokio-gaussdb` 的 `Client` 需要一个后台 `Connection` 驱动任务。`_conn_handle` 存储其 `JoinHandle`。实现 `Drop` 时调用 `self._conn_handle.abort()` 确保资源释放，或由 pool_cache 管理生命周期。

### 能力声明

```rust
DriverCapabilities {
    has_schemas: true,
    has_foreign_keys: true,
    has_stored_procedures: true,
    has_triggers: true,
    has_materialized_views: true,
    has_multi_database: true,
    has_partitions: true,
    sql_dialect: SqlDialect::Standard,
}
```

### 元数据查询策略

沿用 PostgreSQL 的 `information_schema` + `pg_catalog` 查询，对不兼容的函数做降级：

| 元数据 | 来源 | 降级处理 |
|--------|------|----------|
| 表 | `information_schema.tables` | 无需 |
| 列 | `information_schema.columns` | 无需 |
| 索引 | `pg_indexes` | 无需 |
| 外键 | `information_schema.key_column_usage` | 无需 |
| 视图 | `information_schema.views` | 无需 |
| 存储过程 | `information_schema.routines` | 无需 |
| 触发器 | `information_schema.triggers`（不用 `pg_get_triggerdef()`） | 回退到 information_schema |
| DDL | 手动拼装（GaussDB 无 `pg_get_create_table_sql`） | 从 columns/constraints 拼装 |
| 数据库列表 | `SELECT datname FROM pg_database WHERE datistemplate = false` | 与 PG 一致 |
| Schema 列表 | `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema')` | 与 PG 一致 |

### 风险与缓解

- `gaussdb-rust` 项目较新（2 stars），长期维护不确定
  - **缓解**：crate 基于成熟的 `rust-postgres` fork，API 稳定。若 crate 被弃用，可 fork 维护或切换到直接使用 `rust-postgres` + 自定义认证处理
- 部分 PG 函数不可用（`pg_get_triggerdef()`、`has_sequence_privilege()` 等）
  - **缓解**：所有元数据查询均使用 `information_schema` 兜底，不依赖 PG 特有函数
- 认证边缘情况（非标准配置）

## DB2 驱动设计

### 技术选型

| 项目 | 选择 |
|------|------|
| Crate | `odbc-api`（通用 ODBC，成熟稳定，184 stars） |
| 协议 | DRDA（通过 ODBC 桥接） |
| 默认端口 | 50000 |
| 并发模型 | `spawn_blocking()` 包装（与 SQLite/Oracle 一致） |
| 用户前置条件 | 需安装 IBM DB2 ODBC Driver |

### 为什么不用 ibm_db

`ibm_db`（27 stars）同样需要 IBM CLI Driver，且仅同步、社区活跃度低。`odbc-api` 更成熟，且 ODBC 层未来可复用给达梦、人大金仓等国产数据库。

### 文件结构

```
src-tauri/src/datasource/db2.rs   # 新增
```

### 核心结构

```rust
pub struct Db2DataSource {
    conn_str: String,                          // ODBC 连接字符串
    env: Arc<odbc_api::Environment>,           // 全局 ODBC 环境，避免重复创建
    conn: Arc<Mutex<Option<odbc_api::Connection<'static>>>>,  // 持久连接，Mutex 保护
}
```

V1 版本使用持久连接 + `Mutex`，每次操作复用同一连接。连接断开时自动重连。这避免了每次 `execute()` 都创建新 `Environment` + `Connection` 的性能问题。

### 连接字符串格式

```
Driver={IBM DB2 ODBC DRIVER};Database=mydb;Hostname=host;Port=50000;Protocol=TCPIP;Uid=user;Pwd=pass;
```

### 并发模型

```rust
async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
    let conn_str = self.conn_str.clone();
    let sql = sql.to_string();
    tokio::task::spawn_blocking(move || {
        let env = Environment::new()?;
        let conn = env.connect_with_connection_string(&conn_str)?;
        // 执行查询，转换结果
    }).await?
}
```

### 能力声明

```rust
DriverCapabilities {
    has_schemas: true,
    has_foreign_keys: true,
    has_stored_procedures: true,
    has_triggers: true,
    has_materialized_views: true,  // DB2 MQT
    has_multi_database: true,
    has_partitions: true,
    sql_dialect: SqlDialect::Standard,
}
```

### 元数据查询策略

DB2 使用 `SYSCAT` 系统视图：

| 元数据 | DB2 查询 |
|--------|----------|
| 表 | `SYSCAT.TABLES` |
| 列 | `SYSCAT.COLUMNS` |
| 索引 | `SYSCAT.INDEXES` |
| 外键 | `SYSCAT.REFERENCES` |
| 视图 | `SYSCAT.VIEWS` |
| 存储过程 | `SYSCAT.PROCEDURES` |
| DDL | 手动拼装（DB2 无 `SHOW CREATE TABLE`） |
| 物化视图 | `SYSCAT.TABLES WHERE TYPE = 'S'`（MQT） |
| 数据库列表 | `LIST DATABASE DIRECTORY` 或 `SYSCAT.SCHEMATA`（DB2 的 database 概念较弱，以 schema 为主） |
| Schema 列表 | `SELECT SCHEMANAME FROM SYSCAT.SCHEMATA WHERE OWNERTYPE = 'U'` |

### 用户体验

- 连接表单下方显示提示："需要安装 IBM DB2 ODBC Driver"
- 连接测试失败时给出友好的驱动缺失错误信息
- 文档中说明安装步骤

### 平台支持

DB2 ODBC CLI Driver 可用性因平台而异：
- **Windows (x86_64)**: 完整支持
- **Linux (x86_64)**: 完整支持
- **macOS (Apple Silicon)**: IBM 自 DB2 v11.5.8+ 起不再提供 ARM 版本，**不支持**

前端应根据平台检测，在 macOS ARM 上显示"当前平台不支持 DB2"提示。

### 系统依赖

`odbc-api` 依赖 ODBC Driver Manager：
- **Windows**: 内置，无需额外安装
- **Linux**: 需安装 `unixODBC`（`apt install unixodbc-dev` 或 `yum install unixODBC-devel`）
- **macOS**: `brew install unixodbc`

### 风险

- 用户需自行安装 IBM ODBC 驱动（~200MB）+ 平台 ODBC Driver Manager
- DDL 拼装逻辑较复杂，初版先支持基础表结构
- macOS Apple Silicon 不支持

## 公共变更

### 工厂函数（`datasource/mod.rs`）

三个工厂函数各增加两个分支：
- `create_datasource`: `"gaussdb"` → `GaussDbDataSource::new(config)`，`"db2"` → `Db2DataSource::new(config)`
- `create_datasource_with_db`: 同上，覆盖 database 字段
- `create_datasource_with_context`: `"gaussdb"` → `GaussDbDataSource::new_with_schema(config, schema)`，`"db2"` → `Db2DataSource::new(config)`（DB2 以 schema 为主，在连接字符串中指定）

### 连接池缓存（`pool_cache.rs`）

同步增加 `gaussdb` 和 `db2` 分支。

### Schema（`schema/init.sql`）

CHECK 约束新增 `'gaussdb'` 和 `'db2'`。

**迁移策略**：SQLite 的 `CREATE TABLE IF NOT EXISTS` 只在首次创建时生效，已有安装的 CHECK 约束不会自动更新。但 SQLite 默认不强制 CHECK 约束对新插入的数据做严格校验（除非显式开启），且项目通过应用层验证 driver 值。因此无需专门的 ALTER TABLE 迁移 — 在 `init.sql` 中更新约束定义即可，新安装会使用新约束，已有安装通过应用层保证数据一致性。

### 前端连接表单（`ConnectionModal`）

DRIVERS 数组新增：
- `{ value: 'gaussdb', label: 'GaussDB', defaultPort: 8000 }`
- `{ value: 'db2', label: 'IBM DB2', defaultPort: 50000 }`

### 数据库树（`treeStore.ts`）

```typescript
gaussdb: ['tables', 'views', 'functions', 'procedures', 'triggers', 'sequences', 'materialized_views'],
db2:     ['tables', 'views', 'functions', 'procedures', 'triggers', 'materialized_views'],
```

### Cargo.toml 依赖

```toml
tokio-gaussdb = "0.7"    # 实现前需在 crates.io 确认实际可用版本
odbc-api = "23"           # 实现前需确认最新稳定版本
```

> **注意**：`tokio-gaussdb` 版本号需在实现前到 crates.io 核实。若该版本不存在，使用实际最新版本。

## 不做的事

- 不新增 `SqlDialect` 变体 — GaussDB/DB2 都用 `Standard`（AI prompt 管线中已通过 driver 名称区分方言，`SqlDialect` 仅影响前端 UI 适配，两者与标准 SQL 差异不大）
- 不为 DB2 实现连接池 — 单连接 `spawn_blocking` 模式
- 不内嵌 IBM ODBC 驱动 — 用户自行安装
- 不做 GaussDB 降级到 sqlx PG 的兼容模式 — 统一用 `tokio-gaussdb`

## 实现优先级

| 顺序 | 任务 | 原因 |
|------|------|------|
| 1 | GaussDB | 难度低，纯 Rust，可快速交付 |
| 2 | DB2 | 难度高，依赖外部驱动，需充分测试 |
