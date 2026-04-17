# Migration Center Redesign: MigrateQL Code-Driven Architecture

## Overview

Replace the current GUI form-driven migration configuration with a SQL-like domain-specific language (MigrateQL). Users/AI write declarative migration scripts in a Monaco code editor; the Rust backend parses the script into the existing `MigrationJobConfig` IR and executes it through the unchanged ETL pipeline.

### Key Decisions

| Decision | Choice |
|----------|--------|
| Configuration paradigm | Code-driven (MigrateQL DSL), GUI completely removed |
| Tab layout | Clone SQL editor: code on top, result panel below |
| Parser location | Rust backend (pest PEG) |
| Editor experience | Monarch tokenizer (frontend lexical) + embedded LSP via invoke (semantic) |
| AI integration | Ghost Text inline completion only |
| Connection references | Both direct name and USE alias declarations |
| Existing data | Clear all, no migration path |
| Storage | `config_json` renamed to `script_text` |

---

## 1. MigrateQL Language Specification

### Grammar (BNF)

```
script        → (statement ';')* EOF
statement     → use_stmt | set_stmt | migrate_stmt
use_stmt      → 'USE' IDENT '=' 'CONNECTION' '(' STRING ')'
set_stmt      → 'SET' assignment (',' assignment)*
assignment    → IDENT '=' value
migrate_stmt  → 'MIGRATE' 'FROM' table_ref 'INTO' table_ref
                mapping_clause?
                where_clause?
                conflict_clause?
                incremental_clause?
                create_clause?

table_ref     → IDENT '.' IDENT ('.' IDENT)?
mapping_clause→ 'MAPPING' '(' mapping_entry (',' mapping_entry)* ')'
              | 'MAPPING' '(' '*' ')'
mapping_entry → expr '->' IDENT ('::' type_cast)?
where_clause  → 'WHERE' condition
conflict_clause → 'ON' 'CONFLICT' strategy ('BY' '(' col_list ')')?
strategy      → 'UPSERT' | 'REPLACE' | 'SKIP' | 'INSERT' | 'OVERWRITE'
incremental_clause → 'INCREMENTAL' 'ON' IDENT
create_clause → 'CREATE' 'IF' 'NOT' 'EXISTS'
```

### Keywords

```
MIGRATE  FROM  INTO  MAPPING  WHERE  SET  USE  CONNECTION
ON  CONFLICT  UPSERT  REPLACE  SKIP  INSERT  OVERWRITE
BY  INCREMENTAL  CREATE  IF  NOT  EXISTS
```

### Built-in Variables

| Variable | Meaning |
|----------|---------|
| `$LAST_VALUE` | Last incremental sync checkpoint value |

### Comments

```sql
-- Single line comment
/* Multi-line comment */
```

### Type Casting

```sql
created_at -> created_at :: TIMESTAMPTZ
amount -> amount :: NUMERIC(12,2)
```

`::` type is written to `ColumnMapping.target_type`, passed through to target database without validation.

### Examples

**Simple 1:1 migration:**
```sql
MIGRATE FROM source_conn.mydb.users
        INTO target_conn.pgdb.users;
```

**With field mapping:**
```sql
MIGRATE FROM source_conn.mydb.orders
        INTO target_conn.pgdb.t_orders
MAPPING (
    id          -> id,
    user_name   -> full_name,
    created_at  -> created_at :: TIMESTAMPTZ,
    CONCAT(first_name, ' ', last_name) -> display_name
)
WHERE status = 'active' AND created_at > '2025-01-01'
ON CONFLICT UPSERT BY (id);
```

**One-to-many (table splitting):**
```sql
MIGRATE FROM shop.orders
        INTO warehouse.order_headers
MAPPING (id -> id, user_id -> user_id, total -> total);

MIGRATE FROM shop.orders
        INTO warehouse.order_items
MAPPING (id -> order_id, product_name -> name, qty -> quantity);
```

