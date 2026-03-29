<!-- STATUS: ✅ 已实现 -->
# 多语句执行结果智能分组设计

日期：2026-03-11

## 背景

执行多条 SQL（如 `SELECT * FROM t; UPDATE t SET ...;`）时，当前存在两个问题：
1. SELECT 空表时显示"0 行受影响"（Bug：Rust 从 `rows.first()` 取列名，空表返回 columns=[]）
2. 每条 DML 单独占一个 Tab，缺乏聚合视图

## 目标

- SELECT / SHOW / EXPLAIN 类 → 各自独立 Tab，空结果显示"查询成功，暂无数据"
- DML / DDL 类（UPDATE / INSERT / DELETE / CREATE / ALTER / DROP 等）→ 合并为一个"执行报告" Tab
- 纯前端改造，Rust 后端不变

## 方案

### 1. 类型扩展（src/types/index.ts）

给 `QueryResult` 增加两个可选字段：

```typescript
export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  row_count: number;
  duration_ms: number;
  // 前端附加字段（不来自后端，由 executeQuery 填写）
  kind?: 'select' | 'dml-report';
  sql?: string;  // 产生该结果的原始 SQL
}
```

### 2. SQL 分类函数

```typescript
function isSelectLike(sql: string): boolean {
  const s = sql.trim().toUpperCase();
  return s.startsWith('SELECT') || s.startsWith('SHOW') ||
         s.startsWith('EXPLAIN') || s.startsWith('WITH') ||
         s.startsWith('DESC') || s.startsWith('DESCRIBE') ||
         s.startsWith('CALL');  // 存储过程也可能返回结果集
}

function getSqlType(sql: string): string {
  const kw = sql.trim().toUpperCase().split(/\s+/)[0];
  const map: Record<string, string> = {
    INSERT: 'INSERT', UPDATE: 'UPDATE', DELETE: 'DELETE',
    CREATE: 'CREATE', ALTER: 'ALTER', DROP: 'DROP',
    TRUNCATE: 'TRUNCATE', RENAME: 'RENAME',
  };
  return map[kw] ?? kw;
}

function truncateSql(sql: string, max = 40): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
```

### 3. queryStore.ts executeQuery 改造

执行完所有语句后，对结果分组：

```
statements + results 逐条对应
  ├── isSelectLike(stmt) → kind='select', 直接进 finalList
  └── DML → 收集到 dmlBatch[]

if dmlBatch.length > 0:
  合成 dmlReport QueryResult，kind='dml-report'，加入 finalList 末尾

set results[tabId] = finalList
```

DML 报告的合成结构：

| columns | 值 |
|---------|---|
| # | 序号 |
| 操作 | INSERT / UPDATE / DELETE … |
| SQL摘要 | 前 40 字符 + … |
| 影响行数 | row_count |
| 耗时(ms) | duration_ms |
| 状态 | ✓ 成功 |

`row_count` = dmlBatch 条数，`duration_ms` = 各条累加。

### 4. 结果 Tab 标签（MainContent/index.tsx）

当前：全部显示 `结果集 N`

改为：
- kind='select' 或 undefined → `结果集 N`（N 仅对 select 类递增）
- kind='dml-report' → `执行报告（N条）`

### 5. 结果内容渲染

| 条件 | 当前行为 | 新行为 |
|------|---------|--------|
| columns=[], kind 未设置 | "0 行受影响" | 不再出现（DML 已合并） |
| kind='dml-report' | 无 | 渲染报告表格 |
| kind='select', columns=[] | "0 行受影响" | "查询成功，暂无数据" |
| kind='select', columns>0 | 表格 | 表格（不变） |

## 约束

- `kind` 和 `sql` 字段仅由前端 `executeQuery` 赋值，不序列化到历史记录（或保留也可，无害）
- 分号分割沿用现有逻辑，不改 Rust 后端
- 错误处理不变（执行失败仍走现有 error 流程）
