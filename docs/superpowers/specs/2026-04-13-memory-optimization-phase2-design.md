# 内存优化 Phase 2：Bulk Path 优先 + 参数化查询 Fallback

## 问题根因

Migration pipeline 在宽表（多 TEXT 列）场景下内存爆炸（20GB+），根因是 SQL 字符串构造：

```
数据在内存中的 4 次转移：
Reader 从 DB 读取
    ↓ ① migration_read_sql: Vec<MigrationRow>  ~1GB
    ↓ ② 发送通过 channel: 消息被 send() move
Writer 接收
    ↓ ③ native_buf.extend(): 数据移入 writer buf
    ↓ ④ build_native_chunk_sql(): 构造完整 SQL 字符串  ← 内存爆炸点！
    ↓    TEXT 列转义放大 3-5× (单引号变 \'，反斜杠变 \\)
    ↓ ⑤ sqlx::query(&sql).execute()
```

DataX 只需 4GB 的关键区别：

| 对比项 | DataX | 我们的 pipeline |
|--------|-------|-----------------|
| 写方式 | JDBC 参数化查询 (?) | 构造完整 SQL 字符串 |
| 内存放大 | 1× | 3-5× (TEXT 转义) |
| 批次大小 | 512 行 | 1024 行 |
| 事务 | 自动提交 | 3 批/COMMIT |

## 设计目标

将内存峰值从 20GB+ 降低到 ~4GB，与 DataX 相当。

## 方案：Bulk Path 优先 + 参数化查询 Fallback

### 整体架构

```
                    ┌─────────────────────────────────┐
                    │     bulk_write_native()         │
                    │  (入口，接收 MigrationRow[])     │
                    └─────────────┬───────────────────┘
                                  │
                    ┌─────────────▼───────────────────┐
                    │   WriteStrategy Router          │
                    │  (根据 dst_driver 选择策略)      │
                    └─────────────┬───────────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
          ▼                       ▼                       ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ MySQL Bulk      │   │ PostgreSQL Bulk │   │ PreparedStatement│
│ LOAD DATA TSV   │   │ COPY FROM CSV   │   │ (Oracle/SQLite/  │
│ (已有，强制启用) │   │ (已有，强制启用) │   │  SQL Server)    │
│                 │   │                 │   │ 需新增           │
└─────────────────┘   └─────────────────┘   └─────────────────┘
```

## 现有代码分析

### DataSource trait 接口

```rust
// datasource/mod.rs
trait DataSource {
    // 批量写入 (serde_json::Value 行)
    async fn bulk_write(...) -> AppResult<usize>;
    
    // 批量写入 (MigrationRow 行 - migration 专用)
    async fn bulk_write_native(...) -> AppResult<usize>;
}
```

**默认实现**：构造完整 SQL 字符串（内存爆炸根因）

### MySQL 已有 bulk 实现

```rust
// mysql.rs
struct MySqlDataSource {
    load_data_disabled: AtomicBool,  // 标记 LOAD DATA 是否被禁用
    mig_async_pool: OnceCell<Pool>,   // mysql_async 专用池 (LOAD DATA)
}
```

- `bulk_write_native()` 尝试 LOAD DATA LOCAL INFILE (TSV)
- 如果 `load_data_disabled=true`，fallback 到 SQL 字符串
- **问题**：fallback 使用 `build_native_chunk_sql()` 构造完整 INSERT SQL

### PostgreSQL 已有 bulk 实现

```rust
// postgres.rs
struct PostgresDataSource {
    copy_disabled: AtomicBool,  // 标记 COPY 是否被禁用
}
```

- `bulk_write_native()` 尝试 COPY FROM STDIN CSV
- 如果 `copy_disabled=true`，fallback 到 SQL 字符串
- **问题**：fallback 使用 `build_native_chunk_sql()` 构造完整 INSERT SQL

## 方案：移除 SQL 字符串 fallback，改为参数化插入

### MySQL 系修改 (mysql.rs)

**当前 fallback 路径**：
```
load_data_disabled=true → build_native_chunk_sql() → 内存爆炸
```

