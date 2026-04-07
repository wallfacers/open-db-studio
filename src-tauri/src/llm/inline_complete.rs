use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use once_cell::sync::Lazy;
use crate::datasource::{DataSource, TableMeta, ColumnMeta, ForeignKeyMeta, IndexMeta};
use crate::graph::query::find_relevant_subgraph;

// ─── MetaCache ───────────────────────────────────────────────────────────────

static META_CACHE: Lazy<Mutex<HashMap<i64, MetaCache>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

struct MetaCache {
    tables: Option<(Vec<TableMeta>, Instant)>,
    columns: HashMap<(String, String), (Vec<ColumnMeta>, Instant)>, // (schema, table) -> columns
    ttl: Duration,
}

impl MetaCache {
    fn new() -> Self {
        Self {
            tables: None,
            columns: HashMap::new(),
            ttl: Duration::from_secs(30),
        }
    }

    fn get_tables(&self) -> Option<&Vec<TableMeta>> {
        self.tables
            .as_ref()
            .and_then(|(t, ts)| if ts.elapsed() < self.ttl { Some(t) } else { None })
    }

    fn set_tables(&mut self, tables: Vec<TableMeta>) {
        self.tables = Some((tables, Instant::now()));
    }

    fn get_columns(&self, schema: &str, table: &str) -> Option<&Vec<ColumnMeta>> {
        self.columns
            .get(&(schema.to_string(), table.to_string()))
            .and_then(|(c, ts)| if ts.elapsed() < self.ttl { Some(c) } else { None })
    }

    fn set_columns(&mut self, schema: &str, table: &str, cols: Vec<ColumnMeta>) {
        self.columns
            .insert((schema.to_string(), table.to_string()), (cols, Instant::now()));
    }
}

pub async fn invalidate_meta_cache(connection_id: i64) {
    let mut cache = META_CACHE.lock().await;
    cache.remove(&connection_id);
}

// ─── TimeoutTracker ──────────────────────────────────────────────────────────

static TIMEOUT_TRACKERS: Lazy<Mutex<HashMap<i64, TimeoutTracker>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Default)]
struct TimeoutTracker {
    consecutive_timeouts: u32,
    paused_until: Option<Instant>,
}

impl TimeoutTracker {
    fn should_skip(&self) -> bool {
        if let Some(until) = self.paused_until {
            Instant::now() < until
        } else {
            false
        }
    }

    fn record_timeout(&mut self) {
        self.consecutive_timeouts += 1;
        if self.consecutive_timeouts >= 3 {
            // Pause for 60 seconds after 3 consecutive timeouts
            self.paused_until = Some(Instant::now() + Duration::from_secs(60));
        }
    }

    fn record_success(&mut self) {
        self.consecutive_timeouts = 0;
        self.paused_until = None;
    }
}

pub async fn invalidate_timeout_tracker(connection_id: i64) {
    let mut trackers = TIMEOUT_TRACKERS.lock().await;
    trackers.remove(&connection_id);
}

pub async fn should_skip(connection_id: i64) -> bool {
    let trackers = TIMEOUT_TRACKERS.lock().await;
    trackers
        .get(&connection_id)
        .map_or(false, |t| t.should_skip())
}

pub async fn record_timeout(connection_id: i64) {
    let mut trackers = TIMEOUT_TRACKERS.lock().await;
    trackers
        .entry(connection_id)
        .or_default()
        .record_timeout();
}

pub async fn record_success(connection_id: i64) {
    let mut trackers = TIMEOUT_TRACKERS.lock().await;
    trackers
        .entry(connection_id)
        .or_default()
        .record_success();
}

// ─── Concurrency Guard ──────────────────────────────────────────────────────

static IN_FLIGHT: Lazy<Mutex<HashSet<i64>>> = Lazy::new(|| Mutex::new(HashSet::new()));

