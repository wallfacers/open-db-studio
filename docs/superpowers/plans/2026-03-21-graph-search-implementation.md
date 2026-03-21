# 知识图谱实体搜索与多跳路径查询 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 GraphExplorer 实现 FTS5 实体搜索侧边栏 + 多跳路径查询面板，暴露后端已有的 `find_relevant_subgraph` BFS 能力。

**Architecture:** 新增 `find_subgraph` Tauri 命令（后端桥接）；前端新增 GraphSearchPanel（含 SearchTab / PathTab）及两个 Hook；修改 index.tsx 扩展 activePanel/highlight/subgraph 状态；修改 GraphNodeComponents 渲染高亮角色徽章。

**Tech Stack:** Rust (tauri::command, rusqlite), React 18 + TypeScript, @xyflow/react fitView, lucide-react icons, Tailwind CSS (Abyss theme)

**Spec:** `docs/superpowers/specs/2026-03-21-graph-search-design.md`

---

## 文件清单

| 操作 | 文件 |
|------|------|
| 修改 | `src-tauri/src/commands.rs` — 新增 `find_subgraph` |
| 修改 | `src-tauri/src/lib.rs` — 注册命令 |
| 新建 | `src/components/GraphExplorer/useGraphSearch.ts` |
| 新建 | `src/components/GraphExplorer/usePathFinder.ts` |
| 新建 | `src/components/GraphExplorer/SearchTab.tsx` |
| 新建 | `src/components/GraphExplorer/PathTab.tsx` |
| 新建 | `src/components/GraphExplorer/GraphSearchPanel.tsx` |
| 修改 | `src/components/GraphExplorer/GraphNodeComponents.tsx` — 高亮/角色徽章 |
| 修改 | `src/components/GraphExplorer/index.tsx` — 状态扩展 + 集成 |

**并发分组：**
- **Group 1（并发）**：Task 1（后端）、Task 2（useGraphSearch）、Task 3（usePathFinder）、Task 4（GraphNodeComponents 高亮）
- **Group 2（并发）**：Task 5（SearchTab）、Task 6（PathTab）—— 需 Group 1 完成
- **Group 3**：Task 7（GraphSearchPanel）—— 需 Group 2 完成
- **Group 4**：Task 8（index.tsx 集成）—— 需 Group 3 + Task 1 + Task 4 完成

---

## Task 1: 后端 `find_subgraph` 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`（末尾追加函数）
- Modify: `src-tauri/src/lib.rs`（generate_handler![] 中注册）

- [ ] **Step 1: 在 commands.rs 末尾追加命令**

```rust
// ============ 图谱路径查询 ============

#[tauri::command]
pub async fn find_subgraph(
    _app: tauri::AppHandle,
    connection_id: i64,
    from_node_id: String,
    to_node_id: String,
    max_hops: u8,
) -> AppResult<crate::graph::query::SubGraph> {
    // 1. 查询起点节点
    let (from_type, from_name): (String, String) = {
        let conn = crate::db::get().lock().unwrap();
        conn.query_row(
            "SELECT node_type, name FROM graph_nodes WHERE id=?1 AND is_deleted=0",
            [&from_node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| AppError::Other(format!("节点 {} 不存在", from_node_id)))?
    };

    // 2. 查询终点节点
    let (to_type, to_name): (String, String) = {
        let conn = crate::db::get().lock().unwrap();
        conn.query_row(
            "SELECT node_type, name FROM graph_nodes WHERE id=?1 AND is_deleted=0",
            [&to_node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| AppError::Other(format!("节点 {} 不存在", to_node_id)))?
    };

    // 3. 限制：仅支持 table 节点
    if from_type != "table" || to_type != "table" {
        return Err(AppError::Other(
            "路径查询仅支持表节点（node_type='table'）".to_string(),
        ));
    }

    // 4. 复用现有 BFS + LRU 缓存
    let entities = vec![from_name, to_name];
    crate::graph::query::find_relevant_subgraph(connection_id, &entities, max_hops).await
}
```

- [ ] **Step 2: 在 lib.rs 的 generate_handler![] 末尾（`commands::update_graph_edge,` 之后，`]` 之前）注册**

```rust
            commands::find_subgraph,
```

- [ ] **Step 3: Rust 编译检查**

```bash
cd src-tauri && cargo check
```