**修改后 fallback 路径**：
```
load_data_disabled=true → bulk_write_parametrized() → 无内存放大
```

**实现**：当 LOAD DATA 禁用时，使用单行参数化 INSERT（sqlx::query 绑定参数）

### PostgreSQL 系修改 (postgres.rs)

**当前 fallback 路径**：
```
copy_disabled=true → build_native_chunk_sql() → 内存爆炸
```

**修改后 fallback 路径**：
```
copy_disabled=true → bulk_write_parametrized() → 无内存放大
```

**实现**：当 COPY 禁用时，使用单行参数化 INSERT（sqlx::query 绑定参数，$1 $2 占位符）

### Oracle/SQL Server/SQLite 新增实现

这三个数据库目前没有 bulk 协议，直接使用 SQL 字符串构造。

**修改方案**：
1. **SQLite**：新增单行参数化 INSERT (`?` 占位符)
2. **Oracle**：新增单行参数化 INSERT (`:1 :2` 占位符) — sqlx-oracle 支持有限，需验证
3. **SQL Server**：新增单行参数化 INSERT (`@p1 @p2` 占位符) — sqlx-mssql 支持有限，需验证

**Fallback**：如果参数化插入失败，保留原有 SQL 字符串方式（仅用于不支持参数化的极端情况）

### MigrationValue 参数绑定

对于不支持 bulk 的数据库，采用**单行参数化插入**（避免动态列数问题）：

```rust
// 单行参数化插入 (每行单独 execute)
async fn bulk_write_parametrized_single(
    conn: &mut sqlx::AnyConnection,
    table: &str,
    columns: &[String],
    row: &MigrationRow,
    driver: &str,
) -> Result<(), AppError> {
    // 构造单行参数化 SQL
    let placeholders = match driver {
        "postgres" | "gaussdb" => columns.iter().enumerate()
            .map(|(i, _)| format!("${}", i + 1))
            .collect::<Vec<_>>()
            .join(", "),
        "mysql" | "sqlite" | "doris" | "tidb" => 
            columns.iter().map(|_| "?").collect::<Vec<_>>().join(", "),
        _ => columns.iter().map(|_| "?").collect::<Vec<_>>().join(", "),
    };
    
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quote_identifier(table, driver),
        columns.iter().map(|c| quote_identifier(c, driver)).collect::<Vec<_>>().join(", "),
        placeholders
    );
    
    // 使用 sqlx::query 动态绑定参数
    let mut query = sqlx::query(&sql);
    for val in &row.values {
        query = bind_migration_value(query, val);
    }
    query.execute(conn).await?;
    Ok(())
}

/// 将 MigrationValue 绑定到 sqlx query
fn bind_migration_value(query: sqlx::Query<'_, sqlx::Any, sqlx::AnyArguments>, val: &MigrationValue) -> sqlx::Query<'_, sqlx::Any, sqlx::AnyArguments> {
    match val {
        MigrationValue::Null => query.bind(None::<String>),
        MigrationValue::Bool(b) => query.bind(*b),
        MigrationValue::Int(i) => query.bind(*i),
        MigrationValue::UInt(u) => query.bind(*u as i64), // sqlx Any 不支持 u64
        MigrationValue::Float(f) => query.bind(*f),
        MigrationValue::Decimal(d) => query.bind(d.clone()),
        MigrationValue::Text(s) => query.bind(s.clone()),
        MigrationValue::Blob(b) => query.bind(b.clone()),
    }
}
```

**性能优化**：使用 `sqlx::AnyConnection` 的 prepared statement cache，避免每行重新 parse SQL。

## 性能影响分析

### Bulk 协议 (MySQL LOAD DATA, PostgreSQL COPY)

- **内存**：~1× 数据大小（无转义放大）
- **性能**：最优（原生批量协议，单次网络传输）
- **适用场景**：几乎所有 MySQL/PostgreSQL 环境

### 参数化插入 (Fallback)

