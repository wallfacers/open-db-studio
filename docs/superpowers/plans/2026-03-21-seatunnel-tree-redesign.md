# SeaTunnel 迁移中心树结构改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SeaTunnel 迁移中心的目录树根节点从"目录/作业"改为"集群连接"，支持无限目录嵌套，支持右键内联重命名。

**Architecture:** 后端新增 `connection_id` 字段到 `st_categories`，前端 Store 新增 `connection` 节点类型，`init()` 先加载集群作为根节点再挂载目录和作业。`SeaTunnelJobTree` 完整重写以支持三种节点类型、右键菜单和内联 `<input>` 重命名。

**Tech Stack:** Rust (rusqlite, Tauri 2.x), React 18, TypeScript, Zustand, Vitest, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-21-seatunnel-tree-redesign.md`

---

## 文件变更地图

| 文件 | 操作 | 职责 |
|------|------|------|
| `schema/init.sql` | 修改 | `seatunnel_categories` 新增 `connection_id` 列，更新注释 |
| `src-tauri/src/db/migrations.rs` | 修改 | 新增 V12 migration：`st_categories.connection_id` |
| `src-tauri/src/seatunnel/commands.rs` | 修改 | 更新5个命令 + 新增 `rename_st_job` |
| `src-tauri/src/lib.rs` | 修改 | 注册 `rename_st_job` |
| `src/store/seaTunnelStore.ts` | 修改 | 新增 connection 节点类型，重写 `init()`，新增4个 Actions |
| `src/store/seaTunnelStore.test.ts` | 新建 | 测试 `init()` 树构建逻辑 |
| `src/i18n/locales/zh.json` | 修改 | 新增 8 个 seaTunnel.jobTree i18n 键 |
| `src/i18n/locales/en.json` | 修改 | 新增 8 个 seaTunnel.jobTree i18n 键（英文） |
| `src/components/SeaTunnelExplorer/SeaTunnelJobTree.tsx` | 修改 | 完整重写：三种节点、右键菜单、内联重命名 |
| `src/components/SeaTunnelExplorer/index.tsx` | 修改 | 移除"新建目录"工具栏按钮（与 Task 5 同批提交） |
| `src/components/SeaTunnelExplorer/CategoryEditModal.tsx` | 修改 | 移除 rename 模式、depth 校验；新增 connectionId 参数 |

---

## Task 1：DB Migration V12 + Schema 更新

**Files:**
- Modify: `schema/init.sql`
- Modify: `src-tauri/src/db/migrations.rs`

### 1a：更新 `schema/init.sql`（新安装用户的初始 DDL）

- [ ] **Step 1：修改 `seatunnel_categories` 表定义**

  找到第 279-286 行（`seatunnel_categories` 表），改为：

  ```sql
  -- 用户自定义分类（支持无限嵌套；根目录必须有 connection_id 归属集群）
  CREATE TABLE IF NOT EXISTS seatunnel_categories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    parent_id     INTEGER REFERENCES seatunnel_categories(id) ON DELETE CASCADE,
    connection_id INTEGER REFERENCES seatunnel_connections(id) ON DELETE CASCADE,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  ```

### 1b：在 `migrations.rs` 中追加 V12 Migration（存量数据库升级）

- [ ] **Step 2：在 `run_migrations()` 末尾追加 V12 migration**

  找到文件末尾 `Ok(())` 之前，插入：

  ```rust
  // V12: st_categories 新增 connection_id（与 seatunnel_connections 关联）
  {
      let has_col: bool = conn
          .query_row(
              "SELECT COUNT(*) FROM pragma_table_info('seatunnel_categories') WHERE name = 'connection_id'",
              [],
              |r| r.get::<_, i64>(0),
          )
          .unwrap_or(0)
          > 0;
      if !has_col {
          conn.execute_batch(
              "ALTER TABLE seatunnel_categories ADD COLUMN connection_id INTEGER REFERENCES seatunnel_connections(id) ON DELETE CASCADE;"
          )?;
          log::info!("V12: added seatunnel_categories.connection_id column");
      }
  }
  ```

- [ ] **Step 3：cargo check 验证 Rust 编译**

  ```bash
  cd src-tauri && cargo check 2>&1
  ```

  预期：无 error（可能有 warning，忽略）

- [ ] **Step 4：commit**

  ```bash
  git add schema/init.sql src-tauri/src/db/migrations.rs
  git commit -m "feat(db): V12 migration - add connection_id to seatunnel_categories"
  ```

---

## Task 2：更新后端 Rust 命令

**Files:**
- Modify: `src-tauri/src/seatunnel/commands.rs`

### 2a：`list_st_categories` 返回 `connection_id`

- [ ] **Step 1：修改 SQL 查询和 json! 序列化**

  找到 `list_st_categories` 函数（约第152行），将 SQL 和 query_map 改为：

  ```rust
  let mut stmt = conn
      .prepare(
          "SELECT id, name, parent_id, connection_id, sort_order FROM seatunnel_categories ORDER BY sort_order, name",
      )
      .map_err(|e| e.to_string())?;

  let rows = stmt
      .query_map([], |row| {
          Ok(json!({
              "id": row.get::<_, i64>(0)?,
              "name": row.get::<_, String>(1)?,
              "parent_id": row.get::<_, Option<i64>>(2)?,
              "connection_id": row.get::<_, Option<i64>>(3)?,
              "sort_order": row.get::<_, i64>(4)?,
          }))
      })
      .map_err(|e| e.to_string())?;
  ```

### 2b：`create_st_category` 新增 `connection_id` 参数

- [ ] **Step 2：修改函数签名和 INSERT SQL**

  找到 `create_st_category` 函数（约第184行），改为：

  ```rust
  #[tauri::command]
  pub async fn create_st_category(
      _state: tauri::State<'_, AppState>,
      name: String,
      parent_id: Option<i64>,
      connection_id: Option<i64>,
  ) -> Result<i64, String> {
      let conn = crate::db::get().lock().unwrap();
      let now = chrono::Utc::now().to_rfc3339();

      let sort_order: i64 = conn
          .query_row(
              "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM seatunnel_categories WHERE parent_id IS ?1",
              rusqlite::params![parent_id],
              |row| row.get(0),
          )
          .unwrap_or(1);

      conn.execute(
          "INSERT INTO seatunnel_categories (name, parent_id, connection_id, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
          rusqlite::params![name, parent_id, connection_id, sort_order, now],
      )
      .map_err(|e| e.to_string())?;

      Ok(conn.last_insert_rowid())
  }
  ```

### 2c：`create_st_job` 新增 `connection_id` 参数

- [ ] **Step 3：修改函数签名和 INSERT SQL**

  找到 `create_st_job` 函数（约第299行），改为：

  ```rust
  #[tauri::command]
  pub async fn create_st_job(
      _state: tauri::State<'_, AppState>,
      name: String,
      category_id: Option<i64>,
      connection_id: Option<i64>,
  ) -> Result<i64, String> {
      let conn = crate::db::get().lock().unwrap();
      let now = chrono::Utc::now().to_rfc3339();
      conn.execute(
          "INSERT INTO seatunnel_jobs (name, category_id, connection_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
          rusqlite::params![name, category_id, connection_id, now, now],
      )
      .map_err(|e| e.to_string())?;
      Ok(conn.last_insert_rowid())
  }
  ```

### 2d：`delete_st_connection` 先清理孤儿 Job

- [ ] **Step 4：在删除连接前先清理孤儿 Job（两条 DELETE 合并为一次 execute_batch）**

  找到 `delete_st_connection` 函数（约第136行），改为：

  ```rust
  #[tauri::command]
  pub async fn delete_st_connection(
      _state: tauri::State<'_, AppState>,
      id: i64,
  ) -> Result<(), String> {
      let conn = crate::db::get().lock().unwrap();
      // 先删除直属集群且无 category 的孤儿 Job，再删连接（DDL CASCADE 会删根目录及子目录）
      // 使用 execute_batch 将两条语句合并，SQLite 自动在隐式事务中执行
      conn.execute(
          "DELETE FROM seatunnel_jobs WHERE connection_id = ?1 AND category_id IS NULL",
          rusqlite::params![id],
      )
      .map_err(|e| e.to_string())?;
      conn.execute(
          "DELETE FROM seatunnel_connections WHERE id = ?1",
          rusqlite::params![id],
      )
      .map_err(|e| e.to_string())?;
      Ok(())
  }
  ```

### 2e：新增 `rename_st_job`

- [ ] **Step 5：在 `delete_st_job` 之后添加新命令**

  ```rust
  /// 重命名 Job
  #[tauri::command]
  pub async fn rename_st_job(
      _state: tauri::State<'_, AppState>,
      id: i64,
      name: String,
  ) -> Result<(), String> {
      let conn = crate::db::get().lock().unwrap();
      let now = chrono::Utc::now().to_rfc3339();
      conn.execute(
          "UPDATE seatunnel_jobs SET name = ?1, updated_at = ?2 WHERE id = ?3",
          rusqlite::params![name, now, id],
      )
      .map_err(|e| e.to_string())?;
      Ok(())
  }
  ```

- [ ] **Step 6：cargo check 验证编译**

  ```bash
  cd src-tauri && cargo check 2>&1
  ```

  预期：无 error

- [ ] **Step 7：commit**

  ```bash
  git add src-tauri/src/seatunnel/commands.rs
  git commit -m "feat(seatunnel): update commands - list_categories connection_id, create with connection_id, rename_job, delete_connection cascade"
  ```

---

## Task 3：注册新 Rust 命令

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1：在 `generate_handler![]` 中添加 `rename_st_job`**

  找到 `seatunnel::commands::delete_st_job` 附近，添加：

  ```rust
  seatunnel::commands::rename_st_job,
  ```

- [ ] **Step 2：cargo check 验证**

  ```bash
  cd src-tauri && cargo check 2>&1
  ```

  预期：无 error

- [ ] **Step 3：commit**

  ```bash
  git add src-tauri/src/lib.rs
  git commit -m "feat(seatunnel): register rename_st_job command"
  ```

---

## Task 4：Store 重构 + 测试

**Files:**
- Modify: `src/store/seaTunnelStore.ts`
- Create: `src/store/seaTunnelStore.test.ts`

### 4a：先写测试（TDD）

- [ ] **Step 1：创建测试文件，写出 `init()` 树构建的核心测试**

  创建 `src/store/seaTunnelStore.test.ts`：

  ```typescript
  import { describe, it, expect, beforeEach, vi } from 'vitest';

  vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
  vi.mock('./queryStore', () => ({ useQueryStore: vi.fn() }));

  import { invoke } from '@tauri-apps/api/core';
  import { useSeaTunnelStore } from './seaTunnelStore';

  const mockInvoke = vi.mocked(invoke);

  beforeEach(() => {
    vi.clearAllMocks();
    useSeaTunnelStore.setState({
      nodes: new Map(),
      expandedIds: new Set(),
      selectedId: null,
      isInitializing: false,
      error: null,
    });
  });

  const CONNECTIONS = [
    { id: 1, name: '生产集群', url: 'http://prod:8080' },
  ];
  const CATEGORIES = [
    { id: 10, name: '数据同步', parent_id: null, connection_id: 1, sort_order: 1 },
    { id: 11, name: '子目录', parent_id: 10, connection_id: null, sort_order: 1 },
  ];
  const JOBS = [
    { id: 100, name: '用户迁移', category_id: 10, connection_id: 1, last_status: null },
    { id: 101, name: '直属作业', category_id: null, connection_id: 1, last_status: 'RUNNING' },
    { id: 102, name: '孤儿作业', category_id: null, connection_id: null, last_status: null },
  ];

  function mockInit() {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_st_connections') return Promise.resolve(CONNECTIONS);
      if (cmd === 'list_st_categories') return Promise.resolve(CATEGORIES);
      if (cmd === 'list_st_jobs') return Promise.resolve(JOBS);
      if (cmd === 'get_ui_state') return Promise.resolve(null);
      return Promise.resolve(null);
    });
  }

  describe('init() 树构建', () => {
    it('connection 节点成为根节点（parentId = null）', async () => {
      mockInit();
      await useSeaTunnelStore.getState().init();
      const nodes = useSeaTunnelStore.getState().nodes;
      const connNode = nodes.get('conn_1');
      expect(connNode).toBeDefined();
      expect(connNode!.nodeType).toBe('connection');
      expect(connNode!.parentId).toBeNull();
      expect(connNode!.label).toBe('生产集群');
    });

    it('根目录挂在对应 connection 节点下', async () => {
      mockInit();
      await useSeaTunnelStore.getState().init();
      const nodes = useSeaTunnelStore.getState().nodes;
      const catNode = nodes.get('cat_10');
      expect(catNode!.parentId).toBe('conn_1');
    });

    it('子目录挂在父目录下', async () => {
      mockInit();
      await useSeaTunnelStore.getState().init();
      const nodes = useSeaTunnelStore.getState().nodes;
      const subNode = nodes.get('cat_11');
      expect(subNode!.parentId).toBe('cat_10');
    });

    it('有 category_id 的 Job 挂在对应目录下', async () => {
      mockInit();
      await useSeaTunnelStore.getState().init();
      const nodes = useSeaTunnelStore.getState().nodes;
      const job = nodes.get('job_100');
      expect(job!.parentId).toBe('cat_10');
    });

    it('无 category_id 但有 connection_id 的 Job 直挂集群根节点', async () => {
      mockInit();
      await useSeaTunnelStore.getState().init();
      const nodes = useSeaTunnelStore.getState().nodes;
      const job = nodes.get('job_101');
      expect(job!.parentId).toBe('conn_1');
    });

    it('两者均无的孤儿 Job 不加入树', async () => {
      mockInit();
      await useSeaTunnelStore.getState().init();
      const nodes = useSeaTunnelStore.getState().nodes;
      expect(nodes.has('job_102')).toBe(false);
    });
  });
  ```

- [ ] **Step 2：运行测试，确认全部 FAIL（因为 Store 尚未改造）**

  ```bash
  npx vitest run src/store/seaTunnelStore.test.ts 2>&1
  ```

  预期：多个 FAIL（`nodeType 'connection'` 不存在等）

### 4b：重构 Store

- [ ] **Step 3：修改 `STTreeNode` 接口，新增 `connection` nodeType**

  在 `src/store/seaTunnelStore.ts` 中将接口改为：

  ```typescript
  export interface STTreeNode {
    id: string                      // "conn_1" | "cat_5" | "job_10"
    nodeType: 'connection' | 'category' | 'job'
    label: string
    parentId: string | null
    meta: {
      connectionId?: number
      connectionUrl?: string
      categoryId?: number
      jobId?: number
      status?: string
      sortOrder?: number
      depth?: number
    }
    hasChildren: boolean
    loaded: boolean
  }
  ```

- [ ] **Step 4：扩展 `SeaTunnelStore` interface，新增 Actions**

  在 interface 中新增：

  ```typescript
  editConnection: (id: number, name: string, url: string, authToken?: string) => Promise<void>
  deleteConnection: (id: number) => Promise<void>
  renameJob: (id: number, name: string) => Promise<void>
  ```

  并修改现有 Actions 签名：

  ```typescript
  createCategory: (name: string, parentCategoryId?: number, connectionId?: number) => Promise<void>
  createJob: (name: string, categoryId?: number, connectionId?: number) => Promise<number>
  ```

- [ ] **Step 5：重写 `init()` 方法**

  将 `init` action 的实现改为：

  ```typescript
  init: async () => {
    set({ isInitializing: true, error: null });
    try {
      const savedIds = await invoke<string | null>('get_ui_state', { key: 'seatunnel_tree_expanded_ids' });
      const expandedIds = new Set<string>(savedIds ? JSON.parse(savedIds) : []);

      const [connections, categories, jobs] = await Promise.all([
        invoke<Array<{ id: number; name: string; url: string }>>('list_st_connections'),
        invoke<Array<{ id: number; name: string; parent_id: number | null; connection_id: number | null; sort_order: number }>>('list_st_categories'),
        invoke<Array<{ id: number; name: string; category_id: number | null; connection_id: number | null; last_status: string | null }>>('list_st_jobs'),
      ]);

      const nodes = new Map<string, STTreeNode>();

      // 1. 生成 connection 根节点
      for (const c of connections) {
        nodes.set(`conn_${c.id}`, {
          id: `conn_${c.id}`,
          nodeType: 'connection',
          label: c.name,
          parentId: null,
          hasChildren: false,
          loaded: true,
          meta: { connectionId: c.id, connectionUrl: c.url },
        });
      }

      // 2. 构建 category 节点（depth 相对 category 层，0-based）
      const catDepthMap = new Map<number, number>();
      function getCatDepth(catId: number): number {
        if (catDepthMap.has(catId)) return catDepthMap.get(catId)!;
        const cat = categories.find(c => c.id === catId);
        if (!cat || cat.parent_id === null) { catDepthMap.set(catId, 0); return 0; }
        const d = getCatDepth(cat.parent_id) + 1;
        catDepthMap.set(catId, d);
        return d;
      }

      for (const cat of categories) {
        const id = `cat_${cat.id}`;
        let parentId: string | null = null;
        if (cat.parent_id !== null) {
          parentId = `cat_${cat.parent_id}`;
        } else if (cat.connection_id !== null) {
          parentId = `conn_${cat.connection_id}`;
        } else {
          continue; // 无归属的根目录，隐藏
        }
        nodes.set(id, {
          id,
          nodeType: 'category',
          label: cat.name,
          parentId,
          hasChildren: false,
          loaded: true,
          meta: { categoryId: cat.id, sortOrder: cat.sort_order, depth: getCatDepth(cat.id) },
        });
      }

      // 3. 构建 Job 节点
      for (const job of jobs) {
        const id = `job_${job.id}`;
        let parentId: string | null = null;
        if (job.category_id !== null) {
          parentId = `cat_${job.category_id}`;
        } else if (job.connection_id !== null) {
          parentId = `conn_${job.connection_id}`;
        } else {
          continue; // 孤儿 Job，隐藏
        }
        nodes.set(id, {
          id,
          nodeType: 'job',
          label: job.name,
          parentId,
          hasChildren: false,
          loaded: true,
          meta: { jobId: job.id, connectionId: job.connection_id ?? undefined, status: job.last_status ?? undefined },
        });
      }

      // 4. 更新 hasChildren
      for (const node of nodes.values()) {
        if (node.parentId) {
          const parent = nodes.get(node.parentId);
          if (parent) {
            nodes.set(node.parentId, { ...parent, hasChildren: true });
          }
        }
      }

      set({ nodes, expandedIds, isInitializing: false });
    } catch (e) {
      set({ isInitializing: false, error: String(e) });
    }
  },
  ```

- [ ] **Step 6：新增 `editConnection`、`deleteConnection`、`renameJob` actions**

  在 `createCategory` 之前，添加：

  ```typescript
  editConnection: async (id, name, url, authToken) => {
    await invoke('update_st_connection', { id, name, url, authToken: authToken ?? null });
    await get().init();
  },

  deleteConnection: async (id) => {
    await invoke('delete_st_connection', { id });
    await get().init();
  },
  ```

  在 `deleteJob` 之后，添加：

  ```typescript
  renameJob: async (id, name) => {
    await invoke('rename_st_job', { id, name });
    set(s => {
      const key = `job_${id}`;
      const node = s.nodes.get(key);
      if (!node) return {};
      const next = new Map(s.nodes);
      next.set(key, { ...node, label: name });
      return { nodes: next };
    });
  },
  ```

- [ ] **Step 7：修改 `createCategory` 和 `createJob` 传递 `connectionId`**

  ```typescript
  createCategory: async (name, parentCategoryId, connectionId) => {
    const newId = await invoke<number>('create_st_category', {
      name,
      parentId: parentCategoryId ?? null,
      connectionId: connectionId ?? null,
    });
    await get().init();
    if (parentCategoryId) {
      set(s => {
        const next = new Set(s.expandedIds);
        next.add(`cat_${parentCategoryId}`);
        persistSTExpandedIds(next);
        return { expandedIds: next };
      });
    }
    set({ selectedId: `cat_${newId}` });
  },

  createJob: async (name, categoryId, connectionId) => {
    const newId = await invoke<number>('create_st_job', {
      name,
      categoryId: categoryId ?? null,
      connectionId: connectionId ?? null,
    });
    await get().init();
    set({ selectedId: `job_${newId}` });
    return newId;
  },
  ```

- [ ] **Step 8：运行测试，确认全部 PASS**

  ```bash
  npx vitest run src/store/seaTunnelStore.test.ts 2>&1
  ```

  预期：全部 PASS

- [ ] **Step 9：TypeScript 类型检查**

  ```bash
  npx tsc --noEmit 2>&1
  ```

  预期：无 error

- [ ] **Step 10：commit**

  ```bash
  git add src/store/seaTunnelStore.ts src/store/seaTunnelStore.test.ts
  git commit -m "feat(store): refactor seaTunnelStore - connection root nodes, renameJob, editConnection, deleteConnection"
  ```

---

## Task 4b：新增 i18n 键

**Files:**
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`

