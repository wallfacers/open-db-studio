# 知识图谱实体搜索与多跳路径查询 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为知识图谱页面添加 FTS5 实体搜索侧边栏和节点到节点多跳路径查询功能。

**Architecture:** 后端新增 `find_subgraph` Tauri 命令，复用已有 BFS + LRU 缓存；前端新增搜索/路径侧边栏（GraphSearchPanel + SearchTab + PathTab），通过两个新 Hook（useGraphSearch、usePathFinder）管理状态；GraphExplorer 主组件扩展 6 个 state 字段，NodeDetail 面板改由 `activePanel` 统一控制可见性。

**Tech Stack:** Rust / Tauri 2.x、React 18 + TypeScript、ReactFlow (@xyflow/react)、Tailwind CSS、lucide-react

**Spec:** `docs/superpowers/specs/2026-03-21-graph-search-design.md`

---

## File Map

| 状态 | 文件 | 职责 |
|------|------|------|
| 新增 | `src-tauri/src/commands.rs` (+) | `find_subgraph` 命令（追加到末尾） |
| 修改 | `src-tauri/src/lib.rs` | 注册 `find_subgraph` |
| 新增 | `src/components/GraphExplorer/useGraphSearch.ts` | FTS5 搜索 Hook，debounce + invoke |
| 新增 | `src/components/GraphExplorer/usePathFinder.ts` | 路径查询 Hook，SubGraph 类型 + 路径选择 |
| 新增 | `src/components/GraphExplorer/SearchTab.tsx` | 搜索 Tab UI，结果列表 + [S]/[T] 按钮 |
| 新增 | `src/components/GraphExplorer/PathTab.tsx` | 路径 Tab UI，端点槽位 + 路径列表 + 子图按钮 |
| 新增 | `src/components/GraphExplorer/GraphSearchPanel.tsx` | 侧边栏容器，Tab 切换 |
| 修改 | `src/components/GraphExplorer/GraphNodeComponents.tsx` | 节点高亮样式 + S/T 角色徽章 prop |
| 修改 | `src/components/GraphExplorer/index.tsx` | 状态扩展 + 面板切换 + subgraph 模式 |

---

## Chunk 1: 后端 find_subgraph 命令

### Task 1: 新增 find_subgraph Tauri 命令并注册

**Files:**
- Modify: `src-tauri/src/commands.rs`（末尾追加）
- Modify: `src-tauri/src/lib.rs`（generate_handler 列表）

- [ ] **Step 1: 在 commands.rs 末尾追加命令**

在文件末尾（最后一个 `#[tauri::command]` 函数之后）追加：

```rust
/// 查找两个表节点之间的多跳子图（BFS，复用现有 find_relevant_subgraph）
#[tauri::command]
pub async fn find_subgraph(
    _app: tauri::AppHandle,
    connection_id: i64,
    from_node_id: String,
    to_node_id: String,
    max_hops: u8,
) -> AppResult<crate::graph::query::SubGraph> {
    use crate::db;

    // 1. 按 ID 查出两个节点
    let (from_name, to_name) = {
        let conn = db::get().lock().unwrap();
        let from_name: Option<String> = conn.query_row(
            "SELECT name FROM graph_nodes WHERE id=?1 AND node_type='table' AND is_deleted=0",
            [&from_node_id],
            |r| r.get(0),
        ).optional().map_err(crate::AppError::Database)?;
        let to_name: Option<String> = conn.query_row(
            "SELECT name FROM graph_nodes WHERE id=?1 AND node_type='table' AND is_deleted=0",
            [&to_node_id],
            |r| r.get(0),
        ).optional().map_err(crate::AppError::Database)?;
        (from_name, to_name)
    };

    // 2. 校验节点必须是 table 类型
    let from_name = from_name.ok_or_else(|| {
        crate::AppError::Other("路径查询仅支持表节点（node_type='table'）".into())
    })?;
    let to_name = to_name.ok_or_else(|| {
        crate::AppError::Other("路径查询仅支持表节点（node_type='table'）".into())
    })?;

    // 3. 调用 BFS 子图查询（最多 max_hops 跳，最大上限 10）
    let hops = max_hops.min(10);  // u8，与 find_relevant_subgraph 参数类型一致
    let entities = vec![from_name, to_name];
    crate::graph::query::find_relevant_subgraph(connection_id, &entities, hops).await
}
```

- [ ] **Step 2: 注册命令到 lib.rs**

找到 `src-tauri/src/lib.rs` 中 `generate_handler!` 块里最后一个命令 `commands::update_graph_edge,`（第 269 行），在它之后插入：

```rust
            commands::find_subgraph,
```

- [ ] **Step 3: 编译检查**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

预期输出：无 error（warning 可接受）

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(graph): 新增 find_subgraph Tauri 命令，暴露 BFS 多跳子图查询"
```

---

## Chunk 2: 前端 Hooks

### Task 2: useGraphSearch Hook

**Files:**
- Create: `src/components/GraphExplorer/useGraphSearch.ts`

- [ ] **Step 1: 创建文件**

```typescript
// src/components/GraphExplorer/useGraphSearch.ts
import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GraphNode } from './useGraphData';

export interface UseGraphSearchResult {
  query: string;
  setQuery: (q: string) => void;
  results: GraphNode[];
  loading: boolean;
  error: string | null;
  clear: () => void;
}

