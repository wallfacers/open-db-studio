# SeaTunnel 迁移中心树结构改造设计文档

**日期**：2026-03-21
**状态**：✅ 已实现
**实现日期**：2026-03-26

---

## 背景与目标

当前迁移中心（SeaTunnelExplorer）的目录树以 `category`（目录）或 `job`（作业）作为根节点，集群连接（SeaTunnel Connection）仅作为 Job 上的一个属性显示（`#connectionId` 徽章），用户创建集群后无法在树中直观看到。

**改造目标**：
- 集群作为树的根节点，直观展示所有已配置的集群
- 集群下支持目录和作业两种子节点，目录可无限嵌套（去掉旧的 depth ≤ 2 限制）
- 同一集群下的作业不再需要单独选择集群
- 作业和目录名称支持通过右键菜单触发内联重命名

---

## 数据库变更

### `st_categories` 表新增列

```sql
ALTER TABLE st_categories ADD COLUMN connection_id INTEGER REFERENCES seatunnel_connections(id) ON DELETE CASCADE;
```

**语义规则**：
- **根目录**（`parent_id IS NULL`）：`connection_id` 必须非空，表示归属的集群
- **子目录**（`parent_id IS NOT NULL`）：`connection_id` 为 null，通过递归查父节点得到所属集群
- **Job（直属集群根节点）**：`category_id = null`，`connection_id = N`（现有逻辑不变）
- **Job（位于目录下）**：`category_id` 有值，`connection_id` 可选存储（冗余）
- 两者（`category_id` 和 `connection_id`）均为 null 的 Job → 不在树中显示

### 迁移策略（V12 Migration）

在 `src-tauri/src/db/migrations.rs` 的 `run_migrations()` 末尾新增 V12 migration。
SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，必须用 `PRAGMA table_info` 检查列存在性，与现有 V5、V11 等迁移保持一致：

```rust
// V12: st_categories 新增 connection_id
let cols: HashSet<String> = {
    let mut stmt = conn.prepare("PRAGMA table_info(st_categories)")?;
    stmt.query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect()
};
if !cols.contains("connection_id") {
    conn.execute_batch(
        "ALTER TABLE st_categories ADD COLUMN connection_id INTEGER REFERENCES seatunnel_connections(id) ON DELETE CASCADE;"
    )?;
}
```

现有 `connection_id = null` 的根目录不在新树中显示，存量数据静默忽略。

### 级联删除说明

当用户删除集群时，下属内容的处理：

1. **根目录**（`connection_id = N`）：`ON DELETE CASCADE` → 自动删除
2. **子目录**：通过 `parent_id ON DELETE CASCADE` 递归删除
3. **直属集群的 Job**（`category_id = null, connection_id = N`）：现有 DDL 为 `ON DELETE SET NULL`，会导致 Job 成为孤儿

**解决方案**：Rust 的 `delete_st_connection` 命令中先手动删除孤儿 Job，再删除连接：

```sql
-- 先删直属集群的无 category Job
DELETE FROM seatunnel_jobs WHERE connection_id = ?1 AND category_id IS NULL;
-- 再删连接（级联删根目录及子目录）
DELETE FROM seatunnel_connections WHERE id = ?1;
```

---

## 节点模型

### `STTreeNode.nodeType` 扩展

```typescript
nodeType: 'connection' | 'category' | 'job'
```

### `meta` 字段

```typescript
meta: {
  // connection 节点专用
  connectionId?: number
  connectionUrl?: string
  // category 节点专用
  categoryId?: number
  sortOrder?: number
  // job 节点专用
  jobId?: number
  status?: string
  // 通用：相对于 category 层的深度，0 = connection 直接子目录
  depth?: number
}
```

**`depth` 语义说明**：`depth` 仍以 `category` 为基准，`depth=0` 表示直接挂在 connection 下的目录。`connection` 节点本身不计入 depth。现有 `CategoryEditModal` 的深度限制逻辑（`>= 2` 报错）已在本次改造中**废弃**，目录允许无限嵌套。

