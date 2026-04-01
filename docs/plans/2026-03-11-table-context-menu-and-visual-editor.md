<!-- STATUS: ✅ 已实现 -->
# 表右键菜单扩展 & 可视化表结构编辑器 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为表节点右键菜单新增「查看 DDL」「截断表」两个入口，并将「编辑表结构」从 DDL textarea 重构为可视化列编辑表格。

**Architecture:** 新增两个独立轻量对话框（DdlViewerDialog、TruncateConfirmDialog），重构现有 TableManageDialog 为可视化表格编辑器。ALTER/CREATE SQL 由前端 diff 算法实时生成，无需新增 Rust 命令。

**Tech Stack:** React 18, TypeScript, Tauri invoke（复用 `get_table_ddl`、`get_table_detail`、`execute_query`），lucide-react 图标，react-i18next。

---

## Task 1：i18n — 新增文案 Key

**Files:**
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

**Step 1: 在 zh.json 的 `contextMenu` 段新增两行**

在 `"dropTable": "删除表"` 之前插入（保持菜单逻辑顺序）：

```json
"viewDdl": "查看 DDL",
"truncateTable": "截断表",
```

**Step 2: 在 zh.json 新增两个顶层段落**（放在 `tableManage` 之后）：

```json
"ddlViewer": {
  "title": "查看 DDL",
  "copy": "复制",
  "copied": "已复制"
},
"truncateConfirm": {
  "title": "截断表",
  "warning": "此操作将删除表 {{table}} 中的所有数据，且无法恢复。",
  "confirm": "确认截断",
  "success": "截断成功",
  "error": "截断失败"
},
```

**Step 3: 在 zh.json 的 `tableManage` 段新增以下 key**（保留原有 key，追加）：

```json
"addColumn": "添加列",
"columnName": "列名",
"dataType": "类型",
"length": "长度",
"nullable": "可空",
"defaultValue": "默认值",
"primaryKey": "主键",
"alterPreview": "ALTER SQL 预览",
"executeAlter": "执行 ALTER",
"createPreview": "CREATE SQL 预览",
"executeCreate": "创建表",
"noChanges": "-- 无变更",
"orderNotSupported": "-- PostgreSQL 不支持调整列顺序，已忽略排序变更",
"loadFailed": "加载表结构失败"
```

**Step 4: 同样修改 en.json**，对应英文翻译：

`contextMenu` 新增：
```json
"viewDdl": "View DDL",
"truncateTable": "Truncate Table",
```

新增段落：
```json
"ddlViewer": {
  "title": "View DDL",
  "copy": "Copy",
  "copied": "Copied"
},
"truncateConfirm": {
  "title": "Truncate Table",
  "warning": "This operation will delete all data in table {{table}} and cannot be undone.",
  "confirm": "Confirm Truncate",
  "success": "Truncated successfully",
  "error": "Truncate failed"
},
```

`tableManage` 新增：
```json
"addColumn": "Add Column",
"columnName": "Column Name",
"dataType": "Type",
"length": "Length",
"nullable": "Nullable",
"defaultValue": "Default",
"primaryKey": "PK",
"alterPreview": "ALTER SQL Preview",
"executeAlter": "Execute ALTER",
"createPreview": "CREATE SQL Preview",
"executeCreate": "Create Table",
"noChanges": "-- No changes",
"orderNotSupported": "-- PostgreSQL does not support column reordering, order changes ignored",
"loadFailed": "Failed to load table structure"
```

**Step 5: Commit**

```bash
git add src/i18n/locales/zh.json src/i18n/locales/en.json
git commit -m "feat(i18n): add keys for ddl viewer, truncate confirm, visual table editor"
```

---

## Task 2：新增 `DdlViewerDialog` 组件

**Files:**
- Create: `src/components/DdlViewerDialog/index.tsx`

**Step 1: 创建组件文件**

