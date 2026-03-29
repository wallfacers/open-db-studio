# 多数据源架构设计

## DataSource Trait

见 `src-tauri/src/datasource/mod.rs`（权威来源）。

### 核心接口（必须实现）

| 方法 | 返回类型 | 说明 |
|------|----------|------|
| `test_connection()` | `AppResult<()>` | 测试连接是否可用 |
| `execute(sql)` | `AppResult<QueryResult>` | 执行 SQL，返回列/行/耗时 |
| `get_tables()` | `AppResult<Vec<TableMeta>>` | 获取表列表 |
| `get_schema()` | `AppResult<SchemaInfo>` | 获取 Schema 概要 |

### 扩展接口（有默认空实现）

| 方法 | 说明 |
|------|------|
| `get_columns(table, schema)` | 列元数据（名称、类型、是否可空、默认值、主键、注释） |
| `get_indexes(table, schema)` | 索引元数据（名称、唯一性、包含列） |
| `get_foreign_keys(table, schema)` | 外键元数据（约束名、列、引用表/列、ON DELETE） |
| `get_views()` | 视图列表（名称 + 定义） |
| `get_procedures()` | 存储过程/函数列表 |
| `get_table_ddl(table)` | 建表 DDL 语句 |
| `get_table_ddl_for_display(table, schema)` | 用于展示的 DDL（部分驱动使用不同策略） |
| `list_databases()` | 列出数据库 |
| `list_schemas(database)` | 列出 Schema |
| `list_objects(database, schema, category)` | 按类别列出对象（表/视图/函数/过程/触发器等） |
| `list_tables_with_stats(database, schema)` | 带行数和大小统计的表列表 |
| `capabilities()` | `DriverCapabilities` 描述驱动能力 |
| `get_db_stats(database)` | 数据库统计摘要 |
| `get_full_schema()` | 完整 Schema（列+索引+外键+视图+过程） |

### 关键数据结构

```
ConnectionConfig    — driver, host, port, database, username, password, extra_params,
                      file_path, auth_type, token, ssl_mode/ca/cert/key, timeouts, pool 设置
DriverCapabilities  — has_schemas, has_foreign_keys, has_stored_procedures, has_triggers,
                      has_materialized_views, has_multi_database, has_partitions,
                      sql_dialect, supported_auth_types, has_pool_config, has_timeout_config, has_ssl_config
QueryResult         — columns, rows (Vec<Vec<Value>>), row_count, duration_ms
FullSchemaInfo      — tables (Vec<TableDetail>), views, procedures
```

### 工厂函数

- `create_datasource(config)` — 根据 driver 字符串创建实例；`"doris"` 和 `"tidb"` 路由到 MySqlDataSource（不同 Dialect）
- `create_datasource_with_db(config, database)` — 克隆配置并覆盖 database
- `create_datasource_with_context(config, database, schema)` — 同时设置 database 和 schema（PG/GaussDB 需要）

## 支持状态

### 完整驱动列表

| 数据源 | 状态 | Rust crate | 连接池 | 功能覆盖 |
|--------|------|------------|--------|----------|
| MySQL | 完整实现 | sqlx 0.8 (mysql) | `MySqlPoolOptions`（可配置） | 全部方法 + Dialect 枚举 |
| PostgreSQL | 完整实现 | sqlx 0.8 (postgres) | `PgPoolOptions`（可配置） | 全部方法 + 25+ 类型映射 |
| SQLite | 完整实现 | rusqlite 0.32 (bundled) | `Arc<Mutex<Connection>>` | 全部方法（无过程） |
| ClickHouse | 完整实现 | clickhouse 0.12 + reqwest | 单 Client 实例 | 全部方法（无外键/过程） |
| SQL Server | 完整实现 | tiberius 0.12 (tds73) | 每次新建 TCP 连接 | 大部分方法（无 schema 层级） |
| GaussDB | 完整实现 | tokio-gaussdb 0.1 | 单 `Arc<Client>` + spawn | 全部方法（类 PG 查询） |
| Oracle | 最小实现 | oracle 0.6 (可选 feature) | 每次新建连接 | 仅 test/execute/get_tables/get_schema |
| DB2 | 完整实现 | odbc-api 0.23 (可选 feature) | 单连接 + 自动重连 | 全部方法 |

