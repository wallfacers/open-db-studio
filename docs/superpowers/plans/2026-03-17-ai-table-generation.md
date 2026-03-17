# AI 建表功能 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 TableManageDialog 新建表时集成 AI 面板，用户输入自然语言描述后 AI 生成结构化字段并流式填入表格。

**Architecture:** 新增 Rust 命令 `ai_generate_table_schema`，通过 `connection_id` 查询 driver，构造带 JSON Schema 约束的 Prompt 调用 LLM，返回结构化字段数组；前端 `TableManageDialog` 新增表名输入框和 AI 面板，收到结果后用 80ms 间隔逐条填入，双 ref 守卫防卸载泄漏。

**Tech Stack:** Rust / Tauri 2.x，React 18 + TypeScript，serde_json，lucide-react

---

## 文件改动一览

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `prompts/generate_table_schema.txt` | AI 建表 Prompt 模板 |
| 修改 | `src-tauri/src/llm/client.rs` | 新增 `generate_table_schema` 方法 |
| 修改 | `src-tauri/src/commands.rs` | 新增结构体 + `ai_generate_table_schema` 命令 |
| 修改 | `src-tauri/src/lib.rs` | 注册新命令 |
| 修改 | `src/components/TableManageDialog/index.tsx` | 表名输入框 + AI 面板 |

---

## Chunk 1: 后端实现

### Task 1: 新增 Prompt 模板

**Files:**
- Create: `prompts/generate_table_schema.txt`

- [ ] **Step 1: 创建 Prompt 文件**

```
You are a database design expert. Generate a table schema based on the description below.

Database type: {{DRIVER}}
Allowed column types (use ONLY these values): {{TYPE_ENUM}}

Output rules:
- Return ONLY raw JSON. No markdown, no code blocks, no explanation.
- table_name must use lowercase_with_underscores
- Each column comment should describe its purpose concisely
- Primary key column should use auto_increment: true for MySQL, or type SERIAL for PostgreSQL

JSON Schema:
{
  "table_name": "string",
  "columns": [
    {
      "name": "string",
      "column_type": "string (from allowed list only)",
      "length": null,
      "nullable": false,
      "default_value": null,
      "primary_key": false,
      "auto_increment": false,
      "comment": "string"
    }
  ]
}

Description: {{DESCRIPTION}}
```

- [ ] **Step 2: 验证文件路径和格式**

对比 `prompts/sql_create_table.txt`，确认 `{{DOUBLE_BRACE}}` 格式一致。

---

### Task 2: 在 client.rs 新增结构体和方法

**Files:**
- Modify: `src-tauri/src/llm/client.rs`（在 `create_table_ddl` 方法附近，约第 278 行之后）

- [ ] **Step 1: 在 `client.rs` 文件顶部（use 之后，结构体区域）添加返回结构体**

在文件中找到已有的结构体定义区域，新增：

```rust
/// AI 建表返回的单列定义
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiColumnDef {
    pub name: String,
    pub column_type: String,
    pub length: Option<u32>,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub comment: String,
}

/// AI 建表返回的完整表结构
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableSchemaResult {
    pub table_name: String,
    pub columns: Vec<AiColumnDef>,
}
```

- [ ] **Step 2: 在 `create_table_ddl` 方法之后添加 `generate_table_schema` 方法**

