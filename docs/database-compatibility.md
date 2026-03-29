# 数据库功能兼容性矩阵 / Database Compatibility Matrix

**最后更新**：2026-03-29
**参考规格**：[docs/superpowers/specs/2026-03-23-multi-datasource-extension-design.md](./superpowers/specs/2026-03-23-multi-datasource-extension-design.md)

本文档列出 open-db-studio 所有已支持数据库在各功能维度的兼容情况。

图例：
- ✅ 完整支持
- ❌ 不支持
- ⚠️ 部分支持（见说明）

---

## 功能兼容性矩阵

| 功能维度 | MySQL | PostgreSQL | Oracle | SQL Server | SQLite | Apache Doris | ClickHouse | TiDB | GaussDB | DB2 |
|----------|:-----:|:----------:|:------:|:----------:|:------:|:------------:|:----------:|:----:|:-------:|:---:|
| **基础连接（test_connection/execute）** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **查看表列表** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **查看列信息** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **查看索引** | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | ✅ |
| **外键支持** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ |
| **视图支持** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **存储过程/函数** | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **触发器** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **物化视图** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| **字典（ClickHouse 特有）** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **多数据库切换** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Schema 层级** | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **分区查看** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **表 DDL 查看** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **数据库统计信息** | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **AI SQL 生成（SQL 方言）** | ✅ Standard | ✅ Standard | ✅ Standard | ✅ Standard | ✅ Standard | ✅ Doris | ✅ ClickHouse | ✅ Standard | ✅ Standard | ✅ Standard |

---

## 各功能说明

### 基础连接（test_connection/execute）

所有数据库均支持基础连接测试与 SQL 执行。

- **SQLite**：基于本地文件，通过 `rusqlite` 驱动，使用 `Arc<Mutex<Connection>>` + `spawn_blocking` 并发模型，连接时自动开启 WAL 模式。
- **Apache Doris**：复用 MySQL（sqlx）驱动，默认端口 9030（FE Query Port）。
- **ClickHouse**：使用官方 `clickhouse` crate（HTTP 接口），默认端口 8123。
- **TiDB**：复用 MySQL（sqlx）驱动，默认端口 4000。
- **GaussDB**：使用 `tokio-gaussdb` crate（SHA256 认证，rust-postgres 分支），查询接口与 PostgreSQL 高度一致，默认端口 8000。
- **DB2**：使用 `odbc-api` crate（需安装 IBM DB2 ODBC DRIVER），通过 ODBC 连接字符串连接，默认端口 50000。可选 feature gate `db2-driver`。

---

### 查看表列表

所有数据库均支持，元数据来源各异：

| 数据库 | 元数据来源 |
|--------|-----------|
| MySQL / Doris / TiDB | `information_schema.TABLES` |
| PostgreSQL | `information_schema.TABLES` / `pg_tables` |
| Oracle | `ALL_TABLES` |
| SQL Server | `INFORMATION_SCHEMA.TABLES` |
| SQLite | `SELECT name FROM sqlite_master WHERE type='table'` |
| ClickHouse | `SELECT name, engine FROM system.tables WHERE database=?` |
| GaussDB | `pg_tables`（与 PostgreSQL 一致） |
| DB2 | `SYSCAT.TABLES` |

---

### 查看列信息

所有数据库均支持，元数据来源各异：

| 数据库 | 元数据来源 |
|--------|-----------|
| MySQL / Doris / TiDB | `information_schema.COLUMNS` |
| PostgreSQL | `information_schema.COLUMNS` |
| Oracle | `ALL_TAB_COLUMNS` |
| SQL Server | `INFORMATION_SCHEMA.COLUMNS` |
| SQLite | `PRAGMA table_info(table_name)` |
| ClickHouse | `SELECT name, type, is_in_primary_key FROM system.columns WHERE database=? AND table=?` |
| GaussDB | `information_schema.COLUMNS`（与 PostgreSQL 一致） |
| DB2 | `SYSCAT.COLUMNS` |

---

### 查看索引

