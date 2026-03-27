# UI Object Protocol — 统一 AI-UI 操控协议设计

> 日期: 2026-03-28
> 状态: Approved
> 替代: 2026-03-26-unified-fs-abstraction-design.md（fs_* 协议）

## 问题

现有 `fs_*` 协议（fs_read/fs_write/fs_search/fs_open/fs_exec）存在根本限制：

1. **新建表表单不可多轮编辑** — 表单状态在组件 `useState` 中，MCP 工具不可达。prompt 中用硬约束"ONE-SHOT fs_open 后禁止再碰"规避
2. **后端/前端处理分裂** — tab.query 走前端 FsRouter，tab.table/metric/seatunnel 走 Rust 后端，确认机制各不相同
3. **不可扩展** — 每新增一种 Tab 类型（如 ER 图），需要改 Rust 路由、加后端 handler、改 prompt，全栈联动
4. **AI 无法感知 UI 状态** — 无 schema 自描述，AI 不知道能改什么字段

## 方案

参考 Palantir AIP Ontology 模式：UI 和 AI 共享同一数据层，AI 操作数据，React 响应式渲染。

### 核心设计

4 个 MCP 工具替代原来的 5+1 个：

| 新工具 | 替代 | 语义 |
|--------|------|------|
| `ui_read(object, target, mode)` | fs_read | 读状态/schema/actions |
| `ui_patch(object, target, ops, reason?)` | fs_write | JSON Patch (RFC 6902) 局部更新 |
| `ui_exec(object, target, action, params?)` | fs_exec + fs_open | 执行操作 |
| `ui_list(filter?)` | fs_search + search_tabs | 列出/搜索可操作对象 |

### UIObject 接口

```typescript
interface UIObject {
  type: string           // "query_editor" | "table_form" | "er_canvas" | ...
  objectId: string       // 实例唯一 ID（通常是 tabId）
  title: string
  connectionId?: number

  read(mode: 'state' | 'schema' | 'actions'): any
  patch(ops: JsonPatchOp[], reason?: string): PatchResult
  exec(action: string, params?: any): ExecResult
}
```

### JSON Patch 作为统一变更语言

使用 RFC 6902 JSON Patch，不发明新 DSL：

```json
[
  {"op": "replace", "path": "/tableName", "value": "orders"},
  {"op": "add", "path": "/columns/-", "value": {"name": "id", "dataType": "INT"}},
  {"op": "remove", "path": "/columns/3"}
]
```

**数组元素按名称寻址扩展**：标准 JSON Patch 用数字 index 寻址数组元素，但 index 在多 op 批处理中容易偏移。adapter 层支持 `[key=value]` 语法糖：

```json
{"op": "replace", "path": "/columns[name=amount]/dataType", "value": "BIGINT"}
```

adapter 的 `patch()` 在 apply 前将 `[name=amount]` 解析为实际 index。AI 应优先使用按名称寻址，仅在名称不可用时（如新增列尚无名称）才用数字 index。

### Schema 响应格式

`ui_read(mode='schema')` 返回标准 JSON Schema (draft-07)，描述该对象可被 patch 的字段结构。schema 是**静态的**——每个 object type 对应一个固定 schema，不随实例变化。

示例：`table_form` 的 schema 响应：

```json
{
  "type": "object",
  "properties": {
    "tableName":  { "type": "string", "description": "表名" },
    "engine":     { "type": "string", "enum": ["InnoDB", "MyISAM", "MEMORY"], "default": "InnoDB" },
    "charset":    { "type": "string", "default": "utf8mb4" },
    "comment":    { "type": "string" },
    "columns": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name":         { "type": "string" },
          "dataType":     { "type": "string", "description": "SQL data type, e.g. INT, VARCHAR, DECIMAL" },
          "length":       { "type": ["string", "null"], "description": "Type length/precision, e.g. '255', '10,2'" },
          "isNullable":   { "type": "boolean", "default": true },
          "defaultValue": { "type": ["string", "null"] },
          "isPrimaryKey": { "type": "boolean", "default": false },
          "extra":        { "type": "string", "description": "e.g. auto_increment" },
          "comment":      { "type": "string" }
        },
        "required": ["name", "dataType"],
        "x-addressable-by": "name"
      }
    },
    "indexes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name":    { "type": "string" },
          "columns": { "type": "array", "items": { "type": "string" } },
          "unique":  { "type": "boolean", "default": false }
        },
        "x-addressable-by": "name"
      }
    }
  }
}
```

