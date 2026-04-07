use std::collections::{HashMap, HashSet, VecDeque};

use super::models::{ErRelation, ErTable};

/// 排序结果
#[derive(Debug, Clone)]
pub struct SortResult {
    /// 拓扑排序后的表 ID 序列
    pub sorted_table_ids: Vec<i64>,
    /// 是否存在循环依赖
    pub has_cycle: bool,
    /// 循环依赖涉及的表 ID（如果存在循环）
    pub cycle_tables: HashSet<i64>,
    /// 自引用的表 ID（这些表的外键需要延迟创建）
    pub self_referencing_tables: HashSet<i64>,
}

/// 构建依赖图并执行拓扑排序
///
/// # Arguments
/// * `tables` - 所有表列表
/// * `relations` - 所有关系列表
/// * `table_ids_to_include` - 可选：只排序指定的表（用于部分表同步场景）
///
/// # Returns
/// * `SortResult` - 包含排序结果、循环依赖信息、自引用信息
pub fn sort_tables_by_dependency(
    tables: &[ErTable],
    relations: &[ErRelation],
    table_ids_to_include: Option<&HashSet<i64>>,
) -> SortResult {
    // 1. 确定要处理的表 ID 集合
    let table_ids: HashSet<i64> = match table_ids_to_include {
        Some(ids) => ids.clone(),
        None => tables.iter().map(|t| t.id).collect(),
    };

    // 2. 检测自引用
    let self_refs: HashSet<i64> = relations
        .iter()
        .filter(|r| {
            table_ids.contains(&r.source_table_id) && r.source_table_id == r.target_table_id
        })
        .map(|r| r.source_table_id)
        .collect();

    // 3. 构建依赖图（排除自引用边）
    let graph = build_dependency_graph(&table_ids, relations);

    // 4. 执行拓扑排序
    let (sorted, cycle_tables) = kahn_topological_sort(&graph);

    SortResult {
        sorted_table_ids: sorted,
        has_cycle: !cycle_tables.is_empty(),
        cycle_tables,
        self_referencing_tables: self_refs,
    }
}

/// 依赖图节点
struct Node {
    /// 此表依赖的其他表（入边，即 target_table_ids）
    dependencies: HashSet<i64>,
    /// 依赖此表的其他表（出边，即 source_table_ids）
    dependents: HashSet<i64>,
}

/// 构建依赖图
fn build_dependency_graph(table_ids: &HashSet<i64>, relations: &[ErRelation]) -> HashMap<i64, Node> {
    let mut graph: HashMap<i64, Node> = HashMap::new();

    // 初始化所有节点
    for id in table_ids {
        graph.insert(
            *id,
            Node {
                dependencies: HashSet::new(),
                dependents: HashSet::new(),
            },
        );
    }

    // 添加边：source_table 依赖 target_table
    for rel in relations {
        // 跳过不在目标集合中的关系
        if !table_ids.contains(&rel.source_table_id) || !table_ids.contains(&rel.target_table_id) {
            continue;
        }

        // 跳过自引用（自引用不影响创建顺序）
        if rel.source_table_id == rel.target_table_id {
            continue;
        }

        // source_table 依赖 target_table（target 需要先创建）
        graph.get_mut(&rel.source_table_id).unwrap().dependencies.insert(rel.target_table_id);

        // target_table 被 source_table 依赖
        graph.get_mut(&rel.target_table_id).unwrap().dependents.insert(rel.source_table_id);
    }

    graph
}