**Many-to-one (table merging):**
```sql
MIGRATE FROM mysql_a.db1.customers
        INTO pg.unified.all_customers
MAPPING (id -> id, name -> name, 'region_a' -> region);

MIGRATE FROM mysql_b.db2.customers
        INTO pg.unified.all_customers
MAPPING (id -> id, name -> name, 'region_b' -> region)
ON CONFLICT SKIP;
```

**Incremental sync:**
```sql
MIGRATE FROM source.orders
        INTO target.orders
MAPPING (*)
WHERE updated_at > $LAST_VALUE
INCREMENTAL ON updated_at;
```

**Full example with USE and SET:**
```sql
USE source = CONNECTION('Production MySQL');
USE target = CONNECTION('Analytics PG');

SET parallelism = 8,
    error_limit = 50,
    read_batch  = 10000;

MIGRATE FROM source.shop.users
        INTO target.public.dim_users
MAPPING (
    id -> user_id,
    nickname -> display_name,
    phone -> phone :: VARCHAR(20),
    created_at -> registered_at :: TIMESTAMPTZ
)
WHERE is_deleted = 0
ON CONFLICT UPSERT BY (user_id)
CREATE IF NOT EXISTS;

MIGRATE FROM source.shop.orders
        INTO target.public.fact_orders
MAPPING (
    id -> order_id,
    user_id -> user_id,
    total_amount -> amount :: NUMERIC(12,2),
    status -> status,
    created_at -> order_time :: TIMESTAMPTZ
)
WHERE status != 'cancelled'
INCREMENTAL ON created_at
ON CONFLICT UPSERT BY (order_id);
```

---

## 2. Architecture

### Module Layout

```
src-tauri/src/migration/
├── mod.rs                 -- Module exports
├── mig_commands.rs        -- Tauri commands (adjusted interfaces)
├── repository.rs          -- Data access (field renames)
├── task_mgr.rs            -- MigrationJobConfig struct (retained as IR)
├── pipeline.rs            -- ETL engine (UNCHANGED)
├── precheck.rs            -- Pre-checks (UNCHANGED)
├── ddl_convert.rs         -- DDL generation (UNCHANGED)
├── lang/                  -- NEW: MigrateQL language layer
│   ├── mod.rs
│   ├── parser.rs          -- pest PEG parser
│   ├── ast.rs             -- AST node definitions
│   ├── compiler.rs        -- AST → MigrationJobConfig
│   ├── formatter.rs       -- AST → formatted text
│   └── migrateql.pest     -- PEG grammar file
└── lsp/                   -- NEW: Embedded LSP
    ├── mod.rs
    ├── handler.rs         -- Request dispatch
    ├── completion.rs      -- Completion logic
    ├── diagnostics.rs     -- Syntax + semantic diagnostics
    └── hover.rs           -- Hover information
```

### Data Flow

```
User writes MigrateQL
       ↓
  Monaco Editor (Monarch lexical highlighting)
       ↓ invoke('lsp_request') debounced 300ms
  lsp/handler.rs
  ├── Parse → lang/parser.rs → AST
  ├── Semantic validation → query datasource metadata
  └── Return diagnostics / completions / hover
       ↓
  User clicks Run
       ↓ invoke('run_migration_job')
  mig_commands.rs
  ├── Read script_text from DB
  ├── lang/parser.rs → AST
  ├── lang/compiler.rs → MigrationJobConfig (IR)
  └── pipeline.rs executes (UNCHANGED)
```

### Key Principles

- **`pipeline.rs` UNCHANGED** — it receives `MigrationJobConfig`, doesn't care about config source
- **`MigrationJobConfig` retained as IR** — no longer persisted, generated at runtime by compiler
- **LSP and execution share the same parser** — single parsing logic, zero divergence

---

## 3. Database Schema Changes

### migration_jobs table

