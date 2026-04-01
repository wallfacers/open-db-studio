<!-- STATUS: ✅ 已实现 -->
# Table Data Filter & Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在表数据列表中新增列头 ASC/DESC 排序按钮，以及结构化可视化查询行（字段+运算符+值），所有 SQL 拼接在 Rust 后端完成。

**Architecture:** 扩展 `TableDataParams` 接收结构化过滤和排序参数；Rust 中新增纯函数处理类型引号、WHERE/ORDER BY 合并；前端 `TableDataView` 新增 FilterRow 行和列头排序箭头按钮，通过 `DropdownSelect` 复用现有样式。

**Tech Stack:** Rust (Tauri commands), React 18 + TypeScript, Zustand, i18next, lucide-react, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-22-table-data-filter-sort-design.md`

---

## File Map

| 文件 | 操作 | 说明 |
|---|---|---|
| `src-tauri/src/commands.rs` | Modify | 扩展 `TableDataParams`；新增 `quote_filter_value`、`build_filter_part`、`merge_where`、`merge_order` 函数；更新 `get_table_data` |
| `src/i18n/locales/zh.json` | Modify | 新增 FilterRow 相关中文翻译键 |
| `src/i18n/locales/en.json` | Modify | 新增 FilterRow 相关英文翻译键 |
| `src/components/MainContent/TableDataView.tsx` | Modify | 新增 FilterRow UI、列头排序箭头按钮、相关状态和逻辑 |

> **并发说明：** Task 1（Rust）和 Task 2（i18n）完全独立，可并发执行。Task 3（前端）依赖 Task 1 完成后的新 API 字段。

---

## Task 1: Rust 后端 — 扩展 `get_table_data`

**Files:**
- Modify: `src-tauri/src/commands.rs`（`TableDataParams` 结构体约第 325 行，`get_table_data` 函数约第 357 行）

### Step 1.1: 扩展 `TableDataParams` 结构体

- [ ] 在 `src-tauri/src/commands.rs` 找到 `TableDataParams`（约第 325 行），在 `order_clause` 之后新增字段：

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct TableDataParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub table: String,
    pub schema: Option<String>,
    pub page: u32,
    pub page_size: u32,
    pub where_clause: Option<String>,
    pub order_clause: Option<String>,
    // 新增字段
    pub filter_column: Option<String>,
    pub filter_operator: Option<String>,
    pub filter_value: Option<String>,
    pub filter_data_type: Option<String>,
    pub sort_column: Option<String>,
    pub sort_direction: Option<String>,
}
```

### Step 1.2: 新增 `quote_filter_value` 纯函数及单元测试

- [ ] 在 `qualified_table` 函数上方新增以下函数及测试：

```rust
/// 根据字段类型决定是否给值加单引号
/// 字符串/日期类型加引号，数值/时间戳/布尔类型不加引号，未知类型保守加引号
fn quote_filter_value(value: &str, data_type: &str) -> String {
    let dt = data_type.to_lowercase();
    let needs_quote = if dt.contains("timestamp") {
        false
    } else if dt.contains("int") || dt.contains("float") || dt.contains("double")
        || dt.contains("decimal") || dt.contains("numeric") || dt.contains("real")
        || dt.contains("bool") || dt.contains("bit")
    {
        false
    } else {
        // varchar, char, text, date, datetime, time, string, unknown → 加引号
        true
    };

    if needs_quote {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quote_string_types() {
        assert_eq!(quote_filter_value("张三", "varchar"), "'张三'");
        assert_eq!(quote_filter_value("hello", "TEXT"), "'hello'");
        assert_eq!(quote_filter_value("it's", "char"), "'it''s'");
    }

    #[test]
    fn test_no_quote_numeric_types() {
        assert_eq!(quote_filter_value("42", "int"), "42");
        assert_eq!(quote_filter_value("3.14", "float"), "3.14");
        assert_eq!(quote_filter_value("100", "bigint"), "100");
        assert_eq!(quote_filter_value("9.9", "decimal"), "9.9");
    }

    #[test]
    fn test_no_quote_timestamp() {
        assert_eq!(quote_filter_value("1711123456", "timestamp"), "1711123456");
    }

    #[test]
    fn test_quote_date_types() {
        assert_eq!(quote_filter_value("2024-01-01", "date"), "'2024-01-01'");
        assert_eq!(quote_filter_value("2024-01-01 12:00:00", "datetime"), "'2024-01-01 12:00:00'");
        assert_eq!(quote_filter_value("12:00:00", "time"), "'12:00:00'");
    }

    #[test]
    fn test_unknown_type_defaults_to_quote() {
        assert_eq!(quote_filter_value("abc", "unknown_type"), "'abc'");
        assert_eq!(quote_filter_value("abc", ""), "'abc'");
    }
}
```