```rust
/// AI 建表 — 返回结构化字段数组（供 TableManageDialog 填充）
pub async fn generate_table_schema(
    &self,
    description: &str,
    driver: &str,
) -> AppResult<TableSchemaResult> {
    let type_enum = match driver {
        "postgres" | "postgresql" => {
            "INTEGER, BIGINT, SMALLINT, VARCHAR, TEXT, TIMESTAMP, DATE, NUMERIC, BOOLEAN, BYTEA, UUID, JSONB, SERIAL"
        }
        _ => {
            "INT, BIGINT, TINYINT, SMALLINT, VARCHAR, TEXT, LONGTEXT, DATETIME, DATE, TIMESTAMP, DECIMAL, FLOAT, DOUBLE, BOOLEAN, BLOB"
        }
    };

    let system_prompt = include_str!("../../../prompts/generate_table_schema.txt")
        .replace("{{DRIVER}}", driver)
        .replace("{{TYPE_ENUM}}", type_enum)
        .replace("{{DESCRIPTION}}", description);

    // description 已嵌入 system_prompt，user 消息使用固定触发语避免重复
    let messages = vec![
        ChatMessage { role: "system".into(), content: system_prompt },
        ChatMessage { role: "user".into(), content: "Generate table schema.".to_string() },
    ];

    // 第一次尝试
    let raw = self.chat(messages.clone()).await?;
    if let Ok(result) = serde_json::from_str::<TableSchemaResult>(&raw) {
        if !result.columns.is_empty() {
            return Ok(result);
        }
    }

    // 自动重试一次
    log::warn!("[generate_table_schema] First attempt returned invalid JSON, retrying...");
    let raw2 = self.chat(messages).await?;
    serde_json::from_str::<TableSchemaResult>(&raw2)
        .map_err(|e| crate::AppError::Other(
            format!("AI returned invalid JSON format, please try again. Detail: {e}")
        ))
}
```

- [ ] **Step 3: cargo check 确认编译通过**

```bash
cd src-tauri && cargo check
```

预期：无错误，`AiColumnDef` 和 `TableSchemaResult` 正确编译。

---

### Task 3: 在 commands.rs 新增命令

**Files:**
- Modify: `src-tauri/src/commands.rs`（在 `ai_create_table` 命令之后，约第 974 行）

- [ ] **Step 1: 在 `ai_create_table` 函数之后添加新命令**

```rust
#[tauri::command]
pub async fn ai_generate_table_schema(
    description: String,
    connection_id: i64,
) -> AppResult<crate::llm::client::TableSchemaResult> {
    let client = build_llm_client()?;
    let config = crate::db::get_connection_config(connection_id)?;
    let driver = &config.driver;

    // 校验返回的 column_type 是否在合法枚举内（仅记录警告，不阻断）
    let mut result = client.generate_table_schema(&description, driver).await?;
    let valid_types: &[&str] = match driver.as_str() {
        "postgres" | "postgresql" => &[
            "INTEGER", "BIGINT", "SMALLINT", "VARCHAR", "TEXT", "TIMESTAMP",
            "DATE", "NUMERIC", "BOOLEAN", "BYTEA", "UUID", "JSONB", "SERIAL",
        ],
        _ => &[
            "INT", "BIGINT", "TINYINT", "SMALLINT", "VARCHAR", "TEXT", "LONGTEXT",
            "DATETIME", "DATE", "TIMESTAMP", "DECIMAL", "FLOAT", "DOUBLE", "BOOLEAN", "BLOB",
        ],
    };
    for col in &result.columns {
        // 先绑定临时值再借用，避免悬垂引用编译错误
        if !valid_types.iter().any(|t| t.eq_ignore_ascii_case(&col.column_type)) {
            log::warn!(
                "[ai_generate_table_schema] column '{}' has non-standard type '{}', keeping as-is",
                col.name,
                col.column_type
            );
        }
    }

    Ok(result)
}
```

- [ ] **Step 2: cargo check 确认编译通过**

```bash
cd src-tauri && cargo check
```

---

### Task 4: 在 lib.rs 注册命令

**Files:**
- Modify: `src-tauri/src/lib.rs`（在 `commands::ai_create_table,` 所在行之后）

- [ ] **Step 1: 在 `commands::ai_create_table,` 行后新增一行**

```rust
commands::ai_generate_table_schema,
```

- [ ] **Step 2: cargo check 确认注册正确**

```bash
cd src-tauri && cargo check
```

预期：无错误。

- [ ] **Step 3: 提交后端变更**

```bash
git add prompts/generate_table_schema.txt src-tauri/src/llm/client.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(backend): add ai_generate_table_schema command with structured JSON output"
```

---

## Chunk 2: 前端实现

### Task 5: 新增表名输入框

