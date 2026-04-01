<!-- STATUS: ✅ 已实现 -->
# 导入导出 + 任务中心 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现完整的数据库导入导出功能和统一任务中心，包括多表选择导出、CSV/JSON/Excel 导入、新建数据库，以及任务进度追踪 UI。

**Architecture:** P1 基础设施（TaskCenter + Store）已完成骨架，需修复注册遗漏和 bug；P2 实现多表流式导出 ExportWizard；P3 实现带字段映射的 ImportWizard；P4+P5 实现 CreateDatabaseDialog 和工具栏入口。

**Tech Stack:** React 18 + TypeScript + Zustand + Tauri 2.x Rust + rusqlite + tokio + tauri::AppHandle.emit()

---

## 当前状态（实现前）

已完成（partial P1）：
- `schema/init.sql` — task_records 表 ✅
- `db/models.rs` — TaskRecord, CreateTaskInput, UpdateTaskInput ✅
- `db/mod.rs` — list_tasks, create_task, update_task, delete_task, get_task_by_id ✅
- `commands.rs` — get_task_list, create_task, update_task, delete_task, get_task_by_id ✅（**未注册**）
- `store/taskStore.ts` — Zustand store ✅（有 type mismatch bug）
- `components/TaskCenter/index.tsx` + `TaskItem.tsx` ✅

已知 Bug：
1. `lib.rs` 未注册 5 个 task 命令 → 前端调用报错
2. `taskStore.addTask` 调用 `invoke<string>('create_task', ...)` 但命令返回 `TaskRecord`
3. `cancel_task` / `retry_task` 命令在前端被调用但 Rust 未实现

---

## 文件结构映射

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-tauri/src/lib.rs` | 修改 | 注册所有 task 相关命令 |
| `src-tauri/src/commands.rs` | 修改 | 补充 cancel_task, retry_task, export_tables, import_to_table, create_database, drop_database |
| `src/store/taskStore.ts` | 修改 | 修复 create_task 返回类型 mismatch |
| `src/App.tsx` | 修改 | 集成 TaskCenter 弹窗触发按钮（只添加 TaskCenter，不管理 ExportWizard/Import 弹窗） |
| `src/components/Explorer/ContextMenu.tsx` | 修改 | 添加"导出数据"/"导入数据"/"新建数据库"菜单项 |
| `src/components/Explorer/DBTree.tsx` | 修改 | 内部管理 ExportWizard/ImportWizard/CreateDatabaseDialog 弹窗状态（遵循现有自管弹窗模式） |
| `src/components/ImportExport/TableSelector.tsx` | 新建 | 多表选择组件（带搜索/全选/反选） |
| `src/components/ImportExport/ExportWizard.tsx` | 新建 | 3步导出向导 |
| `src/components/ImportExport/FieldMapper.tsx` | 新建 | CSV→表字段映射组件 |
| `src/components/ImportExport/ImportWizard.tsx` | 新建 | 3步导入向导 |
| `src/components/DatabaseManager/CreateDatabaseDialog.tsx` | 新建 | 新建数据库弹窗 |

---

## Chunk 1: P1 完善 — 修复 Bug + 注册命令 + 接入 App

### Task 1: 修复 create_task 返回类型 + 注册命令

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/store/taskStore.ts`

- [ ] **Step 1: 在 lib.rs 注册缺失的 task 命令**

在 `lib.rs` 的 `invoke_handler` 中，`cancel_acp_session` 之后添加：

```rust
            commands::get_task_list,
            commands::create_task,
            commands::update_task,
            commands::delete_task,
            commands::get_task_by_id,
```

- [ ] **Step 2: 修复 taskStore.addTask 的返回类型**

`src/store/taskStore.ts` 第 76 行，`create_task` 返回 `TaskRecord`，不是 `string`。修改：

```typescript
// 修改前
const id = await invoke<string>('create_task', { ... });

// 修改后
const record = await invoke<{ id: string }>('create_task', { ... });
const id = record.id;
```

- [ ] **Step 3: 验证 Rust 编译**

```bash
cd src-tauri && cargo check
```
Expected: 无编译错误

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src/store/taskStore.ts
git commit -m "fix(tasks): register task commands in lib.rs and fix create_task return type"
```

---

### Task 2: 实现 cancel_task 和 retry_task Rust 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

背景：cancel_task 需要一个全局的 CancellationToken 注册表；retry_task 需要重新执行任务。MVP 阶段简化：
- `cancel_task` 只标记状态为 cancelled（不中断正在运行的流）
- `retry_task` 返回 `AppError::Other("retry not yet implemented")` 并更新状态

- [ ] **Step 1: 在 commands.rs 末尾添加命令**

```rust
// ============ 任务取消与重试 ============

#[tauri::command]
pub async fn cancel_task(task_id: String) -> AppResult<()> {
    crate::db::update_task(&task_id, &crate::db::models::UpdateTaskInput {
        status: Some("cancelled".to_string()),
        completed_at: Some(chrono::Utc::now().to_rfc3339()),
        ..Default::default()
    })
}

#[tauri::command]
pub async fn retry_task(task_id: String) -> AppResult<()> {
    // MVP: 仅重置状态，实际重新执行留待 P6
    // error: Some("".to_string()) 将 error 字段更新为空字符串 —— update_task
    // 的 SQL 逻辑对 Some(v) 一律 SET error = v，所以空字符串会写入 DB。
    // 前端 `task.error && ...` 判断中，空字符串为 falsy，等同于无错误，行为正确。
    crate::db::update_task(&task_id, &crate::db::models::UpdateTaskInput {
        status: Some("pending".to_string()),
        progress: Some(0),
        error: Some("".to_string()),  // 清空错误文字
        completed_at: None,
        ..Default::default()
    })
}

- [ ] **Step 2: 注册命令**

在 lib.rs 已注册的 task 命令块添加：
```rust
            commands::cancel_task,
            commands::retry_task,
```

- [ ] **Step 3: cargo check**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tasks): implement cancel_task and retry_task commands (MVP: status-only)"
```

---

### Task 3: 将 TaskCenter 集成到 App.tsx + 初始化进度监听

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: 在 App.tsx 添加 TaskCenter 导入和状态**

```typescript
import { TaskCenter } from './components/TaskCenter';
import { initTaskProgressListener, useTaskStore } from './store';
```

在 App 组件顶部添加：
```typescript
const { visible: taskCenterVisible, setVisible: setTaskCenterVisible } = useTaskStore();

useEffect(() => {
  initTaskProgressListener();
}, []);
```

- [ ] **Step 2: 在 JSX 中渲染 TaskCenter（条件显示）**

在 App 的 return 最外层 div 末尾添加：
```tsx
{taskCenterVisible && (
  <TaskCenter onClose={() => setTaskCenterVisible(false)} />
)}
```

- [ ] **Step 3: 在工具栏/顶部添加任务中心入口按钮**

**先确认工具栏位置：** `App.tsx` 中 `isExportMenuOpen` 状态与按钮在同一文件。搜索 `isExportMenuOpen` 在 JSX 中的使用处（通常是 `<button onClick={() => setIsExportMenuOpen(...)}>`），找到工具栏按钮区，在相邻位置添加：

```tsx
// App.tsx 文件顶部 lucide-react 导入行添加：
import { ListTodo } from 'lucide-react';