`x-addressable-by` 是自定义扩展字段，告知 AI 该数组元素可用 `[name=xxx]` 语法寻址。

### 错误处理契约

```typescript
// PatchResult — ui_patch 返回
interface PatchResult {
  status: 'applied' | 'pending_confirm' | 'error'
  confirm_id?: string          // pending_confirm 时用于后续确认
  preview?: JsonPatchOp[]      // pending_confirm 时展示将要变更的内容
  message?: string             // 人类可读的成功/错误描述
}

// ExecResult — ui_exec 返回
interface ExecResult {
  success: boolean
  data?: any                   // 操作返回的数据（如 preview_sql 返回 SQL 文本）
  error?: string               // 失败时的错误描述
}

// UIResponse — UIRouter 的统一响应封装
interface UIResponse {
  data?: any
  error?: string
  status?: 'applied' | 'pending_confirm'
  confirm_id?: string
}
```

**Patch 错误策略**：**全有或全无（atomic）**。一批 ops 中任何一个失败（如 path 不存在、类型不匹配），整批回滚，返回 `{status: 'error', message: '...'}`。不支持部分成功。

### Workspace 对象规格

`workspace` 是虚拟全局对象，不对应任何 tab，用于全局操作：

**actions 列表**：
| action | params | 描述 |
|--------|--------|------|
| open | `{type, connection_id?, database?, table?, metric_id?, project_id?, job_id?}` | 打开新 tab，返回 `{objectId: tabId}` |
| close | `{target: tabId}` | 关闭指定 tab |
| focus | `{target: tabId}` | 切换到指定 tab |

`workspace` 不支持 `read` 和 `patch`（无自身状态）。`ui_list` 承担了"查看全局状态"的职责。

### 对象类型

| object 类型 | target 格式 | 替代的旧 resource |
|-------------|-------------|------------------|
| query_editor | active / tabId | tab.query |
| table_form | active / tabId | tab.table |
| metric_form | metricId / tabId | tab.metric |
| er_canvas | projectId / tabId | 新增 |
| seatunnel_job | jobId / tabId | tab.seatunnel |
| db_tree | active | panel.db-tree |
| history | active | panel.history |
| workspace | "" | fs_open (全局操作) |

### 确认机制：混合模式

- Auto Mode ON → ui_patch 直接 apply，UI 实时更新
- Auto Mode OFF → ui_patch 返回 pending_confirm，通用 PatchConfirmPanel 展示结构化变更

### 架构分层

```
MCP Tool Call (ui_read/ui_patch/ui_exec/ui_list)
  ↓ [Rust: mod.rs call_tool]
全部 query_frontend("ui_request", ...) 转发到前端
  ↓ [前端: useMcpBridge 监听 "mcp://ui-request"]
UIRouter.handle(req)
  ↓ [UIRouter: 按 object type 查找 adapter，按 target 查找实例]
UIObject.read() / patch() / exec()
  ↓ [Adapter: 操作 Zustand store 或组件 stateRef]
React 响应式渲染 UI 更新
```

**关键决策：Rust 层纯透传，不再处理 UI 状态。** adapter 需要 DB 操作时通过 `invoke()` 回调 Rust command。

## 全栈改动

### Rust 后端

- `mod.rs`: 删除 fs_* 工具定义 + 路由，新增 ui_* 工具定义 + 统一前端转发
- 删除 `tools/fs_table.rs`, `tools/fs_metric.rs`, `tools/fs_seatunnel.rs`, `tools/fs_history.rs`
- 保留 `tools/tab_control.rs`（通信基础设施）
- 保留 `tools/table_edit.rs`, `tools/metric_edit.rs` — 改为 `#[tauri::command]` 暴露，供前端 adapter invoke

### 前端

- 新增 `src/mcp/ui/` 目录：UIRouter、types、useUIObjectRegistry hook、jsonPatch 实现、PatchConfirmPanel
- 新增 8 个 adapter：QueryEditor、TableForm、MetricForm、ERCanvas、SeaTunnelJob、DbTree、History、Workspace
- 删除 `src/mcp/fs/` 整个目录
- 删除 `DiffPanel`（被 PatchConfirmPanel 替代）
- 改造组件：TableStructureView / MetricTab / SeaTunnelJobTab 增加 useUIObjectRegistry 注册
- Tab 类型：删除 initialColumns / initialTableName 字段

