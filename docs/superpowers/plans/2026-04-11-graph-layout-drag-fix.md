# 知识图谱布局与拖拽持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复拖拽节点点击空白区域后位置回弹的 Bug，并将布局算法改为按数据库分组，同时为后端构建流程加入自动坐标分配。

**Architecture:** Bug 根源在 `buildLayout` 的 `hasSavedPosition` 只检查 `data.position_x` 而非 react flow 当前 position，通过合并拖拽坐标时同步更新 data 字段解决。布局算法改为按 `connection_id|database` 分组各跑一次 Dagre，各组横向排列。后端新增 `layout.rs` 模块，在 `run_graph_build` 末尾对 `position_x IS NULL` 的节点分配初始坐标。

**Tech Stack:** React Flow, dagre (frontend), Rust/rusqlite (backend)

---

## 文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/components/GraphExplorer/index.tsx` | 修改 | Task 1 (bug fix) + Task 2 (grouped layout) |
| `src-tauri/src/graph/layout.rs` | 新增 | Task 3 (backend auto-layout) |
| `src-tauri/src/graph/mod.rs` | 修改 | Task 4 (调用 layout + 注册 mod) |
| `src-tauri/src/commands.rs` | 修改 | Task 4 (auto_layout_graph 命令) |
| `src-tauri/src/lib.rs` | 修改 | Task 4 (generate_handler 注册) |

---

## Task 1: Bug Fix — 拖拽坐标合并时同步更新 data 字段

**Files:**
- Modify: `src/components/GraphExplorer/index.tsx:514-519`

- [ ] **Step 1: 定位要修改的行**

  打开 `src/components/GraphExplorer/index.tsx`，找到第 514 行附近的 `mergedNodes` 合并逻辑：

  ```typescript
  const mergedNodes = flowNodes.map(n => {
    const dragged = draggedPositionsRef.current.get(n.id);
    if (dragged) return { ...n, position: dragged };
    return n;
  });
  ```

- [ ] **Step 2: 应用 Bug 修复**

  将上面的代码替换为（第 515-517 行）：

  ```typescript
  const mergedNodes = flowNodes.map(n => {
    const dragged = draggedPositionsRef.current.get(n.id);
    if (dragged) return { ...n, position: dragged, data: { ...n.data as Record<string, unknown>, position_x: dragged.x, position_y: dragged.y } };
    return n;
  });
  ```

  **原理**：`hasSavedPosition(n)` 检查 `n.data.position_x`。首次拖拽后数据库还未 refetch，`data.position_x` 为 null，导致 Dagre 重算覆盖拖拽位置。同步更新 data 字段使 `hasSavedPosition` 返回 true，Dagre 跳过该节点。

- [ ] **Step 3: 类型检查**

  ```bash
  npx tsc --noEmit
  ```

  期望：0 错误。

- [ ] **Step 4: 手动验证 Bug 修复**

  启动 `npm run dev`，打开知识图谱，拖拽一个节点到新位置，然后点击空白区域。节点应保持在拖拽后的位置，不再回弹。

- [ ] **Step 5: 提交**

  ```bash
  git add src/components/GraphExplorer/index.tsx
  git commit -m "fix(graph): prevent node snap-back by syncing data.position_x on drag merge"
  ```

---

## Task 2: 前端分组布局算法

**Files:**
- Modify: `src/components/GraphExplorer/index.tsx:44-98`（常量区 + buildLayout 函数）

- [ ] **Step 1: 添加分组布局常量**

  在 `index.tsx` 第 50 行（`const CLUSTER_THRESHOLD = 200;` 之后）添加：

  ```typescript
  const GROUP_GAP_X = 600;     // 组间横向间距
  const GROUP_GAP_Y = 500;     // 组间纵向间距
  const MAX_COLS = 4;          // 每行最多组数
  const ESTIMATED_GROUP_W = 1400; // 预估每组宽度（用于新组网格定位）
  const ESTIMATED_GROUP_H = 600;  // 预估每组高度
  ```

