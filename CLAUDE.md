# CLAUDE.md — open-db-studio 智能体上下文工程文件

本文件是 Claude Code 的核心上下文入口。每次开始任务前先阅读本文件，
再根据任务类型查阅对应子文档。

## 项目概述

**open-db-studio** 是一款本地优先的 AI 数据库 IDE 桌面应用，复刻 chat2db 核心功能。

核心价值：连接多数据源 → 自然语言转 SQL → 执行查询 → 可视化结果，**全程本地运行**。

产品定位：**AI-Native Database Client**

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2.x |
| 前端 | React 18 + TypeScript + Vite |
| 状态管理 | Zustand |
| 路由 | React Router v6 |
| 后端 | Rust |
| 内置数据库 | SQLite（via rusqlite）— 存储应用配置 |
| 外部数据源 | MySQL、PostgreSQL、Oracle（占位）、SQL Server（占位） |
| AI 接入 | Rust 层统一代理（OpenAI 兼容接口） |

## 目录结构

```
open-db-studio/
├── CLAUDE.md              # 本文件（智能体上下文入口）
├── ARCHITECTURE.md        # 系统架构详述
├── src/                   # React 前端
├── src-tauri/             # Rust 后端
│   └── src/
│       ├── commands.rs    # 所有 Tauri invoke 命令注册
│       ├── db/            # 内置 SQLite（配置存储）
│       ├── datasource/    # 多数据源连接管理
│       └── llm/           # AI 请求统一代理
├── prompts/               # SQL 生成/解释/优化 Prompt 模板
├── schema/                # 内置 SQLite DDL（init.sql）
└── docs/                  # 文档记录系统（见下方导航）
```

## 文档导航

| 文档 | 用途 |
|------|------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统架构、模块说明、数据流 |
| [docs/DESIGN.md](./docs/DESIGN.md) | UI/UX 设计规范 |
| [docs/FRONTEND.md](./docs/FRONTEND.md) | 前端开发规范与组件说明 |
| [docs/PLANS.md](./docs/PLANS.md) | 当前开发计划与路线图 |
| [docs/QUALITY_SCORE.md](./docs/QUALITY_SCORE.md) | 代码质量标准 |
| [docs/SECURITY.md](./docs/SECURITY.md) | 安全策略（API Key、连接凭证） |
| [docs/design-docs/datasource-arch.md](./docs/design-docs/datasource-arch.md) | 多数据源架构设计 |
| [docs/design-docs/ai-pipeline.md](./docs/design-docs/ai-pipeline.md) | AI SQL 生成流程 |
| [docs/adr/](./docs/adr/) | 架构决策记录（ADR） |

## Shell 环境约定

本项目在 Windows 上开发，执行命令前需判断当前 shell：

| Shell | 路径写法 |
|-------|---------|
| Git Bash / MSYS2 | `/d/project/java/source/open-db-studio/...` 或相对路径 |
| PowerShell / CMD | `D:\project\java\source\open-db-studio\...` |

在 Git Bash 中 `\` 是转义字符，`D:\project\...` 的反斜杠会被吞掉导致路径错误。优先使用**相对路径**可以规避 shell 差异。

## 开发命令

```bash
npm run dev              # 仅前端（端口 1420）
npm run tauri:dev        # Tauri 前后端联调
npm run tauri:build      # 打包
npx tsc --noEmit         # TypeScript 类型检查
cd src-tauri && cargo check   # Rust 编译检查
```

## 前后端通信约定

前端通过 Tauri `invoke()` 调用 Rust 命令（定义在 `src-tauri/src/commands.rs`）：

```typescript
import { invoke } from '@tauri-apps/api/core'
await invoke('test_connection', { config: { driver: 'mysql', host: '...', port: 3306, database: '...', username: '...', password: '...' } })
await invoke('execute_query', { connectionId: 1, sql: 'SELECT 1' })
await invoke('ai_generate_sql', { prompt: '查询用户表前10条', connectionId: 1 })
```

## 关键约定

- 数据库操作（内置 SQLite + 外部数据源）全部在 Rust 层，前端不直接访问
- 所有 AI 请求走 `src-tauri/src/llm/client.rs` 统一代理
- 连接密码必须 AES-256 加密存储，见 [docs/SECURITY.md](./docs/SECURITY.md)
- 时间戳使用 ISO 8601 字符串存储
- 新增 Rust 命令后必须在 `lib.rs` 的 `generate_handler![]` 中注册
- 修改代码后检查 [docs/PLANS.md](./docs/PLANS.md) 中的文档新鲜度触发表

## 任务开始前检查清单

1. 阅读 CLAUDE.md（本文件）
2. 根据任务类型查阅对应文档（见文档导航）
3. 了解相关模块现有代码再修改
4. 遵循 [docs/QUALITY_SCORE.md](./docs/QUALITY_SCORE.md) 中的质量标准