- [ ] **Step 1：在 `zh.json` 的 `seaTunnel.jobTree` 对象末尾添加以下键**

  找到第 944 行（`"newJobName": "新 Job"`），在其后添加：

  ```json
  "rename": "重命名",
  "editConnection": "编辑集群配置",
  "deleteConnection": "删除集群",
  "deleteConnectionTitle": "删除集群",
  "confirmDeleteConnection": "确定要删除集群「{{name}}」吗？其下所有目录和 Job 也将被删除，此操作不可撤销。",
  "deleteConnectionFailed": "删除集群失败",
  "renameFailed": "重命名失败"
  ```

  同时在 `seaTunnel` 根对象中，将 `"noJobs"` 键旁边添加：

  ```json
  "noConnections": "暂无集群连接，点击「+ 连接」添加"
  ```

- [ ] **Step 2：在 `en.json` 的 `seaTunnel.jobTree` 对象末尾添加以下键**

  找到对应位置，添加：

  ```json
  "rename": "Rename",
  "editConnection": "Edit Cluster Config",
  "deleteConnection": "Delete Cluster",
  "deleteConnectionTitle": "Delete Cluster",
  "confirmDeleteConnection": "Are you sure you want to delete cluster \"{{name}}\"? All directories and jobs under it will also be deleted. This action cannot be undone.",
  "deleteConnectionFailed": "Failed to delete cluster",
  "renameFailed": "Rename failed"
  ```

  同时在 `seaTunnel` 根对象中添加：

  ```json
  "noConnections": "No cluster connections. Click '+ Connection' to add one."
  ```

