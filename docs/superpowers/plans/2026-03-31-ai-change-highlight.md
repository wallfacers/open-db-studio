# AI Change Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When AI modifies SeaTunnel job config via MCP ui_patch, visually highlight changed fields with a pulse animation that fades into a residual marker.

**Architecture:** A generic `highlightStore` (Zustand) tracks changed field paths per scope. Two hooks — `useFieldHighlight` for form fields and `useMonacoHighlight` for Monaco editors — consume the store and apply CSS animations. The adapter's `patchDirect()` triggers highlights by diffing old vs new JSON.

**Tech Stack:** React 18, Zustand, Monaco Editor (`@monaco-editor/react`), CSS keyframe animations

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/store/highlightStore.ts` | Create | Generic highlight state: entries per scopeId, lifecycle methods |
| `src/utils/jsonDiff.ts` | Create | Recursive JSON tree diff → changed leaf paths |
| `src/styles/ai-highlight.css` | Create | Pulse keyframe + residual CSS classes |
| `src/hooks/useFieldHighlight.ts` | Create | Hook: subscribes to highlightStore, returns className + onUserEdit |
| `src/hooks/useMonacoHighlight.ts` | Create | Hook: computes line diff, manages Monaco deltaDecorations |
| `src/mcp/ui/adapters/SeaTunnelJobAdapter.ts` | Modify | Call highlightStore.addHighlights after patchDirect |
| `src/components/SeaTunnelJobTab/VisualBuilder.tsx` | Modify | Wrap fields with useFieldHighlight |
| `src/components/SeaTunnelJobTab/JsonEditor.tsx` | Modify | Integrate useMonacoHighlight |
| `src/components/SeaTunnelJobTab/index.tsx` | Modify | Pass scopeId, cleanup on unmount |
| `src/main.tsx` | Modify | Import ai-highlight.css |

---

### Task 1: CSS Animation & Import

**Files:**
- Create: `src/styles/ai-highlight.css`
- Modify: `src/main.tsx`

- [ ] **Step 1: Create the CSS animation file**

Create `src/styles/ai-highlight.css`:

```css
/* ── AI Change Highlight: Pulse + Residual ────────────────────── */

@keyframes ai-pulse {
  0%   { background-color: transparent; box-shadow: none; }
  15%  { background-color: rgba(0, 201, 167, 0.35); box-shadow: 0 0 12px rgba(0, 201, 167, 0.25); }
  30%  { background-color: rgba(0, 201, 167, 0.08); box-shadow: none; }
  45%  { background-color: rgba(0, 201, 167, 0.30); box-shadow: 0 0 10px rgba(0, 201, 167, 0.2); }
  60%  { background-color: rgba(0, 201, 167, 0.05); box-shadow: none; }
  75%  { background-color: rgba(0, 201, 167, 0.20); box-shadow: 0 0 6px rgba(0, 201, 167, 0.15); }
  100% { background-color: rgba(0, 201, 167, 0.06); box-shadow: none; }
}

.ai-highlight-pulse {
  animation: ai-pulse 2.4s ease-in-out forwards;
  border-radius: 4px;
}

.ai-highlight-residual {
  background-color: rgba(0, 201, 167, 0.06);
  border-left: 2px solid rgba(0, 201, 167, 0.4);
  border-radius: 4px;
}

/* Monaco editor line decorations */
.ai-line-pulse {
  animation: ai-pulse 2.4s ease-in-out forwards;
}

.ai-line-residual {
  background-color: rgba(0, 201, 167, 0.06);
}

.ai-gutter-residual {
  background: rgba(0, 201, 167, 0.4);
  width: 3px !important;
  margin-left: 3px;
  border-radius: 1px;
}
```

- [ ] **Step 2: Import CSS in main.tsx**

In `src/main.tsx`, add the import after the existing `./index.css` import:

```typescript
import './styles/ai-highlight.css';
```

The full import section should read:

```typescript
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import App from './App.tsx';
import './index.css';
import './styles/ai-highlight.css';
```

- [ ] **Step 3: Verify the app still loads**

Run: `npm run dev`
Expected: App starts on port 1420 with no errors. No visual change yet.

- [ ] **Step 4: Commit**

```bash
git add src/styles/ai-highlight.css src/main.tsx
git commit -m "feat: add AI change highlight CSS animations (pulse + residual)"
```

---

### Task 2: JSON Diff Utility

**Files:**
- Create: `src/utils/jsonDiff.ts`

- [ ] **Step 1: Create jsonDiff.ts**

Create `src/utils/jsonDiff.ts`:

```typescript
/**
 * Recursively diff two JSON-serializable objects and return changed leaf paths.
 *
 * Example:
 *   diffJsonPaths({ env: { parallelism: 6 } }, { env: { parallelism: 2 } })
 *   // → ['env.parallelism']
 *
 * Returns ['*'] (wildcard = everything changed) when inputs are incompatible types.
 */