```sql
-- Field rename
config_json  → script_text    -- MigrateQL source code (TEXT)
```

All other tables (`migration_categories`, `migration_run_history`, `migration_dirty_records`, `migration_checks`) remain unchanged.

### Rust struct change

```rust
// Old
pub struct MigrationJob {
    pub config_json: String,
}

// New
pub struct MigrationJob {
    pub script_text: String,
}
```

`repository.rs`: all `config_json` references renamed to `script_text`, SQL statements updated.

### Migration strategy

Development phase: directly modify `schema/init.sql`, clear old data. No backward compatibility.

---

## 4. Frontend Architecture

### Component Structure

```
src/components/MigrationJobTab/
├── index.tsx              -- Rewrite: clone SQL editor layout
├── MigrationEditor.tsx    -- NEW: Monaco editor wrapper (MigrateQL)
├── MigrationToolbar.tsx   -- NEW: toolbar (run/stop/format/ghost text toggle)
├── MonarchTokenizer.ts    -- NEW: MigrateQL lexical highlighting rules
├── LspAdapter.ts          -- NEW: invoke-based LSP adapter
├── ResultPanel/
│   ├── index.tsx          -- NEW: tab switching container
│   ├── LogTab.tsx         -- Reuse existing
│   ├── StatsTab.tsx       -- Reuse existing
│   └── HistoryTab.tsx     -- NEW: historical run records
├── MappingCard.tsx        -- Retain (runtime progress cards)
├── TimelineView.tsx       -- Retain
├── StatusIcons.tsx        -- Retain
└── LogDetailModal.tsx     -- Retain
```

### Deleted Files

```
src/components/MigrationJobTab/ConfigTab.tsx          DELETE
src/components/MigrationJobTab/TableMappingPanel.tsx   DELETE
src/components/MigrationJobTab/ColumnMappingPanel.tsx  DELETE
```

All import references cleaned up.

### Tab Layout (Clone SQL Editor)

```
┌─────────────────────────────────────────────┐
│ Toolbar (h-10)                              │
│ [▶ Run] [■ Stop] [Format] [✦ Ghost] │ conn  │
├─────────────────────────────────────────────┤
│                                             │
│  Monaco Editor (MigrateQL)                  │
│  flex-1, adaptive height                    │
│                                             │
├─── Drag splitter (h-[4.5px]) ──────────────┤
│ [Logs] [Stats] [History]     ← Result tabs  │
│                                             │
│  Active panel content                       │
│  - Logs: real-time log stream               │
│  - Stats: speed/progress/ETA/mapping cards  │
│  - History: past run records, click to view │
│                                             │
└─────────────────────────────────────────────┘
```

### LspAdapter

```typescript
class MigrateQLLspAdapter {
  private debounceTimer: number;

  onDidChangeContent(text: string) {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.requestDiagnostics(text);
    }, 300);
  }

  async provideCompletionItems(position, text): CompletionItem[] {
    return invoke('lsp_request', {
      method: 'textDocument/completion',
      params: { text, position }
    });
  }

  async requestDiagnostics(text): Diagnostic[] {
    return invoke('lsp_request', {
      method: 'textDocument/diagnostic',
      params: { text }
    });
  }

  async provideHover(position, text): Hover {
    return invoke('lsp_request', {
      method: 'textDocument/hover',
      params: { text, position }
    });
  }
}
```

### Monarch Tokenizer

```typescript
const MigrateQLLanguage = {
  keywords: ['MIGRATE','FROM','INTO','MAPPING','WHERE','SET','USE',
             'CONNECTION','ON','CONFLICT','UPSERT','REPLACE','SKIP',
             'INSERT','OVERWRITE','BY','INCREMENTAL','CREATE','IF',
             'NOT','EXISTS'],
  tokenizer: {
    root: [
      [/--.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/'[^']*'/, 'string'],
      [/\$[A-Z_]+/, 'variable'],
      [/::/, 'operator'],
      [/->/, 'operator'],
      [/[a-zA-Z_]\w*/, {
        cases: { '@keywords': 'keyword', '@default': 'identifier' }
      }],
      [/\d+/, 'number'],
    ],
    comment: [
      [/\*\//, 'comment', '@pop'],
      [/./, 'comment'],
    ]
  }
};
```

