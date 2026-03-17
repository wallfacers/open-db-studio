# UI 状态全量持久化 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将所有 UI 状态（树展开、已打开连接、查询标签页）从 localStorage 迁移到内置 SQLite，SQL 内容改为本地文件，重启后完整恢复树状态，连接不可用时优雅降级。

**Architecture:** Rust 后端新增 8 个命令操作 SQLite `ui_state` 表和 `AppData/tabs/` 文件；前端各 store 订阅状态变化防抖写入；Explorer 启动时深度优先恢复展开树，先用 `test_connection` 检测可用性再决定是否展开。

**Tech Stack:** Rust (rusqlite, tauri), React 18, Zustand, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-17-ui-state-persistence-design.md`

---

## Chunk 1: 后端基础设施

### Task 1: 新增 ui_state 表

**Files:**
- Modify: `schema/init.sql`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: 在 init.sql 末尾追加 ui_state 表**

```sql
-- UI 状态持久化（树展开、标签页、已打开连接等）
CREATE TABLE IF NOT EXISTS ui_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: 确认 db 初始化时会执行完整 init.sql**

读取 `src-tauri/src/db/mod.rs`，确认 `execute_batch` 调用了完整 schema 字符串。如果是 include_str! 方式则无需改动。

- [ ] **Step 3: 编译检查**

```bash
cd src-tauri && cargo check
```

Expected: 无 error

- [ ] **Step 4: Commit**

```bash
git add schema/init.sql
git commit -m "feat(db): add ui_state table for UI persistence"
```

---

### Task 2: 实现 ui_state CRUD 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 commands.rs 新增 get_ui_state**

在文件末尾（注册区之前）添加：

