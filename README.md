<div align="center">

# 🗄️ Open DB Studio

**本地优先的 AI 数据库 IDE / Local-First AI Database IDE**

_连接数据源 · 自然语言转 SQL · 执行查询 · 可视化结果 · 全程本地运行_

[![License](https://img.shields.io/badge/license-MIT-blue.svg)]()
[![Tauri](https://img.shields.io/badge/Tauri-2.x-blue)]()
[![Rust](https://img.shields.io/badge/Rust-stable-orange)]()
[![React](https://img.shields.io/badge/React-18-61dafb)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)]()

<!-- TODO: 替换为截图 -->
<!-- ![Open DB Studio Screenshot](docs/assets/screenshot.png) -->

</div>

---

> <a name="demo"></a>
> 效果图.png

---

## ✨ 核心亮点 / Highlights

- 🤖 **AI Agent 驱动** — 自然语言转 SQL、AI 建表、SQL 优化、错误自动诊断，真正的工具调用 Agent 架构
- 🔌 **多数据源支持** — MySQL、PostgreSQL、Oracle、SQL Server，统一连接管理
- 🔒 **本地优先 & 安全** — 所有数据留在本地，密码 AES-256-GCM 加密，API Key 永不暴露前端
- 📊 **内联图表渲染** — AI 回答中直接生成 ECharts 交互图表，数据即时可视化
- 🧠 **GraphRAG 知识图谱** — Schema 实体图 + JOIN 路径自动推断，让 AI 真正理解你的数据库结构
- 🌊 **流式思考模型** — 支持 DeepSeek-R1、Qwen 思考系列等主流推理模型，流式输出思考过程
- 📝 **专业 SQL 编辑器** — Monaco 编辑器、Schema-aware 自动补全、一键格式化、多结果集 Tab
- 🚀 **开箱即用** — 基于 Tauri 2.x，跨平台桌面应用，无需额外服务，单文件安装

---

## 🔌 数据库支持 / Database Support

### 已支持 / Currently Supported

| 数据库 | 版本 | 状态 |
|--------|------|------|
| MySQL | 5.7 / 8.x | ✅ 完整支持 |
| PostgreSQL | 12+ | ✅ 完整支持 |
| Oracle | 11g+ | ✅ 支持（需 Oracle Instant Client）|
| SQL Server | 2017+ | ✅ 支持（含 Windows 身份验证）|

### 规划中 / Coming Soon

| 数据库 | 预计阶段 |
|--------|---------|
| ClickHouse | V3（插件系统）|
| TiDB | V3（插件系统）|
| 达梦（DM） | V3（插件系统）|
| DrosDB | V3（插件系统）|
| SQLite | V3（插件系统）|
| Milvus（向量库）| V3（RAG 管道）|
| Ollama（本地 LLM）| V3（AI 提供商插件）|

---

## 🤖 AI Agent 能力 / AI Agent Capabilities

Open DB Studio 内置工具驱动的 Agent 架构，以 OpenCode 为底座引擎，AI 可直接调用数据库工具完成复杂任务，而非仅生成文本。

### 📝 Text-to-SQL
自然语言描述需求，AI 自动注入当前数据库 Schema 上下文，生成精准 SQL：
```
用户：查询最近 30 天每个城市的销售总额，按降序排列
  ↓
AI 分析 Schema → 识别相关表和字段 → 生成 SQL → 填充到编辑器
```

### 🏗️ AI 建表
用自然语言描述表结构，AI 流式生成 DDL，确认后一键执行：
```
用户：创建一个电商订单表，包含订单号、用户ID、商品列表、金额、状态、时间戳
  ↓
AI 生成 CREATE TABLE DDL → 预览确认 → 执行建表
```

### 🔍 SQL 优化 & 错误诊断
- **SQL 优化**：分析执行计划，给出索引建议和重写方案
- **错误诊断**：SQL 报错时自动捕获上下文，一键问 AI 获取原因分析 + 修复方案

### 📊 内联图表渲染
AI 回答中直接输出 ECharts 图表代码块，自动渲染为交互式图表，支持放大查看：
```
用户：用柱状图展示各部门人数分布
  ↓
AI 查询数据 → 生成 ECharts 配置 → 直接在对话中渲染图表
```

### 🧠 GraphRAG 知识图谱
自动将数据库 Schema 构建为实体关系图谱，智能推断多表 JOIN 路径，让复杂查询不再困难：
- 表 / 列 / 外键 → 图节点与边
- BFS 多跳路径缓存，毫秒级 JOIN 路径推断
- 图谱可视化面板（GraphExplorer）

### 🌊 流式输出 & 思考模型
支持 DeepSeek-R1、Qwen 思考系列等推理模型，实时展示思考过程（可折叠），多会话后台流式输出，切换会话不中断。

### 💬 多轮对话 & 业务指标层
- 保留完整对话上下文，AI 理解前后文意图
- 自定义业务指标（聚合函数 + 业务含义），AI 自动生成指标草稿，提问时自动注入相关指标定义
- AI 自动生成会话标题，历史会话一目了然

---

## 🚀 快速开始 / Quick Start

### 环境要求
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) stable
- [Tauri CLI](https://tauri.app/) 2.x

### 安装运行

```bash
# 克隆仓库
git clone https://github.com/your-org/open-db-studio.git
cd open-db-studio

# 安装前端依赖
npm install

# 开发模式（前后端联调）
npm run tauri:dev

# 生产构建
npm run tauri:build
```

### AI 配置
启动后进入 **设置 → AI 模型配置**，添加任意 OpenAI 兼容接口（OpenAI、DeepSeek、Qwen 等）。

---

## 🛠️ 技术栈 / Tech Stack

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2.x |
| 前端 | React 18 + TypeScript + Vite |
| 状态管理 | Zustand |
| SQL 编辑器 | Monaco Editor |
| 图表 | ECharts |
| Rust 后端 | Tokio + rusqlite |
| AI 接入 | OpenAI 兼容接口（统一代理）|
| Agent 引擎 | OpenCode |

---

## 🗺️ 路线图 / Roadmap

| 阶段 | 目标 | 状态 |
|------|------|------|
| MVP | 连接管理、SQL 执行、基础 AI | ✅ 完成 |
| V1 | 完整 DB 管理、AI 建表/优化/诊断、数据导入导出 | ✅ 完成 |
| V2 | GraphRAG、业务指标层、跨数据源迁移、流式思考模型 | ✅ 完成 |
| V3 | 向量库、插件系统、团队协作 | 🔜 规划中 |

---

## 🙏 致谢 / Acknowledgements

本项目集成了 [OpenCode](https://github.com/sst/opencode) 作为 AI Agent 底座引擎，
驱动工具调用、多轮对话与流式输出等核心能力。感谢 OpenCode 团队的开源贡献。

Special thanks to the [OpenCode](https://github.com/sst/opencode) project for serving as
the core AI Agent engine powering tool invocation, multi-turn dialogue, and streaming output.

---

## 🤝 贡献 / Contributing

欢迎提交 Issue 和 Pull Request！请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)（即将上线）。

## 📄 License

[MIT License](./LICENSE)