### migrationStore Changes

```typescript
interface MigrationStore {
  // Retained
  nodes, expandedIds, selectedId, activeRuns, ...

  // New
  updateJobScript(jobId: number, scriptText: string): Promise<void>;

  // Deleted: updateJobConfig() and all source/target/mapping temp edit state
}
```

---

## 5. Embedded LSP Design

### Tauri Command Entry

```rust
#[tauri::command]
pub async fn lsp_request(
    method: String,
    params: serde_json::Value,
    state: State<'_, AppState>,
) -> AppResult<serde_json::Value> {
    lsp::handler::handle_request(&method, params, &state).await
}
```

### Request Dispatch (handler.rs)

```rust
pub async fn handle_request(
    method: &str,
    params: Value,
    state: &AppState,
) -> AppResult<Value> {
    match method {
        "textDocument/diagnostic"  => diagnostics::diagnose(params, state).await,
        "textDocument/completion"  => completion::complete(params, state).await,
        "textDocument/hover"       => hover::hover(params, state).await,
        "textDocument/formatting"  => formatting::format(params).await,
        _ => Err(anyhow!("unknown LSP method: {method}")),
    }
}
```

### Diagnostics Flow

```
Input: { text: String }
       ↓
  1. parser::parse(text)
     ├── Syntax error → Diagnostic { severity: Error, range, message }
     └── Success → AST
       ↓
  2. Semantic validation (needs AppState)
     ├── USE connection name exists → query datasource connection list
     ├── table_ref db/table exists → query datasource metadata cache
     ├── MAPPING fields exist in source table → query column info
     ├── ON CONFLICT BY columns are PK/unique
     └── SET parameter values in valid range
       ↓
  3. Return Vec<Diagnostic>
```

### Completion Trigger Points

| Cursor Position | Completion Content | Data Source |
|----------------|-------------------|-------------|
| `MIGRATE FROM ▎` | Connection names + USE aliases | datasource pool |
| `FROM conn.▎` | Database list | `list_databases()` |
| `FROM conn.db.▎` | Table list | `list_tables()` |
| `MAPPING ( ▎` | Source table columns | `get_columns()` |
| `-> ▎` | Target table columns | `get_columns()` |
| `:: ▎` | Common types (filtered by target driver) | Static list |
| `ON CONFLICT ▎` | `UPSERT / REPLACE / SKIP / INSERT / OVERWRITE` | Static list |
| `SET ▎` | `parallelism / read_batch / write_batch / error_limit / speed_limit_rps` | Static list |
| Line start `▎` | `MIGRATE / USE / SET / --` | Static list |

### Hover Information

| Hover Target | Display Content |
|-------------|----------------|
| Connection name/alias | Driver type, host:port, database list |
| Table name | Row count, column count, size, primary key |
| Column name | Type, nullable, default value |
| `$LAST_VALUE` | Current checkpoint value (if any) |
| SET parameter name | Description and valid range |

### Ghost Text Completion

```rust
pub async fn complete(params: Value, state: &AppState) -> AppResult<Value> {
    let trigger = params["context"]["triggerKind"];
    match trigger {
        TriggerKind::Invoked => complete_items(params, state).await,
        TriggerKind::Inline => {
            let text = params["text"].as_str();
            let position = params["position"];
            let context = build_migration_context(text, position, state).await?;
            let suggestion = llm::complete_migration(context).await?;
            Ok(json!({ "insertText": suggestion }))
        }
    }
}
```

---

## 6. Parser & Compiler Design

