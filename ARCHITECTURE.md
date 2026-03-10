# ARCHITECTURE.md — open-db-studio 系统架构

## 系统概览

```
[用户] → [Tauri 窗口]
              ↓
    [React 前端 (src/)]
    ActivityBar / Explorer / MainContent / Assistant
    Zustand 管理全局状态
              ↓ invoke()
    [Rust 后端 (src-tauri/src/)]
              ├── commands.rs  ← 统一入口（11个命令）
              ├── db/          ← 内置 SQLite（应用配置）
              ├── datasource/  ← 外部数据源连接
              └── llm/         ← AI 请求代理
              ↓
    [外部服务]
    ├── MySQL / PostgreSQL / Oracle / SQL Server
    └── OpenAI API（或兼容接口）
```

## 模块说明

### src/ — React 前端

| 目录 | 说明 |
|------|------|
| `components/ActivityBar/` | 左侧图标导航栏（VSCode 风格） |
| `components/Explorer/` | 数据库/表树形浏览器 |
| `components/MainContent/` | SQL 编辑器 + 结果集展示 |
| `components/Assistant/` | AI 对话面板 |
| `store/` | Zustand 全局状态 |
| `hooks/` | 自定义 hooks（useInvoke 等） |
| `types/` | TypeScript 类型定义（与 Rust 结构对齐） |

### src-tauri/src/ — Rust 后端

| 文件/目录 | 说明 |
|-----------|------|
| `commands.rs` | 所有 `#[tauri::command]` 注册，前后端通信唯一入口 |
| `error.rs` | 统一错误类型 `AppError`，实现 `Serialize` 供前端消费 |
| `db/` | 内置 SQLite：连接配置、查询历史、收藏查询 |
| `datasource/` | DataSource trait + MySQL/PG 实现 + Oracle/SqlServer 占位 |
| `llm/` | OpenAI 兼容接口，统一代理所有 AI 请求 |

## 数据流

### 用户执行 SQL 查询

```
前端输入 SQL
→ invoke('execute_query', { connectionId, sql })
→ commands::execute_query()
→ db::get_connection(connectionId)    # 读取连接配置
→ decrypt(password_enc)               # 解密密码
→ datasource::create_datasource()     # 创建数据源
→ datasource.execute(sql)             # 执行查询
→ db::record_history()               # 记录历史
→ QueryResult → 前端渲染结果表格
```

### AI 生成 SQL

```
用户输入自然语言
→ invoke('ai_generate_sql', { prompt, connectionId })
→ commands::ai_generate_sql()
→ get_schema(connectionId)            # 获取表结构
→ llm::generate_sql(prompt, schema)   # 注入 schema 到 Prompt
→ OpenAI API 调用
→ SQL 字符串 → 填充到编辑器
```

## Zustand 状态结构

```typescript
{
  connections: Connection[],        // 连接列表（从 Rust 同步）
  activeConnectionId: number | null,
  tabs: Tab[],                      // 打开的查询标签页
  activeTabId: string,
  queryResults: Map<string, QueryResult>,
  chatMessages: ChatMessage[],      // AI 对话历史
}
```

## 安全边界

详见 [docs/SECURITY.md](./docs/SECURITY.md)。核心原则：
- 连接密码永远不离开 Rust 层（AES-256 加密存储）
- AI API Key 加密存储，不通过 invoke 返回给前端
- 前端获取连接信息时，密码字段始终为 null