export function useGraphSearch(connectionId: number | null): UseGraphSearchResult {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GraphNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim() || connectionId === null) {
      setResults([]);
      setLoading(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await invoke<GraphNode[]>('search_graph', {
          connectionId,
          keyword: query.trim(),
        });
        setResults(res);
        setError(null);
      } catch (e) {
        setError(typeof e === 'string' ? e : '搜索失败');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, connectionId]);

  const clear = () => {
    setQuery('');
    setResults([]);
    setError(null);
  };

  return { query, setQuery, results, loading, error, clear };
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增 error

- [ ] **Step 3: 提交**

```bash
git add src/components/GraphExplorer/useGraphSearch.ts
git commit -m "feat(graph): 新增 useGraphSearch Hook，FTS5 实体搜索 debounce 300ms"
```

---

### Task 3: usePathFinder Hook

**Files:**
- Create: `src/components/GraphExplorer/usePathFinder.ts`

- [ ] **Step 1: 创建文件**

```typescript
// src/components/GraphExplorer/usePathFinder.ts
import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GraphNode, GraphEdge } from './useGraphData';

export interface SubGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  join_paths: string[][];  // 每条路径为节点 ID 数组
}

export interface ResolvedPath {
  nodeIds: string[];
  labels: string[];  // displayName or name
  edgeIds: Set<string>;
}

export interface UsePathFinderResult {
  fromNode: GraphNode | null;
  toNode: GraphNode | null;
  maxHops: number;
  setFromNode: (n: GraphNode | null) => void;
  setToNode: (n: GraphNode | null) => void;
  setMaxHops: (h: number) => void;
  loading: boolean;
  error: string | null;
  subGraph: SubGraph | null;
  resolvedPaths: ResolvedPath[];
  selectedPathIndex: number | null;
  findPaths: () => Promise<void>;
  selectPath: (index: number) => void;
  clearSelection: () => void;
  reset: () => void;
}

export function usePathFinder(connectionId: number | null): UsePathFinderResult {
  const [fromNode, setFromNode] = useState<GraphNode | null>(null);
  const [toNode, setToNode] = useState<GraphNode | null>(null);
  const [maxHops, setMaxHops] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subGraph, setSubGraph] = useState<SubGraph | null>(null);
  const [resolvedPaths, setResolvedPaths] = useState<ResolvedPath[]>([]);
  const [selectedPathIndex, setSelectedPathIndex] = useState<number | null>(null);

  const findPaths = useCallback(async () => {
    if (!fromNode || !toNode || connectionId === null) return;
    setLoading(true);
    setError(null);
    setSubGraph(null);
    setResolvedPaths([]);
    setSelectedPathIndex(null);

    try {
      const sg = await invoke<SubGraph>('find_subgraph', {
        connectionId,
        fromNodeId: fromNode.id,
        toNodeId: toNode.id,
        maxHops: Math.max(1, Math.min(maxHops, 10)),
      });

      // 构建 id→displayName 映射
      const nameMap: Record<string, string> = {};
      sg.nodes.forEach(n => { nameMap[n.id] = n.display_name || n.name; });

      // 解析每条路径
      const paths: ResolvedPath[] = sg.join_paths.slice(0, 20).map(pathIds => {
        const nodeSet = new Set(pathIds);
        const edgeIds = new Set(
          sg.edges
            .filter(e => nodeSet.has(e.from_node) && nodeSet.has(e.to_node))
            .map(e => e.id)
        );
        return {
          nodeIds: pathIds,
          labels: pathIds.map(id => nameMap[id] ?? id),
          edgeIds,
        };
      });

      setSubGraph(sg);
      setResolvedPaths(paths);
    } catch (e) {
      setError(typeof e === 'string' ? e : '路径查询失败');
    } finally {
      setLoading(false);
    }
  }, [fromNode, toNode, maxHops, connectionId]);

  const selectPath = useCallback((index: number) => {
    setSelectedPathIndex(index);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPathIndex(null);
  }, []);

  const reset = useCallback(() => {
    setFromNode(null);
    setToNode(null);
    setSubGraph(null);
    setResolvedPaths([]);
    setSelectedPathIndex(null);
    setError(null);
  }, []);

  return {
    fromNode, toNode, maxHops,
    setFromNode, setToNode, setMaxHops,
    loading, error,
    subGraph, resolvedPaths, selectedPathIndex,
    findPaths, selectPath, clearSelection, reset,
  };
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增 error

- [ ] **Step 3: 提交**

```bash
git add src/components/GraphExplorer/usePathFinder.ts
git commit -m "feat(graph): 新增 usePathFinder Hook，多跳路径查询 + 路径解析"
```

---

## Chunk 3: 前端组件

### Task 4: SearchTab 组件

**Files:**
- Create: `src/components/GraphExplorer/SearchTab.tsx`

- [ ] **Step 1: 创建文件**

```tsx
// src/components/GraphExplorer/SearchTab.tsx
import React from 'react';
import { Search, Loader2, MapPin } from 'lucide-react';
import type { GraphNode } from './useGraphData';
import type { UseGraphSearchResult } from './useGraphSearch';

