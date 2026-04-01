<!-- STATUS: ✅ 已实现 -->
# AI 建表功能设计规格

**日期：** 2026-03-17
**状态：** 已批准
**功能：** 在"新建表"对话框中集成 AI 建表能力

---

## 1. 功能概述

在 `TableManageDialog`（新建表/编辑表对话框）顶部新增 AI 建表面板。用户输入自然语言描述，点击生成后 AI 返回结构化字段定义，逐条动画填入表格，同时自动填写表名。

**仅在新建表场景下展示 AI 面板**（`tableName` prop 为 undefined 时）。编辑现有表时不显示 AI 面板。

---

## 2. 前置条件：新增表名输入字段

`TableManageDialog` 当前**没有**表名输入框，新建表时 SQL 预览硬编码使用 `'new_table'`（见代码第 216 行）。本次实现需要：
1. 新增 `localTableName: string` state（初始为 `''`）
2. 在列表上方增加表名输入行（仅 `!tableName` 时显示）
3. **同步更新代码第 216 行的 `previewSql` 计算**：
   ```typescript
   // 旧：generateSql(tableName ?? 'new_table', ...)
   // 新：generateSql(tableName ?? localTableName || 'new_table', ...)
   ```

---

## 3. 数据流

```
用户描述
  → TableManageDialog AI面板（前端）
  → invoke('ai_generate_table_schema', { description, connectionId })
  → Rust: 通过 connectionId 查询 driver，构造 Prompt（含 JSON Schema + 类型枚举）
  → LLM API → 返回完整 JSON 字符串
  → Rust: 解析并校验 JSON，失败则自动重试一次
  → 前端（mountedRef 守卫，组件已卸载则丢弃结果）:
      若当前 visibleColumns.length > 0（以 invoke 返回时的快照为准）:
        弹确认框（替换 / 追加 / 取消）
        （确认框打开期间禁用列表编辑和执行按钮）
      否则: 直接进入 filling
  → 模拟流式填入（每 80ms 插入一条字段，fillingRef 支持中断）
  → 自动填写 localTableName
  → AI 面板自动收起，状态回到 idle（描述文字保留，便于重新生成）
```

---

## 4. 后端设计

### 4.1 新增 Rust 命令

```rust
// src-tauri/src/commands.rs
#[tauri::command]
async fn ai_generate_table_schema(
    description: String,
    connection_id: i64,
) -> Result<TableSchemaResult, String>
```

**说明：**
- 不接收 `driver` 参数，Rust 内部通过 `connection_id` 查询数据库驱动类型，与现有命令模式一致
- `connection_id` 为必填 `i64`，若查询不到对应连接则返回 `Err("Connection not found")`
- **注册：** 在 `lib.rs` 的 `generate_handler![]` 中添加 `ai_generate_table_schema`

**与现有命令关系：** `ai_create_table`（返回 DDL 字符串，供 `AiCreateTableDialog` 使用）与本命令**并存**，职责不同——旧命令生成可执行 DDL，新命令生成结构化字段数组供 UI 填充。

### 4.2 返回数据结构

```rust
#[derive(Serialize, Deserialize)]
pub struct TableSchemaResult {
    pub table_name: String,
    pub columns: Vec<AiColumnDef>,
}

#[derive(Serialize, Deserialize)]
pub struct AiColumnDef {
    pub name: String,
    pub column_type: String,       // 避免与 Rust 关键字 type 冲突
    pub length: Option<u32>,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub comment: String,
}
```

### 4.3 Prompt 模板

文件：`prompts/generate_table_schema.txt`（使用 `{{DOUBLE_BRACE}}` 与现有模板一致）

```
You are a database design expert. Generate a table schema based on the description below.

Database type: {{DRIVER}}
Allowed column types (use ONLY these values): {{TYPE_ENUM}}

Output rules:
- Return ONLY raw JSON. No markdown, no code blocks, no explanation.
- table_name must use lowercase_with_underscores
- Each column's comment should describe its purpose concisely
- Primary key column should use auto_increment: true for MySQL, or type SERIAL for PostgreSQL

JSON Schema:
{
  "table_name": "string",
  "columns": [
    {
      "name": "string",
      "column_type": "string (from allowed list only)",
      "length": null | number,
      "nullable": boolean,
      "default_value": null | "string",
      "primary_key": boolean,
      "auto_increment": boolean,
      "comment": "string"
    }
  ]
}

Description: {{DESCRIPTION}}
```

Rust 中替换时使用 `.replace("{{DRIVER}}", driver)` 等，与现有模板替换逻辑保持一致。

### 4.4 类型枚举（按数据库类型）

| 驱动 | 合法类型 |
|------|---------|
| mysql | INT, BIGINT, TINYINT, SMALLINT, VARCHAR, TEXT, LONGTEXT, DATETIME, DATE, TIMESTAMP, DECIMAL, FLOAT, DOUBLE, BOOLEAN, BLOB |
| postgres / postgresql | INTEGER, BIGINT, SMALLINT, VARCHAR, TEXT, TIMESTAMP, DATE, NUMERIC, BOOLEAN, BYTEA, UUID, JSONB, SERIAL |
| 其他/未知 | 使用 MySQL 枚举兜底 |

### 4.5 校验与重试逻辑

1. 调用 LLM 获取完整响应
2. 尝试解析 JSON
3. 若解析失败 → 自动用相同参数重试一次
4. 重试仍失败 → 返回 `Err("AI returned invalid JSON format, please try again")`
5. 解析成功后校验：`columns` 非空、每列必须有 `name` 和 `column_type`
6. `column_type` 不在枚举内 → 使用 `log::warn!` 记录警告，保留原值（容错，不阻断）
7. 所有错误消息使用英文（与项目其他 Rust 错误一致）

