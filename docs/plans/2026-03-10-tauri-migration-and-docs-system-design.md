<!-- STATUS: ✅ 已实现 -->
# 设计文档：Tauri 脚手架迁移 + 文档记录系统

**日期**: 2026-03-10
**状态**: 已批准，待实施
**决策者**: @wushengzhou

---

## 背景

open-db-studio 当前是一个基于 Google AI Studio 生成的 React 原型（React 19 + express + better-sqlite3 + @google/genai），目标是复刻 chat2db 核心功能，并迁移至 Tauri 2.x 桌面架构。

同时，参照 OpenAI 工程实践文章的上下文工程原则，将代码仓库改造为"记录系统"：CLAUDE.md 作为 ≈100 行的"地图"，docs/ 作为结构化知识库，每份文档只做一件事，有单一权威来源。

---

## 第一节：项目目录结构

### 迁移后完整目录树

```
open-db-studio/
├── CLAUDE.md                    # 智能体上下文入口（≈100行，地图）
├── ARCHITECTURE.md              # 系统架构详述
├── src/                         # React 前端
│   ├── components/
│   │   ├── ActivityBar/
│   │   ├── Explorer/
│   │   ├── MainContent/
│   │   ├── Assistant/
│   │   └── Toast/
│   ├── pages/
│   ├── store/                   # Zustand stores
│   ├── hooks/
│   ├── utils/
│   └── types/
├── src-tauri/                   # Rust 后端（新建）
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── commands.rs          # Tauri invoke 命令注册
│       ├── error.rs             # 统一错误类型
│       ├── db/                  # 内置 SQLite（配置存储）
│       │   └── mod.rs
│       ├── datasource/          # 多数据源连接管理
│       │   ├── mod.rs
│       │   ├── mysql.rs
│       │   ├── postgres.rs
│       │   ├── oracle.rs
│       │   └── sqlserver.rs
│       └── llm/                 # AI 请求代理
│           ├── mod.rs
│           └── client.rs
├── prompts/                     # Prompt 模板
│   ├── sql_generate.txt
│   ├── sql_explain.txt
│   └── sql_optimize.txt
├── schema/                      # 内置 SQLite DDL
│   └── init.sql
└── docs/                        # 文档记录系统
    ├── DESIGN.md
    ├── FRONTEND.md
    ├── PLANS.md
    ├── QUALITY_SCORE.md
    ├── SECURITY.md
    ├── design-docs/
    │   ├── datasource-arch.md
    │   ├── ai-pipeline.md
    │   └── schema-design.md
    ├── adr/
    │   ├── 001-tauri-vs-electron.md
    │   ├── 002-rust-datasource-layer.md
    │   └── 003-llm-proxy-backend.md
    ├── product-specs/
    │   └── datasource-management.md
    ├── exec-plans/
    │   └── 2026-03-tauri-migration.md
    └── generated/
        └── db-schema.md
```

---

## 第二节：CLAUDE.md 内容设计

CLAUDE.md 严格控制在 ≈100 行，只做"地图"，不做"百科全书"。

### 结构大纲

1. 项目概述（产品定位、核心价值）
2. 技术栈（表格）
3. 目录结构（精简树形图）
4. 文档导航（表格，每行一个文档）
5. 开发命令（5条核心命令）
6. 前后端通信约定（含3个 invoke 示例）
7. 关键约定（硬性规则，6条）
8. 任务开始前检查清单（4步）

### 关键约定（写入 CLAUDE.md 的硬性规则）

- 数据库操作（内置 SQLite + 外部数据源）全部在 Rust 层完成，前端不直接访问
- 所有 AI 请求走 `src-tauri/src/llm/client.rs` 统一代理
- 连接凭证（密码）存储时必须加密，见 docs/SECURITY.md
- 时间戳使用 ISO 8601 字符串存储
- Rust 模块新增命令后，必须在 `commands.rs` 注册
- 文档新鲜度：修改代码后按"文档更新触发表"检查是否需要更新对应文档

---

## 第三节：Rust 后端骨架设计

### 模块职责

| 模块 | 职责 |
|------|------|
| `db/` | 内置 SQLite，管理应用配置（connections、groups、history、saved_queries） |
| `datasource/` | 外部多数据源连接管理，DataSource trait 抽象 |
| `llm/` | AI 请求统一代理，OpenAI 兼容接口 |
| `commands.rs` | 所有 `#[tauri::command]` 注册，是前后端通信的唯一入口 |
| `error.rs` | 统一 AppError 类型，所有模块返回 `Result<T, AppError>` |

### 内置 SQLite Schema

