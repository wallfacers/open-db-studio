<!-- STATUS: ✅ 已实现 -->
# 表数据列表：列头排序 + 可视化查询行 设计文档

**日期**：2026-03-22
**状态**：✅ 已实现
**实现日期**：2026-03-26
**涉及文件**：
- `src-tauri/src/commands.rs`（扩展 `TableDataParams`，新增 Rust 拼接逻辑）
- `src/components/MainContent/TableDataView.tsx`（列头排序 + FilterRow UI）

---

## 一、功能概述

在表数据列表（`TableDataView`）中新增两个功能：

1. **列头排序**：每列表头旁显示 ▲（ASC）和 ▼（DESC）箭头按钮，点击触发排序查询。
2. **可视化查询行（FilterRow）**：在现有 WHERE 文本输入框上方新增一行结构化过滤条件，包含字段选择、条件运算符下拉、值输入，与 WHERE 文本框条件用 AND 合并后统一由后端构建 SQL。

所有 SQL 拼接逻辑（含类型引号处理）均在 Rust 后端完成，前端不直接操作 SQL 字符串。

---

## 二、后端设计（Rust）

### 2.1 `TableDataParams` 扩展

在 `src-tauri/src/commands.rs` 的 `TableDataParams` 结构体中新增字段：

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct TableDataParams {
    // 现有字段（不变）
    pub connection_id: i64,
    pub database: Option<String>,
    pub table: String,
    pub schema: Option<String>,
    pub page: u32,
    pub page_size: u32,
    pub where_clause: Option<String>,   // 手动 WHERE 文本（保留）
    pub order_clause: Option<String>,   // 手动 ORDER BY 文本（保留）

    // 新增：结构化过滤（可视化查询行）
    pub filter_column: Option<String>,
    pub filter_operator: Option<String>,  // =, !=, >, <, >=, <=, LIKE, IS NULL, IS NOT NULL
    pub filter_value: Option<String>,     // 用户输入的原始值（IS NULL/IS NOT NULL 时为 None）
    pub filter_data_type: Option<String>, // 字段类型，由前端从 ColumnMeta.data_type 传入

    // 新增：列头点击排序
    pub sort_column: Option<String>,
    pub sort_direction: Option<String>,   // "ASC" | "DESC"
}
```

### 2.2 类型引号规则（`quote_filter_value` 函数）

根据 `filter_data_type` 决定是否对值加单引号：

| 类型关键字（不区分大小写，contains 匹配） | 处理 |
|---|---|
| `varchar`, `char`, `text`, `tinytext`, `mediumtext`, `longtext`, `string` | 加单引号，内部 `'` 转义为 `''` |
| `date`, `datetime`, `time` | 加单引号 |
| `timestamp` | **不加引号**（数值型时间戳） |
| `int`, `bigint`, `float`, `double`, `decimal`, `tinyint`, `smallint`, `mediumint`, `numeric`, `real` | 不加引号 |
| `bool`, `boolean`, `bit` | 不加引号 |
| 未知/空类型 | 保守处理，加单引号 |

### 2.3 WHERE 合并逻辑

```
filter_part  = 由 filter_column/operator/quoted_value 构建的 SQL 片段
               IS NULL/IS NOT NULL → "col IS NULL" / "col IS NOT NULL"
               其他 → "col op value"
where_text   = where_clause 字段内容

最终 WHERE 子句：
  两者都有 → filter_part AND (where_text)
  只有 filter_part → filter_part
  只有 where_text → where_text
  都为空 → 无 WHERE 子句
```

当 `filter_column` 为空时，忽略整个 filter_part（字段未选则不过滤）。

列名按 driver 类型加转义：MySQL 用反引号，PG/其他用双引号。

### 2.4 ORDER BY 合并逻辑

```
sort_part   = "escaped_col ASC/DESC"（sort_column 按 driver 转义，sort_direction 白名单校验）
order_text  = order_clause 字段内容

最终 ORDER BY 子句：
  两者都有 → sort_part, order_text
  只有 sort_part → sort_part
  只有 order_text → order_text
  都为空 → 无 ORDER BY 子句
```