| 数据库 | 说明 |
|--------|------|
| MySQL / PostgreSQL / Oracle / SQL Server / TiDB / GaussDB / DB2 | ✅ 完整支持，可查看索引名称、类型、列信息 |
| SQLite | ✅ 通过 `PRAGMA index_list(table_name)` + `PRAGMA index_info(index_name)` 实现 |
| Apache Doris | ⚠️ Doris 为 OLAP 引擎，使用 Bitmap/Bloom Filter 等特殊索引，索引信息通过 `SHOW INDEX` 返回，但语义与 OLTP 数据库不同 |
| ClickHouse | ⚠️ 通过 `system.tables` 中 `sorting_key` / `primary_key` 字段获取主键/排序键信息，不支持传统意义的二级索引 |

---

### 外键支持

| 数据库 | 说明 |
|--------|------|
| MySQL / PostgreSQL / Oracle / SQL Server / TiDB / GaussDB / DB2 | ✅ 完整支持，GraphRAG 可通过外键自动推断 JOIN 路径 |
| SQLite | ✅ 通过 `PRAGMA foreign_key_list(table_name)` 获取，GraphRAG 可用 |
| Apache Doris | ❌ OLAP 引擎不支持外键约束，GraphRAG 降级为列名相似度推断 |
| ClickHouse | ❌ 不支持外键约束，GraphRAG 降级为列名相似度推断 |

---

### 视图支持

所有数据库均支持视图的列举与查询。DBTree 中视图节点在所有库中均会渲染。

---

### 存储过程/函数

| 数据库 | 说明 |
|--------|------|
| MySQL / PostgreSQL / Oracle / SQL Server / GaussDB / DB2 | ✅ 完整支持，可在 DBTree 中查看、DBTree 右键菜单可执行 |
| SQLite | ❌ 不支持存储过程/函数（SQLite 无服务端编程能力） |
| Apache Doris | ❌ 不支持，`list_objects()` 对应 category 返回空列表 |
| ClickHouse | ❌ 不支持传统存储过程 |
| TiDB | ❌ 不支持存储过程，`list_objects()` 对应 category 返回空列表 |

---

### 触发器

| 数据库 | 说明 |
|--------|------|
| MySQL / PostgreSQL / Oracle / SQL Server / GaussDB / DB2 | ✅ 完整支持 |
| SQLite | ✅ 通过 `SELECT name FROM sqlite_master WHERE type='trigger'` 获取，DBTree 中显示触发器节点 |
| Apache Doris | ❌ OLAP 引擎不支持触发器，`list_objects()` 对应 category 返回空列表 |
| ClickHouse | ❌ 不支持触发器 |
| TiDB | ❌ 不支持触发器，`list_objects()` 对应 category 返回空列表 |

---

### 物化视图

| 数据库 | 说明 |
|--------|------|
| Apache Doris | ✅ DBTree 新增 `materialized_views` category，数据来自 `information_schema.MATERIALIZED_VIEWS` |
| GaussDB | ✅ 通过 `pg_matviews` 系统视图获取，DBTree 中显示物化视图节点 |
| DB2 | ✅ 通过 `SYSCAT.VIEWS WHERE VIEWTYPE='M'` 获取，DBTree 中显示物化视图节点 |
| 其他所有数据库 | ❌ 不支持此概念（PostgreSQL 虽有物化视图，但本期未实现此功能节点） |

---

### 字典（ClickHouse 特有）

| 数据库 | 说明 |
|--------|------|
| ClickHouse | ✅ DBTree 中显示字典节点，数据来自 `SELECT name FROM system.dictionaries WHERE database=?` |
| 其他所有数据库 | ❌ 无此概念 |

---

### 多数据库切换

| 数据库 | 说明 |
|--------|------|
| MySQL / PostgreSQL / Oracle / SQL Server / Apache Doris / ClickHouse / TiDB / GaussDB / DB2 | ✅ 支持在同一连接下切换数据库，DBTree 展示数据库列表 |
| SQLite | ❌ 单文件无多库概念，`list_databases()` 返回空 Vec，DBTree 层级为：连接 → 表/视图/触发器 |

---

### Schema 层级

