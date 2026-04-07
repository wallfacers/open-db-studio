# ER→数据库同步功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 ER 图→数据库同步：移除 `alert()`，生成方言正确的 ALTER/CREATE TABLE DDL，在预览对话框中展示，用户确认后执行。

**Architecture:** 前端 DiffReportDialog 构建过滤后的 DiffResult 传给 ERCanvas，ERCanvas 调用 Rust `er_generate_sync_ddl` 生成 DDL 语句列表，在 DDLPreviewDialog（新增 preloadedDdl 模式）中展示，执行时调用 `er_execute_sync_ddl`。

**Tech Stack:** Rust (Tauri 2.x)、React 18 + TypeScript、Zustand

---

## 文件改动清单

| 文件 | 操作 |
|------|------|
| `src-tauri/src/er/ddl_generator.rs` | 新增 4 个公有辅助函数 |
| `src-tauri/src/er/commands.rs` | 重写 `er_generate_sync_ddl`（第 471-533 行） |
| `src/store/erDesignerStore.ts` | 新增 `generateSyncDdl` 方法 |
| `src/components/ERDesigner/dialogs/DiffReportDialog.tsx` | 修改 `onSyncToDb` 签名和 `handleSyncToDb` 实现 |
| `src/components/ERDesigner/dialogs/DDLPreviewDialog.tsx` | 新增 `preloadedDdl?: string` prop |
| `src/components/ERDesigner/ERCanvas/index.tsx` | 替换 `alert()`，新增同步状态和流程 |
| `src/i18n/locales/zh.json` | 新增 `syncDdlPreview` 键 |
| `src/i18n/locales/en.json` | 新增 `syncDdlPreview` 键 |

---

## Task 1：在 ddl_generator.rs 中添加辅助函数

**文件：** Modify `src-tauri/src/er/ddl_generator.rs`

