//! graph/cache.rs — 内存图缓存，用于快速 BFS JOIN 路径搜索
//! 懒加载：首次 graph_* 工具调用时从 SQLite 全量加载，build_schema_graph 完成后失效。

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use lru::LruCache;
use std::num::NonZeroUsize;
use serde::{Deserialize, Serialize};
use crate::AppResult;

/// Link Node 的关系元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkMetadata {
    pub cardinality: String,
    pub via: String,
    pub on_delete: String,
    pub description: String,
    pub source_table: String,
    pub target_table: String,
}

/// 邻接表中的一条逻辑边（两跳 table→link→table 压缩为一条）
#[derive(Debug, Clone)]
pub struct LogicalEdge {
    pub link_node_id: String,
    pub target_table: String,
    pub metadata: LinkMetadata,
}

/// 结构化 JOIN 路径（供 LLM 使用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinPath {
    pub path: String,
    pub via: String,
    pub cardinality: String,
    pub on_delete: String,
    pub description: String,
    pub sql_hint: String,
}

/// 单个 connection 的内存图
pub struct ConnectionGraph {
    /// table_name → 可达逻辑边列表（邻接表，双向）
    pub adj: HashMap<String, Vec<LogicalEdge>>,
    /// BFS 路径缓存（LRU，上限 500 条）
    pub path_cache: LruCache<(String, String), Vec<JoinPath>>,
}

impl ConnectionGraph {
    fn new(adj: HashMap<String, Vec<LogicalEdge>>) -> Self {
        Self {
            adj,
            path_cache: LruCache::new(NonZeroUsize::new(500).unwrap()),
        }
    }
}

/// 挂在 AppState 上的全局图缓存
/// key: connection_id → Arc<Mutex<ConnectionGraph>>
pub struct GraphCacheStore {
    inner: Arc<RwLock<HashMap<i64, Arc<tokio::sync::Mutex<ConnectionGraph>>>>>,
}

impl GraphCacheStore {
    pub fn new() -> Self {
        Self { inner: Arc::new(RwLock::new(HashMap::new())) }
    }

    /// 失效指定连接的缓存
    pub async fn invalidate(&self, connection_id: i64) {
        let mut map = self.inner.write().await;
        map.remove(&connection_id);
    }

    /// 获取或加载指定连接的图缓存
    pub async fn get_or_load(
        &self,
        connection_id: i64,
    ) -> AppResult<Arc<tokio::sync::Mutex<ConnectionGraph>>> {
        // 先用读锁检查
        {
            let map = self.inner.read().await;
            if let Some(graph) = map.get(&connection_id) {
                return Ok(Arc::clone(graph));
            }
        }
        // 未命中：进入写锁，再次检查（防止并发重复加载）
        let mut map = self.inner.write().await;
        if let Some(graph) = map.get(&connection_id) {
            return Ok(Arc::clone(graph)); // 另一个并发调用已经加载完成
        }
        // 确认未加载，在写锁内加载（注意：此处持有写锁，load 必须不阻塞 Tokio）
        let graph = tokio::task::spawn_blocking(move || load_connection_graph(connection_id))
            .await
            .map_err(|e| crate::AppError::Other(format!("spawn_blocking failed: {}", e)))??;
        let arc = Arc::new(tokio::sync::Mutex::new(graph));
        map.insert(connection_id, Arc::clone(&arc));
        Ok(arc)
    }
}

