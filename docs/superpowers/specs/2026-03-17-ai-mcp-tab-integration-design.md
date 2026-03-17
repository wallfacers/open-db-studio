# AI 助手 MCP Tab 联动设计文档

**日期**：2026-03-17
**状态**：已批准
**范围**：AI 助手通过 MCP Server 读取并操作 Tab 内容（数据库表结构、业务指标），支持多轮对话式操作

---

## 背景

当前 AI 助手已具备基础对话能力和 SQL diff 确认体系，但无法感知或操作已打开的 Tab 内容（指标定义、表结构）。本设计扩展 AI 助手为具备"操作型工具箱"的智能体，通过扩展现有 MCP Server + OpenCode Skills 实现 Tab 联动与按需工具加载。

---

## 一、整体架构

```
用户输入
  │
  ▼
AI（LLM，按需注入 skill 工具定义）
  │  MCP tool call
  ▼
MCP Client（opencode-cli 内置）
  │  HTTP JSON-RPC（现有 19876 端口）
  ▼
Tauri MCP Server（扩展现有 src-tauri/src/mcp/mod.rs）
  ├── 数据类工具 → 调用现有 Rust 命令（或新增带事务命令）
  └── UI 类工具  → Tauri Event 推送给 WebView → React 监听 → 前端回传结果
```

### 现有 MCP Server 扩展方式

`src-tauri/src/mcp/mod.rs` 已是基于 axum 的完整 MCP HTTP Server（监听 19876 端口，实现 JSON-RPC，处理 `tools/list` 和 `tools/call`）。本期新工具**追加到现有 `tool_definitions()` 函数**，不新增端口或独立端点。

新增工具实现拆分到子模块：

```
src-tauri/src/mcp/
├── mod.rs              # 现有：注册工具、分发调用，新增工具追加到此
└── tools/              # 新增子模块目录
    ├── db_read.rs      # list_databases / list_tables 等（复用现有 datasource 命令）
    ├── tab_control.rs  # focus_tab / open_tab / search_tabs / get_tab_content（Tauri Event 桥接）
    ├── metric_edit.rs  # get_metric / update_metric_definition / create_metric
    ├── table_edit.rs   # get_column_meta / update_column_comment（DDL 执行）
    └── history.rs      # get_change_history / undo_last_change
```

### Skill 按需加载说明

"按需加载"发生在 **opencode 侧**（System Prompt 注入层），不影响 MCP Server 的 `tools/list` 响应。MCP Server 始终返回全部工具；opencode 根据当前 Tab 上下文决定将哪些 skill（工具描述）注入 System Prompt，使 AI 只感知相关工具，避免上下文膨胀。

### Tab 发现策略

**当前 Tab 优先，找不到再主动搜索并自动打开：**

1. 优先读取 `active_tab` 上下文
2. 若目标不在已打开 Tab 中，调用 `search_tabs` 搜索
3. 仍未找到则调用 `search_db_metadata` 查全局元数据（见第二章说明）
4. 找到后调用 `open_tab` 自动打开，等待前端回传确认后再继续（见第三章 open_tab 完成确认机制）

---

## 二、工具目录与 Skill 分组

按场景按需加载，共 5 个 skill，14 个工具。**工具参数统一使用 snake_case**，与现有 MCP 工具保持一致。

| Skill | 加载时机 | 工具列表 |
|-------|---------|---------|
| `db-read` | 始终加载（基础，token 占用小） | `list_databases` `list_tables` `get_table_schema` `get_table_sample` `search_db_metadata` |
| `tab-control` | active_tab 找不到目标时懒加载 | `search_tabs` `get_tab_content` `focus_tab` `open_tab` |
| `metric-edit` | active_tab.type === 'metric' \| 'metric_list' | `get_metric` `update_metric_definition` `create_metric` |
| `table-edit` | active_tab.type === 'table_structure' | `get_column_meta` `update_column_comment` |
| `history` | 消息含撤销/undo/恢复/回滚关键词 | `get_change_history` `undo_last_change` |

