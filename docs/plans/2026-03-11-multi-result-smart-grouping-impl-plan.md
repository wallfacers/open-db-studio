<!-- STATUS: ✅ 已实现 -->
# 多语句执行结果智能分组 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 多条 SQL 执行时，SELECT 类各自独立 Tab 显示数据表格，DML/DDL 类合并为一个"执行报告" Tab 展示小报表。

**Architecture:** 纯前端改造，不改 Rust 后端。在 `types/index.ts` 给 `QueryResult` 扩展 `kind`/`sql` 可选字段，在 `queryStore.ts` 的 `executeQuery` 内执行后按语句类型分组并合成 DML 报告结果，在 `MainContent/index.tsx` 调整 Tab 标签和结果渲染逻辑。

**Tech Stack:** React 18, TypeScript, Zustand

---

## Task 1：扩展 QueryResult 类型

**Files:**
- Modify: `src/types/index.ts:28-33`

**Step 1：修改 QueryResult 接口**

将 `src/types/index.ts` 第 28-33 行替换为：

```typescript
export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  row_count: number;
  duration_ms: number;
  /** 前端附加：select=查询结果, dml-report=DML聚合报告 */
  kind?: 'select' | 'dml-report';
  /** 前端附加：产生该结果的原始 SQL */
  sql?: string;
}
```

**Step 2：编译检查**

```bash
npx tsc --noEmit
```

Expected：无错误

**Step 3：Commit**

```bash
git add src/types/index.ts
git commit -m "feat(result): extend QueryResult with kind and sql fields"
```

---

## Task 2：改造 queryStore.ts 的 executeQuery

**Files:**
- Modify: `src/store/queryStore.ts:61-93`

**Step 1：在文件顶部（import 下方）添加辅助函数**

在 `src/store/queryStore.ts` 第 4 行之后（import 结束后）插入：

```typescript
/** 判断是否为返回结果集的查询语句 */
function isSelectLike(sql: string): boolean {
  const s = sql.trim().toUpperCase();
  return (
    s.startsWith('SELECT') ||
    s.startsWith('SHOW') ||
    s.startsWith('EXPLAIN') ||
    s.startsWith('WITH') ||
    s.startsWith('DESC ') ||
    s.startsWith('DESCRIBE ') ||
    s.startsWith('CALL')
  );
}

/** 从 SQL 提取操作类型关键字 */
function getSqlType(sql: string): string {
  const kw = sql.trim().toUpperCase().split(/\s+/)[0] ?? '';
  const labels: Record<string, string> = {
    INSERT: 'INSERT', UPDATE: 'UPDATE', DELETE: 'DELETE',
    CREATE: 'CREATE', ALTER: 'ALTER', DROP: 'DROP',
    TRUNCATE: 'TRUNCATE', RENAME: 'RENAME',
  };
  return labels[kw] ?? kw;
}

/** 截断 SQL 用于显示 */
function truncateSql(sql: string, max = 40): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
```

**Step 2：替换 executeQuery 方法体**

将 `src/store/queryStore.ts` 第 61-93 行（executeQuery 整个方法体）替换为：

