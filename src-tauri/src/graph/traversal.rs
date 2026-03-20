use crate::AppResult;
use std::collections::{HashMap, HashSet, VecDeque};

/// 从 graph_edges 读取 foreign_key 边的邻接表
fn load_fk_adjacency(connection_id: i64) -> AppResult<Vec<(String, String)>> {
    let conn = crate::db::get().lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT e.from_node, e.to_node
         FROM graph_edges e
         JOIN graph_nodes n ON n.id = e.from_node
         WHERE n.connection_id = ?1 AND e.edge_type = 'foreign_key'"
    )?;
    let rows = stmt.query_map([connection_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// BFS 内部函数（可测试，不依赖 DB）
pub(crate) fn bfs_paths(
    start_ids: &[String],
    edges: &[(String, String)],
    max_hops: u8,
) -> Vec<Vec<String>> {
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for (from, to) in edges {
        adj.entry(from.clone()).or_default().push(to.clone());
        adj.entry(to.clone()).or_default().push(from.clone()); // 双向
    }

    let mut paths = Vec::new();
    for start in start_ids {
        let mut visited: HashSet<String> = HashSet::new();
        let mut queue: VecDeque<(String, Vec<String>, u8)> = VecDeque::new();
        queue.push_back((start.clone(), vec![start.clone()], 0));
        visited.insert(start.clone());

        while let Some((node, path, hops)) = queue.pop_front() {
            if hops > 0 {
                paths.push(path.clone());
            }
            if hops >= max_hops {
                continue;
            }
            if let Some(neighbors) = adj.get(&node) {
                for next in neighbors {
                    if !visited.contains(next) {
                        visited.insert(next.clone());
                        let mut new_path = path.clone();
                        new_path.push(next.clone());
                        queue.push_back((next.clone(), new_path, hops + 1));
                    }
                }
            }
        }
    }
    paths
}

pub fn find_join_paths(
    connection_id: i64,
    from_node_ids: &[String],
    max_hops: u8,
) -> AppResult<Vec<Vec<String>>> {
    let fk_edges = load_fk_adjacency(connection_id)?;
    Ok(bfs_paths(from_node_ids, &fk_edges, max_hops))
}

/// 新增函数：返回结构化 JOIN 路径（用于 MCP 工具）
pub async fn find_join_paths_structured(
    connection_id: i64,
    from_table: &str,
    to_table: &str,
    max_depth: usize,
    app_handle: &tauri::AppHandle,
) -> AppResult<Vec<crate::graph::JoinPath>> {
    use tauri::Manager;
    let app_state = app_handle.state::<crate::AppState>();
    let cache_arc = app_state.graph_cache.get_or_load(connection_id).await?;
    let mut graph = cache_arc.lock().await;
    Ok(crate::graph::cache::bfs_find_paths(&mut graph, from_table, to_table, max_depth))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bfs_simple_path() {
        let edges = vec![
            ("nodeA".to_string(), "nodeB".to_string()),
            ("nodeB".to_string(), "nodeC".to_string()),
        ];
        let paths = bfs_paths(&["nodeA".to_string()], &edges, 2);
        assert!(!paths.is_empty());
        assert!(paths.iter().any(|p| p.len() == 2));
        assert!(paths.iter().any(|p| p.len() == 3));
    }

    #[test]
    fn test_bfs_max_hops_limit() {
        let edges = vec![
            ("A".to_string(), "B".to_string()),
            ("B".to_string(), "C".to_string()),
            ("C".to_string(), "D".to_string()),
        ];
        let paths = bfs_paths(&["A".to_string()], &edges, 1);
        // max_hops=1，只能走一步，最长路径 2 个节点
        assert!(paths.iter().all(|p| p.len() <= 2));
    }

    #[test]
    fn test_bfs_no_edges() {
        let paths = bfs_paths(&["A".to_string()], &[], 2);
        assert!(paths.is_empty());
    }
}
