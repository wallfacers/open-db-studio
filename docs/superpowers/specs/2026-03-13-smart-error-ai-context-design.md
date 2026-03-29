<!-- STATUS: ✅ 已实现 -->
# 智能错误上下文 + AI 助手全局化 设计文档

**日期**: 2026-03-13
**状态**: 待实现
**范围**: 错误处理系统改造 + AI 助手面板全局化

---

## 一、背景与目标

### 问题
当前错误提示仅显示原始错误字符串（如 `ERROR 1054: Unknown column`），用户无法判断原因，也无法快速获得 AI 帮助。

### 目标
1. 每处错误提示提供两份信息：**用户友好简短描述** + **Markdown 格式技术上下文**
2. 一键"问 AI"，将技术上下文填入助手输入框，用户确认后发送
3. AI 助手面板全局化，任何页面均可通过右边缘常驻按钮唤出/收起

---

## 二、现有代码关键现状

| 项目 | 现状 |
|------|------|
| `isAssistantOpen` | `App.tsx` 本地 `useState`（第31行） |
| AI 忙碌判断 | `aiStore.isChatting`（流式对话进行中） |
| 清空对话 | `aiStore.clearHistory()`（已有） |
| 输入框状态 | `Assistant/index.tsx` 本地 `chatInput` useState（第186行） |
| `appStore` | **不存在**，需新建 |
| `copyError` i18n key | **不存在**，需新增 |
| `setDraftMessage` | **不存在**，需新增 |
| `newSession` | **不存在**，用 `clearHistory()` 替代 |

---

## 三、整体架构

```
错误发生（SQL失败 / 导入导出失败 / AI功能失败）
  │
  ▼
buildErrorContext(type, raw)         ← src/utils/errorContext.ts（新建）
  读取来源（全部来自 store，无额外 invoke）：
  · connectionStore.connections       → 连接名、driver、host:port
  · connectionStore.metaCache[id]     → DB 版本（连接时缓存）
  · appStore.lastOperationContext     → 当前操作快照
  · connectionStore.tables            → 相关表结构（已有缓存）
  · queryStore.history.slice(0,3)     → 最近3条 SQL 执行历史
  · aiStore.configs / activeConfigId  → 模型名、base_url
  │
  ├─→ userMessage: string             （1-2句简短描述）
  └─→ markdownContext: string | null  （Markdown；失败时为 null）
        │
        ▼
  showError(userMessage, markdownContext)  ← 替换现有 showToast(e, 'error')
        │
   ┌────┼──────┐
   ▼    ▼      ▼
 Toast TaskCenter 查询结果区
   │    │      │
   └────┴──┬───┘
           │ 点击"问 AI"（markdownContext != null 时才显示按钮）
           ▼
     askAiWithContext(markdownContext)   ← src/utils/askAi.ts（新建）
     · 调用 appStore.setAssistantOpen(true)
     · AI 忙碌（isChatting）→ clearHistory()，再 setDraftMessage()
     · AI 空闲 → 直接 setDraftMessage()
```

---

## 四、数据结构

### 4.1 统一错误上下文

```typescript
// src/utils/errorContext.ts
export interface AppErrorContext {
  userMessage: string;
  markdownContext: string | null;  // null 表示生成失败，此时不显示"问 AI"按钮
}
```

### 4.2 操作上下文快照

```typescript
// src/store/appStore.ts（新建）
export interface OperationContext {
  type: 'sql_execute' | 'import' | 'export' | 'ai_request';
  connectionId: number;
  database?: string;
  schema?: string;
  sql?: string;            // SQL 执行时
  taskId?: string;         // 导入/导出任务 ID
  aiRequestType?: 'generate' | 'explain' | 'optimize' | 'create_table' | 'chat';
  prompt?: string;
  httpStatus?: number;     // AI 请求失败时在 catch 里补充
}

// appStore 状态
interface AppState {
  lastOperationContext: OperationContext | null;
  setLastOperationContext: (ctx: OperationContext | null) => void;
  isAssistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
}
```

**写入规则**：
- **操作发起前**写入基础字段（type、connectionId、sql 等）
- **catch 块中**允许追加 `httpStatus` 字段（补充一次），因为该字段只在请求失败时才存在
- 这是唯一允许在回调中修改的字段，其余字段不得在回调中修改

**并发说明**：多 Tab 并行执行时以最后写入为准，用户点击"问 AI"时立即消费，延迟点击的极端情况可接受；后续可按 tabId 隔离（本期不做）。

