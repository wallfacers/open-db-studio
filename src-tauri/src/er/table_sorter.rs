use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

use super::models::{ErRelation, ErTable};

/// Topological sort result for table creation ordering.
///
/// `sorted_table_ids` contains all tables in creation order.
/// Tables in dependency cycles are appended at the end in ID order;
/// their FK constraints must be added via ALTER TABLE after all tables exist.
#[derive(Debug, Clone)]
pub struct SortResult {
    pub sorted_table_ids: Vec<i64>,
    pub cycle_tables: HashSet<i64>,
    pub self_referencing_tables: HashSet<i64>,
}

impl SortResult {
    pub fn has_cycle(&self) -> bool {
        !self.cycle_tables.is_empty()
    }

    /// Returns relation IDs whose FK constraints must be deferred:
    /// self-referencing FKs and FKs between tables in a dependency cycle.
    pub fn delayed_relation_ids(&self, relations: &[ErRelation]) -> HashSet<i64> {
        relations
            .iter()
            .filter(|r| {
                self.self_referencing_tables.contains(&r.source_table_id)
                    || (self.cycle_tables.contains(&r.source_table_id)
                        && self.cycle_tables.contains(&r.target_table_id)
                        && r.source_table_id != r.target_table_id)
            })
            .map(|r| r.id)
            .collect()
    }
}