### Step 1.3: 新增 `build_filter_part` 函数

- [ ] 在 `quote_filter_value` 下方新增：

```rust
/// 将结构化过滤条件转为 SQL 片段（不含 WHERE 关键字）
/// 返回 None 表示无有效过滤条件（column 为空）
fn build_filter_part(
    column: &str,
    operator: &str,
    value: Option<&str>,
    data_type: &str,
    driver: &str,
) -> Option<String> {
    if column.trim().is_empty() {
        return None;
    }

    let col_escaped = if driver == "mysql" {
        format!("`{}`", column.replace('`', "``"))
    } else {
        format!("\"{}\"", column.replace('"', "\"\""))
    };

    let op_upper = operator.trim().to_uppercase();
    let fragment = match op_upper.as_str() {
        "IS NULL" => format!("{} IS NULL", col_escaped),
        "IS NOT NULL" => format!("{} IS NOT NULL", col_escaped),
        _ => {
            let raw_value = value.unwrap_or("");
            let quoted = quote_filter_value(raw_value, data_type);
            format!("{} {} {}", col_escaped, op_upper, quoted)
        }
    };

    Some(fragment)
}
```

### Step 1.4: 新增 `merge_where` 和 `merge_order` 函数

- [ ] 在 `build_filter_part` 下方新增：

```rust
/// 合并结构化 filter_part 和手动 where_clause 文本，用 AND 连接
fn merge_where(filter_part: Option<String>, where_clause: Option<&str>) -> String {
    let where_text = where_clause.filter(|s| !s.trim().is_empty());
    match (filter_part, where_text) {
        (Some(fp), Some(wt)) => format!("{} AND ({})", fp, wt),
        (Some(fp), None) => fp,
        (None, Some(wt)) => wt.to_string(),
        (None, None) => String::new(),
    }
}

