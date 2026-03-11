# AI Agent 页面交互设计

**日期**: 2026-03-12
**状态**: 已批准
**范围**: AI 助手通过聊天修改 SQL 编辑器、驱动 ER 图设计、操作页面功能

---

## 背景与目标

open-db-studio 已具备基础 AI 对话能力（生成 SQL、解释 SQL），本设计将其升级为**可感知页面状态、可操作 UI 元素的 AI Agent**，主要目标：

1. **聊天修改 SQL**：用自然语言描述修改意图，AI 展示 diff，用户确认后应用
2. **聊天驱动 ER 设计**：从零创建表/字段/虚拟关系，生成 DDL（可不含外键约束）
3. **聊天操作页面**：切换 Tab、打开表、执行 SQL 等页面级操作

---

## 整体架构

```
┌─────────────────────────────────────────────────────┐
│                   用户聊天输入                         │
└─────────────────┬───────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────┐
│              Page Agent Layer                        │
│  • DOM 状态感知（当前 SQL、Schema 树、ER 节点）          │
│  • 自然语言 → 意图识别                                 │
│  • 调用 Tool Bridge（不直接操作 DOM）                  │
│  • 自定义知识库（IDE 规则、操作约束）                   │
└─────────────────┬───────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────┐
│              Tool Bridge Layer（前端接口层）            │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │  SQL 工具组 │ │  ER 工具组  │ │   页面操作工具组   │ │
│  └─────┬──────┘ └─────┬──────┘ └────────┬─────────┘ │
└────────┼──────────────┼─────────────────┼───────────┘
         ↓              ↓                 ↓
┌─────────────────────────────────────────────────────┐
│              现有系统层（改动最小）                      │
│  Monaco Editor │ React Flow ER │ Zustand │ Tauri     │
└─────────────────────────────────────────────────────┘
```

**ACP 迁移路径（Phase 2）**：若 Page Agent 效果不足，Tool Bridge 实现层替换为 ACP JSON-RPC，调用 Rust 后端 Agent 决策，上层 Page Agent 配置不变。

---

## 技术选型

| 层级 | 技术 | 说明 |
|------|------|------|
| Page Agent | `@page-agent/core`（阿里 NPM 包） | DOM 感知 + 意图识别 + Tool 调用 |
| Tool Bridge | 纯前端 TypeScript 实现 | 与 Monaco/React Flow/Zustand 交互 |
| ACP（Phase 2） | Rust SDK | 后端 Agent 决策，替换 Tool Bridge 底层 |
| 虚拟关系存储 | App SQLite（现有） | 新增 `virtual_relations` 表 |
| ER 设计稿存储 | App SQLite（现有） | 新增 `er_designs` 表 |

---

## Tool Bridge API

### SQL 工具组

```typescript
get_current_sql() → {
  full_content:     string,
  selected_text:    string | null,   // 用户选中的文本
  cursor_position:  number,          // 光标偏移量
  statements:       SqlStatement[],  // 解析出的各条语句及位置范围
  active_statement: string | null,   // 光标所在语句（可确定时）
}

propose_sql_diff(original: string, modified: string, reason: string)
  → 在 Assistant 面板展示 diff（红/绿行对比 + 原因说明），返回 pending

apply_sql()
  → 用户确认后，将 modified 写入 Monaco Editor
```

### ER 工具组

```typescript
get_er_state() → {
  tables:   ErTable[],
  relations: VirtualRelation[],
}

propose_er_changes(changes: ErChange[])
  → ER 画布展示预览（新节点虚线框，新连线虚线）
  → Assistant 面板展示变更摘要，返回 pending

apply_er_changes()
  → 写入 React Flow 状态 + virtual_relations（App SQLite）

generate_ddl(options: { include_fk: boolean }) → string
  → include_fk=false 时，DDL 文件头附加 @virtual-relations 注释块
```

### 页面操作工具组

```typescript
switch_tab(tabId: string)
open_table(tableName: string)
execute_current_sql()
navigate_to(view: 'er' | 'settings' | 'history' | 'explorer')
```

---

## 核心交互流程

### SQL 消歧策略（混合模式）

优先级链：**选中文本 → 光标所在语句 → 主动询问**

```
1. selected_text 非空       → 操作选中部分
2. active_statement 非空    → 操作光标所在语句（高亮提示）
3. 以上均无法确定            → 展示编号清单，让用户选择
   "编辑器中有 3 条语句，你想修改哪条？
    1. SELECT * FROM orders WHERE status = 'active'
    2. SELECT count(*) FROM users
    3. UPDATE products SET stock = 0"
```

### SQL 修改流程

