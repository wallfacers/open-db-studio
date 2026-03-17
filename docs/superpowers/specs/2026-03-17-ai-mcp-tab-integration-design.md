# AI 助手 MCP Tab 联动设计文档

**日期**：2026-03-17
**状态**：已批准
**范围**：AI 助手通过 MCP Server 读取并操作 Tab 内容（数据库表结构、业务指标），支持多轮对话式操作

---

## 背景

当前 AI 助手已具备基础对话能力和 SQL diff 确认体系，但无法感知或操作已打开的 Tab 内容（指标定义、表结构）。本设计扩展 AI 助手为具备"操作型工具箱"的智能体，通过 MCP Server + OpenCode Skills 实现 Tab 联动与按需工具加载。

---

## 一、整体架构

```
用户输入
  │
  ▼
AI（LLM，按需注入 skill 工具定义）
  │  MCP tool call
  ▼
MCP Client（Rust，现有 acp/client.rs 扩展）
  │  MCP 协议
  ▼
Tauri MCP Server（Rust 新增模块）
  ├── 数据类工具 → 调用现有 Rust 命令（或新增带事务命令）
  └── UI 类工具  → Tauri Event 推送给 WebView → React 更新 Zustand Store
```

### Tab 发现策略

**当前 Tab 优先，找不到再主动搜索并自动打开：**

1. 优先读取 `activeTab` 上下文
2. 若目标不在已打开 Tab 中，调用 `search_tabs` 搜索
3. 仍未找到则调用 `search_db_metadata` 查全局元数据
4. 找到后调用 `open_tab` 自动打开，再执行后续操作

---

## 二、工具目录与 Skill 分组

按场景按需加载，共 5 个 skill，14 个工具：

| Skill | 加载时机 | 工具列表 |
|-------|---------|---------|
| `db-read` | 始终加载（基础，token 占用小） | `list_databases` `list_tables` `get_table_schema` `get_table_sample` `search_db_metadata` |
| `tab-control` | activeTab 找不到目标时懒加载 | `search_tabs` `get_tab_content` `focus_tab` `open_tab` |
| `metric-edit` | activeTab.type === 'metric' \| 'metric_list' | `get_metric` `update_metric_definition` `create_metric` |
| `table-edit` | activeTab.type === 'table_structure' | `get_column_meta` `update_column_comment` |
| `history` | 消息含撤销/undo/恢复/回滚关键词 | `get_change_history` `undo_last_change` |

单次对话最多注入 **6～9 个工具**，避免上下文膨胀。

---

## 三、MCP Server 设计（Rust 层）

### 新增模块结构

```
src-tauri/src/mcp/
├── mod.rs              # 现有（MCP client）
├── server.rs           # 新增：MCP Server 主逻辑
└── tools/
    ├── db_read.rs      # 复用现有 datasource 命令
    ├── tab_control.rs  # 通过 Tauri Event 驱动前端
    ├── metric_edit.rs  # 复用现有命令 + 写 change_history
    ├── table_edit.rs   # 新增 DDL 执行（ALTER TABLE）
    └── history.rs      # 读写 change_history 表
```

### UI 类工具的前后端桥接

```
MCP Server（Rust）接收 focus_tab / open_tab 调用
  ↓ emit Tauri Event: "mcp://ui-action"
  ↓ payload: { action: "focus_tab", tabId: "xxx" }
React useEffect 监听
  ↓ queryStore.setActiveTabId(tabId)  /  queryStore.openXxxTab(...)
```

### change_history 表（内置 SQLite 新增）

```sql
CREATE TABLE change_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  target_type TEXT NOT NULL,   -- 'metric' | 'column'
  target_id   TEXT NOT NULL,   -- metricId 或 connId+table+column
  old_value   TEXT NOT NULL,   -- JSON 快照（修改前）
  new_value   TEXT NOT NULL,   -- JSON 快照（修改后）
  created_at  TEXT NOT NULL
);
```

### 写操作原子性

