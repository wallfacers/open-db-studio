# Adapter Highlight Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the existing AI change highlight system to QueryEditorAdapter, MetricFormAdapter, and TableFormAdapter so users can visually see what AI modified.

**Architecture:** Each adapter extracts changed field paths in `patchDirect`, calls `highlightStore.addHighlights()`. UI components wrap fields with `useFieldHighlight` (form fields) or `useMonacoHighlight` (Monaco editors). No new files or abstractions — pure integration into existing code.

**Tech Stack:** React 18, TypeScript, Zustand, Monaco Editor, existing highlight infrastructure (`highlightStore`, `useFieldHighlight`, `useMonacoHighlight`, `ai-highlight.css`)

**Design spec:** `docs/superpowers/specs/2026-03-31-adapter-highlight-expansion-design.md`

---

## File Map

| File | Change | Responsibility |
|------|--------|---------------|
| `src/mcp/ui/adapters/QueryEditorAdapter.ts` | Modify | Add highlight path extraction in `patchDirect` |
| `src/mcp/ui/adapters/MetricFormAdapter.ts` | Modify | Add highlight path extraction in `patchDirect` |
| `src/mcp/ui/adapters/TableFormAdapter.ts` | Modify | Add `extractChangedPaths` + highlight trigger in `patchDirect` |
| `src/components/MainContent/index.tsx` | Modify | Add `useMonacoHighlight` for SQL, `useFieldHighlight` for dropdowns, cleanup |
| `src/components/MetricsExplorer/MetricTab.tsx` | Modify | Add `useFieldHighlight` wrappers for all form fields, cleanup |
| `src/components/MainContent/TableStructureView.tsx` | Modify | Add `useFieldHighlight` for tableName + column rows, cleanup |

---

### Task 1: QueryEditorAdapter — Highlight Path Extraction

**Files:**
- Modify: `src/mcp/ui/adapters/QueryEditorAdapter.ts:1-6,76-107`

**Context:** The adapter's `patchDirect` method applies JSON Patch operations to `{ content, connectionId, database, schema }`. We need to compare old vs new values and call `addHighlights` with changed field names.

- [ ] **Step 1: Add highlightStore import**

In `src/mcp/ui/adapters/QueryEditorAdapter.ts`, add at line 6 (after existing imports):

```typescript
import { useHighlightStore } from '../../../store/highlightStore'
```

- [ ] **Step 2: Modify patchDirect to extract changed paths and trigger highlights**

Replace the `patchDirect` method (lines 76-107) with:

