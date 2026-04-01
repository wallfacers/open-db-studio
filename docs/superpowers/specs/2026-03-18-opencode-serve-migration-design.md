<!-- STATUS: ✅ 已实现 -->
# opencode-cli Serve 模式迁移设计文档

**日期：** 2026-03-18
**状态：** 待实现
**范围：** 将 ACP 子进程协议替换为 opencode-cli HTTP Serve 模式，重构 Session 管理、流式通信、SQL 解释/优化，重设计端到端测试

---

## 背景与动机

当前架构通过 `opencode-cli acp` 启动子进程，每个 Session 对应一个独立进程，通过 ACP 私有协议通信。这带来以下问题：

- 多轮对话历史由 Rust HashMap + localStorage 自管理，容易失同步
- 每个 Session 独立进程，资源开销大
- ACP 协议私有，扩展能力受限
- SQL 解释/优化各自启动独立进程，无法复用

opencode-cli 的 `serve` 模式提供标准 HTTP API，Session 历史由服务端统一管理，是更健壮的架构。

---

## Part 1：目录结构与 Serve 进程生命周期

### 新目录结构

```
app_data_dir/                          # com.open-db-studio.app
├── agent/                             # opencode-cli serve 工作目录
│   ├── .opencode/
│   │   ├── config.json                # MCP servers、agents、commands 静态配置
│   │   └── agents/
│   │       ├── sql-explain.md         # SQL 解释专用 Agent 提示词
│   │       └── sql-optimize.md        # SQL 优化专用 Agent 提示词
│   └── opencode.json                  # LLM 配置（持久化，热更新）
└── open-db-studio.db                  # 现有 SQLite（新增 agent_sessions 表）
```

> `acp/` 目录在迁移完成后删除。

### Serve 进程启动流程

```
App 启动
  └─ GET /global/health
      ├─ 200 → 复用已有进程（开发调试场景）
      └─ 失败 → spawn: opencode-cli serve --port 4096
                  cwd = app_data_dir/agent/
                  轮询健康检查（间隔 500ms，最多 10s）
                  成功 → 注册 App 退出钩子（kill 进程）
                        启动崩溃监控（watch child exit）
                  超时 → 报错，提示用户检查 opencode-cli 安装
```

### Serve 进程崩溃恢复

```
监控线程检测到子进程退出（非 App 主动 kill）
  └─ retry_count += 1
      └─ 等待 1s（避免快速重启死循环）
          └─ 重新执行启动流程（同上）
              ├─ 成功 → retry_count = 0（重置计数器）
              │         通过 Tauri 事件通知前端（serve_restarted）
              │         前端显示短暂提示："AI 服务已重连"
              └─ 失败（retry_count >= 3）→ 通知前端 serve_failed，提示用户手动重启
```

> **计数器重置规则：** 每次健康检查通过后立即重置为 0，保证长时运行的 App 不会因早期重启消耗次数而无法恢复。

**设计决策：**
- 单个 serve 实例，所有 Session 共享
- 端口默认 4096，存储在 SQLite `app_config` 表，支持用户修改
- `opencode.json` 持久化落盘，不再握手后删除（API Key 已在 SQLite AES-256-GCM 加密）

### SQLite 新增表

```sql
CREATE TABLE agent_sessions (
  id          TEXT PRIMARY KEY,   -- opencode session UUID
  title       TEXT,
  config_id   INTEGER,            -- 关联 llm_configs 表
  is_temp     INTEGER DEFAULT 0,  -- 1 = SQL解释/优化临时session，不显示在历史
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

---

## Part 2：HTTP Client + 流式通信层

### Rust 模块重组

```
src-tauri/src/
├── acp/          ← 整体删除
├── agent/        ← 新建，替代 acp/
│   ├── mod.rs
│   ├── server.rs    # 进程启动/停止/健康检查
│   ├── client.rs    # reqwest HTTP client（session CRUD、消息发送）
│   ├── stream.rs    # SSE 解析 → Tauri Channel StreamEvent 转换
│   └── config.rs    # opencode.json 生成与持久化
└── mcp/          ← 保留不变（MCP server 工具定义）
```

### SSE 事件映射

opencode serve 的 SSE 流事件映射到现有 `StreamEvent` 类型（前端不变）：

| opencode SSE 事件 | StreamEvent（前端） |
|---|---|
| `message.part.delta` (text) | `ContentChunk` |
| `message.part.delta` (thinking) | `ThinkingChunk` |
| `message.part.delta` (tool_use) | `ToolCallRequest` |
| `session.permission.requested` | `PermissionRequest` ★ |
| `message.completed` | `Done` |
| `error` | `Error` |

### Permission 完整流程

```
opencode SSE: session.permission.requested { permissionID, message, options }
  └─ stream.rs 捕获并转换
      └─ Tauri Channel: StreamEvent::PermissionRequest { id, message, options }
          └─ 前端显示确认面板（UI 不变，用户点击某个 option）
              └─ invoke('agent_permission_respond', { sessionId, permissionId, response, remember })
                  └─ Rust: POST /session/:id/permissions/:permissionID { response, remember? }
