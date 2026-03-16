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
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateMetricInput {
    pub connection_id: i64,
    pub name: String,
    pub display_name: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub aggregation: Option<String>,
    pub filter_sql: Option<String>,
    pub description: Option<String>,
    pub source: Option<String>,
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
}

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
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

const SELECT_COLS: &str =
    "id,connection_id,name,display_name,table_name,column_name,aggregation,\
     filter_sql,description,status,source,created_at,updated_at";

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
    conn.execute(
        "INSERT INTO metrics (connection_id,name,display_name,table_name,column_name,
                              aggregation,filter_sql,description,source)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![
            input.connection_id, input.name, input.display_name, input.table_name,
            input.column_name, input.aggregation, input.filter_sql, input.description, source
        ],
    )?;
    let id = conn.last_insert_rowid();
    get_metric_by_id(&conn, id)
}

pub fn update_metric(id: i64, input: &UpdateMetricInput) -> AppResult<Metric> {
    let conn = crate::db::get().lock().unwrap();
    conn.execute(
        "UPDATE metrics SET
            name=COALESCE(?2,name), display_name=COALESCE(?3,display_name),
            table_name=COALESCE(?4,table_name), column_name=COALESCE(?5,column_name),
            aggregation=COALESCE(?6,aggregation), filter_sql=COALESCE(?7,filter_sql),
            description=COALESCE(?8,description),
            updated_at=datetime('now')
         WHERE id=?1",
        rusqlite::params![
            id, input.name, input.display_name, input.table_name,
            input.column_name, input.aggregation, input.filter_sql, input.description
        ],
    )?;
    get_metric_by_id(&conn, id)
}

pub fn delete_metric(id: i64) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
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
    let conn = crate::db::get().lock().unwrap();
    let pattern = format!("%{}%", keywords.join("%"));
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM metrics WHERE connection_id=?1 AND status='approved'
           AND (name LIKE ?2 OR display_name LIKE ?2 OR description LIKE ?2)
         ORDER BY name",
        SELECT_COLS
    ))?;
    let rows = stmt.query_map(rusqlite::params![connection_id, pattern], row_to_metric)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
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
