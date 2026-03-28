# ER Canvas MCP Adapter — 对话式操作 ER 图设计规格

> 日期: 2026-03-28
> 状态: Approved

---

## 背景

ERCanvasAdapter 当前为空壳 stub，`read` 返回空数组，`patch`/`exec` 直接报错。ER Designer 本身（前端组件 + Zustand store + Rust 后端 27 个命令）已基本完整（~90%）。

目标：让 AI 通过 MCP UI Object Protocol 读取和操控 ER 画布，用户在右侧 AI 对话助手中用自然语言描述需求，AI 通过 `ui_read`/`ui_patch`/`ui_exec` 直接操作画布。

## 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 实现方案 | Store 直驱（方案 A） | 与 QueryEditorAdapter/TableFormAdapter 模式一致 |
| 状态感知策略 | AI 按需读取（方案 C） | 最符合自然对话模式，AI 自行判断何时 read |
| 确认机制 | 不走 pending_confirm | ER 画布是设计态，操作可逆，直接生效更流畅 |
| 高级操作结果呈现 | 混合（方案 C） | DDL/Diff 文本返回 AI 在对话展示；导入/绑定触发对话框 |
| 交互入口 | 复用右侧 AI 对话助手 | 不新建 UI |

## 1. read() 实现

三种模式：

### read('state') — 画布业务数据快照

```typescript
{
  projectId: number,
  projectName: string,
  connectionId: number | null,
  tables: [
    {
      id: number,
      name: string,
      position: { x: number, y: number },
      columns: [
        {
          id: number,
          name: string,
          data_type: string,
          nullable: boolean,
          is_primary_key: boolean,
          is_auto_increment: boolean,
          comment: string | null
        }
      ]
    }
  ],
  relations: [
    {
      id: number,
      source_table_id: number,
      source_column_id: number,
      target_table_id: number,
      target_column_id: number,
      relation_type: string
    }
  ]
}
```

关键：返回业务语义数据（表名、列名、关系），不返回 ReactFlow 的 nodes/edges 渲染细节。

### read('schema') — JSON Schema 描述状态结构

供 AI 理解可操作的字段和类型。

### read('actions') — 可执行操作列表

```typescript
[
  { name: 'add_table', description: '创建新表', paramsSchema: { name: 'string' } },
  { name: 'delete_table', description: '删除表', paramsSchema: { tableId: 'number' } },
  { name: 'add_column', description: '添加列', paramsSchema: { tableId: 'number', column: { name, data_type, nullable?, is_primary_key?, is_auto_increment?, comment? } } },
  { name: 'update_column', description: '修改列', paramsSchema: { columnId: 'number', updates: { name?, data_type?, nullable?, is_primary_key?, is_auto_increment?, comment? } } },
  { name: 'delete_column', description: '删除列', paramsSchema: { columnId: 'number', tableId: 'number' } },
  { name: 'add_relation', description: '创建关系', paramsSchema: { source_table_id, source_column_id, target_table_id, target_column_id, relation_type } },
  { name: 'delete_relation', description: '删除关系', paramsSchema: { relationId: 'number' } },
  { name: 'generate_ddl', description: '生成DDL（结果返回文本）', paramsSchema: { dialect?: 'string' } },
  { name: 'auto_layout', description: '自动布局' },
  { name: 'open_import_dialog', description: '打开导入表对话框' },
  { name: 'open_bind_dialog', description: '打开绑定连接对话框' },
  { name: 'diff_with_database', description: 'Diff对比（结果返回文本）' }
]
```

## 2. exec() 实现

所有写操作主要走 exec，分三类：

### 第一类：CRUD — 调 store action + emit 刷新

```
add_table       → store.addTable(name, position)       → emit('er-canvas-reload')
delete_table    → store.deleteTable(tableId)            → emit('er-canvas-reload')
add_column      → store.addColumn(tableId, columnDef)   → emit('er-canvas-reload')
update_column   → store.updateColumn(columnId, updates) → emit('er-canvas-reload')
delete_column   → store.deleteColumn(columnId, tableId) → emit('er-canvas-reload')
add_relation    → store.addRelation(relationDef)         → emit('er-canvas-reload')
delete_relation → store.deleteRelation(relationId)       → emit('er-canvas-reload')
```

