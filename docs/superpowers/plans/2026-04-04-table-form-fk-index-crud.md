# TableForm FK & Index AI CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable AI to CRUD foreign keys and indexes on an open `table_form` via `ui_exec`, and accept `foreignKeys` in `init_table_form` initialization.

**Architecture:** Add 6 named exec actions (`add/update/remove_foreign_key`, `add/update/remove_index`) to `TableFormUIObject.exec()` in `TableFormAdapter.ts`. Extend `init_table_form` handler in Rust `mcp/mod.rs` to translate `foreignKeys` input array into JSON Patch add-ops, identical to the existing `columns`/`indexes` handling.

**Tech Stack:** TypeScript (Vitest tests), Rust (serde_json / json! macro)

---

## File Map

| File | Change |
|------|--------|
| `src/mcp/ui/__tests__/TableFormAdapter.test.ts` | Add test suite for 6 new exec actions |
| `src/mcp/ui/adapters/TableFormAdapter.ts` | Add 6 exec action cases + update `read('actions')` schema + rename `_params` → `params` |
| `src-tauri/src/mcp/mod.rs` | Add `foreignKeys` to `init_table_form` inputSchema + handler loop |

---

## Task 1: Write failing tests for the 6 exec actions

**Files:**
- Modify: `src/mcp/ui/__tests__/TableFormAdapter.test.ts`

- [ ] **Step 1: Append new describe block to the test file**

Open `src/mcp/ui/__tests__/TableFormAdapter.test.ts` and append the following at the end (after line 221):

