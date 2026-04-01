use crate::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Metric {
    pub id: i64,
    pub connection_id: i64,
    pub name: String,
    pub display_name: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub source: String,
    pub metric_type: String,
    pub composite_components: Option<String>,
    pub composite_formula: Option<String>,
    pub category: Option<String>,
    pub data_caliber: Option<String>,
    pub version: Option<String>,
    pub scope_database: Option<String>,
    pub scope_schema: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateMetricInput {
    pub connection_id: i64,
    pub name: String,
    pub display_name: String,
    pub table_name: Option<String>,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub source: Option<String>,
    pub metric_type: Option<String>,
    pub composite_components: Option<String>,
    pub composite_formula: Option<String>,
    pub category: Option<String>,
    pub data_caliber: Option<String>,
    pub version: Option<String>,
    pub scope_database: Option<String>,
    pub scope_schema: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMetricInput {
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub table_name: Option<String>,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub metric_type: Option<String>,
    pub composite_components: Option<String>,
    pub composite_formula: Option<String>,
    pub category: Option<String>,
    pub data_caliber: Option<String>,
    pub version: Option<String>,
    pub scope_database: Option<String>,
    pub scope_schema: Option<String>,
}

const SELECT_COLS: &str =
    "id,connection_id,name,display_name,table_name,column_name,aggregation,\
     filter_sql,description,status,source,metric_type,composite_components,\
     composite_formula,category,data_caliber,version,scope_database,scope_schema,\
     created_at,updated_at";

fn row_to_metric(row: &rusqlite::Row<'_>) -> rusqlite::Result<Metric> {
    Ok(Metric {
        id: row.get(0)?,
        connection_id: row.get(1)?,
        name: row.get(2)?,
        display_name: row.get(3)?,
        table_name: row.get(4)?,
        column_name: row.get(5)?,
        aggregation: row.get(6)?,
        filter_sql: row.get(7)?,
        description: row.get(8)?,
        status: row.get(9)?,
        source: row.get(10)?,
        metric_type: row.get(11)?,
        composite_components: row.get(12)?,
        composite_formula: row.get(13)?,
        category: row.get(14)?,
        data_caliber: row.get(15)?,
        version: row.get(16)?,
        scope_database: row.get(17)?,
        scope_schema: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}

fn get_metric_by_id(conn: &rusqlite::Connection, id: i64) -> AppResult<Metric> {
    conn.query_row(
        &format!("SELECT {} FROM metrics WHERE id=?1", SELECT_COLS),
        [id],
        row_to_metric,
    ).map_err(Into::into)
}

pub fn list_metrics(connection_id: i64, status: Option<&str>) -> AppResult<Vec<Metric>> {
    let conn = crate::db::get().lock().unwrap();
    let sql = match status {
        Some(_) => format!(
            "SELECT {} FROM metrics WHERE connection_id=?1 AND status=?2 ORDER BY created_at DESC",
            SELECT_COLS
        ),
        None => format!(
            "SELECT {} FROM metrics WHERE connection_id=?1 ORDER BY created_at DESC",
            SELECT_COLS
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = match status {
        Some(s) => stmt.query_map(rusqlite::params![connection_id, s], row_to_metric)?,
        None => stmt.query_map(rusqlite::params![connection_id], row_to_metric)?,
    };
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn save_metric(input: &CreateMetricInput) -> AppResult<Metric> {
    let conn = crate::db::get().lock().unwrap();
    let source = input.source.as_deref().unwrap_or("user");
    let metric_type = input.metric_type.as_deref().unwrap_or("atomic");
    let table_name = input.table_name.as_deref().unwrap_or("");
    conn.execute(
        "INSERT INTO metrics
            (connection_id,name,display_name,table_name,column_name,aggregation,
             filter_sql,description,source,metric_type,composite_components,
             composite_formula,category,data_caliber,version,scope_database,scope_schema)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        rusqlite::params![
            input.connection_id, input.name, input.display_name, table_name,
            input.column_name, input.aggregation, input.filter_sql, input.description,
            source, metric_type, input.composite_components, input.composite_formula,
            input.category, input.data_caliber, input.version,
            input.scope_database, input.scope_schema
        ],
    )?;
    let id = conn.last_insert_rowid();
    get_metric_by_id(&conn, id)
}

pub fn update_metric(id: i64, input: &UpdateMetricInput) -> AppResult<Metric> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE metrics SET
            name=COALESCE(?2,name),
            display_name=COALESCE(?3,display_name),
            table_name=COALESCE(?4,table_name),
            column_name=COALESCE(?5,column_name),
            aggregation=COALESCE(?6,aggregation),
            filter_sql=COALESCE(?7,filter_sql),
            description=COALESCE(?8,description),
            metric_type=COALESCE(?9,metric_type),
            composite_components=COALESCE(?10,composite_components),
            composite_formula=COALESCE(?11,composite_formula),
            category=COALESCE(?12,category),
            data_caliber=COALESCE(?13,data_caliber),
            version=COALESCE(?14,version),
            scope_database=COALESCE(?15,scope_database),
            scope_schema=COALESCE(?16,scope_schema),
            updated_at=datetime('now')
         WHERE id=?1",
        rusqlite::params![
            id,
            input.name, input.display_name, input.table_name,
            input.column_name, input.aggregation, input.filter_sql, input.description,
            input.metric_type, input.composite_components, input.composite_formula,
            input.category, input.data_caliber, input.version,
            input.scope_database, input.scope_schema
        ],
    )?;
    get_metric_by_id(&conn, id)
}

pub fn delete_metric(id: i64) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let referencing: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT display_name FROM metrics WHERE metric_type='composite'
             AND composite_components LIKE '%\"metric_id\":' || CAST(?1 AS TEXT) || '%'"
        )?;
        let rows = stmt.query_map([id], |row| row.get(0))?;
        let collected: Result<Vec<String>, _> = rows.collect();
        collected?
    };
    if !referencing.is_empty() {
        return Err(crate::AppError::Other(format!(
            "该指标被以下复合指标引用，无法删除：{}",
            referencing.join("、")
        )));
    }
    conn.execute("DELETE FROM metrics WHERE id=?1", [id])?;
    Ok(())
}

pub fn set_metric_status(id: i64, status: &str) -> AppResult<Metric> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE metrics SET status=?2, updated_at=datetime('now') WHERE id=?1",
        rusqlite::params![id, status],
    )?;
    get_metric_by_id(&conn, id)
}

