# Knowledge Graph Palantir Ontology 改造 — 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 GraphExplorer 改造为 Palantir Ontology 风格：Object 节点展示 Key Properties，FK 关系升级为携带富属性的独立 Link Node 渲染在画布中央。

**Architecture:** 后端在 `event_processor.rs` 的 `ADD_FK` 处理器中，将原来的"直连边"改为"Link Node + 两条边"；前端新增 `LinkNodeComponent`（青绿扁平卡片），升级 `BaseNode` 为 Palantir Object Type 风格，`index.tsx` 负责 linkCount 统计、合成边兼容、集群折叠改造。

**Tech Stack:** Rust（rusqlite、serde_json）、React 18、TypeScript、ReactFlow（@xyflow/react）、dagre、lucide-react、react-i18next

---

## Chunk 1: Rust 后端 — FK 数据模型升级

### 关键背景（读前必看）

- **Node ID 格式**：`make_node_id(conn_id, "table", &[&name])` → `"{conn_id}:table:{name}"`，例如 `"1:table:orders"`（**使用冒号 `:`，与 spec 草稿中的下划线格式不同，以代码现实为准**）
- **Link Node ID**：`"link:{conn_id}:{from_table}:{to_table}:{via_field}"`，例如 `"link:1:orders:users:user_id"`（同样使用冒号）
- **metadata 中的 `source_node_id`/`target_node_id`**：必须与 Object Node 的实际 id 格式完全一致，即 `"{conn_id}:table:{name}"` 形式，这样前端 `linkCountMap` 才能正确匹配
- **当前 FK 流程**：`change_detector` 写入 `ADD_FK` 事件 → `event_processor` 中 `ADD_FK` 分支创建一条直连 `graph_edges`（`edge_type='foreign_key'`）
- **改造后 FK 流程**：`ADD_FK` 分支创建 1 个 Link Node（`graph_nodes`）+ 2 条边（`graph_edges`，类型 `to_link`/`from_link`）
- **`ForeignKeyMeta`** 当前无 `on_delete` 字段，需新增
- **oracle.rs / sqlserver.rs**：这两个 driver 是占位实现，尚未实现 `get_foreign_keys`，不会构建 `ForeignKeyMeta`，本次无需修改，但后续实现时需同步加 `on_delete` 字段

### Task 1: 扩展 `ForeignKeyMeta` 结构体

**Files:**
- Modify: `src-tauri/src/datasource/mod.rs`

- [ ] **Step 1: 为 `ForeignKeyMeta` 新增 `on_delete` 字段**

在 `mod.rs` 第 54 行的 `ForeignKeyMeta` 结构体，添加：

```rust
pub struct ForeignKeyMeta {
    pub constraint_name: String,
    pub column: String,
    pub referenced_table: String,
    pub referenced_column: String,
    pub on_delete: Option<String>,  // 新增：CASCADE / SET NULL / RESTRICT / NO ACTION
}
```

- [ ] **Step 2: 编译检查确认结构体变更影响范围**

```bash
cd src-tauri && cargo check 2>&1 | grep "error\|ForeignKeyMeta" | head -30
```

预期：看到 mysql.rs、postgres.rs 中构建 `ForeignKeyMeta` 的地方报缺字段错误（正常，待 Task 2 修复）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/datasource/mod.rs
git commit -m "feat(graph): ForeignKeyMeta 新增 on_delete 字段"
```

---

### Task 2: MySQL driver 查询 `DELETE_RULE`

**Files:**
- Modify: `src-tauri/src/datasource/mysql.rs`（第 205-219 行）

- [ ] **Step 1: 更新 MySQL `get_foreign_keys` SQL 查询**

将 SQL 改为 JOIN `REFERENTIAL_CONSTRAINTS` 获取 `DELETE_RULE`，并更新结构体构建：

```rust
async fn get_foreign_keys(&self, table: &str, _schema: Option<&str>) -> AppResult<Vec<ForeignKeyMeta>> {
    let rows = sqlx::query(
        "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
                kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
                rc.DELETE_RULE
         FROM information_schema.KEY_COLUMN_USAGE kcu
         LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
             ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
             AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
         WHERE kcu.TABLE_SCHEMA = DATABASE()
           AND kcu.TABLE_NAME = ?
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL"
    )
    .bind(table)
    .fetch_all(&self.pool)
    .await?;
    Ok(rows.iter().map(|r| ForeignKeyMeta {
        constraint_name: get_str(r, 0),
        column: get_str(r, 1),
        referenced_table: get_str(r, 2),
        referenced_column: get_str(r, 3),
        on_delete: {
            let v = get_str(r, 4);
            if v.is_empty() { None } else { Some(v) }
        },
    }).collect())
}
```

- [ ] **Step 2: 编译检查 MySQL driver**

```bash
cd src-tauri && cargo check 2>&1 | grep "error" | head -20
```

预期：mysql.rs 无报错，postgres.rs 仍有报错（待 Task 3）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/datasource/mysql.rs
git commit -m "feat(graph): MySQL driver get_foreign_keys 增加 DELETE_RULE 查询"
```

---

### Task 3: PostgreSQL driver 查询 `delete_rule`

**Files:**
- Modify: `src-tauri/src/datasource/postgres.rs`（第 171-195 行）

- [ ] **Step 1: 更新 PostgreSQL `get_foreign_keys` SQL 查询**