预期：无错误（warning 可忽略）

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(graph): add find_subgraph tauri command for multi-hop path query"
```

---

## Task 2: `useGraphSearch.ts` Hook

**Files:**
- Create: `src/components/GraphExplorer/useGraphSearch.ts`

- [ ] **Step 1: 创建文件**

```typescript
import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GraphNode } from './useGraphData';

interface UseGraphSearchResult {
  keyword: string;
  setKeyword: (kw: string) => void;
  results: GraphNode[];
  loading: boolean;
  searched: boolean; // true if a search has been attempted
}

export function useGraphSearch(connectionId: number | null): UseGraphSearchResult {
  const [keyword, setKeywordState] = useState('');
  const [results, setResults] = useState<GraphNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setKeyword = useCallback((kw: string) => {
    setKeywordState(kw);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!kw.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }

    if (connectionId === null) return;

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await invoke<GraphNode[]>('search_graph', {
          connectionId,
          keyword: kw.trim(),
        });
        setResults(res);
        setSearched(true);
      } catch {
        setResults([]);
        setSearched(true);
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [connectionId]);

  return { keyword, setKeyword, results, loading, searched };
}
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

预期：无新增错误

- [ ] **Step 3: Commit**

```bash
git add src/components/GraphExplorer/useGraphSearch.ts
git commit -m "feat(graph): add useGraphSearch hook with 300ms debounce FTS5 search"
```

---

## Task 3: `usePathFinder.ts` Hook

**Files:**
- Create: `src/components/GraphExplorer/usePathFinder.ts`

- [ ] **Step 1: 创建文件**

```typescript
import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GraphNode, GraphEdge } from './useGraphData';

export interface SubGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  join_paths: string[][];
}

interface UsePathFinderResult {
  loading: boolean;
  error: string | null;
  subgraph: SubGraph | null;
  findPath: (
    connectionId: number,
    fromNodeId: string,
    toNodeId: string,
    maxHops: number,
  ) => Promise<void>;
  reset: () => void;
  /** node id → display name mapping built from subgraph.nodes */
  nodeDisplayMap: Record<string, string>;
}

export function usePathFinder(): UsePathFinderResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subgraph, setSubgraph] = useState<SubGraph | null>(null);
  const [nodeDisplayMap, setNodeDisplayMap] = useState<Record<string, string>>({});

  const findPath = useCallback(async (
    connectionId: number,
    fromNodeId: string,
    toNodeId: string,
    maxHops: number,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const sg = await invoke<SubGraph>('find_subgraph', {
        connectionId,
        fromNodeId,
        toNodeId,
        maxHops,
      });
      setSubgraph(sg);
      const map: Record<string, string> = {};
      sg.nodes.forEach(n => { map[n.id] = n.display_name || n.name; });
      setNodeDisplayMap(map);
    } catch (e) {
      setError(String(e));
      setSubgraph(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setSubgraph(null);
    setError(null);
    setNodeDisplayMap({});
  }, []);

  return { loading, error, subgraph, findPath, reset, nodeDisplayMap };
}
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/components/GraphExplorer/usePathFinder.ts
git commit -m "feat(graph): add usePathFinder hook wrapping find_subgraph command"
```

---

## Task 4: GraphNodeComponents 高亮与角色徽章

**Files:**
- Modify: `src/components/GraphExplorer/GraphNodeComponents.tsx`

此 Task 需先读取文件再编辑。

- [ ] **Step 1: 在 `GraphNodeData` 接口中追加高亮字段**

在 `GraphNodeData` interface（第14行）的 `onHighlightLinks?:` 字段之后追加：

```typescript
  isHighlighted?: boolean;   // 在路径高亮集合中
  isDimmed?: boolean;        // 路径高亮激活时不在集合中（opacity-30）
  isPathFrom?: boolean;      // 路径起点（绿色 S 徽章）
  isPathTo?: boolean;        // 路径终点（蓝色 T 徽章）
```

- [ ] **Step 2: 新增 `NodeRoleBadge` helper 组件**

在 `BaseNode` 函数定义（第47行）之前插入：

```typescript
/** 节点角色徽章：起点(S) 或 终点(T)，显示在节点右上角 */
function NodeRoleBadge({ isPathFrom, isPathTo }: { isPathFrom?: boolean; isPathTo?: boolean }) {
  if (!isPathFrom && !isPathTo) return null;
  return (
    <div
      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold z-10"
      style={{ background: isPathFrom ? '#4ade80' : '#5eb2f7', color: '#0d1117' }}
    >
      {isPathFrom ? 'S' : 'T'}
    </div>
  );
}
```