```typescript
// ── Mocks needed for useHighlightStore (used by remove actions) ──
vi.mock('../../../store/highlightStore', () => ({
  useHighlightStore: {
    getState: () => ({ addHighlights: vi.fn() }),
  },
}))

describe('TableFormUIObject - exec FK and index actions', () => {
  const tabId = 'test_exec_fk'

  beforeEach(() => {
    useTableFormStore.getState().initForm(tabId, {
      tableName: 'orders',
      engine: 'InnoDB',
      charset: 'utf8mb4',
      comment: '',
      columns: [
        { id: 'c1', name: 'id', dataType: 'BIGINT', isPrimaryKey: true, _isNew: true },
        { id: 'c2', name: 'user_id', dataType: 'BIGINT', _isNew: true },
      ],
      indexes: [
        { id: 'i1', name: 'idx_user_id', type: 'INDEX', columns: '[{"name":"user_id","order":"ASC"}]', _isNew: true },
        { id: 'i2', name: 'idx_status', type: 'INDEX', columns: '[{"name":"status","order":"ASC"}]' }, // existing (no _isNew)
      ],
      foreignKeys: [
        { id: 'fk1', constraintName: 'fk_orders_user_id', column: 'user_id', referencedTable: 'users', referencedColumn: 'id', onDelete: 'NO ACTION', onUpdate: 'NO ACTION', _isNew: true },
        { id: 'fk2', constraintName: 'fk_orders_product_id', column: 'product_id', referencedTable: 'products', referencedColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' }, // existing
      ],
      isNewTable: true,
    })
  })

  // ── add_foreign_key ────────────────────────────────────────────

  it('add_foreign_key adds FK with auto-generated constraintName', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_foreign_key', {
      column: 'category_id',
      referencedTable: 'categories',
      referencedColumn: 'id',
    })
    expect(result.success).toBe(true)
    expect(result.data.constraintName).toBe('fk_orders_category_id')
    const form = useTableFormStore.getState().getForm(tabId)!
    const fk = form.foreignKeys.find(f => f.constraintName === 'fk_orders_category_id')
    expect(fk).toBeDefined()
    expect(fk!.referencedTable).toBe('categories')
    expect(fk!.onDelete).toBe('NO ACTION')
    expect(fk!._isNew).toBe(true)
  })

  it('add_foreign_key uses explicit constraintName when provided', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_foreign_key', {
      constraintName: 'my_custom_fk',
      column: 'category_id',
      referencedTable: 'categories',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
    })
    expect(result.success).toBe(true)
    expect(result.data.constraintName).toBe('my_custom_fk')
    const form = useTableFormStore.getState().getForm(tabId)!
    const fk = form.foreignKeys.find(f => f.constraintName === 'my_custom_fk')!
    expect(fk.onDelete).toBe('CASCADE')
  })

  it('add_foreign_key returns error when required params missing', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_foreign_key', { column: 'category_id' })
    expect(result.success).toBe(false)
  })

  // ── update_foreign_key ─────────────────────────────────────────

  it('update_foreign_key changes onDelete on an existing FK', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_foreign_key', {
      constraintName: 'fk_orders_user_id',
      onDelete: 'CASCADE',
    })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.foreignKeys.find(f => f.constraintName === 'fk_orders_user_id')!.onDelete).toBe('CASCADE')
  })

  it('update_foreign_key returns error when constraintName missing', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_foreign_key', { onDelete: 'CASCADE' })
    expect(result.success).toBe(false)
  })

  it('update_foreign_key returns error when no valid fields provided', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_foreign_key', { constraintName: 'fk_orders_user_id' })
    expect(result.success).toBe(false)
  })

  // ── remove_foreign_key ─────────────────────────────────────────

  it('remove_foreign_key physically removes a _isNew FK', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_foreign_key', { constraintName: 'fk_orders_user_id' })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.foreignKeys.find(f => f.constraintName === 'fk_orders_user_id')).toBeUndefined()
  })

  it('remove_foreign_key soft-deletes an existing FK (no _isNew)', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_foreign_key', { constraintName: 'fk_orders_product_id' })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    const fk = form.foreignKeys.find(f => f.constraintName === 'fk_orders_product_id')
    expect(fk).toBeDefined()
    expect(fk!._isDeleted).toBe(true)
  })

  it('remove_foreign_key returns error for unknown constraintName', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_foreign_key', { constraintName: 'nonexistent_fk' })
    expect(result.success).toBe(false)
  })

  // ── add_index ──────────────────────────────────────────────────

  it('add_index adds index with auto-generated name', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_index', {
      columns: ['email', 'status'],
    })
    expect(result.success).toBe(true)
    expect(result.data.name).toBe('idx_email_status')
    const form = useTableFormStore.getState().getForm(tabId)!
    const idx = form.indexes.find(i => i.name === 'idx_email_status')!
    expect(idx).toBeDefined()
    expect(idx.type).toBe('INDEX')
    expect(idx._isNew).toBe(true)
    // columns stored as JSON string
    const cols = JSON.parse(idx.columns)
    expect(cols[0].name).toBe('email')
    expect(cols[1].name).toBe('status')
  })

  it('add_index uses explicit name and type', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_index', {
      name: 'idx_email_unique',
      columns: ['email'],
      type: 'UNIQUE',
    })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    const idx = form.indexes.find(i => i.name === 'idx_email_unique')!
    expect(idx.type).toBe('UNIQUE')
  })

  it('add_index returns error when columns missing', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('add_index', { name: 'idx_test' })
    expect(result.success).toBe(false)
  })

  // ── update_index ───────────────────────────────────────────────

  it('update_index changes type', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_index', {
      name: 'idx_user_id',
      type: 'UNIQUE',
    })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.indexes.find(i => i.name === 'idx_user_id')!.type).toBe('UNIQUE')
  })

  it('update_index changes columns (converts string[] to JSON string)', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_index', {
      name: 'idx_user_id',
      columns: ['user_id', 'created_at'],
    })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    const idx = form.indexes.find(i => i.name === 'idx_user_id')!
    const cols = JSON.parse(idx.columns)
    expect(cols).toHaveLength(2)
    expect(cols[0].name).toBe('user_id')
    expect(cols[1].name).toBe('created_at')
  })

  it('update_index returns error when name missing', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('update_index', { type: 'UNIQUE' })
    expect(result.success).toBe(false)
  })

  // ── remove_index ───────────────────────────────────────────────

  it('remove_index physically removes a _isNew index', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_index', { name: 'idx_user_id' })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    expect(form.indexes.find(i => i.name === 'idx_user_id')).toBeUndefined()
  })

  it('remove_index soft-deletes an existing index (no _isNew)', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_index', { name: 'idx_status' })
    expect(result.success).toBe(true)
    const form = useTableFormStore.getState().getForm(tabId)!
    const idx = form.indexes.find(i => i.name === 'idx_status')
    expect(idx).toBeDefined()
    expect(idx!._isDeleted).toBe(true)
  })

  it('remove_index returns error for unknown index name', async () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const result = await obj.exec('remove_index', { name: 'nonexistent_idx' })
    expect(result.success).toBe(false)
  })

  // ── read actions includes all 8 actions ────────────────────────

  it('read actions includes all 8 actions including 6 new ones', () => {
    const obj = new TableFormUIObject(tabId, 1, 'testdb')
    const actions = obj.read('actions') as any[]
    const names = actions.map((a: any) => a.name)
    expect(names).toContain('preview_sql')
    expect(names).toContain('save')
    expect(names).toContain('add_foreign_key')
    expect(names).toContain('update_foreign_key')
    expect(names).toContain('remove_foreign_key')
    expect(names).toContain('add_index')
    expect(names).toContain('update_index')
    expect(names).toContain('remove_index')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- TableFormAdapter
```

