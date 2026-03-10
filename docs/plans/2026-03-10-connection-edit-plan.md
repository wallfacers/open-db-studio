# 连接编辑功能实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在左侧连接列表支持右键菜单，提供「连接 / 编辑 / 删除」操作，复用 ConnectionModal 实现编辑模式。

**Architecture:** Rust 新增 update_connection 命令（password 可选保留原值）→ connectionStore 新增 updateConnection → ConnectionModal 支持 edit/create 双模式 → Explorer 右键菜单触发。

**Tech Stack:** Tauri 2.x · Rust · rusqlite · React 18 · TypeScript · Zustand

---

## 依赖顺序

```
Task 1 (Rust db::update_connection)
  → Task 2 (Rust update_connection 命令 + 注册)
    → Task 3 (connectionStore.updateConnection)
      → Task 4 (ConnectionModal edit 模式)
        → Task 5 (Explorer 右键菜单)
          → Task 6 (TypeScript 检查 + cargo check + 提交)
```

---

## Task 1：db::update_connection

**Files:**
- Modify: `src-tauri/src/db/mod.rs`

**Step 1: 在 db/mod.rs 添加 UpdateConnectionRequest 结构体**

在文件顶部 `use` 导入区域后、`create_connection` 函数前插入：

```rust
/// 更新连接请求（password 为 None 时保留原加密密码）
#[derive(Debug, serde::Deserialize)]
pub struct UpdateConnectionRequest {
    pub name: String,
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub database_name: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub extra_params: Option<String>,
}
```

**Step 2: 在 delete_connection 函数之后添加 update_connection 函数**

```rust
/// 更新连接，password 为 None 时保留原值
pub fn update_connection(id: i64, req: &UpdateConnectionRequest) -> AppResult<models::Connection> {
    let conn = get().lock().unwrap();
    let now = Utc::now().to_rfc3339();

    match &req.password {
        Some(pwd) if !pwd.is_empty() => {
            let password_enc = crate::crypto::encrypt(pwd)?;
            conn.execute(
                "UPDATE connections SET name=?1, driver=?2, host=?3, port=?4,
                 database_name=?5, username=?6, password_enc=?7,
                 extra_params=?8, updated_at=?9 WHERE id=?10",
                rusqlite::params![
                    req.name, req.driver, req.host, req.port,
                    req.database_name, req.username, password_enc,
                    req.extra_params, now, id
                ],
            )?;
        }
        _ => {
            conn.execute(
                "UPDATE connections SET name=?1, driver=?2, host=?3, port=?4,
                 database_name=?5, username=?6,
                 extra_params=?7, updated_at=?8 WHERE id=?9",
                rusqlite::params![
                    req.name, req.driver, req.host, req.port,
                    req.database_name, req.username,
                    req.extra_params, now, id
                ],
            )?;
        }
    }

    let result = conn.query_row(
        "SELECT id, name, group_id, driver, host, port, database_name, username, extra_params, created_at, updated_at
         FROM connections WHERE id = ?1",
        [id],
        |row| Ok(models::Connection {
            id: row.get(0)?,
            name: row.get(1)?,
            group_id: row.get(2)?,
            driver: row.get(3)?,
            host: row.get(4)?,
            port: row.get(5)?,
            database_name: row.get(6)?,
            username: row.get(7)?,
            extra_params: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        }),
    )?;
    Ok(result)
}
```

**Step 3: cargo check**

```bash
cd src-tauri && cargo check
```

Expected: 无 error，最多 warning

---

## Task 2：update_connection 命令 + 注册

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 在 commands.rs delete_connection 函数之后添加**

```rust
#[tauri::command]
pub async fn update_connection(id: i64, req: crate::db::UpdateConnectionRequest) -> AppResult<crate::db::models::Connection> {
    crate::db::update_connection(id, &req)
}
```

**Step 2: 在 lib.rs generate_handler![] 中注册**

在 `commands::delete_connection,` 之后添加：
```rust
commands::update_connection,
```

**Step 3: cargo check**

```bash
cd src-tauri && cargo check
```

Expected: EXIT 0

---

## Task 3：connectionStore.updateConnection

**Files:**
- Modify: `src/store/connectionStore.ts`

**Step 1: 在 ConnectionState interface 新增方法签名**

在 `deleteConnection` 下方加：
```typescript
updateConnection: (id: number, req: CreateConnectionRequest) => Promise<Connection>;
```

**Step 2: 实现 updateConnection**

在 `deleteConnection` 实现之后添加：
```typescript
updateConnection: async (id, req) => {
  const conn = await invoke<Connection>('update_connection', { id, req });
  set((s) => ({
    connections: s.connections.map((c) => (c.id === id ? conn : c)),
  }));
  return conn;
},
```

**Step 3: TypeScript 检查**

```bash
npx tsc --noEmit
```

Expected: 无新增错误

---

## Task 4：ConnectionModal edit 模式

**Files:**
- Modify: `src/components/ConnectionModal/index.tsx`

**Step 1: 修改 Props 类型，新增可选 connection prop**

将：
```typescript
interface Props {
  onClose: () => void;
}
```
改为：
```typescript
interface Props {
  onClose: () => void;
  connection?: import('../../types').Connection;
}
```

**Step 2: 引入 useConnectionStore**

在文件顶部 import 区域加：
```typescript
import { useConnectionStore } from '../../store';
```

**Step 3: 修改组件函数签名**

```typescript
export function ConnectionModal({ onClose, connection }: Props) {
  const { createConnection, testConnection, updateConnection } = useConnectionStore();
```

**Step 4: 修改 useState 初始值，使用 connection 预填表单**