- [ ] **Step 3: 修改 `BaseNode` 根 div 支持高亮/暗化**

将 `BaseNode` 中的根 div（第74行）：
```typescript
    <div className={`w-60 rounded-md border bg-[#111922] shadow-lg ${borderClass} group`}>
```
改为：
```typescript
    <div
      className={`w-60 rounded-md border bg-[#111922] shadow-lg ${borderClass} group relative transition-opacity ${
        data.isDimmed ? 'opacity-30' : ''
      } ${data.isHighlighted ? 'accent-glow' : ''}`}
    >
      <NodeRoleBadge isPathFrom={data.isPathFrom} isPathTo={data.isPathTo} />
```

- [ ] **Step 4: 修改 `TableNodeComponent` 根 div 支持高亮/暗化**

`TableNodeComponent`（第150行）的根 div：
```typescript
    <div className="w-60 rounded-md border border-[#3794ff] bg-[#111922] shadow-lg group">
```
改为：
```typescript
    <div
      className={`w-60 rounded-md border border-[#3794ff] bg-[#111922] shadow-lg group relative transition-opacity ${
        nodeData.isDimmed ? 'opacity-30' : ''
      } ${nodeData.isHighlighted ? 'accent-glow' : ''}`}
    >
      <NodeRoleBadge isPathFrom={nodeData.isPathFrom} isPathTo={nodeData.isPathTo} />
```

- [ ] **Step 5: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/components/GraphExplorer/GraphNodeComponents.tsx
git commit -m "feat(graph): add highlight/dim/role-badge support to graph node components"
```

---

## Task 5: `SearchTab.tsx`

**Files:**
- Create: `src/components/GraphExplorer/SearchTab.tsx`

依赖：Task 2（useGraphSearch）需已 commit。

- [ ] **Step 1: 创建文件**

```typescript
import React from 'react';
import { Loader2, Search } from 'lucide-react';
import type { GraphNode } from './useGraphData';
import { useGraphSearch } from './useGraphSearch';
import { useReactFlow } from '@xyflow/react';

interface SearchTabProps {
  connectionId: number | null;
  visibleNodeIds: Set<string>;
  onSetPathFrom: (node: GraphNode) => void;
  onSetPathTo: (node: GraphNode) => void;
  onHighlightNode: (nodeId: string) => void;
  onSwitchToPath: () => void;
}

export function SearchTab({
  connectionId,
  visibleNodeIds,
  onSetPathFrom,
  onSetPathTo,
  onHighlightNode,
  onSwitchToPath,
}: SearchTabProps) {
  const { keyword, setKeyword, results, loading, searched } = useGraphSearch(connectionId);
  const { fitView } = useReactFlow();

  const handleItemClick = (node: GraphNode) => {
    onHighlightNode(node.id);
    fitView({ nodes: [{ id: node.id }], duration: 500, padding: 0.3, maxZoom: 1.5 });
  };

  const handleSetFrom = (e: React.MouseEvent, node: GraphNode) => {
    e.stopPropagation();
    onSetPathFrom(node);
    onSwitchToPath();
  };

  const handleSetTo = (e: React.MouseEvent, node: GraphNode) => {
    e.stopPropagation();
    onSetPathTo(node);
    onSwitchToPath();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search Input */}
      <div className="p-3 border-b border-[#1e2d42]">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#7a9bb8] pointer-events-none" />
          {loading && (
            <Loader2 size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#7a9bb8] animate-spin" />
          )}
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="搜索节点名称..."
            className="w-full pl-7 pr-7 py-1.5 text-xs bg-[#111922] border border-[#1e2d42] rounded text-[#c8daea] placeholder-[#3d5470] focus:outline-none focus:border-[#00a98f] transition-colors"
          />
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {!searched && !loading && (
          <p className="text-[#3d5470] text-xs text-center mt-8 px-4">输入关键词搜索图谱节点</p>
        )}

        {searched && results.length === 0 && !loading && (
          <p className="text-[#7a9bb8] text-xs text-center mt-8 px-4">未找到匹配节点</p>
        )}

        {results.map(node => {
          const isTable = node.node_type === 'table';
          const isHidden = !visibleNodeIds.has(node.id);
          return (
            <div
              key={node.id}
              onClick={() => handleItemClick(node)}
              className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[#1a2639] border-b border-[#1e2d42]/50 group"
            >
              {/* Node type badge */}
              <span
                className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded font-mono"
                style={{
                  background: node.node_type === 'table' ? '#0d2a3d'
                    : node.node_type === 'metric' ? '#2d1e0d'
                    : '#1e0d2d',
                  color: node.node_type === 'table' ? '#3794ff'
                    : node.node_type === 'metric' ? '#f59e0b'
                    : '#a855f7',
                }}
              >
                {node.node_type.toUpperCase()}
              </span>

              {/* Name */}
              <div className="flex-1 min-w-0">
                <p className="text-[#c8daea] text-xs truncate">{node.name}</p>
                {node.display_name && node.display_name !== node.name && (
                  <p className="text-[#3d5470] text-[10px] truncate">{node.display_name}</p>
                )}
                {isHidden && (
                  <p className="text-[#f59e0b] text-[9px]">当前已过滤，节点不可见</p>
                )}
              </div>

              {/* S / T buttons */}
              <div className="flex-shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={e => handleSetFrom(e, node)}
                  disabled={!isTable}
                  title={isTable ? '设为路径起点' : '仅支持表节点'}
                  className="w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ background: '#0a2010', color: '#4ade80', border: '1px solid #4ade8044' }}
                >
                  S
                </button>
                <button
                  onClick={e => handleSetTo(e, node)}
                  disabled={!isTable}
                  title={isTable ? '设为路径终点' : '仅支持表节点'}
                  className="w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ background: '#0a1525', color: '#5eb2f7', border: '1px solid #5eb2f744' }}
                >
                  T
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/components/GraphExplorer/SearchTab.tsx
git commit -m "feat(graph): add SearchTab with FTS5 search results and S/T endpoint buttons"
```

---

## Task 6: `PathTab.tsx`

**Files:**
- Create: `src/components/GraphExplorer/PathTab.tsx`

依赖：Task 3（usePathFinder）需已 commit。

- [ ] **Step 1: 创建文件**

```typescript
import React, { useState } from 'react';
import { Loader2, X, RotateCcw, GitFork } from 'lucide-react';
import type { GraphNode } from './useGraphData';
import { usePathFinder } from './usePathFinder';
import { useReactFlow } from '@xyflow/react';

const MAX_PATHS_SHOWN = 20;

interface PathTabProps {
  connectionId: number | null;
  pathFrom: GraphNode | null;
  pathTo: GraphNode | null;
  onClearFrom: () => void;
  onClearTo: () => void;
  onHighlightPath: (nodeIds: Set<string>, edgeIds: Set<string>) => void;
  onEnterSubgraph: (nodeIds: Set<string>) => void;
  subgraphMode: boolean;
  onExitSubgraph: () => void;
}

export function PathTab({
  connectionId,
  pathFrom,
  pathTo,
  onClearFrom,
  onClearTo,
  onHighlightPath,
  onEnterSubgraph,
  subgraphMode,
  onExitSubgraph,
}: PathTabProps) {
  const [maxHops, setMaxHops] = useState(3);
  const [selectedPathIndex, setSelectedPathIndex] = useState<number | null>(null);
  const { loading, error, subgraph, findPath, reset, nodeDisplayMap } = usePathFinder();
  const { fitView } = useReactFlow();

  const sameNode = pathFrom && pathTo && pathFrom.id === pathTo.id;
  const canQuery = pathFrom && pathTo && !sameNode && connectionId !== null;

  const handleFindPath = async () => {
    if (!canQuery) return;
    setSelectedPathIndex(null);
    reset();
    await findPath(connectionId!, pathFrom!.id, pathTo!.id, maxHops);
  };

  const handleSelectPath = (pathIndex: number) => {
    if (!subgraph) return;
    const path = subgraph.join_paths[pathIndex];
    if (!path) return;
    setSelectedPathIndex(pathIndex);

    const pathNodeSet = new Set(path);
    const pathEdgeSet = new Set<string>(
      subgraph.edges
        .filter(e => pathNodeSet.has(e.from_node) && pathNodeSet.has(e.to_node))
        .map(e => e.id)
    );

    onHighlightPath(pathNodeSet, pathEdgeSet);

    // fitView to path nodes
    const rfNodes = path.map(id => ({ id }));
    fitView({ nodes: rfNodes, duration: 500, padding: 0.3, maxZoom: 1.5 });
  };

  const handleEnterSubgraph = () => {
    if (!subgraph) return;
    const allIds = new Set(subgraph.nodes.map(n => n.id));
    onEnterSubgraph(allIds);
  };

  const shownPaths = subgraph ? subgraph.join_paths.slice(0, MAX_PATHS_SHOWN) : [];
  const truncated = subgraph && subgraph.join_paths.length > MAX_PATHS_SHOWN;

  return (
    <div className="flex flex-col h-full">
      {/* Endpoint slots */}
      <div className="p-3 border-b border-[#1e2d42] space-y-2">
        {/* FROM slot */}
        <div className="flex items-center gap-2">
          <span
            className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: '#0a2010', color: '#4ade80', border: '1px solid #4ade8044' }}
          >
            FROM
          </span>
          {pathFrom ? (
            <div className="flex-1 flex items-center gap-1 min-w-0">
              <span className="text-[#c8daea] text-xs truncate flex-1">{pathFrom.name}</span>
              <button onClick={onClearFrom} className="flex-shrink-0 text-[#7a9bb8] hover:text-white">
                <X size={11} />
              </button>
            </div>
          ) : (
            <span className="text-[#3d5470] text-xs">在搜索结果中点击 [S] 设置</span>
          )}
        </div>

        {/* TO slot */}
        <div className="flex items-center gap-2">
          <span
            className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: '#0a1525', color: '#5eb2f7', border: '1px solid #5eb2f744' }}
          >
            TO
          </span>
          {pathTo ? (
            <div className="flex-1 flex items-center gap-1 min-w-0">
              <span className="text-[#c8daea] text-xs truncate flex-1">{pathTo.name}</span>
              <button onClick={onClearTo} className="flex-shrink-0 text-[#7a9bb8] hover:text-white">
                <X size={11} />
              </button>
            </div>
          ) : (
            <span className="text-[#3d5470] text-xs">在搜索结果中点击 [T] 设置</span>
          )}
        </div>

        {/* Max hops + query button */}
        <div className="flex items-center gap-2 pt-1">
          <label className="text-[#7a9bb8] text-xs flex-shrink-0">最大跳数</label>
          <input
            type="number"
            min={1}
            value={maxHops}
            onChange={e => setMaxHops(Math.max(1, Number(e.target.value) || 1))}
            className="w-14 px-2 py-1 text-xs bg-[#111922] border border-[#1e2d42] rounded text-[#c8daea] focus:outline-none focus:border-[#00a98f]"
          />
          <button
            onClick={handleFindPath}
            disabled={!canQuery || loading}
            title={sameNode ? '起点和终点不能相同' : undefined}
            className="flex-1 flex items-center justify-center gap-1 py-1 text-xs rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: '#0a1f18',
              color: '#00c9a7',
              borderColor: '#00a98f55',
            }}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <GitFork size={12} />}
            {loading ? '查找中...' : '查找路径'}
          </button>
        </div>

        {sameNode && (
          <p className="text-[#f43f5e] text-[10px]">起点和终点不能相同</p>
        )}
      </div>

      {/* Results area */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-3 p-2 rounded text-xs text-[#f43f5e] bg-[#2d1216] border border-[#f43f5e]/30">
            {error}
            <button
              onClick={handleFindPath}
              className="ml-2 underline underline-offset-2 hover:no-underline"
            >
              重试
            </button>
          </div>
        )}

        {subgraph && shownPaths.length === 0 && (
          <p className="text-[#7a9bb8] text-xs text-center mt-8 px-4">
            在 {maxHops} 跳范围内未找到路径，可尝试增大跳数
          </p>
        )}

        {truncated && (
          <p className="text-[#7a9bb8] text-[10px] text-center py-2 border-b border-[#1e2d42]">
            仅显示前 {MAX_PATHS_SHOWN} 条路径
          </p>
        )}

        {shownPaths.map((path, idx) => (
          <div
            key={idx}
            onClick={() => handleSelectPath(idx)}
            className={`px-3 py-2 cursor-pointer border-b border-[#1e2d42]/50 text-xs transition-colors ${
              selectedPathIndex === idx
                ? 'bg-[#003d2f] border-l-2 border-l-[#00c9a7]'
                : 'hover:bg-[#1a2639]'
            }`}
          >
            <p className="text-[#3d5470] text-[9px] mb-1">路径 {idx + 1} · {path.length} 节点</p>
            <p className="text-[#c8daea] leading-relaxed">
              {path.map((id, i) => (
                <span key={id}>
                  <span className={i === 0 ? 'text-[#4ade80]' : i === path.length - 1 ? 'text-[#5eb2f7]' : 'text-[#c8daea]'}>
                    {nodeDisplayMap[id] ?? id}
                  </span>
                  {i < path.length - 1 && <span className="text-[#3d5470] mx-1">→</span>}
                </span>
              ))}
            </p>
          </div>
        ))}

        {/* Extract subgraph button */}
        {subgraph && shownPaths.length > 0 && (
          <div className="p-3 border-t border-[#1e2d42]">
            {subgraphMode ? (
              <button
                onClick={onExitSubgraph}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs rounded border transition-colors"
                style={{ background: '#1a2639', color: '#c8daea', borderColor: '#1e2d42' }}
              >
                <RotateCcw size={12} />
                恢复全图
              </button>
            ) : (
              <button
                onClick={handleEnterSubgraph}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs rounded border transition-colors"
                style={{ background: '#003d2f', color: '#00c9a7', borderColor: '#00a98f55' }}
              >
                <GitFork size={12} />
                提取子图
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/components/GraphExplorer/PathTab.tsx
git commit -m "feat(graph): add PathTab with multi-hop path query, highlighting, and subgraph extraction"
```

---

## Task 7: `GraphSearchPanel.tsx`

**Files:**
- Create: `src/components/GraphExplorer/GraphSearchPanel.tsx`

依赖：Task 5（SearchTab）+ Task 6（PathTab）需已 commit。

- [ ] **Step 1: 创建文件**

```typescript
import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { GraphNode } from './useGraphData';
import { SearchTab } from './SearchTab';
import { PathTab } from './PathTab';

type PanelTab = 'search' | 'path';

interface GraphSearchPanelProps {
  connectionId: number | null;
  visibleNodeIds: Set<string>;
  pathFrom: GraphNode | null;
  pathTo: GraphNode | null;
  subgraphMode: boolean;
  onClose: () => void;
  onSetPathFrom: (node: GraphNode) => void;
  onSetPathTo: (node: GraphNode) => void;
  onClearPathFrom: () => void;
  onClearPathTo: () => void;
  onHighlightNode: (nodeId: string) => void;
  onHighlightPath: (nodeIds: Set<string>, edgeIds: Set<string>) => void;
  onEnterSubgraph: (nodeIds: Set<string>) => void;
  onExitSubgraph: () => void;
}

export function GraphSearchPanel({
  connectionId,
  visibleNodeIds,
  pathFrom,
  pathTo,
  subgraphMode,
  onClose,
  onSetPathFrom,
  onSetPathTo,
  onClearPathFrom,
  onClearPathTo,
  onHighlightNode,
  onHighlightPath,
  onEnterSubgraph,
  onExitSubgraph,
}: GraphSearchPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('search');

  return (
    <div
      className="flex flex-col border-l border-[#1e2d42] bg-[#0d1117] flex-shrink-0"
      style={{ width: 280 }}
    >
      {/* Panel header */}
      <div className="flex items-center border-b border-[#1e2d42] flex-shrink-0">
        {(['search', 'path'] as PanelTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === tab
                ? 'border-[#00c9a7] text-[#e8f4ff]'
                : 'border-transparent text-[#7a9bb8] hover:text-[#c8daea]'
            }`}
          >
            {tab === 'search' ? '搜索' : '路径'}
          </button>
        ))}
        <button
          onClick={onClose}
          className="px-2 py-2 text-[#7a9bb8] hover:text-white transition-colors flex-shrink-0"
          aria-label="关闭搜索面板"
        >
          <X size={14} />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'search' ? (
          <SearchTab
            connectionId={connectionId}
            visibleNodeIds={visibleNodeIds}
            onSetPathFrom={onSetPathFrom}
            onSetPathTo={onSetPathTo}
            onHighlightNode={onHighlightNode}
            onSwitchToPath={() => setActiveTab('path')}
          />
        ) : (
          <PathTab
            connectionId={connectionId}
            pathFrom={pathFrom}
            pathTo={pathTo}
            onClearFrom={onClearPathFrom}
            onClearTo={onClearPathTo}
            onHighlightPath={onHighlightPath}
            onEnterSubgraph={onEnterSubgraph}
            subgraphMode={subgraphMode}
            onExitSubgraph={onExitSubgraph}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/components/GraphExplorer/GraphSearchPanel.tsx
git commit -m "feat(graph): add GraphSearchPanel container with Search/Path tab switching"
```

---

## Task 8: `index.tsx` 状态扩展与集成

**Files:**
- Modify: `src/components/GraphExplorer/index.tsx`

依赖：Task 1（后端）、Task 4（GraphNodeComponents）、Task 7（GraphSearchPanel）需全部 commit。

此 Task 改动较多，分步骤进行，每步后运行类型检查。

- [ ] **Step 1: 新增 import**

在文件顶部现有 import 区域末尾（`import type { GraphNode } from './useGraphData';` 之后）追加：

```typescript
import { GraphSearchPanel } from './GraphSearchPanel';
```

并在 lucide-react import 中追加 `SearchCode`（或复用已有 `Search` 图标）：
将 `Search,` 改为 `Search,` 保持不变（Search 已被 toolbar 搜索框使用，GraphSearchPanel 按钮复用它即可）。

- [ ] **Step 2: 在 `GraphExplorerInner` 组件中添加新 state**

在 `const [showAliasEditorForNode, ...]` 之后追加：

```typescript
  // ── Search panel & path query state ────────────────────────────────────────
  const [activePanel, setActivePanel] = useState<'detail' | 'search' | null>(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [highlightedEdgeIds, setHighlightedEdgeIds] = useState<Set<string>>(new Set());
  const [pathFrom, setPathFrom] = useState<GraphNode | null>(null);
  const [pathTo, setPathTo] = useState<GraphNode | null>(null);
  const [subgraphMode, setSubgraphMode] = useState(false);
  const [subgraphNodeIds, setSubgraphNodeIds] = useState<Set<string>>(new Set());
```

- [ ] **Step 3: 修改 `clustered` useMemo 支持子图模式**

将：
```typescript
  const clustered = useMemo(() => clusterByConnection(filteredRaw), [filteredRaw]);
```
改为：
```typescript
  const sourceNodes = useMemo(
    () => subgraphMode ? filteredRaw.filter(n => subgraphNodeIds.has(n.id)) : filteredRaw,
    [filteredRaw, subgraphMode, subgraphNodeIds],
  );
  const clustered = useMemo(() => clusterByConnection(sourceNodes), [sourceNodes]);
```

- [ ] **Step 4: 修改 `toFlowNodes` 调用，将高亮状态注入节点 data**

将 `useEffect` 中的 `toFlowNodes` 调用（`const flowNodes = toFlowNodes(...)`）修改为：

```typescript
    const flowNodes = toFlowNodes(clustered, handleAddAlias, handleHighlightLinks, linkCountMap, columnMap).map(n => ({
      ...n,
      data: {
        ...n.data,
        isHighlighted: highlightedNodeIds.has(n.id),
        isDimmed: highlightedNodeIds.size > 0 && !highlightedNodeIds.has(n.id),
        isPathFrom: pathFrom?.id === n.id,
        isPathTo: pathTo?.id === n.id,
      },
    }));
```

并在该 `useEffect` 的依赖数组末尾补充 `highlightedNodeIds, pathFrom, pathTo`：
```typescript
  }, [clustered, filteredEdges, setRfNodes, setRfEdges, handleAddAlias, handleHighlightLinks, linkCountMap, fitView, highlightedNodeIds, pathFrom, pathTo]);