```rust
async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> AppResult<Vec<ForeignKeyMeta>> {
    let schema = schema.unwrap_or("public");
    let rows = sqlx::query(
        "SELECT tc.constraint_name, kcu.column_name,
                ccu.table_name AS referenced_table,
                ccu.column_name AS referenced_column,
                rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
             AND ccu.table_schema = tc.table_schema
         LEFT JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name
             AND rc.constraint_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $2
           AND tc.table_name = $1"
    )
    .bind(table)
    .bind(schema)
    .fetch_all(&self.pool)
    .await?;
    Ok(rows.iter().map(|r| ForeignKeyMeta {
        constraint_name: r.try_get::<String, _>(0).unwrap_or_default(),
        column: r.try_get::<String, _>(1).unwrap_or_default(),
        referenced_table: r.try_get::<String, _>(2).unwrap_or_default(),
        referenced_column: r.try_get::<String, _>(3).unwrap_or_default(),
        on_delete: r.try_get::<Option<String>, _>(4).ok().flatten(),
    }).collect())
}
```

- [ ] **Step 2: 全量编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "error" | head -20
```

预期：无 error，仅 warning 可接受。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/datasource/postgres.rs
git commit -m "feat(graph): PostgreSQL driver get_foreign_keys 增加 delete_rule 查询"
```

---

### Task 4: 更新 `change_detector.rs` — FK metadata 包含 `on_delete`

**Files:**
- Modify: `src-tauri/src/graph/change_detector.rs`（第 196-217 行）

- [ ] **Step 1: `ADD_FK` 事件的 metadata 加入 `on_delete`**

在 `detect_and_log_changes` 函数中，`ADD_FK` 事件生成的 `fk_meta` 改为：

```rust
let fk_meta = serde_json::json!({
    "constraint_name": fk.constraint_name,
    "column": fk.column,
    "referenced_table": fk.referenced_table,
    "referenced_column": fk.referenced_column,
    "on_delete": fk.on_delete
})
.to_string();
```

（`fk.on_delete` 是 `Option<String>`，序列化时 `None` → `null`，`Some("CASCADE")` → `"CASCADE"`）

- [ ] **Step 2: 更新 `load_existing_nodes` — 第二个返回值改为追踪 Link Node IDs**

**重要**：`load_existing_nodes` 有两段查询：① tables/columns 查询（检测表和列的差量，**保持不变**）；② FK 约束查询（追踪已有 FK 的 constraint_name，**替换为追踪 Link Node IDs**）。只修改第二段。

将现有的 `fk_constraints` 查询（从 `graph_edges` 读 FK 约束名）替换为从 `graph_nodes` 读 Link Node ID：

```rust
// 替换这一段（原来从 graph_edges 读 fk constraint_name）：
let mut existing_link_ids: HashSet<String> = HashSet::new();
{
    let mut stmt = conn.prepare(
        "SELECT id FROM graph_nodes
         WHERE connection_id=?1 AND node_type='link'
           AND (source IS NULL OR source != 'user')
           AND is_deleted=0",
    )?;
    let ids = stmt.query_map([connection_id], |row| row.get::<_, String>(0))?;
    for id in ids {
        existing_link_ids.insert(id?);
    }
}
Ok((tables, existing_link_ids))
// 函数签名返回类型从 (HashMap<...>, HashSet<String>) 不变，含义从 fk_constraints 改为 link_node_ids
```

同时更新调用处的变量名：

```rust
let (existing_tables, existing_link_ids) = load_existing_nodes(&db_conn, connection_id)?;
```

以及 `ADD_FK` 事件生成时的去重检查（注意 ID 格式使用冒号，与 event_processor 保持一致）：

```rust
// 旧：if !existing_fk_constraints.contains(&fk.constraint_name)
// 新：
let would_be_link_id = format!(
    "link:{}:{}:{}:{}",
    connection_id, tname, fk.referenced_table, fk.column
);
if !existing_link_ids.contains(&would_be_link_id) {
    // 插入 ADD_FK 事件
}
```