/// 从 SQLite 全量加载 connection 的图（仅 Link Node + 两跳边）
fn load_connection_graph(connection_id: i64) -> AppResult<ConnectionGraph> {
    let conn = crate::db::get().lock().map_err(|e| crate::AppError::Other(format!("DB mutex poisoned: {}", e)))?;

    // 查询所有 link 节点及其 metadata
    let mut stmt = conn.prepare(
        "SELECT gn.id, gn.metadata
         FROM graph_nodes gn
         WHERE gn.connection_id = ?1
           AND gn.node_type = 'link'
           AND gn.is_deleted = 0",
    )?;

    struct LinkNode {
        id: String,
        metadata_str: Option<String>,
    }

    let link_nodes: Vec<LinkNode> = stmt
        .query_map([connection_id], |row| {
            Ok(LinkNode {
                id: row.get(0)?,
                metadata_str: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut adj: HashMap<String, Vec<LogicalEdge>> = HashMap::new();

    for link in &link_nodes {
        // 解析 metadata
        let meta: serde_json::Value = match &link.metadata_str {
            Some(s) => serde_json::from_str(s).unwrap_or(serde_json::Value::Null),
            None => serde_json::Value::Null,
        };

        let source_table = meta.get("source_table").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let target_table = meta.get("target_table").and_then(|v| v.as_str()).unwrap_or("").to_string();

        if source_table.is_empty() || target_table.is_empty() {
            continue;
        }

        let link_meta = LinkMetadata {
            cardinality: meta.get("cardinality").and_then(|v| v.as_str()).unwrap_or("N:1").to_string(),
            via: meta.get("via").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            on_delete: meta.get("on_delete").and_then(|v| v.as_str()).unwrap_or("NO ACTION").to_string(),
            description: meta.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            source_table: source_table.clone(),
            target_table: target_table.clone(),
        };

        // source → target 方向
        let edge_fwd = LogicalEdge {
            link_node_id: link.id.clone(),
            target_table: target_table.clone(),
            metadata: link_meta.clone(),
        };
        adj.entry(source_table.clone()).or_default().push(edge_fwd);

        // target → source 反向（双向图）
        let mut rev_meta = link_meta.clone();
        std::mem::swap(&mut rev_meta.source_table, &mut rev_meta.target_table);
        let edge_rev = LogicalEdge {
            link_node_id: link.id.clone(),
            target_table: source_table.clone(),
            metadata: rev_meta,
        };
        adj.entry(target_table.clone()).or_default().push(edge_rev);
    }

    Ok(ConnectionGraph::new(adj))
}

/// BFS 路径搜索（在内存图中）
/// 返回所有最短等长路径
pub fn bfs_find_paths(
    graph: &mut ConnectionGraph,
    from: &str,
    to: &str,
    max_depth: usize,
) -> Vec<JoinPath> {
    // 先检查路径缓存
    let cache_key = (from.to_string(), to.to_string());
    if let Some(cached) = graph.path_cache.get(&cache_key) {
        return cached.clone();
    }

    if from == to {
        return vec![];
    }

    // BFS
    use std::collections::{HashSet, VecDeque};

    // 队列：(当前节点, 到达此节点的路径（LogicalEdge 列表）, 已访问节点集)
    struct State {
        current: String,
        edges: Vec<LogicalEdge>,
        visited: HashSet<String>,
    }

    let mut queue: VecDeque<State> = VecDeque::new();
    let mut visited_start = HashSet::new();
    visited_start.insert(from.to_string());
    queue.push_back(State {
        current: from.to_string(),
        edges: vec![],
        visited: visited_start,
    });

    let mut results: Vec<JoinPath> = vec![];
    let mut shortest_depth: Option<usize> = None;

    'bfs: while let Some(state) = queue.pop_front() {
        let depth = state.edges.len();

        // 如果已经找到最短路径且当前深度超过，停止
        if let Some(sd) = shortest_depth {
            if depth > sd {
                break 'bfs;
            }
        }

        let neighbors = match graph.adj.get(&state.current) {
            Some(n) => n.clone(),
            None => continue,
        };

        for edge in &neighbors {
            if state.visited.contains(&edge.target_table) {
                continue;
            }

            let mut new_edges = state.edges.clone();
            new_edges.push(edge.clone());

            if edge.target_table == to {
                // 找到路径
                shortest_depth = Some(new_edges.len());
                let join_path = build_join_path(from, to, &new_edges);
                results.push(join_path);
            } else if new_edges.len() < max_depth {
                // 只有未到上限才继续入队
                let mut new_visited = state.visited.clone();
                new_visited.insert(edge.target_table.clone());
                queue.push_back(State {
                    current: edge.target_table.clone(),
                    edges: new_edges,
                    visited: new_visited,
                });
            }
        }
    }

    // 写入缓存
    graph.path_cache.put(cache_key, results.clone());
    results
}

fn build_join_path(from: &str, _to: &str, edges: &[LogicalEdge]) -> JoinPath {
    // 构建路径字符串 "tableA → tableB → tableC"
    let mut tables = vec![from.to_string()];
    for e in edges {
        tables.push(e.target_table.clone());
    }
    let path = tables.join(" → ");

    // 取第一条边的元数据作为主要描述
    let (via, cardinality, on_delete, description, sql_hint) = if let Some(first) = edges.first() {
        let m = &first.metadata;
        let via_str = if !m.via.is_empty() {
            format!("{}.{} = {}.{}", m.source_table, m.via, m.target_table, "id")
        } else {
            String::new()
        };
        let hint = if !m.via.is_empty() {
            format!("JOIN {} ON {}.{} = {}.id", m.target_table, m.source_table, m.via, m.target_table)
        } else {
            String::new()
        };
        (via_str, m.cardinality.clone(), m.on_delete.clone(), m.description.clone(), hint)
    } else {
        (String::new(), String::new(), String::new(), String::new(), String::new())
    };

    JoinPath { path, via, cardinality, on_delete, description, sql_hint }
}