**重要**：`App.tsx` 的 `isAssistantOpen` 状态**迁移到 `appStore`**，`App.tsx` 改为从 store 读取，原有 `setIsAssistantOpen` prop 链路全部替换为 `appStore.setAssistantOpen`。

### 4.3 连接元数据缓存

```typescript
// 新增到 connectionStore
export interface ConnectionMeta {
  dbVersion: string;   // 获取失败时为空字符串（不是 "unknown"）
  driver: string;
  host: string;
  port?: number;
  name: string;
}
// 新增字段：metaCache: Record<number, ConnectionMeta>
// 新增 action：setMeta(connectionId: number, meta: ConnectionMeta) => void
// 写入时机：连接测试通过后（test_connection 成功），调用 get_db_version
// 降级：get_db_version 失败 → metaCache 中不写入该 id，Markdown 模板省略版本号
```

### 4.4 aiStore 新增字段

```typescript
// 在现有 AiState 接口中追加
draftMessage: string;
setDraftMessage: (msg: string) => void;
// newSession 用现有的 clearHistory() 替代（clearHistory 已有）
```

### 4.5 与现有 Store 字段的关系

| 现有字段 | 用途 |
|---|---|
| `connectionStore.connections` | 连接名、host、port、driver |
| `connectionStore.tables` | 相关表结构（字段列表） |
| `queryStore.history` | 最近3条 SQL 执行历史 |
| `aiStore.configs` + `activeConfigId` | 模型名、base_url |
| `task.description` | 导入/导出任务 Markdown 基础信息（已实现） |
| `task.errorDetails[]` | 失败行详情，**展示时截取前10条** |
| `aiStore.isChatting` | 判断 AI 是否忙碌 |
| `aiStore.clearHistory()` | 忙碌时"新建会话"= clearHistory + setDraftMessage |

---

## 五、ErrorContextBuilder — 三类模板

### 5.1 SQL 执行失败

```markdown
## SQL 执行错误

**连接**: mydb-prod (ID: 1 · MySQL · localhost:3306)
**版本**: 8.0.32
**数据库**: `mydb` · Schema: `public`

**执行的 SQL**:
```sql
SELECT * FROM orders WHERE status = 'pending'
```

**错误信息**: Unknown column 'status' in 'field list'

### 相关表结构（本地缓存）
- `orders`: id(int PK), order_no(varchar), user_id(int), created_at(datetime)

### 最近执行历史（最近3条）
1. `SELECT COUNT(*) FROM orders` — 成功
2. `SHOW TABLES` — 成功
3. `ALTER TABLE orders ADD COLUMN status VARCHAR(20)` — 失败
```

**降级**：各节数据为空时省略对应节，不报错。版本未缓存时省略版本行。

### 5.2 导入/导出失败

直接复用 `task.description`（已包含连接、数据库、表清单），追加失败详情：

```markdown
（task.description 内容）

---
### 失败详情
**进度**: 已处理 1,203 / 5,000 行（24%）
**错误策略**: 遇错停止

**失败样本（前10条）**:
- 第 1,204 行：字段 `age` 期望 INT，实际值 `"unknown"`
- 第 1,205 行：字段 `email` 违反唯一约束
（共 3,797 行失败，仅展示前10条）
```

`errorDetails` 的截取发生在**点击"问 AI"时**，而非任务失败时。

### 5.3 AI 功能失败

```markdown
## AI 请求失败

**请求类型**: 解释 SQL
**模型配置**: GPT-4o (ID: 2)
**API Base URL**: https://api.openai.com/v1
**HTTP 状态码**: 429
**错误信息**: Rate limit exceeded

**数据库环境**: MySQL · mydb
**版本**: 8.0.32
**请求内容**:
```sql
SELECT * FROM users LIMIT 10
```
```

**降级**：`httpStatus`、版本、请求内容均为可选，不可用时省略。

---

## 六、UI 改造

### 6.1 Toast 改造

```
改造前：
[✕]  执行失败：Unknown column 'status'    [✕关闭]
     [📋 复制]

改造后：
[✕]  执行失败：Unknown column 'status'    [✕关闭]
     ─────────────────────────────────────
     [📋 复制错误]   [🤖 问 AI]    ← markdownContext != null 时才显示
```

- 点击"问 AI"：调用 `askAiWithContext(markdownContext)` → Toast 自动关闭
- 原有自动消失、悬停暂停逻辑不变

### 6.2 TaskCenter 任务卡片

失败任务展开区底部追加（仅 `status === 'failed'`）：

```
[🤖 问 AI 分析失败原因]
```

触发逻辑：拼装 `task.description` + 截取前10条 `task.errorDetails`，调用 `askAiWithContext()`。

