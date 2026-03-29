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

// ─── Request Deduplication ──────────────────────────────────────────────────

static LAST_REQUEST: Lazy<Mutex<HashMap<i64, (String, Vec<String>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub async fn is_duplicate_request(
    connection_id: i64,
    sql_before: &str,
    mentioned: &[String],
) -> bool {
    let cache = LAST_REQUEST.lock().await;
    if let Some((prev_sql, prev_tables)) = cache.get(&connection_id) {
        prev_sql == sql_before && prev_tables.as_slice() == mentioned
    } else {
        false
    }
}

pub async fn update_last_request(
    connection_id: i64,
    sql_before: String,
    mentioned: Vec<String>,
) {
    let mut cache = LAST_REQUEST.lock().await;
    cache.insert(connection_id, (sql_before, mentioned));
}

// ─── postprocess_completion ─────────────────────────────────────────────────

pub fn postprocess_completion(raw: &str, sql_before: &str) -> String {
    let mut result = raw.to_string();

    // Step 1: Strip code block wrappers
    if result.starts_with("```") {
        // Remove opening fence (with optional language tag)
        if let Some(end) = result.find('\n') {
            result = result[end + 1..].to_string();
        }
        // Remove closing fence
        if let Some(pos) = result.rfind("```") {
            result = result[..pos].to_string();
        }
    }

    // Step 2: Remove duplicated prefix (overlap with last 50 chars of sql_before)
    let tail = if sql_before.len() > 50 {
        &sql_before[sql_before.len() - 50..]
    } else {
        sql_before
    };
    // Find the longest suffix of tail that is a prefix of result
    for i in 0..tail.len() {
        let suffix = &tail[i..];
        if result.starts_with(suffix) {
            result = result[suffix.len()..].to_string();
            break;
        }
    }

    // Step 3: Strip leading newlines
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
    let hot_tables_names: Vec<&str> = mentioned.iter().take(10).map(|s| s.as_str()).collect();
    let mut hot_details: Vec<(
        String,
        Option<String>,
        Vec<ColumnMeta>,
        Vec<ForeignKeyMeta>,
        Vec<IndexMeta>,
    )> = Vec::new();

    {
        let mut cache = META_CACHE.lock().await;
        let mc = cache.entry(connection_id).or_insert_with(MetaCache::new);

        for table_name in &hot_tables_names {
            let cols = match mc.get_columns(current_schema, table_name) {
                Some(c) => c.clone(),
                None => {
                    let c = ds
                        .get_columns(table_name, Some(current_schema))
                        .await
                        .unwrap_or_default();
                    mc.set_columns(current_schema, table_name, c.clone());
                    c
                }
            };
            let fks = ds
                .get_foreign_keys(table_name, Some(current_schema))
                .await
                .unwrap_or_default();
            let idxs = ds
                .get_indexes(table_name, Some(current_schema))
                .await
                .unwrap_or_default();
            hot_details.push((
                table_name.to_string(),
                Some(current_schema.to_string()),
                cols,
                fks,
                idxs,
            ));
        }
    }

    let hot_set: HashSet<String> = hot_details.iter().map(|(n, ..)| n.clone()).collect();

    // === Warm Zone ===
    let mut warm_details: Vec<(String, Option<String>, Vec<ColumnMeta>, String)> = Vec::new();

    if !mentioned.is_empty() {
        if let Ok(subgraph) = find_relevant_subgraph(connection_id, mentioned, 1).await {
            // Filter out hot tables, sort by max edge weight desc
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

            let mut cache = META_CACHE.lock().await;
            let mc = cache.entry(connection_id).or_insert_with(MetaCache::new);

            for (node, _weight) in warm_candidates.into_iter().take(15) {
                let schema_hint = node
                    .metadata
                    .as_ref()
                    .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
                    .and_then(|v| v.get("schema").and_then(|s| s.as_str().map(String::from)));
                let schema_ref = schema_hint.as_deref().unwrap_or(current_schema);

                let cols = match mc.get_columns(schema_ref, &node.name) {
                    Some(c) => c.clone(),
                    None => {
                        let c = ds
                            .get_columns(&node.name, Some(schema_ref))
                            .await
                            .unwrap_or_default();
                        mc.set_columns(schema_ref, &node.name, c.clone());
                        c
                    }
                };

                // Build a join path hint from edges
                let join_hint = subgraph
                    .edges
                    .iter()
                    .find(|e| e.from_node.contains(&node.name) || e.to_node.contains(&node.name))
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
                let t = ds.get_tables().await.unwrap_or_default();
                mc.set_tables(t.clone());
                t
            }
        }
    };

    let cold_tables: Vec<(String, Option<String>)> = all_tables
        .iter()
        .filter(|t| !hot_set.contains(&t.name) && !warm_set.contains(&t.name))
        .take(200)
        .map(|t| (t.name.clone(), t.schema.clone()))
        .collect();

    // === Assemble ===
    let hot_str = format_hot_zone(&hot_details, current_schema);
    let warm_str = format_warm_zone(&warm_details, current_schema);
    let cold_str = format_cold_zone(&cold_tables, current_schema);

    let mut result = format!("{}{}{}", hot_str, warm_str, cold_str);

    // Token budget: if result.len() / 4 > 4000, truncate
    if result.len() / 4 > 4000 {
        // Reduce cold to 50
        let cold_tables_reduced: Vec<(String, Option<String>)> = all_tables
            .iter()
            .filter(|t| !hot_set.contains(&t.name) && !warm_set.contains(&t.name))
            .take(50)
            .map(|t| (t.name.clone(), t.schema.clone()))
            .collect();
        let cold_str_reduced = format_cold_zone(&cold_tables_reduced, current_schema);
        result = format!("{}{}{}", hot_str, warm_str, cold_str_reduced);

        if result.len() / 4 > 4000 {
            // Reduce warm to 5
            let warm_reduced: Vec<_> = warm_details.into_iter().take(5).collect();
            let warm_str_reduced = format_warm_zone(&warm_reduced, current_schema);
            result = format!("{}{}{}", hot_str, warm_str_reduced, cold_str_reduced);
        }
    }

    result
}