```typescript
patchDirect(ops: JsonPatchOp[]): PatchResult {
  const store = useQueryStore.getState()
  const tab = store.tabs.find(t => t.id === this.objectId)
  const ctx = tab?.queryContext ?? { connectionId: null, database: null, schema: null }
  const currentState = {
    content: store.sqlContent[this.objectId] ?? '',
    connectionId: ctx.connectionId,
    database: ctx.database,
    schema: ctx.schema,
  }
  try {
    const patched = applyPatch(currentState, ops)

    // Apply SQL content change
    if (patched.content !== currentState.content) {
      store.setSql(this.objectId, patched.content)
    }

    // Apply queryContext changes
    const ctxUpdate: Partial<{ connectionId: number | null; database: string | null; schema: string | null }> = {}
    if (patched.connectionId !== currentState.connectionId) ctxUpdate.connectionId = patched.connectionId
    if (patched.database !== currentState.database) ctxUpdate.database = patched.database
    if (patched.schema !== currentState.schema) ctxUpdate.schema = patched.schema
    if (Object.keys(ctxUpdate).length > 0) {
      store.updateTabContext(this.objectId, ctxUpdate)
    }

    // Extract changed paths and trigger highlights
    const paths: string[] = []
    if (patched.content !== currentState.content) paths.push('content')
    if (patched.connectionId !== currentState.connectionId) paths.push('connectionId')
    if (patched.database !== currentState.database) paths.push('database')
    if (patched.schema !== currentState.schema) paths.push('schema')
    if (paths.length > 0) {
      useHighlightStore.getState().addHighlights(this.objectId, paths)
    }

    return { status: 'applied' }
  } catch (e) {
    return { status: 'error', message: String(e) }
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to QueryEditorAdapter

- [ ] **Step 4: Commit**

```bash
git add src/mcp/ui/adapters/QueryEditorAdapter.ts
git commit -m "feat(highlight): add AI change highlight path extraction to QueryEditorAdapter"
```

---

### Task 2: QueryEditor UI — Monaco Line Highlights + Dropdown Field Highlights

**Files:**
- Modify: `src/components/MainContent/index.tsx:1-78,384,392-430,1104-1159,1187-1207`

**Context:** The MainContent component renders a Monaco SQL editor and three context dropdowns (connectionId, database, schema). We need to:
1. Use `useMonacoHighlight` to highlight changed SQL lines when AI modifies `content`
2. Use `useFieldHighlight` to highlight the three dropdowns when AI changes context
3. Track previous SQL to detect AI-driven changes (via highlight store pulse phase)
4. Clean up highlights on tab unmount

**Important:** The `editorRef` already exists at line 384: `const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null)`. Reuse it.

- [ ] **Step 1: Add imports**

In `src/components/MainContent/index.tsx`, add these imports after the existing import block (around line 78):

```typescript
import { useMonacoHighlight } from '../../hooks/useMonacoHighlight';
import { useFieldHighlight } from '../../hooks/useFieldHighlight';
import { useHighlightStore } from '../../store/highlightStore';
```

- [ ] **Step 2: Add useMonacoHighlight hook and SQL change tracking**

Inside the MainContent component, after the `editorRef` declaration (line 384), add:

```typescript
const { notifyContentChange } = useMonacoHighlight(editorRef);
const prevSqlRef = useRef<string>('');
```

- [ ] **Step 3: Add effect to detect AI-driven SQL changes and trigger line highlights**

Add this effect after the hook declarations (near the other useEffect blocks):

```typescript
// Detect AI-driven SQL changes and trigger Monaco line highlights
useEffect(() => {
  const sql = sqlContent[activeTab] ?? '';
  const prev = prevSqlRef.current;
  prevSqlRef.current = sql;

  if (!prev || prev === sql) return;

  // Only trigger line highlight if the highlight store has a 'content' pulse for this tab
  const highlights = useHighlightStore.getState().highlights.get(activeTab);
  const hasContentPulse = highlights?.some(e => e.path === 'content' && e.phase === 'pulse');
  if (hasContentPulse) {
    notifyContentChange(prev, sql);
  }
}, [sqlContent[activeTab], activeTab, notifyContentChange]);
```

- [ ] **Step 4: Add highlight cleanup on tab unmount**

Find an existing cleanup effect for the active tab, or add a new one:

```typescript
// Clean up highlights when tab changes or unmounts
useEffect(() => {
  return () => {
    if (activeTab) {
      useHighlightStore.getState().clearAll(activeTab);
    }
  };
}, [activeTab]);
```

- [ ] **Step 5: Wrap Connection dropdown with highlight**

The Connection dropdown is at lines 1106-1125. Before the dropdown JSX, we need to use the hook. Since hooks can't be called conditionally, we'll call all three hooks unconditionally at the component level (near the other hook declarations):

```typescript
const connHighlight = useFieldHighlight(activeTab, 'connectionId');
const dbHighlight = useFieldHighlight(activeTab, 'database');
const schemaHighlight = useFieldHighlight(activeTab, 'schema');
```

Then wrap the Connection `DropdownSelect` (lines 1106-1125) with a highlight div:

```typescript
<div className={connHighlight.className}>
  <DropdownSelect
    value={String(activeTabObj?.queryContext?.connectionId ?? '')}
    placeholder={t('mainContent.selectConnection')}
    className="w-32"
    options={Array.from(nodes.values())
      .filter(n => n.nodeType === 'connection')
      .map(n => ({ value: String(n.meta.connectionId ?? ''), label: n.label }))}
    onChange={(val) => {
      connHighlight.onUserEdit();
      const connId = val ? Number(val) : null;
      updateTabContext(activeTab, { connectionId: connId, database: null, schema: null });
      if (connId && !contextDatabases[connId]) {
        const connNode = Array.from(nodes.values()).find(n => n.nodeType === 'connection' && n.meta.connectionId === connId);
        if (connNode?.meta.driver !== 'sqlite') {
          invoke<string[]>('list_databases', { connectionId: connId })
            .then(dbs => setContextDatabases(prev => ({ ...prev, [connId]: dbs })))
            .catch((err) => console.warn('[list_databases]', err));
        }
      }
    }}
  />