- [ ] **Step 1：在文件末尾（`generate_ddl` 函数之后）添加 `make_dialect_impl` 私有函数**

  在 `src-tauri/src/er/ddl_generator.rs` 末尾追加：

  ```rust
  // ---------------------------------------------------------------------------
  // Public helpers for sync DDL generation (used by er/commands.rs)
  // ---------------------------------------------------------------------------

  fn make_dialect_impl(dialect: &str) -> AppResult<Box<dyn DdlDialect>> {
      Ok(match dialect.to_lowercase().as_str() {
          "mysql" => Box::new(MySqlDialect),
          "postgres" | "postgresql" => Box::new(PostgresDialect),
          "oracle" => Box::new(OracleDialect),
          "sqlserver" | "mssql" => Box::new(SqlServerDialect),
          "sqlite" => Box::new(SqliteDialect),
          other => {
              return Err(AppError::Other(format!(
                  "Unsupported DDL dialect: {}",
                  other
              )))
          }
      })
  }

  /// Quote a SQL identifier using the appropriate dialect style.
  /// MySQL uses backticks, SQL Server uses brackets, others use double quotes.
  pub fn quote_identifier(name: &str, dialect: &str) -> String {
      match dialect.to_lowercase().as_str() {
          "mysql" => format!("`{}`", name.replace('`', "``")),
          "sqlserver" | "mssql" => format!("[{}]", name.replace(']', "]]")),
          _ => format!("\"{}\"", name.replace('"', "\"\"")),
      }
  }

  /// Format a column definition for use in ALTER TABLE ADD COLUMN or MODIFY COLUMN.
  /// Returns `quoted_name TYPE [UNSIGNED] [NOT NULL] [AUTO_INCREMENT] [UNIQUE] [DEFAULT ...]`
  pub fn format_column_for_alter(col: &ErColumn, dialect: &str) -> AppResult<String> {
      let d = make_dialect_impl(dialect)?;
      let mut def = format!(
          "{} {}",
          d.quote_identifier(&col.name),
          d.map_column_type(col)
      );
      if col.unsigned {
          def.push_str(" UNSIGNED");
      }
      if !col.nullable {
          def.push_str(" NOT NULL");
      }
      if col.is_auto_increment {
          let ai = d.auto_increment_syntax();
          if !ai.is_empty() {
              def.push_str(&format!(" {}", ai));
          }
      }
      if col.is_unique {
          def.push_str(" UNIQUE");
      }
      if let Some(ref dv) = col.default_value {
          if !dv.is_empty() {
              def.push_str(&format!(" DEFAULT {}", dv));
          }
      }
      Ok(def)
  }

  /// Generate dialect-specific ALTER TABLE MODIFY COLUMN statements.
  /// PostgreSQL returns two statements (TYPE change + NOT NULL change);
  /// SQL Server uses ALTER COLUMN syntax;
  /// MySQL/Oracle/SQLite use MODIFY COLUMN syntax.
  pub fn generate_modify_column_ddl(
      col: &ErColumn,
      table_name: &str,
      dialect: &str,
  ) -> AppResult<Vec<String>> {
      let d = make_dialect_impl(dialect)?;
      let q_table = d.quote_identifier(table_name);
      let col_def = format_column_for_alter(col, dialect)?;

      Ok(match dialect.to_lowercase().as_str() {
          "postgres" | "postgresql" => {
              let q_col = d.quote_identifier(&col.name);
              let col_type = d.map_column_type(col);
              let mut stmts = vec![format!(
                  "ALTER TABLE {} ALTER COLUMN {} TYPE {};",
                  q_table, q_col, col_type
              )];
              if col.nullable {
                  stmts.push(format!(
                      "ALTER TABLE {} ALTER COLUMN {} DROP NOT NULL;",
                      q_table, q_col
                  ));
              } else {
                  stmts.push(format!(
                      "ALTER TABLE {} ALTER COLUMN {} SET NOT NULL;",
                      q_table, q_col
                  ));
              }
              stmts
          }
          "sqlserver" | "mssql" => {
              vec![format!("ALTER TABLE {} ALTER COLUMN {};", q_table, col_def)]
          }
          _ => {
              // MySQL, Oracle, SQLite
              vec![format!("ALTER TABLE {} MODIFY COLUMN {};", q_table, col_def)]
          }
      })
  }
  ```

- [ ] **Step 2：运行 cargo check 确认编译通过**

  ```bash
  cd /home/wushengzhou/workspace/github/open-db-studio/src-tauri && cargo check 2>&1 | tail -5
  ```

  预期：`Finished` 或仅有 warning，无 error。

---

## Task 2：重写 er_generate_sync_ddl

**文件：** Modify `src-tauri/src/er/commands.rs`（第 471-533 行）

- [ ] **Step 1：将第 472-533 行的 `er_generate_sync_ddl` 函数替换为以下完整实现**

  ```rust
  #[tauri::command]
  pub async fn er_generate_sync_ddl(
      project_id: i64,
      changes: serde_json::Value,
  ) -> AppResult<Vec<String>> {
      let full = crate::er::repository::get_project_full(project_id)?;

      // Determine SQL dialect from the project's bound connection.
      // Fall back to "mysql" if no connection is bound or driver is unknown.
      let dialect = if let Some(conn_id) = full.project.connection_id {
          crate::db::get_connection_by_id(conn_id)?
              .map(|c| c.driver.to_lowercase())
              .unwrap_or_else(|| "mysql".to_string())
      } else {
          "mysql".to_string()
      };

      // Build lookup maps: lowercase table_name → ErTableFull
      let tables_map: HashMap<String, &crate::er::models::ErTableFull> = full
          .tables
          .iter()
          .map(|tf| (tf.table.name.to_lowercase(), tf))
          .collect();

      let columns_map: HashMap<i64, Vec<crate::er::models::ErColumn>> = full
          .tables
          .iter()
          .map(|tf| (tf.table.id, tf.columns.clone()))
          .collect();

      let indexes_map: HashMap<i64, Vec<crate::er::models::ErIndex>> = full
          .tables
          .iter()
          .map(|tf| (tf.table.id, tf.indexes.clone()))
          .collect();

      let mut statements: Vec<String> = Vec::new();

      // ── 1. Added tables → full CREATE TABLE DDL ──────────────────────────
      if let Some(added_tables) = changes.get("added_tables").and_then(|v| v.as_array()) {
          for table_val in added_tables {
              if let Some(table_name) = table_val.get("table_name").and_then(|v| v.as_str()) {
                  if let Some(tf) = tables_map.get(&table_name.to_lowercase()) {
                      let options = crate::er::ddl_generator::GenerateOptions::default();
                      let ddl = crate::er::ddl_generator::generate_ddl(
                          std::slice::from_ref(&tf.table),
                          &columns_map,
                          &indexes_map,
                          &full.relations,
                          &dialect,
                          &options,
                          &full.project,
                      )?;
                      statements.push(ddl);
                  }
              }
          }
      }

      // ── 2. Modified tables ───────────────────────────────────────────────
      if let Some(modified_tables) = changes.get("modified_tables").and_then(|v| v.as_array()) {
          for table_val in modified_tables {
              let table_name = table_val
                  .get("table_name")
                  .and_then(|v| v.as_str())
                  .unwrap_or("unknown");
              let tf_opt = tables_map.get(&table_name.to_lowercase());
              let q_table = crate::er::ddl_generator::quote_identifier(table_name, &dialect);

              // 2a. Added columns
              if let Some(added_cols) =
                  table_val.get("added_columns").and_then(|v| v.as_array())
              {
                  for col_val in added_cols {
                      let col_name =
                          col_val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                      if let Some(tf) = tf_opt {
                          if let Some(er_col) = tf
                              .columns
                              .iter()
                              .find(|c| c.name.to_lowercase() == col_name.to_lowercase())
                          {
                              let col_def = crate::er::ddl_generator::format_column_for_alter(
                                  er_col, &dialect,
                              )?;
                              statements.push(format!(
                                  "ALTER TABLE {} ADD COLUMN {};",
                                  q_table, col_def
                              ));
                          }
                      }
                  }
              }

              // 2b. Removed columns
              if let Some(removed_cols) =
                  table_val.get("removed_columns").and_then(|v| v.as_array())
              {
                  for col_val in removed_cols {
                      let col_name =
                          col_val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                      let q_col =
                          crate::er::ddl_generator::quote_identifier(col_name, &dialect);
                      statements.push(format!(
                          "ALTER TABLE {} DROP COLUMN {};",
                          q_table, q_col
                      ));
                  }
              }

              // 2c. Modified columns (type or nullability change)
              if let Some(modified_cols) =
                  table_val.get("modified_columns").and_then(|v| v.as_array())
              {
                  for col_val in modified_cols {
                      let col_name =
                          col_val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                      if let Some(tf) = tf_opt {
                          if let Some(er_col) = tf
                              .columns
                              .iter()
                              .find(|c| c.name.to_lowercase() == col_name.to_lowercase())
                          {
                              let stmts =
                                  crate::er::ddl_generator::generate_modify_column_ddl(
                                      er_col, table_name, &dialect,
                                  )?;
                              statements.extend(stmts);
                          }
                      }
                  }
              }

              // 2d. Added indexes
              if let Some(added_idxs) =
                  table_val.get("added_indexes").and_then(|v| v.as_array())
              {
                  for idx_val in added_idxs {
                      let idx_name =
                          idx_val.get("name").and_then(|v| v.as_str()).unwrap_or("idx");
                      let idx_type = idx_val
                          .get("index_type")
                          .and_then(|v| v.as_str())
                          .unwrap_or("INDEX");
                      let cols: Vec<String> = idx_val
                          .get("columns")
                          .and_then(|v| v.as_array())
                          .map(|arr| {
                              arr.iter()
                                  .filter_map(|c| c.as_str())
                                  .map(|s| {
                                      crate::er::ddl_generator::quote_identifier(s, &dialect)
                                  })
                                  .collect()
                          })
                          .unwrap_or_default();
                      let unique_kw =
                          if idx_type.to_uppercase() == "UNIQUE" { "UNIQUE " } else { "" };
                      let q_idx =
                          crate::er::ddl_generator::quote_identifier(idx_name, &dialect);
                      statements.push(format!(
                          "CREATE {}INDEX {} ON {} ({});",
                          unique_kw,
                          q_idx,
                          q_table,
                          cols.join(", ")
                      ));
                  }
              }

              // 2e. Removed indexes
              if let Some(removed_idxs) =
                  table_val.get("removed_indexes").and_then(|v| v.as_array())
              {
                  for idx_val in removed_idxs {
                      let idx_name =
                          idx_val.get("name").and_then(|v| v.as_str()).unwrap_or("idx");
                      let q_idx =
                          crate::er::ddl_generator::quote_identifier(idx_name, &dialect);
                      let stmt = match dialect.to_lowercase().as_str() {
                          "mysql" => format!("DROP INDEX {} ON {};", q_idx, q_table),
                          _ => format!("DROP INDEX IF EXISTS {};", q_idx),
                      };
                      statements.push(stmt);
                  }
              }
          }
      }

      Ok(statements)
  }
  ```

- [ ] **Step 2：运行 cargo check**

  ```bash
  cd /home/wushengzhou/workspace/github/open-db-studio/src-tauri && cargo check 2>&1 | tail -5
  ```

  预期：无 error。

- [ ] **Step 3：commit**

  ```bash
  cd /home/wushengzhou/workspace/github/open-db-studio
  git add src-tauri/src/er/ddl_generator.rs src-tauri/src/er/commands.rs
  git commit -m "feat(er-designer): implement er_generate_sync_ddl with full DDL generation

  - Add format_column_for_alter, generate_modify_column_ddl, quote_identifier helpers
  - Replace placeholder with real CREATE TABLE, ALTER TABLE ADD/DROP/MODIFY COLUMN,
    CREATE/DROP INDEX generation using existing ddl_generator infrastructure
  - Dialect is inferred from the project's bound connection driver

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 3：在 erDesignerStore.ts 中添加 generateSyncDdl