- [ ] **Step 3: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "error" | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/graph/change_detector.rs
git commit -m "feat(graph): change_detector FK metadata 加入 on_delete，改为追踪 Link Node id"
```

---

### Task 5: 更新 `event_processor.rs` — `ADD_FK` 创建 Link Node + 两条边

**Files:**
- Modify: `src-tauri/src/graph/event_processor.rs`（第 317-347 行）

- [ ] **Step 1: 重写 `ADD_FK` 分支**

找到第 317 行 `"ADD_FK" =>` 分支，替换为：

```rust
"ADD_FK" => {
    if let Some(meta_str) = &ev.metadata {
        if let Ok(meta_val) = serde_json::from_str::<serde_json::Value>(meta_str) {
            let ref_table = meta_val
                .get("referenced_table")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let via_col = meta_val
                .get("column")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let on_delete = meta_val
                .get("on_delete")
                .and_then(|v| v.as_str())
                .unwrap_or("NO ACTION");

            let table_node_id = make_node_id(conn_id, "table", &[&ev.table_name]);
            let ref_table_node_id = make_node_id(conn_id, "table", &[ref_table]);
            let link_id = format!(
                "link:{}:{}:{}:{}",
                conn_id, ev.table_name, ref_table, via_col
            );

            // 推断 cardinality（简化：固定 N:1，精确推断需另查 unique indexes）
            let cardinality = "N:1";

            // Link Node metadata
            let link_metadata = serde_json::json!({
                "edge_type": "fk",
                "cardinality": cardinality,
                "via": via_col,
                "on_delete": on_delete,
                "description": "",
                "weight": 0.95,
                "is_inferred": true,
                "source_table": ev.table_name,
                "target_table": ref_table,
                "source_node_id": table_node_id,
                "target_node_id": ref_table_node_id,
            });

            let display_name = format!("{} → {}", ev.table_name, ref_table);

            // 插入 Link Node（INSERT OR IGNORE 保证幂等）
            // 注意：利用返回的影响行数判断是否真正插入，避免 IGNORE 时错误计数
            let inserted = db_conn.execute(
                "INSERT OR IGNORE INTO graph_nodes
                   (id, node_type, connection_id, name, display_name, metadata, source)
                 VALUES (?1, 'link', ?2, ?3, ?4, ?5, 'schema')",
                rusqlite::params![
                    link_id,
                    conn_id,
                    "fk",
                    display_name,
                    link_metadata.to_string(),
                ],
            ).unwrap_or(0);

            // 插入两条边（INSERT OR IGNORE 保证幂等）
            let edge1_id = format!("{}=>{}", table_node_id, link_id);
            let _ = db_conn.execute(
                "INSERT OR IGNORE INTO graph_edges
                   (id, from_node, to_node, edge_type)
                 VALUES (?1, ?2, ?3, 'to_link')",
                rusqlite::params![edge1_id, table_node_id, link_id],
            );

            let edge2_id = format!("{}=>{}", link_id, ref_table_node_id);
            let _ = db_conn.execute(
                "INSERT OR IGNORE INTO graph_edges
                   (id, from_node, to_node, edge_type)
                 VALUES (?1, ?2, ?3, 'from_link')",
                rusqlite::params![edge2_id, link_id, ref_table_node_id],
            );

            // 仅真正插入时计数（IGNORE 时 inserted == 0）
            if inserted > 0 {
                stats.inserted += 1;
            }
        }
    }
}
```

- [ ] **Step 2: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "error" | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/graph/event_processor.rs
git commit -m "feat(graph): ADD_FK 改为创建 Link Node + 两条 to_link/from_link 边"
```

---

### Task 6: 新增 `update_graph_node_metadata` 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`（在 `update_node_alias` 之后追加）
- Modify: `src-tauri/src/lib.rs`（`generate_handler![]` 追加注册）

- [ ] **Step 1: 在 `commands.rs` 末尾（知识图谱区块内）追加新命令**

紧跟 `update_node_alias` 函数之后插入：

```rust
/// 更新图谱节点的 metadata（用于 Link Node description 编辑）
#[tauri::command]
pub async fn update_graph_node_metadata(
    node_id: String,
    metadata: String,
) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE graph_nodes SET metadata = ?1 WHERE id = ?2",
        rusqlite::params![metadata, node_id],
    )?;
    Ok(())
}
```

- [ ] **Step 2: 在 `lib.rs` 的 `generate_handler![]` 中注册**

在 `commands::update_node_alias,` 后追加：

```rust
commands::update_graph_node_metadata,
```

- [ ] **Step 3: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep "error" | head -20
```

预期：无 error。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(graph): 新增 update_graph_node_metadata 命令并注册"
```

---

## Chunk 2: 前端组件层

### Task 7: 新增 i18n Keys

**Files:**
- Modify: `src/i18n/locales/en.json`（第 700-705 行 `nodeDetail` 节）
- Modify: `src/i18n/locales/zh.json`（对应位置）

- [ ] **Step 1: 在 `en.json` 的 `graphExplorer` 节中追加新 key**

在 `"typeAlias": "Alias",` 之后追加 `typeLink`；在 `nodeDetail` 中追加 Link 专属 key：

```json
"typeLink": "Link",
```

将 `nodeDetail` 改为：

```json
"nodeDetail": {
  "source": "Source",
  "fields": "Fields",
  "semanticAliases": "Semantic Aliases",
  "relatedEdges": "Related Edges",
  "linkProps": "Link Properties",
  "linkDirection": "Direction",
  "linkCardinality": "Cardinality",
  "linkVia": "Via",
  "linkOnDelete": "On Delete",
  "linkDescription": "Description",
  "inferredBadge": "AI Inferred",
  "manualBadge": "Manual"
}
```

- [ ] **Step 2: 在 `zh.json` 对应位置做相同修改**

```json
"typeLink": "关联",
```

```json
"nodeDetail": {
  "source": "来源",
  "fields": "字段",
  "semanticAliases": "语义别名",
  "relatedEdges": "关联边",
  "linkProps": "关联属性",
  "linkDirection": "关联方向",
  "linkCardinality": "基数关系",
  "linkVia": "关联字段",
  "linkOnDelete": "删除行为",
  "linkDescription": "语义描述",
  "inferredBadge": "AI 推断",
  "manualBadge": "手动创建",
  "editBtn": "编辑",
  "saving": "保存中...",
  "save": "保存",
  "cancel": "取消",
  "noDescription": "暂无描述",
  "descriptionPlaceholder": "描述关联的业务含义..."
}
```

以及 `en.json` 对应位置同步追加：

```json
  "editBtn": "Edit",
  "saving": "Saving...",
  "save": "Save",
  "cancel": "Cancel",
  "noDescription": "No description",
  "descriptionPlaceholder": "Describe the business meaning of this relationship..."
```

