# UI 状态全量持久化设计文档

**日期：** 2026-03-17
**状态：** 已批准

---

## 背景与问题

当前应用的 UI 状态持久化方案不完整：

- `expandedIds`（DB 树和指标树的展开状态）仅存于 Zustand 内存，应用重启后丢失
- 已打开的连接 ID、查询标签页等使用 `localStorage` 持久化，桌面应用中不够可靠
- 查询标签页的 SQL 内容随 `unified_tabs_state` 存入 `localStorage`，数据量大时有压力

用户期望：**应用重启后，DB 树和指标树的所有展开层级能完整恢复，且连接不可用时优雅降级。**

---

## 目标

1. 将所有 UI 状态从 `localStorage` 迁移到内置 SQLite
2. 树状态（DB 树 + 指标树）完整持久化所有展开层级
3. 标签页 SQL 内容改为本地文件存储，关闭标签页时删除对应文件
4. 启动时检测连接可用性，不可用的连接保持默认折叠状态（灰图标）
5. 兼容旧 `localStorage` 数据，首次启动自动迁移后清除旧键

---

## 架构设计

```
前端 Zustand Store
    ↕ 订阅/防抖写入
Tauri invoke 命令层
    ↕
内置 SQLite (ui_state 表)   +   AppData/open-db-studio/tabs/{tabId}.sql
```

---

## SQLite Schema 变更

在 `schema/init.sql` 新增（已有 `app_settings` 键值表，`ui_state` 专用于 UI 状态，语义分离）：

```sql
CREATE TABLE IF NOT EXISTS ui_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 存储键清单

| key | 类型 | 内容 |
|-----|------|------|
| `tree_expanded_ids` | JSON array of string | DB 树展开节点 ID 列表 |
| `metrics_tree_expanded_ids` | JSON array of string | 指标树展开节点 ID 列表 |
| `opened_connection_ids` | JSON array of number | 已打开连接 ID 列表 |
| `tabs_metadata` | JSON array of Tab（不含 SQL） | 标签页元数据 |
| `active_tab_id` | string | 当前激活标签页 ID |

---

## 文件存储（SQL 内容）

- **路径：** `{AppDataDir}/open-db-studio/tabs/{tabId}.sql`
- **创建：** 标签页 SQL 内容首次写入时，由 Rust 创建文件
- **更新：** SQL 变化时防抖 500ms 写入
- **删除：** 标签页关闭时立即删除对应文件（Rust 端执行）
- **写入顺序：** 先写文件（`write_tab_file`），再写元数据（`set_ui_state('tabs_metadata', ...)`），防止元数据有记录但文件未创建
- **孤儿文件清理：** 启动时 `list_tab_files()` 与 `tabs_metadata` 对比，删除无对应 tab 的文件。若上次写文件后崩溃（元数据未写入），该文件会被判定为孤儿并删除，属于可接受的数据丢失（SQL 内容恢复为空）

---

## Rust 命令接口

```
// UI 状态 CRUD
get_ui_state(key: String)                       → Result<Option<String>>
set_ui_state(key: String, value: String)        → Result<()>
delete_ui_state(key: String)                    → Result<()>

// 连接可用性检测（按 ID，从 SQLite 读取配置后调用）
test_connection_by_id(connection_id: i64)       → Result<bool>

// SQL 文件管理
read_tab_file(tab_id: String)                   → Result<Option<String>>
write_tab_file(tab_id: String, content: String) → Result<()>
delete_tab_file(tab_id: String)                 → Result<()>
list_tab_files()                                → Result<Vec<String>>
```

所有命令在 `src-tauri/src/commands.rs` 实现，在 `lib.rs` 注册。

**注意：** `test_connection_by_id` 在后端直接从 SQLite 读取连接配置，解密密码后发起连接测试，超时设置为 3 秒。前端无需传递完整连接配置。

---

## 树状态恢复算法

### DB 树

**关键约束：** `treeStore.init()` 目前会重置 `expandedIds: new Set()`。实现时需修改 `init()` 使其**不再重置** `expandedIds`，展开状态由恢复逻辑独立管理。

**调用时序：**
1. `treeStore.init()` — 加载 group/connection 节点列表（不重置 expandedIds）
2. 读取持久化状态
3. 执行恢复逻辑

```
启动时：
1. 从 SQLite 读 opened_connection_ids + tree_expanded_ids
2. 对每个 opened_connection_id：
   a. invoke test_connection_by_id(id) → 检测可用性（后端超时 3s）
   b. 可用 → 深度优先恢复 expandedIds：
        - 展开 conn 节点 → loadChildren → 展开 db 节点 → loadChildren → ...
        - 按 tree_expanded_ids 中的 ID 决定是否继续向下展开
   c. 不可用 → 跳过，节点保持默认状态（灰图标，折叠）