**Files:**
- Modify: `src/components/TableManageDialog/index.tsx`

- [ ] **Step 1: 在组件 state 区域新增 `localTableName` state**

在第 143 行附近（`const [columns, setColumns]...` 之后）新增：

```typescript
const [localTableName, setLocalTableName] = useState('');
```

- [ ] **Step 2: 修复 previewSql 计算（第 216 行）**

将：
```typescript
const previewSql = generateSql(tableName ?? 'new_table', originalColumns, columns, driver, !tableName);
```
改为：
```typescript
const previewSql = generateSql(tableName ?? localTableName || 'new_table', originalColumns, columns, driver, !tableName);
```

- [ ] **Step 3: 在列表上方（`isLoadingData` 判断块之前）添加表名输入行**

在 `<div className="overflow-auto flex-1 p-4">` 内部，`{isLoadingData ? ...` 之前插入：

```tsx
{/* 新建表时显示表名输入 */}
{!tableName && (
  <div className="flex items-center gap-2 mb-3">
    <span className="text-xs text-[#7a9bb8] whitespace-nowrap">{t('tableManage.tableName')}</span>
    <input
      className="flex-1 bg-[#0d1520] border border-[#2a3f5a] rounded px-2 py-1 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
      value={localTableName}
      onChange={e => setLocalTableName(e.target.value)}
      placeholder="e.g. users"
    />
  </div>
)}
```

- [ ] **Step 4: 添加 i18n key（如项目使用 i18n）**

在 `public/locales/zh/translation.json`（或对应语言文件）中，`tableManage` 节点内添加：
```json
"tableName": "表名"
```

如项目中未找到该文件，可直接用字符串 `"表名"` 替换 `{t('tableManage.tableName')}`。

- [ ] **Step 5: 快速验证**

`npm run dev` 打开新建表对话框，确认：
- 顶部出现"表名"输入框
- 输入表名后，SQL 预览区域实时更新（不再显示 `new_table`）

---

### Task 6: 新增 AI 面板 UI 骨架

**Files:**
- Modify: `src/components/TableManageDialog/index.tsx`

- [ ] **Step 1: 新增 AI 面板所需 state 和 refs**

在 `localTableName` state 之后添加：

```typescript
// AI 面板状态
const [aiPanelOpen, setAiPanelOpen] = useState(true); // 新建表时默认展开
const [aiDescription, setAiDescription] = useState('');
type AiState = 'idle' | 'loading' | 'error' | 'confirming' | 'filling';
const [aiState, setAiState] = useState<AiState>('idle');
const [aiError, setAiError] = useState('');

// 卸载守卫
const mountedRef = useRef(true);
const fillingRef = useRef(false);

useEffect(() => {
  mountedRef.current = true;
  return () => {
    mountedRef.current = false;
    fillingRef.current = false;
  };
}, []);
```

- [ ] **Step 2: 在表名输入行之前插入 AI 面板 UI**

在 `{!tableName && (<div ... 表名输入行>)}` 之前插入：