```

**Permission API 合约：**
- `response`: 字符串，值为 opencode permission 选项的语义值，通过 `GET /doc` OpenAPI spec 实现前确认具体枚举（预期为 `"allow"` / `"deny"` 或选项 ID）
- `remember`: 可选布尔，`true` 表示记住此次决策，后续同类操作不再询问
- 前端 PermissionPanel 仍展示 options 列表，用户点击后将该 option 的语义值作为 `response` 传入
- 实现前必须通过 `GET /doc` 验证实际字段名和枚举值，不得假设

### Elicitation 降级

旧的 JSON Schema 表单交互（`ExtRequest("session/elicitation")`）废弃。
Agent 改为用自然语言提问，用户文本回复，多轮对话自然延续。
`ElicitationPanel`（form variant）组件删除，`ElicitationSelectPanel`（文字检测）保留。

### Tauri 命令变化

**废弃：**
- `ai_chat_acp`
- `cancel_acp_session`
- `acp_permission_respond`
- `acp_elicitation_respond`

**新增：**

```rust
ai_chat(prompt, tab_sql?, connection_id?, config_id?, session_id, channel)
    // POST /session/:id/message，model 字段随 config_id 动态传入

agent_permission_respond(session_id, permission_id, response, remember?)
    // POST /session/:id/permissions/:permissionID

cancel_session(session_id)
    // POST /session/:id/abort

get_session_messages(session_id)
    // GET /session/:id/message

list_sessions()
    // GET /session（过滤 is_temp=1）

create_session(config_id?)
    // POST /session，写入 agent_sessions 表，返回服务端分配的 session_id

delete_session(session_id)
    // DELETE /session/:id，从 agent_sessions 表删除

delete_all_sessions()
    // 遍历 list_sessions()（is_temp=0）+ agent_sessions 表中所有 is_temp=1 记录
    // 逐一调用 DELETE /session/:id，确保临时 session 也被清理

clear_session_history(session_id) -> String  // 返回新 session_id
    // 删除当前 session 并创建新 session，返回新 session_id
    // 前端收到返回值后更新 currentSessionId
    // 注意：serve 模式无法仅清空消息而保留 session，此操作等同于 delete+create

request_ai_title(session_id, context) -> String
    // 创建临时 session（is_temp=1），发送单条消息生成标题，完成后删除临时 session
    // 返回 String（标题文本），非流式
    // 无论成功或失败（LLM 报错、超时），均保证在 finally 路径中删除临时 session

apply_agent_config(config_id)
    // 生成 opencode.json 写盘 + PATCH /config 热更新