`sort_direction` 白名单：只允许 `ASC` 或 `DESC`（大小写不敏感），否则返回错误。

---

## 三、前端设计（React/TypeScript）

### 3.1 列头排序

**新增状态**（`TableDataView`）：
```typescript
const [sortCol, setSortCol] = useState<string | null>(null);
const [sortDir, setSortDir] = useState<'ASC' | 'DESC' | null>(null);
```

**列头渲染**：每列 `<th>` 内显示列名 + ▲ ▼ 两个箭头按钮。

**交互规则**：
- 点击 ▲（ASC）：若当前该列已是 ASC → 取消（设为 null）；否则设为该列 ASC
- 点击 ▼（DESC）：若当前该列已是 DESC → 取消；否则设为该列 DESC
- 切换到新列时，自动清除上一列排序状态

**样式**：
- 激活箭头：`text-[#00c9a7]`
- 非激活箭头：`text-[#3a5a7a]`，hover: `text-[#7a9bb8]`

**触发**：`sortCol`/`sortDir` 变化时直接触发 `loadData`（通过加入 `useCallback` 依赖或 `useEffect`）。

### 3.2 可视化查询行（FilterRow）

**位置**：Filter Bar（WHERE 输入行）上方，新增一行 `h-8`。

**新增状态**（`TableDataView`）：
```typescript
const [filterField, setFilterField] = useState('');
const [filterOp, setFilterOp] = useState('=');
const [filterValue, setFilterValue] = useState('');
```

**布局**：
```
[Filter图标]  [字段DropdownSelect]  [运算符DropdownSelect]  [值输入框(条件性显示)]  [搜索按钮]
```

**字段下拉（DropdownSelect）**：
- 选项：`columns`（`ColumnMeta[]`）中的所有字段名
- 含 placeholder（"选择字段"），选 placeholder 时视为未选择
- 选择后：从 `columns` 中找对应 `ColumnMeta.data_type` 用于传后端

**运算符下拉（DropdownSelect）**：
- 固定选项：`=`、`!=`、`>`、`<`、`>=`、`<=`、`LIKE`、`IS NULL`、`IS NOT NULL`
- 默认：`=`

**值输入框**：
- 当运算符为 `IS NULL` 或 `IS NOT NULL` 时隐藏
- `LIKE` 时 placeholder 提示 `%关键词%`
- 样式：与现有 Filter Bar 输入框一致（`bg-transparent outline-none text-[#c8daea]`）

**搜索触发**：FilterRow 与 Filter Bar 共用同一个 `handleSearch`。

**联动重置**：
- 切换 `tableName` 时，`filterField`/`filterOp`/`filterValue` 重置（`useEffect` 监听 `tableName`）
- `filterField` 清空时，`filterOp` 重置为 `=`，`filterValue` 清空

### 3.3 invoke 参数变更

`loadData` 中 `get_table_data` 调用新增参数：
```typescript
filter_column: filterField || null,
filter_operator: filterOp || null,
filter_value: filterValue || null,
filter_data_type: columns.find(c => c.name === filterField)?.data_type || null,
sort_column: sortCol || null,
sort_direction: sortDir || null,
```

---

## 四、边界处理

| 场景 | 处理 |
|---|---|
| `filterField` 为空 | 忽略整个 filter，不影响现有 WHERE 文本 |
| `IS NULL` / `IS NOT NULL` | `filter_value` 传 `null`，Rust 生成 `col IS NULL` |
| `LIKE` 值 | 正常加引号，值本身由用户控制（含 `%`）|
| `sort_direction` 非法 | Rust 白名单校验，返回错误 |
| 列名含特殊字符 | Rust 按 driver 用反引号/双引号转义 |
| 切换表时 | FilterRow 状态、sortCol/sortDir 全部重置 |
| 两个 ORDER BY 同时存在 | 列头排序优先（sort_part 在前），order_clause 文本追加在后 |

---

## 五、不在本次范围内

- 多列排序（Shift+点击）
- 可视化查询多行（动态 +/- 行）
- 后端参数化绑定（当前桌面本地工具，信任本地用户）