export function diffJsonPaths(
  oldObj: unknown,
  newObj: unknown,
  prefix = '',
): string[] {
  // Both null/undefined and equal → no diff
  if (oldObj === newObj) return []

  // Type mismatch or either is a primitive → the whole subtree changed
  if (
    typeof oldObj !== typeof newObj ||
    oldObj === null || newObj === null ||
    typeof oldObj !== 'object' || typeof newObj !== 'object'
  ) {
    return prefix ? [prefix] : ['*']
  }

  // Array vs non-array mismatch
  if (Array.isArray(oldObj) !== Array.isArray(newObj)) {
    return prefix ? [prefix] : ['*']
  }

  const paths: string[] = []

  if (Array.isArray(oldObj) && Array.isArray(newObj)) {
    const maxLen = Math.max(oldObj.length, newObj.length)
    for (let i = 0; i < maxLen; i++) {
      const p = prefix ? `${prefix}.${i}` : String(i)
      if (i >= oldObj.length) {
        paths.push(p)
      } else if (i >= newObj.length) {
        paths.push(p)
      } else {
        paths.push(...diffJsonPaths(oldObj[i], newObj[i], p))
      }
    }
  } else {
    // Plain objects
    const oldRec = oldObj as Record<string, unknown>
    const newRec = newObj as Record<string, unknown>
    const allKeys = new Set([...Object.keys(oldRec), ...Object.keys(newRec)])
    for (const key of allKeys) {
      const p = prefix ? `${prefix}.${key}` : key
      if (!(key in oldRec)) {
        paths.push(p)
      } else if (!(key in newRec)) {
        paths.push(p)
      } else {
        paths.push(...diffJsonPaths(oldRec[key], newRec[key], p))
      }
    }
  }

  return paths
}

/**
 * Safely diff two JSON strings. Returns changed paths, or ['*'] on parse failure.
 */