单次对话最多注入 **6～9 个工具**，避免上下文膨胀。

### search_db_metadata 实现说明

该工具**仅搜索已缓存的元数据**（`treeStore` 中已加载过的节点），不实时遍历所有连接。匹配逻辑：
- 按表名/视图名（英文）做前缀/模糊匹配
- 不支持中文别名搜索（表名本身为英文）
- 若目标库从未展开过（无缓存），返回空结果，需提示用户先展开对应数据库节点

---

## 三、前后端双向桥接

UI 类工具需要 Rust 与 React 双向通信，参照现有 `propose_sql_diff` 的 oneshot channel 模式统一设计。

### AppState 新增字段

UI 类工具与读方向查询使用 HashMap 存储 pending channel，支持并发挂起多个请求（按 `request_id` 区分）：

```rust
// AppState 新增（src-tauri/src/state.rs）
pub pending_ui_actions: tokio::sync::Mutex<
    HashMap<String, tokio::sync::oneshot::Sender<UiActionResponse>>
>,
pub pending_queries: tokio::sync::Mutex<
    HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>
>,
```

Agent loop 工具调用为串行，但设计上允许并发挂起以防未来扩展。`request_id` 由 MCP Server 生成（UUID），前端回传时携带以匹配对应 channel。

### 写方向（Rust → React）

```
MCP Server 接收 focus_tab / open_tab 调用
  ↓ emit Tauri Event: "mcp://ui-action"
  ↓ payload: { request_id, action, params }
React useEffect 监听
  ↓ 执行操作（更新 Zustand Store）
  ↓ invoke('mcp_ui_action_respond', { request_id, success, data })
Rust oneshot channel 接收
  ↓ 继续后续工具调用流程
```

### 读方向（Rust → React → Rust）

`search_tabs` 和 `get_tab_content` 需要读取前端 Zustand Store 中的 `tabs` 数组：

```
MCP Server 接收 search_tabs / get_tab_content 调用
  ↓ emit Tauri Event: "mcp://query-request"
  ↓ payload: { request_id, query_type, params }
React useEffect 监听
  ↓ 从 queryStore 读取 tabs / sqlContent / results
  ↓ invoke('mcp_query_respond', { request_id, data: JSON })
Rust oneshot channel 接收结果
  ↓ 返回给 AI
```

### open_tab 完成确认

`open_tab` 必须等待前端确认 Tab 已真正打开后才返回，避免 AI 立即调用 `get_tab_content` 取到空内容：

```
Rust emit "mcp://ui-action" { action: "open_tab", ... }
  ↓ React 打开 Tab → Zustand 更新完成后
  ↓ invoke('mcp_ui_action_respond', { request_id, success: true, data: { tab_id } })
Rust 收到确认 → 返回 { tab_id } 给 AI
AI 收到 tab_id → 再调用 get_tab_content
```

---

## 四、MCP Server 工具实现

### change_history 表（内置 SQLite 新增）

```sql
CREATE TABLE change_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  target_type TEXT NOT NULL,   -- 'metric' | 'column'
  target_id   TEXT NOT NULL,   -- metric_id 或 conn_id+table+column
  old_value   TEXT NOT NULL,   -- JSON 快照（修改前）
  new_value   TEXT,            -- JSON 快照（修改后，执行失败时为 NULL）
  status      TEXT NOT NULL,   -- 'success' | 'failed' | 'undone'
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_change_history_session ON change_history(session_id, id DESC);
```

### 写操作策略（补偿式，非跨库事务）

由于外部数据库（MySQL/PostgreSQL）与内置 SQLite 无法共享事务，采用补偿式策略：

```
1. 读取当前值（外部 DB 或 SQLite）→ 写 change_history（status='pending', old_value=当前值）
2. 执行外部操作（ALTER TABLE COMMENT / update_metric）
   - 成功 → 更新 change_history（new_value=新值, status='success'）
   - 失败 → 更新 change_history（status='failed'）→ 返回错误给 AI
3. 不存在跨库回滚，失败时已有 old_value 可供 undo 参考
```