```tsx
import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X, Copy, Check } from 'lucide-react';
import { useEscClose } from '../../hooks/useEscClose';

interface Props {
  connectionId: number;
  tableName: string;
  database?: string;
  schema?: string;
  onClose: () => void;
}

export const DdlViewerDialog: React.FC<Props> = ({
  connectionId, tableName, database, schema, onClose
}) => {
  const { t } = useTranslation();
  const [ddl, setDdl] = useState('');
  const [copied, setCopied] = useState(false);

  useEscClose(onClose);

  useEffect(() => {
    invoke<string>('get_table_ddl', {
      connectionId,
      table: tableName,
      database: database ?? null,
      schema: schema ?? null,
    }).then(setDdl).catch(() => setDdl('-- Failed to load DDL'));
  }, [connectionId, tableName, database, schema]);

  const handleCopy = () => {
    navigator.clipboard.writeText(ddl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[640px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[#1e2d42]">
          <span className="text-[#c8daea] text-sm font-medium">
            {t('ddlViewer.title')} — {tableName}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] bg-[#1a2639] rounded"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? t('ddlViewer.copied') : t('ddlViewer.copy')}
            </button>
            <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]">
              <X size={16} />
            </button>
          </div>
        </div>
        <textarea
          readOnly
          className="flex-1 m-4 bg-[#0d1520] border border-[#1e2d42] rounded p-3 font-mono text-xs text-[#c8daea] outline-none resize-none min-h-[300px]"
          value={ddl}
          spellCheck={false}
        />
      </div>
    </div>
  );
};
```

**Step 2: Commit**

```bash
git add src/components/DdlViewerDialog/index.tsx
git commit -m "feat: add DdlViewerDialog component"
```

---

## Task 3：新增 `TruncateConfirmDialog` 组件

**Files:**
- Create: `src/components/TruncateConfirmDialog/index.tsx`

**Step 1: 创建组件文件**