将原：
```typescript
const [form, setForm] = useState<CreateConnectionRequest>({
  name: '',
  driver: 'mysql',
  host: 'localhost',
  port: 3306,
  database_name: '',
  username: '',
  password: '',
});
```
改为：
```typescript
const isEdit = !!connection;
const [form, setForm] = useState<CreateConnectionRequest>({
  name: connection?.name ?? '',
  driver: connection?.driver ?? 'mysql',
  host: connection?.host ?? 'localhost',
  port: connection?.port ?? 3306,
  database_name: connection?.database_name ?? '',
  username: connection?.username ?? '',
  password: '',
});
```

**Step 5: 修改 handleSave 逻辑**

将原 `handleSave` 改为：
```typescript
const handleSave = async () => {
  if (!form.name.trim()) return;
  setSaving(true);
  try {
    if (isEdit && connection) {
      await updateConnection(connection.id, form);
    } else {
      await createConnection(form);
    }
    onClose();
  } finally {
    setSaving(false);
  }
};
```

**Step 6: 修改弹窗标题和保存按钮文字**

将：
```tsx
<h2 className="text-white font-semibold mb-4">新建连接</h2>
```
改为：
```tsx
<h2 className="text-white font-semibold mb-4">{isEdit ? '编辑连接' : '新建连接'}</h2>
```

将保存按钮文字：
```tsx
{saving ? '保存中...' : '保存'}
```
改为：
```tsx
{saving ? '保存中...' : isEdit ? '保存修改' : '保存'}
```

**Step 7: 修改密码输入框 placeholder**

将密码 input 的 placeholder 改为：
```tsx
placeholder={isEdit ? '留空则不修改密码' : ''}
```

**Step 8: TypeScript 检查**

```bash
npx tsc --noEmit
```

Expected: 无新增错误

---

## Task 5：Explorer 右键菜单

**Files:**
- Modify: `src/components/Explorer/index.tsx`

**Step 1: 新增右键菜单状态和 ref**

在组件内现有 `useState` 之后添加：
```tsx
import React, { useEffect, useRef, useState } from 'react';

const [connContextMenu, setConnContextMenu] = useState<{ connId: number; x: number; y: number } | null>(null);
const connMenuRef = useRef<HTMLDivElement>(null);
const [editingConn, setEditingConn] = useState<import('../../types').Connection | null>(null);
```

**Step 2: 新增点击外部关闭菜单的 useEffect**

```tsx
useEffect(() => {
  const handler = (e: MouseEvent) => {
    if (connMenuRef.current && !connMenuRef.current.contains(e.target as Node)) {
      setConnContextMenu(null);
    }
  };
  document.addEventListener('mousedown', handler);
  return () => document.removeEventListener('mousedown', handler);
}, []);
```

**Step 3: 在每个连接的外层 div 上添加 onContextMenu**

找到：
```tsx
<div key={conn.id}>
  <TreeItem
    label={conn.name}
```
改为：
```tsx
<div
  key={conn.id}
  onContextMenu={(e) => {
    e.preventDefault();
    setConnContextMenu({ connId: conn.id, x: e.clientX, y: e.clientY });
  }}
>
  <TreeItem
    label={conn.name}
```

**Step 4: 新增删除处理函数**

在 `handleRefresh` 函数之后添加：
```tsx
const handleDeleteConnection = async (id: number) => {
  if (!window.confirm('确定要删除这个连接吗？相关查询历史也将一并删除。')) return;
  await deleteConnection(id);
  showToast('已删除连接');
};
```

确保 `deleteConnection` 已从 store 解构：
```tsx
const { connections, activeConnectionId, tables, loadConnections, setActiveConnection, loadTables, deleteConnection } = useConnectionStore();
```

**Step 5: 在组件 return 末尾（ConnectionModal 之前）插入右键菜单 + 编辑弹窗**

```tsx
{connContextMenu && (
  <div
    ref={connMenuRef}
    className="fixed z-50 bg-[#252526] border border-[#3c3c3c] rounded shadow-lg py-1 min-w-[140px]"
    style={{ left: connContextMenu.x, top: connContextMenu.y }}
  >
    <button
      className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] hover:text-white"
      onClick={() => {
        const conn = connections.find(c => c.id === connContextMenu.connId);
        if (conn) handleConnectionClick(conn.id);
        setConnContextMenu(null);
      }}
    >
      连接
    </button>
    <button
      className="w-full text-left px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#094771] hover:text-white"
      onClick={() => {
        const conn = connections.find(c => c.id === connContextMenu.connId);
        if (conn) setEditingConn(conn);
        setConnContextMenu(null);
      }}
    >
      编辑
    </button>
    <div className="h-px bg-[#3c3c3c] my-1" />
    <button
      className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-[#094771] hover:text-red-300"
      onClick={() => {
        handleDeleteConnection(connContextMenu.connId);
        setConnContextMenu(null);
      }}
    >
      删除
    </button>
  </div>
)}

{editingConn && (
  <ConnectionModal
    connection={editingConn}
    onClose={() => { setEditingConn(null); loadConnections(); }}
  />
)}
```

**Step 6: TypeScript 检查**

```bash
npx tsc --noEmit
```

Expected: EXIT 0，无错误

---

## Task 6：最终验证与提交

**Step 1: TypeScript 全量检查**

```bash
npx tsc --noEmit
```

Expected: EXIT 0

**Step 2: Rust 检查**

```bash
cd src-tauri && cargo check
```

Expected: EXIT 0

**Step 3: 前端构建**

```bash
npm run build
```

Expected: EXIT 0，build 成功

**Step 4: 提交**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/commands.rs src-tauri/src/lib.rs \
  src/store/connectionStore.ts src/components/ConnectionModal/index.tsx \
  src/components/Explorer/index.tsx
git commit -m "feat: add connection edit/delete via right-click context menu"
git push origin master
```