`change_history` 中 `status='failed'` 的记录不可撤销，`undo_last_change` 只处理 `status='success'` 的记录。

### undo_last_change 行为规范

- **作用域**：按 `session_id` 隔离，每个 AI session 只撤销本 session 的操作
- **顺序**：LIFO（最后一条 `status='success'` 的记录）
- **执行**：读取 `old_value` → 执行反向操作（改回旧值）→ 更新该记录 `status='undone'`
- **错误处理**：反向操作失败时不修改 `status`，返回错误信息给 AI
- **不支持撤销的情况**：`target_type='column'` 且操作为改列名/改列类型（本期不暴露此类工具，下期单独设计）

---

## 五、Auto 模式与确认机制

### autoMode 存储位置

`autoMode` 在 **Rust `AppState`** 中维护（`Arc<Mutex<bool>>`），前端通过 Tauri invoke 读写：

```rust
// AppState 新增
pub auto_mode: Arc<Mutex<bool>>,

// 新增命令
#[tauri::command]
pub fn get_auto_mode(state: State<AppState>) -> bool { ... }

#[tauri::command]
pub fn set_auto_mode(state: State<AppState>, enabled: bool) { ... }
```

前端 `appStore` 新增 `autoMode: boolean`，通过 `invoke('get_auto_mode')` 初始化，通过 `invoke('set_auto_mode')` 同步到 Rust。

MCP Server 在执行写工具前直接读取 `AppState.auto_mode`，决定是否走 ACP 确认流程。

### autoMode 作用域

`autoMode` 为**全局设置**（非 session 级），持久化到内置 SQLite `app_settings` 表（已存在于 `schema/init.sql`，key/value 结构），key 为 `"auto_mode"`，value 为 `"true"` / `"false"`。App 重启后保持用户上次的选择，默认为 `false`。

### 执行路径

**Auto ON：** MCP Server 直接执行写操作 → AI 回复结果 + 提示可撤销
**Auto OFF：** MCP Server 通过 ACP 发起 `request_permission` → 用户确认后执行

### 危险操作分级保护

| 操作 | 风险级别 | 保护措施 |
|------|---------|---------|
| `update_metric_definition` | 低 | 写 change_history，可撤销 |
| `update_column_comment` | 低 | 写 change_history，可撤销 |
| `update_column_meta`（改类型/改名） | 高 | 强制 ACP 确认，忽略 Auto 模式（下期实现） |
| DROP / TRUNCATE 类 | 极高 | 不暴露为 MCP 工具，AI 无法执行 |

### UI

助手面板顶部新增 Auto 模式开关；非 Auto 模式显示橙色提示徽标。

---

## 六、Skill 同步机制

### 目录结构

**源文件（跟随代码库，跟随 Tauri 资源打包）：**
```
src-tauri/skills/
├── db-read/SKILL.md
├── tab-control/SKILL.md
├── metric-edit/SKILL.md
├── table-edit/SKILL.md
└── history/SKILL.md
```

`src-tauri/tauri.conf.json` 的 `bundle.resources` 添加 `skills/**`，使其打包进二进制。

**同步目标（运行时生成，不入库）：**
```
{OPENCODE_CONFIG_DIR}/skills/   # 优先（读取 OPENCODE_CONFIG 环境变量，取父目录）
app_config_dir()/skills/        # fallback（Tauri 标准路径，开发/打包行为一致）
```

`.opencode/` 加入 `.gitignore`。

### 同步逻辑（`src-tauri/src/skill_sync.rs`）