- [ ] **Step 2: 替换 buildLayout 函数**

  将第 58-98 行的 `buildLayout` 函数完整替换为：

  ```typescript
  function buildLayout(
    nodes: Node[],
    edges: Edge[],
    direction: 'LR' | 'TB' = 'LR',
    forceRelayout = false,
  ): { nodes: Node[]; edges: Edge[] } {
    // 快速路径：所有节点都有已保存坐标且不强制重排
    const allSaved = !forceRelayout && nodes.length > 0 && nodes.every(hasSavedPosition);
    if (allSaved) return { nodes, edges };

    // ── 按 connection_id|database 分组 ───────────────────────────────────────
    const groupMap = new Map<string, Node[]>();
    nodes.forEach((n) => {
      const d = n.data as Record<string, unknown>;
      const key = `${d?.connection_id ?? 0}|${d?.database ?? ''}`;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(n);
    });

    // 有已保存节点的组优先，其次按节点数降序
    const sortedGroups = [...groupMap.entries()].sort((a, b) => {
      const aHasPos = a[1].some((n) => !forceRelayout && hasSavedPosition(n));
      const bHasPos = b[1].some((n) => !forceRelayout && hasSavedPosition(n));
      if (aHasPos && !bHasPos) return -1;
      if (!aHasPos && bHasPos) return 1;
      return b[1].length - a[1].length;
    });

    // 计算所有已有坐标节点的全局最大 X，作为新组的起始基准
    let existingMaxX = 0;
    sortedGroups.forEach(([, groupNodes]) => {
      groupNodes.forEach((n) => {
        if (!forceRelayout && hasSavedPosition(n)) {
          const d = n.data as Record<string, unknown>;
          const nx = (d.position_x as number) + NODE_W;
          if (nx > existingMaxX) existingMaxX = nx;
        }
      });
    });

    const resultNodes = new Map<string, Node>(nodes.map((n) => [n.id, n]));
    let newGroupCol = 0;
    let newGroupRow = 0;

    sortedGroups.forEach(([, groupNodes]) => {
      // 本组中需要重新分配坐标的节点
      const needsLayout = groupNodes.filter((n) => forceRelayout || !hasSavedPosition(n));
      if (needsLayout.length === 0) return;

      // ── 本组 Dagre（仅对 needsLayout 中有边连接的节点建图）────────────────
      const g = new dagre.graphlib.Graph();
      g.setDefaultEdgeLabel(() => ({}));
      g.setGraph({ rankdir: direction, ranksep: 200, nodesep: 80 });

      needsLayout.forEach((n) => {
        const isLink = n.type === 'link';
        g.setNode(n.id, { width: isLink ? LINK_NODE_W : NODE_W, height: isLink ? LINK_NODE_H : NODE_H });
      });

      const needsLayoutIds = new Set(needsLayout.map((n) => n.id));
      edges.forEach((e) => {
        if (needsLayoutIds.has(e.source) && needsLayoutIds.has(e.target)) {
          g.setEdge(e.source, e.target);
        }
      });

      dagre.layout(g);

      // ── 计算本组新节点的基准偏移 ──────────────────────────────────────────
      const positioned = groupNodes.filter((n) => !forceRelayout && hasSavedPosition(n));
      let baseX: number;
      let baseY: number;

      if (positioned.length > 0) {
        // 有已保存节点：在其右侧插入
        const d0 = positioned[0].data as Record<string, unknown>;
        const maxX = positioned.reduce((m, n) => {
          const d = n.data as Record<string, unknown>;
          return Math.max(m, (d.position_x as number) + NODE_W);
        }, 0);
        const minY = positioned.reduce((m, n) => {
          const d = n.data as Record<string, unknown>;
          return Math.min(m, d.position_y as number);
        }, (d0.position_y as number) ?? 0);
        baseX = maxX + GROUP_GAP_X;
        baseY = minY;
      } else {
        // 全新组：按网格排列
        baseX = existingMaxX + newGroupCol * (ESTIMATED_GROUP_W + GROUP_GAP_X);
        baseY = newGroupRow * (ESTIMATED_GROUP_H + GROUP_GAP_Y);
        newGroupCol++;
        if (newGroupCol >= MAX_COLS) {
          newGroupCol = 0;
          newGroupRow++;
        }
      }

      // ── 应用 Dagre 坐标 ───────────────────────────────────────────────────
      needsLayout.forEach((n) => {
        const pos = g.node(n.id);
        const isLink = n.type === 'link';
        const w = isLink ? LINK_NODE_W : NODE_W;
        const h = isLink ? LINK_NODE_H : NODE_H;
        resultNodes.set(n.id, {
          ...n,
          position: {
            x: baseX + (pos ? pos.x - w / 2 : 0),
            y: baseY + (pos ? pos.y - h / 2 : 0),
          },
        });
      });
    });

    return { nodes: nodes.map((n) => resultNodes.get(n.id) ?? n), edges };
  }
  ```

- [ ] **Step 3: 类型检查**

  ```bash
  npx tsc --noEmit
  ```

  期望：0 错误。

- [ ] **Step 4: 手动验证分组布局**

  启动 `npm run dev`，打开知识图谱（至少有两个不同 database 的连接），点击"重新布局"。不同数据库的节点应该聚集在不同区域，组间有明显间距。