### pest PEG Grammar (migrateql.pest)

```pest
script = { SOI ~ (statement ~ ";")* ~ EOI }
statement = { use_stmt | set_stmt | migrate_stmt }

use_stmt = { ^"USE" ~ ident ~ "=" ~ ^"CONNECTION" ~ "(" ~ string ~ ")" }

set_stmt = { ^"SET" ~ assignment ~ ("," ~ assignment)* }
assignment = { ident ~ "=" ~ value }
value = { number | string | ident }

migrate_stmt = {
    ^"MIGRATE" ~ ^"FROM" ~ table_ref ~ ^"INTO" ~ table_ref
    ~ mapping_clause?
    ~ where_clause?
    ~ conflict_clause?
    ~ incremental_clause?
    ~ create_clause?
}

table_ref = { ident ~ "." ~ ident ~ ("." ~ ident)? }

mapping_clause = { ^"MAPPING" ~ "(" ~ (star_mapping | mapping_list) ~ ")" }
star_mapping = { "*" }
mapping_list = { mapping_entry ~ ("," ~ mapping_entry)* }
mapping_entry = { expr ~ "->" ~ ident ~ type_cast? }
type_cast = { "::" ~ type_name }
type_name = { ident ~ ("(" ~ number ~ ("," ~ number)? ~ ")")? }

expr = { function_call | dotted_ident | string | ident }
function_call = { ident ~ "(" ~ (expr ~ ("," ~ expr)*)? ~ ")" }
dotted_ident = { ident ~ ("." ~ ident)+ }

where_clause = { ^"WHERE" ~ condition }
condition = { (!("ON" | "INCREMENTAL" | "CREATE" | ";") ~ ANY)+ }

conflict_clause = { ^"ON" ~ ^"CONFLICT" ~ strategy ~ (^"BY" ~ "(" ~ col_list ~ ")")? }
strategy = { ^"UPSERT" | ^"REPLACE" | ^"SKIP" | ^"INSERT" | ^"OVERWRITE" }
col_list = { ident ~ ("," ~ ident)* }

incremental_clause = { ^"INCREMENTAL" ~ ^"ON" ~ ident }
create_clause = { ^"CREATE" ~ ^"IF" ~ ^"NOT" ~ ^"EXISTS" }

ident = @{ (ASCII_ALPHA | "_") ~ (ASCII_ALPHANUMERIC | "_")* }
string = @{ "'" ~ (!"'" ~ ANY)* ~ "'" }
number = @{ ASCII_DIGIT+ }

WHITESPACE = _{ " " | "\t" | "\r" | "\n" }
COMMENT = _{ line_comment | block_comment }
line_comment = { "--" ~ (!"\n" ~ ANY)* }
block_comment = { "/*" ~ (!"*/" ~ ANY)* ~ "*/" }
```

### AST Nodes (ast.rs)

```rust
pub struct Script {
    pub statements: Vec<Statement>,
    pub span: Span,
}

pub enum Statement {
    Use(UseStmt),
    Set(SetStmt),
    Migrate(MigrateStmt),
}

pub struct UseStmt {
    pub alias: String,
    pub connection_name: String,
    pub span: Span,
}

pub struct SetStmt {
    pub assignments: Vec<(String, SetValue)>,
    pub span: Span,
}

pub struct MigrateStmt {
    pub source: TableRef,
    pub target: TableRef,
    pub mapping: Option<MappingClause>,
    pub filter: Option<String>,
    pub conflict: Option<ConflictClause>,
    pub incremental_on: Option<String>,
    pub create_if_not_exists: bool,
    pub span: Span,
}

pub struct TableRef {
    pub parts: Vec<String>,  // 2 or 3 segments: [conn, db, table] or [conn_or_db, table]
    pub span: Span,
}

pub struct MappingClause {
    pub auto_all: bool,
    pub entries: Vec<MappingEntry>,
}

pub struct MappingEntry {
    pub source_expr: String,
    pub target_col: String,
    pub target_type: Option<String>,
}

pub struct ConflictClause {
    pub strategy: ConflictStrategy,
    pub keys: Vec<String>,
}

pub use crate::migration::task_mgr::ConflictStrategy;

pub struct Span {
    pub start: Position,
    pub end: Position,
}

pub struct Position {
    pub line: u32,
    pub column: u32,
}
```