```

### 前端 aiStore 变化

| 现有 | 迁移后 |
|------|--------|
| sessions 存 localStorage | 从 `list_sessions()` 读取，以服务端为准；localStorage sessions 废弃 |
| chatHistory 存内存 | 从 `get_session_messages()` 按需加载 |
| newSession() 仅更新前端状态 | 调用 `create_session()`，以服务端返回的 UUID 作为唯一 session_id |
| session_id 由前端 `crypto.randomUUID()` 生成 | session_id 由 opencode 服务端分配，前端不再自生成 |
| configFingerprint 变化触发进程重建 | 每条消息携带 `model` 字段，无需重建任何进程 |
| pending_permissions Rust HashMap | 废弃，由 opencode 服务端管理 |
| clearHistory() 清空消息保留 session | 改为 `clear_session_history()`：delete + create，currentSessionId 更新 |
| requestAiTitle() 非流式 ai_chat | 改为 `request_ai_title()`：临时 session，单次消息，返回标题字符串 |
| deleteAllSessions() 调用 cancel_acp_session | 改为 `delete_all_sessions()`：遍历所有 session 逐一删除 |

**首次升级迁移：**
- App 升级后首次启动时，检测到 localStorage 中存在旧 session 数据
- 迁移策略：丢弃旧 localStorage 数据，以 opencode 服务端现有 session 为准
- 若服务端无 session（全新安装），正常进入空白状态

---

## Part 3：配置管理与 MCP 注册

### opencode.json 持久化与热更新

**触发时机：** 用户在 AI 助手页面切换 LLM 配置时立即执行。

```
invoke('apply_agent_config', { configId })
  ├─ 从 SQLite llm_configs 读取配置（解密 apiKey）
  ├─ 生成 opencode.json → 写入 agent/opencode.json
  └─ PATCH /config { model, provider }  ← 热更新，无需重启 serve
```

**opencode.json 格式示例（Anthropic）：**

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "provider": {
    "anthropic": {
      "options": { "apiKey": "sk-ant-..." }
    }
  }
}
```

### .opencode/config.json — MCP 工具注册

替代 ACP 握手期间的动态 MCP 注册，改为静态配置文件，serve 启动时自动加载。
MCP 端口在 Rust 启动时动态写入后，再启动 serve 进程。

```json
{
  "mcp": {
    "open-db-studio": {
      "type": "http",
      "url": "http://127.0.0.1:{mcp_port}/mcp"
    }
  }
}
```

---

## Part 4：SQL 解释 & SQL 优化重构

### 现状问题

当前每次 SQL 解释/优化请求都启动独立 ACP 子进程（`acp-explain`、`acp-optimize` 工作目录），无法复用 serve 实例。

### 新方案：专用 Agent + 临时 Session

在 `.opencode/agents/` 定义两个专用 Agent，消息请求时通过 `agent` 字段指定：

```
.opencode/agents/
├── sql-explain.md     # 系统提示词：你是 SQL 解释专家...
└── sql-optimize.md    # 系统提示词：你是 SQL 优化专家...
```

**流程：**

```
invoke('ai_explain_sql', { sql, connectionId, database, channel })
  └─ POST /session { title: "sql-explain-{timestamp}" }  → 写入 agent_sessions(is_temp=1)
      └─ POST /session/:id/message {
           agent: "sql-explain",
           model: <当前 LLM 配置>,
           parts: [{ type: "text", text: "<sql>\n{sql}\n</sql>\n数据库：{database}" }]
         }
          └─ SSE → StreamEvent → Tauri Channel

invoke('ai_optimize_sql', { sql, connectionId, database, channel })
  └─ 同上，agent: "sql-optimize"
```

**临时 Session 清理：**
- explain/optimize session 标记 `is_temp=1`，不显示在历史列表
- 流结束（Done/Error/取消）后调用 `DELETE /session/:id` 清理

### Tauri 命令变化

**废弃：**
- `ai_explain_sql_acp`
- `ai_optimize_sql`（旧 ACP 版本）
- `cancel_explain_acp_session`
- `cancel_optimize_acp_session`

**新增：**
- `ai_explain_sql(sql, connection_id?, database?, channel)` — 临时 session + sql-explain agent
- `ai_optimize_sql(sql, connection_id?, database?, channel)` — 临时 session + sql-optimize agent
- `cancel_explain_sql()` — 调用 `cancel_session(current_explain_session_id)` 并清理临时 session
- `cancel_optimize_sql()` — 调用 `cancel_session(current_optimize_session_id)` 并清理临时 session

Rust 层在 AppState 中各维护一个 `current_explain_session_id: Option<String>` 和 `current_optimize_session_id: Option<String>`，流结束时清空。

**并发策略：** explain 和 optimize 各自串行，同一时刻只允许一个请求。新请求到达时，若对应 AppState 字段非空（上一次请求仍在进行），先自动 abort 旧 session 并清理，再创建新 session。前端层面通过禁用按钮保证 UX 一致性。

---

## 端到端测试设计

### Layer 1 — Serve 进程生命周期（Rust 集成测试）