pub async fn acquire_slot(connection_id: i64) -> bool {
    let mut set = IN_FLIGHT.lock().await;
    set.insert(connection_id) // returns false if already present
}

pub async fn release_slot(connection_id: i64) {
    let mut set = IN_FLIGHT.lock().await;
    set.remove(&connection_id);
}

// ─── Request Deduplication (with result cache) ─────────────────────────────

/// (sql_before, mentioned_tables, last_result)
static LAST_REQUEST: Lazy<Mutex<HashMap<i64, (String, Vec<String>, String)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 检查是否为重复请求。如果是，直接返回上一次的缓存结果。
pub async fn check_duplicate_request(
    connection_id: i64,
    sql_before: &str,
    mentioned: &[String],
) -> Option<String> {
    let cache = LAST_REQUEST.lock().await;
    if let Some((prev_sql, prev_tables, prev_result)) = cache.get(&connection_id) {
        if prev_sql == sql_before && prev_tables.as_slice() == mentioned {
            return Some(prev_result.clone());
        }
    }
    None
}

pub async fn update_last_request(
    connection_id: i64,
    sql_before: String,
    mentioned: Vec<String>,
    result: String,
) {
    let mut cache = LAST_REQUEST.lock().await;
    cache.insert(connection_id, (sql_before, mentioned, result));
}

// ─── postprocess_completion ─────────────────────────────────────────────────

pub fn postprocess_completion(raw: &str, sql_before: &str, sql_after: &str) -> String {
    let mut result = raw.to_string();

    // LLMs sometimes wrap output in markdown code blocks
    if result.starts_with("```") {
        if let Some(end) = result.find('\n') {
            result = result[end + 1..].to_string();
        }
        if let Some(pos) = result.rfind("```") {
            result = result[..pos].to_string();
        }
    }

    // Remove overlap where LLM repeats the end of sql_before (prefix dedup)
    const OVERLAP_WINDOW: usize = 50;
    let tail = if sql_before.len() > OVERLAP_WINDOW {
        let mut start = sql_before.len() - OVERLAP_WINDOW;
        while !sql_before.is_char_boundary(start) { start += 1; }
        &sql_before[start..]
    } else {
        sql_before
    };
    for i in 0..tail.len() {
        if !tail.is_char_boundary(i) { continue; }
        let suffix = &tail[i..];
        if result.starts_with(suffix) {
            result = result[suffix.len()..].to_string();
            break;
        }
    }

    // Remove overlap where LLM included what's already after the cursor (suffix dedup)
    if !sql_after.is_empty() {
        let head = if sql_after.len() > OVERLAP_WINDOW {
            let mut end = OVERLAP_WINDOW;
            while !sql_after.is_char_boundary(end) { end -= 1; }
            &sql_after[..end]
        } else {
            sql_after
        };
        // Find longest suffix of result that matches a prefix of sql_after
        let result_chars_len = result.char_indices().count();
        let _ = result_chars_len; // may use later
        for i in (0..head.len()).rev() {
            if !head.is_char_boundary(i) { continue; }
            let prefix = &head[..i];
            if prefix.is_empty() { continue; }
            if result.ends_with(prefix) {
                result = result[..result.len() - prefix.len()].to_string();
                break;
            }
        }
    }

    result = result.trim_start_matches('\n').to_string();
    result
}

// ─── Format Functions ───────────────────────────────────────────────────────