</div>
```

- [ ] **Step 6: Wrap Database dropdown with highlight**

Wrap the Database `DropdownSelect` (lines 1129-1144):

```typescript
<div className={dbHighlight.className}>
  <DropdownSelect
    value={activeTabObj?.queryContext?.database ?? ''}
    placeholder={t('mainContent.selectDatabase')}
    className="w-28"
    options={availableDatabases.map(db => ({ value: db, label: db }))}
    onChange={(val) => {
      dbHighlight.onUserEdit();
      const db = val || null;
      updateTabContext(activeTab, { database: db, schema: null });
      const connId = activeTabObj?.queryContext?.connectionId;
      if (db && connId) {
        invoke<string[]>('list_schemas', { connectionId: connId, database: db })
          .then(schemas => setContextSchemas(prev => ({ ...prev, [`${connId}/${db}`]: schemas })))
          .catch((err) => console.warn('[list_schemas]', err));
      }
    }}
  />
</div>
```

- [ ] **Step 7: Wrap Schema dropdown with highlight**

Wrap the Schema `DropdownSelect` (lines 1150-1156):

```typescript
<div className={schemaHighlight.className}>
  <DropdownSelect
    value={queryCtx?.schema ?? ''}
    placeholder={t('mainContent.selectSchema')}
    className="w-24"
    options={availableSchemas.map(s => ({ value: s, label: s }))}
    onChange={(val) => {
      schemaHighlight.onUserEdit();
      updateTabContext(activeTab, { schema: val || null });
    }}
  />