```
✓ 启动 opencode-cli serve，GET /global/health 返回 200
✓ 重复启动时检测到已有进程并复用（幂等）
✓ App 退出时进程被正确 kill
✓ 进程崩溃后自动重启并恢复健康
✓ opencode-cli 未安装时报错信息清晰
```

### Layer 2 — Session & 消息 API（Rust 集成测试）

```
✓ create_session() → 返回合法 session_id，写入 agent_sessions 表
✓ ai_chat() → SSE 流包含 ContentChunk 序列 + Done 事件
✓ get_session_messages() → 返回历史消息列表，顺序正确
✓ list_sessions() → 仅返回 is_temp=0 的 session
✓ delete_session() → session 从列表消失，opencode 侧同步删除
✓ cancel_session() → 中断正在进行的流，返回 Done/Error
```

### Layer 3 — Permission 流程（Rust 集成测试）

```
✓ SSE 流中出现 session.permission.requested → 转换为 StreamEvent::PermissionRequest
✓ agent_permission_respond(response=allow) → 流继续，后续 ContentChunk 正常到达
✓ agent_permission_respond(response=deny) → 流终止，返回 Error 或 Done
✓ agent_permission_respond(remember=true) → 后续同类操作不再弹出确认
```

### Layer 4 — 配置管理（Rust 单元测试）

```
✓ apply_agent_config(OpenAI 类型) → opencode.json 格式正确
✓ apply_agent_config(Anthropic 类型) → opencode.json 格式正确
✓ apply_agent_config(自定义端点) → opencode.json 格式正确
✓ PATCH /config 请求体格式符合 opencode API 规范
✓ .opencode/config.json MCP URL 端口动态替换正确
```

### Layer 5 — SQL 解释/优化（Rust 集成测试）

```
✓ ai_explain_sql() → 创建 is_temp=1 session，使用 sql-explain agent，流式返回内容
✓ ai_optimize_sql() → 创建 is_temp=1 session，使用 sql-optimize agent，流式返回内容
✓ 完成后 session 从 GET /session 列表消失（已清理）
✓ 中途 cancel 后 session 同样被清理
✓ list_sessions() 结果中不包含临时 session
```

### Layer 6 — 前端集成（Vitest + MSW mock）

```
✓ aiStore.sendAgentChatStream() 消费 StreamEvent 正确更新 chatHistory
✓ 切换 session 时从 get_session_messages() 加载历史（不依赖 localStorage）
✓ Permission 面板弹出 → 用户响应 → 流恢复继续
✓ newSession() 调用 create_session()，session 出现在列表
✓ deleteSession() 调用 delete_session()，session 从列表移除
✓ apply_agent_config() 切换配置后下一条消息携带新 model 字段
```

---

## 删除清单

迁移完成后可删除的代码：

| 位置 | 内容 |
|------|------|
| `src-tauri/src/acp/` | 整个模块（client.rs、session.rs、config.rs、mod.rs） |
| `src-tauri/src/state.rs` | `acp_sessions`、`pending_permissions`、`pending_elicitations` 字段 |
| `src/components/Assistant/ElicitationPanel.tsx` | form variant（AcpElicitationFormPanel） |
| `src/store/aiStore.ts` | `pendingAcpElicitation`、`respondAcpElicitation`、`configFingerprint` 逻辑、localStorage sessions 持久化 |
| `src/store/aiStore.ts` | `requestAiTitle()` 旧非流式实现（替换为新 `request_ai_title` 命令） |
| `app_data_dir/acp/` | 旧工作目录 |

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|--------|
| opencode serve SSE permission 事件格式未完全确认 | 实现前通过 `GET /doc` OpenAPI spec 验证事件类型和字段名 |
| `PATCH /config` 热更新端点是否存在未验证 | 实现前通过 `GET /doc` 确认端点存在；若不存在则改为重启 serve 进程加载新配置 |
| Elicitation 降级影响 Agent 能力 | Agent 提示词中明确要求用自然语言收集用户输入 |
| serve 进程崩溃导致所有 session 不可用 | 崩溃监控线程自动重启，最多重试 3 次，前端显示重连提示 |
| MCP 工具注册时机（serve 先于 MCP server 启动） | MCP server 先启动，写入 config.json，再启动 serve |
| 旧 localStorage session 数据升级兼容 | 首次启动检测到旧数据时直接丢弃，以服务端为准 |