### Prompt

- `prompts/chat_assistant.txt` 全文重写：围绕 ui_* 协议，建表从 ONE-SHOT 改为多轮 patch 工作流

### 不变的部分

- 数据库读取工具（list_connections, execute_sql, graph_* 等）
- optimize_tool_definitions()（SQL 优化 MCP 端点）
- 前端 UI 组件的用户手动交互逻辑

## 实施阶段

- **Phase 1**: 基础设施 — ui/ 协议层 + PatchConfirmPanel + useMcpBridge 切换 + Rust mod.rs 改造 + table_edit 暴露
- **Phase 2**: 适配器迁移 — 8 个 adapter 逐个实现（可并行）
- **Phase 3**: 清理 — 删除 fs/ 目录、Rust fs_*.rs、DiffPanel、Tab.initialColumns
- **Phase 4**: Prompt + 测试 — chat_assistant.txt 重写 + skills 检查 + 全链路测试

## 架构决策

### AD-1: 可 patch 状态必须在 Zustand slice 中

所有需要被 AI 读写的 UI 状态**必须**存储在 Zustand store 中，不允许用组件局部 `useState`。理由：
- `useState` setter 是异步的，`ui_read` 紧跟 `ui_patch` 可能拿到旧值
- Zustand `set()` 是同步的，状态立即可读
- 跨组件可访问，adapter 不依赖组件生命周期

各 adapter 使用独立的 Zustand slice（如 `useTableFormStore`、`useMetricFormStore`），通过 `useUIObjectRegistry` 向 UIRouter 注册。

### AD-2: 硬切不做向后兼容

这是本地桌面应用，无第三方 MCP 集成。`fs_*` 工具一次性删除，不设过渡期。`tools/list` 响应直接切换为 `ui_*` 工具。版本号跟随应用版本自然递增。

### AD-3: search_tabs 工具删除

现有 `search_tabs` 工具被 `ui_list` 完全取代。`ui_list` 返回所有已注册的 UIObject 实例信息（包括 type、objectId、title、connectionId），支持按 type 和 keyword 过滤。

### AD-4: optimize_tool_definitions() 不受影响

`optimize_tool_definitions()` 仅暴露 4 个只读数据库工具（list_databases, list_tables, get_table_schema, get_table_sample），不涉及 UI 操作，与本次重构无关。

## PatchConfirmPanel 渲染策略

根据 object type 采用不同的渲染方式：

| object type | 渲染方式 |
|-------------|---------|
| query_editor | 文本 diff（保持现有 DiffPanel 体验，对 `/content` 字段做 text diff） |
| table_form | 结构化表格：列名、字段 → 旧值/新值对比 |
| er_canvas | 节点/边的增删描述列表 |
| 其他 | JSON path + 旧值/新值通用渲染 |

## 测试策略

| 层 | 覆盖范围 |
|---|---------|
| UIRouter 单测 | 路由分发、target 解析（active/tabId）、ui_list 过滤 |
| jsonPatch 单测 | RFC 6902 所有 op 类型、`[name=xxx]` 扩展语法、越界/类型错误 → atomic 回滚 |
| 各 Adapter 单测 | read(state/schema/actions) 返回值正确性、patch apply、exec 各 action |
| 集成测试 | MCP tool call → Rust 透传 → 前端 UIRouter → adapter → store 更新 → UI 渲染 |
| 全链路测试 | 多轮建表、SQL 编辑、Auto/非Auto 确认、ui_list 发现 |

## 风险

| 风险 | 缓解 |
|------|------|
| JSON Patch 数组 index 偏移 | `[name=xxx]` 按名称寻址作为主要寻址方式；数字 index 仅作为 fallback |
| Zustand slice 膨胀 | 每个 adapter 独立 slice，tab 关闭时清理对应状态 |
| ER Canvas 状态结构未定义 | Phase 2 先实现桩（read 返回空，patch 报 not_implemented），后续独立迭代 |
| Patch 的 atomic 语义在复杂场景下性能 | ops 数组通常 <20 个操作，deep clone + apply + 失败回滚的成本可忽略 |
