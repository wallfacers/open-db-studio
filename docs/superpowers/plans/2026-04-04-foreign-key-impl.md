# 外键约束创建 & comment_parser 增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在新建/编辑表对话框中加入字段/外键/索引三 tab 管理，同时增强 comment_parser.rs 使其返回去除标记后的干净描述文本。

**Architecture:** Rust 后端 `comment_parser.rs` 新增 `ParsedComment` 结构体和 `parse_comment()` 函数，向后兼容；前端在 `tableFormStore` 新增 `TableFormForeignKey` 类型，`TableFormAdapter` 增加 FK SQL 生成逻辑，`TableManageDialog` 重构为 Tab 布局。两部分完全独立，Rust 先做。

**Tech Stack:** Rust (regex crate)、TypeScript、React 18、Zustand、Tailwind CSS

---

## File Map

| 文件 | 操作 |
|------|------|
| `src-tauri/src/graph/comment_parser.rs` | 修改：新增 `ParsedComment`、`parse_comment()`、6 条测试 |
| `src/store/tableFormStore.ts` | 修改：新增 `TableFormForeignKey`，`TableFormState` 加 `foreignKeys`/`originalForeignKeys` |
| `src/mcp/ui/adapters/TableFormAdapter.ts` | 修改：FK SQL 辅助函数，扩展 `generateCreateSql`/`generateAlterSql`，追加 MCP patch capabilities |
| `src/components/TableManageDialog/index.tsx` | 修改：Tab 布局，Comment 列，外键 tab，索引 tab |

---

## Task 1: comment_parser.rs — 新增 ParsedComment 和 parse_comment()

**Files:**
- Modify: `src-tauri/src/graph/comment_parser.rs`

- [ ] **Step 1: 写 6 条失败测试**

在 `src-tauri/src/graph/comment_parser.rs` 末尾的 `mod tests` 块中，紧接现有测试之后追加：

```rust
    #[test]
    fn test_parse_comment_format_then_desc() {
        let p = parse_comment("@ref:users.id 用户主键");
        assert_eq!(p.refs.len(), 1);
        assert_eq!(p.refs[0].target_table, "users");
        assert_eq!(p.clean_text, "用户主键");
    }

    #[test]
    fn test_parse_comment_desc_then_format() {
        let p = parse_comment("用户ID @ref:users.id");
        assert_eq!(p.refs.len(), 1);
        assert_eq!(p.clean_text, "用户ID");
    }

    #[test]
    fn test_parse_comment_fk_explicit_with_desc() {
        let p = parse_comment("@fk(table=orders,col=id,type=one_to_many) 订单编号");
        assert_eq!(p.refs.len(), 1);
        assert_eq!(p.refs[0].target_table, "orders");
        assert_eq!(p.refs[0].relation_type, "one_to_many");
        assert_eq!(p.clean_text, "订单编号");
    }

    #[test]
    fn test_parse_comment_no_marker_returns_original() {
        let p = parse_comment("普通备注无标记");
        assert!(p.refs.is_empty());
        assert_eq!(p.clean_text, "普通备注无标记");
    }

    #[test]
    fn test_parse_comment_only_marker_clean_empty() {
        let p = parse_comment("@ref:users.id");
        assert_eq!(p.refs.len(), 1);
        assert_eq!(p.clean_text, "");
    }

    #[test]
    fn test_parse_comment_mixed_markers_stripped() {
        let p = parse_comment("@ref:users.id [ref:orders.id] 复合描述");
        assert_eq!(p.refs.len(), 2);
        assert_eq!(p.clean_text, "复合描述");
    }
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd src-tauri && cargo test comment_parser 2>&1 | tail -20
```

预期：`error[E0425]: cannot find function 'parse_comment'`（编译失败）

- [ ] **Step 3: 实现 ParsedComment 和 parse_comment()**

在 `src-tauri/src/graph/comment_parser.rs` 中，在第 8 行（`static RE4` 之后）追加 4 个新 static，然后在 `parse_comment_refs` 函数之前追加结构体和新函数：

在 `static RE4: OnceLock<Regex> = OnceLock::new();` 之后追加：

```rust
static RE_S1: OnceLock<Regex> = OnceLock::new();
static RE_S2: OnceLock<Regex> = OnceLock::new();
static RE_S3: OnceLock<Regex> = OnceLock::new();
static RE_S4: OnceLock<Regex> = OnceLock::new();
```