fn format_hot_zone(
    tables: &[(String, Option<String>, Vec<ColumnMeta>, Vec<ForeignKeyMeta>, Vec<IndexMeta>)],
    current_schema: &str,
) -> String {
    if tables.is_empty() {
        return String::new();
    }
    let mut out = String::from("-- [ACTIVE TABLES]\n");
    for (name, schema, cols, fks, idxs) in tables {
        let display = if schema.as_deref().unwrap_or(current_schema) != current_schema {
            format!("{}.{}", schema.as_deref().unwrap_or(""), name)
        } else {
            name.clone()
        };
        out.push_str(&format!(
            "-- {} (schema: {})\n",
            display,
            schema.as_deref().unwrap_or(current_schema)
        ));
        for col in cols {
            let mut parts = vec![format!("{}:", col.name), col.data_type.clone()];
            if col.is_primary_key {
                parts.push("(PK)".to_string());
            }
            // Check if this column has FK
            if let Some(fk) = fks.iter().find(|f| f.column == col.name) {
                parts.push(format!(
                    "(FK -> {}.{})",
                    fk.referenced_table, fk.referenced_column
                ));
            }
            if let Some(def) = &col.column_default {
                parts.push(format!("DEFAULT {}", def));
            }
            let mut line = format!("--   {}", parts.join(" "));
            if let Some(comment) = &col.comment {
                if !comment.is_empty() {
                    line.push_str(&format!(" -- {}", comment));
                }
            }
            out.push_str(&line);
            out.push('\n');
        }
        // Indexes
        for idx in idxs {
            let unique = if idx.is_unique { ", UNIQUE" } else { "" };
            out.push_str(&format!(
                "--   Indexes: {} ({}{})\n",
                idx.index_name,
                idx.columns.join(", "),
                unique
            ));
        }
    }
    out
}

fn format_warm_zone(
    tables: &[(String, Option<String>, Vec<ColumnMeta>, String)], // name, schema, cols, join_path_hint
    current_schema: &str,
) -> String {
    if tables.is_empty() {
        return String::new();
    }
    let mut out = String::from("-- [RELATED TABLES]\n");
    for (name, schema, cols, join_hint) in tables {
        let display = if schema.as_deref().unwrap_or(current_schema) != current_schema {
            format!("{}.{}", schema.as_deref().unwrap_or(""), name)
        } else {
            name.clone()
        };
        out.push_str(&format!("-- {} ({})\n", display, join_hint));
        for col in cols {
            let mut parts = vec![format!("{}:", col.name), col.data_type.clone()];
            if col.is_primary_key {
                parts.push("(PK)".to_string());
            }
            out.push_str(&format!("--   {}\n", parts.join(" ")));
        }
    }
    out
}

fn format_cold_zone(
    tables: &[(String, Option<String>)], // name, schema
    current_schema: &str,
) -> String {
    if tables.is_empty() {
        return String::new();
    }
    let mut out = String::from("-- [OTHER TABLES]\n-- ");
    let names: Vec<String> = tables
        .iter()
        .map(|(name, schema)| {
            if schema.as_deref().unwrap_or(current_schema) != current_schema {
                format!("{}.{}", schema.as_deref().unwrap_or(""), name)
            } else {
                name.clone()
            }
        })
        .collect();
    out.push_str(&names.join(", "));
    out.push('\n');
    out
}

// ─── build_layered_context ──────────────────────────────────────────────────