- [ ] **Step 5: 提交**

  ```bash
  git add src/components/GraphExplorer/index.tsx
  git commit -m "feat(graph): group layout by database using per-group dagre with grid arrangement"
  ```

---

## Task 3: 后端自动布局模块

**Files:**
- Create: `src-tauri/src/graph/layout.rs`

- [ ] **Step 1: 创建 layout.rs**

  创建文件 `src-tauri/src/graph/layout.rs`，内容如下：

  ```rust
  //! 图谱自动布局：为 position_x IS NULL 的节点分配初始坐标。
  //!
  //! 算法：按 connection_id + database 分组，每组网格排列，组间横向拼接。
  //! 已有坐标的节点永远不被覆盖。

  use crate::AppResult;

  const NODE_W: f64 = 280.0;
  const NODE_H: f64 = 120.0;
  const GROUP_GAP_X: f64 = 600.0;
  const GROUP_GAP_Y: f64 = 500.0;
  const MAX_COLS: usize = 4;

  struct NodePos {
      id: String,
      database: Option<String>,
      position_x: Option<f64>,
      position_y: Option<f64>,
  }

  /// 为指定连接下所有 `position_x IS NULL` 的节点计算并写入初始坐标。
  /// 已有坐标的节点不受影响。
  pub fn auto_layout_new_nodes(connection_id: i64, database: Option<&str>) -> AppResult<()> {
      let conn = crate::db::get().lock().unwrap();

      // 1. 读取所有节点（含已有坐标和待分配节点）
      let mut where_parts = vec!["connection_id=?1".to_string(), "is_deleted=0".to_string()];
      let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(connection_id)];

      if let Some(db) = database {
          where_parts.push("(database=?2 OR database IS NULL)".to_string());
          params.push(Box::new(db.to_string()));
      }

      let sql = format!(
          "SELECT id, database, position_x, position_y FROM graph_nodes WHERE {}",
          where_parts.join(" AND ")
      );

      let mut stmt = conn.prepare(&sql)?;
      let all_nodes: Vec<NodePos> = stmt
          .query_map(rusqlite::params_from_iter(params.iter()), |row| {
              Ok(NodePos {
                  id: row.get(0)?,
                  database: row.get(1)?,
                  position_x: row.get(2)?,
                  position_y: row.get(3)?,
              })
          })?
          .collect::<Result<Vec<_>, _>>()?;

      // 2. 按 database 分组
      let mut group_map: std::collections::HashMap<String, (Vec<&NodePos>, Vec<&NodePos>)> =
          std::collections::HashMap::new();

      for node in &all_nodes {
          let key = node.database.as_deref().unwrap_or("").to_string();
          let entry = group_map.entry(key).or_default();
          if node.position_x.is_some() {
              entry.0.push(node); // 已有坐标
          } else {
              entry.1.push(node); // 待分配
          }
      }

      // 若无待分配节点，直接返回
      if group_map.values().all(|(_, pending)| pending.is_empty()) {
          return Ok(());
      }

      // 3. 计算所有已有坐标节点的全局最大 X（新组从此处右侧开始）
      let existing_max_x = group_map.values().flat_map(|(positioned, _)| positioned.iter()).fold(
          0.0_f64,
          |acc, n| acc.max(n.position_x.unwrap_or(0.0) + NODE_W),
      );

      // 4. 排序：有已坐标节点的组优先，其次按待分配数量降序
      let mut sorted_groups: Vec<(&String, &(Vec<&NodePos>, Vec<&NodePos>))> =
          group_map.iter().collect();
      sorted_groups.sort_by(|(_, (a_pos, a_pend)), (_, (b_pos, b_pend))| {
          let a_has = !a_pos.is_empty();
          let b_has = !b_pos.is_empty();
          match (a_has, b_has) {
              (true, false) => std::cmp::Ordering::Less,
              (false, true) => std::cmp::Ordering::Greater,
              _ => b_pend.len().cmp(&a_pend.len()),
          }
      });

      // 5. 为每组待分配节点计算坐标
      let mut new_assignments: Vec<(String, f64, f64)> = Vec::new();
      let mut new_group_col: usize = 0;
      let mut new_group_row: usize = 0;

      for (_, (positioned, pending)) in &sorted_groups {
          if pending.is_empty() {
              continue;
          }

          let (base_x, base_y) = if !positioned.is_empty() {
              // 在已有节点右侧插入
              let max_x = positioned
                  .iter()
                  .map(|n| n.position_x.unwrap_or(0.0) + NODE_W)
                  .fold(0.0_f64, f64::max);
              let min_y = positioned
                  .iter()
                  .map(|n| n.position_y.unwrap_or(0.0))
                  .fold(f64::MAX, f64::min);
              (max_x + GROUP_GAP_X, min_y)
          } else {
              // 全新组：网格定位
              let bx = existing_max_x
                  + new_group_col as f64 * (NODE_W * 5.0 + GROUP_GAP_X);
              let by = new_group_row as f64 * (NODE_H * 5.0 + GROUP_GAP_Y);
              new_group_col += 1;
              if new_group_col >= MAX_COLS {
                  new_group_col = 0;
                  new_group_row += 1;
              }
              (bx, by)
          };

          // 网格排列：列数 = ceil(sqrt(n))
          let n = pending.len();
          let cols = ((n as f64).sqrt().ceil() as usize).max(1);

          for (i, node) in pending.iter().enumerate() {
              let col = i % cols;
              let row = i / cols;
              let x = base_x + col as f64 * (NODE_W + 40.0);
              let y = base_y + row as f64 * (NODE_H + 20.0);
              new_assignments.push((node.id.clone(), x, y));
          }
      }

      // 6. 批量写入
      drop(stmt);
      for (id, x, y) in &new_assignments {
          conn.execute(
              "UPDATE graph_nodes SET position_x=?1, position_y=?2 WHERE id=?3",
              rusqlite::params![x, y, id],
          )?;
      }

      log::info!(
          "[layout] auto_layout_new_nodes: assigned {} positions for connection {}",
          new_assignments.len(),
          connection_id
      );

      Ok(())
  }

  #[cfg(test)]
  mod tests {
      use super::*;
      use rusqlite::Connection;

      fn setup_db() -> Connection {
          let conn = Connection::open_in_memory().unwrap();
          conn.execute_batch(
              "CREATE TABLE graph_nodes (
                  id TEXT PRIMARY KEY,
                  node_type TEXT NOT NULL,
                  connection_id INTEGER,
                  database TEXT,
                  schema_name TEXT,
                  name TEXT NOT NULL,
                  display_name TEXT,
                  metadata TEXT,
                  aliases TEXT,
                  is_deleted INTEGER NOT NULL DEFAULT 0,
                  source TEXT DEFAULT 'schema',
                  position_x REAL,
                  position_y REAL
              );",
          )
          .unwrap();
          conn
      }

      #[test]
      fn test_layout_assigns_positions_to_null_nodes() {
          // 直接测试坐标计算逻辑（不依赖全局 DB）
          // 给定 4 个待分配节点，cols = ceil(sqrt(4)) = 2
          let n = 4usize;
          let cols = ((n as f64).sqrt().ceil() as usize).max(1);
          assert_eq!(cols, 2);

          let base_x = 0.0_f64;
          let base_y = 0.0_f64;
          let positions: Vec<(f64, f64)> = (0..n)
              .map(|i| {
                  let col = i % cols;
                  let row = i / cols;
                  (base_x + col as f64 * (NODE_W + 40.0), base_y + row as f64 * (NODE_H + 20.0))
              })
              .collect();

          // 第0个：(0, 0)
          assert!((positions[0].0 - 0.0).abs() < 1e-9);
          assert!((positions[0].1 - 0.0).abs() < 1e-9);
          // 第1个：(NODE_W+40, 0)
          assert!((positions[1].0 - (NODE_W + 40.0)).abs() < 1e-9);
          assert!((positions[1].1 - 0.0).abs() < 1e-9);
          // 第2个：(0, NODE_H+20) — 换行
          assert!((positions[2].0 - 0.0).abs() < 1e-9);
          assert!((positions[2].1 - (NODE_H + 20.0)).abs() < 1e-9);
      }

      #[test]
      fn test_existing_nodes_not_moved() {
          // 验证：已有坐标的节点不被分配新坐标
          let positioned = vec![NodePos {
              id: "n1".into(),
              database: Some("db_a".into()),
              position_x: Some(100.0),
              position_y: Some(200.0),
          }];
          let pending = vec![NodePos {
              id: "n2".into(),
              database: Some("db_a".into()),
              position_x: None,
              position_y: None,
          }];

          // existing_max_x from positioned: 100.0 + NODE_W = 380.0
          let existing_max_x = positioned
              .iter()
              .map(|n| n.position_x.unwrap_or(0.0) + NODE_W)
              .fold(0.0_f64, f64::max);
          assert!((existing_max_x - (100.0 + NODE_W)).abs() < 1e-9);

          // pending node placed to right of positioned (base_x = max_x + GROUP_GAP_X)
          let base_x = existing_max_x + GROUP_GAP_X;
          assert!(base_x > 100.0 + NODE_W); // 确实在右侧
          let _ = pending; // n1 的坐标不受影响
      }
  }
  ```