```

- [ ] **Step 5: 修改 `toFlowEdges` 调用，高亮路径边**

在同一 `useEffect` 内，将 `const flowEdges = toFlowEdges(filteredEdges)` 改为：

```typescript
    const flowEdges = toFlowEdges(filteredEdges).map(e => {
      if (highlightedEdgeIds.has(e.id)) {
        return {
          ...e,
          style: { ...e.style, stroke: '#00c9a7', strokeWidth: 3 },
          animated: true,
        };
      }
      if (highlightedEdgeIds.size > 0) {
        return { ...e, style: { ...e.style, opacity: 0.2 } };
      }
      return e;
    });
```

- [ ] **Step 6: 修改 `onNodeClick` 和 `onPaneClick`**

将 `onNodeClick` 改为：
```typescript
  const onNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      const raw = rawNodes.find((n) => n.id === node.id);
      if (raw) {
        setSelectedNode(raw);
        setActivePanel('detail');
      }
    },
    [rawNodes],
  );
```

将 `onPaneClick` 改为：
```typescript
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    if (event.detail >= 2) {
      setSelectedNode(null);
      setActivePanel(null);
    }
  }, []);
```

- [ ] **Step 7: 新增 highlight / path / subgraph 处理函数**

在 `handleAliasUpdated` 之后追加：

```typescript
  // ── Search panel handlers ───────────────────────────────────────────────────

  const handleHighlightNode = useCallback((nodeId: string) => {
    setHighlightedNodeIds(new Set([nodeId]));
    setHighlightedEdgeIds(new Set());
    setTimeout(() => setHighlightedNodeIds(new Set()), 2000);
  }, []);

  const handleHighlightPath = useCallback((nodeIds: Set<string>, edgeIds: Set<string>) => {
    setHighlightedNodeIds(new Set(nodeIds));
    setHighlightedEdgeIds(new Set(edgeIds));
  }, []);

  const handleEnterSubgraph = useCallback((nodeIds: Set<string>) => {
    setSubgraphNodeIds(nodeIds);
    setSubgraphMode(true);
  }, []);

  const handleExitSubgraph = useCallback(() => {
    setSubgraphMode(false);
    setSubgraphNodeIds(new Set());
    setHighlightedNodeIds(new Set());
    setHighlightedEdgeIds(new Set());
  }, []);
