use crate::AppResult;
use super::models::*;

// ─── helper: row → model mappers ────────────────────────────────────────────

fn row_to_project(row: &rusqlite::Row) -> rusqlite::Result<ErProject> {
    Ok(ErProject {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        connection_id: row.get(3)?,
        database_name: row.get(4)?,
        schema_name: row.get(5)?,
        viewport_x: row.get(6)?,
        viewport_y: row.get(7)?,
        viewport_zoom: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

const PROJECT_COLS: &str =
    "id, name, description, connection_id, database_name, schema_name, viewport_x, viewport_y, viewport_zoom, created_at, updated_at";

fn row_to_table(row: &rusqlite::Row) -> rusqlite::Result<ErTable> {
    Ok(ErTable {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        comment: row.get(3)?,
        position_x: row.get(4)?,
        position_y: row.get(5)?,
        color: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

const TABLE_COLS: &str =
    "id, project_id, name, comment, position_x, position_y, color, created_at, updated_at";

fn row_to_column(row: &rusqlite::Row) -> rusqlite::Result<ErColumn> {
    Ok(ErColumn {
        id: row.get(0)?,
        table_id: row.get(1)?,
        name: row.get(2)?,
        data_type: row.get(3)?,
        nullable: row.get(4)?,
        default_value: row.get(5)?,
        is_primary_key: row.get(6)?,
        is_auto_increment: row.get(7)?,
        comment: row.get(8)?,
        length: row.get(9)?,
        scale: row.get(10)?,
        is_unique: row.get(11)?,
        unsigned: row.get(12)?,
        charset: row.get(13)?,
        collation: row.get(14)?,
        on_update: row.get(15)?,
        enum_values: row.get(16)?,
        sort_order: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

const COLUMN_COLS: &str =
    "id, table_id, name, data_type, nullable, default_value, is_primary_key, is_auto_increment, comment, length, scale, is_unique, unsigned, charset, collation, on_update, enum_values, sort_order, created_at, updated_at";

fn row_to_relation(row: &rusqlite::Row) -> rusqlite::Result<ErRelation> {
    Ok(ErRelation {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        source_table_id: row.get(3)?,
        source_column_id: row.get(4)?,
        target_table_id: row.get(5)?,
        target_column_id: row.get(6)?,
        relation_type: row.get(7)?,
        on_delete: row.get(8)?,
        on_update: row.get(9)?,
        source: row.get(10)?,
        comment_marker: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

const RELATION_COLS: &str =
    "id, project_id, name, source_table_id, source_column_id, target_table_id, target_column_id, relation_type, on_delete, on_update, source, comment_marker, created_at, updated_at";

fn row_to_index(row: &rusqlite::Row) -> rusqlite::Result<ErIndex> {
    Ok(ErIndex {
        id: row.get(0)?,
        table_id: row.get(1)?,
        name: row.get(2)?,
        index_type: row.get(3)?,
        columns: row.get(4)?,
        created_at: row.get(5)?,
    })
}

const INDEX_COLS: &str = "id, table_id, name, type, columns, created_at";

// ─── Project CRUD ───────────────────────────────────────────────────────────

pub fn create_project(req: &CreateProjectRequest) -> AppResult<ErProject> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO er_projects (name, description, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![req.name, req.description, &now, &now],
    )?;

    let id = conn.last_insert_rowid();
    let result = conn.query_row(
        &format!("SELECT {} FROM er_projects WHERE id = ?1", PROJECT_COLS),
        [id],
        row_to_project,
    )?;
    Ok(result)
}

pub fn update_project(id: i64, req: &UpdateProjectRequest) -> AppResult<ErProject> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    let mut sets = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut idx = 1u32;

    macro_rules! maybe_set {
        ($field:expr, $col:expr) => {
            if let Some(val) = &$field {
                sets.push(format!("{} = ?{}", $col, idx));
                params.push(Box::new(val.clone()));
                idx += 1;
            }
        };
    }

    maybe_set!(req.name, "name");
    maybe_set!(req.description, "description");
    maybe_set!(req.viewport_x, "viewport_x");
    maybe_set!(req.viewport_y, "viewport_y");
    maybe_set!(req.viewport_zoom, "viewport_zoom");

    if sets.is_empty() {
        // Nothing to update, just refresh updated_at
        sets.push(format!("updated_at = ?{}", idx));
        params.push(Box::new(now.clone()));
    } else {
        sets.push(format!("updated_at = ?{}", idx));
        params.push(Box::new(now.clone()));
    }
    idx += 1;

    let sql = format!(
        "UPDATE er_projects SET {} WHERE id = ?{}",
        sets.join(", "),
        idx
    );
    params.push(Box::new(id));

    conn.execute(&sql, rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))?;

    let result = conn.query_row(
        &format!("SELECT {} FROM er_projects WHERE id = ?1", PROJECT_COLS),
        [id],
        row_to_project,
    )?;
    Ok(result)
}

pub fn delete_project(id: i64) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let affected = conn.execute("DELETE FROM er_projects WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(crate::AppError::Other(format!("ER project {} not found", id)));
    }
    Ok(())
}

pub fn list_projects() -> AppResult<Vec<ErProject>> {
    let conn = crate::db::get().lock().unwrap();
    let mut stmt = conn.prepare(
        &format!("SELECT {} FROM er_projects ORDER BY updated_at DESC", PROJECT_COLS),
    )?;
    let rows = stmt.query_map([], row_to_project)?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

pub fn get_project_full(id: i64) -> AppResult<ErProjectFull> {
    let conn = crate::db::get().lock().unwrap();

    // 1. Get project
    let project = conn.query_row(
        &format!("SELECT {} FROM er_projects WHERE id = ?1", PROJECT_COLS),
        [id],
        row_to_project,
    )?;

    // 2. Get all tables for this project
    let mut stmt = conn.prepare(
        &format!("SELECT {} FROM er_tables WHERE project_id = ?1 ORDER BY name", TABLE_COLS),
    )?;
    let tables: Vec<ErTable> = stmt
        .query_map([id], row_to_table)?
        .collect::<Result<Vec<_>, _>>()?;

    // 3. For each table, get columns and indexes
    let mut table_fulls = Vec::with_capacity(tables.len());
    for table in tables {
        let mut col_stmt = conn.prepare(
            &format!("SELECT {} FROM er_columns WHERE table_id = ?1 ORDER BY sort_order, id", COLUMN_COLS),
        )?;
        let columns: Vec<ErColumn> = col_stmt
            .query_map([table.id], row_to_column)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut idx_stmt = conn.prepare(
            &format!("SELECT {} FROM er_indexes WHERE table_id = ?1 ORDER BY name", INDEX_COLS),
        )?;
        let indexes: Vec<ErIndex> = idx_stmt
            .query_map([table.id], row_to_index)?
            .collect::<Result<Vec<_>, _>>()?;

        table_fulls.push(ErTableFull {
            table,
            columns,
            indexes,
        });
    }

    // 4. Get all relations for this project
    let mut rel_stmt = conn.prepare(
        &format!("SELECT {} FROM er_relations WHERE project_id = ?1", RELATION_COLS),
    )?;
    let relations: Vec<ErRelation> = rel_stmt
        .query_map([id], row_to_relation)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ErProjectFull {
        project,
        tables: table_fulls,
        relations,
    })
}

// ─── Table CRUD ─────────────────────────────────────────────────────────────

pub fn create_table(req: &CreateTableRequest) -> AppResult<ErTable> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO er_tables (project_id, name, comment, position_x, position_y, color, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            req.project_id,
            req.name,
            req.comment,
            req.position_x.unwrap_or(0.0),
            req.position_y.unwrap_or(0.0),
            req.color,
            &now,
            &now,
        ],
    )?;

    let id = conn.last_insert_rowid();
    let result = conn.query_row(
        &format!("SELECT {} FROM er_tables WHERE id = ?1", TABLE_COLS),
        [id],
        row_to_table,
    )?;
    Ok(result)
}

pub fn update_table(id: i64, req: &UpdateTableRequest) -> AppResult<ErTable> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    let mut sets = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut idx = 1u32;

    macro_rules! maybe_set {
        ($field:expr, $col:expr) => {
            if let Some(val) = &$field {
                sets.push(format!("{} = ?{}", $col, idx));
                params.push(Box::new(val.clone()));
                idx += 1;
            }
        };
    }

    maybe_set!(req.name, "name");
    maybe_set!(req.comment, "comment");
    maybe_set!(req.position_x, "position_x");
    maybe_set!(req.position_y, "position_y");
    maybe_set!(req.color, "color");

    sets.push(format!("updated_at = ?{}", idx));
    params.push(Box::new(now.clone()));
    idx += 1;

    let sql = format!(
        "UPDATE er_tables SET {} WHERE id = ?{}",
        sets.join(", "),
        idx
    );
    params.push(Box::new(id));

    conn.execute(&sql, rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))?;

    let result = conn.query_row(
        &format!("SELECT {} FROM er_tables WHERE id = ?1", TABLE_COLS),
        [id],
        row_to_table,
    )?;
    Ok(result)
}

pub fn delete_table(id: i64) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let affected = conn.execute("DELETE FROM er_tables WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(crate::AppError::Other(format!("ER table {} not found", id)));
    }
    Ok(())
}

// ─── Column CRUD ────────────────────────────────────────────────────────────

pub fn create_column(req: &CreateColumnRequest) -> AppResult<ErColumn> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    // If no sort_order given, put it at the end
    let sort_order = match req.sort_order {
        Some(o) => o,
        None => {
            let max: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) FROM er_columns WHERE table_id = ?1",
                    [req.table_id],
                    |r| r.get(0),
                )?;
            max + 1
        }
    };

    conn.execute(
        "INSERT INTO er_columns (table_id, name, data_type, nullable, default_value, is_primary_key, is_auto_increment, comment, length, scale, is_unique, unsigned, charset, collation, on_update, enum_values, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        rusqlite::params![
            req.table_id,
            req.name,
            req.data_type,
            req.nullable.unwrap_or(true),
            req.default_value,
            req.is_primary_key.unwrap_or(false),
            req.is_auto_increment.unwrap_or(false),
            req.comment,
            req.length,
            req.scale,
            req.is_unique.unwrap_or(false),
            req.unsigned.unwrap_or(false),
            req.charset,
            req.collation,
            req.on_update,
            req.enum_values,
            sort_order,
            &now,
            &now,
        ],
    )?;

    let id = conn.last_insert_rowid();
    let result = conn.query_row(
        &format!("SELECT {} FROM er_columns WHERE id = ?1", COLUMN_COLS),
        [id],
        row_to_column,
    )?;
    Ok(result)
}

