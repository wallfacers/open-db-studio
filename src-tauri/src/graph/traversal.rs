use crate::AppResult;

pub fn find_join_paths(
    connection_id: i64,
    from_node_ids: &[String],
    max_hops: u8,
) -> AppResult<Vec<Vec<String>>> {
    let _ = (connection_id, from_node_ids, max_hops);
    Ok(vec![])
}
