<!-- STATUS: ✅ 已实现 -->
# TableDataView 行操作增强实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 TableDataView 添加右键菜单行操作、内联单元格编辑和批量提交功能。

**Architecture:** 拆分为 `usePendingChanges` Hook（本地编辑状态）、`EditableCell`（内联输入）、`RowContextMenu`（右键菜单），TableDataView 作为协调层整合三者。

**Tech Stack:** React 18 + TypeScript + Tauri invoke + react-i18next + Tailwind CSS

---

## 前置了解

- 设计文档：`docs/plans/2026-03-11-table-data-view-row-operations-design.md`
- 主要修改文件：`src/components/MainContent/TableDataView.tsx`
- 现有 Rust 命令：`update_row`（单列更新）、`delete_row`、`get_table_data`、`get_table_detail`
- 类型定义：`src/types/index.ts`（`QueryResult`、`ColumnMeta` 已存在）
- i18n 文件：`src/i18n/locales/zh.json` 和 `en.json`
- 现有 `update_row` 签名：`(connection_id, database, table, schema, pk_column, pk_value, column, new_value)`
- 无测试基础设施，跳过单元测试步骤

---

## Task 1: 添加 insert_row Rust 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`（在 `delete_row` 命令之后添加）
- Modify: `src-tauri/src/lib.rs`（注册新命令）

**Step 1: 在 commands.rs 中添加 insert_row 命令**

在 `delete_row` 函数结束后（约第 421 行 `}` 之后），添加：

