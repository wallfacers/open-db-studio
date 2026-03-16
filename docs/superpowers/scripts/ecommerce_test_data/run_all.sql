-- =====================================================
-- 电商测试数据库 - 一键执行脚本
-- 数据库: test_store
-- 连接信息: localhost:3306, test_user:test123456
--
-- 执行方式:
--   mysql -h localhost -P 3306 -u test_user -ptest123456 < run_all.sql
-- 或者分步执行:
--   source 01_schema.sql;
--   source 02_categories.sql;
--   ...
-- =====================================================

-- 设置字符集
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- 记录开始时间
SELECT '开始执行电商测试数据初始化...' AS message;
SELECT NOW() AS start_time;

-- 1. 建表
SOURCE 01_schema.sql;

-- 2. 分类数据
SOURCE 02_categories.sql;

-- 3. 商品数据
SOURCE 03_products.sql;

-- 4. 用户数据
SOURCE 04_users.sql;

-- 5. 地址数据
SOURCE 05_addresses.sql;

-- 6. 订单相关数据（订单+明细+支付+物流）
SOURCE 06_orders.sql;

-- 7. 退款数据
SOURCE 07_refunds.sql;

-- 8. 购物车数据
SOURCE 08_shopping_carts.sql;

SET FOREIGN_KEY_CHECKS = 1;

-- 记录结束时间
SELECT NOW() AS end_time;

-- =====================================================
-- 最终统计
-- =====================================================

SELECT '========== 数据初始化完成 ==========' AS summary;

SELECT
    'users' AS table_name, COUNT(*) AS count FROM users
UNION ALL
SELECT 'addresses', COUNT(*) FROM addresses
UNION ALL
SELECT 'categories', COUNT(*) FROM categories
UNION ALL
SELECT 'products', COUNT(*) FROM products
UNION ALL
SELECT 'orders', COUNT(*) FROM orders
UNION ALL
SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL
SELECT 'payments', COUNT(*) FROM payments
UNION ALL
SELECT 'shipments', COUNT(*) FROM shipments
UNION ALL
SELECT 'refund_records', COUNT(*) FROM refund_records
UNION ALL
SELECT 'shopping_carts', COUNT(*) FROM shopping_carts;

-- =====================================================
-- 指标验证 SQL 示例
-- =====================================================

SELECT '========== 指标验证示例 ==========' AS info;

-- 1. 总销售额（已完成订单）
SELECT '总销售额(已完成订单)' AS metric,
    CONCAT('¥', FORMAT(SUM(pay_amount), 2)) AS value
FROM orders WHERE status = 30;

-- 2. 订单数
SELECT '总订单数' AS metric, COUNT(*) AS value FROM orders;

-- 3. 订单完成率
SELECT '订单完成率' AS metric,
    CONCAT(ROUND(COUNT(CASE WHEN status = 30 THEN 1 END) * 100.0 / COUNT(*), 2), '%') AS value
FROM orders;

-- 4. 活跃用户数
SELECT '活跃用户数' AS metric, COUNT(DISTINCT user_id) AS value FROM orders;

-- 5. 平均客单价
SELECT '平均客单价' AS metric,
    CONCAT('¥', ROUND(AVG(pay_amount), 2)) AS value
FROM orders WHERE status IN (20, 30);

-- 6. 支付成功率
SELECT '支付成功率' AS metric,
    CONCAT(ROUND(COUNT(CASE WHEN status = 1 THEN 1 END) * 100.0 / COUNT(*), 2), '%') AS value
FROM payments;

-- 7. 退款率
SELECT '退款率' AS metric,
    CONCAT(ROUND(
        (SELECT COUNT(*) FROM refund_records WHERE status = 1) * 100.0 /
        (SELECT COUNT(*) FROM orders WHERE status = 30), 2), '%') AS value;

SELECT '初始化完成！可以开始测试了。' AS message;