- **内存**：~1× 数据大小（值直接绑定，无字符串构造）
- **性能**：比 SQL 字符串略慢（单行 execute，但有 prepared statement cache）
- **预估吞吐下降**：~10-20%（相比 bulk）
- **适用场景**：
  - MySQL：LOAD DATA 禁用（`local_infile=0`）
  - PostgreSQL：COPY 禁用（极少见）
  - SQLite/Oracle/SQL Server：默认使用参数化

### SQL 字符串构造 (已废弃)

- **内存**：3-5× 数据大小（TEXT 转义放大）
- **性能**：中等（单次 execute，但 SQL parse 成本高）
- **适用场景**：仅保留作为极端 fallback（参数化失败时）

## 配置参数调整

降低批次大小和字节容量，减少峰值内存：

```rust
impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            read_batch_size: 512,           // 原 1024
            write_batch_size: 512,          // 原 1024
            byte_capacity: 8 * 1024 * 1024, // 8MB (原 64MB)
            transaction_batch_size: 1,      // 自动提交 (原 3)
            // 其他参数不变
        }
    }
}
```

**transaction_batch_size=1 原因**：
- 参数化插入单行 execute，无需批量事务
- 减少 undo log 累积

## 接口变更

### DataSource trait 新增方法

```rust
trait DataSource {
    /// 参数化批量写入 (内存友好，适用于不支持 bulk 的数据库)
    async fn bulk_write_parametrized(
        &self,
        table: &str,
        columns: &[String],
        rows: Vec<MigrationRow>,
        conflict_strategy: &ConflictStrategy,
        upsert_keys: &[String],
    ) -> Result<usize, AppError>;
}
```

### 废弃方法

- `build_native_chunk_sql()` — SQL 字符串构造，保留但标记 deprecated
- `InsertTemplate::build_chunk_sql()` — 保留用于调试/日志，不再用于实际写入

## 内存估算

优化后的峰值内存：

```
单 split 内存快照:
┌──────────────────────┬──────────────────────┐
│  组件                │ 估算                  │
├──────────────────────┼──────────────────────┤
│ Reader batch         │ 512×500B=256KB       │
│ Channel (byte gate)  │ 8MB 上限              │
│ Writer native_buf    │ 512×500B=256KB       │
│ Bulk TSV/CSV 流      │ 512×500B=256KB       │
│ 参数化查询           │ 无额外内存             │
├──────────────────────┼──────────────────────┤
│ 单 split 小计        │ ~9MB                  │
│ 4 splits             │ ~36MB                 │
├──────────────────────┼──────────────────────┤
│ MySQL undo log       │ 极小 (自动提交)       │
│ OS page cache        │ 正常                  │
└──────────────────────┴──────────────────────┘

总计：~100-500MB（取决于数据大小）
对比：原方案 20GB+，降低 40-200×
```

## 实现步骤

1. **Phase 2.1**：MySQL/PostgreSQL 强制启用 bulk
   - 修改 `bulk_write_native()` 路由逻辑
   - 移除 SQL 字符串 fallback
   - 测试 LOAD DATA 和 COPY FROM

2. **Phase 2.2**：新增参数化查询实现
   - 实现 `bulk_write_parametrized()`
   - 添加 `MigrationValue::to_sql_param()`
   - Oracle/SQL Server/SQLite 使用参数化

3. **Phase 2.3**：配置参数优化
   - 降低默认批次大小
   - 降低 byte_capacity
   - transaction_batch_size = 1

4. **Phase 2.4**：测试验证
   - 宽表迁移内存测试
   - 性能对比测试
   - 兼容性测试

## 风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| LOAD DATA 被禁用 | MySQL fallback 失败 | 参数化查询作为 backup |
| 参数化查询性能下降 | 吞吐降低 | 批量绑定参数，减少 execute 调用 |
| Oracle/SQL Server 占位符差异 | 实现复杂 | 抽象 PlaceholderBuilder |

## 参考

- DataX MySQLWriter: 使用 JDBC PreparedStatement
- DataX PostgreSQLWriter: 使用 COPY FROM STDIN
- sqlx query API: 支持 native 类型绑定