在 `pub struct CommentRef` 之后（第 16 行之后）追加：

```rust
/// 解析列注释的完整结果：引用列表 + 去除标记后的干净描述
#[derive(Debug, PartialEq, Clone)]
pub struct ParsedComment {
    pub refs: Vec<CommentRef>,
    pub clean_text: String,
}
```

在 `pub fn parse_comment_refs` 之前追加：

```rust
/// 解析列注释，返回引用列表和去除所有标记后的干净描述文本。
/// 支持 格式在前+描述在后 或 描述在前+格式在后 两种书写顺序。
pub fn parse_comment(comment: &str) -> ParsedComment {
    let refs = parse_comment_refs(comment);

    let s1 = RE_S1.get_or_init(|| Regex::new(r"@ref:[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*").unwrap());
    let s2 = RE_S2.get_or_init(|| Regex::new(r"@fk\([^)]+\)").unwrap());
    let s3 = RE_S3.get_or_init(|| Regex::new(r"\[ref:[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\]").unwrap());
    let s4 = RE_S4.get_or_init(|| Regex::new(r"\$\$ref\([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\)\$\$").unwrap());

    let t = s1.replace_all(comment, "");
    let t = s2.replace_all(&t, "");
    let t = s3.replace_all(&t, "");
    let t = s4.replace_all(&t, "");
    let clean_text = t.split_whitespace().collect::<Vec<_>>().join(" ");

    ParsedComment { refs, clean_text }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd src-tauri && cargo test comment_parser 2>&1 | tail -20
```

预期：`test result: ok. 15 passed` （原有 9 条 + 新增 6 条）

- [ ] **Step 5: Rust 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | tail -10
```

预期：`Finished` 无 error

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/graph/comment_parser.rs
git commit -m "feat(comment-parser): add ParsedComment and parse_comment() with clean_text extraction"
```

---

## Task 2: tableFormStore.ts — 新增 TableFormForeignKey

**Files:**
- Modify: `src/store/tableFormStore.ts`

- [ ] **Step 1: 新增接口并扩展 TableFormState**

将 `src/store/tableFormStore.ts` 中 `export interface TableFormIndex` 之后追加新接口，并修改 `TableFormState`。

在 `export interface TableFormIndex { ... }` 块（第 29 行）之后，`export interface TableFormState` 之前追加：

```typescript
export interface TableFormForeignKey {
  id: string
  constraintName: string        // e.g. fk_orders_user_id
  column: string                // 当前表的列名
  referencedTable: string       // 引用目标表名
  referencedColumn: string      // 引用目标列名
  onDelete: string              // NO ACTION | CASCADE | SET NULL | RESTRICT | SET DEFAULT
  onUpdate: string
  _isNew?: boolean
  _isDeleted?: boolean
  _originalName?: string        // 用于 ALTER 时追踪约束名变化
}
```

将 `export interface TableFormState` 中的内容修改为（在 `originalIndexes?: TableFormIndex[]` 之后，`isNewTable?: boolean` 之前追加两行）：

```typescript
  foreignKeys: TableFormForeignKey[]
  originalForeignKeys?: TableFormForeignKey[]
```

- [ ] **Step 2: 修复持久化反序列化的向后兼容**

在 `loadPersistedFormState` 函数中，找到：

```typescript
    if (parsed.indexes && !Array.isArray(parsed.indexes)) parsed.indexes = []
```

在其之后追加：

```typescript
    if (!Array.isArray(parsed.foreignKeys)) parsed.foreignKeys = []
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无报错，或只有与本次无关的已有错误。

- [ ] **Step 4: Commit**

```bash
git add src/store/tableFormStore.ts
git commit -m "feat(store): add TableFormForeignKey type and foreignKeys to TableFormState"
```

---

## Task 3: TableFormAdapter.ts — FK SQL 生成

**Files:**
- Modify: `src/mcp/ui/adapters/TableFormAdapter.ts`

- [ ] **Step 1: 导入新类型并添加 FK 辅助函数**

在文件顶部 `import { useTableFormStore, type TableFormState, type TableFormIndex } from '../../../store/tableFormStore'` 一行中，追加 `type TableFormForeignKey`：

```typescript
import { useTableFormStore, type TableFormState, type TableFormIndex, type TableFormForeignKey } from '../../../store/tableFormStore'
```

在 `// ── Index SQL helpers ─────` 注释块之后（`generateIndexCreateSql` 函数之后），追加 FK 辅助函数：

