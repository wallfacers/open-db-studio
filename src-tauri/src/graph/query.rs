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
    pub source: String,
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

    // 4. 查询节点详情（规则1：过滤掉 link 节点）
    let conn = crate::db::get().lock().unwrap();
    let mut all_nodes = Vec::new();
    for node_id in &all_node_ids {
        if let Ok(n) = conn.query_row(
            "SELECT id,node_type,connection_id,name,display_name,metadata,aliases,is_deleted,source
             FROM graph_nodes WHERE id=?1 AND node_type != 'link'",
            [node_id], row_to_node
        ) {
            all_nodes.push(n);
        }
    }

    // 5. 收集相关边
    let mut stmt = conn.prepare(
        "SELECT id,from_node,to_node,edge_type,weight,metadata,source
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
                source: row.get(6)?,
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

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};

    /// 创建 in-memory 数据库并建立 graph_nodes 及 FTS5 虚拟表
    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE graph_nodes (
                id            TEXT PRIMARY KEY,
                node_type     TEXT NOT NULL,
                connection_id INTEGER,
                name          TEXT NOT NULL,
                display_name  TEXT,
                metadata      TEXT,
                aliases       TEXT,
                is_deleted    INTEGER NOT NULL DEFAULT 0,
                source        TEXT DEFAULT 'schema'
            );

            CREATE VIRTUAL TABLE graph_nodes_fts
            USING fts5(
                id UNINDEXED,
                name,
                display_name,
                aliases,
                content='graph_nodes',
                content_rowid='rowid'
            );",
        )
        .expect("create tables");
        conn
    }

    /// 向 graph_nodes 插入一行，并将其同步到 FTS5 虚拟表。
    /// 插入 graph_nodes 后用 last_insert_rowid() 拿到 rowid，
    /// 再往 graph_nodes_fts 中插入对应行。
    fn insert_node(
        conn: &Connection,
        id: &str,
        node_type: &str,
        connection_id: i64,
        name: &str,
        display_name: Option<&str>,
        aliases: Option<&str>,
        is_deleted: i32,
    ) {
        conn.execute(
            "INSERT INTO graph_nodes
             (id, node_type, connection_id, name, display_name, metadata, aliases, is_deleted, source)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, 'schema')",
            params![id, node_type, connection_id, name, display_name, aliases, is_deleted],
        )
        .expect("insert graph_nodes");

        let rowid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO graph_nodes_fts (rowid, id, name, display_name, aliases)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![rowid, id, name, display_name, aliases],
        )
        .expect("insert graph_nodes_fts");
    }

    // -----------------------------------------------------------------------
    // 1. FTS5 前缀匹配正常关键词
    // -----------------------------------------------------------------------
    #[test]
    fn test_fts_prefix_matching() {
        let conn = setup_db();
        insert_node(&conn, "node1", "table", 1, "orders_table", None, None, 0);

        // 与 search_graph 相同的转义 + 前缀匹配逻辑
        let keyword = "orders";
        let escaped = keyword.replace('"', "\"\"");
        let fts_query = format!("\"{}\"*", escaped);

        let mut stmt = conn
            .prepare(
                "SELECT gn.id, gn.node_type, gn.connection_id, gn.name,
                        gn.display_name, gn.metadata, gn.aliases, gn.is_deleted, gn.source
                 FROM graph_nodes_fts fts
                 JOIN graph_nodes gn ON gn.rowid = fts.rowid
                 WHERE graph_nodes_fts MATCH ?1
                   AND gn.connection_id = ?2
                   AND gn.is_deleted = 0
                 LIMIT 20",
            )
            .unwrap();

        let results: Vec<String> = stmt
            .query_map(params![fts_query, 1i64], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(results.len(), 1, "前缀匹配应命中 orders_table");
        assert_eq!(results[0], "node1");
    }

    // -----------------------------------------------------------------------
    // 2. FTS5 特殊字符（双引号）转义后查询不崩溃
    // -----------------------------------------------------------------------
    #[test]
    fn test_fts_special_char_escaping() {
        let conn = setup_db();
        // 插入一个普通节点，不期待它被命中
        insert_node(&conn, "node1", "table", 1, "normal_table", None, None, 0);

        // keyword 含双引号，转义后应为 `"table""name"*`
        let keyword = r#"table"name"#;
        let escaped = keyword.replace('"', "\"\"");
        let fts_query = format!("\"{}\"*", escaped);

        // 关键：执行查询不应 panic / 返回错误
        let mut stmt = conn
            .prepare(
                "SELECT gn.id
                 FROM graph_nodes_fts fts
                 JOIN graph_nodes gn ON gn.rowid = fts.rowid
                 WHERE graph_nodes_fts MATCH ?1
                   AND gn.connection_id = ?2
                   AND gn.is_deleted = 0
                 LIMIT 20",
            )
            .unwrap();

        let result: Result<Vec<String>, _> = stmt
            .query_map(params![fts_query, 1i64], |row| row.get(0))
            .unwrap()
            .collect();

        assert!(result.is_ok(), "含双引号的关键词转义后查询不应返回错误");
        // 无论结果是否为空，只要不崩溃即可
    }

    // -----------------------------------------------------------------------
    // 3. search_graph 不返回 is_deleted=1 的节点
    // -----------------------------------------------------------------------
    #[test]
    fn test_search_excludes_deleted_nodes() {
        let conn = setup_db();
        // 未删除节点
        insert_node(&conn, "node_alive", "table", 1, "users_table", None, None, 0);
        // 已删除节点
        insert_node(&conn, "node_dead", "table", 1, "users_archive", None, None, 1);

        let keyword = "users";
        let escaped = keyword.replace('"', "\"\"");
        let fts_query = format!("\"{}\"*", escaped);

        let mut stmt = conn
            .prepare(
                "SELECT gn.id, gn.is_deleted
                 FROM graph_nodes_fts fts
                 JOIN graph_nodes gn ON gn.rowid = fts.rowid
                 WHERE graph_nodes_fts MATCH ?1
                   AND gn.connection_id = ?2
                   AND gn.is_deleted = 0
                 LIMIT 20",
            )
            .unwrap();

        let results: Vec<(String, i32)> = stmt
            .query_map(params![fts_query, 1i64], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(results.len(), 1, "只应返回一个未删除节点");
        assert_eq!(results[0].0, "node_alive");
        assert_eq!(results[0].1, 0, "返回节点的 is_deleted 必须为 0");
    }

    // -----------------------------------------------------------------------
    // 4. get_nodes 按 node_type 过滤
    // -----------------------------------------------------------------------
    #[test]
    fn test_get_nodes_filters_by_type() {
        let conn = setup_db();
        insert_node(&conn, "t1", "table",  1, "orders", None, None, 0);
        insert_node(&conn, "c1", "column", 1, "order_id", None, None, 0);

        // 复现 get_nodes(connection_id=1, node_type=Some("table")) 的 SQL
        let mut stmt = conn
            .prepare(
                "SELECT id, node_type, connection_id, name, display_name, metadata,
                        aliases, is_deleted, source
                 FROM graph_nodes
                 WHERE connection_id=?1 AND node_type=?2 AND is_deleted=0
                 ORDER BY name",
            )
            .unwrap();

        let results: Vec<(String, String)> = stmt
            .query_map(params![1i64, "table"], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(results.len(), 1, "按 node_type='table' 过滤应只返回一行");
        assert_eq!(results[0].0, "t1");
        assert_eq!(results[0].1, "table");
    }

    // -----------------------------------------------------------------------
    // 5. get_nodes 不返回 is_deleted 节点
    // -----------------------------------------------------------------------
    #[test]
    fn test_get_nodes_excludes_deleted() {
        let conn = setup_db();
        insert_node(&conn, "n_active", "table", 1, "products", None, None, 0);
        insert_node(&conn, "n_dead",   "table", 1, "products_old", None, None, 1);

        // 复现 get_nodes(connection_id=1, node_type=None) 的 SQL
        let mut stmt = conn
            .prepare(
                "SELECT id, is_deleted
                 FROM graph_nodes
                 WHERE connection_id=?1 AND is_deleted=0
                 ORDER BY node_type, name",
            )
            .unwrap();

        let results: Vec<(String, i32)> = stmt
            .query_map(params![1i64], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(results.len(), 1, "is_deleted=1 的节点不应出现");
        assert_eq!(results[0].0, "n_active");
        assert_eq!(results[0].1, 0);
    }

    // -----------------------------------------------------------------------
    // 6. row_to_node：metadata 字段作为 Option<String> 映射正确
    // -----------------------------------------------------------------------
    #[test]
    fn test_row_to_node_metadata_is_option_string() {
        let conn = setup_db();

        // 带 metadata JSON 字符串的节点
        conn.execute(
            "INSERT INTO graph_nodes
             (id, node_type, connection_id, name, display_name, metadata, aliases, is_deleted, source)
             VALUES ('m1', 'table', 1, 'meta_table', NULL, '{\"comment\":\"test\"}', NULL, 0, 'schema')",
            [],
        )
        .unwrap();

        // metadata 为 NULL 的节点
        conn.execute(
            "INSERT INTO graph_nodes
             (id, node_type, connection_id, name, display_name, metadata, aliases, is_deleted, source)
             VALUES ('m2', 'table', 1, 'no_meta_table', NULL, NULL, NULL, 0, 'schema')",
            [],
        )
        .unwrap();

        let node_with_meta = conn
            .query_row(
                "SELECT id,node_type,connection_id,name,display_name,metadata,aliases,is_deleted,source
                 FROM graph_nodes WHERE id='m1'",
                [],
                super::row_to_node,
            )
            .unwrap();

        let node_without_meta = conn
            .query_row(
                "SELECT id,node_type,connection_id,name,display_name,metadata,aliases,is_deleted,source
                 FROM graph_nodes WHERE id='m2'",
                [],
                super::row_to_node,
            )
            .unwrap();

        // metadata 应为 Some(String)，而非 serde_json::Value
        assert!(node_with_meta.metadata.is_some(), "有 metadata 时应为 Some");
        assert_eq!(
            node_with_meta.metadata.as_deref(),
            Some("{\"comment\":\"test\"}"),
            "metadata 应原样保存为字符串"
        );
        assert!(node_without_meta.metadata.is_none(), "metadata 为 NULL 时应为 None");
    }
}