```
用户："帮我加上按 created_at 倒序排列"
  → get_current_sql()（含消歧）
  → AI 生成 modified SQL
  → propose_sql_diff(original, modified, reason)
  → Assistant 面板展示 diff

  ┌─────────────────────────────────────┐
  │ 修改建议：添加按创建时间倒序排序        │
  │ ─────────────────────────────────── │
  │   SELECT * FROM orders              │
  │   WHERE status = 'active'           │
  │ + ORDER BY created_at DESC          │
  │ ─────────────────────────────────── │
  │  [应用]              [取消]          │
  └─────────────────────────────────────┘

  → 用户点击"应用" → apply_sql() → Monaco 更新
  → 用户点击"取消" → 关闭，无副作用
```

### ER 设计流程

```
用户："创建用户表，字段：id、username、email、created_at"
  → propose_er_changes([{ type:'add_table', ... }])
  → ER 画布：新节点虚线框（预览态）
  → 用户确认 → apply_er_changes() → 节点实线，写入 SQLite

用户："orders 表的 customer_id 关联 users.id，多对一"
  → propose_er_changes([{ type:'add_virtual_relation', from:'orders.customer_id', to:'users.id', cardinality:'N:1' }])
  → ER 画布：虚线连线（区别于真实 FK 实线）
  → 用户确认 → virtual_relations 写入记录

用户："生成 DDL，不要外键约束"
  → generate_ddl({ include_fk: false })
```

#### DDL 输出格式（虚拟关系注释块）

```sql
-- @virtual-relations v1
-- orders.customer_id -> users.id (N:1)
-- order_items.order_id -> orders.id (N:1)
-- @end-virtual-relations

CREATE TABLE users (
  id          BIGINT PRIMARY KEY,
  username    VARCHAR(100),
  email       VARCHAR(255),
  created_at  DATETIME
);

CREATE TABLE orders (
  id          BIGINT PRIMARY KEY,
  customer_id BIGINT,   -- 逻辑关联 users(id)，见文件头注释
  ...
);
```

**反向解析**：导入含 `@virtual-relations` 注释块的 DDL 文件时，自动恢复 `virtual_relations` 表记录并重建 ER 连线。

---

## 数据模型变更

### App SQLite 新增表

```sql
-- 虚拟外键关系（运行时主数据源）
CREATE TABLE virtual_relations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  from_table    TEXT NOT NULL,
  from_column   TEXT NOT NULL,
  to_table      TEXT NOT NULL,
  to_column     TEXT NOT NULL,
  cardinality   TEXT NOT NULL,  -- 'N:1' | '1:N' | '1:1' | 'N:N'
  created_at    TEXT NOT NULL
);

-- ER 图设计稿（支持离线空白设计）
CREATE TABLE er_designs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER,         -- NULL 表示离线设计稿
  name          TEXT NOT NULL,
  layout_json   TEXT NOT NULL,   -- React Flow 节点位置信息
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

---

## 前端组件变更

```
src/components/
├── Assistant/
│   ├── index.tsx           (改动：集成 Page Agent 初始化)
│   ├── DiffPanel.tsx       (新增：SQL diff 红/绿展示 + 应用/取消)
│   └── ErChangesPanel.tsx  (新增：ER 变更摘要列表 + 确认/取消)
├── ERDiagram.tsx           (改动：虚拟关系虚线渲染 + 预览态节点虚线框)
└── hooks/
    └── useToolBridge.ts    (新增：Tool Bridge 实现，暴露给 Page Agent)
```

---

## Page Agent 配置

```typescript
const agent = createAgent({
  llm: {
    baseURL: activeConfig.base_url,
    apiKey:  activeConfig.api_key,   // 复用现有 LLM 配置
    model:   activeConfig.model,
  },
  tools: toolBridge,
  knowledge: [
    '这是一个数据库 IDE，包含 SQL 编辑器、ER 图设计、Schema 浏览器',
    '修改 SQL 前必须调用 propose_sql_diff，不得直接写入编辑器',
    '所有 ER 变更必须经用户确认后才能 apply',
    '禁止读取或展示密码、API Key 等敏感字段',
  ],
  whitelist: ['#sql-editor', '#er-diagram', '.tab-bar', '.schema-tree'],
  blacklist: ['.connection-password', '.api-key-field', '.settings-security'],
});
```

---

## 安全边界

- Page Agent 黑名单覆盖所有敏感字段（密码、API Key）
- 所有破坏性操作（SQL 修改、ER 变更）必须经过 propose → 用户确认 → apply 三步
- ACP 阶段：Rust 后端 Agent 不绕过现有 AES-256 加密存储机制

---

## 分阶段实施

| 阶段 | 内容 | 依赖 |
|------|------|------|
| Phase 1 | Tool Bridge + DiffPanel + SQL 修改流程 | 无 |
| Phase 2 | Page Agent 集成 + 消歧策略 | Phase 1 |
| Phase 3 | ER 聊天设计 + virtual_relations + DDL 生成 | Phase 1 |
| Phase 4 | ACP 协议接入（可选，按效果决定） | Phase 2 |