```tsx
import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X, AlertTriangle } from 'lucide-react';
import { useEscClose } from '../../hooks/useEscClose';
import type { ToastLevel } from '../Toast';

interface Props {
  connectionId: number;
  tableName: string;
  database?: string;
  schema?: string;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}

export const TruncateConfirmDialog: React.FC<Props> = ({
  connectionId, tableName, database, schema, onClose, onSuccess, showToast
}) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);

  useEscClose(onClose);

  const handleTruncate = async () => {
    setIsLoading(true);
    try {
      // 根据是否有 schema 决定 SQL 方言
      const sql = schema
        ? `TRUNCATE TABLE "${schema}"."${tableName}"`
        : `TRUNCATE TABLE \`${tableName}\``;
      await invoke('execute_query', {
        connectionId,
        sql,
        database: database ?? null,
        schema: schema ?? null,
      });
      showToast(t('truncateConfirm.success'), 'success');
      onSuccess();
      onClose();
    } catch (e) {
      showToast(`${t('truncateConfirm.error')}: ${String(e)}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[420px] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[#1e2d42]">
          <span className="text-red-400 text-sm font-medium flex items-center gap-2">
            <AlertTriangle size={15} />
            {t('truncateConfirm.title')}
          </span>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          <p className="text-[#c8daea] text-sm">
            {t('truncateConfirm.warning', { table: tableName })}
          </p>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-[#1e2d42]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-[#1a2639] text-[#7a9bb8] hover:text-[#c8daea] rounded text-xs"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleTruncate}
            disabled={isLoading}
            className="px-3 py-1.5 bg-red-600/80 text-white hover:bg-red-600 rounded text-xs disabled:opacity-50"
          >
            {isLoading ? t('common.executing') : t('truncateConfirm.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};
```

**Step 2: Commit**

```bash
git add src/components/TruncateConfirmDialog/index.tsx
git commit -m "feat: add TruncateConfirmDialog component"
```

---

## Task 4：ContextMenu — 新增两个菜单项

**Files:**
- Modify: `src/components/Explorer/ContextMenu.tsx`

**Step 1: 新增 import 图标**

在现有 import 行的 lucide-react 中，追加 `Code2` 和 `Eraser`：

```tsx
import {
  PlugZap, Unplug, FilePlus, FilePlus2, Pencil, Trash2,
  RefreshCw, FileEdit, ListTree, Copy, Eye, Sparkles, FolderOpen,
  DatabaseZap, FolderInput, Code2, Eraser
} from 'lucide-react';
```

**Step 2: 新增两个 Props 回调**

在 `ContextMenuProps` interface 中（`onDropTable` 之前）添加：

```tsx
onViewDdl: () => void;
onTruncateTable: () => void;
```

**Step 3: 解构参数中添加两个回调**

在 `export const ContextMenu` 的解构参数中（`onDropTable` 附近）添加：

```tsx
onViewDdl, onTruncateTable,
```

**Step 4: 修改 `table` case 的菜单项**

将 `table` case 替换为：

```tsx
case 'table':
  return [
    { label: t('contextMenu.openTableData'), icon: Eye, onClick: onOpenTableData },
    { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
    { label: t('contextMenu.viewDdl'), icon: Code2, onClick: onViewDdl },
    { label: t('contextMenu.editTableStructure'), icon: FileEdit, onClick: onEditTable, dividerBefore: true },
    { label: t('contextMenu.manageIndexes'), icon: ListTree, onClick: onManageIndexes },
    { label: t('contextMenu.truncateTable'), icon: Eraser, onClick: onTruncateTable, danger: true, dividerBefore: true },
    { label: t('contextMenu.dropTable'), icon: Trash2, onClick: onDropTable, danger: true },
  ];
```

**Step 5: Commit**

```bash
git add src/components/Explorer/ContextMenu.tsx
git commit -m "feat(context-menu): add View DDL and Truncate Table items"
```

---

## Task 5：DBTree — 接入新对话框

**Files:**
- Modify: `src/components/Explorer/DBTree.tsx`

**Step 1: 新增 import**

```tsx
import { DdlViewerDialog } from '../DdlViewerDialog';
import { TruncateConfirmDialog } from '../TruncateConfirmDialog';
```

**Step 2: 新增状态**

在 `tableManageDialog` state 附近（约 90 行）添加：

```tsx
const [ddlViewer, setDdlViewer] = useState<{ connectionId: number; tableName: string; database?: string; schema?: string } | null>(null);
const [truncateConfirm, setTruncateConfirm] = useState<{ connectionId: number; tableName: string; database?: string; schema?: string } | null>(null);
```

**Step 3: 在 ContextMenu 中追加两个回调 prop**

在 `<ContextMenu ...>` 的 JSX 中（约 213 行）追加：

```tsx
onViewDdl={() => {
  const n = contextMenu.node;
  setContextMenu(null);
  setDdlViewer({ connectionId: getConnectionId(n), tableName: n.label, database: n.meta.database, schema: n.meta.schema });
}}
onTruncateTable={() => {
  const n = contextMenu.node;
  setContextMenu(null);
  setTruncateConfirm({ connectionId: getConnectionId(n), tableName: n.label, database: n.meta.database, schema: n.meta.schema });
}}
```

**Step 4: 在 JSX 末尾渲染两个新对话框**

在 `tableManageDialog && <TableManageDialog .../>` 附近追加：

```tsx
{ddlViewer && (
  <DdlViewerDialog
    connectionId={ddlViewer.connectionId}
    tableName={ddlViewer.tableName}
    database={ddlViewer.database}
    schema={ddlViewer.schema}
    onClose={() => setDdlViewer(null)}
  />
)}

{truncateConfirm && (
  <TruncateConfirmDialog
    connectionId={truncateConfirm.connectionId}
    tableName={truncateConfirm.tableName}
    database={truncateConfirm.database}
    schema={truncateConfirm.schema}
    onClose={() => setTruncateConfirm(null)}
    onSuccess={() => refreshNode(
      Array.from(useTreeStore.getState().nodes.values())
        .find(n => n.label === truncateConfirm.tableName)?.parentId ?? ''
    )}
    showToast={showToast}
  />
)}
```

**Step 5: Commit**

```bash
git add src/components/Explorer/DBTree.tsx
git commit -m "feat(db-tree): wire DdlViewerDialog and TruncateConfirmDialog"
```

---

## Task 6：重构 `TableManageDialog` 为可视化编辑器

**Files:**
- Modify: `src/components/TableManageDialog/index.tsx`

这是最复杂的 Task，分步骤实现。

**Step 1: 定义 `EditableColumn` 类型（文件顶部）**

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { useEscClose } from '../../hooks/useEscClose';
import { useConnectionStore } from '../../store/connectionStore';
import type { ToastLevel } from '../Toast';

interface EditableColumn {
  id: string;
  name: string;
  dataType: string;
  length: string;
  isNullable: boolean;
  defaultValue: string;
  isPrimaryKey: boolean;
  extra: string;
  _originalName?: string;
  _isNew?: boolean;
  _isDeleted?: boolean;
}

const COMMON_TYPES = ['INT', 'BIGINT', 'VARCHAR', 'TEXT', 'BOOLEAN', 'FLOAT', 'DOUBLE', 'DECIMAL', 'DATE', 'DATETIME', 'TIMESTAMP', 'JSON'];
```

**Step 2: 实现 ALTER SQL 生成函数**

```tsx
function generateSql(
  tableName: string,
  original: EditableColumn[],
  edited: EditableColumn[],
  driver: string,
  isNew: boolean
): string {
  const isPostgres = driver === 'postgres' || driver === 'postgresql';
  const q = (name: string) => isPostgres ? `"${name}"` : `\`${name}\``;

  const colDef = (col: EditableColumn) => {
    const type = col.length ? `${col.dataType}(${col.length})` : col.dataType;
    const nullable = col.isNullable ? 'NULL' : 'NOT NULL';
    const def = col.defaultValue ? `DEFAULT ${col.defaultValue}` : '';
    const extra = col.extra && !isPostgres ? col.extra.toUpperCase() : '';
    return [q(col.name), type, nullable, def, extra].filter(Boolean).join(' ');
  };

  if (isNew) {
    const activeCols = edited.filter(c => !c._isDeleted);
    const pkCols = activeCols.filter(c => c.isPrimaryKey).map(c => q(c.name));
    const lines = activeCols.map(c => `  ${colDef(c)}`);
    if (pkCols.length > 0) lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
    return `CREATE TABLE ${q(tableName)} (\n${lines.join(',\n')}\n);`;
  }

  const tbl = q(tableName);
  const statements: string[] = [];
  const origNames = new Set(original.map(c => c.name));
  const orderChanged = !isPostgres && edited
    .filter(c => !c._isNew && !c._isDeleted)
    .some((c, i) => {
      const origIdx = original.findIndex(o => o.name === (c._originalName ?? c.name));
      return origIdx !== i;
    });

  if (orderChanged) {
    statements.push('-- 列顺序调整（仅 MySQL 支持）');
  }

  for (const col of edited) {
    if (col._isDeleted && !col._isNew) {
      statements.push(`ALTER TABLE ${tbl} DROP COLUMN ${q(col._originalName ?? col.name)};`);
    } else if (col._isNew && !col._isDeleted) {
      statements.push(`ALTER TABLE ${tbl} ADD COLUMN ${colDef(col)};`);
    } else if (!col._isNew && !col._isDeleted) {
      const orig = original.find(o => o.name === (col._originalName ?? col.name));
      if (!orig) continue;
      const changed = orig.name !== col.name
        || orig.dataType !== col.dataType
        || orig.isNullable !== col.isNullable
        || orig.defaultValue !== col.defaultValue
        || orig.extra !== col.extra
        || (orderChanged && !isPostgres);
      if (changed) {
        if (isPostgres) {
          if (orig.dataType !== col.dataType || orig.length !== col.length) {
            const type = col.length ? `${col.dataType}(${col.length})` : col.dataType;
            statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name)} TYPE ${type};`);
          }
          if (orig.isNullable !== col.isNullable) {
            statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name)} ${col.isNullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
          }
          if (orig.defaultValue !== col.defaultValue) {
            statements.push(col.defaultValue
              ? `ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name)} SET DEFAULT ${col.defaultValue};`
              : `ALTER TABLE ${tbl} ALTER COLUMN ${q(col.name)} DROP DEFAULT;`
            );
          }
        } else {
          const after = (() => {
            const idx = edited.filter(c => !c._isDeleted).indexOf(col);
            if (idx <= 0) return 'FIRST';
            const prev = edited.filter(c => !c._isDeleted)[idx - 1];
            return `AFTER ${q(prev.name)}`;
          })();
          statements.push(`ALTER TABLE ${tbl} MODIFY COLUMN ${colDef(col)} ${after};`);
        }
      }
    }
  }

  // 主键变化
  const origPks = original.filter(c => c.isPrimaryKey).map(c => q(c.name));
  const newPks = edited.filter(c => c.isPrimaryKey && !c._isDeleted).map(c => q(c.name));
  const pkChanged = JSON.stringify(origPks.sort()) !== JSON.stringify(newPks.sort());
  if (pkChanged) {
    if (isPostgres) {
      statements.push(`ALTER TABLE ${tbl} DROP CONSTRAINT IF EXISTS ${tbl}_pkey;`);
      if (newPks.length > 0) statements.push(`ALTER TABLE ${tbl} ADD PRIMARY KEY (${newPks.join(', ')});`);
    } else {
      statements.push(`ALTER TABLE ${tbl} DROP PRIMARY KEY;`);
      if (newPks.length > 0) statements.push(`ALTER TABLE ${tbl} ADD PRIMARY KEY (${newPks.join(', ')});`);
    }
  }

  return statements.length > 0 ? statements.join('\n') : '-- 无变更';
}
```

**Step 3: 实现组件主体**

```tsx
interface Props {
  connectionId: number;
  tableName?: string;
  database?: string;
  schema?: string;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}

function makeId() { return Math.random().toString(36).slice(2); }

export const TableManageDialog: React.FC<Props> = ({
  connectionId, tableName, database, schema, onClose, onSuccess, showToast
}) => {
  const { t } = useTranslation();
  const [columns, setColumns] = useState<EditableColumn[]>([]);
  const [originalColumns, setOriginalColumns] = useState<EditableColumn[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(false);

  const { connections } = useConnectionStore();
  const driver = connections.find(c => c.id === connectionId)?.driver ?? 'mysql';

  useEscClose(onClose);

  useEffect(() => {
    if (!tableName) {
      const initCols: EditableColumn[] = [{
        id: makeId(), name: 'id', dataType: 'INT', length: '', isNullable: false,
        defaultValue: '', isPrimaryKey: true, extra: 'auto_increment', _isNew: true,
      }];
      setColumns(initCols);
      setOriginalColumns([]);
      return;
    }
    setIsLoadingData(true);
    invoke<{ name: string; columns: Array<{
      name: string; data_type: string; is_nullable: boolean;
      column_default: string | null; is_primary_key: boolean; extra: string | null;
    }> }>('get_table_detail', {
      connectionId, database: database ?? null, schema: schema ?? null, table: tableName
    }).then(detail => {
      const cols: EditableColumn[] = detail.columns.map(c => ({
        id: makeId(),
        name: c.name,
        dataType: c.data_type.toUpperCase().split('(')[0],
        length: c.data_type.match(/\((\d+)\)/)?.[1] ?? '',
        isNullable: c.is_nullable,
        defaultValue: c.column_default ?? '',
        isPrimaryKey: c.is_primary_key,
        extra: c.extra ?? '',
        _originalName: c.name,
      }));
      setColumns(cols);
      setOriginalColumns(cols.map(c => ({ ...c })));
    }).catch(e => {
      showToast(`${t('tableManage.loadFailed')}: ${String(e)}`, 'error');
    }).finally(() => setIsLoadingData(false));
  }, [tableName, connectionId]);

  const updateColumn = useCallback((id: string, patch: Partial<EditableColumn>) => {
    setColumns(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  }, []);

  const addColumn = useCallback(() => {
    setColumns(prev => [...prev, {
      id: makeId(), name: 'new_column', dataType: 'VARCHAR', length: '255',
      isNullable: true, defaultValue: '', isPrimaryKey: false, extra: '', _isNew: true,
    }]);
  }, []);

  const moveColumn = useCallback((id: string, dir: 'up' | 'down') => {
    setColumns(prev => {
      const active = prev.filter(c => !c._isDeleted);
      const idx = active.findIndex(c => c.id === id);
      if (dir === 'up' && idx <= 0) return prev;
      if (dir === 'down' && idx >= active.length - 1) return prev;
      const newActive = [...active];
      const swap = dir === 'up' ? idx - 1 : idx + 1;
      [newActive[idx], newActive[swap]] = [newActive[swap], newActive[idx]];
      // 重建完整列表（保留 _isDeleted 列）
      const deleted = prev.filter(c => c._isDeleted);
      return [...newActive, ...deleted];
    });
  }, []);

  const previewSql = generateSql(tableName ?? 'new_table', originalColumns, columns, driver, !tableName);

  const handleExecute = async () => {
    if (previewSql.startsWith('-- 无变更') || previewSql.startsWith('-- No changes')) return;
    setIsLoading(true);
    try {
      await invoke('execute_query', {
        connectionId, sql: previewSql,
        database: database ?? null, schema: schema ?? null,
      });
      showToast(tableName ? t('tableManage.alterSuccess') : t('tableManage.createSuccess'), 'success');
      onSuccess();
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const visibleColumns = columns.filter(c => !c._isDeleted);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[800px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#1e2d42]">
          <span className="text-[#c8daea] text-sm font-medium">
            {tableName ? t('tableManage.editTable', { table: tableName }) : t('tableManage.createTable')}
          </span>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]"><X size={16} /></button>
        </div>

        {/* Column editor table */}
        <div className="overflow-auto flex-1 p-4">
          {isLoadingData ? (
            <div className="text-center text-xs text-[#7a9bb8] py-8">{t('common.loading', 'Loading...')}</div>
          ) : (
            <table className="w-full text-xs text-[#c8daea] border-collapse">
              <thead>
                <tr className="border-b border-[#1e2d42]">
                  <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[120px]">{t('tableManage.columnName')}</th>
                  <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[110px]">{t('tableManage.dataType')}</th>
                  <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[60px]">{t('tableManage.length')}</th>
                  <th className="text-center py-1.5 px-2 font-medium text-[#7a9bb8] w-[50px]">{t('tableManage.nullable')}</th>
                  <th className="text-left py-1.5 px-2 font-medium text-[#7a9bb8] w-[100px]">{t('tableManage.defaultValue')}</th>
                  <th className="text-center py-1.5 px-2 font-medium text-[#7a9bb8] w-[40px]">{t('tableManage.primaryKey')}</th>
                  <th className="text-center py-1.5 px-2 font-medium text-[#7a9bb8] w-[80px]">Extra</th>
                  <th className="w-[70px]"></th>
                </tr>
              </thead>
              <tbody>
                {visibleColumns.map((col, idx) => (
                  <tr key={col.id} className="border-b border-[#1a2639] hover:bg-[#1a2639]/40">
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                        value={col.name}
                        onChange={e => updateColumn(col.id, { name: e.target.value })}
                      />
                    </td>
                    <td className="py-1 px-2">
                      <select
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                        value={col.dataType}
                        onChange={e => updateColumn(col.id, { dataType: e.target.value })}
                      >
                        {COMMON_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        {!COMMON_TYPES.includes(col.dataType) && <option value={col.dataType}>{col.dataType}</option>}
                      </select>
                    </td>
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                        value={col.length}
                        onChange={e => updateColumn(col.id, { length: e.target.value })}
                        placeholder="—"
                      />
                    </td>
                    <td className="py-1 px-2 text-center">
                      <input
                        type="checkbox"
                        checked={col.isNullable}
                        onChange={e => updateColumn(col.id, { isNullable: e.target.checked })}
                        className="accent-[#009e84]"
                      />
                    </td>
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                        value={col.defaultValue}
                        onChange={e => updateColumn(col.id, { defaultValue: e.target.value })}
                        placeholder="—"
                      />
                    </td>
                    <td className="py-1 px-2 text-center">
                      <input
                        type="checkbox"
                        checked={col.isPrimaryKey}
                        onChange={e => updateColumn(col.id, { isPrimaryKey: e.target.checked })}
                        className="accent-[#3794ff]"
                      />
                    </td>
                    <td className="py-1 px-2">
                      <input
                        className="w-full bg-[#0d1520] border border-[#2a3f5a] rounded px-1.5 py-0.5 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                        value={col.extra}
                        onChange={e => updateColumn(col.id, { extra: e.target.value })}
                        placeholder="—"
                      />
                    </td>
                    <td className="py-1 px-2">
                      <div className="flex items-center gap-0.5 justify-center">
                        <button
                          onClick={() => moveColumn(col.id, 'up')}
                          disabled={idx === 0}
                          className="text-[#7a9bb8] hover:text-[#c8daea] disabled:opacity-30 p-0.5"
                        ><ChevronUp size={12} /></button>
                        <button
                          onClick={() => moveColumn(col.id, 'down')}
                          disabled={idx === visibleColumns.length - 1}
                          className="text-[#7a9bb8] hover:text-[#c8daea] disabled:opacity-30 p-0.5"
                        ><ChevronDown size={12} /></button>
                        <button
                          onClick={() => col._isNew
                            ? setColumns(prev => prev.filter(c => c.id !== col.id))
                            : updateColumn(col.id, { _isDeleted: true })
                          }
                          className="text-red-500/70 hover:text-red-400 p-0.5"
                        ><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button
            onClick={addColumn}
            className="mt-2 flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#009e84] px-2 py-1"
          >
            <Plus size={13} />
            {t('tableManage.addColumn')}
          </button>
        </div>

        {/* ALTER SQL preview */}
        <div className="px-4 pb-2">
          <div className="text-xs text-[#7a9bb8] mb-1">
            {tableName ? t('tableManage.alterPreview') : t('tableManage.createPreview')}
          </div>
          <textarea
            readOnly
            className="w-full bg-[#0d1520] border border-[#1e2d42] rounded p-2 font-mono text-xs text-[#c8daea] outline-none resize-none h-[80px]"
            value={previewSql}
            spellCheck={false}
          />
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-[#1e2d42]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-[#1a2639] text-[#7a9bb8] hover:text-[#c8daea] rounded text-xs"
          >{t('common.cancel')}</button>
          <button
            onClick={handleExecute}
            disabled={isLoading || previewSql.startsWith('-- ') || isLoadingData}
            className="px-3 py-1.5 bg-[#3794ff] text-[#c8daea] hover:bg-[#2b7cdb] rounded text-xs disabled:opacity-50"
          >
            {isLoading
              ? t('common.executing')
              : tableName ? t('tableManage.executeAlter') : t('tableManage.executeCreate')}
          </button>
        </div>
      </div>
    </div>
  );
};
```

**Step 4: Commit**

```bash
git add src/components/TableManageDialog/index.tsx
git commit -m "feat: refactor TableManageDialog to visual column editor with ALTER SQL preview"
```

---

## Task 7：TypeScript 类型检查

**Step 1: 运行类型检查**

```bash
npx tsc --noEmit
```

预期：0 错误。如有报错，根据错误信息修复类型问题。

**Step 2: 常见问题修复**

- `get_table_detail` 返回类型与 invoke 泛型参数不匹配 → 检查 `src/types/index.ts` 中的 `TableDetail` 定义并对齐
- 缺少 onViewDdl / onTruncateTable props → 确认 Task 4 Step 2 已添加

**Step 3: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: resolve TypeScript errors in table editor and new dialogs"
```

---

## Task 8：手工冒烟测试

连接一个 MySQL 或 PostgreSQL 数据库，验证以下场景：

1. **查看 DDL**：右键表节点 → 「查看 DDL」→ 弹窗显示 DDL，点「复制」后粘贴验证
2. **截断表**：右键表节点 → 「截断表」→ 红色确认对话框出现 → 点「确认截断」→ 成功 toast → 刷新后数据为空
3. **截断取消**：同上，点「取消」→ 对话框关闭，数据不变
4. **编辑表结构（修改列）**：右键 → 「编辑表结构」→ 修改某列类型或长度 → 底部实时显示 MODIFY COLUMN SQL → 执行 → 成功
5. **编辑表结构（新增列）**：点「添加列」→ 填写名称/类型 → SQL 预览出现 ADD COLUMN → 执行
6. **编辑表结构（删除列）**：点某列垃圾桶 → SQL 预览出现 DROP COLUMN → 执行
7. **调整顺序**：点上下箭头 → SQL 预览（MySQL：MODIFY COLUMN ... AFTER；PostgreSQL：提示不支持）
8. **新建表**：右键 tables 分组 → 「新建表」→ 可视化编辑器打开（无列加载）→ 设计列 → 底部生成 CREATE TABLE SQL → 执行

---

## 注意事项

- `get_table_detail` 的 Rust invoke 参数名为 `table`（不是 `tableName`），注意对齐
- PostgreSQL schema 用双引号 `"schema"."table"`，MySQL 用反引号
- `generateSql` 中的 `-- 无变更` 判断用于禁用执行按钮，需与 i18n key 无关（hardcode 判断前缀）
- `onSuccess` 回调用于刷新树，Task 5 Step 4 中需要找到正确的 parentId 节点刷新，可简化为刷新整棵树：`useTreeStore.getState().refreshNode(parentId)`