// 在工具栏按钮区（紧挨现有导出按钮）：
<button
  onClick={() => setTaskCenterVisible(true)}
  className="flex items-center gap-1 px-2 py-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1a2639] rounded transition-colors"
  title="任务中心"
>
  <ListTodo size={14} />
  <span>任务中心</span>
</button>
```

如果工具栏按钮实际上在 `MainContent` 子组件中而不在 `App.tsx` JSX 里：在 `App.tsx` 中向 `MainContent` 传入 `onOpenTaskCenter={() => setTaskCenterVisible(true)}` prop，在 `MainContent` 组件中接收并绑定到按钮的 `onClick`。

- [ ] **Step 4: npx tsc --noEmit 验证类型**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(tasks): wire TaskCenter into App.tsx with toolbar button"
```

---

## Chunk 2: P2 — ExportWizard（多表选择导出）

### Task 4: TableSelector 多表选择组件

**Files:**
- Create: `src/components/ImportExport/TableSelector.tsx`

- [ ] **Step 1: 创建 TableSelector 组件**

```typescript
// src/components/ImportExport/TableSelector.tsx
import React, { useState, useMemo } from 'react';
import { Search } from 'lucide-react';

export interface TableInfo {
  name: string;
  rowCount?: number;
  size?: string;
}

interface Props {
  tables: TableInfo[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

export const TableSelector: React.FC<Props> = ({ tables, selected, onChange }) => {
  const [search, setSearch] = useState('');

  const filtered = useMemo(
    () => tables.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())),
    [tables, search]
  );

  const toggleTable = (name: string) => {
    onChange(
      selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]
    );
  };

  const selectAll = () => onChange(filtered.map((t) => t.name));
  const invertSelection = () =>
    onChange(filtered.filter((t) => !selected.includes(t.name)).map((t) => t.name));

  return (
    <div className="flex flex-col h-full">
      {/* 搜索栏 + 全选按钮 */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 flex items-center gap-1.5 bg-[#1a2639] border border-[#253347] rounded px-2 py-1">
          <Search size={12} className="text-[#7a9bb8]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索表名..."
            className="flex-1 bg-transparent text-xs text-[#c8daea] placeholder-[#4a6a8a] outline-none"
          />
        </div>
        <button
          onClick={selectAll}
          className="px-2 py-1 text-xs text-[#7a9bb8] hover:text-[#3794ff] border border-[#253347] rounded transition-colors"
        >
          全选
        </button>
        <button
          onClick={invertSelection}
          className="px-2 py-1 text-xs text-[#7a9bb8] hover:text-[#3794ff] border border-[#253347] rounded transition-colors"
        >
          反选
        </button>
      </div>

      {/* 表头 */}
      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 px-2 py-1 text-[10px] text-[#4a6a8a] border-b border-[#1e2d42]">
        <div className="w-4" />
        <div>表名</div>
        <div className="text-right">行数(估算)</div>
        <div className="text-right">大小</div>
      </div>

      {/* 表列表 */}
      <div className="flex-1 overflow-y-auto">
        {filtered.map((t) => (
          <label
            key={t.name}
            className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 items-center px-2 py-1.5 text-xs cursor-pointer hover:bg-[#1a2639]/50"
          >
            <input
              type="checkbox"
              checked={selected.includes(t.name)}
              onChange={() => toggleTable(t.name)}
              className="accent-[#3794ff]"
            />
            <span className="text-[#c8daea] truncate">{t.name}</span>
            <span className="text-[#7a9bb8] text-right">
              {t.rowCount !== undefined ? t.rowCount.toLocaleString() : '-'}
            </span>
            <span className="text-[#7a9bb8] text-right">{t.size ?? '-'}</span>
          </label>
        ))}
      </div>

      <div className="text-xs text-[#7a9bb8] mt-2 pt-2 border-t border-[#1e2d42]">
        已选: {selected.length} / {tables.length} 个表
      </div>
    </div>
  );
};
```

- [ ] **Step 2: npx tsc --noEmit 验证**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/components/ImportExport/TableSelector.tsx
git commit -m "feat(export): add TableSelector multi-table selection component"
```

---

### Task 5: ExportWizard 3步向导组件

**Files:**
- Create: `src/components/ImportExport/ExportWizard.tsx`

- [ ] **Step 1: 创建 ExportWizard 组件**

```typescript
// src/components/ImportExport/ExportWizard.tsx
import React, { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, Download } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { TableSelector, TableInfo } from './TableSelector';
import { useTaskStore } from '../../store';

export type ExportScope = 'current_table' | 'multi_table' | 'database';
export type ExportFormat = 'csv' | 'json' | 'sql';

interface ExportWizardProps {
  /** 右键触发时的初始表名（可选） */
  defaultTable?: string;
  connectionId: number;
  database?: string;
  schema?: string;
  onClose: () => void;
}

interface Step1State {
  scope: ExportScope;
  connectionId: number;
  database: string;
  schema: string;
}

interface Step3Options {
  format: ExportFormat;
  includeHeader: boolean;
  includeDdl: boolean;
  whereClause: string;
  encoding: 'UTF-8' | 'GBK';
  delimiter: string;
}