/// Build a dependency graph from FK relations and return tables in creation order.
pub fn sort_tables_by_dependency(
    tables: &[ErTable],
    relations: &[ErRelation],
    table_ids_to_include: Option<&HashSet<i64>>,
) -> SortResult {
    let table_ids: HashSet<i64> = match table_ids_to_include {
        Some(ids) => ids.clone(),
        None => tables.iter().map(|t| t.id).collect(),
    };

    let self_refs: HashSet<i64> = relations
        .iter()
        .filter(|r| {
            table_ids.contains(&r.source_table_id) && r.source_table_id == r.target_table_id
        })
        .map(|r| r.source_table_id)
        .collect();

    // in_degree[X] = number of tables X depends on (must be created before X)
    let mut in_degree: HashMap<i64, usize> = table_ids.iter().map(|&id| (id, 0)).collect();
    // dependents[X] = tables that depend on X (can be created after X)
    let mut dependents: HashMap<i64, HashSet<i64>> =
        table_ids.iter().map(|&id| (id, HashSet::new())).collect();

    for rel in relations {
        if !table_ids.contains(&rel.source_table_id) || !table_ids.contains(&rel.target_table_id) {
            continue;
        }
        if rel.source_table_id == rel.target_table_id {
            continue;
        }
        // source depends on target (target must be created first)
        *in_degree.get_mut(&rel.source_table_id).unwrap() += 1;
        dependents
            .get_mut(&rel.target_table_id)
            .unwrap()
            .insert(rel.source_table_id);
    }

    // Kahn's algorithm with min-heap for deterministic ordering by ID
    let mut heap: BinaryHeap<Reverse<i64>> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(&id, _)| Reverse(id))
        .collect();

    let mut sorted: Vec<i64> = Vec::with_capacity(table_ids.len());

    while let Some(Reverse(id)) = heap.pop() {
        sorted.push(id);
        if let Some(deps) = dependents.get(&id) {
            for &dep_id in deps {
                let deg = in_degree.get_mut(&dep_id).unwrap();
                *deg -= 1;
                if *deg == 0 {
                    heap.push(Reverse(dep_id));
                }
            }
        }
    }

    // Nodes with remaining in_degree > 0 are in dependency cycles
    let cycle_tables: HashSet<i64> = in_degree
        .iter()
        .filter(|(_, &deg)| deg > 0)
        .map(|(&id, _)| id)
        .collect();

    // Append cycle tables in ID order; their FKs need ALTER TABLE after creation
    if !cycle_tables.is_empty() {
        let mut remaining: Vec<i64> = cycle_tables.iter().copied().collect();
        remaining.sort();
        sorted.extend(remaining);
    }

    SortResult {
        sorted_table_ids: sorted,
        cycle_tables,
        self_referencing_tables: self_refs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_table(id: i64, name: &str) -> ErTable {
        ErTable {
            id,
            project_id: 1,
            name: name.to_string(),
            comment: None,
            position_x: 0.0,
            position_y: 0.0,
            color: None,
            constraint_method: None,
            comment_format: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn make_relation(id: i64, source_table: i64, target_table: i64) -> ErRelation {
        ErRelation {
            id,
            project_id: 1,
            name: Some(format!("fk_{}", id)),
            source_table_id: source_table,
            source_column_id: source_table * 10 + 1,
            target_table_id: target_table,
            target_column_id: target_table * 10,
            relation_type: "many-to-one".to_string(),
            on_delete: "NO ACTION".to_string(),
            on_update: "NO ACTION".to_string(),
            source: "manual".to_string(),
            comment_marker: None,
            constraint_method: None,
            comment_format: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn test_simple_dependency() {
        let tables = vec![make_table(1, "orders"), make_table(2, "users")];
        let relations = vec![make_relation(1, 1, 2)];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle());
        assert_eq!(result.sorted_table_ids, vec![2, 1]);
    }

    #[test]
    fn test_chain_dependency() {
        let tables = vec![
            make_table(1, "A"),
            make_table(2, "B"),
            make_table(3, "C"),
            make_table(4, "D"),
        ];
        let relations = vec![
            make_relation(1, 1, 2),
            make_relation(2, 2, 3),
            make_relation(3, 3, 4),
        ];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle());
        assert_eq!(result.sorted_table_ids, vec![4, 3, 2, 1]);
    }

    #[test]
    fn test_self_reference() {
        let tables = vec![make_table(1, "categories")];
        let relations = vec![make_relation(1, 1, 1)];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle());
        assert!(result.self_referencing_tables.contains(&1));
        assert_eq!(result.sorted_table_ids, vec![1]);
    }

    #[test]
    fn test_circular_dependency() {
        let tables = vec![
            make_table(1, "A"),
            make_table(2, "B"),
            make_table(3, "C"),
        ];
        let relations = vec![
            make_relation(1, 1, 2),
            make_relation(2, 2, 3),
            make_relation(3, 3, 1),
        ];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(result.has_cycle());
        assert!(result.cycle_tables.contains(&1));
        assert!(result.cycle_tables.contains(&2));
        assert!(result.cycle_tables.contains(&3));
        assert_eq!(result.sorted_table_ids.len(), 3);
    }

    #[test]
    fn test_multiple_dependencies() {
        let tables = vec![
            make_table(1, "A"),
            make_table(2, "B"),
            make_table(3, "C"),
            make_table(4, "D"),
        ];
        let relations = vec![
            make_relation(1, 1, 2),
            make_relation(2, 1, 3),
            make_relation(3, 2, 4),
            make_relation(4, 3, 4),
        ];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle());
        assert_eq!(result.sorted_table_ids.first(), Some(&4));
        assert_eq!(result.sorted_table_ids.last(), Some(&1));
    }

    #[test]
    fn test_independent_tables() {
        let tables = vec![
            make_table(1, "logs"),
            make_table(2, "settings"),
            make_table(3, "cache"),
        ];
        let relations = vec![];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle());
        assert_eq!(result.sorted_table_ids, vec![1, 2, 3]);
    }

    #[test]
    fn test_partial_sort_subset() {
        let tables = vec![
            make_table(1, "users"),
            make_table(2, "orders"),
            make_table(3, "products"),
            make_table(4, "reviews"),
        ];
        let relations = vec![
            make_relation(1, 2, 1),
            make_relation(2, 4, 2),
            make_relation(3, 4, 3),
        ];

        let subset: HashSet<i64> = HashSet::from([2, 4]);
        let result = sort_tables_by_dependency(&tables, &relations, Some(&subset));

        assert!(!result.has_cycle());
        let order_pos = result.sorted_table_ids.iter().position(|id| *id == 2).unwrap();
        let review_pos = result.sorted_table_ids.iter().position(|id| *id == 4).unwrap();
        assert!(order_pos < review_pos);
    }

    #[test]
    fn test_delayed_relation_ids_method() {
        let tables = vec![
            make_table(1, "A"),
            make_table(2, "B"),
            make_table(3, "C"),
        ];
        let relations = vec![
            make_relation(1, 1, 1), // self-ref
            make_relation(2, 1, 2), // in cycle
            make_relation(3, 2, 3), // in cycle
            make_relation(4, 3, 1), // in cycle
        ];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(result.has_cycle());
        let delayed = result.delayed_relation_ids(&relations);
        assert!(delayed.contains(&1));
        assert!(delayed.contains(&2));
        assert!(delayed.contains(&3));
        assert!(delayed.contains(&4));
    }

    #[test]
    fn test_mixed_self_ref_and_normal() {
        let tables = vec![make_table(1, "users"), make_table(2, "orders")];
        let relations = vec![
            make_relation(1, 1, 1),
            make_relation(2, 2, 1),
        ];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle());
        assert!(result.self_referencing_tables.contains(&1));
        assert_eq!(result.sorted_table_ids, vec![1, 2]);
    }
}