Expected: FAIL — `exec` doesn't have `add_foreign_key` etc., `read('actions')` only returns 2 actions.

---

## Task 2: Implement the 6 exec actions in `TableFormAdapter.ts`

**Files:**
- Modify: `src/mcp/ui/adapters/TableFormAdapter.ts`

- [ ] **Step 1: Rename `_params` to `params` in the `exec` method signature**

Find (line 586):
```typescript
async exec(action: string, _params?: any): Promise<ExecResult> {
```
Replace with:
```typescript
async exec(action: string, params?: any): Promise<ExecResult> {
```

- [ ] **Step 2: Replace the `read('actions')` return value**

Find (lines 399–413):
```typescript
      case 'actions':
        return [
          {
            name: 'preview_sql',
            description: 'Preview CREATE/ALTER TABLE SQL based on current form state',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'save',
            description: 'Generate SQL and write to query tab for review',
            paramsSchema: { type: 'object', properties: {} },
          },
        ]
```

Replace with:
```typescript
      case 'actions': {
        const CASCADE_OPTS = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT']
        const INDEX_TYPES = ['INDEX', 'UNIQUE', 'FULLTEXT']
        return [
          {
            name: 'preview_sql',
            description: 'Preview CREATE/ALTER TABLE SQL based on current form state',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'save',
            description: 'Generate SQL and write to query tab for review',
            paramsSchema: { type: 'object', properties: {} },
          },
          {
            name: 'add_foreign_key',
            description: 'Add a foreign key constraint. constraintName is auto-generated as fk_{tableName}_{column} if omitted.',
            paramsSchema: {
              type: 'object',
              properties: {
                column: { type: 'string', description: 'Column in this table (required)' },
                referencedTable: { type: 'string', description: 'Referenced table name (required)' },
                referencedColumn: { type: 'string', description: 'Referenced column name (required)' },
                constraintName: { type: 'string', description: 'Constraint name (auto-generated if omitted)' },
                onDelete: { type: 'string', enum: CASCADE_OPTS, default: 'NO ACTION' },
                onUpdate: { type: 'string', enum: CASCADE_OPTS, default: 'NO ACTION' },
              },
              required: ['column', 'referencedTable', 'referencedColumn'],
            },
          },
          {
            name: 'update_foreign_key',
            description: 'Update properties of an existing foreign key (located by constraintName).',
            paramsSchema: {
              type: 'object',
              properties: {
                constraintName: { type: 'string', description: 'Constraint name to locate the FK (required)' },
                column: { type: 'string' },
                referencedTable: { type: 'string' },
                referencedColumn: { type: 'string' },
                onDelete: { type: 'string', enum: CASCADE_OPTS },
                onUpdate: { type: 'string', enum: CASCADE_OPTS },
              },
              required: ['constraintName'],
            },
          },
          {
            name: 'remove_foreign_key',
            description: 'Remove a foreign key constraint. Soft-deletes for existing tables; physically removes for new tables.',
            paramsSchema: {
              type: 'object',
              properties: {
                constraintName: { type: 'string', description: 'Constraint name to remove (required)' },
              },
              required: ['constraintName'],
            },
          },
          {
            name: 'add_index',
            description: 'Add an index. name is auto-generated as idx_{columns} if omitted.',
            paramsSchema: {
              type: 'object',
              properties: {
                columns: { type: 'array', items: { type: 'string' }, description: 'Column names for the index (required)' },
                name: { type: 'string', description: 'Index name (auto-generated if omitted)' },
                type: { type: 'string', enum: INDEX_TYPES, default: 'INDEX' },
              },
              required: ['columns'],
            },
          },
          {
            name: 'update_index',
            description: 'Update properties of an existing index (located by name).',
            paramsSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Index name to locate (required)' },
                columns: { type: 'array', items: { type: 'string' }, description: 'New column names' },
                type: { type: 'string', enum: INDEX_TYPES },
              },
              required: ['name'],
            },
          },
          {
            name: 'remove_index',
            description: 'Remove an index. Soft-deletes for existing tables; physically removes for new tables.',
            paramsSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Index name to remove (required)' },
              },
              required: ['name'],
            },
          },
        ]
      }
```

