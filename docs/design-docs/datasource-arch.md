# 多数据源架构设计

## DataSource Trait

见 `src-tauri/src/datasource/mod.rs`（权威来源）。

统一接口：`test_connection`、`execute`、`get_tables`、`get_schema`。

## 支持状态

| 数据源 | 状态 | 依赖 |
|--------|------|------|
| MySQL | MVP 实现 | sqlx mysql feature |
| PostgreSQL | MVP 实现 | sqlx postgres feature |
| Oracle | 占位 | TBD |
| SQL Server | 占位 | TBD（tiberius） |

## 连接池策略

当前：每次查询创建新连接（MVP 阶段）。
计划：sqlx 连接池按 connection_id 缓存 pool 实例。
