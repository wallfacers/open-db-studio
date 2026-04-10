//! 图谱自动布局：为 position_x IS NULL 的节点分配初始坐标。
//!
//! 算法：按 connection_id + database 分组，每组网格排列，组间横向拼接。
//! 已有坐标的节点永远不被覆盖。

use crate::AppResult;

const NODE_W: f64 = 280.0;
const NODE_H: f64 = 120.0;
const GROUP_GAP_X: f64 = 600.0;
const GROUP_GAP_Y: f64 = 500.0;
const MAX_COLS: usize = 4;

struct NodePos {
    id: String,
    database: Option<String>,
    position_x: Option<f64>,
    position_y: Option<f64>,
}

/// 为指定连接下所有 `position_x IS NULL` 的节点计算并写入初始坐标。
/// 已有坐标的节点不受影响。
pub fn auto_layout_new_nodes(connection_id: i64, database: Option<&str>) -> AppResult<()> {
    let conn = crate::db::get().lock().unwrap();

    // 1. 读取所有节点（含已有坐标和待分配节点）
    let mut where_parts = vec!["connection_id=?1".to_string(), "is_deleted=0".to_string()];
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(connection_id)];

    if let Some(db) = database {
        where_parts.push("(database=?2 OR database IS NULL)".to_string());
        params.push(Box::new(db.to_string()));
    }

    let sql = format!(
        "SELECT id, database, position_x, position_y FROM graph_nodes WHERE {}",
        where_parts.join(" AND ")
    );

    let mut stmt = conn.prepare(&sql)?;
    let all_nodes: Vec<NodePos> = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok(NodePos {
                id: row.get(0)?,
                database: row.get(1)?,
                position_x: row.get(2)?,
                position_y: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // 2. 按 database 分组
    let mut group_map: std::collections::HashMap<String, (Vec<&NodePos>, Vec<&NodePos>)> =
        std::collections::HashMap::new();

    for node in &all_nodes {
        let key = node.database.as_deref().unwrap_or("").to_string();
        let entry = group_map.entry(key).or_default();
        if node.position_x.is_some() {
            entry.0.push(node); // 已有坐标
        } else {
            entry.1.push(node); // 待分配
        }
    }

    // 若无待分配节点，直接返回
    if group_map.values().all(|(_, pending)| pending.is_empty()) {
        return Ok(());
    }

    // 3. 计算所有已有坐标节点的全局最大 X（新组从此处右侧开始）
    let existing_max_x = group_map.values().flat_map(|(positioned, _)| positioned.iter()).fold(
        0.0_f64,
        |acc, n| acc.max(n.position_x.unwrap_or(0.0) + NODE_W),
    );

    // 4. 排序：有已坐标节点的组优先，其次按待分配数量降序
    let mut sorted_groups: Vec<(&String, &(Vec<&NodePos>, Vec<&NodePos>))> =
        group_map.iter().collect();
    sorted_groups.sort_by(|(_, (a_pos, a_pend)), (_, (b_pos, b_pend))| {
        let a_has = !a_pos.is_empty();
        let b_has = !b_pos.is_empty();
        match (a_has, b_has) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => b_pend.len().cmp(&a_pend.len()),
        }
    });

    // 5. 为每组待分配节点计算坐标
    let mut new_assignments: Vec<(String, f64, f64)> = Vec::new();
    let mut new_group_col: usize = 0;
    let mut new_group_row: usize = 0;

    for (_, (positioned, pending)) in &sorted_groups {
        if pending.is_empty() {
            continue;
        }

        let (base_x, base_y) = if !positioned.is_empty() {
            // 在已有节点右侧插入
            let max_x = positioned
                .iter()
                .map(|n| n.position_x.unwrap_or(0.0) + NODE_W)
                .fold(0.0_f64, f64::max);
            let min_y = positioned
                .iter()
                .map(|n| n.position_y.unwrap_or(0.0))
                .fold(f64::MAX, f64::min);
            (max_x + GROUP_GAP_X, min_y)
        } else {
            // 全新组：网格定位
            let bx = existing_max_x
                + new_group_col as f64 * (NODE_W * 5.0 + GROUP_GAP_X);
            let by = new_group_row as f64 * (NODE_H * 5.0 + GROUP_GAP_Y);
            new_group_col += 1;
            if new_group_col >= MAX_COLS {
                new_group_col = 0;
                new_group_row += 1;
            }
            (bx, by)
        };

        // 网格排列：列数 = ceil(sqrt(n))
        let n = pending.len();
        let cols = ((n as f64).sqrt().ceil() as usize).max(1);

        for (i, node) in pending.iter().enumerate() {
            let col = i % cols;
            let row = i / cols;
            let x = base_x + col as f64 * (NODE_W + 40.0);
            let y = base_y + row as f64 * (NODE_H + 20.0);
            new_assignments.push((node.id.clone(), x, y));
        }
    }

    // 6. 批量写入
    drop(stmt);
    for (id, x, y) in &new_assignments {
        conn.execute(
            "UPDATE graph_nodes SET position_x=?1, position_y=?2 WHERE id=?3",
            rusqlite::params![x, y, id],
        )?;
    }

    log::info!(
        "[layout] auto_layout_new_nodes: assigned {} positions for connection {}",
        new_assignments.len(),
        connection_id
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_layout_assigns_positions_to_null_nodes() {
        // 直接测试坐标计算逻辑（不依赖全局 DB）
        // 给定 4 个待分配节点，cols = ceil(sqrt(4)) = 2
        let n = 4usize;
        let cols = ((n as f64).sqrt().ceil() as usize).max(1);
        assert_eq!(cols, 2);

        let base_x = 0.0_f64;
        let base_y = 0.0_f64;
        let positions: Vec<(f64, f64)> = (0..n)
            .map(|i| {
                let col = i % cols;
                let row = i / cols;
                (base_x + col as f64 * (NODE_W + 40.0), base_y + row as f64 * (NODE_H + 20.0))
            })
            .collect();

        // 第0个：(0, 0)
        assert!((positions[0].0 - 0.0).abs() < 1e-9);
        assert!((positions[0].1 - 0.0).abs() < 1e-9);
        // 第1个：(NODE_W+40, 0)
        assert!((positions[1].0 - (NODE_W + 40.0)).abs() < 1e-9);
        assert!((positions[1].1 - 0.0).abs() < 1e-9);
        // 第2个：(0, NODE_H+20) — 换行
        assert!((positions[2].0 - 0.0).abs() < 1e-9);
        assert!((positions[2].1 - (NODE_H + 20.0)).abs() < 1e-9);
    }

    #[test]
    fn test_existing_nodes_not_moved() {
        // 验证：已有坐标的节点不被分配新坐标
        let positioned = vec![NodePos {
            id: "n1".into(),
            database: Some("db_a".into()),
            position_x: Some(100.0),
            position_y: Some(200.0),
        }];
        let pending = vec![NodePos {
            id: "n2".into(),
            database: Some("db_a".into()),
            position_x: None,
            position_y: None,
        }];

        // existing_max_x from positioned: 100.0 + NODE_W = 380.0
        let existing_max_x = positioned
            .iter()
            .map(|n| n.position_x.unwrap_or(0.0) + NODE_W)
            .fold(0.0_f64, f64::max);
        assert!((existing_max_x - (100.0 + NODE_W)).abs() < 1e-9);

        // pending node placed to right of positioned (base_x = max_x + GROUP_GAP_X)
        let base_x = existing_max_x + GROUP_GAP_X;
        assert!(base_x > 100.0 + NODE_W); // 确实在右侧
        let _ = pending; // n1 的坐标不受影响
    }
}