- [ ] **Step 3: Add the 6 exec action cases to the `exec()` switch**

Find (line 590—606):
```typescript
    switch (action) {
      case 'preview_sql': {
        try {
          const sql = generateTableSql(state, this.getDriver())
          return { success: true, data: { sql } }
        } catch (e) {
          return execError(String(e))
        }
      }
      case 'save': {
        const previewResult = await this.exec('preview_sql')
        if (!previewResult.success) return previewResult
        return { success: true, data: { sql: previewResult.data.sql, message: 'SQL generated. Open query tab to execute.' } }
      }
      default:
        return execError(`Unknown action: ${action}`, 'Available actions: preview_sql, save')
    }
```

Replace with:
```typescript
    switch (action) {
      case 'preview_sql': {
        try {
          const sql = generateTableSql(state, this.getDriver())
          return { success: true, data: { sql } }
        } catch (e) {
          return execError(String(e))
        }
      }
      case 'save': {
        const previewResult = await this.exec('preview_sql')
        if (!previewResult.success) return previewResult
        return { success: true, data: { sql: previewResult.data.sql, message: 'SQL generated. Open query tab to execute.' } }
      }

      case 'add_foreign_key': {
        const p = params ?? {}
        const { column, referencedTable, referencedColumn, onDelete = 'NO ACTION', onUpdate = 'NO ACTION' } = p
        if (!column || !referencedTable || !referencedColumn) {
          return execError('column, referencedTable, referencedColumn are required')
        }
        const constraintName = p.constraintName || `fk_${state.tableName}_${column}`
        const r = this.patchDirect([{
          op: 'add',
          path: '/foreignKeys/-',
          value: { constraintName, column, referencedTable, referencedColumn, onDelete, onUpdate },
        }])
        if (r.status === 'applied') return { success: true, data: { constraintName } }
        return execError('Failed to add foreign key')
      }

      case 'update_foreign_key': {
        const p = params ?? {}
        const { constraintName, ...updates } = p
        if (!constraintName) return execError('constraintName is required')
        const ALLOWED = ['column', 'referencedTable', 'referencedColumn', 'onDelete', 'onUpdate', 'constraintName']
        const ops: JsonPatchOp[] = Object.entries(updates as Record<string, unknown>)
          .filter(([k]) => ALLOWED.includes(k))
          .map(([k, v]) => ({ op: 'replace' as const, path: `/foreignKeys[constraintName=${constraintName}]/${k}`, value: v }))
        if (ops.length === 0) return execError('No valid fields to update')
        const r = this.patchDirect(ops)
        if (r.status === 'applied') return { success: true, data: { updated: constraintName } }
        return execError('Failed to update foreign key')
      }

      case 'remove_foreign_key': {
        const { constraintName } = params ?? {}
        if (!constraintName) return execError('constraintName is required')
        const fks = state.foreignKeys ?? []
        const idx = fks.findIndex(fk => fk.constraintName === constraintName && !fk._isDeleted)
        if (idx === -1) return execError(`Foreign key not found: ${constraintName}`)
        const fk = fks[idx]
        const newFks = fk._isNew
          ? fks.filter((_, i) => i !== idx)
          : fks.map((f, i) => i === idx ? { ...f, _isDeleted: true } : f)
        useTableFormStore.getState().setForm(this.objectId, { ...state, foreignKeys: newFks })
        useHighlightStore.getState().addHighlights(this.objectId, ['foreignKeys'])
        return { success: true, data: { removed: constraintName } }
      }

      case 'add_index': {
        const p = params ?? {}
        const { columns, type = 'INDEX', name } = p
        if (!columns || !Array.isArray(columns) || columns.length === 0) {
          return execError('columns array is required')
        }
        const indexName: string = name || `idx_${(columns as string[]).join('_')}`
        const columnsJson = JSON.stringify((columns as string[]).map(c => ({ name: c, order: 'ASC' })))
        const r = this.patchDirect([{
          op: 'add',
          path: '/indexes/-',
          value: { name: indexName, type, columns: columnsJson },
        }])
        if (r.status === 'applied') return { success: true, data: { name: indexName } }
        return execError('Failed to add index')
      }

      case 'update_index': {
        const p = params ?? {}
        const { name, columns, type } = p
        if (!name) return execError('name is required')
        const ops: JsonPatchOp[] = []
        if (type !== undefined) {
          ops.push({ op: 'replace', path: `/indexes[name=${name}]/type`, value: type })
        }
        if (columns !== undefined) {
          if (!Array.isArray(columns)) return execError('columns must be an array of strings')
          const columnsJson = JSON.stringify((columns as string[]).map(c => ({ name: c, order: 'ASC' })))
          ops.push({ op: 'replace', path: `/indexes[name=${name}]/columns`, value: columnsJson })
        }
        if (ops.length === 0) return execError('No valid fields to update')
        const r = this.patchDirect(ops)
        if (r.status === 'applied') return { success: true, data: { updated: name } }
        return execError('Failed to update index')
      }

      case 'remove_index': {
        const { name } = params ?? {}
        if (!name) return execError('name is required')
        const indexes = state.indexes ?? []
        const idx = indexes.findIndex(i => i.name === name && !i._isDeleted)
        if (idx === -1) return execError(`Index not found: ${name}`)
        const index = indexes[idx]
        const newIndexes = index._isNew
          ? indexes.filter((_, i) => i !== idx)
          : indexes.map((ix, i) => i === idx ? { ...ix, _isDeleted: true } : ix)
        useTableFormStore.getState().setForm(this.objectId, { ...state, indexes: newIndexes })
        useHighlightStore.getState().addHighlights(this.objectId, ['indexes'])
        return { success: true, data: { removed: name } }
      }

      default:
        return execError(`Unknown action: ${action}`, 'Available actions: preview_sql, save, add_foreign_key, update_foreign_key, remove_foreign_key, add_index, update_index, remove_index')
    }
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- TableFormAdapter
```