### 节点 ID 规则

| 类型 | ID 格式 |
|------|---------|
| connection | `conn_N` |
| category | `cat_N` |
| job | `job_N` |

---

## 后端命令变更（`seatunnel/commands.rs`）

### 修改：`list_st_categories`

SQL 查询需包含 `connection_id` 列，`json!{}` 中同步添加：

```sql
SELECT id, name, parent_id, connection_id, sort_order, created_at FROM seatunnel_categories ORDER BY sort_order, name
```

### 修改：`create_st_category`

Rust 函数签名新增 `connection_id: Option<i64>` 参数，INSERT SQL 同步更新：

```rust
#[tauri::command]
pub async fn create_st_category(
    name: String,
    parent_id: Option<i64>,
    connection_id: Option<i64>,   // 新增
    state: tauri::State<'_, AppState>,
) -> Result<i64, String>
```

```sql
INSERT INTO seatunnel_categories (name, parent_id, connection_id, sort_order, created_at)
VALUES (?1, ?2, ?3, ?4, ?5)
```

### 修改：`create_st_job`

新增 `connection_id: Option<i64>` 参数，支持直接挂在集群根节点下的作业创建：

```rust
#[tauri::command]
pub async fn create_st_job(
    name: String,
    category_id: Option<i64>,
    connection_id: Option<i64>,   // 新增
    state: tauri::State<'_, AppState>,
) -> Result<i64, String>
```

INSERT SQL 同步包含 `connection_id` 字段。

### 新增：`rename_st_job`

```rust
#[tauri::command]
pub async fn rename_st_job(
    id: i64,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String>
```

### 修改：`delete_st_connection`

在删除连接前先清理孤儿 Job（见"级联删除说明"章节）。

### 无需新增的后端命令

`update_st_connection`、`delete_st_connection` 均已存在，Store 中新增对应 Action 直接调用即可。

---

## Store 变更（`seaTunnelStore.ts`）

### `init()` 新逻辑

1. 并行加载 `list_st_connections`、`list_st_categories`、`list_st_jobs`
2. 为每个 connection 生成 `conn_N` 根节点（`parentId = null`）
3. 根目录（`parent_id = null && connection_id = N`）挂在对应 `conn_N` 下
4. 子目录递归挂在父目录下（无深度限制）
5. Job 按如下规则定位父节点：
   - `category_id` 有值 → `cat_X`
   - `category_id = null` 且 `connection_id` 有值 → `conn_N`
   - 其他 → 跳过（不加入树）

### 新增 / 修改的 Actions

```typescript
// 集群管理（调用已有 Rust 命令 update_st_connection / delete_st_connection）
editConnection: (id: number, name: string, url: string, authToken?: string) => Promise<void>
deleteConnection: (id: number) => Promise<void>

// 目录创建（新增 connectionId 参数，传给后端 create_st_category）
createCategory: (name: string, parentCategoryId?: number, connectionId?: number) => Promise<void>

// 作业重命名（新增，调用新 Rust 命令 rename_st_job）
renameJob: (id: number, name: string) => Promise<void>

// 作业创建（新增 connectionId 参数，传给后端 create_st_job）
createJob: (name: string, categoryId?: number, connectionId?: number) => Promise<number>
```

---

## UI 设计

### 树节点渲染

| 节点类型 | 图标 | 缩进 | 右侧信息 |
|---------|------|------|---------|
| `connection` | `Server`（`#00c9a7`） | 0 | 截断的集群 URL（`#7a9bb8`） |
| `category` | `Folder` / `FolderOpen` | depth × 16 + 8px | 无 |
| `job` | `Play` / `CircleStop` | depth × 16 + 8px | 运行状态徽章 |