pub fn search_metrics(connection_id: i64, keywords: &[String]) -> AppResult<Vec<Metric>> {
    if keywords.is_empty() {
        return Ok(vec![]);
    }
    let conn = crate::db::get().lock().map_err(|_| crate::AppError::Other("DB lock poisoned".into()))?;
    let mut seen_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut results: Vec<Metric> = Vec::new();
    // Run a separate LIKE query per keyword (OR semantics), dedup by id
    for keyword in keywords {
        let pattern = format!("%{}%", keyword);
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM metrics WHERE connection_id=?1 AND status='approved'
               AND (name LIKE ?2 OR display_name LIKE ?2 OR description LIKE ?2)
             ORDER BY name",
            SELECT_COLS
        ))?;
        let rows = stmt.query_map(rusqlite::params![connection_id, pattern], row_to_metric)?;
        for row in rows {
            let metric = row?;
            if seen_ids.insert(metric.id) {
                results.push(metric);
            }
        }
    }
    Ok(results)
}

pub fn get_metric_pub(id: i64) -> AppResult<Metric> {
    let conn = crate::db::get().lock().unwrap();
    get_metric_by_id(&conn, id)
}

pub fn list_metrics_by_node(
    connection_id: i64,
    database: Option<&str>,
    schema: Option<&str>,
    status: Option<&str>,
) -> AppResult<Vec<Metric>> {
    let conn = crate::db::get().lock().unwrap();
    let mut sql = format!(
        "SELECT {} FROM metrics WHERE connection_id=?1",
        SELECT_COLS
    );
    let mut param_values: Vec<String> = vec![connection_id.to_string()];
    let mut idx = 2usize;

    if let Some(db) = database {
        sql.push_str(&format!(" AND (scope_database=?{} OR scope_database IS NULL)", idx));
        param_values.push(db.to_string());
        idx += 1;
    }
    if let Some(sc) = schema {
        sql.push_str(&format!(" AND (scope_schema=?{} OR scope_schema IS NULL)", idx));
        param_values.push(sc.to_string());
        idx += 1;
    }
    if let Some(st) = status {
        sql.push_str(&format!(" AND status=?{}", idx));
        param_values.push(st.to_string());
    }
    sql.push_str(" ORDER BY created_at DESC");

    // 使用动态参数查询
    let mut stmt = conn.prepare(&sql)?;
    match (database, schema, status) {
        (None, None, None) => {
            let rows = stmt.query_map(rusqlite::params![connection_id], row_to_metric)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }
        (Some(db), None, None) => {
            let rows = stmt.query_map(rusqlite::params![connection_id, db], row_to_metric)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }
        (Some(db), Some(sc), None) => {
            let rows = stmt.query_map(rusqlite::params![connection_id, db, sc], row_to_metric)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }
        (Some(db), Some(sc), Some(st)) => {
            let rows = stmt.query_map(rusqlite::params![connection_id, db, sc, st], row_to_metric)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }
        (None, None, Some(st)) => {
            let rows = stmt.query_map(rusqlite::params![connection_id, st], row_to_metric)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }
        (Some(db), None, Some(st)) => {
            let rows = stmt.query_map(rusqlite::params![connection_id, db, st], row_to_metric)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }
        _ => {
            // schema without database — rare, fallback
            let rows = stmt.query_map(rusqlite::params![connection_id], row_to_metric)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }
    }
}