Expected: All tests PASS including the new `exec FK and index actions` suite.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ui/__tests__/TableFormAdapter.test.ts src/mcp/ui/adapters/TableFormAdapter.ts
git commit -m "feat(TableFormAdapter): add exec actions for FK and index CRUD"
```

---

## Task 3: Extend `init_table_form` in `mcp/mod.rs`

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`

> Note: No unit tests for Rust MCP handlers — verify manually after this task by running `npm run tauri:dev` and confirming the schema appears in AI tooling.

- [ ] **Step 1: Add `foreignKeys` to the `inputSchema` of `init_table_form`**

Find (around line 266 in `mcp/mod.rs`):
```rust
                        "comment": { "type": "string", "description": "Table comment" },
                        "engine": { "type": "string", "default": "InnoDB" },
                        "charset": { "type": "string", "default": "utf8mb4" }
                    },
                    "required": ["connection_id", "database", "table_name", "columns"]
```

Replace with:
```rust
                        "comment": { "type": "string", "description": "Table comment" },
                        "engine": { "type": "string", "default": "InnoDB" },
                        "charset": { "type": "string", "default": "utf8mb4" },
                        "foreignKeys": {
                            "type": "array",
                            "description": "Foreign key definitions (optional). Can also be added later via ui_exec add_foreign_key.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "constraintName": { "type": "string", "description": "Constraint name (auto-generated as fk_{tableName}_{column} if omitted)" },
                                    "column": { "type": "string", "description": "Column in this table" },
                                    "referencedTable": { "type": "string", "description": "Referenced table name" },
                                    "referencedColumn": { "type": "string", "description": "Referenced column name" },
                                    "onDelete": { "type": "string", "enum": ["NO ACTION", "CASCADE", "SET NULL", "RESTRICT", "SET DEFAULT"], "default": "NO ACTION" },
                                    "onUpdate": { "type": "string", "enum": ["NO ACTION", "CASCADE", "SET NULL", "RESTRICT", "SET DEFAULT"], "default": "NO ACTION" }
                                },
                                "required": ["column", "referencedTable", "referencedColumn"]
                            }
                        }
                    },
                    "required": ["connection_id", "database", "table_name", "columns"]
```

