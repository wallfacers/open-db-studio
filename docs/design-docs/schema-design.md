# 内置 SQLite Schema 设计

## 权威来源

`schema/init.sql`（本文档为说明文档，init.sql 为权威来源）。

**最后更新**：2026-03-29

---

## 核心表（5 张 — 基础配置）

| 表 | 用途 |
|----|------|
| `connections` | 数据库连接配置（10 种驱动），密码 AES-256 加密，支持 SSL/TLS/连接池/超时 |
| `connection_groups` | 连接分组（树形，支持嵌套） |
| `query_history` | 查询历史，关联 connection |
| `saved_queries` | 用户收藏查询 |
| `app_settings` | key-value 应用设置 |

## AI 模块表（1 张）

| 表 | 用途 |
|----|------|
| `llm_configs` | LLM 模型配置（多供应商、多配置 CRUD、opencode 集成字段） |

## 任务系统表（1 张）

| 表 | 用途 |
|----|------|
| `task_records` | 后台任务（导入/导出/迁移/SeaTunnel/AI 指标生成），含进度、日志、错误详情 |

## GraphRAG 图谱表（2 张）

| 表 | 用途 |
|----|------|
| `graph_nodes` | 图谱节点（表/列/FK Link 节点），按 connection+database+schema 分区 |
| `graph_edges` | 图谱边（FK 关系、合成关系），支持多跳 BFS 路径查询 |

## 业务指标表（2 张）

| 表 | 用途 |
|----|------|
| `metrics` | 业务指标定义（draft/approved/rejected 状态流转），原子/复合指标 |
| `semantic_aliases` | 语义别名（自然语言 → 表/列映射，AI 上下文增强） |

## 跨源迁移表（2 张）

| 表 | 用途 |
|----|------|
| `migration_tasks` | 迁移任务（pending/running/paused/done/failed 状态机） |
| `migration_checks` | 迁移预检结果（类型兼容/null 约束/主键冲突） |

## UI 持久化表（1 张）

| 表 | 用途 |
|----|------|
| `ui_state` | UI 状态持久化（标签页、树展开、分页大小等，从 localStorage 迁移至 SQLite） |

## 变更追踪表（1 张）

| 表 | 用途 |
|----|------|
| `change_history` | 数据变更历史（跟踪表数据的 INSERT/UPDATE/DELETE 操作） |

## Agent 会话表（1 张）

| 表 | 用途 |
|----|------|
| `agent_sessions` | AI 助手会话历史（多会话、AI 生成标题） |

## Schema 变更日志表（1 张）

| 表 | 用途 |
|----|------|
| `schema_change_log` | 外部数据源 Schema 变更追踪（DDL 审计） |

## SeaTunnel 集成表（3 张）

| 表 | 用途 |
|----|------|
| `seatunnel_connections` | SeaTunnel 引擎连接配置 |
| `seatunnel_categories` | SeaTunnel 任务分类 |
| `seatunnel_jobs` | SeaTunnel 迁移 Job（CRUD + REST API 提交/停止/状态轮询） |

## ER 设计器表（5 张）

| 表 | 用途 |
|----|------|
| `er_projects` | ER 设计项目 |
| `er_tables` | ER 设计表定义 |
| `er_columns` | ER 设计列定义 |
| `er_relations` | ER 设计关系（外键连线） |
| `er_indexes` | ER 设计索引定义 |

---

## 表统计

| 分类 | 数量 |
|------|------|
| 基础配置 | 5 |
| AI 模块 | 1 |
| 任务系统 | 1 |
| GraphRAG | 2 |
| 业务指标 | 2 |
| 跨源迁移 | 2 |
| UI 持久化 | 1 |
| 变更追踪 | 1 |
| Agent 会话 | 1 |
| Schema 日志 | 1 |
| SeaTunnel | 3 |
| ER 设计器 | 5 |
| **总计** | **25** |

## 迁移策略

当前：`execute_batch(include_str!("schema/init.sql"))` 启动时执行（幂等 IF NOT EXISTS）。
后续：引入 refinery crate 实现版本化迁移。