3. 持久化：expandedIds 变化 → 防抖 800ms → set_ui_state('tree_expanded_ids', ...)
```

### 指标树

```
启动时：
1. 从 SQLite 读 metrics_tree_expanded_ids
2. 直接恢复展开状态（指标树无网络连接，无需可用性检查）
3. 持久化：expandedIds 变化 → 防抖 800ms → set_ui_state('metrics_tree_expanded_ids', ...)
```

---

## localStorage 迁移策略

| 原 localStorage key | 迁移目标 |
|---------------------|---------|
| `open-db-studio-opened-connections` | SQLite `opened_connection_ids` |
| `unified_tabs_state`（元数据） | SQLite `tabs_metadata` + `active_tab_id` |
| `unified_tabs_state`（SQL 内容） | 文件系统 `tabs/{tabId}.sql` |
| `metrics_tabs_state`（旧 key）| 废弃丢弃，不迁移（仅作为兜底 fallback 读取 `unified_tabs_state` 时的备用键，读取后立即清除） |

**迁移时机：** Explorer 组件首次挂载时，检查 localStorage 是否有旧数据 → 迁移 → 清除旧键。

---

## 前端改动范围

**已确认存在的文件（来自代码探查）：**
- `src/store/connectionStore.ts` — 包含 `saveOpenedConnectionIds` / `loadOpenedConnectionIds` 和 `OPENED_CONNECTIONS_KEY`
- `src/store/queryStore.ts` — 包含 `unified_tabs_state` 的 localStorage 订阅和 `loadTabsFromStorage`
- `src/store/treeStore.ts` — `init()` 中有 `expandedIds: new Set()` 需要去除
- `src/components/Explorer/index.tsx` — 包含 `restoreOpenedConnections` 启动恢复逻辑

| 文件 | 改动 |
|------|------|
| `src/store/treeStore.ts` | 移除 `init()` 中的 `expandedIds: new Set()` 重置；新增防抖持久化和 `loadPersistedTreeExpandedIds()` |
| `src/store/metricsTreeStore.ts` | 同上，针对指标树；**同时移除 `init()` 中的 `expandedIds: new Set()` 重置，以及 `refresh()` 中的显式 `set({ expandedIds: new Set() })` 重置** |
| `src/store/connectionStore.ts` | `saveOpenedConnectionIds` / `loadOpenedConnectionIds` 改为 async invoke ui_state；`openConnection` / `closeConnection` 内部使用 fire-and-forget（不 await），调用方无需改动 |
| `src/store/queryStore.ts` | 删除模块顶层同步的 `loadTabsFromStorage()` 调用和底部 `useQueryStore.subscribe()` localStorage 订阅；改为异步初始化（模块外部 loadTabsFromStorage().then(setState)）；元数据改为 ui_state，SQL 内容改为 write_tab_file；tab 关闭时 delete_tab_file |
| `src/components/Explorer/index.tsx` | 恢复逻辑改为全层级深度优先，使用 `test_connection_by_id` 检测可用性 |
| `src-tauri/src/commands.rs` | 新增 8 个命令（`get_ui_state`、`set_ui_state`、`delete_ui_state`、`test_connection_by_id`、`read_tab_file`、`write_tab_file`、`delete_tab_file`、`list_tab_files`） |
| `src-tauri/src/lib.rs` | 注册新命令 |
| `schema/init.sql` | 新增 `ui_state` 表 |

---

## 错误处理

- 连接不可用：静默跳过（不弹 toast），节点保持默认折叠状态
- SQLite 读写失败：静默降级，不影响正常功能
- 文件读写失败：SQL 内容为空字符串，不阻断 tab 恢复
- 孤儿文件：启动时静默清理