pub async fn build_layered_context(
    ds: &dyn DataSource,
    mentioned: &[String],
    current_schema: &str,
    connection_id: i64,
) -> String {
    // === Hot Zone ===
    // Check cache first (short lock), then fetch missing data outside the lock
    let hot_tables_names: Vec<&str> = mentioned.iter().take(10).map(|s| s.as_str()).collect();
    let mut hot_details: Vec<(
        String,
        Option<String>,
        Vec<ColumnMeta>,
        Vec<ForeignKeyMeta>,
        Vec<IndexMeta>,
    )> = Vec::new();

    // Phase 1: check cache for columns
    let mut hot_cache_misses: Vec<&str> = Vec::new();
    let mut hot_cached_cols: HashMap<String, Vec<ColumnMeta>> = HashMap::new();
    {
        let cache = META_CACHE.lock().await;
        if let Some(mc) = cache.get(&connection_id) {
            for &table_name in &hot_tables_names {
                match mc.get_columns(current_schema, table_name) {
                    Some(c) => { hot_cached_cols.insert(table_name.to_string(), c.clone()); }
                    None => { hot_cache_misses.push(table_name); }
                }
            }
        } else {
            hot_cache_misses.extend_from_slice(&hot_tables_names);
        }
    } // lock released

    // Phase 2: fetch missing data without holding the lock
    let mut hot_fetched_cols: HashMap<String, Vec<ColumnMeta>> = HashMap::new();
    for table_name in &hot_cache_misses {
        let c = ds.get_columns(table_name, Some(current_schema)).await.unwrap_or_default();
        hot_fetched_cols.insert(table_name.to_string(), c);
    }

    // Phase 3: update cache with fetched data
    if !hot_fetched_cols.is_empty() {
        let mut cache = META_CACHE.lock().await;
        let mc = cache.entry(connection_id).or_insert_with(MetaCache::new);
        for (name, cols) in &hot_fetched_cols {
            mc.set_columns(current_schema, name, cols.clone());
        }
    }

    // Phase 4: assemble hot details (FKs and indexes are not cached)
    for &table_name in &hot_tables_names {
        let cols = hot_cached_cols.get(table_name)
            .or_else(|| hot_fetched_cols.get(table_name))
            .cloned()
            .unwrap_or_default();
        let fks = ds.get_foreign_keys(table_name, Some(current_schema)).await.unwrap_or_default();
        let idxs = ds.get_indexes(table_name, Some(current_schema)).await.unwrap_or_default();
        hot_details.push((
            table_name.to_string(),
            Some(current_schema.to_string()),
            cols, fks, idxs,
        ));
    }

    let hot_set: HashSet<String> = hot_details.iter().map(|(n, ..)| n.clone()).collect();

    // === Warm Zone ===
    let mut warm_details: Vec<(String, Option<String>, Vec<ColumnMeta>, String)> = Vec::new();

    if !mentioned.is_empty() {
        if let Ok(subgraph) = find_relevant_subgraph(connection_id, mentioned, 1).await {
            let mut warm_candidates: Vec<(&crate::graph::query::GraphNode, f64)> = subgraph
                .nodes
                .iter()
                .filter(|n| n.node_type == "table" && !hot_set.contains(&n.name))
                .map(|n| {
                    let max_weight = subgraph
                        .edges
                        .iter()
                        .filter(|e| e.from_node == n.id || e.to_node == n.id)
                        .map(|e| e.weight)
                        .fold(0.0f64, f64::max);
                    (n, max_weight)
                })
                .collect();
            warm_candidates
                .sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

            // Collect warm table info: check cache, then fetch outside lock
            let warm_selected: Vec<_> = warm_candidates.into_iter().take(15).collect();
            let warm_schema_hints: Vec<Option<String>> = warm_selected
                .iter()
                .map(|(node, _)| {
                    node.metadata.as_ref()
                        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
                        .and_then(|v| v.get("schema").and_then(|s| s.as_str().map(String::from)))
                })
                .collect();
            let mut warm_cache_misses: Vec<(String, String)> = Vec::new(); // (schema, name)
            let mut warm_cached_cols: HashMap<String, Vec<ColumnMeta>> = HashMap::new();
            {
                let cache = META_CACHE.lock().await;
                if let Some(mc) = cache.get(&connection_id) {
                    for ((node, _), schema_hint) in warm_selected.iter().zip(&warm_schema_hints) {
                        let schema_ref = schema_hint.as_deref().unwrap_or(current_schema);
                        match mc.get_columns(schema_ref, &node.name) {
                            Some(c) => { warm_cached_cols.insert(node.name.clone(), c.clone()); }
                            None => { warm_cache_misses.push((schema_ref.to_string(), node.name.clone())); }
                        }
                    }
                } else {
                    for ((node, _), schema_hint) in warm_selected.iter().zip(&warm_schema_hints) {
                        let schema_ref = schema_hint.as_deref().unwrap_or(current_schema);
                        warm_cache_misses.push((schema_ref.to_string(), node.name.clone()));
                    }
                }
            } // lock released

            // Fetch missing warm columns
            let mut warm_fetched_cols: HashMap<String, Vec<ColumnMeta>> = HashMap::new();
            for (schema_ref, name) in &warm_cache_misses {
                let c = ds.get_columns(name, Some(schema_ref)).await.unwrap_or_default();
                warm_fetched_cols.insert(name.clone(), c);
            }

            // Update cache
            if !warm_fetched_cols.is_empty() {
                let mut cache = META_CACHE.lock().await;
                let mc = cache.entry(connection_id).or_insert_with(MetaCache::new);
                for (schema_ref, name) in &warm_cache_misses {
                    if let Some(cols) = warm_fetched_cols.get(name) {
                        mc.set_columns(schema_ref, name, cols.clone());
                    }
                }
            }

            // Assemble warm details
            for ((node, _weight), schema_hint) in warm_selected.iter().zip(warm_schema_hints) {
                let cols = warm_cached_cols.get(&node.name)
                    .or_else(|| warm_fetched_cols.get(&node.name))
                    .cloned()
                    .unwrap_or_default();

                // Use node.id for exact matching instead of contains()
                let join_hint = subgraph
                    .edges
                    .iter()
                    .find(|e| e.from_node == node.id || e.to_node == node.id)
                    .map(|e| format!("related via {}", e.edge_type))
                    .unwrap_or_else(|| "related".to_string());

                warm_details.push((node.name.clone(), schema_hint, cols, join_hint));
            }
        }
    }

    let warm_set: HashSet<String> = warm_details.iter().map(|(n, ..)| n.clone()).collect();

    // === Cold Zone ===
    let all_tables = {
        let mut cache = META_CACHE.lock().await;
        let mc = cache.entry(connection_id).or_insert_with(MetaCache::new);
        match mc.get_tables() {
            Some(t) => t.clone(),
            None => {
                drop(cache); // release lock before await
                let t = ds.get_tables().await.unwrap_or_default();
                let mut cache = META_CACHE.lock().await;
                let mc = cache.entry(connection_id).or_insert_with(MetaCache::new);
                mc.set_tables(t.clone());
                t
            }
        }
    };

    // === Assemble with progressive truncation ===
    let hot_str = format_hot_zone(&hot_details, current_schema);
    let warm_str = format_warm_zone(&warm_details, current_schema);
    let hot_warm_len = hot_str.len() + warm_str.len();

    // Start with full cold, reduce if over token budget (4000 tokens ≈ 16000 chars)
    const TOKEN_BUDGET_CHARS: usize = 16000;
    let cold_limit = if hot_warm_len / 4 > TOKEN_BUDGET_CHARS / 4 { 50 } else { 200 };
    let cold_tables: Vec<(String, Option<String>)> = all_tables
        .iter()
        .filter(|t| !hot_set.contains(&t.name) && !warm_set.contains(&t.name))
        .take(cold_limit)
        .map(|t| (t.name.clone(), t.schema.clone()))
        .collect();
    let cold_str = format_cold_zone(&cold_tables, current_schema);

    let mut result = format!("{}{}{}", hot_str, warm_str, cold_str);

    // Further truncation if still over budget
    if result.len() / 4 > 4000 {
        let cold_str_reduced = format_cold_zone(
            &cold_tables.iter().take(50).cloned().collect::<Vec<_>>(),
            current_schema,
        );
        result = format!("{}{}{}", hot_str, warm_str, cold_str_reduced);

        if result.len() / 4 > 4000 {
            let warm_reduced: Vec<_> = warm_details.into_iter().take(5).collect();
            let warm_str_reduced = format_warm_zone(&warm_reduced, current_schema);
            result = format!("{}{}{}", hot_str, warm_str_reduced, cold_str_reduced);
        }
    }

    result
}