pub fn update_column(id: i64, req: &UpdateColumnRequest) -> AppResult<ErColumn> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    let mut sets = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut idx = 1u32;

    macro_rules! maybe_set {
        ($field:expr, $col:expr) => {
            if let Some(val) = &$field {
                sets.push(format!("{} = ?{}", $col, idx));
                params.push(Box::new(val.clone()));
                idx += 1;
            }
        };
    }

    maybe_set!(req.name, "name");
    maybe_set!(req.data_type, "data_type");
    maybe_set!(req.nullable, "nullable");
    maybe_set!(req.default_value, "default_value");
    maybe_set!(req.is_primary_key, "is_primary_key");
    maybe_set!(req.is_auto_increment, "is_auto_increment");
    maybe_set!(req.comment, "comment");
    maybe_set!(req.length, "length");
    maybe_set!(req.scale, "scale");
    maybe_set!(req.is_unique, "is_unique");
    maybe_set!(req.unsigned, "unsigned");
    maybe_set!(req.charset, "charset");
    maybe_set!(req.collation, "collation");
    maybe_set!(req.on_update, "on_update");
    maybe_set!(req.enum_values, "enum_values");
    maybe_set!(req.sort_order, "sort_order");

    sets.push(format!("updated_at = ?{}", idx));
    params.push(Box::new(now.clone()));
    idx += 1;

    let sql = format!(
        "UPDATE er_columns SET {} WHERE id = ?{}",
        sets.join(", "),
        idx
    );
    params.push(Box::new(id));

    conn.execute(&sql, rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))?;

    let result = conn.query_row(
        &format!("SELECT {} FROM er_columns WHERE id = ?1", COLUMN_COLS),
        [id],
        row_to_column,
    )?;
    Ok(result)
}

