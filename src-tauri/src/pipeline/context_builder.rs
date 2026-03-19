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

    // 降级策略11：子图检索无命中时，用 FTS5 搜索兜底
    let effective_tables = if relevant_tables.is_empty() && !entities.is_empty() {
        // 对每个关键词做 FTS5 搜索，收集命中的表名
        let mut fts_tables: Vec<String> = Vec::new();
        for keyword in entities {
            let nodes = crate::graph::query::search_graph(connection_id, keyword)
                .unwrap_or_default();
            for node in nodes {
                if node.node_type == "table" && !fts_tables.contains(&node.name) {
                    fts_tables.push(node.name);
                }
            }
        }
        fts_tables
    } else {
        relevant_tables
    };

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

    if effective_tables.is_empty() {
        // 降级策略11（兜底）：图谱和 FTS5 均无命中，尝试注入所有表名列表
        match ds.get_schema().await {
            Ok(schema) if !schema.tables.is_empty() => {
                schema_ddl.push_str("-- 图谱检索无结果，以下为全库表名列表\n");
                for t in &schema.tables {
                    schema_ddl.push_str(&format!("-- Table: {}\n", t.name));
                }
                schema_ddl.push('\n');
            }
            _ => {
                // 连 schema 都无法获取时，写入提示让 LLM 依靠通用知识
                schema_ddl.push_str(
                    "-- 图谱检索无结果，请根据常规 SQL 知识生成\n"
                );
            }
        }
    } else {
        for table_name in &effective_tables {
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
    }

    Ok(SqlContext {
        relevant_tables: effective_tables,
        join_paths,
        metrics: metric_descs,
        schema_ddl,
    })
}

#[cfg(test)]
mod tests {
    use super::super::SqlContext;

    /// SqlContext 所有字段为空时，各字段的空状态断言
    #[test]
    fn test_sql_context_empty_when_all_fields_empty() {
        let ctx = SqlContext {
            relevant_tables: vec![],
            join_paths: vec![],
            metrics: vec![],
            schema_ddl: String::new(),
        };
        assert!(ctx.relevant_tables.is_empty());
        assert!(ctx.join_paths.is_empty());
        assert!(ctx.metrics.is_empty());
        assert!(ctx.schema_ddl.is_empty());
    }

    /// SqlContext 有数据时，各字段不为空
    #[test]
    fn test_sql_context_non_empty_fields() {
        let ctx = SqlContext {
            relevant_tables: vec!["orders".to_string()],
            join_paths: vec!["orders → users".to_string()],
            metrics: vec!["GMV = SUM(orders.amount): 总成交额".to_string()],
            schema_ddl: "-- 表: orders\n".to_string(),
        };
        assert!(!ctx.relevant_tables.is_empty());
        assert!(!ctx.join_paths.is_empty());
        assert!(!ctx.metrics.is_empty());
        assert!(!ctx.schema_ddl.is_empty());
    }

    /// graph_context 判断逻辑（复刻 generate_sql_v2 中的条件）：
    /// relevant_tables / join_paths / metrics 均为空时视为无命中
    #[test]
    fn test_graph_context_none_condition_all_empty() {
        let ctx = SqlContext {
            relevant_tables: vec![],
            join_paths: vec![],
            metrics: vec![],
            schema_ddl: "-- fallback\n".to_string(),
        };
        let is_no_hit = ctx.relevant_tables.is_empty()
            && ctx.join_paths.is_empty()
            && ctx.metrics.is_empty();
        assert!(is_no_hit, "三个检索字段均为空时应判定为无命中");
    }

    /// 只要有任意一个非空字段，就不应视为无命中
    #[test]
    fn test_graph_context_some_condition_partial_hit() {
        let ctx = SqlContext {
            relevant_tables: vec!["orders".to_string()],
            join_paths: vec![],
            metrics: vec![],
            schema_ddl: String::new(),
        };
        let is_no_hit = ctx.relevant_tables.is_empty()
            && ctx.join_paths.is_empty()
            && ctx.metrics.is_empty();
        assert!(!is_no_hit, "relevant_tables 非空时应判定为有命中");
    }
}