const NODE_TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  table:  { label: 'Table',  cls: 'bg-[#0d2a3d] text-[#3794ff]' },
  metric: { label: 'Metric', cls: 'bg-[#2d1e0d] text-[#f59e0b]' },
  alias:  { label: 'Alias',  cls: 'bg-[#1e0d2d] text-[#a855f7]' },
  link:   { label: 'Link',   cls: 'bg-[#0d1f1a] text-[#00c9a7]' },
};

interface SearchTabProps {
  search: UseGraphSearchResult;
  visibleNodeIds: Set<string>;
  onJumpToNode: (nodeId: string) => void;
  onSetFrom: (node: GraphNode) => void;
  onSetTo: (node: GraphNode) => void;
}

export function SearchTab({ search, visibleNodeIds, onJumpToNode, onSetFrom, onSetTo }: SearchTabProps) {
  const { query, setQuery, results, loading } = search;

  return (
    <div className="flex flex-col h-full">
      {/* 搜索输入框 */}
      <div className="p-3 border-b border-[#1e2d42]">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#4a6480] pointer-events-none" />
          {loading && (
            <Loader2 size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#4a6480] animate-spin" />
          )}
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索实体名称或别名..."
            className="w-full pl-7 pr-7 py-1.5 text-[12px] bg-[#111922] border border-[#1e2d42] rounded text-[#c8daea] placeholder-[#3d5470] focus:outline-none focus:border-[#00a98f] transition-colors"
          />
        </div>
      </div>

      {/* 结果列表 */}
      <div className="flex-1 overflow-y-auto">
        {!query.trim() && (
          <div className="p-4 text-center text-[#4a6480] text-[12px]">输入关键词开始搜索</div>
        )}

        {query.trim() && !loading && results.length === 0 && (
          <div className="p-4 text-center text-[#4a6480] text-[12px]">未找到匹配节点</div>
        )}

        {results.map(node => {
          const badge = NODE_TYPE_BADGE[node.node_type] ?? NODE_TYPE_BADGE.table;
          const isTable = node.node_type === 'table';
          const isVisible = visibleNodeIds.has(node.id);

          return (
            <div
              key={node.id}
              className="group px-3 py-2 border-b border-[#161e2e] hover:bg-[#1a2639] cursor-pointer transition-colors"
              onClick={() => onJumpToNode(node.id)}
            >
              <div className="flex items-center gap-2">
                {/* 类型徽章 */}
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0 ${badge.cls}`}>
                  {badge.label}
                </span>
                {/* 节点名 */}
                <span className="text-[12px] text-[#c8daea] truncate flex-1">{node.name}</span>
                {/* 操作按钮（hover 时显示） */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <button
                    onClick={e => { e.stopPropagation(); if (isTable) onSetFrom(node); }}
                    disabled={!isTable}
                    title={isTable ? '设为路径起点' : '仅支持表节点'}
                    className={`w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center transition-colors
                      ${isTable
                        ? 'bg-[#052917] text-[#4ade80] border border-[#4ade80]/40 hover:bg-[#4ade80]/20'
                        : 'bg-[#111922] text-[#2a3e56] border border-[#1e2d42] cursor-not-allowed'}`}
                  >S</button>
                  <button
                    onClick={e => { e.stopPropagation(); if (isTable) onSetTo(node); }}
                    disabled={!isTable}
                    title={isTable ? '设为路径终点' : '仅支持表节点'}
                    className={`w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center transition-colors
                      ${isTable
                        ? 'bg-[#051525] text-[#5eb2f7] border border-[#5eb2f7]/40 hover:bg-[#5eb2f7]/20'
                        : 'bg-[#111922] text-[#2a3e56] border border-[#1e2d42] cursor-not-allowed'}`}
                  >T</button>
                </div>
              </div>
              {/* display_name 副标题 */}
              {node.display_name && node.display_name !== node.name && (
                <p className="text-[11px] text-[#7a9bb8] mt-0.5 truncate pl-0.5">{node.display_name}</p>
              )}
              {/* 节点不可见提示 */}
              {!isVisible && (
                <p className="text-[10px] text-[#4a6480] mt-0.5 flex items-center gap-1">
                  <MapPin size={9} /> 当前已过滤，节点不可见
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增 error

- [ ] **Step 3: 提交**

```bash
git add src/components/GraphExplorer/SearchTab.tsx
git commit -m "feat(graph): 新增 SearchTab 组件，FTS5 结果列表 + S/T 端点设置按钮"
```

---

### Task 5: PathTab 组件

**Files:**
- Create: `src/components/GraphExplorer/PathTab.tsx`

- [ ] **Step 1: 创建文件**

```tsx
// src/components/GraphExplorer/PathTab.tsx
import React from 'react';
import { X, Search, Loader2, ChevronRight, Network, AlertCircle } from 'lucide-react';
import type { UsePathFinderResult } from './usePathFinder';

interface PathTabProps {
  pathFinder: UsePathFinderResult;
  onHighlightPath: (nodeIds: string[], edgeIds: Set<string>) => void;
  onEnterSubgraph: (nodeIds: string[]) => void;
  onClearHighlight: () => void;
}

export function PathTab({ pathFinder, onHighlightPath, onEnterSubgraph, onClearHighlight }: PathTabProps) {
  const {
    fromNode, toNode, maxHops,
    setFromNode, setToNode, setMaxHops,
    loading, error,
    resolvedPaths, selectedPathIndex,
    findPaths, selectPath,
  } = pathFinder;

  const canSearch = fromNode !== null && toNode !== null && fromNode.id !== toNode.id && !loading;
  const sameNode = fromNode !== null && toNode !== null && fromNode.id === toNode.id;

  const handleSelectPath = (idx: number) => {
    selectPath(idx);
    const path = resolvedPaths[idx];
    if (path) onHighlightPath(path.nodeIds, path.edgeIds);
  };

  const handleHopsChange = (v: string) => {
    const n = parseInt(v, 10);
    setMaxHops(isNaN(n) || n < 1 ? 1 : Math.min(n, 10));
  };

  return (
    <div className="flex flex-col h-full">
      {/* 起点/终点槽位 */}
      <div className="p-3 space-y-2 border-b border-[#1e2d42]">
        {/* 起点 */}
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-[#4ade80]/20 border border-[#4ade80]/50 flex items-center justify-center text-[10px] font-bold text-[#4ade80] flex-shrink-0">S</span>
          {fromNode ? (
            <div className="flex-1 flex items-center justify-between bg-[#111922] border border-[#1e2d42] rounded px-2 py-1 min-w-0">
              <span className="text-[12px] text-[#c8daea] truncate">{fromNode.name}</span>
              <button onClick={() => { setFromNode(null); onClearHighlight(); }} className="ml-1 text-[#4a6480] hover:text-[#f43f5e] flex-shrink-0">
                <X size={11} />
              </button>
            </div>
          ) : (
            <div className="flex-1 bg-[#111922] border border-dashed border-[#1e2d42] rounded px-2 py-1 text-[11px] text-[#3d5470]">
              从搜索结果点击 S 设置起点
            </div>
          )}
        </div>

        {/* 终点 */}
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-[#5eb2f7]/20 border border-[#5eb2f7]/50 flex items-center justify-center text-[10px] font-bold text-[#5eb2f7] flex-shrink-0">T</span>
          {toNode ? (
            <div className="flex-1 flex items-center justify-between bg-[#111922] border border-[#1e2d42] rounded px-2 py-1 min-w-0">
              <span className="text-[12px] text-[#c8daea] truncate">{toNode.name}</span>
              <button onClick={() => { setToNode(null); onClearHighlight(); }} className="ml-1 text-[#4a6480] hover:text-[#f43f5e] flex-shrink-0">
                <X size={11} />
              </button>
            </div>
          ) : (
            <div className="flex-1 bg-[#111922] border border-dashed border-[#1e2d42] rounded px-2 py-1 text-[11px] text-[#3d5470]">
              从搜索结果点击 T 设置终点
            </div>
          )}
        </div>

        {/* 跳数 + 查找按钮 */}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[11px] text-[#7a9bb8] flex-shrink-0">最大跳数</span>
          <input
            type="number"
            min={1}
            max={10}
            value={maxHops}
            onChange={e => handleHopsChange(e.target.value)}
            className="w-16 px-2 py-1 text-[12px] bg-[#111922] border border-[#1e2d42] rounded text-[#c8daea] focus:outline-none focus:border-[#00a98f] text-center"
          />
          <button
            onClick={findPaths}
            disabled={!canSearch}
            className="flex-1 flex items-center justify-center gap-1.5 py-1 text-[12px] rounded border transition-colors
              bg-[#003d2f] border-[#00a98f] text-[#00c9a7] hover:bg-[#00a98f]/20
              disabled:bg-[#111922] disabled:border-[#1e2d42] disabled:text-[#2a3e56] disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
            查找路径
          </button>
        </div>

        {sameNode && (
          <p className="text-[11px] text-[#f59e0b] flex items-center gap-1">
            <AlertCircle size={11} /> 起点和终点不能相同
          </p>
        )}
        {error && (
          <p className="text-[11px] text-[#f43f5e] flex items-center gap-1">
            <AlertCircle size={11} /> {error}
          </p>
        )}
      </div>

      {/* 路径列表 */}
      <div className="flex-1 overflow-y-auto">
        {resolvedPaths.length === 0 && !loading && !error && fromNode && toNode && (
          <div className="p-4 text-center text-[#4a6480] text-[12px]">
            点击"查找路径"开始搜索
          </div>
        )}

        {resolvedPaths.length > 0 && (
          <>
            <div className="px-3 py-2 text-[11px] text-[#4a6480] border-b border-[#161e2e] flex items-center justify-between">
              <span>找到 {resolvedPaths.length} 条路径{resolvedPaths.length >= 20 ? '（仅显示前 20 条）' : ''}</span>
              {selectedPathIndex !== null && (
                <button
                  onClick={() => { onEnterSubgraph(resolvedPaths[selectedPathIndex].nodeIds); }}
                  className="flex items-center gap-1 text-[#00c9a7] hover:text-[#29edd0] transition-colors"
                >
                  <Network size={11} /> 提取子图
                </button>
              )}
            </div>

            {resolvedPaths.map((path, idx) => (
              <div
                key={idx}
                onClick={() => handleSelectPath(idx)}
                className={`px-3 py-2.5 border-b border-[#161e2e] cursor-pointer transition-colors
                  ${selectedPathIndex === idx
                    ? 'bg-[#003d2f] border-l-2 border-l-[#00c9a7]'
                    : 'hover:bg-[#1a2639]'}`}
              >
                <div className="flex items-center gap-1 flex-wrap">
                  {path.labels.map((label, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <ChevronRight size={10} className="text-[#4a6480] flex-shrink-0" />}
                      <span className={`text-[11px] px-1.5 py-0.5 rounded
                        ${i === 0 ? 'bg-[#4ade80]/10 text-[#4ade80]'
                          : i === path.labels.length - 1 ? 'bg-[#5eb2f7]/10 text-[#5eb2f7]'
                          : 'bg-[#1e2d42] text-[#c8daea]'}`}>
                        {label}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
                <p className="text-[10px] text-[#4a6480] mt-1">{path.labels.length - 1} 跳</p>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增 error

- [ ] **Step 3: 提交**

```bash
git add src/components/GraphExplorer/PathTab.tsx
git commit -m "feat(graph): 新增 PathTab 组件，端点选择 + 路径列表 + 子图提取"
```

---

### Task 6: GraphSearchPanel 容器

**Files:**
- Create: `src/components/GraphExplorer/GraphSearchPanel.tsx`

- [ ] **Step 1: 创建文件**

```tsx
// src/components/GraphExplorer/GraphSearchPanel.tsx
import React from 'react';
import { X } from 'lucide-react';
import { SearchTab } from './SearchTab';
import { PathTab } from './PathTab';
import type { GraphNode } from './useGraphData';
import type { UseGraphSearchResult } from './useGraphSearch';
import type { UsePathFinderResult, ResolvedPath } from './usePathFinder';

type ActiveTab = 'search' | 'path';

interface GraphSearchPanelProps {
  search: UseGraphSearchResult;
  pathFinder: UsePathFinderResult;
  visibleNodeIds: Set<string>;
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  onClose: () => void;
  onJumpToNode: (nodeId: string) => void;
  onHighlightPath: (nodeIds: string[], edgeIds: Set<string>) => void;
  onEnterSubgraph: (nodeIds: string[]) => void;
  onClearHighlight: () => void;
}

export function GraphSearchPanel({
  search,
  pathFinder,
  visibleNodeIds,
  activeTab,
  onTabChange,
  onClose,
  onJumpToNode,
  onHighlightPath,
  onEnterSubgraph,
  onClearHighlight,
}: GraphSearchPanelProps) {

  const handleSetFrom = (node: GraphNode) => {
    pathFinder.setFromNode(node);
    onTabChange('path');
  };

  const handleSetTo = (node: GraphNode) => {
    pathFinder.setToNode(node);
    onTabChange('path');
  };

  return (
    <div className="w-[280px] flex-shrink-0 flex flex-col bg-[#0d1117] border-l border-[#1e2d42] overflow-hidden">
      {/* Tab 头 */}
      <div className="flex items-center border-b border-[#1e2d42] flex-shrink-0">
        {(['search', 'path'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={`flex-1 py-2 text-[12px] font-medium transition-colors border-b-2
              ${activeTab === tab
                ? 'border-[#00c9a7] text-[#e8f4ff]'
                : 'border-transparent text-[#7a9bb8] hover:text-[#c8daea]'}`}
          >
            {tab === 'search' ? '搜索' : '路径'}
          </button>
        ))}
        <button
          onClick={onClose}
          className="px-2 py-2 text-[#4a6480] hover:text-[#c8daea] transition-colors flex-shrink-0"
          title="关闭"
        >
          <X size={14} />
        </button>
      </div>

      {/* Tab 内容 */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'search' ? (
          <SearchTab
            search={search}
            visibleNodeIds={visibleNodeIds}
            onJumpToNode={onJumpToNode}
            onSetFrom={handleSetFrom}
            onSetTo={handleSetTo}
          />
        ) : (
          <PathTab
            pathFinder={pathFinder}
            onHighlightPath={onHighlightPath}
            onEnterSubgraph={onEnterSubgraph}
            onClearHighlight={onClearHighlight}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增 error

- [ ] **Step 3: 提交**

```bash
git add src/components/GraphExplorer/GraphSearchPanel.tsx
git commit -m "feat(graph): 新增 GraphSearchPanel 侧边栏容器，搜索/路径 Tab 切换"
```

---

## Chunk 4: GraphExplorer 集成

### Task 7: GraphNodeComponents 高亮与角色徽章

**Files:**
- Modify: `src/components/GraphExplorer/GraphNodeComponents.tsx`

- [ ] **Step 1: 在 GraphNodeData 接口中增加高亮相关 props**

在 `src/components/GraphExplorer/GraphNodeComponents.tsx` 的 `GraphNodeData` 接口中追加：

```typescript
// 在 GraphNodeData 接口末尾（tableColumns 之后）追加：
  isHighlighted?: boolean;   // 路径高亮节点 → accent-glow
  isDimmed?: boolean;        // 非路径节点 → opacity-30
  pathRole?: 'from' | 'to'; // 起点/终点角色徽章
```

- [ ] **Step 2: 在 BaseNode 组件中应用高亮样式和角色徽章**

`MetricNodeComponent`、`AliasNodeComponent` 使用 `BaseNode`，只需修改 `BaseNode` 一处。

找到 `BaseNode` 的根 `<div>` 元素（`className={`w-60 rounded-md border bg-[#111922] ...`}`），修改为：

```tsx
<div className={`w-60 rounded-md border bg-[#111922] shadow-lg ${borderClass} group relative
  ${data.isHighlighted ? 'accent-glow' : ''}
  ${data.isDimmed ? 'opacity-30' : ''}
`}>
```

在 `<Handle type="target" .../>` 之后、Header 之前插入角色徽章：

```tsx
{/* 路径角色徽章 */}
{data.pathRole && (
  <div className={`absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold z-10
    ${data.pathRole === 'from'
      ? 'bg-[#4ade80] text-[#052917]'
      : 'bg-[#5eb2f7] text-[#051525]'}`}>
    {data.pathRole === 'from' ? 'S' : 'T'}
  </div>
)}
```

- [ ] **Step 2b: 在 TableNodeComponent 中应用相同逻辑**

`TableNodeComponent` 独立实现，根 div 在第 151 行：`<div className="w-60 rounded-md border border-[#3794ff] bg-[#111922] shadow-lg group">`

修改为：

```tsx
<div className={`w-60 rounded-md border border-[#3794ff] bg-[#111922] shadow-lg group relative
  ${nodeData.isHighlighted ? 'accent-glow' : ''}
  ${nodeData.isDimmed ? 'opacity-30' : ''}
`}>
```

在 `<Handle type="target" .../>` 之后、Header `<div>` 之前插入与 BaseNode 相同的徽章 JSX（`nodeData.pathRole` 替代 `data.pathRole`）。

- [ ] **Step 2c: 在 LinkNodeComponent 中应用相同逻辑**

`LinkNodeComponent` 根 div 在第 283 行：`<div className={`w-64 rounded-md border bg-[#111922] shadow-lg ${borderClass}`}>`

修改为：

```tsx
<div className={`w-64 rounded-md border bg-[#111922] shadow-lg ${borderClass} relative
  ${nodeData.isHighlighted ? 'accent-glow' : ''}
  ${nodeData.isDimmed ? 'opacity-30' : ''}
`}>
```

在 `<Handle type="target" .../>` 之后插入徽章 JSX（`nodeData.pathRole` 替代 `data.pathRole`）。

- [ ] **Step 3: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

预期：无新增 error

- [ ] **Step 4: 提交**

```bash
git add src/components/GraphExplorer/GraphNodeComponents.tsx
git commit -m "feat(graph): 节点组件支持 isHighlighted/isDimmed/pathRole 高亮与角色徽章"
```

---

### Task 8: GraphExplorer 主组件集成

**Files:**
- Modify: `src/components/GraphExplorer/index.tsx`

这是改动最多的一步，按小步骤逐一完成。

- [ ] **Step 1: 追加 import**

在现有 import 区域末尾追加：

```typescript
import { GraphSearchPanel } from './GraphSearchPanel';
import { useGraphSearch } from './useGraphSearch';
import { usePathFinder } from './usePathFinder';
import { RotateCcw, PanelRight } from 'lucide-react';
```

同时在已有的 lucide-react import 行中，确认 `Search` 已存在（已有），如无则追加。

- [ ] **Step 2: 在 GraphExplorerInner 内部追加 6 个新 state**

在 `const [editMode, setEditMode] = useState(false);` 之后追加：

```typescript
// ── Search panel state ──────────────────────────────────────────────────────
const [activePanel, setActivePanel] = useState<'detail' | 'search' | null>(null);
const [searchPanelTab, setSearchPanelTab] = useState<'search' | 'path'>('search');
const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
const [highlightedEdgeIds, setHighlightedEdgeIds] = useState<Set<string>>(new Set());
const [subgraphMode, setSubgraphMode] = useState(false);
const [subgraphNodeIds, setSubgraphNodeIds] = useState<Set<string>>(new Set());

const search = useGraphSearch(internalConnId);
const pathFinder = usePathFinder(internalConnId);
```

- [ ] **Step 3: 修改 onNodeClick 和 onPaneClick**

将现有 `onNodeClick`：
```typescript
const onNodeClick: NodeMouseHandler = useCallback(
  (_evt, node) => {
    const raw = rawNodes.find((n) => n.id === node.id);
    if (raw) setSelectedNode(raw);
  },
  [rawNodes],
);
```
替换为：
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

将现有 `onPaneClick`：
```typescript
const onPaneClick = useCallback((event: React.MouseEvent) => {
  if (event.detail >= 2) {
    setSelectedNode(null);
  }
}, []);
```
替换为：
```typescript
const onPaneClick = useCallback((event: React.MouseEvent) => {
  if (event.detail >= 2) {
    setSelectedNode(null);
    setActivePanel(null);
  }
}, []);
```

- [ ] **Step 4: 修改 clustered useMemo，支持子图模式**

找到：
```typescript
const clustered = useMemo(() => clusterByConnection(filteredRaw), [filteredRaw]);
```
替换为：
```typescript
const clustered = useMemo(() => {
  const sourceNodes = subgraphMode
    ? filteredRaw.filter(n => subgraphNodeIds.has(n.id))
    : filteredRaw;
  return clusterByConnection(sourceNodes);
}, [filteredRaw, subgraphMode, subgraphNodeIds]);
```

- [ ] **Step 5: 修改 toFlowNodes，传入高亮/角色信息**

找到 `toFlowNodes` 调用处（在 useEffect 中）：
```typescript
const flowNodes = toFlowNodes(clustered, handleAddAlias, handleHighlightLinks, linkCountMap, columnMap);
```
替换为：
```typescript
const flowNodes = toFlowNodes(
  clustered, handleAddAlias, handleHighlightLinks, linkCountMap, columnMap,
  highlightedNodeIds, highlightedEdgeIds,
  pathFinder.fromNode?.id, pathFinder.toNode?.id,
);
```

同时修改 `toFlowNodes` 函数签名和实现，在 `data` 对象中追加：
```typescript
function toFlowNodes(
  rawNodes: GraphNode[],
  onAddAlias: (nodeId: string) => void,
  onHighlightLinks: (nodeId: string) => void,
  linkCountMap: Record<string, number>,
  columnMap: Record<string, import('./GraphNodeComponents').ColumnInfo[]>,
  highlightedNodeIds: Set<string> = new Set(),
  highlightedEdgeIds: Set<string> = new Set(),
  fromNodeId?: string,
  toNodeId?: string,
): Node[] {
  const hasHighlight = highlightedNodeIds.size > 0;
  return rawNodes.map((n) => ({
    id: n.id,
    type: NODE_TYPE_MAP[n.node_type] ?? 'table',
    position: { x: 0, y: 0 },
    data: {
      ...n,
      onAddAlias,
      onHighlightLinks,
      linkCount: linkCountMap[n.id] ?? 0,
      tableColumns: n.node_type === 'table' ? (columnMap[n.id] ?? []) : undefined,
      isHighlighted: hasHighlight ? highlightedNodeIds.has(n.id) : false,
      isDimmed: hasHighlight ? !highlightedNodeIds.has(n.id) : false,
      pathRole: n.id === fromNodeId ? 'from' : n.id === toNodeId ? 'to' : undefined,
    },
  }));
}
```

- [ ] **Step 6: 修改 filteredEdges，支持路径边高亮样式**

找到 `toFlowEdges` 调用：
```typescript
const flowEdges = toFlowEdges(filteredEdges);
```
替换为：
```typescript
const flowEdges = toFlowEdges(filteredEdges, highlightedEdgeIds);
```

修改 `toFlowEdges` 函数签名：
```typescript
function toFlowEdges(
  rawEdges: { id: string; from_node: string; to_node: string; edge_type: string; weight: number; source?: string }[],
  highlightedEdgeIds: Set<string> = new Set(),
): Edge[] {
  return rawEdges.map((e) => ({
    id: e.id,
    source: e.from_node,
    target: e.to_node,
    type: 'relation',
    animated: false,
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: '#4a6380' },
    style: highlightedEdgeIds.has(e.id)
      ? { stroke: '#00c9a7', strokeWidth: 2.5, opacity: 1 }
      : getEdgeStyleBySource(e.source ?? 'schema'),
    data: { edge_type: e.edge_type, weight: e.weight },
  }));
}
```

- [ ] **Step 7: 新增 handleJumpToNode、handleHighlightPath、handleEnterSubgraph**

在 `handleAliasUpdated` 之后追加：

```typescript
// ── Search panel handlers ────────────────────────────────────────────────────
const handleJumpToNode = useCallback((nodeId: string) => {
  // 若在子图模式且节点不在子图内，先退出子图模式
  if (subgraphMode && !subgraphNodeIds.has(nodeId)) {
    setSubgraphMode(false);
    setSubgraphNodeIds(new Set());
    // TODO: toast "目标节点在子图外，已恢复全图"
  }
  // 临时高亮 2 秒
  setHighlightedNodeIds(new Set([nodeId]));
  setHighlightedEdgeIds(new Set());
  const timer = setTimeout(() => {
    setHighlightedNodeIds(new Set());
    setHighlightedEdgeIds(new Set());
  }, 2000);
  // fitView to node（nodes 参数只需 {id} 即可）
  fitView({ nodes: [{ id: nodeId }], duration: 500, padding: 0.3, maxZoom: 1.5 });
  return () => clearTimeout(timer);
}, [subgraphMode, subgraphNodeIds, fitView]);

const handleHighlightPath = useCallback((nodeIds: string[], edgeIds: Set<string>) => {
  setHighlightedNodeIds(new Set(nodeIds));
  setHighlightedEdgeIds(edgeIds);
  // fitView to path nodes
  const pathRfNodes = rfNodes.filter(n => nodeIds.includes(n.id));
  if (pathRfNodes.length > 0) {
    fitView({ nodes: pathRfNodes, duration: 500, padding: 0.2, maxZoom: 1.2 });
  }
}, [rfNodes, fitView]);

const handleEnterSubgraph = useCallback((nodeIds: string[]) => {
  setSubgraphNodeIds(new Set(nodeIds));
  setSubgraphMode(true);
}, []);

const handleExitSubgraph = useCallback(() => {
  setSubgraphMode(false);
  setSubgraphNodeIds(new Set());
  setHighlightedNodeIds(new Set());
  setHighlightedEdgeIds(new Set());
}, []);

const handleClearHighlight = useCallback(() => {
  setHighlightedNodeIds(new Set());
  setHighlightedEdgeIds(new Set());
}, []);
```

- [ ] **Step 8: 修改 NodeDetail 渲染条件，改由 activePanel 控制**

找到：
```typescript
{/* Node detail panel */}
{selectedNode && (
  <NodeDetail
    ...
    onClose={() => setSelectedNode(null)}
```
替换 `{selectedNode && (` 为：
```typescript
{activePanel === 'detail' && selectedNode && (
  <NodeDetail
    ...
    onClose={() => { setSelectedNode(null); setActivePanel(null); }}
```

- [ ] **Step 9: 在工具栏追加搜索面板按钮和恢复全图按钮**

在工具栏 `{/* Search */}` 区域之后（searchQuery input 之后），在 `<div className="ml-auto ...">` 之前插入：

```tsx
{/* 搜索面板按钮 */}
<button
  onClick={() => {
    if (activePanel === 'search') {
      setActivePanel(null);
    } else {
      setSelectedNode(null);
      setActivePanel('search');
    }
  }}
  title="搜索 / 路径查询"
  className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors
    ${activePanel === 'search'
      ? 'bg-[#003d2f] border-[#00a98f] text-[#00c9a7]'
      : 'text-[#7a9bb8] hover:text-[#c8daea] bg-[#111922] hover:bg-[#1e2d42] border border-[#1e2d42]'}`}
>
  <PanelRight size={13} />
</button>
```

在 `<div className="ml-auto ...">` 内，Build graph 按钮之前插入"恢复全图"按钮：

```tsx
{/* 恢复全图按钮（子图模式下显示） */}
{subgraphMode && (
  <button
    onClick={handleExitSubgraph}
    className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-[#00c9a7] bg-[#003d2f] border border-[#00a98f] rounded hover:bg-[#00a98f]/20 transition-colors"
  >
    <RotateCcw size={13} />
    恢复全图
  </button>
)}
```

- [ ] **Step 10: 在主画布区域挂载 GraphSearchPanel**

找到 `{/* Node detail panel */}` 块，在它之后追加：

```tsx
{/* Search panel */}
{activePanel === 'search' && (
  <GraphSearchPanel
    search={search}
    pathFinder={pathFinder}
    visibleNodeIds={visibleNodeIds}
    activeTab={searchPanelTab}
    onTabChange={setSearchPanelTab}
    onClose={() => setActivePanel(null)}
    onJumpToNode={handleJumpToNode}
    onHighlightPath={handleHighlightPath}
    onEnterSubgraph={handleEnterSubgraph}
    onClearHighlight={handleClearHighlight}
  />
)}
```

- [ ] **Step 11: 切换连接/数据库时退出子图模式**

找到现有的 Connection selector（`setInternalConnId` onChange），将单表达式改为块语句并追加清理：

```tsx
onChange={(v) => {
  setInternalConnId(v ? Number(v) : null);
  setInternalDb(null);
  setSubgraphMode(false);
  setSubgraphNodeIds(new Set());
  setHighlightedNodeIds(new Set());
  setHighlightedEdgeIds(new Set());
  setSelectedNode(null);
  search.clear();
  pathFinder.reset();
  setActivePanel(null);
}}
```

找到 Database selector（`setInternalDb` onChange，原为单表达式 `v => setInternalDb(v || null)`），展开为块语句并追加清理：

```tsx
onChange={(v) => {
  setInternalDb(v || null);
  setSubgraphMode(false);
  setSubgraphNodeIds(new Set());
  setHighlightedNodeIds(new Set());
  setHighlightedEdgeIds(new Set());
  setSelectedNode(null);
  search.clear();
  pathFinder.reset();
  setActivePanel(null);
}}
```

- [ ] **Step 12: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

预期：无 error

- [ ] **Step 13: 前端编译验证**

```bash
npm run build 2>&1 | tail -20
```

预期：Build succeeded

- [ ] **Step 14: 提交**

```bash
git add src/components/GraphExplorer/index.tsx
git commit -m "feat(graph): GraphExplorer 集成搜索面板 + 路径高亮 + 子图模式"
```

---

## Chunk 5: 收尾验证

### Task 9: 端到端验证与最终提交

- [ ] **Step 1: Rust 最终编译检查**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error" | head -10
```

预期：无 error 输出

- [ ] **Step 2: TypeScript 最终检查**

```bash
cd .. && npx tsc --noEmit 2>&1 | head -20
```

预期：无 error 输出

- [ ] **Step 3: 启动开发模式，手动验证核心功能**

```bash
npm run tauri:dev
```

验证清单（有数据库连接时）：
1. 工具栏有 `PanelRight` 图标按钮
2. 点击后打开搜索侧边栏，Tab 可切换"搜索 / 路径"
3. 搜索 Tab：输入关键词 → 300ms 后显示 FTS5 结果，点击条目 → 图谱聚焦到节点并短暂高亮 2 秒
4. 非 table 节点的 [S]/[T] 按钮禁用
5. 搜索结果点击 [S] → 路径 Tab 自动切换并显示起点
6. 路径 Tab：设置起点+终点+跳数 → 点击查找 → 显示路径列表
7. 点击路径条目 → 路径节点高亮（accent-glow），非路径节点 opacity-30，路径边青色
8. 点击"提取子图"→ 主图只显示路径节点，工具栏出现"恢复全图"按钮
9. 点击"恢复全图"→ 恢复完整图谱
10. 切换连接 → 子图模式自动退出，搜索面板状态清空
11. 点击图中节点 → 搜索面板关闭，NodeDetail 打开

- [ ] **Step 4: 最终提交（如有未提交的小修复）**

```bash
git add -p  # 选择性暂存
git commit -m "fix(graph): 搜索面板端到端验证修复"
```