```tsx
{/* AI 建表面板（仅新建表时显示）*/}
{!tableName && (
  <div className="mb-3 border border-[#1e2d42] rounded overflow-hidden">
    <button
      className="w-full flex items-center justify-between px-3 py-2 bg-[#0d1520] text-xs text-[#7a9bb8] hover:text-[#c8daea]"
      onClick={() => setAiPanelOpen(v => !v)}
    >
      <span className="flex items-center gap-1.5">
        <Sparkles size={13} className="text-[#009e84]" />
        AI 建表
      </span>
      {aiPanelOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
    </button>

    {aiPanelOpen && (
      <div className="p-3 bg-[#111922] space-y-2">
        <textarea
          className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84] resize-none h-[60px] disabled:opacity-50"
          placeholder='描述你想要的表，例如："用户表，包含昵称、头像、手机号、注册时间"'
          value={aiDescription}
          onChange={e => setAiDescription(e.target.value)}
          disabled={aiState === 'loading'}
        />
        {aiError && (
          <p className="text-xs text-red-400">{aiError}</p>
        )}
        <div className="flex justify-end">
          <button
            onClick={handleAiGenerate}
            disabled={aiState === 'loading' || !aiDescription.trim()}
            className="px-3 py-1 bg-[#009e84] text-white rounded text-xs hover:bg-[#007a67] disabled:opacity-50 flex items-center gap-1"
          >
            {aiState === 'loading' ? (
              <><span className="animate-spin inline-block w-3 h-3 border border-white border-t-transparent rounded-full" /> 正在生成...</>
            ) : '生成字段 →'}
          </button>
        </div>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 3: 更新文件顶部 import**

第 1 行补充 `useRef`：
```typescript
import React, { useState, useEffect, useCallback, useRef } from 'react';
```

第 4 行补充 `Sparkles`：
```typescript
import { X, Plus, Trash2, ChevronUp, ChevronDown, Sparkles } from 'lucide-react';
```

- [ ] **Step 4: 添加占位函数（防编译报错）**

在组件内（state 定义之后）临时添加：

```typescript
const handleAiGenerate = async () => { /* TODO */ };
```

- [ ] **Step 5: 快速验证 UI 渲染**

`npm run dev` 打开新建表对话框，确认：
- AI 面板默认展开，显示 textarea 和"生成字段"按钮
- 可点击标题栏折叠/展开
- 编辑已有表时 AI 面板不显示

---

### Task 7: 实现 handleAiGenerate 核心逻辑

**Files:**
- Modify: `src/components/TableManageDialog/index.tsx`

AI 返回的字段类型定义（在组件文件顶部 interface 区域添加）：

```typescript
interface AiColumnDef {
  name: string;
  column_type: string;
  length: number | null;
  nullable: boolean;
  default_value: string | null;
  primary_key: boolean;
  auto_increment: boolean;
  comment: string;
}