/// 合并列头排序和手动 order_clause 文本
/// 列头排序在前，手动文本追加在后
fn merge_order(
    sort_column: Option<&str>,
    sort_direction: Option<&str>,
    order_clause: Option<&str>,
    driver: &str,
) -> Result<String, String> {
    let sort_part = match (sort_column, sort_direction) {
        (Some(col), Some(dir)) if !col.trim().is_empty() => {
            let dir_upper = dir.trim().to_uppercase();
            if dir_upper != "ASC" && dir_upper != "DESC" {
                return Err(format!("Invalid sort direction: {}", dir));
            }
            let col_escaped = if driver == "mysql" {
                format!("`{}`", col.replace('`', "``"))
            } else {
                format!("\"{}\"", col.replace('"', "\"\""))
            };
            Some(format!("{} {}", col_escaped, dir_upper))
        }
        _ => None,
    };

    let order_text = order_clause.filter(|s| !s.trim().is_empty());
    let result = match (sort_part, order_text) {
        (Some(sp), Some(ot)) => format!("{}, {}", sp, ot),
        (Some(sp), None) => sp,
        (None, Some(ot)) => ot.to_string(),
        (None, None) => String::new(),
    };
    Ok(result)
}
```

### Step 1.5: 更新 `get_table_data` 函数体

- [ ] 找到 `get_table_data` 函数（约第 357 行），将 `where_part` 和 `order_part` 的构建逻辑替换为使用新函数：

```rust
#[tauri::command]
pub async fn get_table_data(params: TableDataParams) -> AppResult<crate::datasource::QueryResult> {
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };

    if params.page_size > 10_000 {
        return Err(crate::AppError::Other(
            format!("page_size exceeds maximum allowed value (10000), got {}", params.page_size)
        ));
    }

    let offset = params.page.saturating_sub(1) * params.page_size;

    // 构建结构化 filter 片段
    let filter_part = params.filter_column.as_deref()
        .filter(|s| !s.trim().is_empty())
        .and_then(|col| build_filter_part(
            col,
            params.filter_operator.as_deref().unwrap_or("="),
            params.filter_value.as_deref(),
            params.filter_data_type.as_deref().unwrap_or(""),
            &config.driver,
        ));

    // 合并 WHERE
    let merged_where = merge_where(filter_part, params.where_clause.as_deref());
    let where_part = if merged_where.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", merged_where)
    };

    // 合并 ORDER BY
    let merged_order = merge_order(
        params.sort_column.as_deref(),
        params.sort_direction.as_deref(),
        params.order_clause.as_deref(),
        &config.driver,
    ).map_err(|e| crate::AppError::Other(e))?;
    let order_part = if merged_order.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", merged_order)
    };

    let tbl = qualified_table(&config.driver, params.schema.as_deref(), &params.table);
    let sql = format!("SELECT * FROM {}{}{} LIMIT {} OFFSET {}", tbl, where_part, order_part, params.page_size, offset);

    ds.execute(&sql).await
}
```

### Step 1.6: 运行 Rust 单元测试和编译检查

- [ ] 运行单元测试：
  ```bash
  cd src-tauri && cargo test -- --nocapture 2>&1
  ```
  预期：所有测试通过，`test_quote_string_types`、`test_no_quote_numeric_types` 等均为 PASS

- [ ] 运行编译检查：
  ```bash
  cd src-tauri && cargo check 2>&1
  ```
  预期：无编译错误

### Step 1.7: 提交

- [ ] 提交：
  ```bash
  git add src-tauri/src/commands.rs
  git commit -m "feat(rust): extend TableDataParams with structured filter and sort, add SQL builder helpers"
  ```

---

## Task 2: i18n — 新增翻译键（与 Task 1 并发）

**Files:**
- Modify: `src/i18n/locales/zh.json`（`tableDataView` 节，约第 344-345 行 `"search"` 键之后）
- Modify: `src/i18n/locales/en.json`（同位置）

### Step 2.1: 新增中文翻译键

- [ ] 在 `zh.json` 的 `tableDataView` 节中，在 `"search": "查询"` 之前新增（保持 JSON 合法）：

```json
"filterSelectField": "选择字段",
"filterOperatorLabel": "条件",
"filterValuePlaceholder": "输入值",
"filterValueLikePlaceholder": "%关键词%",
"sortAsc": "升序排序",
"sortDesc": "降序排序",
```

### Step 2.2: 新增英文翻译键

- [ ] 在 `en.json` 的 `tableDataView` 节中，在 `"search"` 之前新增：

```json
"filterSelectField": "Select field",
"filterOperatorLabel": "Operator",
"filterValuePlaceholder": "Enter value",
"filterValueLikePlaceholder": "%keyword%",
"sortAsc": "Sort ascending",
"sortDesc": "Sort descending",
```

### Step 2.3: TypeScript 类型检查

- [ ] 运行 TypeScript 检查：
  ```bash
  npx tsc --noEmit 2>&1
  ```
  预期：无新增类型错误

### Step 2.4: 提交

- [ ] 提交：
  ```bash
  git add src/i18n/locales/zh.json src/i18n/locales/en.json
  git commit -m "feat(i18n): add filter row and column sort translation keys"
  ```

---

## Task 3: 前端 — FilterRow + 列头排序（依赖 Task 1、Task 2 完成）

**Files:**
- Modify: `src/components/MainContent/TableDataView.tsx`

### Step 3.1: 新增状态

- [ ] 在 `TableDataView` 函数体中，找到现有状态声明区域，在 `showExport` 之后新增：

```typescript
// 可视化查询行状态
const [filterField, setFilterField] = useState('');
const [filterOp, setFilterOp] = useState('=');
const [filterValue, setFilterValue] = useState('');