</div>
```

- [ ] **Step 8: Enable glyphMargin in Monaco options**

In the MonacoEditor options (around line 1200), add `glyphMargin: true` to enable gutter decorations:

```typescript
options={{
  fontSize: 16,
  fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: 'on',
  lineNumbers: 'on',
  renderLineHighlight: 'line',
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  formatOnPaste: true,
  tabSize: 2,
  padding: { top: 12, bottom: 12 },
  glyphMargin: true,
```

- [ ] **Step 9: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to MainContent

- [ ] **Step 10: Manual test**

1. Open a query tab
2. Use AI to modify the SQL content (via MCP ui_patch on query_editor)
3. Verify: changed lines pulse green for 2.4s, then show residual (faint background + gutter marker)
4. Verify: typing in the editor clears residual on edited lines
5. If AI changes connectionId/database/schema, verify the dropdown pulses

- [ ] **Step 11: Commit**

```bash
git add src/components/MainContent/index.tsx
git commit -m "feat(highlight): add AI change highlights to SQL editor and context dropdowns"
```

---

### Task 3: MetricFormAdapter — Highlight Path Extraction

**Files:**
- Modify: `src/mcp/ui/adapters/MetricFormAdapter.ts:1-6,64-74`

**Context:** The adapter's `patchDirect` applies JSON Patch to a flat form state. We compare old vs new field values to find changed paths.

- [ ] **Step 1: Add highlightStore import**

In `src/mcp/ui/adapters/MetricFormAdapter.ts`, add after line 6:

```typescript
import { useHighlightStore } from '../../../store/highlightStore'
```

- [ ] **Step 2: Modify patchDirect to extract changed paths and trigger highlights**

Replace `patchDirect` method (lines 64-74) with:

```typescript
patchDirect(ops: JsonPatchOp[]): PatchResult {
  const current = useMetricFormStore.getState().getForm(this.objectId)
  if (!current) return { status: 'error', message: `No form state for ${this.objectId}` }
  try {
    const patched = applyPatch(current, ops)
    useMetricFormStore.getState().setForm(this.objectId, patched)

    // Extract changed paths by comparing old vs new field values
    const paths: string[] = []
    for (const key of Object.keys(patched) as Array<keyof typeof patched>) {
      if (current[key] !== patched[key]) {
        paths.push(key)
      }
    }
    if (paths.length > 0) {
      useHighlightStore.getState().addHighlights(this.objectId, paths)
    }

    return { status: 'applied' }
  } catch (e) {
    return { status: 'error', message: String(e) }
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to MetricFormAdapter

- [ ] **Step 4: Commit**

```bash
git add src/mcp/ui/adapters/MetricFormAdapter.ts
git commit -m "feat(highlight): add AI change highlight path extraction to MetricFormAdapter"
```

---

### Task 4: MetricTab UI — Form Field Highlights

**Files:**
- Modify: `src/components/MetricsExplorer/MetricTab.tsx:1-13,196-211,387-533`

**Context:** MetricTab renders 11 form fields. We wrap each field's container with a `HighlightedField` component (same pattern used in SeaTunnel VisualBuilder). Each onChange handler calls `onUserEdit()`.

- [ ] **Step 1: Add imports**

In `src/components/MetricsExplorer/MetricTab.tsx`, add after line 13:

```typescript
import { useFieldHighlight } from '../../hooks/useFieldHighlight';
import { useHighlightStore } from '../../store/highlightStore';
```

- [ ] **Step 2: Add HighlightedField wrapper component**

Add this component definition before the `MetricTab` component (around line 15, after imports):

```typescript
const HighlightedField: React.FC<{
  scopeId: string;
  path: string;
  children: (onUserEdit: () => void) => React.ReactNode;
}> = ({ scopeId, path, children }) => {
  const { className, onUserEdit } = useFieldHighlight(scopeId, path);
  return <div className={className}>{children(onUserEdit)}</div>;
};
```

- [ ] **Step 3: Add highlight cleanup in existing cleanup effect**

In the existing cleanup effect (lines 196-211), add `clearAll` to the cleanup function. Find the `return () => useMetricFormStore.getState().removeForm(tabId)` line and change it to:

```typescript
return () => {
  useMetricFormStore.getState().removeForm(tabId);
  useHighlightStore.getState().clearAll(tabId);
};
```

- [ ] **Step 4: Wrap Display Name field with highlight**

Find the Display Name field (lines 413-420). Wrap the containing `<div>` with `HighlightedField`:

```typescript
<HighlightedField scopeId={tabId} path="displayName">
  {(onUserEdit) => (
    <div>
      <label className={labelCls}>{t('metricsExplorer.metricTab.displayName')} *</label>
      <input
        className={inputCls}
        value={form.display_name}
        onChange={e => { onUserEdit(); setForm(f => ({ ...f, display_name: e.target.value })); }}
      />
    </div>
  )}
</HighlightedField>
```

- [ ] **Step 5: Wrap English Name field with highlight**

Find the English Name field (lines 423-430). Wrap similarly:

```typescript
<HighlightedField scopeId={tabId} path="name">
  {(onUserEdit) => (
    <div>
      <label className={labelCls}>{t('metricsExplorer.metricTab.englishName')} *</label>
      <input
        className={inputCls}
        value={form.name}
        onChange={e => { onUserEdit(); setForm(f => ({ ...f, name: e.target.value })); }}
      />
    </div>
  )}
</HighlightedField>
```

- [ ] **Step 6: Wrap Category field with highlight**

Find the Category Tags field (lines 433-440). Wrap:

```typescript
<HighlightedField scopeId={tabId} path="category">
  {(onUserEdit) => (
    <div>
      <label className={labelCls}>{t('metricsExplorer.metricTab.category')}</label>
      {/* existing TagInput component — add onUserEdit to its onChange */}
    </div>
  )}
</HighlightedField>
```

Note: Add `onUserEdit()` call in the TagInput's onChange/onAdd/onRemove handlers.

- [ ] **Step 7: Wrap remaining simple fields (metricType, version, description, data_caliber)**

Apply the same `HighlightedField` wrapper pattern to:
- **Metric Type** (lines 392-410): path `"metricType"`, call `onUserEdit()` in radio onChange
- **Version** (lines 443-450): path `"version"`, call `onUserEdit()` in input onChange
- **Description** (lines 492-499): path `"description"`, call `onUserEdit()` in textarea onChange
- **Data Caliber** (lines 504-510): path `"data_caliber"`, call `onUserEdit()` in textarea onChange

Each follows the exact same pattern as Step 4/5.

- [ ] **Step 8: Wrap atomic-only fields (tableName, columnName, aggregation, filterSql)**

These are conditionally rendered (only when `metricType === 'atomic'`). Wrap each:
- **Related Table** (lines 457-464): path `"tableName"`, call `onUserEdit()` in DropdownSelect onChange
- **Related Column** (lines 468-475): path `"columnName"`, call `onUserEdit()` in DropdownSelect onChange
- **Aggregation** (lines 479-486): path `"aggregation"`, call `onUserEdit()` in DropdownSelect onChange
- **Filter SQL** (lines 514-526): path `"filterSql"`, call `onUserEdit()` in textarea onChange

Same `HighlightedField` wrapper pattern. Since the wrapper is inside the conditional block, hooks in `HighlightedField` (a separate component) are safe.

- [ ] **Step 9: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to MetricTab

- [ ] **Step 10: Manual test**

1. Open a metric tab
2. Use AI to modify metric fields (via MCP ui_patch on metric_form)
3. Verify: modified fields pulse green for 2.4s, then show residual
4. Verify: editing a field clears its residual marker

- [ ] **Step 11: Commit**

```bash
git add src/components/MetricsExplorer/MetricTab.tsx
git commit -m "feat(highlight): add AI change highlights to MetricTab form fields"
```

---

### Task 5: TableFormAdapter — Highlight Path Extraction with Column Row Merging

**Files:**
- Modify: `src/mcp/ui/adapters/TableFormAdapter.ts:1-6,231-241`

**Context:** This adapter needs the most complex path extraction because column patches use `[name=x]` addressable syntax or numeric indices. All column field changes for the same column merge into `columns.<columnName>` for row-level highlighting.

- [ ] **Step 1: Add highlightStore import**

In `src/mcp/ui/adapters/TableFormAdapter.ts`, add after line 6:

```typescript
import { useHighlightStore } from '../../../store/highlightStore'
```

- [ ] **Step 2: Add extractChangedPaths private method**

Add this method to the `TableFormUIObject` class (before `patchDirect`):

```typescript
private extractChangedPaths(ops: JsonPatchOp[], patched: TableFormState): string[] {
  const paths: string[] = []
  for (const op of ops) {
    const segments = op.path.replace(/^\//, '').split('/')
    const topKey = segments[0]

    if (topKey === 'columns' && segments.length >= 2) {
      // Column field change → merge to row level by column name
      const addressable = segments[1]
      const nameMatch = addressable.match(/^\[name=(.+)\]$/)
      if (nameMatch) {
        // /columns/[name=id]/dataType → "columns.id"
        paths.push(`columns.${nameMatch[1]}`)
      } else if (/^\d+$/.test(addressable)) {
        // /columns/3/comment → resolve index to column name
        const col = patched.columns[Number(addressable)]
        if (col) paths.push(`columns.${col.name}`)
      } else if (addressable === '-') {
        // /columns/- (append) → last column in patched array
        const last = patched.columns[patched.columns.length - 1]
        if (last) paths.push(`columns.${last.name}`)
      }
    } else if (topKey === 'indexes' && segments.length >= 2) {
      // Index change → merge to index level by name
      const addressable = segments[1]
      const nameMatch = addressable.match(/^\[name=(.+)\]$/)
      if (nameMatch) {
        paths.push(`indexes.${nameMatch[1]}`)
      } else if (/^\d+$/.test(addressable)) {
        const idx = patched.indexes?.[Number(addressable)]
        if (idx?.name) paths.push(`indexes.${idx.name}`)
      }
    } else {
      // Top-level field: /tableName, /engine, /charset, /comment
      paths.push(topKey)
    }
  }
  return [...new Set(paths)]
}
```

- [ ] **Step 3: Modify patchDirect to trigger highlights**

Replace `patchDirect` method (lines 231-241) with:

```typescript
patchDirect(ops: JsonPatchOp[]): PatchResult {
  const current = useTableFormStore.getState().getForm(this.objectId)
  if (!current) return { status: 'error', message: `No form state for ${this.objectId}` }
  try {
    const patched = applyPatch(current, ops)
    useTableFormStore.getState().setForm(this.objectId, patched)

    // Extract changed paths and trigger highlights
    const paths = this.extractChangedPaths(ops, patched)
    if (paths.length > 0) {
      useHighlightStore.getState().addHighlights(this.objectId, paths)
    }

    return { status: 'applied' }
  } catch (e) {
    return { status: 'error', message: String(e) }
  }
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to TableFormAdapter

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/adapters/TableFormAdapter.ts
git commit -m "feat(highlight): add AI change highlight path extraction to TableFormAdapter"
```

---

### Task 6: TableStructureView UI — Table Name + Column Row Highlights

**Files:**
- Modify: `src/components/MainContent/TableStructureView.tsx:1-11,92-153,245-251,275-365`

**Context:** TableStructureView renders a tableName input and a columns table. Top-level fields use `useFieldHighlight` directly. Column rows use `useFieldHighlight` with path `columns.<columnName>` on the `<tr>` element.

- [ ] **Step 1: Add imports**

In `src/components/MainContent/TableStructureView.tsx`, add after line 11:

```typescript
import { useFieldHighlight } from '../../hooks/useFieldHighlight';
import { useHighlightStore } from '../../store/highlightStore';
```

- [ ] **Step 2: Add HighlightedField wrapper and HighlightedRow components**

Add these component definitions before the `TableStructureView` component (after imports):

```typescript
const HighlightedField: React.FC<{
  scopeId: string;
  path: string;
  children: (onUserEdit: () => void) => React.ReactNode;
}> = ({ scopeId, path, children }) => {
  const { className, onUserEdit } = useFieldHighlight(scopeId, path);
  return <div className={className}>{children(onUserEdit)}</div>;
};

/** Wraps a <tr> with highlight className — returns className string, not a wrapper div */
function useRowHighlight(scopeId: string, columnName: string) {
  return useFieldHighlight(scopeId, `columns.${columnName}`);
}
```

- [ ] **Step 3: Add highlight cleanup to existing cleanup effect**

In the existing cleanup effect (lines 99-153), find the `return () => removeForm(tabId)` line and change it to:

```typescript
return () => {
  removeForm(tabId);
  useHighlightStore.getState().clearAll(tabId);
};
```

- [ ] **Step 4: Wrap tableName input with highlight**

Find the tableName input (lines 245-251). Wrap with HighlightedField:

```typescript
<HighlightedField scopeId={tabId} path="tableName">
  {(onUserEdit) => (
    <input
      className="bg-[#0d1520] border border-[#2a3f5a] rounded px-2 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84] w-40"
      placeholder={t('tableManage.tableName') + '...'}
      value={newTableName}
      onChange={e => { onUserEdit(); setNewTableName(e.target.value); }}
    />
  )}
</HighlightedField>
```

- [ ] **Step 5: Add row-level highlight to column table rows**

Each column row `<tr>` (line 276) needs highlight support. Since hooks can't be called in a `.map()` callback directly, extract a `ColumnRow` component:

```typescript
const ColumnRow: React.FC<{
  col: EditableColumn;
  idx: number;
  tabId: string;
  updateColumn: (id: string, updates: Partial<EditableColumn>) => void;
  moveColumn: (id: string, dir: 'up' | 'down') => void;
  removeColumn: (id: string) => void;
  dataTypeOptions: { value: string; label: string }[];
  t: (key: string) => string;
}> = ({ col, idx, tabId, updateColumn, moveColumn, removeColumn, dataTypeOptions, t }) => {
  const { className: hlClass, onUserEdit } = useRowHighlight(tabId, col.name);

  return (
    <tr
      key={col.id}
      className={`hover:bg-[#1a2639] border-b border-[#1e2d42] group ${col._isNew ? 'bg-green-900/10' : ''} ${hlClass}`}
    >
      {/* All existing <td> cells — add onUserEdit() to each onChange handler */}
      <td className="w-[30px] px-1 py-1.5 border-r border-[#1e2d42] text-[#7a9bb8] bg-[#0d1117] text-center text-xs cursor-default select-none">
        {idx + 1}
      </td>
      <td className="p-0 border-r border-[#1e2d42] [&:focus-within]:[outline:1px_solid_#3a7bd5] [&:focus-within]:[-outline-offset:1px] [&:focus-within]:bg-[#1a2639]">
        <input
          className="w-full h-full px-3 py-1.5 bg-transparent text-[#c8daea] outline-none text-xs block"
          value={col.name}
          onChange={e => { onUserEdit(); updateColumn(col.id, { name: e.target.value }); }}
        />
      </td>
      {/* ... remaining cells follow same pattern: add onUserEdit() to each onChange ... */}
    </tr>
  );
};
```

Then replace the `.map()` in the table body:

```typescript
{visibleColumns.map((col, idx) => (
  <ColumnRow
    key={col.id}
    col={col}
    idx={idx}
    tabId={tabId}
    updateColumn={updateColumn}
    moveColumn={moveColumn}
    removeColumn={removeColumn}
    dataTypeOptions={dataTypeOptions}
    t={t}
  />
))}
```

**Important:** The `ColumnRow` component must include ALL existing `<td>` cells from the original `<tr>` (name, dataType, length, nullable, defaultValue, isPrimaryKey, extra, comment, actions). Copy them verbatim from the existing code, only adding `onUserEdit()` to each `onChange` handler. Do NOT omit any cells or change any existing behavior.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to TableStructureView

- [ ] **Step 7: Manual test**

1. Open a table structure tab (click a table → "Edit Structure" or create new table)
2. Use AI to modify columns (via MCP ui_patch on table_form, e.g. `/columns/[name=id]/dataType` → `BIGINT`)
3. Verify: the modified column row pulses green for 2.4s, then shows residual
4. Verify: editing any cell in the row clears the residual
5. Test top-level field: AI changes `/tableName` → tableName input pulses

- [ ] **Step 8: Commit**

```bash
git add src/components/MainContent/TableStructureView.tsx
git commit -m "feat(highlight): add AI change highlights to TableStructureView columns and fields"
```

---

## Self-Review Checklist

### Spec Coverage
| Spec Requirement | Task |
|-----------------|------|
| QueryEditorAdapter path extraction | Task 1 |
| QueryEditor Monaco line highlights | Task 2 (Steps 2-3) |
| QueryEditor dropdown highlights | Task 2 (Steps 5-7) |
| QueryEditor cleanup | Task 2 (Step 4) |
| MetricFormAdapter path extraction | Task 3 |
| MetricTab all 11 fields highlighted | Task 4 (Steps 4-8) |
| MetricTab cleanup | Task 4 (Step 3) |
| TableFormAdapter path extraction + column merging | Task 5 |
| TableStructureView tableName highlight | Task 6 (Step 4) |
| TableStructureView column row highlights | Task 6 (Step 5) |
| TableStructureView cleanup | Task 6 (Step 3) |

### Type Consistency
- `useFieldHighlight(scopeId, path)` returns `{ phase, className, onUserEdit }` — consistent across all tasks
- `useMonacoHighlight(editorRef)` returns `{ notifyContentChange }` — used in Task 2
- `useHighlightStore.getState().addHighlights(objectId, paths)` — called in Tasks 1, 3, 5
- `useHighlightStore.getState().clearAll(tabId)` — called in Tasks 2, 4, 6
- `HighlightedField` component signature `{ scopeId, path, children: (onUserEdit) => ReactNode }` — consistent in Tasks 4, 6