pub fn delete_column(id: i64) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let affected = conn.execute("DELETE FROM er_columns WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(crate::AppError::Other(format!("ER column {} not found", id)));
    }
    Ok(())
}

pub fn reorder_columns(table_id: i64, column_ids: &[i64]) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    for (order, col_id) in column_ids.iter().enumerate() {
        conn.execute(
            "UPDATE er_columns SET sort_order = ?1, updated_at = ?2 WHERE id = ?3 AND table_id = ?4",
            rusqlite::params![order as i64, &now, col_id, table_id],
        )?;
    }
    Ok(())
}

// ─── Relation CRUD ──────────────────────────────────────────────────────────

pub fn create_relation(req: &CreateRelationRequest) -> AppResult<ErRelation> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO er_relations (project_id, name, source_table_id, source_column_id, target_table_id, target_column_id, relation_type, on_delete, on_update, source, comment_marker, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            req.project_id,
            req.name,
            req.source_table_id,
            req.source_column_id,
            req.target_table_id,
            req.target_column_id,
            req.relation_type.as_deref().unwrap_or("one_to_many"),
            req.on_delete.as_deref().unwrap_or("NO ACTION"),
            req.on_update.as_deref().unwrap_or("NO ACTION"),
            req.source.as_deref().unwrap_or("designer"),
            req.comment_marker,
            &now,
            &now,
        ],
    )?;

    let id = conn.last_insert_rowid();
    let result = conn.query_row(
        &format!("SELECT {} FROM er_relations WHERE id = ?1", RELATION_COLS),
        [id],
        row_to_relation,
    )?;
    Ok(result)
}