export function diffJsonStringPaths(oldJson: string, newJson: string): string[] {
  try {
    const oldObj = JSON.parse(oldJson)
    const newObj = JSON.parse(newJson)
    return diffJsonPaths(oldObj, newObj)
  } catch {
    return ['*']
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/jsonDiff.ts
git commit -m "feat: add generic JSON tree diff utility for change detection"
```

---

### Task 3: Highlight Store

**Files:**
- Create: `src/store/highlightStore.ts`

- [ ] **Step 1: Create highlightStore.ts**

Create `src/store/highlightStore.ts`:

```typescript
import { create } from 'zustand'

export interface HighlightEntry {
  path: string
  phase: 'pulse' | 'residual'
  timestamp: number
}

const PULSE_DURATION = 2400 // ms — matches CSS animation duration

interface HighlightState {
  /** key = scopeId (e.g. tabId), value = highlight entries for that scope */
  highlights: Map<string, HighlightEntry[]>

  /** Add highlight entries in 'pulse' phase. Auto-promotes to 'residual' after PULSE_DURATION. */
  addHighlights: (scopeId: string, paths: string[]) => void

  /** Get the phase for a specific field path within a scope. Returns null if not highlighted. */
  getPhase: (scopeId: string, path: string) => 'pulse' | 'residual' | null

  /** Clear a single field's highlight (called when user edits the field). */
  clearHighlight: (scopeId: string, path: string) => void

  /** Clear all highlights for a scope (called when tab closes). */
  clearAll: (scopeId: string) => void
}

export const useHighlightStore = create<HighlightState>((set, get) => ({
  highlights: new Map(),

  addHighlights: (scopeId, paths) => {
    const now = Date.now()
    const entries: HighlightEntry[] = paths.map(p => ({
      path: p,
      phase: 'pulse' as const,
      timestamp: now,
    }))

    set(state => {
      const next = new Map(state.highlights)
      // Merge with existing (replace entries for same paths)
      const existing = (next.get(scopeId) ?? []).filter(
        e => !paths.includes(e.path)
      )
      next.set(scopeId, [...existing, ...entries])
      return { highlights: next }
    })

    // Auto-promote to residual after pulse duration
    setTimeout(() => {
      set(state => {
        const next = new Map(state.highlights)
        const list = next.get(scopeId)
        if (!list) return state
        const updated = list.map(e =>
          e.timestamp === now && e.phase === 'pulse'
            ? { ...e, phase: 'residual' as const }
            : e
        )
        next.set(scopeId, updated)
        return { highlights: next }
      })
    }, PULSE_DURATION)
  },

  getPhase: (scopeId, path) => {
    const list = get().highlights.get(scopeId)
    if (!list) return null
    // Wildcard: if '*' exists, all fields are highlighted
    const wildcard = list.find(e => e.path === '*')
    if (wildcard) return wildcard.phase
    const entry = list.find(e => e.path === path)
    return entry?.phase ?? null
  },

  clearHighlight: (scopeId, path) => {
    set(state => {
      const next = new Map(state.highlights)
      const list = next.get(scopeId)
      if (!list) return state
      next.set(scopeId, list.filter(e => e.path !== path))
      return { highlights: next }
    })
  },

  clearAll: (scopeId) => {
    set(state => {
      const next = new Map(state.highlights)
      next.delete(scopeId)
      return { highlights: next }
    })
  },
}))
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/store/highlightStore.ts
git commit -m "feat: add generic highlight store for AI change tracking"
```

---

### Task 4: useFieldHighlight Hook

**Files:**
- Create: `src/hooks/useFieldHighlight.ts`

- [ ] **Step 1: Create useFieldHighlight.ts**

Create `src/hooks/useFieldHighlight.ts`:

```typescript
import { useCallback } from 'react'
import { useHighlightStore } from '../store/highlightStore'

/**
 * Generic hook for form field highlight.
 * Returns a CSS class name based on the current highlight phase,
 * and a callback to clear the highlight when the user edits the field.
 *
 * Usage:
 *   const { className, onUserEdit } = useFieldHighlight(tabId, 'env.parallelism')
 *   <div className={className}>
 *     <input onChange={(e) => { onUserEdit(); handle(e) }} />
 *   </div>
 */
export function useFieldHighlight(scopeId: string, path: string) {
  const phase = useHighlightStore(
    s => s.getPhase(scopeId, path)
  )
  const clearHighlight = useHighlightStore(s => s.clearHighlight)

  const className =
    phase === 'pulse'
      ? 'ai-highlight-pulse'
      : phase === 'residual'
        ? 'ai-highlight-residual'
        : ''

  const onUserEdit = useCallback(() => {
    clearHighlight(scopeId, path)
  }, [clearHighlight, scopeId, path])

  return { phase, className, onUserEdit }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useFieldHighlight.ts
git commit -m "feat: add useFieldHighlight hook for form field change indicators"
```

---

### Task 5: useMonacoHighlight Hook

**Files:**
- Create: `src/hooks/useMonacoHighlight.ts`

- [ ] **Step 1: Create useMonacoHighlight.ts**

Create `src/hooks/useMonacoHighlight.ts`:

```typescript
import { useRef, useCallback, useEffect } from 'react'
import type * as Monaco from 'monaco-editor'

const PULSE_DURATION = 2400

/**
 * Compute changed line numbers between two strings (1-based).
 * If the line count difference exceeds 50%, returns null (= fallback to full flash).
 */
function diffLines(oldText: string, newText: string): number[] | null {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  // Fallback if structure changed too much
  const maxLen = Math.max(oldLines.length, newLines.length)
  if (maxLen === 0) return null
  const minLen = Math.min(oldLines.length, newLines.length)
  if (maxLen > 0 && (maxLen - minLen) / maxLen > 0.5) return null

  const changed: number[] = []
  for (let i = 0; i < maxLen; i++) {
    if ((oldLines[i] ?? '') !== (newLines[i] ?? '')) {
      changed.push(i + 1) // Monaco lines are 1-based
    }
  }
  return changed
}

function linesToDecorations(
  lines: number[],
  className: string,
  glyphClassName?: string,
): Monaco.editor.IModelDeltaDecoration[] {
  return lines.map(line => ({
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    options: {
      isWholeLine: true,
      className,
      glyphMarginClassName: glyphClassName,
    },
  }))
}

/**
 * Generic hook for Monaco editor AI change highlighting.
 *
 * Usage:
 *   const { notifyContentChange } = useMonacoHighlight(editorRef)
 *   // When external (AI) content arrives:
 *   notifyContentChange(oldJson, newJson)
 */
export function useMonacoHighlight(
  editorRef: React.RefObject<Monaco.editor.IStandaloneCodeEditor | null>,
) {
  const decorationIdsRef = useRef<string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const disposableRef = useRef<Monaco.IDisposable>()

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      disposableRef.current?.dispose()
    }
  }, [])

  const notifyContentChange = useCallback(
    (oldValue: string, newValue: string) => {
      const editor = editorRef.current
      if (!editor) return

      // Clear previous decorations
      decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, [])
      if (timerRef.current) clearTimeout(timerRef.current)
      disposableRef.current?.dispose()

      const changedLines = diffLines(oldValue, newValue)

      let targetLines: number[]
      if (changedLines === null || changedLines.length === 0) {
        // Fallback: flash all lines
        const lineCount = editor.getModel()?.getLineCount() ?? 0
        if (lineCount === 0) return
        targetLines = Array.from({ length: lineCount }, (_, i) => i + 1)
      } else {
        targetLines = changedLines
      }

      // Phase 1: Pulse decorations
      decorationIdsRef.current = editor.deltaDecorations(
        [],
        linesToDecorations(targetLines, 'ai-line-pulse'),
      )

      // Phase 2: After pulse ends, switch to residual
      timerRef.current = setTimeout(() => {
        if (!editorRef.current) return
        decorationIdsRef.current = editorRef.current.deltaDecorations(
          decorationIdsRef.current,
          linesToDecorations(targetLines, 'ai-line-residual', 'ai-gutter-residual'),
        )
      }, PULSE_DURATION)

      // Clear residual decorations on user edit in those lines
      disposableRef.current = editor.onDidChangeModelContent((e) => {
        if (!editorRef.current) return
        const editedLines = new Set<number>()
        for (const change of e.changes) {
          for (let l = change.range.startLineNumber; l <= change.range.endLineNumber; l++) {
            editedLines.add(l)
          }
        }
        // Remove decorations for edited lines
        const remaining = linesToDecorations(
          targetLines.filter(l => !editedLines.has(l)),
          'ai-line-residual',
          'ai-gutter-residual',
        )
        decorationIdsRef.current = editorRef.current.deltaDecorations(
          decorationIdsRef.current,
          remaining,
        )
        // Update targetLines
        targetLines = targetLines.filter(l => !editedLines.has(l))
        if (targetLines.length === 0) {
          disposableRef.current?.dispose()
        }
      })
    },
    [editorRef],
  )

  return { notifyContentChange }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useMonacoHighlight.ts