| 数据库 | 说明 |
|--------|------|
| PostgreSQL | ✅ 支持 Schema 层级（`public` / 自定义 Schema），DBTree 层级：连接 → 数据库 → Schema → 表 |
| GaussDB | ✅ 与 PostgreSQL 一致，支持 Schema 层级（`public` / 自定义 Schema），DBTree 层级：连接 → 数据库 → Schema → 表 |
| Oracle | ✅ 使用用户名作为 Schema，DBTree 层级：连接 → Schema → 表 |
| SQL Server | ✅ 支持 Schema（`dbo` 等），DBTree 层级：连接 → 数据库 → Schema → 表 |
| DB2 | ✅ 支持 Schema 层级（默认为用户名大写），DBTree 层级：连接 → 数据库 → Schema → 表 |
| MySQL / Apache Doris / ClickHouse / TiDB | ❌ 无 Schema 层级（数据库即最细层级），DBTree 层级：连接 → 数据库 → 表 |
| SQLite | ❌ 无 Schema 层级，DBTree 层级：连接 → 表 |

---

### 分区查看

| 数据库 | 说明 |
|--------|------|
| MySQL / PostgreSQL / Oracle / SQL Server / TiDB / Apache Doris / ClickHouse | ✅ 支持在表节点右键菜单中查看分区信息 |
| GaussDB / DB2 | ❌ 未实现分区查看（capabilities.has_partitions = false） |
| SQLite | ❌ 不支持分区，右键菜单中无"查看分区"选项 |

参见规格文档 §5.2 右键菜单表格（查看分区列）。

---

### 表 DDL 查看

所有数据库均支持，前端"查看 DDL"操作直接透传原始结果：

| 数据库 | DDL 来源 | 说明 |
|--------|---------|------|
| MySQL / TiDB | `SHOW CREATE TABLE` | 直接透传 |
| SQL Server | 基于 `INFORMATION_SCHEMA.COLUMNS` 手工拼接 | SQL Server 无 `SHOW CREATE TABLE`，手工构造 `CREATE TABLE [schema].[table]` |
| PostgreSQL | 基于 `information_schema.columns` 手工拼接 | 直接透传列定义 |
| GaussDB | 基于 `information_schema.columns` 手工拼接 | 与 PostgreSQL 策略一致 |
| Oracle | `DBMS_METADATA.GET_DDL` | 直接透传 |
| SQLite | `SELECT sql FROM sqlite_master WHERE name=?` | 直接透传 |
| Apache Doris | `SHOW CREATE TABLE`（含 `ENGINE=OLAP`、`DISTRIBUTED BY` 等 Doris 专有子句） | 前端展示直接透传；AI 上下文注入时改用 `information_schema.COLUMNS` 手工拼接标准 DDL，避免 Doris 专有子句干扰 SQL 生成 |
| ClickHouse | `SHOW CREATE TABLE db.table` | 直接透传 |
| DB2 | 基于 `SYSCAT.COLUMNS` 手工拼接 | DB2 无 `SHOW CREATE TABLE`，手工构造 DDL |

---

### 数据库统计信息

| 数据库 | 行数来源 | 磁盘大小来源 | 说明 |
|--------|---------|------------|------|
| MySQL / TiDB | `information_schema.TABLES.TABLE_ROWS` | `DATA_LENGTH + INDEX_LENGTH` | ✅ |
| PostgreSQL | `pg_stat_user_tables.n_live_tup` | `pg_total_relation_size()` | ✅ |
| GaussDB | `pg_stat_user_tables.n_live_tup` | `pg_total_relation_size()` | ✅ 与 PostgreSQL 一致 |
| Oracle | `ALL_TABLES.NUM_ROWS` | `DBA_SEGMENTS` | ✅ |
| SQL Server | `sys.dm_db_partition_stats` | `sys.allocation_units` | ✅ |
| DB2 | `SYSCAT.TABLES.CARD`（RUNSTATS 后可用） | 基于表空间页计算 | ✅ 注：需执行 `RUNSTATS` 后 CARD 才有值 |
| Apache Doris | `information_schema.TABLES.TABLE_ROWS` | `DATA_LENGTH + INDEX_LENGTH` | ✅ 注：`TABLE_ROWS` 在 Doris 中不精确，改用 `DATA_LENGTH` 字段 |
| ClickHouse | `system.tables.total_rows` | `system.tables.total_bytes` | ✅ |
| SQLite | ⚠️ 优先读 `sqlite_stat1`（`ANALYZE` 后可用）；fallback: `SELECT COUNT(*)`，单次最多 20 张表，超出返回 `None` | `page_count × page_size`（PRAGMA）| ⚠️ 行数为估算值，精度取决于是否执行过 `ANALYZE` |