// 列头排序状态
const [sortCol, setSortCol] = useState<string | null>(null);
const [sortDir, setSortDir] = useState<'ASC' | 'DESC' | null>(null);
```

### Step 3.2: 新增表切换时状态重置

- [ ] 找到 `useEffect` 中监听 `tableName` 的副作用（约第 92 行的 `get_table_detail` 调用处）。**在该 useEffect 函数体开头**（`if (!activeConnectionId` 判断之后、`invoke` 之前）插入 5 行重置代码：

```typescript
// 在现有 useEffect 开头插入这 5 行，不要替换整个 useEffect
setFilterField('');
setFilterOp('=');
setFilterValue('');
setSortCol(null);
setSortDir(null);
```

### Step 3.3: 更新 `loadData` 的 `invoke` 调用，新增参数

- [ ] 在 `loadData` 的 `invoke<QueryResult>('get_table_data', { params: { ... } })` 调用中，在 `order_clause` 之后新增：

```typescript
filter_column: filterField || null,
filter_operator: filterOp || null,
filter_value: (['IS NULL', 'IS NOT NULL'].includes(filterOp)) ? null : (filterValue || null),
filter_data_type: columns.find(c => c.name === filterField)?.data_type || null,
sort_column: sortCol,
sort_direction: sortDir,
```

- [ ] 同时将 `sortCol` 和 `sortDir` 加入 `loadData` 的 `useCallback` 依赖数组：

```typescript
}, [activeConnectionId, dbName, tableName, schema, page, pageSize, refreshKey, filterField, filterOp, filterValue, sortCol, sortDir]);
```

### Step 3.4: 新增 FilterRow UI（可视化查询行）

- [ ] 在现有 Filter Bar（约第 273 行，`{/* Filter Bar */}` 注释处）**上方**插入新的 FilterRow：

```tsx
{/* FilterRow — 可视化查询行 */}
<div className="h-8 flex items-center px-3 border-b border-[#1e2d42] bg-[#080d12] text-xs gap-2">
  <Filter size={12} className="text-[#7a9bb8] flex-shrink-0"/>
  {/* 字段选择 */}
  <DropdownSelect
    value={filterField}
    options={columns.map(c => ({ value: c.name, label: c.name }))}
    placeholder={t('tableDataView.filterSelectField')}
    onChange={(v) => {
      setFilterField(v);
      if (!v) { setFilterOp('='); setFilterValue(''); }
    }}
    className="w-36"
  />
  {/* 运算符选择 */}
  <DropdownSelect
    value={filterOp}
    options={[
      { value: '=', label: '=' },
      { value: '!=', label: '!=' },
      { value: '>', label: '>' },
      { value: '<', label: '<' },
      { value: '>=', label: '>=' },
      { value: '<=', label: '<=' },
      { value: 'LIKE', label: 'LIKE' },
      { value: 'IS NULL', label: 'IS NULL' },
      { value: 'IS NOT NULL', label: 'IS NOT NULL' },
    ]}
    onChange={setFilterOp}
    className="w-28"
  />
  {/* 值输入框（IS NULL / IS NOT NULL 时隐藏） */}
  {!['IS NULL', 'IS NOT NULL'].includes(filterOp) && (
    <input
      className="bg-transparent outline-none text-[#c8daea] flex-1 min-w-0"
      placeholder={filterOp === 'LIKE'
        ? t('tableDataView.filterValueLikePlaceholder')
        : t('tableDataView.filterValuePlaceholder')}
      value={filterValue}
      onChange={e => setFilterValue(e.target.value)}
      onKeyDown={e => e.key === 'Enter' && handleSearch()}
    />
  )}
  {/* 搜索按钮 */}
  <Tooltip content={t('tableDataView.search')}>
    <button
      onClick={handleSearch}
      className="p-1 hover:bg-[#1a2639] rounded text-[#7a9bb8] hover:text-[#00c9a7] transition-colors flex-shrink-0"
    >
      <Search size={14}/>
    </button>
  </Tooltip>