---

## 5. 前端设计

### 5.1 改动范围

**唯一修改文件：** `src/components/TableManageDialog/index.tsx`

不新增组件文件，不修改 aiStore、Assistant、AiCreateTableDialog。

### 5.2 新增：表名输入框

新建表时（`!tableName`），在 AI 面板下方、列表上方增加表名输入行：

```
表名: [_________________________]
```

状态：`const [localTableName, setLocalTableName] = useState('')`

### 5.3 AI 面板 UI 结构（仅新建表时显示）

```
┌─────────────────────────────────────────────┐
│  ✨ AI 建表                          [收起 ∧] │
├─────────────────────────────────────────────┤
│  ┌───────────────────────────────────────┐  │
│  │ 描述你想要的表，例如：                   │  │
│  │ "用户表，包含昵称、头像、手机号、注册时间"  │  │
│  └───────────────────────────────────────┘  │
│                              [生成字段 →]    │
└─────────────────────────────────────────────┘
```

生成中状态（输入框只读，按钮禁用，**列表行输入框和执行按钮也禁用**）：

```
┌─────────────────────────────────────────────┐
│  ✨ AI 建表                          [收起 ∧] │
├─────────────────────────────────────────────┤
│  [描述输入框（只读）]              [重新生成]  │
│  ⟳ 正在生成...                               │
│  （红色错误提示，仅在 error 状态显示）          │
└─────────────────────────────────────────────┘
```

### 5.4 状态机

```
idle
  → loading（点击"生成字段"，禁用：描述输入框、生成按钮、列表行输入、执行按钮）
      → error（LLM失败，显示红色错误，面板保持展开，解除禁用）→ idle
      → [mountedRef 检查，若已卸载则丢弃] confirming / filling
      → confirming（invoke 返回时 visibleColumns.length > 0，弹确认框，保持禁用列表和执行）
          → filling（用户选择替换/追加）
          → idle（用户取消，解除禁用）
      → filling（invoke 返回时 visibleColumns.length === 0）
  filling
      → idle（fillingRef.current = false 中断，或正常完成）
        填入完成时：setAiPanelOpen(false)，描述文字保留
```

### 5.5 确认对话框

```
应用 AI 生成的字段

AI 已生成 N 个字段，当前表格已有 M 个字段。

[替换现有字段]  [追加到末尾]  [取消]
```

**确认框打开期间：** 列表行的输入框、"+ 添加字段"按钮、"执行"按钮全部设为 `disabled`，防止状态不同步。

### 5.6 组件卸载保护

```typescript
const mountedRef = useRef(true);
const fillingRef = useRef(false);

useEffect(() => {
  mountedRef.current = true;
  return () => {
    mountedRef.current = false;
    fillingRef.current = false;  // 中断进行中的填入动画
  };
}, []);
```

`invoke` 回调中所有 `setState` 调用前检查 `if (!mountedRef.current) return`。

### 5.7 流式填入动画

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
    setAiPanelOpen(false);  // 填入完成，收起 AI 面板，描述文字保留
    setAiState('idle');
  }
};
```

### 5.8 后端返回值映射到 EditableColumn

前端通过 `useConnectionStore` 获取 `driver`（与现有代码第 149 行相同模式）：

```typescript
const driver = connections.find(c => c.id === connectionId)?.driver ?? 'mysql';
```

映射函数：

```typescript
function mapAiColumn(col: AiColumnDef, driver: string): EditableColumn {
  const isPostgres = driver === 'postgres' || driver === 'postgresql';
  // PostgreSQL 中 auto_increment 通过 SERIAL 类型表达，extra 留空
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

**表名填写：** AI 返回的 `table_name` → `setLocalTableName(result.table_name)`

---

## 6. Prompt 文件新增

`prompts/generate_table_schema.txt` — 新增文件，使用 `{{PLACEHOLDER}}` 双大括号语法，与 `prompts/sql_create_table.txt` 等现有模板一致。

---

## 7. 不在本次范围内

- 修改 `AiCreateTableDialog`（保留现状）
- 修改 `aiStore`（新功能直接 `invoke`，不经过 store）
- 表注释字段（当前 `TableManageDialog` 无此字段，后续迭代）
- 多轮对话修正字段（后续迭代）

---

## 8. 验收标准

1. 新建表时，对话框顶部显示 AI 建表面板；编辑已有表时不显示
2. 新建表时，对话框顶部显示表名输入框，AI 生成后自动填入表名；SQL 预览随表名输入实时更新
3. 输入描述后点击生成，字段以 80ms 间隔逐条出现在表格中
4. 有现有字段时弹出确认框，"替换"/"追加"/"取消"均按预期工作
5. AI 返回格式错误（两次重试均失败）时，面板内显示英文错误提示，不崩溃
6. `column_type` 超出枚举时，Rust 单元测试可通过硬编码含无效类型的 JSON 字符串验证 `warn!` 被调用，字段仍正常返回
7. 组件卸载时（用户关闭对话框），正在进行的填入动画立即停止，无 React 控制台警告
8. 确认框打开时，列表行、添加按钮、执行按钮均被禁用
9. `loading` 状态期间（invoke 进行中），列表行输入和执行按钮被禁用
10. AI 生成成功后，描述文字保留，面板自动收起，用户可再次点击展开重新生成