---

### AI SQL 生成（SQL 方言）

| 数据库 | 方言标识 | AI Prompt 注入内容 |
|--------|---------|------------------|
| MySQL | `SqlDialect::Standard` | 标准 SQL + MySQL 方言提示 |
| PostgreSQL | `SqlDialect::Standard` | 标准 SQL + PostgreSQL 方言提示 |
| GaussDB | `SqlDialect::Standard` | 标准 SQL + GaussDB 方言提示（与 PostgreSQL 高度兼容） |
| Oracle | `SqlDialect::Standard` | 标准 SQL + Oracle 方言提示 |
| SQL Server | `SqlDialect::Standard` | 标准 SQL + T-SQL 方言提示 |
| DB2 | `SqlDialect::Standard` | 标准 SQL + DB2 方言提示 |
| SQLite | `SqlDialect::Standard` | 标准 SQL |
| Apache Doris | `SqlDialect::Doris` | 标准 SQL + Doris 专有函数/语法说明 |
| ClickHouse | `SqlDialect::ClickHouse` | 标准 SQL + ClickHouse 专有函数说明（`arrayJoin`、`groupArray`、`countIf`、`sumIf` 等） |
| TiDB | `SqlDialect::Standard` | 标准 SQL + MySQL 兼容方言提示 |

方言能力声明通过 `DriverCapabilities.sql_dialect` 字段暴露给前端，AI prompt 构建时自动注入对应方言说明。

---

## DBTree 层级结构汇总

| 数据库 | DBTree 层级结构 |
|--------|---------------|
| MySQL | 连接 → 数据库 → 表 / 视图 / 存储过程 / 函数 / 触发器 / 事件 |
| PostgreSQL | 连接 → 数据库 → Schema → 表 / 视图 / 存储过程 / 函数 / 触发器 |
| GaussDB | 连接 → 数据库 → Schema → 表 / 视图 / 物化视图 / 函数 / 存储过程 / 触发器 / 序列 |
| Oracle | 连接 → Schema → 表 / 视图 / 存储过程 / 函数 / 触发器 |
| SQL Server | 连接 → 数据库 → Schema → 表 / 视图 / 存储过程 / 函数 / 触发器 |
| DB2 | 连接 → 数据库 → Schema → 表 / 视图 / 物化视图 / 函数 / 存储过程 / 触发器 |
| SQLite | 连接 → 表 / 视图 / 触发器 |
| Apache Doris | 连接 → 数据库 → 表 / 视图 / 物化视图 |
| ClickHouse | 连接 → 数据库 → 表 / 视图 / 字典 |
| TiDB | 连接 → 数据库 → 表 / 视图 |

---

## 连接配置参数汇总

| 数据库 | 默认端口 | 特殊参数 |
|--------|---------|---------|
| MySQL | 3306 | — |
| PostgreSQL | 5432 | — |
| GaussDB | 8000 | SHA256 认证，与 PostgreSQL 协议兼容 |
| Oracle | 1521 | 需 Oracle Instant Client（可选 feature gate `oracle-driver`，仅 Windows） |
| SQL Server | 1433 | 支持 Windows 身份验证 |
| DB2 | 50000 | 需安装 IBM DB2 ODBC DRIVER（可选 feature gate `db2-driver`） |
| SQLite | — | `file_path`（本地 `.sqlite` 文件路径，通过文件选择器选取） |
| Apache Doris | 9030 | FE Query Port |
| ClickHouse | 8123 | HTTP 接口 |
| TiDB | 4000 | — |

---

## 相关文档

- [多数据源扩展设计规格](./superpowers/specs/2026-03-23-multi-datasource-extension-design.md)
- [多数据源架构设计](./design-docs/datasource-arch.md)
- [ARCHITECTURE.md](../ARCHITECTURE.md)