**文件：** Modify `src/store/erDesignerStore.ts`

- [ ] **Step 1：在 interface ErDesignerState 中添加方法声明**

  在 `syncFromDatabase` 声明的下一行（第 102 行之后）插入：

  ```typescript
    generateSyncDdl: (projectId: number, changes: DiffResult) => Promise<string[]>;
  ```

- [ ] **Step 2：在实现区（第 728-735 行 syncFromDatabase 实现之后）添加实现**

  ```typescript
    generateSyncDdl: async (projectId, changes) => {
      try {
        return await invoke<string[]>('er_generate_sync_ddl', { projectId, changes });
      } catch (e) {
        console.error('Failed to generate sync DDL:', e);
        throw e;
      }
    },
  ```

- [ ] **Step 3：TypeScript 类型检查**

  ```bash
  cd /home/wushengzhou/workspace/github/open-db-studio && npx tsc --noEmit 2>&1 | head -20
  ```

  预期：无新增错误。

---

## Task 4：修改 DiffReportDialog.tsx

**文件：** Modify `src/components/ERDesigner/dialogs/DiffReportDialog.tsx`

- [ ] **Step 1：修改 `DiffReportDialogProps` 中 `onSyncToDb` 的类型**

  将第 13 行：
  ```typescript
    onSyncToDb: (selectedChanges: SelectedChange[]) => void;
  ```
  改为：
  ```typescript
    onSyncToDb: (diff: DiffResult) => void;
  ```