```typescript
  executeQuery: async (connectionId, tabId, sqlOverride, database, schema) => {
    const sql = sqlOverride ?? get().sqlContent[tabId] ?? '';
    if (!sql.trim()) return;

    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    set({ isExecuting: true, error: null, diagnosis: null });

    interface StmtResult { stmt: string; result: QueryResult }
    const selectResults: StmtResult[] = [];
    const dmlResults: StmtResult[] = [];

    try {
      for (const stmt of statements) {
        const result = await invoke<QueryResult>('execute_query', {
          connectionId,
          sql: stmt,
          database: database ?? null,
          schema: schema ?? null,
        });
        result.sql = stmt;
        if (isSelectLike(stmt) || result.columns.length > 0) {
          result.kind = 'select';
          selectResults.push({ stmt, result });
        } else {
          dmlResults.push({ stmt, result });
        }
      }

      const finalList: QueryResult[] = selectResults.map(r => r.result);

      if (dmlResults.length > 0) {
        const totalDuration = dmlResults.reduce((sum, r) => sum + r.result.duration_ms, 0);
        const dmlReport: QueryResult = {
          columns: ['#', '操作', 'SQL摘要', '影响行数', '耗时(ms)', '状态'],
          rows: dmlResults.map((item, i) => [
            String(i + 1),
            getSqlType(item.stmt),
            truncateSql(item.stmt),
            String(item.result.row_count),
            String(item.result.duration_ms),
            '✓ 成功',
          ]),
          row_count: dmlResults.length,
          duration_ms: totalDuration,
          kind: 'dml-report',
          sql: '',
        };
        finalList.push(dmlReport);
      }

      set(s => ({ results: { ...s.results, [tabId]: finalList }, isExecuting: false }));
    } catch (e) {
      const errorMsg = String(e);
      set({ error: errorMsg, isExecuting: false });
      const sql = get().sqlContent[tabId] ?? '';
      invoke<string>('ai_diagnose_error', { sql, errorMsg, connectionId })
        .then(diagnosis => set({ diagnosis }))
        .catch(() => {});
    }
  },
```

**Step 3：编译检查**

```bash
npx tsc --noEmit
```

Expected：无错误

**Step 4：Commit**

```bash
git add src/store/queryStore.ts
git commit -m "feat(result): group select/dml results and synthesize dml report"
```

---

## Task 3：更新 MainContent 结果展示

**Files:**
- Modify: `src/components/MainContent/index.tsx:546-613`

### 3.1 更新 Tab 标签（第 553 行）

将第 546-564 行的 Tab 标签渲染块中第 553 行：

```tsx
<span>{t('mainContent.resultSet')} {idx + 1}</span>
```

替换为：

```tsx
<span>
  {result.kind === 'dml-report'
    ? `执行报告（${result.row_count}条）`
    : `${t('mainContent.resultSet')} ${idx + 1}`}
</span>
```

注意：需要将 `currentResults.map((_, idx) =>` 改为 `currentResults.map((result, idx) =>` 以便访问 `result.kind`。

### 3.2 更新结果内容渲染（第 583-584 行）

将：

```tsx
} : currentResults[selectedResultIdx]?.columns.length === 0 ? (
  <div className="flex items-center justify-center h-full text-green-400 text-sm">{t('mainContent.executeSuccess')}{currentResults[selectedResultIdx].row_count} {t('mainContent.rowsAffected')}（{currentResults[selectedResultIdx].duration_ms}ms）</div>
) : (
```

替换为：

```tsx
} : currentResults[selectedResultIdx]?.kind === 'select' && currentResults[selectedResultIdx]?.columns.length === 0 ? (
  <div className="flex items-center justify-center h-full text-[#7a9bb8] text-sm">查询成功，暂无数据</div>
) : (
```

这样：
- `kind='select'` + `columns=[]` → 显示"查询成功，暂无数据"
- `kind='dml-report'` → `columns.length > 0`（报告有列头），走下面的通用表格渲染，自动渲染为报告小表格

**Step 1：按上述修改更新 MainContent/index.tsx**

**Step 2：编译检查**

```bash
npx tsc --noEmit
```

Expected：无错误

**Step 3：Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(result): smart tab labels and dml report rendering"
```

---

## 验收标准

- [ ] 执行两条 SELECT → 两个"结果集 N" Tab，各自展示数据表格
- [ ] SELECT 空表 → 显示"查询成功，暂无数据"，不显示"0 行受影响"
- [ ] 执行两条 UPDATE → 一个"执行报告（2条）" Tab，内含报告小表格
- [ ] 混合执行（SELECT + UPDATE）→ SELECT 独立 Tab + 一个执行报告 Tab
- [ ] `npx tsc --noEmit` 无类型错误