### 路由别名

| 别名 | 实际驱动 | 说明 |
|------|----------|------|
| `doris` | MySqlDataSource | Dialect::Doris，禁用存储过程/触发器，DDL 从 information_schema 组装 |
| `tidb` | MySqlDataSource | Dialect::TiDB，禁用事件/物化视图 |

### 功能覆盖矩阵

| 功能 | MySQL | PG | SQLite | ClickHouse | SQL Server | GaussDB | Oracle | DB2 |
|------|-------|----|--------|------------|------------|---------|--------|-----|
| test_connection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| execute | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| get_columns | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| get_indexes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| get_foreign_keys | ✅ | ✅ | ✅ | — | ✅ | ✅ | — | ✅ |
| get_views | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| get_procedures | ✅ | ✅ | — | — | ✅ | ✅ | — | ✅ |
| get_table_ddl | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| list_databases | ✅ | ✅ | — | ✅ | ✅ | ✅ | — | ✅ |
| list_schemas | — | ✅ | — | — | — | ✅ | — | ✅ |
| list_objects | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | ✅ |
| list_tables_with_stats | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| get_db_stats | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| SSL/TLS | ✅ | ✅ | — | ✅ | ✅ | ✅ | — | — |
| Windows 集成认证 | — | — | — | — | ✅ | — | — | — |

### DriverCapabilities 差异

| 能力 | MySQL | PG | SQLite | ClickHouse | SQL Server | GaussDB | Oracle | DB2 |
|------|-------|----|--------|------------|------------|---------|--------|-----|
| has_schemas | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ |
| has_multi_database | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ |
| has_stored_procedures | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ |
| has_triggers | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ |
| has_materialized_views | Doris✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ |
| has_partitions | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |

## 连接池策略

### 全局池缓存层

见 `src-tauri/src/datasource/pool_cache.rs`。

- 全局 `HashMap<(i64, String, String), Arc<dyn DataSource>>` 按 (connection_id, database, schema) 缓存
- 首次访问懒创建，后续复用
- SQLite 排除在缓存外（每次新建实例）
- `invalidate(connection_id)` 在删除/更新连接时清除
- `close_all()` 在应用退出时清除

### 各驱动池策略

| 驱动 | 策略 | 可配置参数 |
|------|------|-----------|
| MySQL / PG | sqlx 异步连接池 | `max_connections`(默认 5)、`idle_timeout`(默认 300s)、`acquire_timeout`(默认 30s) |
| SQLite | 单连接 + Mutex + spawn_blocking | — |
| ClickHouse | 单 Client 实例 | — |
| SQL Server | 每次新建 TCP 连接 | — |
| GaussDB | 单 Client + spawn task | — |
| Oracle | 每次新建连接 (spawn_blocking) | — |
| DB2 | 单连接 Mutex + 自动重连 (SQLSTATE 08xxx) | — |

## 可选驱动编译

Oracle 和 DB2 为可选功能，通过 Cargo feature gate 控制：

```toml
# Cargo.toml
[features]
oracle-driver = ["oracle"]   # 仅 Windows，需要 Oracle Instant Client
db2-driver = ["odbc-api"]    # 需要 IBM DB2 ODBC DRIVER 已安装
```

未启用 feature 时，对应驱动的所有方法返回错误信息（如 "Oracle driver not enabled"）。

## Tauri 命令注册

数据源相关命令均在 `src-tauri/src/commands.rs` 注册，主要分组：

- **连接管理**: list/create/test/delete/update_connection, get_connection_password/token
- **查询执行**: execute_query, get_table_detail, get_table_data, update/delete/insert_row
- **导航树**: list_databases/schemas/objects, list_tables_with_stats/with_column_count
- **Schema & DDL**: get_tables/schema/full_schema, get_table_ddl
- **能力 & 统计**: get_driver_capabilities, get_db_stats/version
- **数据库管理**: create/drop_database
- **导入导出**: export_table_data/tables, preview_import_file, import_to_table, backup_database