export const ExportWizard: React.FC<ExportWizardProps> = ({
  defaultTable,
  connectionId,
  database = '',
  schema = '',
  onClose,
}) => {
  const { setVisible: setTaskCenterVisible } = useTaskStore();
  const [step, setStep] = useState(1);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>(
    defaultTable ? [defaultTable] : []
  );
  const [step1, setStep1] = useState<Step1State>({
    scope: defaultTable ? 'current_table' : 'multi_table',
    connectionId,
    database,
    schema,
  });
  const [options, setOptions] = useState<Step3Options>({
    format: 'csv',
    includeHeader: true,
    includeDdl: true,
    whereClause: '',
    encoding: 'UTF-8',
    delimiter: ',',
  });
  const [isLoading, setIsLoading] = useState(false);

  // Step 2: 加载表列表（multi_table 和 database scope 都要加载）
  useEffect(() => {
    if (step === 2 && step1.scope !== 'current_table') {
      setIsLoading(true);
      invoke<string[]>('list_objects', {
        connectionId: step1.connectionId,
        database: step1.database,
        schema: step1.schema || undefined,
        category: 'tables',
      })
        .then((names) => {
          const tableList = names.map((name) => ({ name }));
          setTables(tableList);
          // database scope: 自动全选所有表
          if (step1.scope === 'database') {
            setSelectedTables(names);
          }
        })
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }
  }, [step, step1]);

  // Step 2 加载所有表（database scope 时也需要显示表列表用于确认）
  const loadAllTables = step === 2;

  const handleStart = async () => {
    const outputDir = await openDialog({
      directory: true,
      title: '选择导出目录',
    });
    if (!outputDir) return;

    // database scope：导出所有已加载的表（selectedTables 在 step 2 已被全选）
    const tablesToExport =
      step1.scope === 'current_table' && defaultTable
        ? [defaultTable]
        : selectedTables; // multi_table 和 database scope 都用 selectedTables

    try {
      await invoke('export_tables', {
        params: {
          connection_id: step1.connectionId,
          database: step1.database || null,
          schema: step1.schema || null,
          tables: tablesToExport,
          format: options.format,
          output_dir: outputDir as string,
          options: {
            include_header: options.includeHeader,
            include_ddl: options.includeDdl,
            where_clause: options.whereClause || null,
            encoding: options.encoding,
            delimiter: options.delimiter,
          },
        },
      });
      setTaskCenterVisible(true);
      onClose();
    } catch (e) {
      console.error('Export failed:', e);
    }
  };

  const canGoNext = () => {
    if (step === 2) return selectedTables.length > 0;
    return true;
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#0d1520] border border-[#1e2d42] rounded-lg w-[560px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e2d42]">
          <h3 className="text-sm text-[#e8f4ff] font-medium">导出数据</h3>
          <div className="flex items-center gap-3">
            {/* Step indicator */}
            <div className="flex gap-1.5">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className={`w-2 h-2 rounded-full ${
                    n === step ? 'bg-[#3794ff]' : n < step ? 'bg-[#00c9a7]' : 'bg-[#253347]'
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-[#7a9bb8]">步骤 {step}/3</span>
            <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 min-h-[300px]">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-2">导出范围</label>
                {(['current_table', 'multi_table', 'database'] as ExportScope[]).map((scope) => (
                  <label key={scope} className="flex items-center gap-2 py-1 cursor-pointer">
                    <input
                      type="radio"
                      name="scope"
                      value={scope}
                      checked={step1.scope === scope}
                      onChange={() => setStep1((s) => ({ ...s, scope }))}
                      className="accent-[#3794ff]"
                      disabled={scope === 'current_table' && !defaultTable}
                    />
                    <span className={`text-sm ${scope === 'current_table' && !defaultTable ? 'text-[#4a6a8a]' : 'text-[#c8daea]'}`}>
                      {scope === 'current_table' ? `当前表${defaultTable ? `（${defaultTable}）` : ''}` :
                       scope === 'multi_table' ? '多表选择' : '整个数据库'}
                    </span>
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#7a9bb8] mb-1">数据库</label>
                  <input
                    value={step1.database}
                    onChange={(e) => setStep1((s) => ({ ...s, database: e.target.value }))}
                    className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                    placeholder="数据库名"
                  />
                </div>
                {schema !== undefined && (
                  <div>
                    <label className="block text-xs text-[#7a9bb8] mb-1">Schema</label>
                    <input
                      value={step1.schema}
                      onChange={(e) => setStep1((s) => ({ ...s, schema: e.target.value }))}
                      className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                      placeholder="schema 名（PG）"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="h-[300px] flex flex-col">
              {isLoading ? (
                <div className="flex-1 flex items-center justify-center text-[#7a9bb8] text-sm">
                  加载表列表...
                </div>
              ) : step1.scope === 'current_table' ? (
                <div className="text-sm text-[#c8daea] py-4">
                  将导出表：<span className="text-[#3794ff] font-medium">{defaultTable}</span>
                </div>
              ) : (
                <TableSelector
                  tables={tables}
                  selected={selectedTables}
                  onChange={setSelectedTables}
                />
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#7a9bb8] mb-1">格式</label>
                  <select
                    value={options.format}
                    onChange={(e) => setOptions((o) => ({ ...o, format: e.target.value as ExportFormat }))}
                    className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                  >
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                    <option value="sql">SQL</option>
                  </select>
                </div>
                {options.format === 'csv' && (
                  <div>
                    <label className="block text-xs text-[#7a9bb8] mb-1">编码</label>
                    <select
                      value={options.encoding}
                      onChange={(e) => setOptions((o) => ({ ...o, encoding: e.target.value as 'UTF-8' | 'GBK' }))}
                      className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                    >
                      <option value="UTF-8">UTF-8</option>
                      <option value="GBK">GBK</option>
                    </select>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={options.includeHeader}
                    onChange={(e) => setOptions((o) => ({ ...o, includeHeader: e.target.checked }))}
                    className="accent-[#3794ff]"
                  />
                  <span className="text-xs text-[#c8daea]">包含表头（CSV）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={options.includeDdl}
                    onChange={(e) => setOptions((o) => ({ ...o, includeDdl: e.target.checked }))}
                    className="accent-[#3794ff]"
                  />
                  <span className="text-xs text-[#c8daea]">包含 DDL（SQL 格式）</span>
                </label>
              </div>
              {selectedTables.length === 1 && (
                <div>
                  <label className="block text-xs text-[#7a9bb8] mb-1">
                    WHERE 条件（可选，单表时生效）
                  </label>
                  <input
                    value={options.whereClause}
                    onChange={(e) => setOptions((o) => ({ ...o, whereClause: e.target.value }))}
                    placeholder="例如: id > 100"
                    className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none font-mono"
                  />
                </div>
              )}
              <div className="p-3 bg-[#111922] rounded border border-[#1e2d42] text-xs text-[#7a9bb8]">
                <div>导出表数: {step1.scope === 'current_table' ? 1 : selectedTables.length}</div>
                <div>格式: {options.format.toUpperCase()}</div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[#1e2d42]">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea]">
            取消
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs text-[#7a9bb8] border border-[#253347] rounded hover:bg-[#1a2639] transition-colors"
              >
                <ChevronLeft size={12} /> 上一步
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canGoNext()}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#1a4a8a] text-[#3794ff] border border-[#3794ff]/50 rounded hover:bg-[#1e5a9a] transition-colors disabled:opacity-40"
              >
                下一步 <ChevronRight size={12} />
              </button>
            ) : (
              <button
                onClick={handleStart}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#1a4a8a] text-[#3794ff] border border-[#3794ff]/50 rounded hover:bg-[#1e5a9a] transition-colors"
              >
                <Download size={12} /> 开始导出
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: npx tsc --noEmit 验证**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/components/ImportExport/ExportWizard.tsx
git commit -m "feat(export): add 3-step ExportWizard component with multi-table selection"
```

---

### Task 6: Rust export_tables 流式导出命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

关键设计决策：使用 `tauri::AppHandle` 发送 `task-progress` 事件（匹配前端 `listen('task-progress', ...)`），而不是 Channel，避免前端每次调用都要管理 Channel。

- [ ] **Step 1: 在 commands.rs 中添加 ExportTableParams 结构体和 export_tables 命令**

在现有 `ExportParams` 结构体之后添加：

```rust
// ============ 多表导出（流式进度） ============

#[derive(Debug, Serialize, Deserialize)]
pub struct MultiExportOptions {
    pub include_header: bool,
    pub include_ddl: bool,
    pub where_clause: Option<String>,
    pub encoding: String,
    pub delimiter: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MultiExportParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub tables: Vec<String>,
    pub format: String,
    pub output_dir: String,
    pub options: MultiExportOptions,
}

#[derive(Clone, Serialize)]
pub struct TaskProgressPayload {
    pub task_id: String,
    pub status: String,
    pub progress: u8,
    pub processed_rows: u64,
    pub total_rows: Option<u64>,
    pub current_target: String,
    pub error: Option<String>,
    pub output_path: Option<String>,
}

#[tauri::command]
pub async fn export_tables(
    params: MultiExportParams,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    use std::path::Path;

    // 1. 创建任务记录
    let title = if params.tables.len() == 1 {
        format!("导出 {} 表", params.tables[0])
    } else {
        format!("导出 {} 个表", params.tables.len())
    };

    let task = crate::db::create_task(&crate::db::models::CreateTaskInput {
        type_: "export".to_string(),
        status: "running".to_string(),
        title,
        params: Some(serde_json::to_string(&params).unwrap_or_default()),
        progress: Some(0),
        processed_rows: Some(0),
        total_rows: None,
        current_target: Some(params.tables.first().cloned().unwrap_or_default()),
        error: None,
        error_details: None,
        output_path: Some(params.output_dir.clone()),
    })?;

    let task_id = task.id.clone();
    let total = params.tables.len() as u64;

    // 2. 后台执行（不阻塞前端）
    let task_id_clone = task_id.clone();
    tokio::spawn(async move {
        let mut processed = 0u64;
        let mut all_ok = true;

        for (i, table_name) in params.tables.iter().enumerate() {
            // 发送进度事件
            let _ = app_handle.emit("task-progress", TaskProgressPayload {
                task_id: task_id_clone.clone(),
                status: "running".to_string(),
                progress: ((i as f64 / total as f64) * 100.0) as u8,
                processed_rows: processed,
                total_rows: Some(total),
                current_target: table_name.clone(),
                error: None,
                output_path: Some(params.output_dir.clone()),
            });

            // 构建单表导出参数（复用 export_table_data 逻辑）
            let output_file = Path::new(&params.output_dir)
                .join(format!("{}.{}", table_name, &params.format));

            let single_params = ExportParams {
                connection_id: params.connection_id,
                database: params.database.clone(),
                table: table_name.clone(),
                schema: params.schema.clone(),
                format: params.format.clone(),
                where_clause: if params.tables.len() == 1 {
                    params.options.where_clause.clone()
                } else {
                    None
                },
                output_path: output_file.to_string_lossy().to_string(),
            };

            if let Err(e) = export_table_data(single_params).await {
                all_ok = false;
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("failed".to_string()),
                    error: Some(e.to_string()),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone.clone(),
                    status: "failed".to_string(),
                    progress: ((i as f64 / total as f64) * 100.0) as u8,
                    processed_rows: processed,
                    total_rows: Some(total),
                    current_target: table_name.clone(),
                    error: Some(e.to_string()),
                    output_path: None,
                });
                return;
            }
            processed += 1;
        }

        if all_ok {
            let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                status: Some("completed".to_string()),
                progress: Some(100),
                processed_rows: Some(processed as i64),
                total_rows: Some(total as i64),
                output_path: Some(params.output_dir.clone()),
                completed_at: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            });
            let _ = app_handle.emit("task-progress", TaskProgressPayload {
                task_id: task_id_clone.clone(),
                status: "completed".to_string(),
                progress: 100,
                processed_rows: processed,
                total_rows: Some(total),
                current_target: String::new(),
                error: None,
                output_path: Some(params.output_dir),
            });
        }
    });

    Ok(task_id)
}
```

- [ ] **Step 2: 注册命令**

在 lib.rs 添加：
```rust
            commands::export_tables,
```

- [ ] **Step 3: cargo check**

```bash
cd src-tauri && cargo check
```

常见编译问题：
- `app_handle.emit()` 需要 `tauri::Manager` trait 在 scope 内。在 commands.rs 文件顶部确认有 `use tauri::Manager;`（若没有则添加）。
- `chrono::Utc::now()` 需要 `use chrono::Utc;` 或完整路径 `chrono::Utc::now()`。
- `delimiter` 字段：spec 定义为 `char`，但 JSON 序列化不直接支持 `char`。计划中使用 `String` 类型更好，MVP 阶段仅取 `delimiter.chars().next().unwrap_or(',')` 来得到分隔符字符。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(export): implement export_tables command with async progress events"
```

---

## Chunk 3: P3 — ImportWizard

### Task 7: FieldMapper 字段映射组件

**Files:**
- Create: `src/components/ImportExport/FieldMapper.tsx`

- [ ] **Step 1: 创建 FieldMapper 组件**

```typescript
// src/components/ImportExport/FieldMapper.tsx
import React from 'react';
import { ArrowRight } from 'lucide-react';

export interface ColumnMapping {
  sourceColumn: string;
  targetColumn: string | null;  // null 表示不映射
}

interface TargetColumn {
  name: string;
  type: string;
  isPk: boolean;
  nullable: boolean;
}

interface Props {
  sourceColumns: string[];
  targetColumns: TargetColumn[];
  mappings: ColumnMapping[];
  onChange: (mappings: ColumnMapping[]) => void;
}

export const FieldMapper: React.FC<Props> = ({
  sourceColumns,
  targetColumns,
  mappings,
  onChange,
}) => {
  const autoMatch = () => {
    const newMappings = sourceColumns.map((src) => ({
      sourceColumn: src,
      targetColumn:
        targetColumns.find(
          (t) => t.name.toLowerCase() === src.toLowerCase()
        )?.name ?? null,
    }));
    onChange(newMappings);
  };

  const clearAll = () => {
    onChange(sourceColumns.map((src) => ({ sourceColumn: src, targetColumn: null })));
  };

  const updateMapping = (sourceColumn: string, targetColumn: string | null) => {
    onChange(
      mappings.map((m) =>
        m.sourceColumn === sourceColumn ? { ...m, targetColumn } : m
      )
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={autoMatch}
          className="px-2 py-1 text-xs text-[#3794ff] border border-[#3794ff]/50 rounded hover:bg-[#1a4a8a] transition-colors"
        >
          自动匹配列名
        </button>
        <button
          onClick={clearAll}
          className="px-2 py-1 text-xs text-[#7a9bb8] border border-[#253347] rounded hover:bg-[#1a2639] transition-colors"
        >
          清空映射
        </button>
        <span className="text-xs text-[#7a9bb8] ml-auto">
          已映射: {mappings.filter((m) => m.targetColumn).length}/{sourceColumns.length}
        </span>
      </div>

      {/* Header */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 px-1 py-1 text-[10px] text-[#4a6a8a] border-b border-[#1e2d42]">
        <div>源文件列</div>
        <div className="w-6" />
        <div>目标表列</div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1 mt-1">
        {mappings.map((m) => (
          <div
            key={m.sourceColumn}
            className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center"
          >
            <div className="px-2 py-1 bg-[#1a2639] border border-[#253347] rounded text-xs text-[#c8daea] truncate">
              {m.sourceColumn}
            </div>
            <ArrowRight size={12} className="text-[#253347]" />
            <select
              value={m.targetColumn ?? ''}
              onChange={(e) => updateMapping(m.sourceColumn, e.target.value || null)}
              className="px-2 py-1 bg-[#1a2639] border border-[#253347] rounded text-xs text-[#c8daea] outline-none"
            >
              <option value="">（不映射）</option>
              {targetColumns.map((tc) => (
                <option key={tc.name} value={tc.name}>
                  {tc.name} ({tc.type}{tc.isPk ? ', PK' : ''})
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: npx tsc --noEmit 验证**

```bash
npx tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ImportExport/FieldMapper.tsx
git commit -m "feat(import): add FieldMapper column mapping component"
```

---

### Task 8: ImportWizard 3步向导组件

**Files:**
- Create: `src/components/ImportExport/ImportWizard.tsx`

- [ ] **Step 1: 创建 ImportWizard 组件**

```typescript
// src/components/ImportExport/ImportWizard.tsx
import React, { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, Upload } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FieldMapper, ColumnMapping } from './FieldMapper';
import { useTaskStore } from '../../store';

type FileType = 'csv' | 'json' | 'excel' | 'sql';
type ErrorStrategy = 'stop_on_error' | 'skip_and_continue';

interface ImportWizardProps {
  connectionId: number;
  database?: string;
  schema?: string;
  defaultTable?: string;
  onClose: () => void;
}

interface ColumnInfo {
  name: string;
  type: string;
  isPk: boolean;
  nullable: boolean;
}

export const ImportWizard: React.FC<ImportWizardProps> = ({
  connectionId,
  database = '',
  schema = '',
  defaultTable = '',
  onClose,
}) => {
  // 注意：不使用 useTranslation，所有字符串已硬编码中文（MVP 阶段）
  const { setVisible: setTaskCenterVisible } = useTaskStore();
  const [step, setStep] = useState(1);

  // Step 1 state
  const [fileType, setFileType] = useState<FileType>('csv');
  const [filePath, setFilePath] = useState('');
  const [preview, setPreview] = useState<string[]>([]);
  const [sourceColumns, setSourceColumns] = useState<string[]>([]);

  // Step 2 state
  const [targetTable, setTargetTable] = useState(defaultTable);
  const [targetColumns, setTargetColumns] = useState<ColumnInfo[]>([]);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [availableTables, setAvailableTables] = useState<string[]>([]);

  // Step 3 state
  const [errorStrategy, setErrorStrategy] = useState<ErrorStrategy>('skip_and_continue');

  const handleSelectFile = async () => {
    const selected = await openDialog({
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
        { name: 'SQL', extensions: ['sql'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (selected && typeof selected === 'string') {
      setFilePath(selected);
      // 请求后端解析文件预览
      try {
        const result = await invoke<{ columns: string[]; preview_rows: string[] }>(
          'preview_import_file',
          { filePath: selected, fileType }
        );
        setSourceColumns(result.columns);
        setPreview(result.preview_rows);
      } catch (e) {
        console.error('Preview failed:', e);
      }
    }
  };

  // 加载目标表列表
  useEffect(() => {
    if (step === 2) {
      invoke<string[]>('list_objects', {
        connectionId,
        database,
        schema: schema || undefined,
        category: 'tables',
      })
        .then(setAvailableTables)
        .catch(console.error);
    }
  }, [step, connectionId, database, schema]);

  // 当目标表变化时加载列信息
  useEffect(() => {
    if (targetTable && step === 2) {
      invoke<{ columns: ColumnInfo[] }>('get_table_columns_for_import', {
        connectionId,
        database: database || null,
        schema: schema || null,
        table: targetTable,
      })
        .then((info) => {
          setTargetColumns(info.columns);
          // 自动初始化映射
          setMappings(
            sourceColumns.map((src) => ({
              sourceColumn: src,
              targetColumn:
                info.columns.find(
                  (c) => c.name.toLowerCase() === src.toLowerCase()
                )?.name ?? null,
            }))
          );
        })
        .catch(console.error);
    }
  }, [targetTable, step, sourceColumns, connectionId, database, schema]);

  const handleStart = async () => {
    const fieldMapping: Record<string, string> = {};
    mappings.forEach((m) => {
      if (m.targetColumn) fieldMapping[m.sourceColumn] = m.targetColumn;
    });

    try {
      await invoke('import_to_table', {
        params: {
          connection_id: connectionId,
          database: database || null,
          schema: schema || null,
          table: targetTable,
          file_path: filePath,
          file_type: fileType,
          field_mapping: fieldMapping,
          error_strategy: errorStrategy === 'stop_on_error' ? 'StopOnError' : 'SkipAndContinue',
        },
      });
      setTaskCenterVisible(true);
      onClose();
    } catch (e) {
      console.error('Import failed:', e);
    }
  };

  const mappedCount = mappings.filter((m) => m.targetColumn).length;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#0d1520] border border-[#1e2d42] rounded-lg w-[600px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e2d42]">
          <h3 className="text-sm text-[#e8f4ff] font-medium">导入数据</h3>
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className={`w-2 h-2 rounded-full ${
                    n === step ? 'bg-[#3794ff]' : n < step ? 'bg-[#00c9a7]' : 'bg-[#253347]'
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-[#7a9bb8]">步骤 {step}/3</span>
            <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 min-h-[320px]">
          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-1">文件类型</label>
                <select
                  value={fileType}
                  onChange={(e) => setFileType(e.target.value as FileType)}
                  className="bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                >
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                  <option value="excel">Excel (.xlsx)</option>
                  <option value="sql">SQL Dump</option>
                </select>
              </div>
              <div
                onClick={handleSelectFile}
                className="border-2 border-dashed border-[#253347] rounded-lg p-6 flex flex-col items-center gap-2 cursor-pointer hover:border-[#3794ff]/50 transition-colors"
              >
                <Upload size={24} className="text-[#7a9bb8]" />
                <span className="text-sm text-[#c8daea]">
                  {filePath ? filePath.split(/[/\\]/).pop() : '点击选择文件'}
                </span>
                <span className="text-xs text-[#7a9bb8]">或拖放到此处</span>
              </div>
              {preview.length > 0 && (
                <div>
                  <div className="text-xs text-[#7a9bb8] mb-1">预览 (前5行):</div>
                  <div className="bg-[#0d1117] rounded p-2 font-mono text-xs text-[#00c9a7] max-h-28 overflow-y-auto">
                    {preview.map((line, i) => <div key={i}>{line}</div>)}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="h-[320px] flex flex-col space-y-3">
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-1">目标表</label>
                <select
                  value={targetTable}
                  onChange={(e) => setTargetTable(e.target.value)}
                  className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                >
                  <option value="">选择目标表...</option>
                  {availableTables.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              {targetTable && sourceColumns.length > 0 && (
                <div className="flex-1 overflow-hidden">
                  <FieldMapper
                    sourceColumns={sourceColumns}
                    targetColumns={targetColumns}
                    mappings={mappings}
                    onChange={setMappings}
                  />
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div className="p-3 bg-[#111922] rounded border border-[#1e2d42] text-xs space-y-1">
                <div className="text-[#7a9bb8]">导入摘要:</div>
                <div className="text-[#c8daea]">源文件: {filePath.split(/[/\\]/).pop()}</div>
                <div className="text-[#c8daea]">目标表: {targetTable}</div>
                <div className="text-[#c8daea]">映射字段: {mappedCount}/{sourceColumns.length}</div>
              </div>
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-2">错误处理:</label>
                {(['stop_on_error', 'skip_and_continue'] as ErrorStrategy[]).map((s) => (
                  <label key={s} className="flex items-center gap-2 py-1 cursor-pointer">
                    <input
                      type="radio"
                      name="errorStrategy"
                      value={s}
                      checked={errorStrategy === s}
                      onChange={() => setErrorStrategy(s)}
                      className="accent-[#3794ff]"
                    />
                    <span className="text-sm text-[#c8daea]">
                      {s === 'stop_on_error' ? '遇错停止' : '跳过错误行继续'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[#1e2d42]">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea]">
            取消
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs text-[#7a9bb8] border border-[#253347] rounded hover:bg-[#1a2639] transition-colors"
              >
                <ChevronLeft size={12} /> 上一步
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={
                  (step === 1 && !filePath) ||
                  (step === 2 && (!targetTable || mappedCount === 0))
                }
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#1a4a8a] text-[#3794ff] border border-[#3794ff]/50 rounded hover:bg-[#1e5a9a] transition-colors disabled:opacity-40"
              >
                下一步 <ChevronRight size={12} />
              </button>
            ) : (
              <button
                onClick={handleStart}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#3794ff] text-white rounded hover:bg-[#4aa4ff] transition-colors"
              >
                <Upload size={12} /> 开始导入
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: npx tsc --noEmit 验证**

```bash
npx tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ImportExport/ImportWizard.tsx
git commit -m "feat(import): add 3-step ImportWizard with field mapping"
```

---

### Task 9: Rust import_to_table 命令（CSV + JSON）

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**注意**: Excel 和 preview_import_file 功能需要额外的 crate（`calamine`），作为 MVP 先支持 CSV + JSON + SQL，其他格式返回有意义的错误。`get_table_columns_for_import` 复用已有的 `get_columns` 方法。

- [ ] **Step 1: 添加 import_to_table 相关结构体和命令**

在 commands.rs 末尾添加：

```rust
// ============ 数据导入 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportParams {
    pub connection_id: i64,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub file_path: String,
    pub file_type: String,   // csv/json/excel/sql
    pub field_mapping: std::collections::HashMap<String, String>,
    pub error_strategy: String,  // "StopOnError" | "SkipAndContinue"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ColumnInfoForImport {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub is_pk: bool,
    pub nullable: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableColumnsResponse {
    pub columns: Vec<ColumnInfoForImport>,
}

/// 获取表列信息用于导入字段映射
#[tauri::command]
pub async fn get_table_columns_for_import(
    connection_id: i64,
    database: Option<String>,
    schema: Option<String>,
    table: String,
) -> AppResult<TableColumnsResponse> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let schema_ref = schema.as_deref().filter(|s| !s.is_empty());
    let cols = ds.get_columns(&table, schema_ref).await?;
    let columns = cols.into_iter().map(|c| ColumnInfoForImport {
        type_: c.data_type.clone(),
        is_pk: c.is_primary_key,
        nullable: c.is_nullable,
        name: c.name,
    }).collect();
    Ok(TableColumnsResponse { columns })
}

/// 预览导入文件（返回前5行的文本预览 + 列名）
#[tauri::command]
pub async fn preview_import_file(
    file_path: String,
    file_type: String,
) -> AppResult<serde_json::Value> {
    let content = tokio::fs::read_to_string(&file_path).await
        .map_err(|e| crate::AppError::Other(format!("Failed to read file: {}", e)))?;

    match file_type.as_str() {
        "csv" => {
            let lines: Vec<&str> = content.lines().take(6).collect();
            let columns = lines.first()
                .map(|h| h.split(',').map(|s| s.trim().trim_matches('"').to_string()).collect::<Vec<_>>())
                .unwrap_or_default();
            let preview_rows: Vec<String> = lines.iter().take(6).map(|s| s.to_string()).collect();
            Ok(serde_json::json!({ "columns": columns, "preview_rows": preview_rows }))
        }
        "json" => {
            let parsed: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| crate::AppError::Other(format!("Invalid JSON: {}", e)))?;
            let (columns, preview_rows) = if let Some(arr) = parsed.as_array() {
                let cols = arr.first()
                    .and_then(|v| v.as_object())
                    .map(|o| o.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                let rows = arr.iter().take(5)
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>();
                (cols, rows)
            } else {
                (vec![], vec![parsed.to_string()])
            };
            Ok(serde_json::json!({ "columns": columns, "preview_rows": preview_rows }))
        }
        _ => Ok(serde_json::json!({
            "columns": [],
            "preview_rows": [format!("预览不支持 {} 格式，请直接导入", file_type)]
        })),
    }
}

/// 导入文件到表（异步后台执行，通过 task-progress 事件推进度）
#[tauri::command]
pub async fn import_to_table(
    params: ImportParams,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    let title = format!("导入到 {} 表", params.table);
    let task = crate::db::create_task(&crate::db::models::CreateTaskInput {
        type_: "import".to_string(),
        status: "running".to_string(),
        title,
        params: Some(serde_json::to_string(&params).unwrap_or_default()),
        progress: Some(0),
        processed_rows: Some(0),
        total_rows: None,
        current_target: Some(params.table.clone()),
        error: None,
        error_details: None,
        output_path: Some(params.file_path.clone()),
    })?;
    let task_id = task.id.clone();
    let task_id_clone = task_id.clone();

    tokio::spawn(async move {
        let result = run_import(&params, &task_id_clone, &app_handle).await;
        match result {
            Ok(count) => {
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("completed".to_string()),
                    progress: Some(100),
                    processed_rows: Some(count as i64),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone,
                    status: "completed".to_string(),
                    progress: 100,
                    processed_rows: count,
                    total_rows: None,
                    current_target: String::new(),
                    error: None,
                    output_path: None,
                });
            }
            Err(e) => {
                let _ = crate::db::update_task(&task_id_clone, &crate::db::models::UpdateTaskInput {
                    status: Some("failed".to_string()),
                    error: Some(e.to_string()),
                    completed_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..Default::default()
                });
                let _ = app_handle.emit("task-progress", TaskProgressPayload {
                    task_id: task_id_clone,
                    status: "failed".to_string(),
                    progress: 0,
                    processed_rows: 0,
                    total_rows: None,
                    current_target: String::new(),
                    error: Some(e.to_string()),
                    output_path: None,
                });
            }
        }
    });

    Ok(task_id)
}

async fn run_import(
    params: &ImportParams,
    task_id: &str,
    app_handle: &tauri::AppHandle,
) -> AppResult<u64> {
    let config = crate::db::get_connection_config(params.connection_id)?;
    let ds = match params.database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };

    let content = tokio::fs::read_to_string(&params.file_path).await
        .map_err(|e| crate::AppError::Other(format!("Failed to read file: {}", e)))?;

    let rows: Vec<std::collections::HashMap<String, serde_json::Value>> = match params.file_type.as_str() {
        "csv" => {
            let mut lines = content.lines();
            let headers: Vec<String> = lines.next()
                .ok_or_else(|| crate::AppError::Other("Empty CSV file".into()))?
                .split(',')
                .map(|s| s.trim().trim_matches('"').to_string())
                .collect();
            lines.enumerate().map(|(_, line)| {
                let vals: Vec<&str> = line.split(',').collect();
                headers.iter().enumerate().map(|(i, h)| {
                    let v = vals.get(i).copied().unwrap_or("").trim().trim_matches('"');
                    (h.clone(), serde_json::Value::String(v.to_string()))
                }).collect()
            }).collect()
        }
        "json" => {
            let parsed: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| crate::AppError::Other(format!("Invalid JSON: {}", e)))?;
            parsed.as_array()
                .ok_or_else(|| crate::AppError::Other("JSON must be an array".into()))?
                .iter()
                .filter_map(|v| v.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()))
                .collect()
        }
        _ => return Err(crate::AppError::Other(format!("Import format '{}' not yet supported", params.file_type))),
    };

    let total = rows.len() as u64;
    let batch_size = 100;
    let tbl = qualified_table(&config.driver, params.schema.as_deref(), &params.table);
    let mut success_count = 0u64;
    let stop_on_error = params.error_strategy == "StopOnError";

    for (batch_idx, chunk) in rows.chunks(batch_size).enumerate() {
        let progress = ((batch_idx * batch_size) as f64 / total as f64 * 100.0) as u8;
        let _ = app_handle.emit("task-progress", TaskProgressPayload {
            task_id: task_id.to_string(),
            status: "running".to_string(),
            progress,
            processed_rows: success_count,
            total_rows: Some(total),
            current_target: params.table.clone(),
            error: None,
            output_path: None,
        });

        for row in chunk {
            // 应用字段映射
            let mapped: Vec<(String, Option<String>)> = params.field_mapping.iter()
                .filter_map(|(src, dst)| {
                    row.get(src).map(|v| {
                        let val = match v {
                            serde_json::Value::Null => None,
                            serde_json::Value::String(s) => Some(s.clone()),
                            other => Some(other.to_string()),
                        };
                        (dst.clone(), val)
                    })
                })
                .collect();

            if mapped.is_empty() { continue; }

            let (col_list, val_list): (Vec<String>, Vec<String>) = mapped.iter()
                .map(|(col, val)| {
                    let qcol = match config.driver.as_str() {
                        "mysql" => format!("`{}`", col.replace('`', "``")),
                        _ => format!("\"{}\"", col.replace('"', "\"\"")),
                    };
                    let qval = match val {
                        None => "NULL".to_string(),
                        Some(v) => match config.driver.as_str() {
                            "mysql" => format!("'{}'", v.replace('\'', "\\'")),
                            _ => format!("'{}'", v.replace('\'', "''")),
                        },
                    };
                    (qcol, qval)
                })
                .unzip();

            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                tbl, col_list.join(", "), val_list.join(", ")
            );

            match ds.execute(&sql).await {
                Ok(_) => success_count += 1,
                Err(e) => {
                    if stop_on_error {
                        return Err(e);
                    }
                }
            }
        }
    }

    Ok(success_count)
}
```

- [ ] **Step 2: 注册命令**

在 `lib.rs` 的 `invoke_handler` 中，紧接 `commands::export_tables` 之后添加：

```rust
            commands::import_to_table,
            commands::preview_import_file,
            commands::get_table_columns_for_import,
```

**MVP 说明：** `run_import` 中使用逐行 INSERT（每批最多 100 行循环调用 `ds.execute()`），而非单条批量 INSERT 语句（如 `INSERT INTO t VALUES (v1),(v2),...`）。这是 MVP 简化，不符合 spec §4.4 中"批量 INSERT"的描述。真实批量 INSERT 需要在 for chunk 循环中将 100 行合并为一条 SQL，后续可优化。

**GBK 说明：** `preview_import_file` 使用 `read_to_string` 假设 UTF-8 编码。GBK 文件预览会乱码，这是 MVP 已知限制。

- [ ] **Step 3: cargo check**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(import): implement import_to_table, preview_import_file, get_table_columns_for_import"
```

---

## Chunk 4: P4+P5 — CreateDatabaseDialog + Context Menu + 集成

### Task 10: CreateDatabaseDialog

**Files:**
- Create: `src/components/DatabaseManager/CreateDatabaseDialog.tsx`

- [ ] **Step 1: 创建 CreateDatabaseDialog 组件**

```typescript
// src/components/DatabaseManager/CreateDatabaseDialog.tsx
import React, { useState } from 'react';
import { X, Database } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  connectionId: number;
  driver: string;  // 'mysql' | 'postgres' | 'sqlite'
  onClose: () => void;
  onSuccess: (dbName: string, switchTo: boolean) => void;
}

export const CreateDatabaseDialog: React.FC<Props> = ({
  connectionId,
  driver,
  onClose,
  onSuccess,
}) => {
  const [name, setName] = useState('');
  const [charset, setCharset] = useState('utf8mb4');
  const [collation, setCollation] = useState('utf8mb4_general_ci');
  const [defaultSchema, setDefaultSchema] = useState('public');
  const [switchAfterCreate, setSwitchAfterCreate] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('数据库名称不能为空');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      await invoke('create_database', {
        connectionId,
        name: name.trim(),
        options: {
          charset: driver === 'mysql' ? charset : null,
          collation: driver === 'mysql' ? collation : null,
          default_schema: driver === 'postgres' ? defaultSchema : null,
          tablespace: null,
        },
      });
      onSuccess(name.trim(), switchAfterCreate);  // 第二参数传出 switchAfterCreate 让调用方决定是否刷新并切换
      onClose();
    } catch (e: any) {
      setError(e?.toString() ?? '创建失败');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#0d1520] border border-[#1e2d42] rounded-lg w-[400px]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e2d42]">
          <div className="flex items-center gap-2">
            <Database size={14} className="text-[#3794ff]" />
            <h3 className="text-sm text-[#e8f4ff] font-medium">新建数据库</h3>
          </div>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-[#7a9bb8] mb-1">
              数据库名称 <span className="text-[#f44747]">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="my_new_db"
              className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none focus:border-[#3794ff]"
              autoFocus
            />
          </div>

          {driver === 'mysql' && (
            <>
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-1">字符集 (MySQL)</label>
                <select
                  value={charset}
                  onChange={(e) => setCharset(e.target.value)}
                  className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                >
                  <option value="utf8mb4">utf8mb4</option>
                  <option value="utf8">utf8</option>
                  <option value="latin1">latin1</option>
                  <option value="gbk">gbk</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-1">排序规则 (MySQL)</label>
                <select
                  value={collation}
                  onChange={(e) => setCollation(e.target.value)}
                  className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                >
                  <option value="utf8mb4_general_ci">utf8mb4_general_ci</option>
                  <option value="utf8mb4_unicode_ci">utf8mb4_unicode_ci</option>
                  <option value="utf8mb4_0900_ai_ci">utf8mb4_0900_ai_ci</option>
                </select>
              </div>
            </>
          )}

          {driver === 'postgres' && (
            <div>
              <label className="block text-xs text-[#7a9bb8] mb-1">默认 Schema 名称 (PostgreSQL)</label>
              <input
                value={defaultSchema}
                onChange={(e) => setDefaultSchema(e.target.value)}
                placeholder="public"
                className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
              />
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={switchAfterCreate}
              onChange={(e) => setSwitchAfterCreate(e.target.checked)}
              className="accent-[#3794ff]"
            />
            <span className="text-xs text-[#c8daea]">创建后立即切换到该数据库</span>
          </label>

          {error && (
            <div className="text-xs text-[#f44747] bg-[#f44747]/10 px-2 py-1.5 rounded border border-[#f44747]/30">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#1e2d42]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleCreate}
            disabled={isLoading || !name.trim()}
            className="px-3 py-1.5 text-xs bg-[#1a4a8a] text-[#3794ff] border border-[#3794ff]/50 rounded hover:bg-[#1e5a9a] transition-colors disabled:opacity-40"
          >
            {isLoading ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Rust create_database 命令**

在 commands.rs 末尾添加：

```rust
// ============ 数据库管理 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateDatabaseOptions {
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub default_schema: Option<String>,
    pub tablespace: Option<String>,
}

#[tauri::command]
pub async fn create_database(
    connection_id: i64,
    name: String,
    options: CreateDatabaseOptions,
) -> AppResult<()> {
    // 验证名称安全（只允许字母、数字、下划线）
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other(
            format!("Invalid database name '{}': only alphanumeric and underscore allowed", name)
        ));
    }

    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

    let sql = match config.driver.as_str() {
        "mysql" => {
            let charset = options.charset.as_deref().unwrap_or("utf8mb4");
            let collation = options.collation.as_deref().unwrap_or("utf8mb4_general_ci");
            format!(
                "CREATE DATABASE `{}` CHARACTER SET {} COLLATE {}",
                name, charset, collation
            )
        }
        "postgres" => format!("CREATE DATABASE \"{}\"", name),
        _ => format!("CREATE DATABASE \"{}\"", name),
    };

    ds.execute(&sql).await?;
    Ok(())
}

#[tauri::command]
pub async fn drop_database(
    connection_id: i64,
    name: String,
) -> AppResult<()> {
    // 验证名称安全
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(crate::AppError::Other(
            format!("Invalid database name '{}': only alphanumeric and underscore allowed", name)
        ));
    }

    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;

    let sql = match config.driver.as_str() {
        "mysql" => format!("DROP DATABASE `{}`", name),
        _ => format!("DROP DATABASE \"{}\"", name),
    };

    ds.execute(&sql).await?;
    Ok(())
}
```

- [ ] **Step 3: 注册 create_database, drop_database**

```rust
            commands::create_database,
            commands::drop_database,
```

- [ ] **Step 4: cargo check + tsc --noEmit**

```bash
cd src-tauri && cargo check
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/components/DatabaseManager/CreateDatabaseDialog.tsx src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(db): add CreateDatabaseDialog component and create_database/drop_database commands"
```

---

### Task 11: 更新 ContextMenu + DBTree 添加导出/导入/新建数据库入口

**Files:**
- Modify: `src/components/Explorer/ContextMenu.tsx`
- Modify: `src/components/Explorer/DBTree.tsx`

**架构说明：** DBTree 采用"自管弹窗"模式——所有对话框（TableManageDialog、DdlViewerDialog 等）都作为 state 存储在 DBTree 内部并直接渲染，而不是通过 App.tsx props 传递。ExportWizard、ImportWizard、CreateDatabaseDialog 应遵循相同模式，在 DBTree 内部管理。

- [ ] **Step 1: 在 ContextMenu.tsx 添加新 props 和菜单项**

在 `ContextMenuProps` 接口的 `onMoveToGroup` 附近添加新 props（**不要**新开一个 import 行，合并进现有 lucide-react import）：

```typescript
// 在现有 lucide-react import 行中追加 Download, Upload, Database：
import {
  FilePlus, FilePlus2, Pencil, Trash2,
  RefreshCw, FileEdit, ListTree, Copy, Eye, Sparkles, FolderOpen, DatabaseZap, FolderInput,
  Code2, Eraser, Download, Upload, Database
} from 'lucide-react';

// 在 ContextMenuProps 接口末尾添加：
  onExportTableData: () => void;
  onImportToTable: () => void;
  onCreateDatabase: () => void;
```

在 `ContextMenu` 组件函数参数解构中追加这 3 个 props。

在 `table` case 中，`onDropTable` 行之前添加：
```typescript
{ label: t('contextMenu.exportData', '导出数据'), icon: Download, onClick: onExportTableData, dividerBefore: true },
{ label: t('contextMenu.importData', '导入数据'), icon: Upload, onClick: onImportToTable },
```

在 `connection` case 中，`onEditConnection` 行之前添加：
```typescript
{ label: t('contextMenu.createDatabase', '新建数据库'), icon: Database, onClick: onCreateDatabase, disabled: !isConnected, dividerBefore: true },
```

- [ ] **Step 2: 在 DBTree.tsx 添加弹窗状态和处理函数**

在 DBTree.tsx 的现有 state 声明区（`truncateConfirm` 附近）添加：

```typescript
import { ExportWizard } from '../ImportExport/ExportWizard';
import { ImportWizard } from '../ImportExport/ImportWizard';
import { CreateDatabaseDialog } from '../DatabaseManager/CreateDatabaseDialog';
import { useConnectionStore } from '../../store/connectionStore';  // 已存在，确认已导入

// state 声明：
const [exportWizard, setExportWizard] = useState<{
  tableName: string; connectionId: number; database?: string; schema?: string;
} | null>(null);
const [importWizard, setImportWizard] = useState<{
  tableName: string; connectionId: number; database?: string; schema?: string;
} | null>(null);
const [createDb, setCreateDb] = useState<{
  connectionId: number; driver: string;
} | null>(null);
```

获取 driver 的辅助函数（DBTree 已有 `connections` from `useConnectionStore`）：
```typescript
const getDriver = (connectionId: number): string => {
  return connections.find(c => c.id === connectionId)?.driver ?? 'mysql';
};
```

- [ ] **Step 3: 在 ContextMenu 渲染处绑定新回调**

在 DBTree.tsx 中 ContextMenu 的 JSX 渲染处，添加 3 个新 props：

```typescript
onExportTableData={() => {
  const n = contextMenu.node;
  setContextMenu(null);
  setExportWizard({ tableName: n.label, connectionId: getConnectionId(n), database: n.meta.database, schema: n.meta.schema });
}}
onImportToTable={() => {
  const n = contextMenu.node;
  setContextMenu(null);
  setImportWizard({ tableName: n.label, connectionId: getConnectionId(n), database: n.meta.database, schema: n.meta.schema });
}}
onCreateDatabase={() => {
  const n = contextMenu.node;
  setContextMenu(null);
  setCreateDb({ connectionId: getConnectionId(n), driver: getDriver(getConnectionId(n)) });
}}
```

- [ ] **Step 4: 在 DBTree return 末尾渲染 3 个弹窗**

在 DBTree.tsx 的 JSX return 中，`{tableManageDialog && ...}` 等其他弹窗渲染块之后，添加：

```tsx
{exportWizard && (
  <ExportWizard
    defaultTable={exportWizard.tableName}
    connectionId={exportWizard.connectionId}
    database={exportWizard.database}
    schema={exportWizard.schema}
    onClose={() => setExportWizard(null)}
  />
)}
{importWizard && (
  <ImportWizard
    defaultTable={importWizard.tableName}
    connectionId={importWizard.connectionId}
    database={importWizard.database}
    schema={importWizard.schema}
    onClose={() => setImportWizard(null)}
  />
)}
{createDb && (
  <CreateDatabaseDialog
    connectionId={createDb.connectionId}
    driver={createDb.driver}
    onClose={() => setCreateDb(null)}
    onSuccess={(dbName, switchTo) => {
      setCreateDb(null);
      // 刷新树（让新建的数据库出现在树中）
      refreshNode(`conn_${createDb.connectionId}`);
      if (switchTo) {
        showToast(`已创建数据库 ${dbName}`, 'success');
      }
    }}
  />
)}
```

- [ ] **Step 5: npx tsc --noEmit**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/components/Explorer/ContextMenu.tsx src/components/Explorer/DBTree.tsx src/components/DatabaseManager/CreateDatabaseDialog.tsx
git commit -m "feat(context-menu): add export/import/create-database entries to context menu"
```

---

## 验证清单

在所有 chunk 完成后：

- [ ] `cargo check` 通过，无编译错误
- [ ] `npx tsc --noEmit` 通过，无类型错误
- [ ] 启动 `npm run tauri:dev` 验证：
  - TaskCenter 按钮可见并可打开
  - 右键表节点能看到"导出数据"/"导入数据"选项
  - 右键 connection 节点能看到"新建数据库"选项
  - ExportWizard 3步可以完成并创建任务记录
  - ImportWizard 3步流程可以触发

---

## 未实现（有意留待后续）

- **P6**: 跨连接数据迁移（MigrationWizard + migrate_data）
- **Excel 导入**: 需要 `calamine` crate，后续 P3 增强
- **取消正在运行的导出/导入**: 需要 CancellationToken 机制，MVP 仅标记 cancelled 状态
- **重试任务**: MVP 仅重置状态，实际重新执行需要序列化参数并重新调用命令