- [ ] **Step 2：替换 `handleSyncToDb` 函数（第 218-221 行）**

  将：
  ```typescript
    const handleSyncToDb = () => {
      onSyncToDb(toDb);
      onClose();
    };
  ```
  替换为：
  ```typescript
    const handleSyncToDb = () => {
      if (!diffResult) return;
      const payload: DiffResult = {
        added_tables: diffResult.added_tables.filter((t) =>
          selectedChanges.has(`added_table:${t.table_name}`)
        ),
        removed_tables: [],
        modified_tables: diffResult.modified_tables
          .map((t) => ({
            ...t,
            added_columns: t.added_columns.filter((c) =>
              selectedChanges.has(`added_column:${t.table_name}:${c.name}`)
            ),
            removed_columns: t.removed_columns.filter((c) =>
              selectedChanges.has(`removed_column:${t.table_name}:${c.name}`)
            ),
            modified_columns: t.modified_columns.filter((c) =>
              selectedChanges.has(`modified_column:${t.table_name}:${c.name}`)
            ),
            added_indexes: t.added_indexes.filter((i) =>
              selectedChanges.has(`added_index:${t.table_name}:${i.name}`)
            ),
            removed_indexes: t.removed_indexes.filter((i) =>
              selectedChanges.has(`removed_index:${t.table_name}:${i.name}`)
            ),
          }))
          .filter(
            (t) =>
              t.added_columns.length > 0 ||
              t.removed_columns.length > 0 ||
              t.modified_columns.length > 0 ||
              t.added_indexes.length > 0 ||
              t.removed_indexes.length > 0
          ),
      };
      onSyncToDb(payload);
      onClose();
    };
  ```

- [ ] **Step 3：TypeScript 类型检查**

  ```bash
  cd /home/wushengzhou/workspace/github/open-db-studio && npx tsc --noEmit 2>&1 | head -20
  ```

  预期：无新增错误。（注意：ERCanvas 中的 onSyncToDb 回调类型不匹配会在 Task 6 修复，此时可能有临时错误，属正常现象。）

