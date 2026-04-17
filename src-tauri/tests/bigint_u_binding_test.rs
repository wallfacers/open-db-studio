//! 独立测试：验证 BIGINT UNSIGNED 参数绑定修复
//!
//! 测试目标：
//! 1. u64 值 <= i64::MAX → 正确绑定
//! 2. u64 值 > i64::MAX → 字符串绑定（避免溢出）

use sqlx::mysql::MySqlPoolOptions;

#[tokio::main]
async fn main() {
    println!("=== BIGINT UNSIGNED 参数绑定测试 ===\n");

    // 连接 MySQL
    let url = "mysql://root:root123456@127.0.0.1:3306/test_project";
    let pool = MySqlPoolOptions::new()
        .max_connections(2)
        .connect(url)
        .await
        .expect("Failed to connect to MySQL");

    println!("[1] 连接成功");

    // 创建测试表
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bigint_u_test (
            id INT AUTO_INCREMENT PRIMARY KEY,
            val_bigint_u BIGINT UNSIGNED NOT NULL
        ) ENGINE=InnoDB"
    )
    .execute(&pool)
    .await
    .expect("Failed to create table");

    println!("[2] 测试表已创建");

    // 清空表
    sqlx::query("TRUNCATE TABLE bigint_u_test")
        .execute(&pool)
        .await
        .expect("Failed to truncate");

    println!("[3] 测试表已清空");

    // 测试用例：覆盖临界值
    let test_cases: Vec<(u64, &str)> = vec![
        (0, "最小值 0"),
        (255, "TINYINT UNSIGNED 最大值"),
        (65535, "SMALLINT UNSIGNED 最大值"),
        (4294967295, "INT UNSIGNED 最大值"),
        (9223372036854775807, "i64::MAX（临界值）"),
        (9223372036854775808, "i64::MAX + 1（超大值）"),
        (18446744073709551615, "u64::MAX（超大值）"),
    ];

    println!("\n[4] 开始插入测试值...");
    let mut success_count = 0;
    let mut fail_count = 0;

    for (val, desc) in &test_cases {
        // 模拟修复后的绑定逻辑
        let query_str = "INSERT INTO bigint_u_test (val_bigint_u) VALUES (?)";
        let mut query = sqlx::query(query_str);

        if *val <= i64::MAX as u64 {
            // 安全范围内：强转 i64
            query = query.bind(*val as i64);
            println!("  插入 {} ({}) → bind as i64", val, desc);
        } else {
            // 超大值：字符串绑定
            query = query.bind(val.to_string());
            println!("  插入 {} ({}) → bind as String", val, desc);
        }

        let result = query.execute(&pool).await;
        match result {
            Ok(r) => {
                println!("    ✓ 成功，插入行 ID {}", r.last_insert_id());
                success_count += 1;
            }
            Err(e) => {
                println!("    ✗ 失败: {}", e);
                fail_count += 1;
            }
        }
    }

    // 验证插入结果
    println!("\n[5] 验证插入结果...");
    let rows: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, CAST(val_bigint_u AS CHAR) as val FROM bigint_u_test ORDER BY id"
    )
    .fetch_all(&pool)
    .await
    .expect("Failed to query");

    println!("  查询结果:");
    for (id, val) in &rows {
        println!("    ID {}: {}", id, val);
    }

    // 验证超大值正确性
    println!("\n[6] 验证超大值...");
    let expected_large = vec![
        ("9223372036854775808", "i64::MAX + 1"),
        ("18446744073709551615", "u64::MAX"),
    ];

    let mut large_ok = true;
    for (expected, desc) in &expected_large {
        let found = rows.iter().any(|(_, v)| v == expected);
        if found {
            println!("  ✓ {} ({}) 正确存储", expected, desc);
        } else {
            println!("  ✗ {} ({}) 未找到或值错误！", expected, desc);
            large_ok = false;
        }
    }

    println!("\n=== 测试完成 ===");
    println!("成功插入 {} 行，失败 {} 行", success_count, fail_count);

    if large_ok && fail_count == 0 {
        println!("✓ 修复验证成功：超大 BIGINT UNSIGNED 值通过字符串绑定正确写入！");
    } else {
        println!("✗ 测试失败，请检查修复");
    }

    // 清理
    sqlx::query("DROP TABLE bigint_u_test")
        .execute(&pool)
        .await
        .expect("Failed to drop table");
    println!("\n测试表已清理");
}