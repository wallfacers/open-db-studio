# SeaTunnel 迁移中心树结构改造设计文档

**日期**：2026-03-21
**状态**：已确认，待实现

---

## 背景与目标

当前迁移中心（SeaTunnelExplorer）的目录树以 `category`（目录）或 `job`（作业）作为根节点，集群连接（SeaTunnel Connection）仅作为 Job 上的一个属性显示（`#connectionId` 徽章），用户创建集群后无法在树中直观看到。

**改造目标**：
- 集群作为树的根节点，直观展示所有已配置的集群
- 集群下支持目录和作业两种子节点，目录可无限嵌套
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
- **Job**：`connection_id` 保持现有逻辑不变（直接存储在 `st_jobs` 表）
  - `category_id` 有值 → 挂在对应目录下
  - `category_id = null` 且 `connection_id` 有值 → 直接挂在集群根节点下
  - 两者均无 → 不在树中显示

### 迁移策略

在 `db/mod.rs` 的 `initialize_db()` 中执行（幂等）：

```sql
ALTER TABLE st_categories ADD COLUMN IF NOT EXISTS connection_id INTEGER REFERENCES seatunnel_connections(id) ON DELETE CASCADE;
```

现有 `connection_id = null` 的根目录不在新树中显示，存量数据静默忽略。

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
  // 通用
  depth?: number
}
```

### 节点 ID 规则

| 类型 | ID 格式 |
|------|---------|
| connection | `conn_N` |
| category | `cat_N` |
| job | `job_N` |

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
// 集群管理
editConnection: (id: number, name: string, url: string, authToken?: string) => Promise<void>
deleteConnection: (id: number) => Promise<void>

// 目录（已有，补充 connection_id 参数）
createCategory: (name: string, parentCategoryId?: number, connectionId?: number) => Promise<void>

// 作业重命名（新增）
renameJob: (id: number, name: string) => Promise<void>
```

---

## UI 设计

### 树节点渲染

| 节点类型 | 图标 | 缩进 | 右侧信息 |
|---------|------|------|---------|
| `connection` | `Server`（`#00c9a7`） | 0 | 截断的集群 URL（`#7a9bb8`） |
| `category` | `Folder` / `FolderOpen` | depth × 16px | 无 |
| `job` | `Play` / `CircleStop` | depth × 16px | 运行状态徽章 |

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
5. 删除集群（二次确认，级联删除下属内容）

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

### 工具栏变更

- **移除**：旧的"新建目录"按钮（改为集群右键菜单创建）
- **保留**：刷新按钮、`+ 连接`（新建集群）按钮

### 空状态

- 无集群配置：显示提示文字"尚未配置集群，点击 + 连接添加"
- 集群下无内容：展开后内容区为空（不显示额外提示）

---

## 受影响的文件清单

| 文件 | 变更类型 |
|------|---------|
| `schema/init.sql` | 新增 `connection_id` 列 DDL |
| `src-tauri/src/db/mod.rs` | 启动时执行 ALTER TABLE migration |
| `src-tauri/src/seatunnel/commands.rs` | `create_st_category` 新增 `connection_id` 参数；新增 `rename_st_job` 命令 |
| `src/store/seaTunnelStore.ts` | `init()` 重构；新增 `editConnection`、`deleteConnection`、`renameJob` |
| `src/components/SeaTunnelExplorer/SeaTunnelJobTree.tsx` | 完整重写树渲染与右键菜单逻辑 |
| `src/components/SeaTunnelExplorer/index.tsx` | 移除"新建目录"工具栏按钮；传入 connection 操作回调 |
| `src/components/SeaTunnelExplorer/CategoryEditModal.tsx` | 新增 `connectionId` 参数支持 |

---

## 不在本次范围内

- 移动作业（Move Job）对话框的具体 UI（现有 TODO，保持占位）
- SeaTunnel Job 编辑器内部的集群选择器（Job 已从根节点继承集群，编辑器可在后续迭代更新）