```
BEGIN TRANSACTION
  1. 读取当前值 → 写 change_history.old_value
  2. 执行修改（update_metric / ALTER TABLE COMMENT）
  3. 写 change_history.new_value
COMMIT  ← 全部成功才提交，任一失败全部回滚
```

---

## 四、Auto 模式与确认机制

### appStore 新增

```typescript
autoMode: boolean        // 默认 false
toggleAutoMode: () => void
```

### System Prompt 注入

每次对话构建时追加：

```
## 执行模式
当前模式：{{AUTO_MODE ? "Auto（直接执行）" : "确认模式（写操作前请求用户确认）"}}
```

### 执行路径

**Auto ON：** AI 直接调用写工具 → 完成后告知结果 + 提示可撤销
**Auto OFF：** AI 调用 `request_permission`（现有 ACP 体系）→ 用户确认后执行

### 危险操作分级保护

| 操作 | 风险级别 | 保护措施 |
|------|---------|---------|
| `update_metric_definition` | 低 | 写 change_history，可撤销 |
| `update_column_comment` | 低 | 写 change_history，可撤销 |
| `update_column_meta`（改类型/改名） | 高 | 强制 ACP 确认，忽略 Auto 模式 |
| DROP / TRUNCATE 类 | 极高 | 不暴露为 MCP 工具，AI 无法执行 |

### UI

助手面板顶部新增 Auto 模式开关；非 Auto 模式显示橙色提示徽标。

---

## 五、Skill 同步机制

### 目录结构

**源文件（跟随代码库）：**
```
src-tauri/skills/
├── db-read/SKILL.md
├── tab-control/SKILL.md
├── metric-edit/SKILL.md
├── table-edit/SKILL.md
└── history/SKILL.md
```

**同步目标（运行时生成，不入库）：**
```
{OPENCODE_CONFIG_DIR}/skills/   # 优先
.opencode/skills/               # fallback（项目级）
```

`.opencode/` 加入 `.gitignore`。

### 同步逻辑（`src-tauri/src/skill_sync.rs`）

```rust
pub fn sync_skills_on_startup() {
    let target_dir = if let Ok(cfg) = std::env::var("OPENCODE_CONFIG") {
        PathBuf::from(cfg).parent().unwrap().join("skills")
    } else {
        project_root().join(".opencode/skills")
    };

    for skill_dir in read_dir("skills") {
        let src = skill_dir.join("SKILL.md");
        let dst = target_dir.join(skill_dir.name()).join("SKILL.md");

        if !dst.exists() {
            copy(src, dst);
        } else if sha256(&src) != sha256(&dst) {
            copy(src, dst);
        }
        // 相同则跳过
    }
}
```

**约束：**
- 只写本项目定义的 5 个 skill，不删除目标目录其他文件
- 每个 SKILL.md 内容不同才覆盖（SHA256 比对）

---

## 六、典型操作流程示例

**场景：修改 addresses 表的 user_id 列描述**

```
用户：帮我把 addresses 表的 user_id 描述改为"用户唯一ID"

AI：
  1. 检查 activeTab → 不是 table_structure 类型
  2. [加载 tab-control skill]
  3. search_tabs(tableName="addresses", type="table_structure")
     → 未找到
  4. search_db_metadata(keyword="addresses")
     → 找到 conn_01.ecommerce.addresses
  5. open_tab(type="table_structure", connectionId=1, table="addresses")
     → Tab 打开，React 切换到该 Tab
  6. [加载 table-edit skill]
  7. get_column_meta(connectionId=1, table="addresses")
     → user_id 当前 comment 为空
  8. [Auto OFF → request_permission → 用户确认]
  9. update_column_comment(connectionId=1, table="addresses",
       column="user_id", comment="用户唯一ID")
     → 写 change_history → ALTER TABLE → COMMIT
 10. 回复："已将 addresses.user_id 描述更新为「用户唯一ID」，
          可输入「撤销」回滚此修改。"
```

---

## 七、不在本期范围

- `update_column_meta`（改列名/类型）— 高风险，下期单独设计
- 批量跨表操作
- Skill 热重载（启动时同步即可）
- `.claude/skills/` 支持（明确不在本期）
