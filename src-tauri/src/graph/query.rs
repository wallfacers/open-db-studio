use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphNode {
    pub id: String,
    pub node_type: String,
    pub connection_id: Option<i64>,
    pub name: String,
    pub display_name: Option<String>,
    pub metadata: Option<String>,
    pub aliases: Option<String>,
    pub is_deleted: Option<i32>,
    pub source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphEdge {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub edge_type: String,
    pub weight: f64,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SubGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub join_paths: Vec<Vec<String>>,
}

fn row_to_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<GraphNode> {
    Ok(GraphNode {
        id: row.get(0)?,
        node_type: row.get(1)?,
        connection_id: row.get(2)?,
        name: row.get(3)?,
        display_name: row.get(4)?,
        metadata: row.get::<_, Option<String>>(5)?,
        aliases: row.get::<_, Option<String>>(6)?,
        is_deleted: row.get::<_, Option<i32>>(7)?,
        source: row.get::<_, Option<String>>(8)?,
    })
}

pub fn get_nodes(connection_id: i64, node_type: Option<&str>) -> AppResult<Vec<GraphNode>> {
    let conn = crate::db::get().lock().unwrap();
    let (sql, p): (String, Vec<Box<dyn rusqlite::ToSql>>) = match node_type {
        Some(t) => (
            "SELECT id,node_type,connection_id,name,display_name,metadata,aliases,is_deleted,source
             FROM graph_nodes WHERE connection_id=?1 AND node_type=?2 AND is_deleted=0 ORDER BY name".to_string(),
            vec![Box::new(connection_id), Box::new(t.to_string())],
        ),
        None => (
            "SELECT id,node_type,connection_id,name,display_name,metadata,aliases,is_deleted,source
             FROM graph_nodes WHERE connection_id=?1 AND is_deleted=0 ORDER BY node_type,name".to_string(),
            vec![Box::new(connection_id)],
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(p.iter()), row_to_node)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// FTS5 全文检索：通过 graph_nodes_fts 虚拟表进行前缀匹配
pub fn search_graph(connection_id: i64, keyword: &str) -> AppResult<Vec<GraphNode>> {
    let conn = crate::db::get().lock().unwrap();
    // FTS5 前缀匹配：转义关键词中的双引号后包裹在引号内并加 * 前缀匹配
    let escaped = keyword.replace('"', "\"\"");
    let fts_query = format!("\"{}\"*", escaped);
    let mut stmt = conn.prepare(
        "SELECT gn.id, gn.node_type, gn.connection_id, gn.name, gn.display_name, gn.metadata,
                gn.aliases, gn.is_deleted, gn.source
         FROM graph_nodes_fts fts
         JOIN graph_nodes gn ON gn.rowid = fts.rowid
         WHERE graph_nodes_fts MATCH ?1
           AND gn.connection_id = ?2
           AND gn.is_deleted = 0
         LIMIT 20"
    )?;
    let rows = stmt.query_map(rusqlite::params![fts_query, connection_id], row_to_node)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub async fn find_relevant_subgraph(
    connection_id: i64,
    entities: &[String],
    max_hops: u8,
) -> AppResult<SubGraph> {
    if entities.is_empty() {
        return Ok(SubGraph { nodes: vec![], edges: vec![], join_paths: vec![] });
    }

    // 1. 匹配实体名的表节点
    // ⚠️ rusqlite ?N 是位置绑定，同一个 ?N 不能出现两次
    // 两个 IN 子句用不同编号：?2..?N+1（name IN）和 ?N+2..?2N+1（alias IN）
    let n = entities.len();
    let ph1 = (2..=n+1).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(",");
    let ph2 = (n+2..=2*n+1).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id,node_type,connection_id,name,display_name,metadata,aliases,is_deleted,source
         FROM graph_nodes
         WHERE connection_id=?1 AND node_type='table'
           AND (name IN ({ph1}) OR id IN (
               SELECT node_id FROM semantic_aliases WHERE connection_id=?1
                 AND alias IN ({ph2})
           ))",
        ph1 = ph1, ph2 = ph2
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(connection_id)];
    for e in entities {
        params.push(Box::new(e.clone()));  // ?2..?N+1 for name IN
    }
    for e in entities {
        params.push(Box::new(e.clone()));  // ?N+2..?2N+1 for alias IN
    }

    let matched_nodes: Vec<GraphNode> = {
        let conn = crate::db::get().lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let result = stmt.query_map(rusqlite::params_from_iter(params.iter()), row_to_node)?
            .collect::<Result<Vec<_>, _>>()?;
        result
    };

    let matched_ids: Vec<String> = matched_nodes.iter().map(|n| n.id.clone()).collect();

    // 2. BFS 找 JOIN 路径（锁外调用）
    let join_paths = crate::graph::traversal::find_join_paths(
        connection_id, &matched_ids, max_hops
    )?;

    // 3. 收集路径涉及的所有节点 ID
    let all_node_ids: std::collections::HashSet<String> = join_paths.iter()
        .flat_map(|p| p.iter().cloned())
        .chain(matched_ids.iter().cloned())
        .collect();

    // 4. 查询节点详情
    let conn = crate::db::get().lock().unwrap();
    let mut all_nodes = Vec::new();
    for node_id in &all_node_ids {
        if let Ok(n) = conn.query_row(
            "SELECT id,node_type,connection_id,name,display_name,metadata,aliases,is_deleted,source
             FROM graph_nodes WHERE id=?1",
            [node_id], row_to_node
        ) {
            all_nodes.push(n);
        }
    }

    // 5. 收集相关边
    let mut stmt = conn.prepare(
        "SELECT id,from_node,to_node,edge_type,weight,metadata
         FROM graph_edges WHERE from_node=?1 OR to_node=?1"
    )?;
    let mut edges = Vec::new();
    for node_id in &all_node_ids {
        let rows = stmt.query_map([node_id], |row| {
            let meta_str: Option<String> = row.get(5)?;
            Ok(GraphEdge {
                id: row.get(0)?,
                from_node: row.get(1)?,
                to_node: row.get(2)?,
                edge_type: row.get(3)?,
                weight: row.get(4)?,
                metadata: meta_str.and_then(|s| serde_json::from_str(&s).ok()),
            })
        })?;
        for r in rows {
            edges.push(r?);
        }
    }
    // 去重（按 id 排序后去重）
    edges.sort_by(|a, b| a.id.cmp(&b.id));
    edges.dedup_by_key(|e| e.id.clone());

    Ok(SubGraph { nodes: all_nodes, edges, join_paths })
}
