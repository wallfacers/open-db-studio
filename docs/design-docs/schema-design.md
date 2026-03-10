# 内置 SQLite Schema 设计

## 权威来源

`schema/init.sql`（本文档为说明文档，init.sql 为权威来源）。

## 核心表说明

| 表 | 用途 |
|----|------|
| `connections` | 数据库连接配置，密码 AES-256 加密 |
| `connection_groups` | 连接分组（树形，支持嵌套） |
| `query_history` | 查询历史，关联 connection |
| `saved_queries` | 用户收藏查询 |
| `app_settings` | key-value 应用设置 |

## 迁移策略

当前：`execute_batch(include_str!("schema/init.sql"))` 启动时执行（幂等 IF NOT EXISTS）。
后续：引入 refinery crate 实现版本化迁移。