### Compiler (AST → MigrationJobConfig)

```rust
pub fn compile(
    script: &Script,
    resolve_connection: impl Fn(&str) -> Option<i64>,
) -> Result<MigrationJobConfig, Vec<CompileError>> {
    // 1. Collect USE declarations → alias_map: HashMap<String, String>
    // 2. Collect SET parameters → PipelineConfig
    // 3. For each MIGRATE statement:
    //    a. Resolve table_ref → via alias_map or direct connection name match → connection_id
    //    b. mapping_clause → Vec<ColumnMapping>
    //    c. where_clause → filter_condition
    //    d. conflict_clause → ConflictStrategy + upsert_keys
    //    e. incremental_clause → IncrementalConfig
    //    f. create_clause → create_if_not_exists
    // 4. Assemble MigrationJobConfig { table_mappings, pipeline, ... }
}

pub struct CompileError {
    pub message: String,
    pub span: Span,
    pub severity: Severity,
}
```

### Key Design Decisions

- **WHERE clause not deeply parsed** — kept as raw text, passed through to source database
- **MAPPING (*) deferred expansion** — not expanded at compile time (no table schema available); `auto_all=true` recorded in AST, pipeline expands at runtime by matching same-name columns
- **Span preserved** — every AST node records source position for diagnostics and hover
- **table_ref 2-segment handling** — when `table_ref` has only 2 parts (e.g., `conn.table`), the compiler uses the connection's default database. If the connection has no default database, emit a `CompileError` requiring 3-segment form (`conn.db.table`)

---

## 7. Ghost Text AI Integration

### Context Building

```rust
async fn build_migration_context(
    text: &str,
    cursor_line: u32,
    state: &AppState,
) -> MigrationAIContext {
    let partial_ast = parser::parse_partial(text);
    let mut schemas = Vec::new();
    for conn_ref in partial_ast.referenced_connections() {
        let conn_id = resolve_connection(conn_ref, state);
        if let Some(id) = conn_id {
            let tables = datasource::list_tables(id, &db).await;
            for t in tables {
                let cols = datasource::get_columns(id, &db, &t).await;
                schemas.push(TableSchema { conn: conn_ref, db, table: t, columns: cols });
            }
        }
    }
    MigrationAIContext { current_script: text.to_string(), cursor_line, available_schemas: schemas }
}
```

### Prompt Template

New file: `prompts/migration_ghost_text.md`

```markdown
You are a MigrateQL code completion assistant. Based on the user's existing script and cursor position, continue writing subsequent code.

## MigrateQL Syntax Reference
- MIGRATE FROM <conn.db.table> INTO <conn.db.table>
- MAPPING (source_col -> target_col :: TYPE, ...)
- MAPPING (*) for auto-mapping same-name columns
- WHERE <condition>
- ON CONFLICT UPSERT|REPLACE|SKIP|INSERT|OVERWRITE BY (col, ...)
- INCREMENTAL ON <column>
- CREATE IF NOT EXISTS
- USE <alias> = CONNECTION('<name>');
- SET parallelism=N, read_batch=N, write_batch=N, error_limit=N;

## Available Database Schemas
{{schemas}}

## Current Script
{{current_script}}

## Cursor Position
End of line {{cursor_line}}

## Requirements
- Only output continuation code, do not repeat existing content
- Infer user intent from context
- Generate accurate column names and types based on available table schemas
```

### AI Channel