git commit -m "feat: add useMonacoHighlight hook for editor line change indicators"
```

---

### Task 6: Wire SeaTunnelJobAdapter to Trigger Highlights

**Files:**
- Modify: `src/mcp/ui/adapters/SeaTunnelJobAdapter.ts`

- [ ] **Step 1: Modify patchDirect to trigger highlights**

In `src/mcp/ui/adapters/SeaTunnelJobAdapter.ts`, add the import at the top (after existing imports):

```typescript
import { useHighlightStore } from '../../../store/highlightStore'
import { diffJsonStringPaths } from '../../../utils/jsonDiff'
```

Then replace the `patchDirect` method (lines 62-76) with:

```typescript
  patchDirect(ops: JsonPatchOp[]): PatchResult {
    const current = useSeaTunnelJobFormStore.getState().getForm(this.objectId)
    if (!current) return { status: 'error', message: `No form state for ${this.objectId}` }
    const oldConfigJson = current.configJson
    try {
      const patched = applyPatch(current, ops)
      useSeaTunnelJobFormStore.getState().setForm(this.objectId, patched)
      // 同步到 seaTunnelStore.stJobContent，触发 SeaTunnelJobTab 的 externalContent 订阅
      if (patched.jobId && patched.configJson) {
        useSeaTunnelStore.getState().setStJobContent(patched.jobId, patched.configJson)
      }

      // 提取变更路径并触发高亮
      const changedPaths = this.extractChangedPaths(ops, oldConfigJson, patched.configJson)
      if (changedPaths.length > 0) {
        useHighlightStore.getState().addHighlights(this.objectId, changedPaths)
      }

      return { status: 'applied' }
    } catch (e) {
      return { status: 'error', message: String(e) }
    }
  }