```typescript
// ── Foreign Key SQL helpers ──────────────────────────────────────────────

function generateFkConstraintLine(fk: TableFormForeignKey, isPg: boolean): string {
  return `  CONSTRAINT ${q(fk.constraintName, isPg)} FOREIGN KEY (${q(fk.column, isPg)}) REFERENCES ${q(fk.referencedTable, isPg)} (${q(fk.referencedColumn, isPg)}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`
}

function generateFkAddSql(tableName: string, fk: TableFormForeignKey, isPg: boolean): string {
  const tbl = q(tableName, isPg)
  return `ALTER TABLE ${tbl} ADD CONSTRAINT ${q(fk.constraintName, isPg)} FOREIGN KEY (${q(fk.column, isPg)}) REFERENCES ${q(fk.referencedTable, isPg)} (${q(fk.referencedColumn, isPg)}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate};`
}

function generateFkDropSql(tableName: string, constraintName: string, isPg: boolean): string {
  const tbl = q(tableName, isPg)
  if (isPg) return `ALTER TABLE ${tbl} DROP CONSTRAINT ${q(constraintName, isPg)};`
  return `ALTER TABLE ${tbl} DROP FOREIGN KEY ${q(constraintName, isPg)};`
}

function isFkComplete(fk: TableFormForeignKey): boolean {
  return !!(fk.constraintName && fk.column && fk.referencedTable && fk.referencedColumn)
}
```

- [ ] **Step 2: 在 generateCreateSql 中追加 FK CONSTRAINT 行**

找到 `generateCreateSql` 函数中：

```typescript
  if (pkCols.length) lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`)

  const stmts = [`CREATE TABLE ${q(state.tableName, isPg)} (\n${lines.join(',\n')}\n);`]
```

在 `if (pkCols.length)...` 行之后、`const stmts` 行之前插入：

```typescript
  const activeFks = (state.foreignKeys ?? []).filter(fk => !fk._isDeleted && isFkComplete(fk))
  for (const fk of activeFks) {
    lines.push(generateFkConstraintLine(fk, isPg))
  }
```

- [ ] **Step 3: 在 generateAlterSql 中追加 FK diff 逻辑**

找到 `generateAlterSql` 函数中最后的 `return` 语句：

```typescript
  return statements.length > 0 ? statements.join('\n') : '-- No changes'
```

在 `return` 之前追加：

```typescript
  // ── Foreign Key diff ──
  const origFks = state.originalForeignKeys ?? []
  const editedFks = state.foreignKeys ?? []

  for (const fk of editedFks) {
    if (fk._isDeleted && !fk._isNew) {
      statements.push(generateFkDropSql(state.tableName, fk._originalName ?? fk.constraintName, isPg))
    } else if (fk._isNew && !fk._isDeleted) {
      if (isFkComplete(fk)) statements.push(generateFkAddSql(state.tableName, fk, isPg))
    } else if (!fk._isNew && !fk._isDeleted) {
      const orig = origFks.find(o => (o._originalName ?? o.constraintName) === (fk._originalName ?? fk.constraintName))
      if (orig && (
        orig.constraintName !== fk.constraintName ||
        orig.column !== fk.column ||
        orig.referencedTable !== fk.referencedTable ||
        orig.referencedColumn !== fk.referencedColumn ||
        orig.onDelete !== fk.onDelete ||
        orig.onUpdate !== fk.onUpdate
      )) {
        statements.push(generateFkDropSql(state.tableName, orig._originalName ?? orig.constraintName, isPg))
        if (isFkComplete(fk)) statements.push(generateFkAddSql(state.tableName, fk, isPg))
      }
    }
  }