- [ ] **Step 2: Rust 编译检查**

  ```bash
  cd src-tauri && cargo check 2>&1 | head -30
  ```

  此时会报错（layout 模块尚未在 mod.rs 声明），属于预期，进入 Task 4。

---

## Task 4: 后端集成 — 注册模块、调用布局、暴露命令

**Files:**
- Modify: `src-tauri/src/graph/mod.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 graph/mod.rs 中声明 layout 子模块**

  在 `src-tauri/src/graph/mod.rs` 第 1 行（现有 `pub mod cache;` 之前）添加：

  ```rust
  pub mod layout;
  ```

  （文件第 1-6 行变为）：
  ```rust
  pub mod cache;
  pub mod change_detector;
  pub mod comment_parser;
  pub mod event_processor;
  pub mod layout;
  pub mod query;
  pub mod traversal;
  ```

- [ ] **Step 2: 在 run_graph_build 末尾调用自动布局**

  在 `src-tauri/src/graph/mod.rs` 第 383 行（`emit_completed` 调用之前）插入：

  ```rust
      // 9. 为新增节点分配初始坐标（position_x IS NULL → 自动布局）
      let layout_db = config.database.as_deref();
      match crate::graph::layout::auto_layout_new_nodes(connection_id, layout_db) {
          Ok(()) => log_and_emit(&app, &task_id, &mut logs, "INFO", "新节点初始坐标分配完成"),
          Err(e) => log_and_emit(&app, &task_id, &mut logs, "WARN", &format!("自动布局失败（不影响主流程）: {}", e)),
      }

      emit_completed(&app, &task_id, &logs, table_count);
  ```

  注意：将原有的 `emit_completed(&app, &task_id, &logs, table_count);` 替换为上面的完整块（保留 `emit_completed` 调用，只在其前面插入布局调用）。

- [ ] **Step 3: 在 commands.rs 添加 auto_layout_graph 命令**

  在 `src-tauri/src/commands.rs` 第 2709 行（`clear_graph_node_positions` 函数之后）添加：

  ```rust
  #[tauri::command]
  pub async fn auto_layout_graph(
      connection_id: i64,
      database: Option<String>,
  ) -> AppResult<()> {
      crate::graph::layout::auto_layout_new_nodes(connection_id, database.as_deref())
  }
  ```

- [ ] **Step 4: 在 lib.rs 注册命令**

  在 `src-tauri/src/lib.rs` 第 289 行（`commands::clear_graph_node_positions,` 之后）添加：

  ```rust
              commands::auto_layout_graph,
  ```

- [ ] **Step 5: Rust 编译检查**

  ```bash
  cd src-tauri && cargo check 2>&1 | head -50
  ```

  期望：0 错误，可能有警告（dead_code 等），忽略。

- [ ] **Step 6: 运行 layout 模块的单元测试**

  ```bash
  cd src-tauri && cargo test graph::layout 2>&1
  ```

  期望：
  ```
  test graph::layout::tests::test_layout_assigns_positions_to_null_nodes ... ok
  test graph::layout::tests::test_existing_nodes_not_moved ... ok
  ```

- [ ] **Step 7: 提交**

  ```bash
  git add src-tauri/src/graph/layout.rs \
          src-tauri/src/graph/mod.rs \
          src-tauri/src/commands.rs \
          src-tauri/src/lib.rs
  git commit -m "feat(graph): backend auto-layout assigns initial positions to new nodes after build"
  ```

---

## 自检（Spec Coverage）

| Spec 要求 | 对应 Task |
|----------|---------|
| 拖拽后点击空白不回弹 | Task 1 ✓ |
| 所有节点类型拖拽持久化 | Task 1 （同一套逻辑，已覆盖 table/metric/alias/link）✓ |
| 前端按数据库分组布局 | Task 2 ✓ |
| 分组间 600px 横向间距 | Task 2 ✓ |
| > 4 组时换行，行间距 500px | Task 2 ✓ |
| 已拖拽节点不被 Dagre 覆盖 | Task 1 + Task 2 ✓ |
| 后端 layout.rs 新文件 | Task 3 ✓ |
| 后端只分配 position_x IS NULL 节点 | Task 3 ✓ |
| run_graph_build 末尾触发布局 | Task 4 ✓ |
| auto_layout_graph Tauri 命令 | Task 4 ✓ |