```

Then add the `extractChangedPaths` private method after `patchDirect`, before the `exec` method:

```typescript
  private extractChangedPaths(
    ops: JsonPatchOp[],
    oldConfigJson: string,
    newConfigJson: string,
  ): string[] {
    const paths: string[] = []
    for (const op of ops) {
      const segments = op.path.replace(/^\//, '').split('/')
      const topKey = segments[0]
      if (topKey === 'configJson') {
        // Diff the JSON content to get specific field paths
        paths.push(...diffJsonStringPaths(oldConfigJson, newConfigJson))
      } else {
        // Direct field (e.g. /jobName) → map as-is
        paths.push(segments.join('.'))
      }
    }
    return paths
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/ui/adapters/SeaTunnelJobAdapter.ts
git commit -m "feat: trigger highlight store from SeaTunnelJobAdapter.patchDirect"
```

---

### Task 7: Wire VisualBuilder with useFieldHighlight

**Files:**
- Modify: `src/components/SeaTunnelJobTab/VisualBuilder.tsx`
- Modify: `src/components/SeaTunnelJobTab/index.tsx`

- [ ] **Step 1: Pass scopeId to VisualBuilder**

In `src/components/SeaTunnelJobTab/index.tsx`, modify the `VisualBuilder` invocation (line 475). Change:

```tsx
<VisualBuilder value={builderState} onChange={handleBuilderChange} />
```

to:

```tsx
<VisualBuilder value={builderState} onChange={handleBuilderChange} scopeId={tabId} />
```

- [ ] **Step 2: Update VisualBuilder props and add highlight to env bar**

In `src/components/SeaTunnelJobTab/VisualBuilder.tsx`:

Add import at top (after existing imports):

```typescript
import { useFieldHighlight } from '../../hooks/useFieldHighlight';
```

Update the `VisualBuilderProps` interface (around line 417):

```typescript
interface VisualBuilderProps {
  value: BuilderState;
  onChange: (state: BuilderState) => void;
  scopeId: string;
}
```

Update the component signature (around line 422):

```typescript
const VisualBuilder: React.FC<VisualBuilderProps> = ({ value, onChange, scopeId }) => {
```

Add highlight hook call inside the component body, right after `const { t } = useTranslation();`:

```typescript
  const parallelismHighlight = useFieldHighlight(scopeId, 'env.parallelism');
```

Then wrap the parallelism stepper div (the `div` with `style={{ width: '80px' }}`, around line 431) with the highlight class. Replace:

```tsx
        <div className="flex items-stretch border border-[#253347] rounded overflow-hidden focus-within:border-[#00c9a7]/60 transition-colors" style={{ width: '80px' }}>
```

with:

```tsx
        <div className={`flex items-stretch border border-[#253347] rounded overflow-hidden focus-within:border-[#00c9a7]/60 transition-colors ${parallelismHighlight.className}`} style={{ width: '80px' }}>
```

Also update the parallelism `onChange` handler (around line 437) to clear highlight on user edit. Replace:

```tsx
            onChange={(e) =>
              onChange({ ...value, env: { ...value.env, parallelism: parseInt(e.target.value, 10) || 1 } })
            }
```

with:

```tsx
            onChange={(e) => {
              parallelismHighlight.onUserEdit();
              onChange({ ...value, env: { ...value.env, parallelism: parseInt(e.target.value, 10) || 1 } });
            }}
```

Also update the increment button onClick (around line 444). Replace:

```tsx
              onClick={() => onChange({ ...value, env: { ...value.env, parallelism: value.env.parallelism + 1 } })}
```

with:

```tsx
              onClick={() => { parallelismHighlight.onUserEdit(); onChange({ ...value, env: { ...value.env, parallelism: value.env.parallelism + 1 } }); }}
```

And the decrement button onClick (around line 450). Replace:

```tsx
              onClick={() => onChange({ ...value, env: { ...value.env, parallelism: Math.max(1, value.env.parallelism - 1) } })}
```

with:

```tsx
              onClick={() => { parallelismHighlight.onUserEdit(); onChange({ ...value, env: { ...value.env, parallelism: Math.max(1, value.env.parallelism - 1) } }); }}
```

- [ ] **Step 3: Add highlight to ConnectorPanel fields**

In the same file, update `ConnectorPanelProps` to include `scopeId` and `section`:

```typescript
interface ConnectorPanelProps {
  title: string;
  config: ConnectorConfig;
  onChange: (config: ConnectorConfig) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  scopeId: string;
  section: string; // 'source.0' or 'sink.0'
}
```

Update the `ConnectorPanel` signature:

```typescript
const ConnectorPanel: React.FC<ConnectorPanelProps> = ({ title, config, onChange, t, scopeId, section }) => {
```

In the dynamic fields rendering (inside the `fields.map` around line 317), wrap each field with highlight. Replace:

```tsx
        {fields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1">
            <span className={labelCls}>
              {getTranslatedLabel(field.label, t)}
              {field.required && <span className="text-red-400 ml-0.5">*</span>}
            </span>
            <FieldInput
              field={field}
              value={config.fields[field.key] ?? ''}
              onChange={(v) => handleFieldChange(field.key, v)}
              t={t}
            />
          </div>
        ))}
```

with:

```tsx
        {fields.map((field) => (
          <HighlightedField key={field.key} scopeId={scopeId} path={`${section}.${field.key}`}>
            {(onUserEdit) => (
              <div className="flex flex-col gap-1">
                <span className={labelCls}>
                  {getTranslatedLabel(field.label, t)}
                  {field.required && <span className="text-red-400 ml-0.5">*</span>}
                </span>
                <FieldInput
                  field={field}
                  value={config.fields[field.key] ?? ''}
                  onChange={(v) => { onUserEdit(); handleFieldChange(field.key, v); }}
                  t={t}
                />
              </div>
            )}
          </HighlightedField>
        ))}
```

Add the `HighlightedField` helper component (before the `VisualBuilder` component, around line 415):

```typescript
/** Thin wrapper that applies highlight class to a field container */
const HighlightedField: React.FC<{
  scopeId: string;
  path: string;
  children: (onUserEdit: () => void) => React.ReactNode;
}> = ({ scopeId, path, children }) => {
  const { className, onUserEdit } = useFieldHighlight(scopeId, path);
  return <div className={className}>{children(onUserEdit)}</div>;
};
```

- [ ] **Step 4: Pass scopeId to ConnectorPanel calls**

In the VisualBuilder return JSX, update the Source ConnectorPanel (around line 464). Replace:

```tsx
          <ConnectorPanel
            title="Source"
            config={value.source}
            onChange={(source) => onChange({ ...value, source })}
            t={t}
          />
```

with:

```tsx
          <ConnectorPanel
            title="Source"
            config={value.source}
            onChange={(source) => onChange({ ...value, source })}
            t={t}
            scopeId={scopeId}
            section="source.0"
          />
```

Update the Sink ConnectorPanel (around line 482). Replace:

```tsx
          <ConnectorPanel
            title="Sink"
            config={value.sink}
            onChange={(sink) => onChange({ ...value, sink })}
            t={t}
          />
```

with:

```tsx
          <ConnectorPanel
            title="Sink"
            config={value.sink}
            onChange={(sink) => onChange({ ...value, sink })}
            t={t}
            scopeId={scopeId}
            section="sink.0"
          />
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/SeaTunnelJobTab/VisualBuilder.tsx src/components/SeaTunnelJobTab/index.tsx
git commit -m "feat: wire VisualBuilder fields with AI change highlight"
```

---

### Task 8: Wire JsonEditor with useMonacoHighlight

**Files:**
- Modify: `src/components/SeaTunnelJobTab/JsonEditor.tsx`
- Modify: `src/components/SeaTunnelJobTab/index.tsx`

- [ ] **Step 1: Refactor JsonEditor to expose editor ref and accept highlight callback**

Replace the entire content of `src/components/SeaTunnelJobTab/JsonEditor.tsx` with:

```tsx
import React, { useRef, useEffect, useCallback } from 'react';
import MonacoEditor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { useMonacoHighlight } from '../../hooks/useMonacoHighlight';

interface JsonEditorProps {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  /** When set, AI-driven external changes will be highlighted */
  externalValue?: string;
}

const handleEditorWillMount: BeforeMount = (monaco) => {
  if (!monaco.editor.getModel(monaco.Uri.parse('inmemory://odb-json-theme'))) {
    monaco.editor.defineTheme('odb-dark-json', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'string.key.json',   foreground: '5eb2f7' },
        { token: 'string.value.json', foreground: 'e8a87c' },
        { token: 'number',            foreground: '9de0b2' },
        { token: 'keyword',           foreground: '00c9a7' },
        { token: 'delimiter',         foreground: '7a9bb8' },
      ],
      colors: {
        'editor.background':                  '#111922',
        'editorGutter.background':            '#0d1117',
        'editorLineNumber.foreground':        '#2a3f5a',
        'editorLineNumber.activeForeground':  '#00c9a7',
        'editor.lineHighlightBackground':     '#0e1e2e',
        'editor.lineHighlightBorder':         '#00000000',
        'editor.selectionBackground':         '#003d2f80',
        'editor.inactiveSelectionBackground': '#003d2f40',
        'editorCursor.foreground':            '#00c9a7',
        'editorWidget.background':            '#151d28',
        'editorWidget.border':                '#1e2d42',
        'scrollbarSlider.background':         '#1e2d4260',
        'scrollbarSlider.hoverBackground':    '#2a3f5a80',
      },
    });
  }
};