```

- [ ] **Step 8: 在工具栏中添加搜索面板切换按钮**

在工具栏右侧按钮组（`<div className="ml-auto flex items-center gap-1.5">`）的最前面添加搜索按钮：

```typescript
          {/* Search panel toggle */}
          <button
            onClick={() => {
              if (activePanel === 'search') {
                setActivePanel(null);
              } else {
                setSelectedNode(null);
                setActivePanel('search');
              }
            }}
            title="实体搜索 / 路径查询"
            className={`flex items-center gap-1 px-2 py-1 text-xs border rounded transition-colors ${
              activePanel === 'search'
                ? 'text-[#00c9a7] bg-[#0a1f18] border-[#00a98f55]'
                : 'text-[#7a9bb8] hover:text-[#c8daea] bg-[#111922] hover:bg-[#1e2d42] border-[#1e2d42]'
            }`}
          >
            <Search size={13} />
          </button>
```

- [ ] **Step 9: 修改 NodeDetail 面板的显示条件，并渲染 GraphSearchPanel**

将：
```typescript
        {/* Node detail panel */}
        {selectedNode && (
          <NodeDetail
            ...
          />
        )}
```
改为：
```typescript
        {/* Node detail panel */}
        {activePanel === 'detail' && selectedNode && (
          <NodeDetail
            node={selectedNode}
            edges={filteredEdges}
            nodeNameMap={nodeNameMap}
            onClose={() => { setSelectedNode(null); setActivePanel(null); }}
            onAliasUpdated={handleAliasUpdated}
            onRefresh={refetch}
          />
        )}

        {/* Search / Path panel */}
        {activePanel === 'search' && (
          <GraphSearchPanel
            connectionId={internalConnId}
            visibleNodeIds={visibleNodeIds}
            pathFrom={pathFrom}
            pathTo={pathTo}
            subgraphMode={subgraphMode}
            onClose={() => setActivePanel(null)}
            onSetPathFrom={setPathFrom}
            onSetPathTo={setPathTo}
            onClearPathFrom={() => setPathFrom(null)}
            onClearPathTo={() => setPathTo(null)}
            onHighlightNode={handleHighlightNode}
            onHighlightPath={handleHighlightPath}
            onEnterSubgraph={handleEnterSubgraph}
            onExitSubgraph={handleExitSubgraph}
          />
        )}