interface TableSchemaResult {
  table_name: string;
  columns: AiColumnDef[];
}
```

- [ ] **Step 1: 添加 `mapAiColumn` 辅助函数（在组件函数外、`generateSql` 之后）**

```typescript
function mapAiColumn(col: AiColumnDef, driver: string): EditableColumn {
  const isPostgres = driver === 'postgres' || driver === 'postgresql';
  // PostgreSQL 中 auto_increment 通过 SERIAL 类型表达
  const dataType = (isPostgres && col.auto_increment) ? 'SERIAL' : col.column_type;
  const extra = (!isPostgres && col.auto_increment) ? 'auto_increment' : '';
  return {
    id: makeId(),
    name: col.name,
    dataType,
    length: col.length ? String(col.length) : '',
    isNullable: col.nullable,
    defaultValue: col.default_value ?? '',
    isPrimaryKey: col.primary_key,
    extra,
    _isNew: true,
  };
}
```

- [ ] **Step 2: 添加 `fillColumns` 动画函数（在组件函数内，state 定义之后）**

```typescript
const fillColumns = async (newCols: EditableColumn[], mode: 'replace' | 'append') => {
  fillingRef.current = true;
  if (mode === 'replace') setColumns([]);
  for (const col of newCols) {
    if (!fillingRef.current || !mountedRef.current) break;
    await new Promise(r => setTimeout(r, 80));
    if (!mountedRef.current) break;
    setColumns(prev => [...prev, col]);
  }
  fillingRef.current = false;
  if (mountedRef.current) {
    setAiState('idle');
    setAiPanelOpen(false);
  }
};
```

**说明：** `replace` 模式先 `setColumns([])` 清空再逐条追加；`append` 模式直接逐条追加。两种模式均使用函数式 `prev => [...prev, col]` 避免闭包捕获旧值。

- [ ] **Step 3: 用真实逻辑替换 `handleAiGenerate` 占位函数**

```typescript
const handleAiGenerate = async () => {
  if (!aiDescription.trim()) return;
  setAiState('loading');
  setAiError('');

  let result: TableSchemaResult;
  try {
    result = await invoke<TableSchemaResult>('ai_generate_table_schema', {
      description: aiDescription,
      connectionId,
    });
  } catch (e) {
    if (!mountedRef.current) return;
    setAiState('error');
    setAiError(String(e));
    return;
  }

  if (!mountedRef.current) return;

  const mappedCols = result.columns.map(c => mapAiColumn(c, driver));

  // 填写表名
  setLocalTableName(result.table_name);

  // 判断是否需要确认
  const currentVisible = columns.filter(c => !c._isDeleted);
  if (currentVisible.length > 0) {
    setAiState('confirming');
    // 暂存待填充的列，等用户确认后调用 fillColumns
    setPendingAiCols({ cols: mappedCols, count: mappedCols.length, existingCount: currentVisible.length });
  } else {
    setAiState('filling');
    fillColumns(mappedCols, 'replace');
  }
};
```

- [ ] **Step 4: 新增 `pendingAiCols` state（用于确认弹窗）**

```typescript
const [pendingAiCols, setPendingAiCols] = useState<{
  cols: EditableColumn[];
  count: number;
  existingCount: number;
} | null>(null);
```

---

### Task 8: 实现确认弹窗

**Files:**
- Modify: `src/components/TableManageDialog/index.tsx`

- [ ] **Step 1a: 先给内层对话框 div 加 `relative`**

将第 245 行（内层对话框容器）：
```tsx
<div className="bg-[#111922] border border-[#253347] rounded-lg w-[800px] max-h-[85vh] flex flex-col">
```
改为：
```tsx
<div className="bg-[#111922] border border-[#253347] rounded-lg w-[800px] max-h-[85vh] flex flex-col relative">
```

**必须先加 `relative`**，否则后续 `absolute inset-0` 的确认弹窗会相对于视口定位，全屏显示。

- [ ] **Step 1b: 插入确认弹窗 JSX**

**插入位置：** 底部按钮行 `<div className="flex justify-end gap-2 p-4 ...">...</div>` **之后**，作为内层 flex-col div 的直接子元素（与 `overflow-auto` 容器同级，不要插入其内部）：

```tsx
{/* AI 字段应用确认弹窗 */}
{aiState === 'confirming' && pendingAiCols && (
  <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10 rounded-lg">
    <div className="bg-[#111922] border border-[#253347] rounded-lg p-5 w-[320px] space-y-3">
      <p className="text-sm text-[#c8daea] font-medium">应用 AI 生成的字段</p>
      <p className="text-xs text-[#7a9bb8]">
        AI 已生成 {pendingAiCols.count} 个字段，当前表格已有 {pendingAiCols.existingCount} 个字段。
      </p>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => {
            setAiState('filling');
            fillColumns(pendingAiCols.cols, 'replace');
            setPendingAiCols(null);
          }}
          className="flex-1 px-2 py-1.5 bg-[#3794ff] text-white rounded text-xs hover:bg-[#2b7cdb]"
        >替换现有字段</button>
        <button
          onClick={() => {
            setAiState('filling');
            fillColumns(pendingAiCols.cols, 'append');
            setPendingAiCols(null);
          }}
          className="flex-1 px-2 py-1.5 bg-[#1a2639] text-[#c8daea] rounded text-xs hover:bg-[#253347]"
        >追加到末尾</button>
        <button
          onClick={() => {
            setAiState('idle');
            setPendingAiCols(null);
          }}
          className="px-2 py-1.5 text-[#7a9bb8] rounded text-xs hover:text-[#c8daea]"
        >取消</button>
      </div>
    </div>
  </div>
)}
```

**注意：** 确认弹窗使用 `absolute` 定位覆盖对话框，需要对话框最外层 `<div>` 加 `relative` 类名。将第 244 行：
```tsx
<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
  <div className="bg-[#111922] border border-[#253347] rounded-lg w-[800px] max-h-[85vh] flex flex-col">