```

- [ ] **Step 4: 追加 MCP patch capabilities**

在 `TABLE_FORM_PATCH_CAPABILITIES` 数组末尾（`]` 之前）追加：

```typescript
  {
    pathPattern: '/foreignKeys/-',
    ops: ['add'],
    description: 'Append a new FK constraint',
  },
  {
    pathPattern: '/foreignKeys[name=<s>]',
    ops: ['remove'],
    description: 'Remove an FK constraint by constraintName',
    addressableBy: ['constraintName'],
  },
  {
    pathPattern: '/foreignKeys[name=<s>]/<field>',
    ops: ['replace'],
    description: 'Modify a FK constraint field by constraintName',
    addressableBy: ['constraintName'],
  },
```

在 `TABLE_FORM_SCHEMA` 的 `properties` 对象中（`indexes` 属性之后）追加：

```typescript
    foreignKeys: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          constraintName: { type: 'string' },
          column: { type: 'string' },
          referencedTable: { type: 'string' },
          referencedColumn: { type: 'string' },
          onDelete: { type: 'string', enum: ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT'], default: 'NO ACTION' },
          onUpdate: { type: 'string', enum: ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT'], default: 'NO ACTION' },
        },
        required: ['constraintName', 'column', 'referencedTable', 'referencedColumn'],
        'x-addressable-by': 'constraintName',
      },
    },
```

- [ ] **Step 5: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增错误。

- [ ] **Step 6: Commit**

```bash
git add src/mcp/ui/adapters/TableFormAdapter.ts
git commit -m "feat(adapter): add FK CONSTRAINT SQL generation in create/alter table"
```

---

## Task 4: TableManageDialog — Tab 布局 + Comment 列（字段 tab）

**Files:**
- Modify: `src/components/TableManageDialog/index.tsx`

- [ ] **Step 1: 扩展 import 和类型**

在文件顶部 import 行中，将：

```typescript
import type { EditableColumn } from '../../store/tableFormStore';
```

改为：

```typescript
import type { EditableColumn, TableFormForeignKey, TableFormIndex } from '../../store/tableFormStore';
```

将 lucide-react import 中加入 `Link`（外键 tab 用）：

```typescript
import { X, Plus, Trash2, ChevronUp, ChevronDown, Sparkles, Link } from 'lucide-react';
```

- [ ] **Step 2: 新增 Tab state 和 FK/Index state**

在 `Props` interface 之后，组件函数内部，在现有 `const [columns, setColumns]` 之前追加：

```typescript
  type ActiveTab = 'columns' | 'foreignKeys' | 'indexes'
  const [activeTab, setActiveTab] = useState<ActiveTab>('columns')
  const [foreignKeys, setForeignKeys] = useState<TableFormForeignKey[]>([])
  const [originalForeignKeys, setOriginalForeignKeys] = useState<TableFormForeignKey[]>([])
  const [indexes, setIndexes] = useState<TableFormIndex[]>([])
  const [originalIndexes, setOriginalIndexes] = useState<TableFormIndex[]>([])