const JsonEditor: React.FC<JsonEditorProps> = ({ value, onChange, readOnly = false, externalValue }) => {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const prevExternalRef = useRef<string>('');
  const { notifyContentChange } = useMonacoHighlight(editorRef);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  // Watch for external (AI) value changes and trigger highlight
  useEffect(() => {
    if (externalValue === undefined) return;
    const prev = prevExternalRef.current;
    prevExternalRef.current = externalValue;
    if (prev && prev !== externalValue) {
      notifyContentChange(prev, externalValue);
    }
  }, [externalValue, notifyContentChange]);

  return (
    <MonacoEditor
      height="100%"
      language="json"
      theme="odb-dark-json"
      value={value}
      beforeMount={handleEditorWillMount}
      onMount={handleMount}
      onChange={(v) => {
        if (!readOnly && v !== undefined) onChange(v);
      }}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        tabSize: 2,
        formatOnPaste: true,
        formatOnType: false,
        automaticLayout: true,
        glyphMargin: true,
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
        },
      }}
    />
  );
};

export default JsonEditor;
```

- [ ] **Step 2: Pass externalValue from SeaTunnelJobTab to JsonEditor**

In `src/components/SeaTunnelJobTab/index.tsx`, update the JsonEditor usage (around line 477). Replace:

```tsx
          <JsonEditor value={configJson} onChange={handleJsonChange} />