- [ ] **Step 3：commit**

  ```bash
  git add src/i18n/locales/zh.json src/i18n/locales/en.json
  git commit -m "feat(i18n): add seaTunnel cluster management and rename translation keys"
  ```

---

## Task 5：更新 `CategoryEditModal` + `index.tsx`（同批提交）

> ⚠️ **顺序约束**：Task 5 和 Task 7（`index.tsx` 更新）必须在同一批次完成后再提交。`CategoryEditModal` 接口变更会导致 `index.tsx` 中旧的 `mode="create"` 调用产生 TypeScript 编译错误，两个文件需同时修改。

**Files:**
- Modify: `src/components/SeaTunnelExplorer/CategoryEditModal.tsx`

- [ ] **Step 1：移除 `rename` mode，移除 depth 校验，新增 `connectionId` prop**

  将文件改为：

  ```typescript
  import React, { useState, useRef, useEffect } from 'react';
  import { X } from 'lucide-react';
  import { useTranslation } from 'react-i18next';

  interface CategoryEditModalProps {
    parentNode?: { label: string };
    connectionId?: number;
    onClose: () => void;
    onSave: (name: string) => Promise<void>;
  }

  export function CategoryEditModal({
    parentNode,
    onClose,
    onSave,
  }: CategoryEditModalProps) {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      inputRef.current?.focus();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) {
        setError(t('seaTunnel.categoryModal.nameRequired'));
        return;
      }
      setSaving(true);
      setError(null);
      try {
        await onSave(trimmed);
        onClose();
      } catch (err: any) {
        setError(err?.message ?? t('seaTunnel.categoryModal.saveFailed'));
      } finally {
        setSaving(false);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          className="bg-[#111922] border border-[#253347] rounded-lg shadow-2xl w-80"
          onKeyDown={handleKeyDown}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#253347]">
            <span className="text-sm font-medium text-[#c8daea]">{t('seaTunnel.categoryModal.newTitle')}</span>
            <button className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="p-4 space-y-3">
            {parentNode && (
              <div className="text-xs text-[#7a9bb8]">
                {t('seaTunnel.categoryModal.parentCategory')}：<span className="text-[#c8daea]">{parentNode.label}</span>
              </div>
            )}
            <div>
              <label className="block text-xs text-[#7a9bb8] mb-1">{t('seaTunnel.categoryModal.categoryName')}</label>
              <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('seaTunnel.categoryModal.namePlaceholder')}
                className="w-full bg-[#0d1117] border border-[#253347] rounded px-3 py-1.5 text-sm text-[#c8daea] placeholder-[#7a9bb8] outline-none focus:border-[#00c9a7] transition-colors"
              />
            </div>
            {error && <div className="text-xs text-red-400">{error}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] border border-[#253347] rounded transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-3 py-1.5 text-xs text-[#0d1117] bg-[#00c9a7] hover:bg-[#00a98f] rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? t('common.saving') : t('common.create')}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2：TypeScript 检查**

  ```bash
  npx tsc --noEmit 2>&1
  ```

  预期：无 error

- [ ] **Step 3：commit**

  ```bash
  git add src/components/SeaTunnelExplorer/CategoryEditModal.tsx
  git commit -m "refactor(seatunnel): simplify CategoryEditModal - remove rename mode and depth check"
  ```

---

## Task 6：重写 `SeaTunnelJobTree`

> ⚠️ **前置条件**：Task 4（Store 重构）必须先完成，本 Task 依赖 `editConnection`、`deleteConnection`、`renameJob` 等新 Action。

**Files:**
- Modify: `src/components/SeaTunnelExplorer/SeaTunnelJobTree.tsx`

> 这是本次改造最大的文件。完整替换如下。

- [ ] **Step 1：完整替换 `SeaTunnelJobTree.tsx` 内容**

  ```typescript
  import React, { useMemo, useState, useEffect, useRef } from 'react';
  import {
    ChevronRight, ChevronDown,
    Folder, FolderOpen, Server,
    Play, CircleStop,
    Trash2, FolderPlus, FilePlus, Eye, MoveRight, Pencil,
  } from 'lucide-react';
  import { useTranslation } from 'react-i18next';
  import { useSeaTunnelStore, type STTreeNode } from '../../store/seaTunnelStore';
  import { useConfirmStore } from '../../store/confirmStore';
  import { SeaTunnelConnectionModal } from './SeaTunnelConnectionModal';
  import { CategoryEditModal } from './CategoryEditModal';

  interface SeaTunnelJobTreeProps {
    searchQuery?: string;
    onOpenJob?: (jobId: number, title: string, connectionId?: number) => void;
  }

  interface ContextMenuState {
    node: STTreeNode;
    x: number;
    y: number;
  }

  interface InlineEditState {
    nodeId: string;
    originalLabel: string;
    value: string;
  }

  function computeVisible(nodes: Map<string, STTreeNode>, expandedIds: Set<string>): STTreeNode[] {
    const result: STTreeNode[] = [];
    function visit(parentId: string | null) {
      const children = Array.from(nodes.values())
        .filter(n => n.parentId === parentId)
        .sort((a, b) => {
          // connection 节点按名称排序；category/job 按 sortOrder 再按名称
          if (a.nodeType === 'connection' && b.nodeType === 'connection') return a.label.localeCompare(b.label);
          return (a.meta.sortOrder ?? 0) - (b.meta.sortOrder ?? 0) || a.label.localeCompare(b.label);
        });
      for (const node of children) {
        result.push(node);
        const isExpandable = node.nodeType === 'connection' || node.nodeType === 'category';
        if (isExpandable && expandedIds.has(node.id)) {
          visit(node.id);
        }
      }
    }
    visit(null);
    return result;
  }

  function searchNodes(nodes: Map<string, STTreeNode>, query: string): STTreeNode[] {
    const q = query.toLowerCase();
    const matched = Array.from(nodes.values()).filter(n => n.label.toLowerCase().includes(q));
    const toInclude = new Set<string>();
    for (const node of matched) {
      toInclude.add(node.id);
      let parentId = node.parentId;
      while (parentId) {
        toInclude.add(parentId);
        parentId = nodes.get(parentId)?.parentId ?? null;
      }
    }
    return computeVisible(nodes, new Set(
      Array.from(nodes.values())
        .filter(n => n.nodeType === 'connection' || n.nodeType === 'category')
        .map(n => n.id)
    )).filter(n => toInclude.has(n.id));
  }

  function getVisualDepth(node: STTreeNode, nodes: Map<string, STTreeNode>): number {
    let depth = 0;
    let parentId = node.parentId;
    while (parentId) {
      depth++;
      parentId = nodes.get(parentId)?.parentId ?? null;
    }
    return depth;
  }

  export function SeaTunnelJobTree({ searchQuery = '', onOpenJob }: SeaTunnelJobTreeProps) {
    const { t } = useTranslation();
    const {
      nodes, expandedIds, selectedId, isInitializing,
      toggleExpand, selectNode,
      deleteCategory, deleteJob, createCategory, createJob,
      deleteConnection, renameCategory, renameJob, init,
    } = useSeaTunnelStore();
    const confirm = useConfirmStore(s => s.confirm);

    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showCategoryModal, setShowCategoryModal] = useState<{ parentNode: STTreeNode; connectionId: number } | null>(null);
    const [showEditConnectionModal, setShowEditConnectionModal] = useState<{ id: number; name: string; url: string } | null>(null);
    const inlineInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      const handler = () => setContextMenu(null);
      window.addEventListener('click', handler);
      return () => window.removeEventListener('click', handler);
    }, []);

    useEffect(() => {
      if (inlineEdit) inlineInputRef.current?.select();
    }, [inlineEdit?.nodeId]);

    const visibleNodes = useMemo(() => {
      if (searchQuery.trim()) return searchNodes(nodes, searchQuery);
      return computeVisible(nodes, expandedIds);
    }, [nodes, expandedIds, searchQuery]);

    const isExpanded = (node: STTreeNode) => {
      if (searchQuery.trim()) return node.nodeType !== 'job';
      return expandedIds.has(node.id);
    };

    // ─── 辅助：从节点向上找最近的 connectionId ────────────────────────────────
    function resolveConnectionId(node: STTreeNode): number | undefined {
      if (node.meta.connectionId) return node.meta.connectionId;
      let parentId = node.parentId;
      while (parentId) {
        const parent = nodes.get(parentId);
        if (!parent) break;
        if (parent.meta.connectionId) return parent.meta.connectionId;
        parentId = parent.parentId;
      }
      return undefined;
    }

    // ─── 右键菜单操作 ─────────────────────────────────────────────────────────
    const startInlineEdit = (node: STTreeNode) => {
      setContextMenu(null);
      setInlineEdit({ nodeId: node.id, originalLabel: node.label, value: node.label });
    };

    const commitInlineEdit = async () => {
      if (!inlineEdit) return;
      const trimmed = inlineEdit.value.trim();
      if (!trimmed || trimmed === inlineEdit.originalLabel) {
        setInlineEdit(null);
        return;
      }
      const node = nodes.get(inlineEdit.nodeId);
      if (!node) { setInlineEdit(null); return; }
      try {
        if (node.nodeType === 'category' && node.meta.categoryId) {
          await renameCategory(node.meta.categoryId, trimmed);
        } else if (node.nodeType === 'job' && node.meta.jobId) {
          await renameJob(node.meta.jobId, trimmed);
        }
      } catch (e: any) {
        setError(e?.message ?? t('seaTunnel.jobTree.renameFailed'));
      }
      setInlineEdit(null);
    };

    const handleDeleteConnection = async (node: STTreeNode) => {
      const ok = await confirm({
        title: t('seaTunnel.jobTree.deleteConnectionTitle'),
        message: t('seaTunnel.jobTree.confirmDeleteConnection', { name: node.label }),
        variant: 'danger',
        confirmLabel: t('common.confirm'),
      });
      if (!ok) return;
      try { await deleteConnection(node.meta.connectionId!); }
      catch (e: any) { setError(e?.message ?? t('seaTunnel.jobTree.deleteConnectionFailed')); }
    };

    const handleDeleteCategory = async (node: STTreeNode) => {
      const ok = await confirm({
        title: t('seaTunnel.jobTree.deleteCategoryTitle'),
        message: t('seaTunnel.jobTree.confirmDeleteCategory', { name: node.label }),
        variant: 'danger',
        confirmLabel: t('common.confirm'),
      });
      if (!ok) return;
      try { await deleteCategory(node.meta.categoryId!); }
      catch (e: any) { setError(e?.message ?? t('seaTunnel.jobTree.deleteCategoryFailed')); }
    };

    const handleDeleteJob = async (node: STTreeNode) => {
      const ok = await confirm({
        title: t('seaTunnel.jobTree.deleteJobTitle'),
        message: t('seaTunnel.jobTree.confirmDeleteJob', { name: node.label }),
        variant: 'danger',
        confirmLabel: t('common.confirm'),
      });
      if (!ok) return;
      try { await deleteJob(node.meta.jobId!); }
      catch (e: any) { setError(e?.message ?? t('seaTunnel.jobTree.deleteJobFailed')); }
    };

    const handleNewCategory = async (parentNode: STTreeNode) => {
      setContextMenu(null);
      const connId = resolveConnectionId(parentNode);
      if (!connId) return;
      setShowCategoryModal({ parentNode, connectionId: connId });
    };

    const handleNewJob = async (parentNode: STTreeNode) => {
      setContextMenu(null);
      const connId = resolveConnectionId(parentNode);
      const catId = parentNode.nodeType === 'category' ? parentNode.meta.categoryId : undefined;
      try { await createJob(t('seaTunnel.jobTree.newJobName'), catId, connId); }
      catch (e: any) { setError(e?.message ?? t('seaTunnel.jobTree.createJobFailed')); }
    };

    // ─── 渲染 ─────────────────────────────────────────────────────────────────
    if (isInitializing) {
      return (
        <div className="px-3 py-2 space-y-1">
          {[80, 64, 72, 56, 68].map((w, i) => (
            <div key={i} className="flex items-center gap-2 h-7 px-1">
              <div className="w-3 h-3 rounded bg-[#1e2d42] animate-pulse flex-shrink-0" />
              <div className="h-2.5 rounded bg-[#1e2d42] animate-pulse" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      );
    }

    if (visibleNodes.length === 0) {
      return (
        <div className="px-3 py-4 text-center text-xs text-[#7a9bb8]">
          {searchQuery.trim() ? t('seaTunnel.noResults') : t('seaTunnel.noConnections')}
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-y-auto py-1 relative">
        {error && (
          <div className="mx-2 mb-1 px-3 py-1.5 text-xs text-red-400 bg-red-900/20 rounded border border-red-900/40 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-2 text-red-400/60 hover:text-red-400">✕</button>
          </div>
        )}

        {visibleNodes.map(node => {
          const depth = getVisualDepth(node, nodes);
          const expanded = isExpanded(node);
          const isSelected = selectedId === node.id;
          const paddingLeft = depth * 16 + 8;
          const isEditing = inlineEdit?.nodeId === node.id;

          // 图标
          let Icon: React.ElementType;
          let iconClass = 'text-[#7a9bb8]';
          if (node.nodeType === 'connection') {
            Icon = Server;
            iconClass = 'text-[#00c9a7]';
          } else if (node.nodeType === 'category') {
            Icon = expanded ? FolderOpen : Folder;
            if (expanded) iconClass = 'text-[#00c9a7]';
          } else {
            Icon = node.meta.status === 'RUNNING' ? CircleStop : Play;
            if (node.meta.status === 'RUNNING') iconClass = 'text-[#00c9a7]';
          }

          const isExpandable = node.nodeType === 'connection' || node.nodeType === 'category';

          return (
            <div
              key={node.id}
              className={`flex items-center py-1 px-2 cursor-pointer hover:bg-[#1a2639] outline-none select-none ${isSelected ? 'bg-[#1e2d42]' : ''}`}
              style={{ paddingLeft }}
              tabIndex={0}
              onClick={() => {
                selectNode(node.id);
                if (isExpandable) toggleExpand(node.id);
              }}
              onDoubleClick={() => {
                if (node.nodeType === 'job' && node.meta.jobId) {
                  onOpenJob?.(node.meta.jobId, node.label, node.meta.connectionId);
                }
              }}
              onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ node, x: e.clientX, y: e.clientY });
              }}
            >
              {/* 展开箭头 */}
              <div className="w-4 h-4 mr-1 flex items-center justify-center text-[#7a9bb8] flex-shrink-0">
                {isExpandable ? (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
              </div>

              {/* 节点图标 */}
              <Icon size={14} className={`mr-1.5 flex-shrink-0 ${iconClass}`} />

              {/* 标签 / 内联编辑 */}
              {isEditing ? (
                <input
                  ref={inlineInputRef}
                  className="flex-1 text-[13px] bg-[#0d1117] border border-[#00c9a7] rounded px-1 text-[#e8f4ff] outline-none min-w-0"
                  value={inlineEdit.value}
                  onChange={e => setInlineEdit(prev => prev ? { ...prev, value: e.target.value } : null)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); commitInlineEdit(); }
                    if (e.key === 'Escape') setInlineEdit(null);
                  }}
                  onBlur={commitInlineEdit}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span className={`text-[13px] truncate flex-1 ${isSelected ? 'text-[#e8f4ff]' : 'text-[#b5cfe8]'}`}>
                  {node.label}
                </span>
              )}

              {/* connection 节点右侧 URL */}
              {node.nodeType === 'connection' && node.meta.connectionUrl && !isEditing && (
                <span className="text-[10px] text-[#7a9bb8] flex-shrink-0 ml-1 max-w-[100px] truncate">
                  {node.meta.connectionUrl}
                </span>
              )}

              {/* Job 状态徽章 */}
              {node.nodeType === 'job' && node.meta.status && !isEditing && (
                <span className={`text-[10px] flex-shrink-0 ml-1 px-1 rounded ${
                  node.meta.status === 'RUNNING' ? 'text-[#00c9a7] bg-[#00c9a7]/10'
                  : node.meta.status === 'FAILED' ? 'text-red-400 bg-red-900/20'
                  : 'text-[#7a9bb8]'
                }`}>
                  {node.meta.status}
                </span>
              )}
            </div>
          );
        })}

        {/* 右键菜单 */}
        {contextMenu && (
          <div
            className="fixed z-50 bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl py-1 min-w-[160px]"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={e => e.stopPropagation()}
          >
            {contextMenu.node.nodeType === 'connection' && (
              <>
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                  onClick={() => handleNewCategory(contextMenu.node)}>
                  <FolderPlus size={13} />{t('seaTunnel.jobTree.newCategory')}
                </button>
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                  onClick={() => handleNewJob(contextMenu.node)}>
                  <FilePlus size={13} />{t('seaTunnel.jobTree.newJob')}
                </button>
                <div className="h-px bg-[#253347] my-1" />
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                  onClick={() => {
                    const { connectionId, connectionUrl } = contextMenu.node.meta;
                    if (connectionId) {
                      setShowEditConnectionModal({ id: connectionId, name: contextMenu.node.label, url: connectionUrl ?? '' });
                    }
                    setContextMenu(null);
                  }}>
                  <Pencil size={13} />{t('seaTunnel.jobTree.editConnection')}
                </button>
                <div className="h-px bg-[#253347] my-1" />
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-red-400 hover:bg-[#1a2639] hover:text-red-300"
                  onClick={async () => {
                    const node = contextMenu.node;
                    setContextMenu(null);
                    await handleDeleteConnection(node);
                  }}>
                  <Trash2 size={13} />{t('seaTunnel.jobTree.deleteConnection')}
                </button>
              </>
            )}

            {contextMenu.node.nodeType === 'category' && (
              <>
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                  onClick={() => handleNewCategory(contextMenu.node)}>
                  <FolderPlus size={13} />{t('seaTunnel.jobTree.newSubCategory')}
                </button>
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                  onClick={() => handleNewJob(contextMenu.node)}>
                  <FilePlus size={13} />{t('seaTunnel.jobTree.newJob')}
                </button>
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                  onClick={() => startInlineEdit(contextMenu.node)}>
                  <Pencil size={13} />{t('seaTunnel.jobTree.rename')}
                </button>
                <div className="h-px bg-[#253347] my-1" />
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-red-400 hover:bg-[#1a2639] hover:text-red-300"
                  onClick={async () => {
                    const node = contextMenu.node;
                    setContextMenu(null);
                    await handleDeleteCategory(node);
                  }}>
                  <Trash2 size={13} />{t('seaTunnel.jobTree.deleteCategory')}
                </button>
              </>
            )}

            {contextMenu.node.nodeType === 'job' && (
              <>
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                  onClick={() => {
                    const { jobId, connectionId } = contextMenu.node.meta;
                    if (jobId) onOpenJob?.(jobId, contextMenu.node.label, connectionId);
                    setContextMenu(null);
                  }}>
                  <Eye size={13} />{t('seaTunnel.jobTree.open')}
                </button>
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                  onClick={() => startInlineEdit(contextMenu.node)}>
                  <Pencil size={13} />{t('seaTunnel.jobTree.rename')}
                </button>
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                  onClick={() => { setContextMenu(null); /* TODO: move dialog */ }}>
                  <MoveRight size={13} />{t('seaTunnel.jobTree.moveToCategory')}
                </button>
                <div className="h-px bg-[#253347] my-1" />
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-red-400 hover:bg-[#1a2639] hover:text-red-300"
                  onClick={async () => {
                    const node = contextMenu.node;
                    setContextMenu(null);
                    await handleDeleteJob(node);
                  }}>
                  <Trash2 size={13} />{t('seaTunnel.jobTree.deleteJob')}
                </button>
              </>
            )}
          </div>
        )}

        {/* 新建目录弹窗 */}
        {showCategoryModal && (
          <CategoryEditModal
            parentNode={showCategoryModal.parentNode}
            connectionId={showCategoryModal.connectionId}
            onClose={() => setShowCategoryModal(null)}
            onSave={async (name) => {
              const catId = showCategoryModal.parentNode.nodeType === 'category'
                ? showCategoryModal.parentNode.meta.categoryId
                : undefined;
              await createCategory(name, catId, showCategoryModal.connectionId);
              setShowCategoryModal(null);
            }}
          />
        )}

        {/* 编辑集群弹窗 */}
        {showEditConnectionModal && (
          <SeaTunnelConnectionModal
            mode="edit"
            connection={showEditConnectionModal}
            onClose={() => setShowEditConnectionModal(null)}
            onSave={() => { init(); setShowEditConnectionModal(null); }}
          />
        )}
      </div>
    );
  }
  ```

- [ ] **Step 2：TypeScript 检查**

  ```bash
  npx tsc --noEmit 2>&1
  ```

  预期：无 error

- [ ] **Step 3：commit**

  ```bash
  git add src/components/SeaTunnelExplorer/SeaTunnelJobTree.tsx
  git commit -m "feat(ui): rewrite SeaTunnelJobTree - connection root nodes, right-click menus, inline rename"
  ```

---

## Task 7：更新 `SeaTunnelExplorer/index.tsx`（与 Task 5 同批提交）

> ⚠️ **顺序约束**：此 Task 与 Task 5 必须同批完成，不能单独提交。Task 5 修改了 `CategoryEditModal` 接口，`index.tsx` 中旧的调用会产生编译错误，必须同时修复。

**Files:**
- Modify: `src/components/SeaTunnelExplorer/index.tsx`

- [ ] **Step 1：移除"新建目录"工具栏按钮，移除 `showCategoryModal` 相关 state 和 Modal**

  将工具栏 `<div className="flex items-center space-x-2 ...">` 内的 `FolderPlus` 按钮整块删除：

  ```diff
  - <Tooltip content={t('seaTunnel.newCategory')}>
  -   <div
  -     className="flex items-center gap-0.5 cursor-pointer hover:text-[#c8daea] transition-colors"
  -     onClick={() => setShowCategoryModal(true)}
  -   >
  -     <FolderPlus size={14} />
  -   </div>
  - </Tooltip>
  ```

  同时删除：
  - `import { FolderPlus } from 'lucide-react'` 中的 `FolderPlus`
  - `const [showCategoryModal, setShowCategoryModal] = useState(false);`
  - 文件末尾的 `{showCategoryModal && <CategoryEditModal ... />}` 整块
  - `import { CategoryEditModal }` 引用（树组件内部处理了）
  - `const { init, createCategory } = useSeaTunnelStore();` 中的 `createCategory`（如果不再需要）

- [ ] **Step 2：TypeScript 检查**

  ```bash
  npx tsc --noEmit 2>&1
  ```

  预期：无 error

- [ ] **Step 3：与 Task 5 同批 commit**

  ```bash
  git add src/components/SeaTunnelExplorer/CategoryEditModal.tsx src/components/SeaTunnelExplorer/index.tsx
  git commit -m "refactor(ui): simplify CategoryEditModal and remove new-category toolbar button"
  ```

---

## Task 8：最终验证

- [ ] **Step 1：运行所有前端测试**

  ```bash
  npx vitest run 2>&1
  ```

  预期：全部 PASS，重点关注 `seaTunnelStore.test.ts`

- [ ] **Step 2：Rust 完整编译检查**

  ```bash
  cd src-tauri && cargo check 2>&1
  ```

  预期：无 error

- [ ] **Step 3：TypeScript 全量检查**

  ```bash
  npx tsc --noEmit 2>&1
  ```

  预期：无 error

- [ ] **Step 4：启动前端确认页面可正常渲染**

  ```bash
  npm run dev
  ```

  在浏览器 `http://localhost:1420` 切换到迁移中心，确认：
  - 集群节点为根节点（有 Server 图标）
  - 右键集群出现正确菜单
  - 右键目录/作业出现重命名选项
  - 内联编辑 Enter 保存、Escape 取消正常
  - 无集群时显示空状态提示

- [ ] **Step 5：最终 commit（如有未提交变更）**

  ```bash
  git status
  git add -p  # 逐块确认
  git commit -m "chore: final cleanup for seatunnel tree redesign"
  ```