```

- [ ] **Step 3: 更新 get_table_detail invoke 的类型签名**

找到 `invoke<{` 调用，将其类型更新为包含 `foreign_keys` 和 `indexes`：

```typescript
    invoke<{
      name: string;
      columns: Array<{
        name: string; data_type: string; is_nullable: boolean;
        column_default: string | null; is_primary_key: boolean; extra: string | null;
      }>;
      foreign_keys: Array<{
        constraint_name: string;
        column: string;
        referenced_table: string;
        referenced_column: string;
      }>;
      indexes: Array<{
        index_name: string;
        is_unique: boolean;
        columns: string[];
      }>;
    }>('get_table_detail', {
```

在 `.then(detail => {` 块内，`setColumns(cols)` 和 `setOriginalColumns(...)` 之后追加：

```typescript
      const fks: TableFormForeignKey[] = (detail.foreign_keys ?? []).map(fk => ({
        id: makeId(),
        constraintName: fk.constraint_name,
        column: fk.column,
        referencedTable: fk.referenced_table,
        referencedColumn: fk.referenced_column,
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        _originalName: fk.constraint_name,
      }))
      setForeignKeys(fks)
      setOriginalForeignKeys(fks.map(f => ({ ...f })))

      const idxs: TableFormIndex[] = (detail.indexes ?? []).map(idx => ({
        id: makeId(),
        name: idx.index_name,
        type: idx.is_unique ? 'UNIQUE' : 'INDEX',
        columns: JSON.stringify(idx.columns.map(c => ({ name: c, order: 'ASC' }))),
        _originalName: idx.index_name,
      }))
      setIndexes(idxs)
      setOriginalIndexes(idxs.map(i => ({ ...i })))
```

- [ ] **Step 4: 更新 previewSql 调用，传入 foreignKeys 和 indexes**

找到：

```typescript
  const previewSql = generateTableSql({
    tableName: effectiveTableName,
    engine: 'InnoDB', charset: 'utf8mb4', comment: '',
    columns, originalColumns: tableName ? originalColumns : undefined,
    indexes: [], isNewTable: !tableName,
  }, driver);
```

替换为：

```typescript
  const previewSql = generateTableSql({
    tableName: effectiveTableName,
    engine: 'InnoDB', charset: 'utf8mb4', comment: '',
    columns, originalColumns: tableName ? originalColumns : undefined,
    indexes, originalIndexes: tableName ? originalIndexes : undefined,
    foreignKeys, originalForeignKeys: tableName ? originalForeignKeys : undefined,
    isNewTable: !tableName,
  }, driver);
```

- [ ] **Step 5: 在 handleExecute 中加 FK 完整性校验**

找到：

```typescript
    if (visibleColumns.some(c => !c.name.trim())) {
      showToast(t('tableManage.columnNameRequired'), 'error');
      return;
    }
```

在其之后追加：

```typescript
    const visibleFks = foreignKeys.filter(fk => !fk._isDeleted)
    if (visibleFks.some(fk => !fk.constraintName || !fk.column || !fk.referencedTable || !fk.referencedColumn)) {
      showToast('外键配置不完整，请填写约束名、列名、引用表和引用列', 'error');
      return;
    }
```

- [ ] **Step 6: 将对话框宽度从 800px 改为 960px**

找到：

```typescript
      <div className="bg-background-panel border border-border-strong rounded-lg w-[800px] max-h-[85vh] flex flex-col relative">
```

改为：

```typescript
      <div className="bg-background-panel border border-border-strong rounded-lg w-[960px] max-h-[85vh] flex flex-col relative">
```

- [ ] **Step 7: 添加 Tab 导航 UI**

找到内容区域开头（`<div className="overflow-auto flex-1 p-4">`），在 AI 面板和表名输入之后、`{isLoadingData ? (` 之前插入 Tab 导航：

```tsx
          {/* Tab 导航 */}
          <div className="flex border-b border-border-default mb-3">
            {(['columns', 'foreignKeys', 'indexes'] as ActiveTab[]).map(tab => {
              const labels: Record<ActiveTab, string> = { columns: '字段', foreignKeys: '外键', indexes: '索引' }
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-xs transition-colors duration-200 border-b-2 -mb-px ${
                    activeTab === tab
                      ? 'border-accent text-accent'
                      : 'border-transparent text-foreground-muted hover:text-foreground-default'
                  }`}
                >
                  {labels[tab]}
                </button>
              )
            })}
          </div>
```

- [ ] **Step 8: 在字段 tab 的表头加 Comment 列**

找到 `<thead>` 内的列头，在 `Extra` 列之后、空 `<th>` 之前插入：

```tsx
                  <th className="text-left py-1.5 px-2 font-medium text-foreground-muted w-[130px]">Comment</th>
```

在 `<tbody>` 中 Extra 列的 `<td>` 之后、操作列之前插入：

```tsx
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-background-base border border-border-strong rounded px-1.5 py-0.5 text-xs text-foreground-default outline-none focus:border-border-focus disabled:opacity-50"
                        value={col.comment ?? ''}
                        onChange={e => updateColumn(col.id, { comment: e.target.value })}
                        placeholder="—"
                        disabled={isAiBusy}
                      />
                    </td>
```

- [ ] **Step 9: 将字段 tab 的整个表格区域用条件包裹**

将现有的 `{isLoadingData ? ... : <table>...</table>}` 块和 `<button onClick={addColumn}>` 按钮包裹在 `{activeTab === 'columns' && (...)}` 中：

```tsx
          {activeTab === 'columns' && (
            <>
              {isLoadingData ? (
                <div className="text-center text-xs text-foreground-muted py-8">{t('tableDataView.loading')}</div>
              ) : (
                <table className="w-full text-xs text-foreground-default border-collapse">
                  {/* 整个现有 thead + tbody 内容不变 */}
                </table>
              )}
              <button
                onClick={addColumn}
                disabled={isAiBusy}
                className="mt-2 flex items-center gap-1 text-xs text-foreground-muted hover:text-accent px-2 py-1 disabled:opacity-40 transition-colors duration-200"
              >
                <Plus size={13} />
                {t('tableManage.addColumn')}
              </button>
            </>
          )}
```

- [ ] **Step 10: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增错误。

- [ ] **Step 11: Commit**

```bash
git add src/components/TableManageDialog/index.tsx
git commit -m "feat(table-dialog): add tab layout, comment column, and FK/index state wiring"
```

---

## Task 5: TableManageDialog — 外键 Tab

**Files:**
- Modify: `src/components/TableManageDialog/index.tsx`

- [ ] **Step 1: 添加 FK 操作函数**

在组件函数体内，在 `const visibleColumns` 之后追加：

```typescript
  const visibleForeignKeys = foreignKeys.filter(fk => !fk._isDeleted)

  const addForeignKey = () => {
    setForeignKeys(prev => [...prev, {
      id: makeId(),
      constraintName: '',
      column: '',
      referencedTable: '',
      referencedColumn: '',
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      _isNew: true,
    }])
  }

  const updateForeignKey = (id: string, patch: Partial<TableFormForeignKey>) => {
    setForeignKeys(prev => prev.map(fk => fk.id === id ? { ...fk, ...patch } : fk))
  }

  const handleFkColumnChange = (id: string, col: string) => {
    setForeignKeys(prev => prev.map(fk => {
      if (fk.id !== id) return fk
      const autoName = !fk.constraintName && col
        ? `fk_${effectiveTableName}_${col}`
        : fk.constraintName
      return { ...fk, column: col, constraintName: autoName }
    }))
  }
```

- [ ] **Step 2: 添加外键 Tab UI**

在字段 tab 的 `{activeTab === 'columns' && (...)}` 块之后追加：

```tsx
          {activeTab === 'foreignKeys' && (
            <div className="space-y-1">
              {visibleForeignKeys.length === 0 && (
                <div className="text-xs text-foreground-muted py-4 text-center">暂无外键约束</div>
              )}
              {visibleForeignKeys.length > 0 && (
                <table className="w-full text-xs text-foreground-default border-collapse">
                  <thead>
                    <tr className="border-b border-border-default">
                      <th className="text-left py-1.5 px-2 font-medium text-foreground-muted w-[180px]">约束名</th>
                      <th className="text-left py-1.5 px-2 font-medium text-foreground-muted w-[120px]">当前列</th>
                      <th className="text-left py-1.5 px-2 font-medium text-foreground-muted w-[120px]">引用表</th>
                      <th className="text-left py-1.5 px-2 font-medium text-foreground-muted w-[100px]">引用列</th>
                      <th className="text-left py-1.5 px-2 font-medium text-foreground-muted w-[100px]">ON DELETE</th>
                      <th className="text-left py-1.5 px-2 font-medium text-foreground-muted w-[100px]">ON UPDATE</th>
                      <th className="w-[30px]"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleForeignKeys.map(fk => {
                      const colOptions = visibleColumns.map(c => ({ value: c.name, label: c.name }))
                      const actionOptions = [
                        { value: 'NO ACTION', label: 'NO ACTION' },
                        { value: 'CASCADE', label: 'CASCADE' },
                        { value: 'SET NULL', label: 'SET NULL' },
                        { value: 'RESTRICT', label: 'RESTRICT' },
                        { value: 'SET DEFAULT', label: 'SET DEFAULT' },
                      ]
                      return (
                        <tr key={fk.id} className="border-b border-background-hover hover:bg-background-hover/40 transition-colors duration-150">
                          <td className="py-1 px-2">
                            <input
                              className="w-full bg-background-base border border-border-strong rounded px-1.5 py-0.5 text-xs text-foreground-default outline-none focus:border-border-focus"
                              value={fk.constraintName}
                              onChange={e => updateForeignKey(fk.id, { constraintName: e.target.value })}
                              placeholder="fk_table_col"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <DropdownSelect
                              value={fk.column}
                              options={colOptions}
                              placeholder="选择列"
                              onChange={col => handleFkColumnChange(fk.id, col)}
                              className="w-full"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <input
                              className="w-full bg-background-base border border-border-strong rounded px-1.5 py-0.5 text-xs text-foreground-default outline-none focus:border-border-focus"
                              value={fk.referencedTable}
                              onChange={e => updateForeignKey(fk.id, { referencedTable: e.target.value })}
                              placeholder="users"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <input
                              className="w-full bg-background-base border border-border-strong rounded px-1.5 py-0.5 text-xs text-foreground-default outline-none focus:border-border-focus"
                              value={fk.referencedColumn}
                              onChange={e => updateForeignKey(fk.id, { referencedColumn: e.target.value })}
                              placeholder="id"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <DropdownSelect
                              value={fk.onDelete}
                              options={actionOptions}
                              onChange={v => updateForeignKey(fk.id, { onDelete: v })}
                              className="w-full"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <DropdownSelect
                              value={fk.onUpdate}
                              options={actionOptions}
                              onChange={v => updateForeignKey(fk.id, { onUpdate: v })}
                              className="w-full"
                            />
                          </td>
                          <td className="py-1 px-2 text-center">
                            <button
                              onClick={() => fk._isNew
                                ? setForeignKeys(prev => prev.filter(f => f.id !== fk.id))
                                : updateForeignKey(fk.id, { _isDeleted: true })
                              }
                              className="text-error/70 hover:text-error p-0.5 transition-colors duration-200"
                            >
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
              <button
                onClick={addForeignKey}
                className="mt-2 flex items-center gap-1 text-xs text-foreground-muted hover:text-accent px-2 py-1 transition-colors duration-200"
              >
                <Plus size={13} />
                添加外键
              </button>
            </div>
          )}
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/TableManageDialog/index.tsx
git commit -m "feat(table-dialog): add foreign key tab with full CRUD UI"
```

---

## Task 6: TableManageDialog — 索引 Tab

**Files:**
- Modify: `src/components/TableManageDialog/index.tsx`

- [ ] **Step 1: 添加 Index 操作函数**

在 `addForeignKey` / `updateForeignKey` / `handleFkColumnChange` 之后追加：

```typescript
  const visibleIndexes = indexes.filter(idx => !idx._isDeleted)

  const addIndex = () => {
    setIndexes(prev => [...prev, {
      id: makeId(),
      name: '',
      type: 'INDEX',
      columns: JSON.stringify([{ name: '', order: 'ASC' }]),
      _isNew: true,
    }])
  }

  const updateIndex = (id: string, patch: Partial<TableFormIndex>) => {
    setIndexes(prev => prev.map(idx => idx.id === id ? { ...idx, ...patch } : idx))
  }
```

- [ ] **Step 2: 添加索引 Tab UI**

在外键 tab 的 `{activeTab === 'foreignKeys' && (...)}` 块之后追加：

```tsx
          {activeTab === 'indexes' && (
            <div className="space-y-1">
              {visibleIndexes.length === 0 && (
                <div className="text-xs text-foreground-muted py-4 text-center">暂无索引</div>
              )}
              {visibleIndexes.length > 0 && (
                <table className="w-full text-xs text-foreground-default border-collapse">
                  <thead>
                    <tr className="border-b border-border-default">
                      <th className="text-left py-1.5 px-2 font-medium text-foreground-muted w-[200px]">索引名</th>
                      <th className="text-left py-1.5 px-2 font-medium text-foreground-muted w-[100px]">类型</th>
                      <th className="text-left py-1.5 px-2 font-medium text-foreground-muted">列（JSON）</th>
                      <th className="w-[30px]"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleIndexes.map(idx => {
                      const typeOptions = [
                        { value: 'INDEX', label: 'INDEX' },
                        { value: 'UNIQUE', label: 'UNIQUE' },
                        { value: 'FULLTEXT', label: 'FULLTEXT' },
                      ]
                      return (
                        <tr key={idx.id} className="border-b border-background-hover hover:bg-background-hover/40 transition-colors duration-150">
                          <td className="py-1 px-2">
                            <input
                              className="w-full bg-background-base border border-border-strong rounded px-1.5 py-0.5 text-xs text-foreground-default outline-none focus:border-border-focus"
                              value={idx.name}
                              onChange={e => updateIndex(idx.id, { name: e.target.value })}
                              placeholder="idx_table_col"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <DropdownSelect
                              value={idx.type}
                              options={typeOptions}
                              onChange={v => updateIndex(idx.id, { type: v as TableFormIndex['type'] })}
                              className="w-full"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <input
                              className="w-full bg-background-base border border-border-strong rounded px-1.5 py-0.5 text-xs font-mono text-foreground-default outline-none focus:border-border-focus"
                              value={idx.columns}
                              onChange={e => updateIndex(idx.id, { columns: e.target.value })}
                              placeholder='[{"name":"col","order":"ASC"}]'
                            />
                          </td>
                          <td className="py-1 px-2 text-center">
                            <button
                              onClick={() => idx._isNew
                                ? setIndexes(prev => prev.filter(i => i.id !== idx.id))
                                : updateIndex(idx.id, { _isDeleted: true })
                              }
                              className="text-error/70 hover:text-error p-0.5 transition-colors duration-200"
                            >
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
              <button
                onClick={addIndex}
                className="mt-2 flex items-center gap-1 text-xs text-foreground-muted hover:text-accent px-2 py-1 transition-colors duration-200"
              >
                <Plus size={13} />
                添加索引
              </button>
            </div>
          )}
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/TableManageDialog/index.tsx
git commit -m "feat(table-dialog): add index tab, activating existing TableFormIndex state"
```

---

## Self-Review

**Spec coverage check:**

| Spec 要求 | 覆盖任务 |
|-----------|---------|
| comment_parser: ParsedComment + parse_comment() | Task 1 |
| 支持格式+描述 / 描述+格式 | Task 1 Step 3 |
| 4 种注释格式剥离 | Task 1 Step 3 (RE_S1~RE_S4) |
| 6 条新测试 | Task 1 Step 1 |
| TableFormForeignKey 接口 | Task 2 Step 1 |
| TableFormState 加 foreignKeys | Task 2 Step 1 |
| 持久化向后兼容 | Task 2 Step 2 |
| FK SQL 辅助函数 | Task 3 Step 1 |
| generateCreateSql 追加 FK CONSTRAINT | Task 3 Step 2 |
| generateAlterSql FK diff | Task 3 Step 3 |
| MCP patch capabilities | Task 3 Step 4 |
| Tab 布局（字段/外键/索引） | Task 4 Step 7 |
| 对话框宽度 960px | Task 4 Step 6 |
| Comment 列 | Task 4 Step 8 |
| 加载已有表 FK（onDelete/onUpdate 默认 NO ACTION） | Task 4 Step 3 |
| 加载已有表 indexes | Task 4 Step 3 |
| handleExecute FK 完整性校验 | Task 4 Step 5 |
| 外键 Tab CRUD UI | Task 5 |
| 约束名自动建议 | Task 5 Step 1 (handleFkColumnChange) |
| 索引 Tab | Task 6 |

**Placeholder scan:** 无 TBD/TODO，所有代码步骤均已给出完整实现。

**Type consistency check:**
- `TableFormForeignKey` 在 Task 2 定义，Task 3/4/5 中使用 — 字段名一致：`constraintName`, `column`, `referencedTable`, `referencedColumn`, `onDelete`, `onUpdate`
- `generateFkConstraintLine` / `generateFkAddSql` / `generateFkDropSql` / `isFkComplete` 在 Task 3 Step 1 定义，Task 3 Step 2/3 中使用 — 名称一致
- `visibleForeignKeys` / `visibleIndexes` 在 Task 5/6 Step 1 定义，Step 2 中使用 — 一致
- `updateForeignKey` / `handleFkColumnChange` 在 Task 5 Step 1 定义，Step 2 UI 中引用 — 一致
- `updateIndex` 在 Task 6 Step 1 定义，Step 2 中引用 — 一致
- `Link` icon 在 Task 4 Step 1 import，但外键 tab 最终未使用（使用 `Trash2` 和 `Plus`）— 移除 `Link` import 以避免 unused import 警告

**修正：** Task 4 Step 1 中移除 `Link` from lucide-react import（设计中未实际使用该图标）：

```typescript
import { X, Plus, Trash2, ChevronUp, ChevronDown, Sparkles } from 'lucide-react';
```

（与原始 import 相同，不需要添加 `Link`）