```rust
pub fn sync_skills_on_startup(app: &AppHandle) {
    // 1. 确定源文件目录（Tauri resource 路径，打包后依然有效）
    let src_dir = app.path().resource_dir()
        .expect("resource dir")
        .join("skills");

    // 2. 确定目标目录
    let target_dir = if let Ok(cfg) = std::env::var("OPENCODE_CONFIG") {
        PathBuf::from(cfg)
            .parent()
            .map(|p| p.join("skills"))
            .unwrap_or_else(|| app.path().app_config_dir().unwrap().join("skills"))
    } else {
        app.path().app_config_dir().unwrap().join("skills")
    };

    // 3. 遍历每个 skill，SHA256 比对后按需复制
    for skill_dir in read_dir(&src_dir) {
        let src = skill_dir.join("SKILL.md");
        let dst = target_dir.join(skill_dir.file_name()).join("SKILL.md");

        if !dst.exists() {
            fs::create_dir_all(dst.parent().unwrap()).ok();
            fs::copy(&src, &dst).ok();
        } else if sha256_file(&src) != sha256_file(&dst) {
            fs::copy(&src, &dst).ok();
        }
        // 相同则跳过
    }
    // 只写本项目定义的 5 个 skill，不删除目标目录其他文件
}
```

---

## 七、典型操作流程示例

**场景：修改 addresses 表的 user_id 列注释（Auto OFF）**

```
用户："帮我把 addresses 表的 user_id 描述改为'用户唯一ID'"

AI：
  1. 检查 active_tab → 不是 table_structure 类型
  2. [加载 tab-control skill]
  3. search_tabs(table_name="addresses", type="table_structure")
     → emit "mcp://query-request" → React 回传 tabs 数据 → 未找到
  4. search_db_metadata(keyword="addresses")
     → 从 treeStore 缓存查到 conn_1.ecommerce.addresses
  5. open_tab(connection_id=1, type="table_structure", table_name="addresses")
     → emit "mcp://ui-action" → React 打开 Tab → 回传 { tab_id: "tab_xyz" }
  6. [加载 table-edit skill]
  7. get_column_meta(connection_id=1, table_name="addresses")
     → emit "mcp://query-request" → React 回传 Tab 内列数据
     → user_id 当前 comment 为空
  8. [Auto OFF → request_permission → 用户点击"允许"]
  9. update_column_comment(connection_id=1, table_name="addresses",
       column_name="user_id", comment="用户唯一ID")
     → 写 change_history(status='pending', old_value='')
     → ALTER TABLE addresses MODIFY COLUMN user_id ... COMMENT '用户唯一ID'
     → 更新 change_history(new_value='用户唯一ID', status='success')
 10. AI 回复："已将 addresses.user_id 注释更新为「用户唯一ID」，
          可输入「撤销」回滚此修改。"
```

---

## 八、新增 Tauri 命令清单

以下命令需在 `src-tauri/src/commands.rs` 中实现并在 `lib.rs` 的 `generate_handler![]` 中注册：

| 命令名 | 用途 |
|-------|------|
| `get_auto_mode` | 读取当前 autoMode 值 |
| `set_auto_mode` | 设置 autoMode 并持久化到 app_settings |
| `mcp_ui_action_respond` | 前端回传 UI 操作完成结果（写方向） |
| `mcp_query_respond` | 前端回传 Store 数据查询结果（读方向） |

> **实现注意**：`AppState` 新增的 `pending_ui_actions` 和 `pending_queries` 字段，需同步在 `src-tauri/src/lib.rs` 的 `AppState` 初始化块中赋初值（`Default::default()` 或 `Mutex::new(HashMap::new())`）。字段类型统一使用 `tokio::sync::Mutex`，与现有 `AppState` 字段保持一致，`auto_mode` 同理（`tokio::sync::Mutex<bool>`，无需外层 `Arc`）。

---

## 九、不在本期范围

- `update_column_meta`（改列名/类型）— 高风险，下期单独设计
- 批量跨表操作
- Skill 热重载（启动时同步即可）
- `.claude/skills/` 支持（明确不在本期）
- `search_db_metadata` 中文别名搜索（表名本身为英文，暂不支持）
- `change_history` 历史数据清理（本期不实现，下期按 session 老化策略处理）