```rust
#[tauri::command]
pub async fn get_ui_state(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT value FROM ui_state WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_row(rusqlite::params![key], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn set_ui_state(
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO ui_state (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_ui_state(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM ui_state WHERE key = ?1",
        rusqlite::params![key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 2: 在 lib.rs 注册这 3 个命令**

找到 `generate_handler![` 列表，追加：

```rust
get_ui_state,
set_ui_state,
delete_ui_state,
```

- [ ] **Step 3: 编译检查**

```bash
cd src-tauri && cargo check
```

Expected: 无 error

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(backend): add get/set/delete_ui_state commands"
```

---

### Task 3: 实现 tab 文件管理命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 commands.rs 新增 4 个文件命令**

```rust
use tauri::Manager;
use std::fs;

fn tabs_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let tabs_dir = data_dir.join("tabs");
    if !tabs_dir.exists() {
        fs::create_dir_all(&tabs_dir).map_err(|e| e.to_string())?;
    }
    Ok(tabs_dir)
}

#[tauri::command]
pub async fn read_tab_file(
    app_handle: tauri::AppHandle,
    tab_id: String,
) -> Result<Option<String>, String> {
    let path = tabs_dir(&app_handle)?.join(format!("{}.sql", tab_id));
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn write_tab_file(
    app_handle: tauri::AppHandle,
    tab_id: String,
    content: String,
) -> Result<(), String> {
    let path = tabs_dir(&app_handle)?.join(format!("{}.sql", tab_id));
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_tab_file(
    app_handle: tauri::AppHandle,
    tab_id: String,
) -> Result<(), String> {
    let path = tabs_dir(&app_handle)?.join(format!("{}.sql", tab_id));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_tab_files(
    app_handle: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    let dir = tabs_dir(&app_handle)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let ids: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".sql").map(|s| s.to_string())
        })
        .collect();
    Ok(ids)
}
```

- [ ] **Step 2: 在 lib.rs 注册这 4 个命令**

```rust
read_tab_file,
write_tab_file,
delete_tab_file,
list_tab_files,
```

- [ ] **Step 3: 编译检查**

```bash
cd src-tauri && cargo check
```

Expected: 无 error

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(backend): add tab file management commands"
```

---

## Chunk 2: 前端 Store 迁移

### Task 4: 迁移 connectionStore

**Files:**
- Modify: `src/store/connectionStore.ts`

- [ ] **Step 1: 读取 connectionStore.ts，找到 localStorage 相关代码**

定位 `OPENED_CONNECTIONS_KEY`、`saveOpenedConnectionIds`、`loadOpenedConnectionIds` 函数。

- [ ] **Step 2: 替换为 invoke 调用**

删除旧的 localStorage 函数，改为：

```typescript
import { invoke } from '@tauri-apps/api/core';

const UI_STATE_KEY = 'opened_connection_ids';

async function saveOpenedConnectionIds(ids: Set<number>): Promise<void> {
  try {
    await invoke('set_ui_state', { key: UI_STATE_KEY, value: JSON.stringify([...ids]) });
  } catch {}
}

export async function loadOpenedConnectionIds(): Promise<number[]> {
  try {
    const raw = await invoke<string | null>('get_ui_state', { key: UI_STATE_KEY });
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((id): id is number => typeof id === 'number');
    return [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: 确保调用方已改为 await**

检查 `openConnection` 和 `closeConnection` 中调用 `saveOpenedConnectionIds` 的地方，确保使用 `await`（若原来是同步调用则需要改为 async）。

- [ ] **Step 4: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无 error

- [ ] **Step 5: Commit**

```bash
git add src/store/connectionStore.ts
git commit -m "feat(store): migrate opened_connection_ids from localStorage to SQLite"
```

---

### Task 5: 迁移 queryStore（元数据 + SQL 文件）

**Files:**
- Modify: `src/store/queryStore.ts`

- [ ] **Step 1: 读取 queryStore.ts，找到所有 localStorage 引用**

定位 `unified_tabs_state`、`metrics_tabs_state`、`saveTabsToStorage`、`loadTabsFromStorage`。

- [ ] **Step 2: 改写 loadTabsFromStorage 为异步函数，从 SQLite 读元数据，从文件读 SQL**

```typescript
export async function loadTabsFromStorage(): Promise<{
  tabs: Tab[];
  activeTabId: string;
  sqlContent: Record<string, string>;
}> {
  try {
    // 1. 读元数据
    const rawMeta = await invoke<string | null>('get_ui_state', { key: 'tabs_metadata' });
    const rawActiveId = await invoke<string | null>('get_ui_state', { key: 'active_tab_id' });

    let tabs: Tab[] = [];
    if (rawMeta) {
      const parsed: unknown = JSON.parse(rawMeta);
      if (Array.isArray(parsed)) tabs = parsed as Tab[];
    }

    // 2. 孤儿文件清理
    const existingFiles = await invoke<string[]>('list_tab_files');
    const tabIds = new Set(tabs.map(t => t.id));
    await Promise.allSettled(
      existingFiles
        .filter(id => !tabIds.has(id))
        .map(id => invoke('delete_tab_file', { tabId: id }))
    );

    // 3. 读每个 tab 的 SQL 文件
    const sqlContent: Record<string, string> = {};
    await Promise.allSettled(
      tabs.map(async (tab) => {
        const sql = await invoke<string | null>('read_tab_file', { tabId: tab.id });
        if (sql != null) sqlContent[tab.id] = sql;
      })
    );

    // 4. 兼容旧 localStorage（一次性迁移）
    if (tabs.length === 0) {
      const oldRaw = localStorage.getItem('unified_tabs_state') ?? localStorage.getItem('metrics_tabs_state');
      if (oldRaw) {
        const old = JSON.parse(oldRaw);
        tabs = (old.tabs ?? []) as Tab[];
        const oldSql: Record<string, string> = old.sqlContent ?? {};
        // 迁移旧 SQL 到文件
        await Promise.allSettled(
          Object.entries(oldSql).map(([id, sql]) =>
            invoke('write_tab_file', { tabId: id, content: sql })
          )
        );
        Object.assign(sqlContent, oldSql);
        localStorage.removeItem('unified_tabs_state');
        localStorage.removeItem('metrics_tabs_state');
      }
    }

    return { tabs, activeTabId: rawActiveId ?? '', sqlContent };
  } catch {
    return { tabs: [], activeTabId: '', sqlContent: {} };
  }
}
```

- [ ] **Step 3: 改写持久化订阅，分离元数据和 SQL**

删除原来的 `localStorage.setItem` 订阅，改为：

```typescript
// 持久化元数据（防抖 500ms）
let saveMetaTimer: ReturnType<typeof setTimeout> | null = null;
useQueryStore.subscribe((state) => {
  if (saveMetaTimer) clearTimeout(saveMetaTimer);
  saveMetaTimer = setTimeout(async () => {
    try {
      // 只保存不含 SQL 的元数据
      await invoke('set_ui_state', {
        key: 'tabs_metadata',
        value: JSON.stringify(state.tabs),
      });
      await invoke('set_ui_state', {
        key: 'active_tab_id',
        value: state.activeTabId,
      });
    } catch {}
  }, 500);
});
```

- [ ] **Step 4: SQL 内容变化时写文件（防抖 500ms）**

在 `setSqlContent` action 中（或其订阅中），写入文件：

```typescript
// 在 queryStore 的 sqlContent 变化时触发
let saveSqlTimers: Record<string, ReturnType<typeof setTimeout>> = {};

export function persistSqlContent(tabId: string, content: string) {
  if (saveSqlTimers[tabId]) clearTimeout(saveSqlTimers[tabId]);
  saveSqlTimers[tabId] = setTimeout(async () => {
    try {
      await invoke('write_tab_file', { tabId, content });
    } catch {}
  }, 500);
}
```

在 store 的 `setSqlContent` 中调用 `persistSqlContent(tabId, content)`。

- [ ] **Step 5: tab 关闭时删除文件**

在 `closeTab` action 中，tab 移除后调用：

```typescript
invoke('delete_tab_file', { tabId }).catch(() => {});
```

- [ ] **Step 6: 调整 store 初始化：改为异步加载**

原来是同步初始化 `const { tabs, ... } = loadTabsFromStorage()`，改为在 store 外部异步初始化：

在 `queryStore.ts` 底部或 `Explorer/index.tsx` 的 `useEffect` 中：

```typescript
// queryStore.ts 底部
loadTabsFromStorage().then(({ tabs, activeTabId, sqlContent }) => {
  useQueryStore.setState({ tabs, activeTabId, sqlContent });
}).catch(() => {});
```

- [ ] **Step 7: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无 error

- [ ] **Step 8: Commit**

```bash
git add src/store/queryStore.ts
git commit -m "feat(store): migrate tabs to SQLite metadata + file-based SQL content"
```

---

## Chunk 3: 树状态持久化

### Task 6: treeStore 展开状态持久化

**Files:**
- Modify: `src/store/treeStore.ts`

- [ ] **Step 1: 读取 treeStore.ts 完整内容**

- [ ] **Step 2: 在 toggleExpand 后新增持久化逻辑**

在 `toggleExpand` action 末尾，加防抖持久化：

```typescript
// treeStore.ts 顶部（store 外部）
let persistTreeTimer: ReturnType<typeof setTimeout> | null = null;

function persistTreeExpandedIds(ids: Set<string>) {
  if (persistTreeTimer) clearTimeout(persistTreeTimer);
  persistTreeTimer = setTimeout(async () => {
    try {
      await invoke('set_ui_state', {
        key: 'tree_expanded_ids',
        value: JSON.stringify([...ids]),
      });
    } catch {}
  }, 800);
}
```

在 `toggleExpand` 的 `set(...)` 调用后，追加：

```typescript
persistTreeExpandedIds(get().expandedIds);
```

- [ ] **Step 3: 新增 loadPersistedExpandedIds 工具函数**

```typescript
export async function loadPersistedTreeExpandedIds(): Promise<Set<string>> {
  try {
    const raw = await invoke<string | null>('get_ui_state', { key: 'tree_expanded_ids' });
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === 'string'));
    return new Set();
  } catch {
    return new Set();
  }
}
```

- [ ] **Step 4: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无 error

- [ ] **Step 5: Commit**

```bash
git add src/store/treeStore.ts
git commit -m "feat(store): persist treeStore expandedIds to SQLite"
```

---

### Task 7: metricsTreeStore 展开状态持久化

**Files:**
- Modify: `src/store/metricsTreeStore.ts`

- [ ] **Step 1: 读取 metricsTreeStore.ts 完整内容，定位 toggleExpand**

- [ ] **Step 2: 参考 Task 6，新增防抖持久化**

```typescript
let persistMetricsTimer: ReturnType<typeof setTimeout> | null = null;

function persistMetricsExpandedIds(ids: Set<string>) {
  if (persistMetricsTimer) clearTimeout(persistMetricsTimer);
  persistMetricsTimer = setTimeout(async () => {
    try {
      await invoke('set_ui_state', {
        key: 'metrics_tree_expanded_ids',
        value: JSON.stringify([...ids]),
      });
    } catch {}
  }, 800);
}
```

在 `toggleExpand` 后调用 `persistMetricsExpandedIds(get().expandedIds)`。

- [ ] **Step 3: 新增 loadPersistedMetricsExpandedIds**

```typescript
export async function loadPersistedMetricsExpandedIds(): Promise<Set<string>> {
  try {
    const raw = await invoke<string | null>('get_ui_state', { key: 'metrics_tree_expanded_ids' });
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === 'string'));
    return new Set();
  } catch {
    return new Set();
  }
}
```

- [ ] **Step 4: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无 error

- [ ] **Step 5: Commit**

```bash
git add src/store/metricsTreeStore.ts
git commit -m "feat(store): persist metricsTreeStore expandedIds to SQLite"
```

---

## Chunk 4: 启动时恢复树状态

### Task 8: DB 树全层级恢复（含连接可用性检查）

**Files:**
- Modify: `src/components/Explorer/index.tsx`

- [ ] **Step 1: 读取 Explorer/index.tsx，定位 restoreOpenedConnections 函数**

- [ ] **Step 2: 改写 restoreOpenedConnections 为全层级深度优先恢复**

```typescript
const restoreOpenedConnections = async () => {
  if (useTreeStore.getState().nodes.size > 0) return;
  await init();

  // 从 SQLite 读已打开连接 + 展开 ID
  const [savedIds, savedExpandedIds] = await Promise.all([
    loadOpenedConnectionIds(),
    loadPersistedTreeExpandedIds(),
  ]);

  if (savedIds.length === 0) return;

  // 逐个连接：先检测可用性，再深度优先恢复
  await Promise.allSettled(savedIds.map(id => restoreConnectionTree(id, savedExpandedIds)));
};

// 深度优先恢复单个连接的树展开状态
const restoreConnectionTree = async (connectionId: number, savedExpandedIds: Set<string>) => {
  const nodeId = `conn_${connectionId}`;
  const store = useTreeStore.getState();
  if (!store.nodes.get(nodeId)) return;

  // 1. 检测连接可用性（超时 3s）
  const conn = useConnectionStore.getState().connections.find(c => c.id === connectionId);
  if (!conn) return;

  let available = false;
  try {
    await Promise.race([
      invoke('test_connection', { config: { ...conn } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    available = true;
  } catch {
    available = false;
  }

  if (!available) return; // 不可用：保持默认折叠状态

  // 2. 标记连接已打开
  openConnection(connectionId);

  // 3. 异步获取版本（不阻断恢复）
  invoke<string>('get_db_version', { connectionId })
    .then(version => {
      if (version) {
        useConnectionStore.getState().setMeta(connectionId, {
          dbVersion: version,
          driver: conn.driver,
          host: conn.host ?? '',
          port: conn.port ?? undefined,
          name: conn.name,
        });
      }
    })
    .catch(() => {});

  // 4. 深度优先恢复展开状态
  await restoreNodeExpansion(nodeId, savedExpandedIds);
};

// 递归恢复节点展开状态
const restoreNodeExpansion = async (nodeId: string, savedExpandedIds: Set<string>) => {
  if (!savedExpandedIds.has(nodeId)) return;

  const store = useTreeStore.getState();
  const node = store.nodes.get(nodeId);
  if (!node) return;

  // 展开节点
  if (!store.expandedIds.has(nodeId)) {
    store.toggleExpand(nodeId);
  }

  // 加载子节点（若未加载）
  if (!node.loaded) {
    await store.loadChildren(nodeId);
  }

  // 递归恢复子节点
  const children = [...useTreeStore.getState().nodes.values()].filter(n => n.parentId === nodeId);
  await Promise.allSettled(
    children
      .filter(child => savedExpandedIds.has(child.id))
      .map(child => restoreNodeExpansion(child.id, savedExpandedIds))
  );
};
```

- [ ] **Step 3: 确保从 treeStore 导入 loadPersistedTreeExpandedIds**

```typescript
import { useTreeStore, loadPersistedTreeExpandedIds } from '../../store/treeStore';
```

- [ ] **Step 4: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无 error

- [ ] **Step 5: Commit**

```bash
git add src/components/Explorer/index.tsx
git commit -m "feat(explorer): restore full tree expansion state on startup with connection availability check"
```

---

### Task 9: 指标树恢复

**Files:**
- Modify: `src/components/MetricsExplorer/MetricsTree.tsx`（或指标树初始化入口，需读取确认）

- [ ] **Step 1: 读取 MetricsExplorer 目录，找到初始化入口（init/useEffect）**

- [ ] **Step 2: 在初始化 useEffect 中添加展开状态恢复**

```typescript
useEffect(() => {
  const restore = async () => {
    await metricsTreeStore.init(); // 先初始化节点

    // 从 SQLite 读已持久化的展开状态
    const savedExpandedIds = await loadPersistedMetricsExpandedIds();
    if (savedExpandedIds.size === 0) return;

    // 恢复展开节点（指标树无网络依赖，直接展开）
    const { nodes, toggleExpand, expandedIds } = useMetricsTreeStore.getState();
    for (const nodeId of savedExpandedIds) {
      if (nodes.has(nodeId) && !expandedIds.has(nodeId)) {
        toggleExpand(nodeId);
      }
    }
  };
  restore();
}, []);
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无 error

- [ ] **Step 4: Commit**

```bash
git add src/components/MetricsExplorer/
git commit -m "feat(metrics): restore metrics tree expansion state on startup"
```

---

## Chunk 5: 验证与收尾

### Task 10: 手动集成测试

- [ ] **Step 1: 启动应用**

```bash
npm run tauri:dev
```

- [ ] **Step 2: 验证 DB 树恢复**

1. 打开一个数据库连接
2. 展开到 schema/category/table 层级
3. 关闭应用（或刷新页面）
4. 重启应用
5. 确认树状态与关闭前一致

- [ ] **Step 3: 验证连接不可用降级**

1. 展开一个连接的树
2. 停止该数据库服务（或修改连接配置使其失效）
3. 重启应用
4. 确认该连接节点保持默认折叠状态（灰图标），不报错

- [ ] **Step 4: 验证指标树恢复**

1. 展开指标树若干节点
2. 重启应用
3. 确认指标树展开状态恢复

- [ ] **Step 5: 验证标签页恢复**

1. 打开多个查询标签页，编写 SQL
2. 重启应用
3. 确认标签页和 SQL 内容恢复

- [ ] **Step 6: 验证 localStorage 迁移**

打开浏览器 DevTools → Application → Local Storage，确认不再有 `open-db-studio-opened-connections` 和 `unified_tabs_state` 键。

- [ ] **Step 7: 最终 Commit**

```bash
git add .
git commit -m "test(ui-state): verify full persistence and recovery works end-to-end"
```