- [ ] **Step 3: TypeScript 编译检查**

```bash
npx tsc --noEmit 2>&1 | grep "error" | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/en.json src/i18n/locales/zh.json
git commit -m "feat(graph): 新增 Link Node 相关 i18n keys（en/zh）"
```

---

### Task 8: 升级 `BaseNode` 为 Palantir Object Type 风格，新增 `LinkNodeComponent`

**Files:**
- Modify: `src/components/GraphExplorer/GraphNodeComponents.tsx`

- [ ] **Step 1: 在文件顶部追加 lucide 图标导入**

在现有 `import { Plus } from 'lucide-react';` 行，改为：

```typescript
import { Plus, Database, BarChart2, Hash, ArrowLeftRight } from 'lucide-react';
```

- [ ] **Step 2: 先更新 `GraphNodeData` 接口，加入新字段（必须在 BaseNode 实现之前）**

找到文件顶部的 `GraphNodeData` 接口，在 `onAddAlias` 之后追加：

```typescript
export interface GraphNodeData extends Record<string, unknown> {
  id: string;
  node_type: string;
  name: string;
  display_name: string | null;
  aliases: string | null;
  metadata: string | null;
  connection_id: number | null;
  is_deleted: number | null;
  source: string | null;
  onAddAlias?: (nodeId: string) => void;
  onHighlightLinks?: (nodeId: string) => void;  // 新增：点击 linkCount 徽章时触发
  linkCount?: number;                            // 新增：与该节点关联的 Link Node 数量
}
```

- [ ] **Step 3: 新增 `parseNodeFields` 辅助函数（仅文件内使用）**

在 `BaseNode` 函数之前插入：

```typescript
interface NodeField { name: string; type?: string; is_primary_key?: boolean; }

function parseNodeFields(metadata: string | null): NodeField[] {
  if (!metadata) return [];
  try {
    const obj = JSON.parse(metadata);
    if (Array.isArray(obj)) {
      return obj.slice(0, 3).map((f: Record<string, unknown>) => ({
        name: String(f.name ?? f.column_name ?? ''),
        type: f.data_type ? String(f.data_type) : f.type ? String(f.type) : undefined,
        is_primary_key: Boolean(f.is_primary_key),
      })).filter(f => f.name);
    }
  } catch { /* ignore */ }
  return [];
}
```

- [ ] **Step 4: 替换 `BaseNode` 为 Palantir Object Type 风格**

用以下实现替换整个 `BaseNode` 函数（保留同名，三个具名组件继续透传）。注意 `badgeClass` 改为 `badgeBgClass`（仅含背景/文字色，不含 border），避免运行时 string replace 导致 Tailwind JIT 无法识别动态类名：