</div>
```

### Step 3.5: 更新列头渲染，新增排序箭头

- [ ] 找到列头渲染（约第 309 行）：

```tsx
{data.columns.map(col => (
  <th key={col} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">{col}</th>
))}
```

替换为：

```tsx
{data.columns.map(col => (
  <th key={col} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">
    <div className="flex items-center gap-1">
      <span>{col}</span>
      <div className="flex flex-col gap-0 ml-1">
        <Tooltip content={t('tableDataView.sortAsc')}>
          <button
            className={`leading-none p-0 hover:opacity-100 transition-colors ${
              sortCol === col && sortDir === 'ASC' ? 'text-[#00c9a7]' : 'text-[#3a5a7a] hover:text-[#7a9bb8]'
            }`}
            onClick={() => {
              if (sortCol === col && sortDir === 'ASC') {
                setSortCol(null); setSortDir(null);
              } else {
                setSortCol(col); setSortDir('ASC');
              }
            }}
          >
            <ChevronUp size={10}/>
          </button>
        </Tooltip>
        <Tooltip content={t('tableDataView.sortDesc')}>
          <button
            className={`leading-none p-0 hover:opacity-100 transition-colors ${
              sortCol === col && sortDir === 'DESC' ? 'text-[#00c9a7]' : 'text-[#3a5a7a] hover:text-[#7a9bb8]'
            }`}
            onClick={() => {
              if (sortCol === col && sortDir === 'DESC') {
                setSortCol(null); setSortDir(null);
              } else {
                setSortCol(col); setSortDir('DESC');
              }
            }}
          >
            <ChevronDown size={10}/>
          </button>
        </Tooltip>
      </div>
    </div>
  </th>
))}
```

### Step 3.6: 新增 import

- [ ] 在 `TableDataView.tsx` 顶部 import 行中：
  - 在 lucide-react 的导入中新增 `ChevronUp`（`ChevronDown` 已存在，无需重复添加）：
    ```typescript
    import { ChevronLeft, ChevronRight, RefreshCw, Filter, Download, Check, RotateCcw, Plus, ChevronUp, ChevronDown } from 'lucide-react';
    ```
  - 新增 `DropdownSelect` 和 `Search` 导入（`Search` 来自 lucide-react，`DropdownSelect` 来自 common）：
    ```typescript
    import { DropdownSelect } from '../common/DropdownSelect';
    // lucide-react import 行同时加入 Search（如未存在）
    ```

### Step 3.7: TypeScript 类型检查

- [ ] 运行：
  ```bash
  npx tsc --noEmit 2>&1
  ```
  预期：无新增类型错误

### Step 3.8: 提交

- [ ] 提交：
  ```bash
  git add src/components/MainContent/TableDataView.tsx
  git commit -m "feat(ui): add visual filter row and column header sort to TableDataView"
  ```

---

## Task 4: 冒烟测试验证

### Step 4.1: 启动前端开发服务

- [ ] 运行：
  ```bash
  npm run dev
  ```
  预期：前端在 http://localhost:1420 启动，无编译错误

### Step 4.2: 手动验证清单

连接数据库后，打开任意表的数据视图，验证：

- [ ] **FilterRow 渲染**：WHERE 手动输入框上方出现新的字段选择+运算符+值输入一行
- [ ] **字段下拉**：点击字段下拉显示表所有字段名，样式与其他 DropdownSelect 一致
- [ ] **运算符下拉**：显示 9 个运算符选项
- [ ] **IS NULL 隐藏值框**：选择 `IS NULL` 或 `IS NOT NULL` 时值输入框消失
- [ ] **LIKE placeholder**：选择 `LIKE` 时值输入框 placeholder 变为 `%keyword%`
- [ ] **过滤查询**：选字段 `name`，运算符 `=`，值 `张三`，按 Enter → 数据正确过滤
- [ ] **与 WHERE 文本联动**：同时填写 FilterRow 和 WHERE 文本框，结果是 AND 合并
- [ ] **列头升序**：点击某列 ▲ 按钮 → 数据按该列 ASC 排序，箭头变为绿色
- [ ] **列头降序**：点击同列 ▼ 按钮 → 排序变为 DESC
- [ ] **取消排序**：再次点击已激活的同向箭头 → 排序取消，恢复默认
- [ ] **切换表**：切换到另一张表 → FilterRow 和排序状态全部清空

### Step 4.3: 最终提交

- [ ] 如 Step 4.2 均通过，运行最终检查后提交：
  ```bash
  cd src-tauri && cargo check && cd .. && npx tsc --noEmit
  git add -A
  git commit -m "chore: final verification pass for filter row and column sort feature"
  ```