```sql
CREATE TABLE connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    driver TEXT NOT NULL,        -- mysql | postgres | oracle | sqlserver | sqlite
    host TEXT,
    port INTEGER,
    database TEXT,
    username TEXT,
    password_enc TEXT,           -- AES-256 加密存储
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE connection_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES connection_groups(id)
);

CREATE TABLE query_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER REFERENCES connections(id),
    sql TEXT NOT NULL,
    executed_at TEXT NOT NULL,
    duration_ms INTEGER,
    row_count INTEGER
);

CREATE TABLE saved_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    connection_id INTEGER REFERENCES connections(id),
    sql TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

### DataSource Trait（统一抽象）

```rust
#[async_trait]
pub trait DataSource: Send + Sync {
    async fn test_connection(&self) -> Result<(), AppError>;
    async fn execute(&self, sql: &str) -> Result<QueryResult, AppError>;
    async fn get_tables(&self) -> Result<Vec<TableMeta>, AppError>;
    async fn get_schema(&self) -> Result<SchemaInfo, AppError>;
}
```

MVP 阶段：MySQL + PostgreSQL 完整实现；Oracle + SQL Server 骨架占位。

### Tauri 命令接口清单

```rust
// 连接管理
list_connections() -> Vec<Connection>
create_connection(config: ConnectionConfig) -> Connection
test_connection(config: ConnectionConfig) -> bool
delete_connection(id: i64)

// 查询执行
execute_query(connection_id: i64, sql: String) -> QueryResult
get_schema(connection_id: i64) -> SchemaInfo
get_tables(connection_id: i64) -> Vec<TableMeta>

// AI 代理
ai_chat(message: String, context: ChatContext) -> String
ai_generate_sql(prompt: String, schema: SchemaInfo) -> String

// 历史 & 收藏
get_query_history(connection_id: i64) -> Vec<QueryHistory>
save_query(name: String, connection_id: i64, sql: String)
```

---

## 第四节：docs/ 文档体系规划

### 文档分层原则

每份文档只做一件事，且只有一个权威来源（Single Source of Truth）。

### 文档内容速览

| 文档 | 核心内容 |
|------|------|
| `DESIGN.md` | VSCode 暗色主题规范；组件间距、颜色 token；禁止内联样式 |
| `FRONTEND.md` | 组件命名约定；Zustand store 分层；Tauri invoke 封装规范 |
| `QUALITY_SCORE.md` | TypeScript strict 必须开启；Rust clippy 0 warning；禁止 `unwrap()` |
| `SECURITY.md` | 连接密码 AES-256 加密；API Key 存 Tauri secure storage；不得 log 凭证 |
| `design-docs/datasource-arch.md` | DataSource trait；连接池策略；多数据源并发隔离 |
| `design-docs/ai-pipeline.md` | Prompt 模板加载；schema 注入机制；流式响应处理 |
| `design-docs/schema-design.md` | 内置 SQLite 表结构；versioned migrations 策略 |
| `adr/001` | 选 Tauri 而非 Electron：包体积、Rust 原生、内存占用 |
| `adr/002` | 数据源层放 Rust：连接池复用、敏感凭证隔离 |
| `adr/003` | LLM 请求走 Rust 代理：API Key 不暴露前端、统一限流 |

### ADR 标准格式

```markdown
# ADR-XXX: 标题

**状态**: 已接受 | 已废弃 | 待定
**日期**: YYYY-MM-DD
**决策者**: @wushengzhou

## 背景
## 决策
## 后果
### 优点
### 缺点
### 风险
```

### 文档新鲜度触发表

| 触发事件 | 需更新的文档 |
|----------|------------|
| 新增 Tauri 命令 | `ARCHITECTURE.md` + `CLAUDE.md` 命令示例 |
| 新增数据源驱动 | `datasource-arch.md` + `PLANS.md` |
| 修改 SQLite schema | `schema-design.md` + `generated/db-schema.md` |
| 修改 Prompt 模板 | `ai-pipeline.md` |
| 重大架构决策 | 新建 `docs/adr/XXX.md` |

---

## 实施顺序

1. 初始化 Tauri 2.x 脚手架（`npm run tauri init`）
2. 迁移现有 React 前端代码到 Tauri 项目结构
3. 创建 Rust 后端骨架（所有模块目录 + 占位文件）
4. 写入 `schema/init.sql`
5. 创建 `CLAUDE.md`
6. 创建 `ARCHITECTURE.md`
7. 创建 `docs/` 下所有规范文档（骨架内容）
8. 创建 3 个 ADR 文件
9. 创建 `prompts/` 目录和初始模板