```

- [ ] **Step 10: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

预期：无错误。若有类型错误则修复后再继续。

- [ ] **Step 11: 前端开发服务器冒烟测试**

```bash
npm run dev
```

打开浏览器，验证：
1. 工具栏出现搜索按钮，点击后右侧出现 280px 搜索面板
2. 搜索 Tab 可输入关键词，有结果列表
3. 点击节点时面板切换为 NodeDetail
4. Path Tab 可设置起点/终点

- [ ] **Step 12: Commit**

```bash
git add src/components/GraphExplorer/index.tsx
git commit -m "feat(graph): integrate GraphSearchPanel into GraphExplorer with activePanel, highlight, and subgraph state"
```

---

## 最终验证清单

- [ ] `cargo check` 通过
- [ ] `npx tsc --noEmit` 无新增错误
- [ ] 工具栏搜索按钮可切换面板
- [ ] SearchTab FTS5 搜索返回结果，点击可 fitView 到目标节点
- [ ] [S]/[T] 按钮可设置路径端点，非 table 节点按钮禁用
- [ ] PathTab 查找路径后显示路径列表
- [ ] 点击路径条目高亮节点/边，非路径节点变暗
- [ ] 提取子图 / 恢复全图可切换
- [ ] 点击画布节点打开 NodeDetail（不再总是 selectedNode 直接控制）
- [ ] 双击画布空白关闭所有面板
