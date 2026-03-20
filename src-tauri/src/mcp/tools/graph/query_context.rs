use std::sync::Arc;
use serde_json::{json, Value};
use tauri::Manager;

pub async fn handle(
    handle: Arc<tauri::AppHandle>,
    args: Value,
) -> crate::AppResult<String> {
    let question = args["question"].as_str()
        .ok_or_else(|| crate::AppError::Other("missing question".into()))?
        .to_string();
    let connection_id = args["connection_id"].as_i64()
        .ok_or_else(|| crate::AppError::Other("missing connection_id".into()))?;

    // 1. 实体提取
    let entities = crate::pipeline::entity_extract::extract_entities(&question, connection_id)
        .await
        .unwrap_or_default();

    // 2. 图谱子图检索
    let subgraph = crate::graph::query::find_relevant_subgraph(
        connection_id, &entities, 2
    ).await.unwrap_or_else(|_| crate::graph::SubGraph {
        nodes: vec![], edges: vec![], join_paths: vec![],
    });

    // 3. 判断命中质量 + FTS5 兜底
    let relevant_tables: Vec<String> = subgraph.nodes.iter()
        .filter(|n| matches!(n.node_type.as_str(), "table" | "metric" | "alias"))
        .map(|n| n.name.clone())
        .collect();

    let (effective_tables, context_quality) = if !relevant_tables.is_empty() {
        (relevant_tables, "graph_hit")
    } else if !entities.is_empty() {
        // FTS5 兜底
        let mut fts_tables = Vec::new();
        for kw in &entities {
            if let Ok(nodes) = crate::graph::query::search_graph(connection_id, kw) {
                for n in nodes {
                    if matches!(n.node_type.as_str(), "table" | "metric" | "alias")
                        && !fts_tables.contains(&n.name)
                    {
                        fts_tables.push(n.name);
                    }
                }
            }
        }
        if !fts_tables.is_empty() {
            (fts_tables, "fts_fallback")
        } else {
            (vec![], "schema_only")
        }
    } else {
        (vec![], "schema_only")
    };

    // 4. 结构化 JOIN 路径
    let mut join_paths: Vec<Value> = Vec::new();
    for path in &subgraph.join_paths {
        if path.len() >= 2 {
            // 将节点 id 转为 name
            let names: Vec<String> = path.iter()
                .filter_map(|id| subgraph.nodes.iter().find(|n| &n.id == id))
                .filter(|n| n.node_type != "link")
                .map(|n| n.name.clone())
                .collect();
            if names.len() >= 2 {
                let from = &names[0];
                let to = names.last().unwrap();
                // 尝试获取结构化路径
                if let Ok(structured) = crate::graph::traversal::find_join_paths_structured(
                    connection_id, from, to, 4, &handle
                ).await {
                    for jp in structured {
                        join_paths.push(json!({
                            "path": jp.path,
                            "via": jp.via,
                            "cardinality": jp.cardinality,
                            "on_delete": jp.on_delete,
                            "description": jp.description,
                            "sql_hint": jp.sql_hint,
                        }));
                    }
                } else {
                    // 降级：用名字拼路径
                    join_paths.push(json!({
                        "path": names.join(" → "),
                        "via": "",
                        "cardinality": "",
                        "on_delete": "",
                        "description": "",
                        "sql_hint": "",
                    }));
                }
            }
        }
    }

    // 5. 相关指标
    let metrics = crate::metrics::search_metrics(connection_id, &entities)
        .unwrap_or_default();
    let metric_descs: Vec<String> = metrics.iter()
        .map(|m| {
            let agg = m.aggregation.as_deref().unwrap_or("VALUE");
            let col = m.column_name.as_deref().unwrap_or("*");
            format!("{} = {}({}.{}): {}",
                m.display_name, agg, m.table_name, col,
                m.description.as_deref().unwrap_or(""))
        })
        .collect();

    let result = json!({
        "relevant_tables": effective_tables,
        "join_paths": join_paths,
        "schema_ddl": "",
        "metrics": metric_descs,
        "context_quality": context_quality,
    });

    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}