---

## Task 5：修改 DDLPreviewDialog.tsx

**文件：** Modify `src/components/ERDesigner/dialogs/DDLPreviewDialog.tsx`

- [ ] **Step 1：在 `DDLPreviewDialogProps` 接口中添加 `preloadedDdl` 属性（第 12 行后）**

  ```typescript
    preloadedDdl?: string;
  ```

- [ ] **Step 2：在组件函数参数解构中加入 `preloadedDdl`**

  将第 26-32 行的参数解构：
  ```typescript
  export const DDLPreviewDialog: React.FC<DDLPreviewDialogProps> = ({
    visible,
    projectId,
    hasConnection,
    onClose,
    onExecute,
  }) => {
  ```
  改为：
  ```typescript
  export const DDLPreviewDialog: React.FC<DDLPreviewDialogProps> = ({
    visible,
    projectId,
    hasConnection,
    onClose,
    onExecute,
    preloadedDdl,
  }) => {
  ```

- [ ] **Step 3：修改 `useEffect`（第 45-65 行），当有 `preloadedDdl` 时跳过生成**

  将：
  ```typescript
    useEffect(() => {
      if (visible && projectId) {
        setLoading(true);
        generateDDL(projectId, dialect, {
          includeIndexes,
          includeComments,
          includeForeignKeys,
          includeCommentRefs,
        })
          .then((result) => {
            setDdl(result);
          })
          .catch((err) => {
            console.error('Failed to generate DDL:', err);
            setDdl('-- ' + t('erDesigner.generateDdlFailed') + '\n' + String(err));
          })
          .finally(() => {
            setLoading(false);
          });
      }
    }, [visible, projectId, dialect, includeIndexes, includeComments, includeForeignKeys, includeCommentRefs, generateDDL]);
  ```
  替换为：
  ```typescript
    useEffect(() => {
      if (!visible || !projectId) return;

      if (preloadedDdl !== undefined) {
        setDdl(preloadedDdl);
        return;
      }

      setLoading(true);
      generateDDL(projectId, dialect, {
        includeIndexes,
        includeComments,
        includeForeignKeys,
        includeCommentRefs,
      })
        .then((result) => {
          setDdl(result);
        })
        .catch((err) => {
          console.error('Failed to generate DDL:', err);
          setDdl('-- ' + t('erDesigner.generateDdlFailed') + '\n' + String(err));
        })
        .finally(() => {
          setLoading(false);
        });
    }, [visible, projectId, dialect, includeIndexes, includeComments, includeForeignKeys, includeCommentRefs, generateDDL, preloadedDdl]);
  ```

- [ ] **Step 4：在 `BaseModal` 中，当有 `preloadedDdl` 时隐藏方言/选项控件，并更改标题**

  将 `<BaseModal` 的 `title` 属性（第 86 行）改为：
  ```tsx
      title={preloadedDdl !== undefined ? t('erDesigner.syncDdlPreview') : t('erDesigner.generateDdl')}
  ```

  在 `<div className="flex flex-col gap-4">` 内部，将方言选择 div 和选项开关 div 用 `{preloadedDdl === undefined && (...)}` 包裹，条件渲染：

  将：
  ```tsx
        {/* 方言选择 */}
        <div className="flex items-center gap-4">
          ...
        </div>

        {/* 选项开关 */}
        <div className="flex items-center gap-6">
          ...
        </div>
  ```
  改为：
  ```tsx
        {/* 方言选择和选项（仅在正常生成模式下显示） */}
        {preloadedDdl === undefined && (
          <>
            <div className="flex items-center gap-4">
              <span className="text-xs text-foreground-default">{t('erDesigner.dialect')}:</span>
              <DropdownSelect
                value={dialect}
                options={DIALECT_OPTIONS}
                onChange={(val) => setDialect(val as SqlDialect)}
                className="w-32"
              />
            </div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeIndexes}
                  onChange={(e) => setIncludeIndexes(e.target.checked)}
                  className="accent-accent w-4 h-4"
                />
                <span className="text-xs text-foreground-default">{t('erDesigner.includeIndexes')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeComments}
                  onChange={(e) => setIncludeComments(e.target.checked)}
                  className="accent-accent w-4 h-4"
                />
                <span className="text-xs text-foreground-default">{t('erDesigner.includeComments')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeForeignKeys}
                  onChange={(e) => setIncludeForeignKeys(e.target.checked)}
                  className="accent-accent w-4 h-4"
                />
                <span className="text-xs text-foreground-default">{t('erDesigner.includeForeignKeys')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeCommentRefs}
                  onChange={e => setIncludeCommentRefs(e.target.checked)}
                  className="accent-accent w-4 h-4"
                />
                <span className="text-[12px] text-foreground-default">在列注释中生成引用标记 💬</span>
              </label>
            </div>
          </>
        )}
  ```