/// Kahn 算法拓扑排序
///
/// 返回 (排序结果, 循环涉及的表)
fn kahn_topological_sort(graph: &HashMap<i64, Node>) -> (Vec<i64>, HashSet<i64>) {
    // 计算入度（依赖数量）
    let mut in_degree: HashMap<i64, usize> = HashMap::new();
    for (id, node) in graph {
        in_degree.insert(*id, node.dependencies.len());
    }

    // 保持原始顺序的稳定排序：使用表 ID 作为优先级
    let mut sorted_ids: Vec<i64> = graph.keys().cloned().collect();
    sorted_ids.sort();

    // 队列：入度为 0 的节点，按 ID 排序保证稳定
    let mut queue: VecDeque<i64> = VecDeque::new();
    for id in &sorted_ids {
        if in_degree[id] == 0 {
            queue.push_back(*id);
        }
    }

    let mut sorted: Vec<i64> = Vec::new();

    while let Some(id) = queue.pop_front() {
        sorted.push(id);

        // 更新依赖此节点的其他节点的入度
        if let Some(node) = graph.get(&id) {
            let mut new_zero_nodes: Vec<i64> = Vec::new();
            for dep_id in &node.dependents {
                if let Some(deg) = in_degree.get_mut(dep_id) {
                    *deg -= 1;
                    if *deg == 0 {
                        new_zero_nodes.push(*dep_id);
                    }
                }
            }
            // 保持稳定性：新入度为 0 的节点按 ID 排序
            new_zero_nodes.sort();
            for nid in new_zero_nodes {
                queue.push_back(nid);
            }
        }
    }

    // 检测循环：如果排序结果不包含所有节点，说明存在循环
    let all_ids: HashSet<i64> = graph.keys().cloned().collect();
    let sorted_set: HashSet<i64> = sorted.iter().cloned().collect();
    let cycle_tables: HashSet<i64> = all_ids.difference(&sorted_set).cloned().collect();

    // 如果存在循环，将循环中的表按 ID 顺序追加到结果末尾
    // 这些表的外键约束需要在表创建后通过 ALTER TABLE 添加
    if !cycle_tables.is_empty() {
        let mut remaining: Vec<i64> = cycle_tables.iter().cloned().collect();
        remaining.sort();
        sorted.extend(remaining);
    }

    (sorted, cycle_tables)
}