```

with:

```tsx
          <JsonEditor value={configJson} onChange={handleJsonChange} externalValue={externalContent} />
```

- [ ] **Step 3: Add cleanup on tab unmount**

In `src/components/SeaTunnelJobTab/index.tsx`, add the import at the top (after existing imports):

```typescript
import { useHighlightStore } from '../../store/highlightStore';
```

Add a cleanup effect after the existing init/cleanup useEffect (after line 124):

```typescript
  // ── Cleanup highlights on unmount ─────────────────────────────
  useEffect(() => {
    return () => useHighlightStore.getState().clearAll(tabId);
  }, [tabId]);
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/SeaTunnelJobTab/JsonEditor.tsx src/components/SeaTunnelJobTab/index.tsx
git commit -m "feat: wire JsonEditor with Monaco AI change highlight"
```

---

### Task 9: Integration Verification

- [ ] **Step 1: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Run Rust backend check**

Run: `cd src-tauri && cargo check`
Expected: No errors (no Rust changes in this feature).

- [ ] **Step 3: Manual integration test**

Run: `npm run tauri:dev`

Test scenario:
1. Open a SeaTunnel job tab
2. Trigger an AI modification (via MCP chat: e.g. "把并行度改为 5")
3. **Visual mode**: Verify the parallelism field shows a 3-pulse animation, then fades to a residual marker (faint background + left border)
4. Manually edit the parallelism field → verify residual marker clears
5. Switch to **Script mode** → trigger another AI modification
6. Verify changed lines in Monaco show pulse animation then residual decoration
7. Edit a highlighted line → verify decoration clears for that line
8. Close the tab and reopen → verify no stale highlights

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: integration fixes for AI change highlight"
```