### 6.3 查询结果区

`queryStore.error` 非空时，错误信息下方追加：

```
[🤖 问 AI]
```

**与现有自动诊断的关系**：
- 现有 `queryStore.ts` 失败后自动调用 `ai_diagnose_error`（静默诊断，结果在 Assistant 面板显示）
- 本功能为**用户主动触发**的补充，两者并存
- 用户主动触发时，如 AI 正在自动诊断（`isChatting = true`），执行 `clearHistory()` 后重新填入错误上下文

---

## 七、"问 AI"统一触发逻辑

```typescript
// src/utils/askAi.ts
export function askAiWithContext(markdownContext: string) {
  const { isChatting, clearHistory, setDraftMessage } = useAiStore.getState();
  const { setAssistantOpen } = useAppStore.getState();

  // 1. 打开 Assistant 面板
  setAssistantOpen(true);

  // 2. AI 忙碌 → 调用 clearHistory()
  //    clearHistory() 会同时取消后端 ACP session，属于用户主动打断，可接受
  if (isChatting) {
    clearHistory();
  }

  // 3. 填入输入框（不自动发送，用户确认后发送）
  setDraftMessage(markdownContext);
}
```

**`draftMessage` 消费机制**：`Assistant/index.tsx` 新增 `useEffect` 监听 `draftMessage`：

```typescript
// Assistant/index.tsx 中新增
useEffect(() => {
  if (draftMessage) {
    setChatInput(draftMessage);   // 一次性写入输入框
    setDraftMessage('');           // 立即清空 store，避免重复填入
  }
}, [draftMessage]);
```

即"一写即消费"：`draftMessage` 填入 `chatInput` 后立刻清空，后续用户的输入完全独立。

---

## 八、AI 助手面板全局化

### 8.1 布局结构

```
收起状态（Tab 宽约 20px，绝对定位贴右侧，z-index 高于主内容）：
┌──────┬────────────────────────────┬──┐
│侧边栏 │       主内容区              │▶ │
└──────┴────────────────────────────┴──┘

展开状态（主内容区宽度被 flex 压缩，Tab 随面板移动）：
┌──────┬──────────────┬──┬─────────────┐
│侧边栏 │   主内容区    │◀ │ AI Assistant│
└──────┴──────────────┴──┴─────────────┘
```

**实现**：`App.tsx` 顶层 flex 布局中，Assistant 面板的宽度由 `isAssistantOpen` 控制（`width: assistantWidth` or `width: 0`），加 CSS transition。`AssistantToggleTab` 是绝对定位在面板左边缘的细长按钮，随面板宽度一起动。

**`isAssistantOpen` 迁移**：从 `App.tsx` 本地 state 迁移到 `appStore`，`App.tsx` + 所有消费 `setIsAssistantOpen` prop 的子组件（`ActivityBar`、`Assistant`）改为直接调用 `appStore.setAssistantOpen()`，移除 prop 传递链路。

### 8.2 动画规格（Cursor / Copilot Chat 风格）

```css
/* Tailwind 形式写在组件内联或 index.css */

/* 面板本体 */
.assistant-panel {
  transition: width 280ms cubic-bezier(0.32, 0.72, 0, 1); /* 展开 ease-out */
}
.assistant-panel.is-closing {
  transition: width 200ms ease-in;  /* 收起更快 */
}

/* 面板内容：等动画完成后 fade-in，避免文字挤压感 */
.assistant-panel-content {
  opacity: 0;
  transition: opacity 60ms ease-in 280ms;
}
.assistant-panel.is-open .assistant-panel-content {
  opacity: 1;
}

/* 主内容区同步压缩 */
.main-content-area {
  transition: width 280ms cubic-bezier(0.32, 0.72, 0, 1);
}
```

CSS 写在 `src/index.css`（全局）或各组件的 `className` 中通过 Tailwind 实现。

### 8.3 AssistantToggleTab 组件

- 绝对定位，贴在 Assistant 面板左边缘，`z-index: 10`，不遮挡主内容交互区
- 展开时 `left: 0`（相对面板），收起时固定在页面最右侧
- 箭头图标：`▶`（收起）/ `◀`（展开），`transition: transform 200ms`
- 点击反馈：`active:scale-110`

### 8.4 移除工具栏 AI 按钮

`MainContent/index.tsx` 工具栏中触发 `setIsAssistantOpen(true)` 的按钮统一移除，入口收归右边缘 Tab。若有快捷键，绑定到 `AssistantToggleTab` 上。

---

## 九、后端新增命令