- [ ] **Step 5：TypeScript 类型检查**

  ```bash
  cd /home/wushengzhou/workspace/github/open-db-studio && npx tsc --noEmit 2>&1 | head -20
  ```

---

## Task 6：更新 ERCanvas/index.tsx

**文件：** Modify `src/components/ERDesigner/ERCanvas/index.tsx`

- [ ] **Step 1：在 store 引用区（第 106 行附近）添加 `generateSyncDdl` 引用**

  在 `const syncFromDatabase = useErDesignerStore(s => s.syncFromDatabase)` 后添加：

  ```typescript
  const generateSyncDdl = useErDesignerStore(s => s.generateSyncDdl)
  ```

- [ ] **Step 2：在 state 声明区（第 82-87 行附近）添加 `syncStatements` state**

  在 `const [showSettings, setShowSettings] = useState(false)` 后添加：

  ```typescript
  const [syncStatements, setSyncStatements] = useState<string[] | null>(null)
  ```

- [ ] **Step 3：替换 DDLPreviewDialog 挂载代码（第 525-543 行）**

  将：
  ```tsx
        <DDLPreviewDialog
          visible={showDDL}
          projectId={projectId}
          hasConnection={hasConnection}
          onClose={() => setShowDDL(false)}
          onExecute={async (ddl) => {
            if (!activeProject?.connection_id) return
            try {
              await invoke('execute_query', {
                connectionId: activeProject.connection_id,
                sql: ddl,
                database: activeProject.database_name ?? null,
                schema: activeProject.schema_name ?? null,
              })
            } catch (e) {
              console.error('Failed to execute DDL:', e)
            }
          }}
        />
  ```
  替换为：
  ```tsx
        <DDLPreviewDialog
          visible={showDDL}
          projectId={projectId}
          hasConnection={hasConnection}
          preloadedDdl={syncStatements ? syncStatements.join('\n\n') : undefined}
          onClose={() => { setShowDDL(false); setSyncStatements(null) }}
          onExecute={async (ddl) => {
            if (syncStatements) {
              // Sync mode: execute via er_execute_sync_ddl for per-statement results
              try {
                await invoke('er_execute_sync_ddl', {
                  projectId,
                  ddlStatements: syncStatements,
                })
              } catch (e) {
                console.error('Failed to execute sync DDL:', e)
              } finally {
                setSyncStatements(null)
              }
            } else {
              // Normal generate-DDL mode: execute as single query
              if (!activeProject?.connection_id) return
              try {
                await invoke('execute_query', {
                  connectionId: activeProject.connection_id,
                  sql: ddl,
                  database: activeProject.database_name ?? null,
                  schema: activeProject.schema_name ?? null,
                })
              } catch (e) {
                console.error('Failed to execute DDL:', e)
              }
            }
          }}
        />
  ```

- [ ] **Step 4：替换 DiffReportDialog 的 `onSyncToDb` 回调（第 544-558 行）**

  将：
  ```tsx
        <DiffReportDialog
          visible={showDiff}
          projectId={projectId}
          connectionInfo={connectionInfo}
          onClose={() => setShowDiff(false)}
          onSyncToDb={(_changes) => {
            // ER→DB DDL 执行尚未完整实现（Rust 侧 CREATE TABLE DDL 生成仍是 placeholder）
            alert('ER → 数据库同步功能尚未实现，敬请期待。')
          }}
          onSyncFromDb={(changes) => {
            // 只同步用户勾选的表，避免全量覆盖
            const tableNames = [...new Set(changes.map(c => c.table))]
            syncFromDatabase(projectId, tableNames.length > 0 ? tableNames : undefined).then(reloadCanvas)
          }}
        />
  ```
  替换为：
  ```tsx
        <DiffReportDialog
          visible={showDiff}
          projectId={projectId}
          connectionInfo={connectionInfo}
          onClose={() => setShowDiff(false)}
          onSyncToDb={async (filteredDiff) => {
            try {
              const statements = await generateSyncDdl(projectId, filteredDiff)
              setSyncStatements(statements)
              setShowDiff(false)
              setShowDDL(true)
            } catch (e) {
              console.error('Failed to generate sync DDL:', e)
            }
          }}
          onSyncFromDb={(changes) => {
            // 只同步用户勾选的表，避免全量覆盖
            const tableNames = [...new Set(changes.map(c => c.table))]
            syncFromDatabase(projectId, tableNames.length > 0 ? tableNames : undefined).then(reloadCanvas)
          }}
        />
  ```