```
内层 div 改为：
```tsx
<div className="bg-[#111922] border border-[#253347] rounded-lg w-[800px] max-h-[85vh] flex flex-col relative">
```

- [ ] **Step 2: 在 loading 和 confirming 状态下禁用主体编辑**

找到列表行的输入框和添加字段按钮，在 `loading` 和 `confirming` 状态期间禁用。

在 `visibleColumns.map((col, idx) => ...)` 的各输入组件上添加 `disabled` 条件：

```tsx
disabled={aiState === 'loading' || aiState === 'confirming'}
```

具体需要处理的元素（loading / confirming / filling 三种状态均需禁用）：

**列名 input / 长度 input / 默认值 input / extra input：**
```tsx
disabled={aiState === 'loading' || aiState === 'confirming' || aiState === 'filling'}
```

**可空 checkbox / 主键 checkbox：**
```tsx
disabled={aiState === 'loading' || aiState === 'confirming' || aiState === 'filling'}
```

**移动和删除按钮（`moveColumn` / `setColumns` 按钮）：**
```tsx
disabled={idx === 0 || aiState === 'loading' || aiState === 'confirming' || aiState === 'filling'}
// 删除按钮同理加 disabled 条件
```

**DropdownSelect 无 disabled prop，需用 wrapper div 包裹：**
```tsx
<div className={aiState === 'loading' || aiState === 'confirming' || aiState === 'filling' ? 'pointer-events-none opacity-50' : ''}>
  <DropdownSelect
    value={col.dataType}
    options={getTypeOptions(col.dataType)}
    onChange={v => updateColumn(col.id, { dataType: v })}
    className="w-full"
  />
</div>
```

**底部"+ 添加字段"按钮：**
```tsx
<button
  onClick={addColumn}
  disabled={aiState === 'loading' || aiState === 'confirming' || aiState === 'filling'}
  className="mt-2 flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#009e84] px-2 py-1 disabled:opacity-40"
>
```

**底部"执行"按钮的 `disabled` 条件：**
```tsx
disabled={isLoading || previewSql.startsWith('-- ') || isLoadingData || aiState === 'loading' || aiState === 'confirming' || aiState === 'filling'}
```

---

### Task 9: 完整功能验证和收尾

**Files:**
- Modify: `src/components/TableManageDialog/index.tsx`（清理和最终检查）

- [ ] **Step 1: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

预期：0 错误。如有类型错误，修复后重新运行。

- [ ] **Step 2: 手动验证完整流程（需要配置好 LLM）**

1. 右键数据库树 tables 节点 → 新建表
2. 确认顶部显示 AI 面板（默认展开）
3. 输入描述："用户表，包含昵称、头像URL、手机号、注册时间、是否禁用"
4. 点击"生成字段 →"，观察 loading 状态
5. 生成完成后确认字段逐条出现（80ms 间隔）
6. 确认表名输入框自动填入
7. 观察 SQL 预览区域实时生成 CREATE TABLE 语句

- [ ] **Step 3: 验证确认弹窗流程**

1. 手动添加几个字段
2. 再次点击"生成字段"
3. 确认弹出确认框，三个按钮均正常工作

- [ ] **Step 4: 验证错误处理**

1. 断开网络或使用无效 LLM 配置
2. 点击"生成字段"
3. 确认面板内显示红色错误信息，不崩溃，按钮恢复可点击

- [ ] **Step 5: 验证编辑表时不显示 AI 面板**

1. 右键已有表节点 → 编辑表结构
2. 确认 AI 面板和表名输入框均不显示

- [ ] **Step 6: 提交前端变更**

```bash
git add src/components/TableManageDialog/index.tsx
git commit -m "feat(frontend): add AI table generation panel to TableManageDialog"
```

---

## 最终检查清单

- [ ] `cargo check` 通过（后端）
- [ ] `npx tsc --noEmit` 通过（前端）
- [ ] 新建表时 AI 面板正常显示/折叠
- [ ] 表名自动填入，SQL 预览实时更新
- [ ] 字段流式填入（80ms 间隔）
- [ ] 有现有字段时弹出确认框
- [ ] 关闭对话框时无 React 控制台警告
- [ ] 编辑已有表时无 AI 面板