/// 获取需要延迟创建外键约束的 relation IDs
///
/// 延迟的外键包括：
/// 1. 自引用的外键（source_table_id == target_table_id）
/// 2. 循环依赖中涉及的外键（source 和 target 都在 cycle_tables 中）
pub fn get_delayed_fk_relations(
    relations: &[ErRelation],
    cycle_tables: &HashSet<i64>,
    self_refs: &HashSet<i64>,
) -> HashSet<i64> {
    relations
        .iter()
        .filter(|r| {
            // 自引用的外键需要延迟
            self_refs.contains(&r.source_table_id)
                // 循环依赖中涉及的外键需要延迟
                || (cycle_tables.contains(&r.source_table_id)
                    && cycle_tables.contains(&r.target_table_id)
                    && r.source_table_id != r.target_table_id) // 自引用已单独处理
        })
        .map(|r| r.id)
        .collect()
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
        // orders -> users：users 应先创建
        let tables = vec![make_table(1, "orders"), make_table(2, "users")];
        let relations = vec![make_relation(1, 1, 2)]; // orders FK -> users

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle);
        assert_eq!(result.sorted_table_ids, vec![2, 1]); // users first, then orders
    }

    #[test]
    fn test_chain_dependency() {
        // A -> B -> C -> D：应按 D, C, B, A 顺序创建
        let tables = vec![
            make_table(1, "A"),
            make_table(2, "B"),
            make_table(3, "C"),
            make_table(4, "D"),
        ];
        let relations = vec![
            make_relation(1, 1, 2), // A -> B
            make_relation(2, 2, 3), // B -> C
            make_relation(3, 3, 4), // C -> D
        ];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle);
        assert_eq!(result.sorted_table_ids, vec![4, 3, 2, 1]);
    }

    #[test]
    fn test_self_reference() {
        // categories 表自引用 parent_id -> id
        let tables = vec![make_table(1, "categories")];
        let relations = vec![make_relation(1, 1, 1)]; // self-ref

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle);
        assert!(result.self_referencing_tables.contains(&1));
        assert_eq!(result.sorted_table_ids, vec![1]);
    }

    #[test]
    fn test_circular_dependency() {
        // A -> B -> C -> A：循环依赖
        let tables = vec![
            make_table(1, "A"),
            make_table(2, "B"),
            make_table(3, "C"),
        ];
        let relations = vec![
            make_relation(1, 1, 2), // A -> B
            make_relation(2, 2, 3), // B -> C
            make_relation(3, 3, 1), // C -> A (cycle!)
        ];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(result.has_cycle);
        assert!(result.cycle_tables.contains(&1));
        assert!(result.cycle_tables.contains(&2));
        assert!(result.cycle_tables.contains(&3));
        // 所有表都在结果中（循环的表追加到末尾）
        assert_eq!(result.sorted_table_ids.len(), 3);
    }

    #[test]
    fn test_multiple_dependencies() {
        // A 依赖 B 和 C，B 和 C 依赖 D
        let tables = vec![
            make_table(1, "A"),
            make_table(2, "B"),
            make_table(3, "C"),
            make_table(4, "D"),
        ];
        let relations = vec![
            make_relation(1, 1, 2), // A -> B
            make_relation(2, 1, 3), // A -> C
            make_relation(3, 2, 4), // B -> D
            make_relation(4, 3, 4), // C -> D
        ];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle);
        // D 必须最先
        assert_eq!(result.sorted_table_ids.first(), Some(&4));
        // A 必须最后（因为它依赖 B 和 C）
        assert_eq!(result.sorted_table_ids.last(), Some(&1));
    }

    #[test]
    fn test_independent_tables() {
        // 无依赖关系的表：按原始顺序（ID 顺序）
        let tables = vec![
            make_table(1, "logs"),
            make_table(2, "settings"),
            make_table(3, "cache"),
        ];
        let relations = vec![];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle);
        // 无依赖时按 ID 顺序排列
        assert_eq!(result.sorted_table_ids, vec![1, 2, 3]);
    }

    #[test]
    fn test_partial_sort_subset() {
        // 只排序部分表（用于 er_generate_sync_ddl）
        let tables = vec![
            make_table(1, "users"),
            make_table(2, "orders"),
            make_table(3, "products"),
            make_table(4, "reviews"),
        ];
        let relations = vec![
            make_relation(1, 2, 1), // orders -> users
            make_relation(2, 4, 2), // reviews -> orders
            make_relation(3, 4, 3), // reviews -> products
        ];

        // 只排序 orders 和 reviews（users 和 products 已存在）
        let subset: HashSet<i64> = HashSet::from([2, 4]);
        let result = sort_tables_by_dependency(&tables, &relations, Some(&subset));

        assert!(!result.has_cycle);
        // orders 必须在 reviews 之前（reviews 依赖 orders）
        let order_pos = result.sorted_table_ids.iter().position(|id| *id == 2).unwrap();
        let review_pos = result.sorted_table_ids.iter().position(|id| *id == 4).unwrap();
        assert!(order_pos < review_pos);
    }

    #[test]
    fn test_delayed_fk_detection() {
        let relations = vec![
            make_relation(1, 1, 1), // self-ref
            make_relation(2, 1, 2), // in cycle (both source and target in cycle_tables)
            make_relation(3, 2, 3), // in cycle
            make_relation(4, 3, 1), // in cycle
        ];

        let self_refs: HashSet<i64> = HashSet::from([1]);
        let cycle_tables: HashSet<i64> = HashSet::from([1, 2, 3]);

        let delayed = get_delayed_fk_relations(&relations, &cycle_tables, &self_refs);

        // self-ref (id=1) 应被延迟
        assert!(delayed.contains(&1));
        // 所有在 cycle 中的 relation (id=2, 3, 4) 都应被延迟
        // 因为它们的 source 和 target 都在 cycle_tables 中
        assert!(delayed.contains(&2));
        assert!(delayed.contains(&3));
        assert!(delayed.contains(&4));
    }

    #[test]
    fn test_mixed_self_ref_and_normal() {
        // users 有自引用，同时 orders 引用 users
        let tables = vec![make_table(1, "users"), make_table(2, "orders")];
        let relations = vec![
            make_relation(1, 1, 1), // users 自引用
            make_relation(2, 2, 1), // orders -> users
        ];

        let result = sort_tables_by_dependency(&tables, &relations, None);

        assert!(!result.has_cycle);
        assert!(result.self_referencing_tables.contains(&1));
        // users 应先创建
        assert_eq!(result.sorted_table_ids, vec![1, 2]);
    }
}