pub fn update_relation(id: i64, req: &UpdateRelationRequest) -> AppResult<ErRelation> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    let mut sets = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut idx = 1u32;

    macro_rules! maybe_set {
        ($field:expr, $col:expr) => {
            if let Some(val) = &$field {
                sets.push(format!("{} = ?{}", $col, idx));
                params.push(Box::new(val.clone()));
                idx += 1;
            }
        };
    }

    maybe_set!(req.name, "name");
    maybe_set!(req.relation_type, "relation_type");
    maybe_set!(req.on_delete, "on_delete");
    maybe_set!(req.on_update, "on_update");
    maybe_set!(req.source, "source");
    maybe_set!(req.comment_marker, "comment_marker");

    sets.push(format!("updated_at = ?{}", idx));
    params.push(Box::new(now.clone()));
    idx += 1;

    let sql = format!(
        "UPDATE er_relations SET {} WHERE id = ?{}",
        sets.join(", "),
        idx
    );
    params.push(Box::new(id));

    conn.execute(&sql, rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))?;

    let result = conn.query_row(
        &format!("SELECT {} FROM er_relations WHERE id = ?1", RELATION_COLS),
        [id],
        row_to_relation,
    )?;
    Ok(result)
}

pub fn delete_relation(id: i64) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    // 幂等删除：可能已被 ON DELETE CASCADE 级联删除，affected==0 不视为错误
    conn.execute("DELETE FROM er_relations WHERE id = ?1", [id])?;
    Ok(())
}

// ─── Index CRUD ─────────────────────────────────────────────────────────────

pub fn create_index(req: &CreateIndexRequest) -> AppResult<ErIndex> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO er_indexes (table_id, name, type, columns, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            req.table_id,
            req.name,
            req.index_type.as_deref().unwrap_or("INDEX"),
            req.columns,
            &now,
        ],
    )?;

    let id = conn.last_insert_rowid();
    let result = conn.query_row(
        &format!("SELECT {} FROM er_indexes WHERE id = ?1", INDEX_COLS),
        [id],
        row_to_index,
    )?;
    Ok(result)
}

pub fn update_index(id: i64, req: &UpdateIndexRequest) -> AppResult<ErIndex> {
    let conn = crate::db::get().lock().unwrap();

    let mut sets = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut idx = 1u32;

    macro_rules! maybe_set {
        ($field:expr, $col:expr) => {
            if let Some(val) = &$field {
                sets.push(format!("{} = ?{}", $col, idx));
                params.push(Box::new(val.clone()));
                idx += 1;
            }
        };
    }

    maybe_set!(req.name, "name");
    maybe_set!(req.index_type, "type");
    maybe_set!(req.columns, "columns");

    if sets.is_empty() {
        // Nothing to update
        let result = conn.query_row(
            &format!("SELECT {} FROM er_indexes WHERE id = ?1", INDEX_COLS),
            [id],
            row_to_index,
        )?;
        return Ok(result);
    }

    let sql = format!(
        "UPDATE er_indexes SET {} WHERE id = ?{}",
        sets.join(", "),
        idx
    );
    params.push(Box::new(id));

    conn.execute(&sql, rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))?;

    let result = conn.query_row(
        &format!("SELECT {} FROM er_indexes WHERE id = ?1", INDEX_COLS),
        [id],
        row_to_index,
    )?;
    Ok(result)
}

pub fn delete_index(id: i64) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let affected = conn.execute("DELETE FROM er_indexes WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(crate::AppError::Other(format!("ER index {} not found", id)));
    }
    Ok(())
}

// ─── Connection Binding ─────────────────────────────────────────────────────

pub fn bind_connection(project_id: i64, req: &BindConnectionRequest) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    let affected = conn.execute(
        "UPDATE er_projects SET connection_id = ?1, database_name = ?2, schema_name = ?3, updated_at = ?4 WHERE id = ?5",
        rusqlite::params![req.connection_id, req.database_name, req.schema_name, &now, project_id],
    )?;

    if affected == 0 {
        return Err(crate::AppError::Other(format!("ER project {} not found", project_id)));
    }
    Ok(())
}

pub fn unbind_connection(project_id: i64) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    let affected = conn.execute(
        "UPDATE er_projects SET connection_id = NULL, database_name = NULL, schema_name = NULL, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![&now, project_id],
    )?;

    if affected == 0 {
        return Err(crate::AppError::Other(format!("ER project {} not found", project_id)));
    }
    Ok(())
}
