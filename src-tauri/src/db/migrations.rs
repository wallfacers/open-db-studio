use rusqlite::Connection;
use crate::AppResult;

pub fn run_migrations(conn: &Connection) -> AppResult<()> {
    let schema = include_str!("../../../schema/init.sql");
    conn.execute_batch(schema)?;
    log::info!("Database migrations completed");
    Ok(())
}