```rust
pub async fn complete_migration(context: MigrationAIContext) -> AppResult<String> {
    let prompt = render_template("migration_ghost_text", &context)?;
    let response = llm_request(prompt, LlmOptions {
        max_tokens: 500,
        temperature: 0.1,
        stop: vec![";".into()],
    }).await?;
    Ok(response.trim().to_string())
}
```

### Frontend Integration

```typescript
monaco.languages.registerInlineCompletionsProvider('migrateql', {
    provideInlineCompletions: async (model, position) => {
        if (!ghostTextEnabled) return { items: [] };
        const text = model.getValue();
        const result = await invoke('lsp_request', {
            method: 'textDocument/completion',
            params: {
                text,
                position: { line: position.lineNumber - 1, column: position.column - 1 },
                context: { triggerKind: 'inline' }
            }
        });
        return { items: [{ insertText: result.insertText, range: ... }] };
    },
});
```

---

## 8. Testing Strategy

### Rust Tests

**Parser tests (lang/parser.rs)**

```
test_parse_simple_migrate           -- MIGRATE FROM a.b.c INTO d.e.f;
test_parse_mapping_star             -- MAPPING (*)
test_parse_mapping_explicit         -- MAPPING (a -> b :: INT, ...)
test_parse_where_clause             -- WHERE status = 'active'
test_parse_conflict_upsert          -- ON CONFLICT UPSERT BY (id)
test_parse_incremental              -- INCREMENTAL ON updated_at
test_parse_create_if_not_exists     -- CREATE IF NOT EXISTS
test_parse_use_stmt                 -- USE src = CONNECTION('my_mysql');
test_parse_set_stmt                 -- SET parallelism = 4, read_batch = 5000;
test_parse_multi_statement          -- Multiple MIGRATE statements
test_parse_comments                 -- Single-line and block comments
test_parse_type_cast                -- :: NUMERIC(12,2)
test_parse_function_expr            -- CONCAT(a, ' ', b) -> c
test_error_missing_semicolon
test_error_missing_into
test_error_invalid_table_ref
test_error_unclosed_mapping
test_error_span_accuracy
```

**Compiler tests (lang/compiler.rs)**

```
test_compile_simple                 -- Single statement → MigrationJobConfig
test_compile_use_alias              -- USE alias resolution
test_compile_use_and_direct         -- Alias + direct connection name mixed
test_compile_multi_migrate          -- Multiple statements → multiple table_mappings
test_compile_set_pipeline           -- SET → PipelineConfig
test_compile_mapping_star           -- auto_all = true
test_compile_incremental            -- IncrementalConfig generation
test_compile_unknown_connection     -- Unknown connection → CompileError
```

**LSP tests (lsp/)**

```
test_diag_syntax_error              -- Syntax error returns correct range
test_diag_unknown_connection        -- Connection doesn't exist
test_diag_clean_script              -- Valid script returns empty diagnostics
test_complete_after_from            -- Returns connection name list
test_complete_after_conn_dot        -- Returns database list
test_complete_after_db_dot          -- Returns table list
test_complete_in_mapping            -- Returns column list
test_complete_after_conflict        -- Returns strategy list
test_complete_after_set             -- Returns parameter name list
test_hover_connection_name          -- Shows connection info
test_hover_table_name               -- Shows table metadata
test_hover_column_name              -- Shows column type
```

### Frontend Tests

```
MigrationEditor.test.tsx            -- Monaco mount, language registration
MonarchTokenizer.test.ts            -- Keyword/string/comment/operator token classification
LspAdapter.test.ts                  -- invoke mock, debounce behavior, response mapping
ResultPanel.test.tsx                -- Tab switching, panel rendering
```

---

## 9. Frontend UI Design

All UI elements MUST use the project's semantic color system (Tailwind v4 CSS variables). No hardcoded hex values.

### Color System Reference