- [ ] **Step 5：TypeScript 类型检查**

  ```bash
  cd /home/wushengzhou/workspace/github/open-db-studio && npx tsc --noEmit 2>&1 | head -20
  ```

  预期：0 errors。

---

## Task 7：添加 i18n 键

**文件：** `src/i18n/locales/zh.json`，`src/i18n/locales/en.json`

- [ ] **Step 1：在 `zh.json` 的 `erDesigner` 对象中添加（在 `syncToDb` 键附近）**

  ```json
  "syncDdlPreview": "同步 DDL 预览",
  ```

- [ ] **Step 2：在 `en.json` 的 `erDesigner` 对象中添加**

  ```json
  "syncDdlPreview": "Sync DDL Preview",
  ```

---

## Task 8：全量验证

- [ ] **Step 1：TypeScript 全量检查**

  ```bash
  cd /home/wushengzhou/workspace/github/open-db-studio && npx tsc --noEmit 2>&1
  ```

  预期：0 errors。

- [ ] **Step 2：Rust 编译检查**

  ```bash
  cd /home/wushengzhou/workspace/github/open-db-studio/src-tauri && cargo check 2>&1 | tail -5
  ```

  预期：无 error。

- [ ] **Step 3：提交前端改动**

  ```bash
  cd /home/wushengzhou/workspace/github/open-db-studio
  git add src/store/erDesignerStore.ts \
          src/components/ERDesigner/dialogs/DiffReportDialog.tsx \
          src/components/ERDesigner/dialogs/DDLPreviewDialog.tsx \
          src/components/ERDesigner/ERCanvas/index.tsx \
          src/i18n/locales/zh.json \
          src/i18n/locales/en.json
  git commit -m "feat(er-designer): implement ER→DB sync flow with DDL preview

  - DiffReportDialog.onSyncToDb now passes filtered DiffResult instead of SelectedChange[]
  - DDLPreviewDialog accepts preloadedDdl prop for sync mode (hides dialect/options controls)
  - ERCanvas replaces alert() with generateSyncDdl → DDLPreviewDialog → er_execute_sync_ddl flow
  - Add i18n keys syncDdlPreview (zh/en)

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

- [ ] **Step 4：手动验证流程**

  1. 启动应用：`npm run tauri:dev`
  2. 打开一个绑定了 MySQL/PostgreSQL 连接的 ER 项目
  3. 在 ER 图中新增一张表（含列和索引），但不在数据库中创建它
  4. 点击工具栏"同步"按钮 → DiffReportDialog 弹出，新增表出现在"新增"区域
  5. 勾选该表，点击"ER→数据库"
  6. **预期**：DiffReportDialog 关闭，DDLPreviewDialog 弹出，标题为"同步 DDL 预览"，显示正确方言的 CREATE TABLE 语句，无方言选择器
  7. 点击"Execute"，**预期**：DDL 在数据库中执行成功
  8. 再次点击"同步"，**预期**：差异消失，显示"没有检测到差异"
  9. 验证"生成 DDL"按钮（工具栏另一个按钮）仍然正常显示方言选择器

---

## 潜在注意点

- `er_generate_sync_ddl` 中如果 ER 模型中找不到对应表/列（tables_map miss），该变更会被**静默跳过**。这是合理的防御行为，因为用户可能传入了与 ER 模型不一致的数据。
- PostgreSQL 的 MODIFY COLUMN 生成两条语句（TYPE + NOT NULL），执行时需要数据库支持类型转换（`USING` 子句），如有需要未来可扩展。
- SQLite 不支持 DROP COLUMN（3.35.0 以下），当前实现直接生成 DROP COLUMN，如遇报错属 SQLite 版本限制。