```typescript
function BaseNode({
  data,
  borderClass,
  badgeBgClass,
  badgeLabel,
  icon: Icon,
}: {
  data: GraphNodeData;
  borderClass: string;
  badgeBgClass: string;  // 仅背景+文字色，如 "bg-[#0d2a3d] text-[#3794ff]"
  badgeLabel: string;
  icon: React.ElementType;
}) {
  const { t } = useTranslation();
  const fields = parseNodeFields(data.metadata as string | null);
  const aliases = (data.aliases as string | null)
    ? (data.aliases as string).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
    : [];
  const propCount = fields.length;
  const linkCount = (data.linkCount as number) ?? 0;

  const handleAddAlias = (e: React.MouseEvent) => {
    e.stopPropagation();
    data.onAddAlias?.(data.id);
  };

  return (
    <div className={`w-60 rounded-md border bg-[#111922] shadow-lg ${borderClass} group`}>
      <Handle type="target" position={Position.Left} className="!bg-[#1e2d42] !border-[#2a3f5a]" />

      {/* Header: icon + name + counts */}
      <div className="px-3 py-2 border-b border-[#1e2d42] flex items-center gap-2">
        <div className={`flex-shrink-0 ${badgeBgClass} p-1 rounded`}>
          <Icon size={13} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[#c8daea] text-xs font-semibold truncate" title={data.name}>{data.name}</p>
          <p className="text-[#3d5470] text-[9px]">Object Type · {badgeLabel.toUpperCase()}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {propCount > 0 && (
            <span className="text-[9px] text-[#7a9bb8] bg-[#0d1117] px-1 rounded">{propCount}✦</span>
          )}
          {linkCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); data.onHighlightLinks?.(data.id); }}
              className="text-[9px] text-[#00c9a7] bg-[#0d1f1a] px-1 rounded hover:bg-[#00c9a722] transition-colors"
              title={t('graphExplorer.highlightLinks')}
            >
              {linkCount}⇌
            </button>
          )}
          <button
            title={t('graphExplorer.addAlias')}
            onClick={handleAddAlias}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-[#1e2d42] text-[#7a9bb8] hover:text-[#c8daea]"
          >
            <Plus size={11} />
          </button>
        </div>
      </div>

      {/* Key Properties */}
      {fields.length > 0 && (
        <div className="px-3 py-1.5 border-b border-[#1e2d42]">
          {fields.map((f, i) => (
            <div key={i} className="flex items-center justify-between py-0.5">
              <span className="text-[#c8daea] text-[10px] font-mono truncate flex-1">
                {f.is_primary_key && <span className="text-[#f59e0b] mr-1">⬡</span>}
                {f.name}
              </span>
              {f.type && <span className="text-[#7a9bb8] text-[9px] font-mono ml-2 flex-shrink-0">{f.type}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Aliases */}
      {aliases.length > 0 && (
        <div className="px-3 py-1.5 flex flex-wrap gap-1">
          {aliases.slice(0, 3).map(a => (
            <span key={a} className="text-[9px] text-[#a855f7] bg-[#1e0d2d] border border-[#a855f744] rounded px-1">
              #{a}
            </span>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!bg-[#1e2d42] !border-[#2a3f5a]" />
    </div>
  );
}
```

- [ ] **Step 4: 更新三个具名组件，透传 `badgeBgClass` 和 `icon` prop**

```typescript
export const TableNodeComponent = memo(({ data }: NodeProps) => (
  <BaseNode
    data={data as GraphNodeData}
    borderClass="border-[#3794ff]"
    badgeBgClass="bg-[#0d2a3d] text-[#3794ff]"
    badgeLabel="table"
    icon={Database}
  />
));
TableNodeComponent.displayName = 'TableNodeComponent';

export const MetricNodeComponent = memo(({ data }: NodeProps) => (
  <BaseNode
    data={data as GraphNodeData}
    borderClass="border-[#f59e0b]"
    badgeBgClass="bg-[#2d1e0d] text-[#f59e0b]"
    badgeLabel="metric"
    icon={BarChart2}
  />
));
MetricNodeComponent.displayName = 'MetricNodeComponent';

export const AliasNodeComponent = memo(({ data }: NodeProps) => (
  <BaseNode
    data={data as GraphNodeData}
    borderClass="border-[#a855f7]"
    badgeBgClass="bg-[#1e0d2d] text-[#a855f7]"
    badgeLabel="alias"
    icon={Hash}
  />
));
AliasNodeComponent.displayName = 'AliasNodeComponent';
```

- [ ] **Step 5: 在文件末尾新增 `LinkMetadata` 接口和 `LinkNodeComponent`**

```typescript
interface LinkMetadata {
  edge_type?: string;
  cardinality?: string;
  via?: string;
  on_delete?: string;
  description?: string;
  is_inferred?: boolean;
  source_table?: string;
  target_table?: string;
}

export const LinkNodeComponent = memo(({ data }: NodeProps) => {
  const nodeData = data as GraphNodeData;
  let meta: LinkMetadata = {};
  try { meta = JSON.parse((nodeData.metadata as string) || '{}'); } catch { /* ignore */ }

  const isInferred = meta.is_inferred !== false;
  const borderClass = isInferred
    ? 'border-dashed border-[#00c9a7]'
    : 'border-[#00c9a7]';

  return (
    <div className={`w-64 rounded-md border bg-[#111922] shadow-lg ${borderClass}`}>
      <Handle type="target" position={Position.Left} className="!bg-[#1e2d42] !border-[#2a3f5a]" />

      {/* Row 1: edge_type + cardinality */}
      <div className="px-3 py-1.5 border-b border-[#1e2d42] flex items-center gap-2">
        <ArrowLeftRight size={12} className="text-[#00c9a7] flex-shrink-0" />
        <span className="text-[#00c9a7] text-[11px] font-semibold flex-1">
          {(meta.edge_type ?? 'fk').toUpperCase()}
        </span>
        {meta.cardinality && (
          <span className="text-[#f59e0b] text-[10px] font-mono">{meta.cardinality}</span>
        )}
      </div>

      {/* Row 2: via + on_delete */}
      <div className="px-3 py-1 border-b border-[#1e2d42] flex items-center gap-1.5">
        {meta.via && (
          <span className="text-[#7a9bb8] text-[9px]">
            via: <span className="text-[#c8daea] font-mono">{meta.via}</span>
          </span>
        )}
        {meta.on_delete && (
          <span className="text-[#7a9bb8] text-[9px] ml-1">
            · <span className="text-[#f59e0b]">{meta.on_delete}</span>
          </span>
        )}
      </div>

      {/* Row 3: direction */}
      <div className="px-3 py-1 flex items-center">
        <span className="text-[#3d5470] text-[9px] truncate">
          {nodeData.display_name || `${meta.source_table ?? ''} → ${meta.target_table ?? ''}`}
        </span>
        {isInferred && (
          <span className="ml-auto text-[8px] text-[#3d5470] flex-shrink-0">AI</span>
        )}
      </div>

      {/* Row 4 (optional): description */}
      {meta.description && (
        <div className="px-3 py-1 border-t border-[#1e2d42]">
          <span className="text-[#7a9bb8] text-[9px] italic truncate block">{meta.description}</span>
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!bg-[#1e2d42] !border-[#2a3f5a]" />
    </div>
  );
});
LinkNodeComponent.displayName = 'LinkNodeComponent';
```

- [ ] **Step 6: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | grep "GraphNodeComponents\|error" | head -20
```

- [ ] **Step 7: Commit**

```bash
git add src/components/GraphExplorer/GraphNodeComponents.tsx
git commit -m "feat(graph): 升级 BaseNode 为 Palantir Object Type 风格，新增 LinkNodeComponent"
```

---

### Task 9: 更新 `nodeTypes.ts` 注册 `link` 类型

**Files:**
- Modify: `src/components/GraphExplorer/nodeTypes.ts`

- [ ] **Step 1: 读取当前 nodeTypes.ts 内容确认结构**

当前文件导入 `TableNodeComponent`、`MetricNodeComponent`、`AliasNodeComponent`。追加 `LinkNodeComponent` 导入和注册：

```typescript
import {
  TableNodeComponent,
  MetricNodeComponent,
  AliasNodeComponent,
  LinkNodeComponent,  // 新增
} from './GraphNodeComponents';

export const nodeTypes = {
  table:  TableNodeComponent,
  metric: MetricNodeComponent,
  alias:  AliasNodeComponent,
  link:   LinkNodeComponent,  // 新增
};
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | grep "nodeTypes\|error" | head -10
```

- [ ] **Step 3: Commit**

```bash
git add src/components/GraphExplorer/nodeTypes.ts
git commit -m "feat(graph): nodeTypes 注册 link 节点类型"
```

---

## Chunk 3: 前端逻辑层（`index.tsx` + `NodeDetail.tsx`）

### Task 10: 更新 `index.tsx` — 布局/过滤/linkCount/高亮/合成边/MiniMap

**Files:**
- Modify: `src/components/GraphExplorer/index.tsx`

> **注意**：这是改动最多的文件，按步骤逐一修改，每步后编译检查。

- [ ] **Step 1: 更新常量**

将第 36-38 行的常量改为：

```typescript
const NODE_W = 240;
const NODE_H = 100;
const LINK_NODE_W = 260;
const LINK_NODE_H = 70;
const CLUSTER_THRESHOLD = 200;
```

- [ ] **Step 2: 更新 `buildLayout` — 按节点类型设置 dagre 尺寸**

`buildLayout` 函数内 `nodes.forEach` 部分改为：

```typescript
nodes.forEach((n) => {
  const isLink = n.type === 'link';
  g.setNode(n.id, { width: isLink ? LINK_NODE_W : NODE_W, height: isLink ? LINK_NODE_H : NODE_H });
});
```

同时更新 `g.setGraph` 参数：

```typescript
g.setGraph({ rankdir: direction, ranksep: 200, nodesep: 80 });
```

- [ ] **Step 3: 更新 `clusterByConnection` — Link Node 优先保留**

用以下实现替换整个 `clusterByConnection` 函数：

```typescript
function clusterByConnection(rawNodes: GraphNode[]): GraphNode[] {
  if (rawNodes.length <= CLUSTER_THRESHOLD) return rawNodes;

  const result: GraphNode[] = [];
  const byConn: Record<number, { links: GraphNode[]; objects: GraphNode[] }> = {};

  rawNodes.forEach(n => {
    const cid = n.connection_id ?? 0;
    if (!byConn[cid]) byConn[cid] = { links: [], objects: [] };
    if (n.node_type === 'link') byConn[cid].links.push(n);
    else byConn[cid].objects.push(n);
  });

  Object.entries(byConn).forEach(([cid, { links, objects }]) => {
    const linkQuota = Math.min(links.length, 50);
    const objectQuota = Math.max(0, 50 - linkQuota);
    links.slice(0, linkQuota).forEach(n => result.push(n));
    objects.slice(0, objectQuota).forEach(n => result.push(n));
    const collapsed = objects.length - objectQuota;
    if (collapsed > 0) {
      result.push({
        id: `cluster_${cid}`,
        node_type: 'alias',
        name: `[连接 ${cid}：${collapsed} 个节点已折叠]`,
        display_name: '',
        aliases: '',
        metadata: '',
        connection_id: Number(cid),
        is_deleted: 0,
        source: 'cluster',
      });
    }
  });
  return result;
}
```

- [ ] **Step 4: 更新 `NODE_TYPE_MAP` — 加入 `link`**

```typescript
const NODE_TYPE_MAP: Record<string, string> = {
  table: 'table',
  metric: 'metric',
  alias: 'alias',
  link: 'link',   // 新增
};
```

- [ ] **Step 5: 更新 `toFlowNodes` 签名 — 加入 `linkCountMap` 和 `onHighlightLinks`**

```typescript
function toFlowNodes(
  rawNodes: GraphNode[],
  onAddAlias: (nodeId: string) => void,
  onHighlightLinks: (nodeId: string) => void,
  linkCountMap: Record<string, number>,
): Node[] {
  return rawNodes.map((n) => ({
    id: n.id,
    type: NODE_TYPE_MAP[n.node_type] ?? 'table',
    position: { x: 0, y: 0 },
    data: {
      ...n,
      onAddAlias,
      onHighlightLinks,
      linkCount: linkCountMap[n.id] ?? 0,
    },
  }));
}
```

- [ ] **Step 6: 在 `GraphExplorerInner` 组件中，新增高亮 state 和 `onHighlightLinks` 回调**

在 `const [showAliasEditorForNode, ...` 之后新增：

```typescript
const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);

const handleHighlightLinks = useCallback((nodeId: string) => {
  setHighlightedNodeId(prev => prev === nodeId ? null : nodeId);
}, []);
```

- [ ] **Step 7: 更新 `filteredRaw` 的 useMemo，加入 `linkCountMap` 计算**

在 `clustered` 的 useMemo 之前，新增：

```typescript
const linkCountMap = useMemo<Record<string, number>>(() => {
  const map: Record<string, number> = {};
  filteredRaw
    .filter(n => n.node_type === 'link')
    .forEach(n => {
      try {
        const meta = JSON.parse(n.metadata || '{}') as { source_node_id?: string; target_node_id?: string };
        if (meta.source_node_id) map[meta.source_node_id] = (map[meta.source_node_id] ?? 0) + 1;
        if (meta.target_node_id) map[meta.target_node_id] = (map[meta.target_node_id] ?? 0) + 1;
      } catch { /* ignore */ }
    });
  return map;
}, [filteredRaw]);
```

- [ ] **Step 8: 更新 `filteredEdges` — 加入合成边逻辑**

将 `filteredEdges` 的 useMemo 替换为：

```typescript
const filteredEdges = useMemo(() => {
  // 正常两段式边（Link Node 开启时）
  const normal = rawEdges.filter(
    (e) => visibleNodeIds.has(e.from_node) && visibleNodeIds.has(e.to_node)
  );

  // 合成直连边（Link Node 关闭时，从 Link Node metadata 重建）
  const synthetic: typeof rawEdges = typeFilter.includes('link')
    ? []
    : filteredRaw
        .filter(n => n.node_type === 'link')
        .flatMap(n => {
          try {
            const meta = JSON.parse(n.metadata || '{}') as {
              source_node_id?: string;
              target_node_id?: string;
              edge_type?: string;
              weight?: number;
            };
            if (!meta.source_node_id || !meta.target_node_id) return [];
            if (!visibleNodeIds.has(meta.source_node_id) || !visibleNodeIds.has(meta.target_node_id)) return [];
            return [{
              id: `synthetic_${n.id}`,
              from_node: meta.source_node_id,
              to_node: meta.target_node_id,
              edge_type: meta.edge_type ?? 'fk',
              weight: meta.weight ?? 0.95,
            }];
          } catch { return []; }
        });

  return [...normal, ...synthetic];
}, [rawEdges, visibleNodeIds, typeFilter, filteredRaw]);
```

- [ ] **Step 9: 更新 `useEffect`（sync to ReactFlow）— 传入新参数**

```typescript
useEffect(() => {
  const flowNodes = toFlowNodes(clustered, handleAddAlias, handleHighlightLinks, linkCountMap);
  const flowEdges = toFlowEdges(filteredEdges);
  // ... 其余不变
}, [clustered, filteredEdges, setRfNodes, setRfEdges, handleAddAlias, handleHighlightLinks, linkCountMap, fitView]);
```

- [ ] **Step 10: 更新工具栏过滤器 `typeFilter` 初始值和 `typeButtons`**

```typescript
const [typeFilter, setTypeFilter] = useState<string[]>(['table', 'metric', 'alias', 'link']);
```

在 `typeButtons` 数组末尾追加：

```typescript
{ type: 'link', label: t('graphExplorer.typeLink'), activeClass: 'bg-[#0d1f1a] text-[#00c9a7] border-[#00c9a7]/50' },
```

- [ ] **Step 11: 更新 MiniMap `nodeColor`**

```typescript
nodeColor={(n) => {
  const t = n.type ?? '';
  if (t === 'table') return '#3794ff';
  if (t === 'metric') return '#f59e0b';
  if (t === 'alias') return '#a855f7';
  if (t === 'link') return '#00c9a7';   // 新增
  return '#1e2d42';
}}
```

- [ ] **Step 12: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | grep "error" | head -30
```

逐一修复类型错误后再继续。

- [ ] **Step 13: Commit**

```bash
git add src/components/GraphExplorer/index.tsx
git commit -m "feat(graph): index.tsx 更新布局/集群/过滤/linkCount/合成边/MiniMap 逻辑"
```

---

### Task 11: 更新 `NodeDetail.tsx` — 支持 Link Node 详情面板

**Files:**
- Modify: `src/components/GraphExplorer/NodeDetail.tsx`

- [ ] **Step 1: 新增 Link Node metadata 解析接口和渲染函数**

在文件顶部导入区域，补充：

```typescript
import { invoke } from '@tauri-apps/api/core';
```

在 `parseMetadata` 函数之前，新增 `parseLinkMetadata` 和 `LinkDetail` 组件：

```typescript
interface LinkMeta {
  edge_type?: string;
  cardinality?: string;
  via?: string;
  on_delete?: string;
  description?: string;
  weight?: number;
  is_inferred?: boolean;
  source_table?: string;
  target_table?: string;
}

function LinkDetail({ node, onMetaUpdated }: { node: GraphNode; onMetaUpdated: () => void }) {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  let meta: LinkMeta = {};
  try { meta = JSON.parse(node.metadata || '{}'); } catch { /* ignore */ }

  // 同步初始 description
  React.useEffect(() => {
    setDescription(meta.description ?? '');
  }, [node.id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = { ...meta, description };
      await invoke('update_graph_node_metadata', {
        nodeId: node.id,
        metadata: JSON.stringify(updated),
      });
      setEditing(false);
      onMetaUpdated();
    } catch (err) {
      console.warn('[LinkDetail] save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const rows: { label: string; value: string; color?: string }[] = [
    { label: t('graphExplorer.nodeDetail.linkDirection'), value: `${meta.source_table ?? ''} → ${meta.target_table ?? ''}` },
    { label: t('graphExplorer.nodeDetail.linkCardinality'), value: meta.cardinality ?? '-', color: '#f59e0b' },
    { label: t('graphExplorer.nodeDetail.linkVia'), value: meta.via ?? '-', color: '#3794ff' },
    { label: t('graphExplorer.nodeDetail.linkOnDelete'), value: meta.on_delete ?? '-' },
    { label: 'Weight', value: meta.weight?.toFixed(2) ?? '-' },
  ];

  return (
    <div className="px-4 py-3 flex-1 overflow-y-auto">
      <p className="text-[#7a9bb8] text-[11px] uppercase tracking-wide mb-2">
        {t('graphExplorer.nodeDetail.linkProps')}
      </p>

      {/* 推断标记 */}
      <div className="mb-3">
        <span className={`text-[9px] px-2 py-0.5 rounded border ${
          meta.is_inferred !== false
            ? 'bg-[#0d2a3d] text-[#3794ff] border-[#3794ff]/30'
            : 'bg-[#1e2d42] text-[#7a9bb8] border-[#253347]'
        }`}>
          {meta.is_inferred !== false
            ? t('graphExplorer.nodeDetail.inferredBadge')
            : t('graphExplorer.nodeDetail.manualBadge')}
        </span>
      </div>

      {/* 属性行 */}
      <div className="space-y-1.5 mb-4">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between py-1 px-2 rounded hover:bg-[#0d1117]">
            <span className="text-[#7a9bb8] text-[10px]">{r.label}</span>
            <span className={`text-[10px] font-mono ${r.color ? `text-[${r.color}]` : 'text-[#c8daea]'}`}>{r.value}</span>
          </div>
        ))}
      </div>

      {/* Description 编辑 */}
      <div className="border-t border-[#1e2d42] pt-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[#7a9bb8] text-[11px] uppercase tracking-wide">
            {t('graphExplorer.nodeDetail.linkDescription')}
          </span>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-[10px] text-[#7a9bb8] hover:text-[#c8daea] px-1.5 py-0.5 rounded hover:bg-[#1e2d42]"
            >
              编辑
            </button>
          )}
        </div>
        {editing ? (
          <div>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full text-xs bg-[#0d1117] border border-[#2a3f5a] rounded p-2 text-[#c8daea] placeholder-[#3d5470] focus:outline-none focus:border-[#00c9a7]/50 resize-none"
              rows={3}
              placeholder="描述关联的业务含义..."
            />
            <div className="flex gap-2 mt-1.5">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 text-[10px] py-1 bg-[#00c9a7] text-[#0d1117] rounded font-medium hover:bg-[#00c9a7]/80 disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存'}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="flex-1 text-[10px] py-1 bg-[#1e2d42] text-[#7a9bb8] rounded hover:bg-[#253347]"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[#c8daea] text-xs italic">
            {description || <span className="text-[#3d5470]">暂无描述</span>}
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 更新 `NodeDetail` 组件 props，新增 `onAliasUpdated` → `onMetaUpdated` 泛化**

在 `NodeDetailProps` 接口新增：

```typescript
interface NodeDetailProps {
  node: GraphNode;
  edges: GraphEdge[];
  onClose: () => void;
  onAliasUpdated: () => void;  // 保留，对 Object Node 使用
}
```

- [ ] **Step 3: 在 `NodeDetail` 渲染逻辑中，对 `link` 类型走 `LinkDetail` 路径**

在现有 Header 区块之后，根据 `node.node_type` 分支：

```typescript
{/* 主体内容：Link Node 走独立路径 */}
{node.node_type === 'link' ? (
  <LinkDetail node={node} onMetaUpdated={onAliasUpdated} />
) : (
  /* 现有的 Fields / Aliases / Related Edges 区块，保持不变 */
  <div className="flex-1 overflow-y-auto">
    {/* ... 现有代码 ... */}
  </div>
)}
```

- [ ] **Step 4: TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | grep "NodeDetail\|error" | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/components/GraphExplorer/NodeDetail.tsx
git commit -m "feat(graph): NodeDetail 支持 Link Node 详情面板（属性展示 + description 编辑）"
```

---

### Task 12: 端到端验证

- [ ] **Step 1: 前端开发服务器启动**

```bash
npm run dev
```

打开 http://localhost:1420，进入 Graph Explorer 面板。

- [ ] **Step 2: 验证过滤器**

工具栏应显示 `[Table] [Metric] [Alias] [Link]` 四个按钮，Link 按钮为青绿色（`#00c9a7`）。

- [ ] **Step 3: Rust 后端编译验证**

```bash
cd src-tauri && cargo check 2>&1 | grep "error" | wc -l
```

预期：输出 `0`。

- [ ] **Step 4: TypeScript 全量类型检查**

```bash
npx tsc --noEmit 2>&1 | grep "error" | wc -l
```

预期：输出 `0`。

- [ ] **Step 5: 重新构建图谱并验证 Link Node 出现**

在有 FK 关系的数据库连接上点击「Build Graph」，等待完成后：
- 画布中 FK 关系应渲染为独立的青绿色扁平节点
- Object 节点卡片显示字段列表和 links 计数徽章
- 点击 Link Node → 右侧面板显示 cardinality / via / on_delete 等属性
- 关闭 `Link` 过滤器 → Link Node 消失，Object 节点之间出现合成直连边

- [ ] **Step 6: 最终提交**

```bash
git add -A
git commit -m "feat(graph): 知识图谱 Palantir Ontology 改造完成（Link Node 独立渲染 + Object 卡片升级）"
```