| Role | Variable | Usage |
|------|----------|-------|
| Panel background | `bg-background-panel` | Editor container, result panel |
| Elevated background | `bg-background-elevated` | Dropdown triggers, cards |
| Hover background | `bg-background-hover` | List item hover, tab hover |
| Void background | `bg-background-void` | Deep background, result area |
| Accent | `text-accent` | Active tab indicator, selected items, run button |
| Default text | `text-foreground-default` | Editor text, labels |
| Muted text | `text-foreground-muted` | Placeholders, secondary info |
| Default border | `border-border-default` | Dividers, inactive borders |
| Strong border | `border-border-strong` | Input borders, dropdown borders |
| Focus border | `border-border-focus` | Focus rings, hover borders |

### Toolbar Design

```
┌──────────────────────────────────────────────────────────────┐
│ h-10, bg-background-panel, border-b border-border-default    │
│                                                              │
│ [▶] [■]  [Format] [✦ Ghost]              │ Connection info │
│                                                              │
│ gap-1, px-2                               text-foreground-muted │
└──────────────────────────────────────────────────────────────┘

Button states:
- Default:  bg-transparent text-foreground-muted
- Hover:    bg-background-hover text-foreground-default
- Active:   text-accent (e.g., Ghost Text enabled)
- Run btn:  hover:text-success
- Stop btn: hover:text-error (only visible during run)
- Size:     h-7 w-7, rounded, transition-colors duration-150
```

### Dropdown / Select (MUST match project theme)

All dropdowns in migration editor (if any future additions) MUST use the existing `DropdownSelect` component from `src/components/common/DropdownSelect.tsx`. Style rules:

```
Trigger:
  bg-background-elevated
  border border-border-strong
  hover:border-border-focus
  text-foreground-default text-xs
  rounded px-2 py-1

Dropdown panel:
  bg-background-elevated
  border border-border-strong
  rounded shadow-lg
  z-[200] (portal to body)

Options:
  px-3 py-1.5 text-[12px]
  hover:bg-border-default
  transition-colors duration-150

Selected option:
  text-accent (#10B981)

Search input (if searchable):
  bg-background-base
  border border-border-strong
  focus:border-border-focus
  text-foreground-default
  placeholder:text-foreground-muted
```

No custom dropdown implementations. Reuse `DropdownSelect` for consistency.

### Result Panel Tabs

```
Tab bar:
  bg-background-base, border-t border-border-default

Active tab:
  bg-background-void text-accent
  border-t-[3px] border-t-accent

Inactive tab:
  bg-background-hover text-foreground-muted
  border-t-transparent
  hover:bg-background-elevated

Tab size:
  px-3 h-[38px] flex items-center gap-1.5 text-xs
```

### MappingCard (Runtime Progress)

Retained from existing design, follows current style:

```
Container:
  border-l-2 {status-color} bg-background-elevated rounded-r-md

Status border colors:
  success:  border-l-success
  running:  border-l-accent
  failed:   border-l-error
  pending:  border-l-foreground-ghost

Stats text:
  text-[10px] text-foreground-muted
  Important values: text-foreground-default font-medium
```

### Monaco Editor Container

```
Container:
  flex-1 bg-background-panel min-h-0 relative

Editor theme:
  Reuse existing 'odb-dark' theme registration
  Register 'migrateql' language with MonarchTokenizer

Gutter/line numbers:
  Inherit from odb-dark theme
```

### Splitter (Drag Handle)

```
  h-[4.5px] cursor-row-resize
  bg-transparent
  hover:bg-accent/30
  transition-colors
```

### End-to-End Verification

```
1. Write MigrateQL script → syntax highlighting correct
2. Intentional error → red squiggly at correct position
3. Type MIGRATE FROM → completion list shows connection names
4. Click Run → log panel shows real-time progress
5. Run completes → switch to History tab, see record
6. Ghost Text → type MIGRATE FROM, gray completion appears
```