- [ ] **Step 2: Add `foreignKeys` loop in the `init_table_form` handler**

Find (around line 700 in `mcp/mod.rs`):
```rust
            if let Some(indexes) = args["indexes"].as_array() {
                for idx in indexes {
                    ops.push(json!({"op": "add", "path": "/indexes/-", "value": idx}));
                }
            }

            let patch_payload = json!({
```

Replace with:
```rust
            if let Some(indexes) = args["indexes"].as_array() {
                for idx in indexes {
                    ops.push(json!({"op": "add", "path": "/indexes/-", "value": idx}));
                }
            }
            if let Some(fks) = args.get("foreignKeys").and_then(|v| v.as_array()) {
                for fk in fks {
                    ops.push(json!({"op": "add", "path": "/foreignKeys/-", "value": fk}));
                }
            }

            let patch_payload = json!({
```

- [ ] **Step 3: Update the result JSON to include `foreign_keys_count`**

Find (around line 715 in `mcp/mod.rs`):
```rust
            let result = json!({
                "objectId": object_id,
                "table_name": args["table_name"],
                "columns_count": args["columns"].as_array().map(|a| a.len()).unwrap_or(0),
                "patch_status": patch_result.get("data").and_then(|d| d.get("status")).unwrap_or(&json!("unknown")),
            });
```

Replace with:
```rust
            let result = json!({
                "objectId": object_id,
                "table_name": args["table_name"],
                "columns_count": args["columns"].as_array().map(|a| a.len()).unwrap_or(0),
                "foreign_keys_count": args.get("foreignKeys").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
                "patch_status": patch_result.get("data").and_then(|d| d.get("status")).unwrap_or(&json!("unknown")),
            });
```

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

Expected: Compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): extend init_table_form with foreignKeys parameter"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| `init_table_form` accepts `foreignKeys` parameter | Task 3 |
| `add_foreign_key` exec action | Task 2 Step 3 |
| `update_foreign_key` exec action | Task 2 Step 3 |
| `remove_foreign_key` exec action | Task 2 Step 3 |
| `add_index` exec action | Task 2 Step 3 |
| `update_index` exec action | Task 2 Step 3 |
| `remove_index` exec action | Task 2 Step 3 |
| `read('actions')` includes all 8 actions | Task 2 Step 2 |
| Auto-generate `constraintName` as `fk_{tableName}_{column}` | Task 2 Step 3 |
| Auto-generate index `name` as `idx_{columns}` | Task 2 Step 3 |
| Soft-delete for existing FK/index | Task 2 Step 3 |
| Physical delete for new FK/index | Task 2 Step 3 |

**Notes:**
- Design doc used `NORMAL` for index type, but actual `TableFormIndex.type` is `'INDEX' | 'UNIQUE' | 'FULLTEXT'`. Plan uses `INDEX` (correct value from codebase).
- `remove_foreign_key` / `remove_index` bypass `patchDirect` to handle soft-delete logic directly, consistent with how `normalizeColumnOps` handles column removal.
- `update_foreign_key` uses `patchDirect` with `[constraintName=xxx]` path syntax, which is supported natively by `applyPatch` via `resolvePath`.