**主题色规范**（延用现有）：
- 背景层：`#0d1117` / `#111922` / `#151d28`
- 边框：`#1e2d42` / `#253347`
- 主文字：`#c8daea` / `#e8f4ff`
- 次要文字：`#7a9bb8` / `#b5cfe8`
- 强调色：`#00c9a7` / `#00a98f`（集群图标、选中态）
- 悬停背景：`#1a2639`
- 选中背景：`#1e2d42`

### 右键菜单

**集群节点（connection）**：
1. 新建目录
2. 新建作业
3. —
4. 编辑集群配置（打开 SeaTunnelConnectionModal edit 模式）
5. 删除集群（二次确认，先删孤儿 Job 再删连接）

**目录节点（category）**：
1. 新建子目录
2. 新建作业
3. 重命名（触发内联编辑）
4. —
5. 删除目录（二次确认）

**作业节点（job）**：
1. 打开
2. 重命名（触发内联编辑）
3. 移动到目录
4. —
5. 删除作业

### 内联重命名交互

1. 右键菜单点击"重命名" → 该节点 label 替换为 `<input>`，自动聚焦并全选文本
2. `Enter` 或失焦 → 调用对应 rename action 保存
3. `Escape` → 取消，恢复原名
4. 输入为空 → 不保存，恢复原名

**重命名路径**：
- 目录重命名：调用现有 `renameCategory` Action（已有 Rust 命令 `rename_st_category`）
- 作业重命名：调用新增 `renameJob` Action（新增 Rust 命令 `rename_st_job`）
- `CategoryEditModal` 的 `rename` 模式**废弃**，Modal 仅保留 `create` 模式（新建目录）

### 工具栏变更

- **移除**：旧的"新建目录"按钮（改为集群右键菜单创建）
- **保留**：刷新按钮、`+ 连接`（新建集群）按钮

### 搜索行为兼容

`searchNodes` 和 `computeVisible` 函数需适配 `connection` 节点类型：
- 搜索时 `connection` 节点始终展开（与 `category` 节点保持一致）
- `computeVisible` 的 `visit(null)` 入口已能正确定位 `connection` 根节点（`parentId = null`）

### 空状态

- 无集群配置：显示提示文字"尚未配置集群，点击 + 连接添加"
- 集群下无内容：展开后内容区为空（不显示额外提示）

---

## 受影响的文件清单

| 文件 | 变更类型 |
|------|---------|
| `src-tauri/src/db/migrations.rs` | 新增 V12：PRAGMA table_info 检查后 ALTER TABLE 加 `connection_id` |
| `schema/init.sql` | 新增 `connection_id` 列 DDL；更新 `st_categories` 表注释（深度限制已废弃） |
| `src-tauri/src/seatunnel/commands.rs` | `list_st_categories` 新增 `connection_id` 字段；`create_st_category` 新增参数；`create_st_job` 新增 `connection_id` 参数；新增 `rename_st_job`；`delete_st_connection` 先删孤儿 Job |
| `src-tauri/src/lib.rs` | 在 `generate_handler![]` 中注册 `rename_st_job` |
| `src/store/seaTunnelStore.ts` | `init()` 重构；新增 `editConnection`、`deleteConnection`、`renameJob`；修改 `createCategory`、`createJob` 签名 |
| `src/components/SeaTunnelExplorer/SeaTunnelJobTree.tsx` | 完整重写树渲染与右键菜单逻辑；新增内联重命名 `<input>` 逻辑；搜索函数适配 `connection` 节点 |
| `src/components/SeaTunnelExplorer/index.tsx` | 移除"新建目录"工具栏按钮；传入 connection 操作回调 |
| `src/components/SeaTunnelExplorer/CategoryEditModal.tsx` | 新增 `connectionId` 参数；废弃 `rename` 模式（仅保留 `create` 模式） |

---

## 不在本次范围内

- 移动作业（Move Job）对话框的具体 UI（现有 TODO，保持占位）
- SeaTunnel Job 编辑器内部的集群选择器（Job 已从根节点继承集群，编辑器可在后续迭代更新）