| 命令 | 参数 | 返回 | 失败处理 |
|------|------|------|----------|
| `get_db_version` | `connection_id: i64` | `String`（如 `"8.0.32"`） | 返回 `Ok("")`，不报错；前端收到空字符串则不写入 metaCache |

注册位置：`src-tauri/src/lib.rs` 的 `generate_handler![]`。

---

## 十、i18n 新增 key

`src/i18n/locales/zh.json` 和 `en.json`：

```json
{
  "error": {
    "askAi": "问 AI",
    "askAiAnalyze": "问 AI 分析失败原因",
    "copyError": "复制错误"
  }
}
```

---

## 十一、完整改造点清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/store/appStore.ts` | `lastOperationContext` + `isAssistantOpen` 状态 |
| `src/utils/errorContext.ts` | `buildErrorContext()` 三类模板函数；内部 try-catch，失败返回 `markdownContext: null` |
| `src/utils/askAi.ts` | `askAiWithContext()` 统一触发函数 |
| `src/components/Assistant/AssistantToggleTab.tsx` | 右边缘常驻 Tab 按钮 |

### 改动文件

| 文件 | 具体改动 |
|------|----------|
| `src/store/connectionStore.ts` | 新增 `metaCache: Record<number, ConnectionMeta>`；新增 `setMeta(id, meta)` action |
| `src/store/aiStore.ts` | 新增 `draftMessage: string`、`setDraftMessage(msg)` action |
| `src/App.tsx` | `isAssistantOpen` 改从 `appStore` 读取；挂载 `AssistantToggleTab`；主内容区 + 面板加 CSS transition |
| `src/components/ActivityBar/index.tsx` | 移除 `isAssistantOpen` prop，改用 `appStore` |
| `src/components/Assistant/index.tsx` | 移除 `isAssistantOpen`/`setIsAssistantOpen` prop；`chatInput` 受 `draftMessage` 初始化控制（消费后清空 `draftMessage`） |
| `src/components/Toast/index.tsx` | 接收 `markdownContext?: string` prop；新增"问 AI"按钮 |
| `src/components/TaskCenter/TaskItem.tsx` | 失败状态展开区底部新增"问 AI 分析失败原因"按钮 |
| `src/components/MainContent/index.tsx` | 查询错误区新增"问 AI"按钮；移除工具栏 AI 打开按钮 |
| `src/store/queryStore.ts` | `executeQuery()` 调用前写入 `appStore.setLastOperationContext({type:'sql_execute', ...})` |
| `src/components/ImportExport/ExportWizard.tsx` | `invoke('export_tables')` 前写入 `lastOperationContext({type:'export', ...})` |
| `src/components/ImportExport/ImportWizard.tsx` | `invoke('import_to_table')` 前写入 `lastOperationContext({type:'import', ...})` |
| `src/store/aiStore.ts`（AI 请求） | `explainSql`/`optimizeSql` 等请求前写入 `lastOperationContext`；catch 中补 `httpStatus` |
| `src-tauri/src/commands.rs` | 新增 `get_db_version` 命令 |
| `src-tauri/src/lib.rs` | 注册 `get_db_version` |
| `src/i18n/locales/zh.json` + `en.json` | 新增 `error.askAi`、`error.askAiAnalyze`、`error.copyError` |
| `src/index.css` | 新增 `.assistant-panel`、`.assistant-panel-content`、`.main-content-area` 动画 CSS |

---

## 十二、边界情况与降级

| 场景 | 处理方式 |
|------|----------|
| `tableCache` 为空 | 省略"相关表结构"节 |
| `dbVersion` 未缓存 | 省略版本行 |
| `errorDetails` 超过10条 | 截取前10条，注明"共 N 条，仅展示前10条" |
| `buildErrorContext` 内部抛异常 | try-catch 降级，返回 `markdownContext: null`，不显示"问 AI"按钮 |
| LLM 未配置 | `askAiWithContext` 照常打开面板，用户在面板内看到配置提示 |
| AI 正在自动诊断（isChatting） | `clearHistory()` 后填入新上下文，不中断 Rust 侧的已有请求（cancel 逻辑可后续扩展） |
| 多 Tab 并行失败 | `lastOperationContext` 以最后写入为准，可接受；后续可按 tabId 隔离 |

---

## 十三、本期不做

- AI 诊断结果的自动跟进
- `lastOperationContext` 按 tabId 严格隔离
- Toast 多条堆叠优化
- 取消 Rust 侧已有 AI 流式请求（`cancelChat` 已有，但与 clearHistory 的协调留后期）
