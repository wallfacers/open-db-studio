use crate::AppResult;
use super::SqlContext;

pub async fn build_sql_context(
    connection_id: i64,
    entities: &[String],
) -> AppResult<SqlContext> {
    // 1. 图谱检索相关子图
    let subgraph = crate::graph::query::find_relevant_subgraph(
        connection_id, entities, 2
    ).await?;

    let relevant_tables: Vec<String> = subgraph.nodes.iter()
        .filter(|n| n.node_type == "table")
        .map(|n| n.name.clone())
        .collect();

    // 2. JOIN 路径转可读文字
    let join_paths: Vec<String> = subgraph.join_paths.iter()
        .filter(|p| p.len() >= 2)
        .map(|path| {
            let names: Vec<String> = path.iter()
                .filter_map(|id| subgraph.nodes.iter().find(|n| &n.id == id))
                .map(|n| n.name.clone())
                .collect();
            names.join(" → ")
        })
        .collect();

    // 3. 相关指标
    let metrics = crate::metrics::search_metrics(connection_id, &entities.to_vec())?;
    let metric_descs: Vec<String> = metrics.iter()
        .map(|m| {
            let agg = m.aggregation.as_deref().unwrap_or("VALUE");
            let col = m.column_name.as_deref().unwrap_or("*");
            format!("{} = {}({}.{}): {}",
                m.display_name, agg, m.table_name, col,
                m.description.as_deref().unwrap_or(""))
        })
        .collect();

    // 4. 构建精简 Schema DDL（只包含相关表）
    let config = crate::db::get_connection_config(connection_id)?;
    let ds = crate::datasource::create_datasource(&config).await?;
    let mut schema_ddl = String::new();
    for table_name in &relevant_tables {
        let cols = ds.get_columns(table_name, None).await.unwrap_or_default();
        schema_ddl.push_str(&format!("-- 表: {}\n", table_name));
        for col in &cols {
            schema_ddl.push_str(&format!(
                "--   {} {} {}\n",
                col.name, col.data_type,
                if col.is_primary_key { "PRIMARY KEY" } else { "" }
            ));
        }
        schema_ddl.push('\n');
    }

    Ok(SqlContext {
        relevant_tables,
        join_paths,
        metrics: metric_descs,
        schema_ddl,
    })
}
