# 知识图谱

> **模块类型**：AI 能力 / 可视化工具
> **首次发布**：V2
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

知识图谱（GraphRAG）自动将数据库 Schema 构建为实体关系图，采用 Palantir Link Node 设计理念，将外键提升为独立节点展示关联详情。支持 JOIN 路径自动推断、多跳关系探索，为 AI 提供结构化上下文。

### 快速入门

**1. 浏览图谱**
- 切换到图谱模式（ActivityBar 🧠 图标）
- 自动加载当前数据库的 Schema 图谱
- 缩放、拖拽浏览节点关系

**2. 搜索节点**
- 使用顶部搜索框输入关键词
- 匹配表名、别名、描述
- 点击结果定位到节点

**3. 查看 JOIN 路径**
- 选中两个表节点
- 点击「查找路径」
- 查看自动推断的多跳 JOIN 路径

**4. 过滤节点类型**
- 使用过滤器切换：
  - table - 表节点
  - metric - 指标节点
  - alias - 别名节点
  - link - 关联节点

### 操作说明

**图谱浏览**
- 画布操作：拖拽移动、滚轮缩放
- 节点交互：点击查看详情、双击展开关联
- 边交互：悬停查看关系属性

**搜索功能**
- 关键词匹配：表名、别名、描述模糊匹配
- 实时搜索：输入时即时过滤
- 结果导航：点击跳转到节点位置

**JOIN 路径推断**
- 选择起点表：点击选中
- 选择终点表：按住 Ctrl 点击另一表
- 路径展示：高亮显示 JOIN 路径
- 路径详情：显示每跳关联字段

**节点详情面板**
- 表节点：字段列表、索引信息、描述
- Link 节点：关联类型、基数、级联规则
- 别名节点：别名映射、业务含义

**过滤器**
- table：实体表节点
- metric：业务指标节点
- alias：语义别名节点
- link：表间关联节点（外键关系）

### 常见问题

**Q: 图谱加载慢？**
A: 大型数据库 Schema 首次构建可能需要几秒，结果会缓存到内存。

**Q: JOIN 路径找不到？**
A: 确保数据库已定义外键约束，或手动添加关联关系。

**Q: 节点位置错乱？**
A: 使用「重新布局」功能自动优化节点位置。

---

## 开发者指南

### 架构设计

知识图谱采用 Palantir Link Node 设计：
- **图数据层**：graph_nodes / graph_edges 表
- **内存缓存**：GraphCacheStore 缓存节点边
- **路径引擎**：BFS 多跳路径推断
- **MCP 集成**：图谱工具供 AI 调用

### 数据流

```
数据库 Schema → build_schema_graph → graph_nodes/edges 表
                                    ↓
                              GraphCacheStore 内存缓存
                                    ↓
                              图谱可视化 / JOIN 路径推断
```

### 数据表结构

**graph_nodes**
- `id` - 节点 ID
- `connection_id` - 所属连接
- `node_type` - 节点类型（table/column/metric/alias/link）
- `name` - 节点名称
- `properties` - 节点属性 JSON

**graph_edges**
- `id` - 边 ID
- `connection_id` - 所属连接
- `source_id` - 源节点
- `target_id` - 目标节点
- `edge_type` - 边类型（belongs_to/references/alias_of/link_via）
- `properties` - 边属性 JSON

### API 接口

**图谱构建**
- `build_schema_graph(connection_id: i64) -> Result<BuildResult, Error>`
  - 从 information_schema 构建图谱
  - 返回节点数、边数统计

**图谱查询**
- `graph_get_node_list(connection_id: i64, filter: NodeFilter) -> Result<Vec<Node>, Error>`
- `graph_get_node_detail(connection_id: i64, node_id: String) -> Result<NodeDetail, Error>`
- `graph_search_nodes(connection_id: i64, keyword: String) -> Result<Vec<Node>, Error>`

**路径推断**
- `find_join_paths_structured(connection_id: i64, table_a: String, table_b: String) -> Result<Vec<JoinPath>, Error>`
  - BFS 多跳路径搜索
  - 返回完整 JOIN 链条

### MCP 工具

- `graph_get_node_list(connection_id: i64, node_type: Option<String>)` - 获取节点列表
- `graph_get_node_detail(connection_id: i64, node_id: String)` - 获取节点详情
- `graph_search_nodes(connection_id: i64, keyword: String)` - 搜索节点
- `find_join_paths(connection_id: i64, table_a: String, table_b: String)` - 查找 JOIN 路径

### 扩展方式

**自定义节点类型**
1. 扩展 `GraphNodeType` enum
2. 在图谱构建逻辑中添加新类型处理
3. 前端添加节点渲染组件

**路径算法优化**
修改 `src-tauri/src/graph/path.rs`：
- 实现更高效的图遍历算法
- 添加路径评分机制
- 支持带权最短路径

### 相关文档

- 设计文档：[docs/superpowers/specs/2026-03-20-knowledge-graph-palantir-redesign.md](./2026-03-20-knowledge-graph-palantir-redesign.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/GraphExplorer/` | 图谱浏览器组件 |
| `src-tauri/src/graph/` | Rust 图谱模块 |
| `src-tauri/src/graph/build.rs` | Schema 图谱构建 |
| `src-tauri/src/graph/path.rs` | JOIN 路径推断 |
| `src-tauri/src/graph/cache.rs` | GraphCacheStore |
| `schema/init.sql` | graph_nodes/edges 表结构 |