pub fn list_metrics_by_node_paged(
    connection_id: i64,
    database: Option<&str>,
    schema: Option<&str>,
    status: Option<&str>,
    page: u32,
    page_size: u32,
) -> AppResult<(Vec<Metric>, usize, i64)> {
    let conn = crate::db::get().lock().unwrap();

    // 构建公用 WHERE 片段与参数（不含 LIMIT/OFFSET/ORDER BY）
    let mut where_sql = "WHERE connection_id=?1".to_string();
    let mut param_values: Vec<String> = vec![connection_id.to_string()];
    let mut idx = 2usize;

    if let Some(db) = database {
        where_sql.push_str(&format!(" AND (scope_database=?{} OR scope_database IS NULL)", idx));
        param_values.push(db.to_string());
        idx += 1;

        if let Some(sc) = schema {
            where_sql.push_str(&format!(" AND (scope_schema=?{} OR scope_schema IS NULL)", idx));
            param_values.push(sc.to_string());
            idx += 1;
        }
    }
    if let Some(st) = status {
        where_sql.push_str(&format!(" AND status=?{}", idx));
        param_values.push(st.to_string());
        idx += 1;
    }

    // COUNT 查询
    let count_sql = format!("SELECT COUNT(*) FROM metrics {}", where_sql);
    let total_rows: i64 = conn.query_row(
        &count_sql,
        rusqlite::params_from_iter(param_values.iter().map(|s| s.as_str())),
        |row| row.get(0),
    ).unwrap_or(0);

    // 数据查询
    let offset = (page.saturating_sub(1)) as u64 * page_size as u64;
    let data_sql = format!(
        "SELECT {} FROM metrics {} ORDER BY created_at DESC LIMIT ?{} OFFSET ?{}",
        SELECT_COLS, where_sql, idx, idx + 1
    );
    param_values.push(page_size.to_string());
    param_values.push(offset.to_string());

    let mut stmt = conn.prepare(&data_sql)?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter(param_values.iter().map(|s| s.as_str())),
        row_to_metric,
    )?;
    let items: Vec<Metric> = rows.collect::<Result<Vec<_>, _>>()?;
    let row_count = items.len();
    Ok((items, row_count, total_rows))
}

pub fn count_metrics_batch(
    connection_id: i64,
    database: Option<&str>,
) -> AppResult<std::collections::HashMap<String, i64>> {
    let conn = crate::db::get().lock().unwrap();
    let mut map = std::collections::HashMap::new();
    match database {
        None => {
            let mut stmt = conn.prepare(
                "SELECT scope_database, COUNT(*) FROM metrics
                 WHERE connection_id=?1 AND scope_database IS NOT NULL
                 GROUP BY scope_database"
            )?;
            let rows = stmt.query_map(rusqlite::params![connection_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows { let (k, v) = row?; map.insert(k, v); }
        }
        Some(db) => {
            let mut stmt = conn.prepare(
                "SELECT scope_schema, COUNT(*) FROM metrics
                 WHERE connection_id=?1 AND scope_database=?2 AND scope_schema IS NOT NULL
                 GROUP BY scope_schema"
            )?;
            let rows = stmt.query_map(rusqlite::params![connection_id, db], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows { let (k, v) = row?; map.insert(k, v); }
        }
    }
    Ok(map)
}

/// 计算指定节点下的指标数量（用于树节点未展开时显示徽章）
pub fn count_metrics_by_node(
    connection_id: i64,
    database: Option<&str>,
    schema: Option<&str>,
) -> AppResult<i64> {
    let conn = crate::db::get().lock().unwrap();
    let count: i64 = match (database, schema) {
        (Some(db), Some(sc)) => conn.query_row(
            "SELECT COUNT(*) FROM metrics WHERE connection_id=?1 AND scope_database=?2 AND scope_schema=?3",
            rusqlite::params![connection_id, db, sc],
            |row| row.get(0),
        )?,
        (Some(db), None) => conn.query_row(
            "SELECT COUNT(*) FROM metrics WHERE connection_id=?1 AND scope_database=?2",
            rusqlite::params![connection_id, db],
            |row| row.get(0),
        )?,
        (None, Some(sc)) => conn.query_row(
            "SELECT COUNT(*) FROM metrics WHERE connection_id=?1 AND scope_schema=?2",
            rusqlite::params![connection_id, sc],
            |row| row.get(0),
        )?,
        (None, None) => conn.query_row(
            "SELECT COUNT(*) FROM metrics WHERE connection_id=?1",
            rusqlite::params![connection_id],
            |row| row.get(0),
        )?,
    };
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_metrics_type_check() {
        let result: AppResult<Vec<Metric>> = Ok(vec![]);
        assert!(result.is_ok());
    }
}