```rust
#[tauri::command]
pub async fn insert_row(
    connection_id: i64,
    database: Option<String>,
    table: String,
    schema: Option<String>,
    columns: Vec<String>,
    values: Vec<Option<String>>,
) -> AppResult<()> {
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = match database.as_deref().filter(|s| !s.is_empty()) {
        Some(db) => crate::datasource::create_datasource_with_db(&config, db).await?,
        None => crate::datasource::create_datasource(&config).await?,
    };
    let tbl = qualified_table(&config.driver, schema.as_deref(), &table);
    let (col_list, val_list): (Vec<String>, Vec<String>) = columns
        .iter()
        .zip(values.iter())
        .map(|(col, val)| {
            let quoted_col = match config.driver.as_str() {
                "mysql" => format!("`{}`", col.replace('`', "``")),
                _ => format!("\"{}\"", col.replace('"', "\"\"")),
            };
            let quoted_val = match val {
                None => "NULL".to_string(),
                Some(v) => match config.driver.as_str() {
                    "mysql" => format!("'{}'", v.replace('\'', "\\'")),
                    _ => format!("'{}'", v.replace('\'', "''")),
                },
            };
            (quoted_col, quoted_val)
        })
        .unzip();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        tbl,
        col_list.join(", "),
        val_list.join(", ")
    );
    ds.execute(&sql).await?;
    Ok(())
}
```

**Step 2: 在 lib.rs 中注册命令**

找到 `generate_handler![` 列表，添加 `insert_row`：

```rust
insert_row,
```

**Step 3: 编译检查**

```bash
cd src-tauri && cargo check
```

期望：无编译错误。

**Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(rust): add insert_row command for table data view"
```

---

## Task 2: 添加 i18n 键

**Files:**
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

**Step 1: 在 zh.json 的 tableDataView 对象中添加缺少的键**

找到 `"tableDataView"` 对象，在现有键之后（`"rowsPerPage"` 后）添加：

```json
"commit": "提交",
"commitWithCount": "提交({{count}})",
"discardChanges": "撤销改动",
"copyCellValue": "复制单元格",
"copyRow": "复制行",
"copyAsInsertSql": "INSERT SQL",
"copyAsUpdateSql": "UPDATE SQL",
"copyAsDeleteSql": "DELETE SQL",
"copyAsSql": "复制为 SQL",
"sqlCopied": "已复制到剪贴板",
"commitSuccess": "提交成功",
"commitFailed": "提交失败"
```

**Step 2: 在 en.json 的 tableDataView 对象中添加对应英文键**

```json
"commit": "Commit",
"commitWithCount": "Commit({{count}})",
"discardChanges": "Discard Changes",
"copyCellValue": "Copy Cell",
"copyRow": "Copy Row",
"copyAsInsertSql": "INSERT SQL",
"copyAsUpdateSql": "UPDATE SQL",
"copyAsDeleteSql": "DELETE SQL",
"copyAsSql": "Copy as SQL",
"sqlCopied": "Copied to clipboard",
"commitSuccess": "Committed successfully",
"commitFailed": "Commit failed"
```

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit
```

期望：无类型错误。

**Step 4: Commit**

```bash
git add src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "feat(i18n): add row operations keys to tableDataView"
```

---

## Task 3: 创建 usePendingChanges Hook

**Files:**
- Create: `src/components/MainContent/usePendingChanges.ts`

**Step 1: 创建 Hook 文件**

创建 `src/components/MainContent/usePendingChanges.ts`：

```typescript
import { useState, useCallback } from 'react';

export type RowData = (string | number | boolean | null)[];

export interface CellEdit {
  rowIdx: number;
  colIdx: number;
  newValue: string | null;
}

export interface PendingState {
  edits: CellEdit[];
  clonedRows: RowData[];
  deletedRowIdxs: number[];
}

const EMPTY: PendingState = { edits: [], clonedRows: [], deletedRowIdxs: [] };

export function usePendingChanges() {
  const [pending, setPending] = useState<PendingState>(EMPTY);

  const editCell = useCallback((rowIdx: number, colIdx: number, newValue: string | null) => {
    setPending(prev => {
      const edits = prev.edits.filter(e => !(e.rowIdx === rowIdx && e.colIdx === colIdx));
      return { ...prev, edits: [...edits, { rowIdx, colIdx, newValue }] };
    });
  }, []);

  const cloneRow = useCallback((rowData: RowData) => {
    setPending(prev => ({ ...prev, clonedRows: [...prev.clonedRows, [...rowData]] }));
  }, []);

  const markDelete = useCallback((rowIdx: number) => {
    setPending(prev => {
      if (prev.deletedRowIdxs.includes(rowIdx)) return prev;
      return { ...prev, deletedRowIdxs: [...prev.deletedRowIdxs, rowIdx] };
    });
  }, []);

  const unmarkDelete = useCallback((rowIdx: number) => {
    setPending(prev => ({
      ...prev,
      deletedRowIdxs: prev.deletedRowIdxs.filter(i => i !== rowIdx),
    }));
  }, []);

  const discard = useCallback(() => setPending(EMPTY), []);

  const totalCount =
    pending.edits.length + pending.clonedRows.length + pending.deletedRowIdxs.length;

  const hasPending = totalCount > 0;

  return { pending, editCell, cloneRow, markDelete, unmarkDelete, discard, hasPending, totalCount };
}
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```

期望：无类型错误。

**Step 3: Commit**

```bash
git add src/components/MainContent/usePendingChanges.ts
git commit -m "feat(table): add usePendingChanges hook"
```

---

## Task 4: 创建 EditableCell 组件

**Files:**
- Create: `src/components/MainContent/EditableCell.tsx`

**Step 1: 创建组件文件**

创建 `src/components/MainContent/EditableCell.tsx`：

```typescript
import React, { useState, useRef, useEffect } from 'react';

interface EditableCellProps {
  value: string | number | boolean | null;
  pendingValue?: string | null;  // undefined = 未修改
  isDeleted?: boolean;
  isCloned?: boolean;
  onCommit: (newValue: string | null) => void;
}

export const EditableCell: React.FC<EditableCellProps> = ({
  value,
  pendingValue,
  isDeleted,
  isCloned,
  onCommit,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const displayValue = pendingValue !== undefined ? pendingValue : value;
  const isModified = pendingValue !== undefined;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = () => {
    if (isDeleted) return;
    setDraft(displayValue === null ? '' : String(displayValue));
    setEditing(true);
  };

  const confirm = () => {
    setEditing(false);
    onCommit(draft === '' && displayValue === null ? null : draft);
  };

  const cancel = () => setEditing(false);

  const cellClass = [
    'px-3 py-1.5 text-[#c8daea] border-r border-[#1e2d42] max-w-[300px] truncate relative',
    isDeleted ? 'line-through text-red-400/60' : '',
    isCloned ? 'text-green-400' : '',
    isModified && !isDeleted ? 'bg-yellow-900/20' : '',
  ].filter(Boolean).join(' ');

  if (editing) {
    return (
      <td className={cellClass}>
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={confirm}
          onKeyDown={e => {
            if (e.key === 'Enter') confirm();
            if (e.key === 'Escape') cancel();
          }}
          className="w-[calc(100%-4px)] h-[calc(100%-4px)] bg-[#1a2639] text-[#c8daea] border border-[#3a7bd5] rounded px-1 outline-none text-xs"
        />
      </td>
    );
  }

  return (
    <td className={cellClass} onDoubleClick={startEdit}>
      {displayValue === null
        ? <span className="text-[#7a9bb8] italic">NULL</span>
        : String(displayValue)}
    </td>
  );
};
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```

期望：无类型错误。

**Step 3: Commit**

```bash
git add src/components/MainContent/EditableCell.tsx
git commit -m "feat(table): add EditableCell component with inline editing"
```

---

## Task 5: 创建 RowContextMenu 组件

**Files:**
- Create: `src/components/MainContent/RowContextMenu.tsx`

**Step 1: 创建组件文件**

创建 `src/components/MainContent/RowContextMenu.tsx`：

```typescript
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

export type ClickTarget = 'row' | 'cell';

interface RowContextMenuProps {
  x: number;
  y: number;
  target: ClickTarget;
  rowData: (string | number | boolean | null)[];
  columns: string[];
  colIdx: number;
  pkColumn: string;
  tableName: string;
  onClose: () => void;
  onSetNull: () => void;
  onCloneRow: () => void;
  onDeleteRow: () => void;
  onPaste: (text: string) => void;
  showToast: (msg: string, level?: 'success' | 'error' | 'info' | 'warning') => void;
}

export const RowContextMenu: React.FC<RowContextMenuProps> = ({
  x, y, target, rowData, columns, colIdx, pkColumn, tableName,
  onClose, onSetNull, onCloneRow, onDeleteRow, onPaste, showToast,
}) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [sqlSubmenuOpen, setSqlSubmenuOpen] = useState(false);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const copyToClipboard = async (text: string) => {
    await writeText(text);
    showToast(t('tableDataView.sqlCopied'), 'success');
    onClose();
  };

  const handleCopyCell = () => {
    const val = rowData[colIdx];
    copyToClipboard(val === null ? 'NULL' : String(val));
  };

  const handleCopyRow = () => {
    copyToClipboard(rowData.map(v => v === null ? 'NULL' : String(v)).join('\t'));
  };

  const handlePaste = async () => {
    try {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      const text = await readText();
      if (text) onPaste(text);
    } catch {}
    onClose();
  };

  const buildInsertSql = () => {
    const cols = columns.map(c => `\`${c}\``).join(', ');
    const vals = rowData.map(v => v === null ? 'NULL' : `'${String(v).replace(/'/g, "\\'")}'`).join(', ');
    return `INSERT INTO \`${tableName}\` (${cols}) VALUES (${vals});`;
  };

  const buildUpdateSql = () => {
    const pkIdx = columns.indexOf(pkColumn);
    const pkVal = pkIdx >= 0 ? rowData[pkIdx] : null;
    const sets = columns
      .map((c, i) => `\`${c}\` = ${rowData[i] === null ? 'NULL' : `'${String(rowData[i]).replace(/'/g, "\\'")}'`}`)
      .join(', ');
    return `UPDATE \`${tableName}\` SET ${sets} WHERE \`${pkColumn}\` = '${pkVal}';`;
  };

  const buildDeleteSql = () => {
    const pkIdx = columns.indexOf(pkColumn);
    const pkVal = pkIdx >= 0 ? rowData[pkIdx] : null;
    return `DELETE FROM \`${tableName}\` WHERE \`${pkColumn}\` = '${pkVal}';`;
  };

  const itemClass = 'px-4 py-1.5 hover:bg-[#1a2639] cursor-pointer text-[#c8daea] flex items-center justify-between';
  const dividerClass = 'border-t border-[#1e2d42] my-1';

  return (
    <div
      ref={menuRef}
      style={{ position: 'fixed', top: y, left: x, zIndex: 9999 }}
      className="bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl text-xs min-w-[160px] py-1"
      onContextMenu={e => e.preventDefault()}
    >
      {target === 'cell' && (
        <div className={itemClass} onClick={handleCopyCell}>
          {t('tableDataView.copyCellValue')}
        </div>
      )}
      <div className={itemClass} onClick={handleCopyRow}>
        {t('tableDataView.copyRow')}
      </div>
      <div className={itemClass} onClick={handlePaste}>
        {t('tableDataView.paste')}
      </div>

      <div className={dividerClass} />

      {target === 'cell' && (
        <div className={itemClass} onClick={() => { onSetNull(); onClose(); }}>
          {t('tableDataView.setAsNull')}
        </div>
      )}
      <div className={itemClass} onClick={() => { onCloneRow(); onClose(); }}>
        {t('tableDataView.cloneRow')}
      </div>
      <div className={itemClass} onClick={() => { onDeleteRow(); onClose(); }}>
        <span className="text-red-400">{t('tableDataView.deleteRowMenuItem')}</span>
      </div>

      <div className={dividerClass} />

      <div
        className={itemClass}
        onMouseEnter={() => setSqlSubmenuOpen(true)}
        onMouseLeave={() => setSqlSubmenuOpen(false)}
        style={{ position: 'relative' }}
      >
        <span>{t('tableDataView.copyAsSql')}</span>
        <ChevronRight size={12} className="text-[#7a9bb8]" />
        {sqlSubmenuOpen && (
          <div
            className="absolute left-full top-0 bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl text-xs min-w-[140px] py-1"
          >
            <div className={itemClass} onClick={() => copyToClipboard(buildInsertSql())}>
              {t('tableDataView.copyAsInsertSql')}
            </div>
            <div className={itemClass} onClick={() => copyToClipboard(buildUpdateSql())}>
              {t('tableDataView.copyAsUpdateSql')}
            </div>
            <div className={itemClass} onClick={() => copyToClipboard(buildDeleteSql())}>
              {t('tableDataView.copyAsDeleteSql')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
```

**Step 2: 检查 @tauri-apps/plugin-clipboard-manager 是否已安装**

```bash
grep "clipboard" package.json
```

如果未安装，运行：
```bash
npm install @tauri-apps/plugin-clipboard-manager
```
并在 `src-tauri/Cargo.toml` 中添加：
```toml
tauri-plugin-clipboard-manager = "2"
```
并在 `src-tauri/src/lib.rs` 中注册插件：
```rust
.plugin(tauri_plugin_clipboard_manager::init())
```

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/components/MainContent/RowContextMenu.tsx
git commit -m "feat(table): add RowContextMenu with context-sensitive actions"
```

---

## Task 6: 重构 TableDataView 整合所有组件

**Files:**
- Modify: `src/components/MainContent/TableDataView.tsx`

**Step 1: 用新版本替换 TableDataView.tsx**

完整替换文件内容：

```typescript
import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useConnectionStore } from '../../store';
import type { QueryResult, ColumnMeta } from '../../types';
import { ChevronLeft, ChevronRight, RefreshCw, Filter, Download, Check, RotateCcw } from 'lucide-react';
import { ExportDialog } from '../ExportDialog';
import type { ToastLevel } from '../Toast';
import { Tooltip } from '../common/Tooltip';
import { EditableCell } from './EditableCell';
import { RowContextMenu, type ClickTarget } from './RowContextMenu';
import { usePendingChanges, type RowData } from './usePendingChanges';

interface TableDataViewProps {
  tableName: string;
  dbName: string;
  connectionId?: number;
  schema?: string;
  showToast: (msg: string, level?: ToastLevel) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  rowIdx: number;
  colIdx: number;
  target: ClickTarget;
}

export const TableDataView: React.FC<TableDataViewProps> = ({
  tableName, dbName, connectionId: propConnectionId, schema, showToast
}) => {
  const { t } = useTranslation();
  const { activeConnectionId: storeConnectionId } = useConnectionStore();
  const activeConnectionId = propConnectionId ?? storeConnectionId;

  const [data, setData] = useState<QueryResult | null>(null);
  const [_columns, setColumns] = useState<ColumnMeta[]>([]);
  const [pkColumn, setPkColumn] = useState<string>('id');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(100);
  const [whereClause, setWhereClause] = useState('');
  const [orderClause, setOrderClause] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);

  const { pending, editCell, cloneRow, markDelete, unmarkDelete, discard, hasPending, totalCount } = usePendingChanges();

  const loadData = useCallback(async () => {
    if (!activeConnectionId || !tableName) return;
    setIsLoading(true);
    try {
      const result = await invoke<QueryResult>('get_table_data', {
        params: {
          connection_id: activeConnectionId,
          database: dbName || null,
          table: tableName,
          schema: schema || null,
          page,
          page_size: pageSize,
          where_clause: whereClause || null,
          order_clause: orderClause || null,
        }
      });
      setData(result);
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setIsLoading(false);
    }
  }, [activeConnectionId, tableName, page, pageSize, whereClause, orderClause, showToast]);

  useEffect(() => {
    if (!activeConnectionId || !tableName) return;
    invoke<{ columns: ColumnMeta[] }>('get_table_detail', {
      connectionId: activeConnectionId, database: dbName || null, table: tableName
    })
      .then(detail => {
        setColumns(detail.columns);
        const pk = detail.columns.find(c => c.is_primary_key);
        if (pk) setPkColumn(pk.name);
      })
      .catch(() => {});
  }, [activeConnectionId, tableName]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleCommit = async () => {
    if (!activeConnectionId || !data) return;
    setIsCommitting(true);
    try {
      // 1. DELETE
      for (const rowIdx of pending.deletedRowIdxs) {
        const pkColIdx = data.columns.indexOf(pkColumn);
        const pkValue = pkColIdx >= 0 ? String(data.rows[rowIdx][pkColIdx] ?? '') : '';
        await invoke('delete_row', {
          connectionId: activeConnectionId,
          database: dbName || null,
          table: tableName,
          schema: schema || null,
          pkColumn,
          pkValue,
        });
      }
      // 2. UPDATE（按行分组，逐列调用 update_row）
      const editsByRow = new Map<number, typeof pending.edits>();
      for (const edit of pending.edits) {
        if (!editsByRow.has(edit.rowIdx)) editsByRow.set(edit.rowIdx, []);
        editsByRow.get(edit.rowIdx)!.push(edit);
      }
      for (const [rowIdx, edits] of editsByRow.entries()) {
        const pkColIdx = data.columns.indexOf(pkColumn);
        const pkValue = pkColIdx >= 0 ? String(data.rows[rowIdx][pkColIdx] ?? '') : '';
        for (const edit of edits) {
          await invoke('update_row', {
            connectionId: activeConnectionId,
            database: dbName || null,
            table: tableName,
            schema: schema || null,
            pkColumn,
            pkValue,
            column: data.columns[edit.colIdx],
            newValue: edit.newValue ?? '',
          });
        }
      }
      // 3. INSERT（克隆行）
      for (const rowData of pending.clonedRows) {
        await invoke('insert_row', {
          connectionId: activeConnectionId,
          database: dbName || null,
          table: tableName,
          schema: schema || null,
          columns: data.columns,
          values: rowData.map(v => v === null ? null : String(v)),
        });
      }
      discard();
      showToast(t('tableDataView.commitSuccess'), 'success');
      loadData();
    } catch (e) {
      showToast(`${t('tableDataView.commitFailed')}: ${String(e)}`, 'error');
    } finally {
      setIsCommitting(false);
    }
  };

  const getPendingValue = (rowIdx: number, colIdx: number) => {
    const edit = pending.edits.find(e => e.rowIdx === rowIdx && e.colIdx === colIdx);
    return edit ? edit.newValue : undefined;
  };

  const isRowDeleted = (rowIdx: number) => pending.deletedRowIdxs.includes(rowIdx);

  const handleContextMenu = (e: React.MouseEvent, rowIdx: number, colIdx: number, target: ClickTarget) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, rowIdx, colIdx, target });
  };

  const rowBgClass = (rowIdx: number) => {
    if (isRowDeleted(rowIdx)) return 'bg-red-900/20';
    const hasEdits = pending.edits.some(e => e.rowIdx === rowIdx);
    if (hasEdits) return 'bg-yellow-900/20';
    return '';
  };

  return (
    <div className="flex-1 flex flex-col bg-[#080d12] h-full">
      {/* Toolbar */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42] bg-[#080d12] text-xs">
        <div className="flex items-center space-x-2 text-[#7a9bb8]">
          <Tooltip content={t('tableDataView.firstPage')}>
            <button disabled={page <= 1} onClick={() => setPage(1)} className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30">|&lt;</button>
          </Tooltip>
          <Tooltip content={t('tableDataView.prevPage')}>
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30"><ChevronLeft size={14}/></button>
          </Tooltip>
          <span className="text-[#c8daea]">{page}</span>
          <Tooltip content={t('tableDataView.nextPage')}>
            <button
              disabled={!data || data.rows.length < pageSize}
              onClick={() => setPage(p => p + 1)}
              className="p-1 hover:bg-[#1a2639] rounded disabled:opacity-30"
            ><ChevronRight size={14}/></button>
          </Tooltip>
          <span className="text-[#7a9bb8]">{pageSize} {t('tableDataView.rowsPerPage')}</span>
          <Tooltip content={t('tableDataView.refreshData')}>
            <button onClick={loadData} className="p-1 hover:bg-[#1a2639] rounded"><RefreshCw size={14}/></button>
          </Tooltip>
        </div>

        <div className="flex items-center gap-2 text-[#7a9bb8]">
          {hasPending && (
            <>
              <Tooltip content={t('tableDataView.commit')}>
                <button
                  onClick={handleCommit}
                  disabled={isCommitting}
                  className="flex items-center gap-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 text-xs"
                >
                  <Check size={12}/>
                  {t('tableDataView.commitWithCount', { count: totalCount })}
                </button>
              </Tooltip>
              <Tooltip content={t('tableDataView.discardChanges')}>
                <button
                  onClick={discard}
                  className="flex items-center gap-1 px-2 py-1 hover:bg-[#1a2639] rounded text-xs"
                >
                  <RotateCcw size={12}/>
                  {t('tableDataView.discardChanges')}
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip content={t('export.exportData')}>
            <button onClick={() => setShowExport(true)} className="p-1 hover:bg-[#1a2639] rounded">
              <Download size={14}/>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="h-8 flex items-center px-3 border-b border-[#1e2d42] bg-[#080d12] text-xs gap-3">
        <Filter size={12} className="text-[#7a9bb8]"/>
        <span className="text-[#7a9bb8]">WHERE</span>
        <input
          className="bg-transparent outline-none text-[#c8daea] flex-1"
          placeholder={t('tableDataView.enterCondition')}
          value={whereClause}
          onChange={e => setWhereClause(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { if (page !== 1) setPage(1); else loadData(); } }}
        />
        <span className="text-[#7a9bb8]">ORDER BY</span>
        <input
          className="bg-transparent outline-none text-[#c8daea] flex-1"
          placeholder={t('tableDataView.enterOrder')}
          value={orderClause}
          onChange={e => setOrderClause(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { if (page !== 1) setPage(1); else loadData(); } }}
        />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-4 text-[#7a9bb8] text-sm">{t('tableDataView.loading')}</div>
        ) : !data ? (
          <div className="p-4 text-[#7a9bb8] text-sm">{t('tableDataView.noData')}</div>
        ) : (
          <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
            <thead className="sticky top-0 bg-[#0d1117] z-10">
              <tr>
                <th className="w-10 px-2 py-1.5 border-b border-r border-[#1e2d42] text-[#7a9bb8] font-normal">#</th>
                {data.columns.map(col => (
                  <th key={col} className="px-3 py-1.5 border-b border-r border-[#1e2d42] text-[#c8daea] font-normal">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, ri) => (
                <tr
                  key={ri}
                  className={`hover:bg-[#1a2639] border-b border-[#1e2d42] group ${rowBgClass(ri)}`}
                >
                  {/* 行号列 */}
                  <td
                    className="px-2 py-1.5 border-r border-[#1e2d42] text-[#7a9bb8] bg-[#0d1117] text-center text-xs cursor-default select-none"
                    onContextMenu={e => handleContextMenu(e, ri, -1, 'row')}
                  >
                    {(page - 1) * pageSize + ri + 1}
                  </td>
                  {/* 数据单元格 */}
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="p-0"
                      onContextMenu={e => handleContextMenu(e, ri, ci, 'cell')}
                    >
                      <EditableCell
                        value={cell}
                        pendingValue={getPendingValue(ri, ci)}
                        isDeleted={isRowDeleted(ri)}
                        onCommit={newVal => editCell(ri, ci, newVal)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {/* 克隆的新行（绿色） */}
              {pending.clonedRows.map((row, ci) => (
                <tr key={`cloned-${ci}`} className="border-b border-[#1e2d42] bg-green-900/20">
                  <td className="px-2 py-1.5 border-r border-[#1e2d42] text-green-400 bg-[#0d1117] text-center text-xs">+</td>
                  {row.map((cell, ji) => (
                    <td key={ji} className="px-3 py-1.5 text-green-400 border-r border-[#1e2d42] max-w-[300px] truncate">
                      {cell === null ? <span className="italic text-green-400/60">NULL</span> : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Status Bar */}
      <div className="h-7 flex items-center px-3 border-t border-[#1e2d42] bg-[#080d12] text-[#7a9bb8] text-xs">
        {data && <span>{data.row_count} {t('tableDataView.row')} · {data.duration_ms}ms</span>}
      </div>

      {/* Context Menu */}
      {contextMenu && data && (
        <RowContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu.target}
          rowData={data.rows[contextMenu.rowIdx] as RowData}
          columns={data.columns}
          colIdx={contextMenu.colIdx}
          pkColumn={pkColumn}
          tableName={tableName}
          onClose={() => setContextMenu(null)}
          onSetNull={() => editCell(contextMenu.rowIdx, contextMenu.colIdx, null)}
          onCloneRow={() => cloneRow(data.rows[contextMenu.rowIdx] as RowData)}
          onDeleteRow={() => {
            if (isRowDeleted(contextMenu.rowIdx)) {
              unmarkDelete(contextMenu.rowIdx);
            } else {
              markDelete(contextMenu.rowIdx);
            }
          }}
          onPaste={text => editCell(contextMenu.rowIdx, contextMenu.colIdx, text)}
          showToast={showToast}
        />
      )}

      {showExport && activeConnectionId && (
        <ExportDialog
          connectionId={activeConnectionId}
          database={dbName || undefined}
          tableName={tableName}
          schema={schema}
          onClose={() => setShowExport(false)}
          showToast={showToast}
        />
      )}
    </div>
  );
};
```

**Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```

期望：无类型错误。如有错误，逐个修复后重新检查。

**Step 3: 启动前端验证**

```bash
npm run dev
```

手动验证：
- [ ] 右键行号列，菜单不含"复制单元格"和"设置为NULL"
- [ ] 右键数据单元格，菜单含完整选项
- [ ] 双击单元格，出现内联输入框
- [ ] Enter 确认编辑，行变黄色背景
- [ ] 右键→克隆行，底部出现绿色新行
- [ ] 右键→删除行，行变红色+删除线
- [ ] 工具栏出现"提交(N)"和"撤销改动"按钮
- [ ] 复制为 SQL 子菜单正常展开并复制
- [ ] 提交后数据刷新，pending 清空

**Step 4: Commit**

```bash
git add src/components/MainContent/TableDataView.tsx
git commit -m "feat(table): integrate row operations - context menu, inline edit, pending changes"
```

---

## 完成检查

```bash
npx tsc --noEmit
cd src-tauri && cargo check
```

两项均无错误即为完成。
