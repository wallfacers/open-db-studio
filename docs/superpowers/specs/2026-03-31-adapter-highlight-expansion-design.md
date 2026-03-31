<!-- STATUS: ✅ 已实现 -->
# AI Change Highlight Expansion Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand the existing AI change highlight system (built for SeaTunnelJobAdapter) to QueryEditorAdapter, MetricFormAdapter, and TableFormAdapter.

**Architecture:** Each adapter independently extracts changed paths in its `patchDirect` method and calls `highlightStore.addHighlights()`. UI components wrap their fields with `useFieldHighlight` (form fields) or `useMonacoHighlight` (Monaco editors). No new shared abstractions needed.

**Prerequisite:** The generic highlight infrastructure is already in place:
- `src/store/highlightStore.ts` — Zustand store with pulse/residual lifecycle
- `src/hooks/useFieldHighlight.ts` — Form field highlight hook
- `src/hooks/useMonacoHighlight.ts` — Monaco editor line-level highlight hook
- `src/styles/ai-highlight.css` — CSS animations (pulse + residual)
- `src/utils/jsonDiff.ts` — JSON tree diff utility

---

## 1. QueryEditorAdapter

### 1.1 Adapter Layer (`src/mcp/ui/adapters/QueryEditorAdapter.ts`)

Modify `patchDirect` to extract changed paths by comparing old vs new state:

- Save `oldContent` (from `sqlContent[objectId]`) and `oldCtx` (from `tab.queryContext`) before patch
- After applying patch, compare:
  - `patched.content !== oldContent` → push `'content'`
  - `patched.connectionId !== oldCtx.connectionId` → push `'connectionId'`
  - `patched.database !== oldCtx.database` → push `'database'`
  - `patched.schema !== oldCtx.schema` → push `'schema'`
- Call `useHighlightStore.getState().addHighlights(this.objectId, paths)`

### 1.2 UI Layer (`src/components/MainContent/index.tsx`)

**SQL Editor (Monaco) — line-level highlighting:**

- Add `editorRef` (already exists as local ref in `handleEditorDidMount`)
- Add `useMonacoHighlight(editorRef)` to get `notifyContentChange`
- Track previous SQL content via `useRef`. When `sqlContent[activeTab]` changes AND the highlight store has a `'content'` entry in pulse phase for this tab, call `notifyContentChange(prevSql, newSql)`
- This ensures only AI-driven changes trigger line highlights, not user typing

**Context dropdowns — field-level highlighting:**

- Wrap each `DropdownSelect` (connectionId, database, schema) with `useFieldHighlight(activeTab, 'connectionId')` etc.
- Apply `className` to the dropdown container
- Call `onUserEdit()` in each dropdown's `onChange` handler

**Cleanup:**

- Add `useEffect` cleanup: `return () => useHighlightStore.getState().clearAll(tabId)` on tab unmount

---

## 2. MetricFormAdapter

### 2.1 Adapter Layer (`src/mcp/ui/adapters/MetricFormAdapter.ts`)

Modify `patchDirect` to compare old vs new form state field-by-field:

- Save `current` (already available) before patch
- After applying patch, iterate `Object.keys(patched)` and compare with `current[key]`
- Collect changed keys as paths
- Call `useHighlightStore.getState().addHighlights(this.objectId, paths)`

### 2.2 UI Layer (`src/components/MetricsExplorer/MetricTab.tsx`)

**Form fields — field-level highlighting:**

All 11 form fields get highlight support:

| Field | Highlight path | Input type |
|-------|---------------|------------|
| Metric Type | `metricType` | Radio buttons |
| Display Name | `displayName` | Text input |
| English Name | `name` | Text input |
| Category | `category` | TagInput |
| Version | `version` | Text input |
| Related Table | `tableName` | DropdownSelect |
| Related Column | `columnName` | DropdownSelect |
| Aggregation | `aggregation` | DropdownSelect |
| Description | `description` | Textarea |
| Data Caliber | `data_caliber` | Textarea |
| Filter SQL | `filterSql` | Textarea |

**Integration pattern:**

- Use `HighlightedField` wrapper component (same pattern as SeaTunnel VisualBuilder)
- Each field's container `<div>` gets `className` from `useFieldHighlight`
- Each field's onChange calls `onUserEdit()` to clear residual on user edit

**Cleanup:**

- Add `useEffect` cleanup: `clearAll(tabId)` on unmount

---

## 3. TableFormAdapter

### 3.1 Adapter Layer (`src/mcp/ui/adapters/TableFormAdapter.ts`)

Modify `patchDirect` with a dedicated `extractChangedPaths` method:

**Top-level fields** (direct mapping):
- `/tableName` → `'tableName'`
- `/engine` → `'engine'`
- `/charset` → `'charset'`
- `/comment` → `'comment'`

**Column fields** (merge to row level by column name):
- `/columns/[name=id]/dataType` → `'columns.id'` (addressable-by-name syntax)
- `/columns/3/comment` → `'columns.<name>'` (resolve index to column name from patched state)
- `/columns/-` (append) → `'columns.<newName>'` (last column in patched array)

**Indexes** (same pattern):
- `/indexes/[name=idx]/...` → `'indexes.idx'`

Deduplicate paths with `new Set()`.

### 3.2 UI Layer (`src/components/MainContent/TableStructureView.tsx`)

**Top-level fields:**

- tableName input: `useFieldHighlight(tabId, 'tableName')`
- engine/charset/comment (if rendered): same pattern

**Column table rows:**

- Each `<tr>` uses `useFieldHighlight(tabId, \`columns.\${col.name}\`)`
- Apply `className` to the `<tr>` element (entire row highlights)
- All cell onChange handlers call `onUserEdit()`

**Cleanup:**

- Add `useEffect` cleanup: `clearAll(tabId)` on unmount

---

## 4. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SQL editor highlight granularity | Line-level (useMonacoHighlight) | SQL is the core scenario; users need to see exactly which lines AI changed |
| Context dropdowns highlight | Yes (useFieldHighlight) | Minimal effort, high value when AI switches database/schema |
| Table columns highlight granularity | Row-level | Cell-level too visually fragmented in a dense table |
| Column path merging | `columns.<columnName>` | Natural mapping from addressable-by-name patch paths |
| Path extraction approach | Each adapter implements its own | SeaTunnel needs JSON deep diff, QueryEditor needs direct compare, TableForm needs index resolution — too different to abstract |
| ERCanvas highlight | Deferred (tech debt in PLANS.md) | Canvas/SVG rendering needs different approach; has undo as alternative |

## 5. Files Modified

| File | Change |
|------|--------|
| `src/mcp/ui/adapters/QueryEditorAdapter.ts` | Add highlight path extraction in `patchDirect` |
| `src/mcp/ui/adapters/MetricFormAdapter.ts` | Add highlight path extraction in `patchDirect` |
| `src/mcp/ui/adapters/TableFormAdapter.ts` | Add `extractChangedPaths` method and highlight trigger in `patchDirect` |
| `src/components/MainContent/index.tsx` | Add `useMonacoHighlight` for SQL editor, `useFieldHighlight` for dropdowns, cleanup effect |
| `src/components/MetricsExplorer/MetricTab.tsx` | Add `HighlightedField` wrapper for all form fields, cleanup effect |
| `src/components/MainContent/TableStructureView.tsx` | Add `useFieldHighlight` for top fields and column rows, cleanup effect |

No new files created. No changes to existing highlight infrastructure.