每个 CRUD 操作返回 `{ success: true, data: { id: ... } }` 供 AI 追踪实体 ID。

### 第二类：文本结果 — 调 invoke，结果返回 AI

```
generate_ddl       → invoke('er_generate_ddl', { projectId, dialect })
                   → return { success: true, data: { ddl, dialect } }

diff_with_database → invoke('er_diff_with_database', { projectId })
                   → return { success: true, data: { diff } }
```

### 第三类：触发对话框 — emit 事件

```
open_import_dialog → emit('er-canvas-open-dialog', { projectId, dialog: 'import' })
open_bind_dialog   → emit('er-canvas-open-dialog', { projectId, dialog: 'bind' })
auto_layout        → emit('er-canvas-auto-layout', { projectId })
```

## 3. patch() 实现

仅支持简单属性替换（表名、列属性）：

```typescript
// 示例 ops:
[{ op: 'replace', path: '/tables/[id=5]/name', value: 'users' }]
[{ op: 'replace', path: '/columns/[id=12]/data_type', value: 'BIGINT' }]
```

内部解析 path 中的 `[id=N]` 定位实体，调用 `store.updateTable` 或 `store.updateColumn`，然后 emit `er-canvas-reload`。

不走 pending_confirm，直接生效返回 `{ status: 'applied' }`。

## 4. 注册生命周期与多轮对话

### 注册时机

ERCanvas 组件挂载时创建 adapter，通过 useUIObjectRegistry 注册，卸载时注销：

```typescript
// ERCanvas/index.tsx
const adapter = useMemo(
  () => new ERCanvasAdapter(tabId, projectName, projectId),
  [tabId, projectName, projectId]
)
useUIObjectRegistry(adapter)
```

objectId = tabId（如 `er_design_3_1711612345000`），与 workspace tab 系统一致。

### 多轮对话连续性

靠三点天然实现，无需额外机制：

1. **adapter 生命周期绑定 tab** — 标签页不关，adapter 持续存在
2. **read('state') 实时读 store** — 每次 read 拿最新数据，无缓存漂移
3. **exec 返回实体 ID** — AI 上下文自然追踪（"刚建了 users 表 id=5"→"给 id=5 加 email 字段"）

### 多画布场景

用户可同时打开多个 ER 项目标签页，AI 通过 `ui_list` 发现全部，用 `target: 'active'` 操作当前聚焦画布或用具体 objectId 指定。

## 5. 画布侧事件监听

ERCanvas 组件新增 3 个 Tauri event listener：

| 事件 | 响应 |
|------|------|
| `er-canvas-reload` | 调用已有的 `reloadCanvas()` |
| `er-canvas-open-dialog` | 根据 `dialog` 字段 setShowImport/setShowBind(true) |
| `er-canvas-auto-layout` | 调用 ERToolbar 已有的 dagre 布局逻辑 |

所有 listener 通过 `event.payload.projectId` 过滤，只响应自己项目的事件。

## 6. 改动清单

### 改动文件（2 个）

| 文件 | 改动 |
|------|------|
| `src/mcp/ui/adapters/ERCanvasAdapter.ts` | 重写 — 实现完整 read/patch/exec |
| `src/components/ERDesigner/ERCanvas/index.tsx` | 修改 — adapter 创建 + useUIObjectRegistry 注册 + 3 个 event listener |

### 不改动

- erDesignerStore.ts — 27 个 action 原样复用
- UIRouter.ts / types.ts — 通用路由层
- useUIObjectRegistry.ts — 注册 hook 通用
- useMcpBridge.ts — ER canvas 是动态注册，不加 singleton
- ERTableNode / EREdge / ERToolbar — 不涉及 MCP 适配
- Rust 后端 — 零改动

## 7. 实现优先级

```
Step 1: ERCanvasAdapter 重写
  - read() 三种模式
  - exec() 12 个操作
  - patch() 属性替换

Step 2: ERCanvas 组件集成
  - adapter 创建 + 注册
  - 3 个 event listener

Step 3: 端到端验证
  - ui_list 能发现 ER 画布
  - ui_read 返回正确状态
  - ui_exec add_table → 画布出现新表
  - 多轮对话：建表 → 加列 → 建关系 → 生成 DDL
```
