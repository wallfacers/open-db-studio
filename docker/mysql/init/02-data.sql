-- MySQL 测试数据
-- 用于 open-db-studio 功能测试

USE test_store;

-- 分类数据
INSERT INTO categories (id, name, parent_id, sort_order) VALUES
(1, '电子产品', NULL, 1),
(2, '手机', 1, 1),
(3, '电脑', 1, 2),
(4, '配件', 1, 3),
(5, '服装', NULL, 2),
(6, '男装', 5, 1),
(7, '女装', 5, 2),
(8, '运动', 5, 3),
(9, '家居', NULL, 3),
(10, '家具', 9, 1),
(11, '厨具', 9, 2);

-- 用户数据
INSERT INTO users (id, username, email, phone, status) VALUES
(1, 'zhangsan', 'zhangsan@example.com', '13800138001', 'active'),
(2, 'lisi', 'lisi@example.com', '13800138002', 'active'),
(3, 'wangwu', 'wangwu@example.com', '13800138003', 'active'),
(4, 'zhaoliu', 'zhaoliu@example.com', '13800138004', 'inactive'),
(5, 'sunqi', 'sunqi@example.com', '13800138005', 'active'),
(6, 'zhouba', 'zhouba@example.com', '13800138006', 'active'),
(7, 'wujiu', 'wujiu@example.com', '13800138007', 'banned'),
(8, 'zhengshi', 'zhengshi@example.com', '13800138008', 'active'),
(9, 'test_user', 'test@example.com', '13800138009', 'active'),
(10, 'demo_user', 'demo@example.com', '13800138010', 'active');

-- 产品数据
INSERT INTO products (id, name, category_id, price, stock, status, description) VALUES
(1, 'iPhone 15 Pro', 2, 8999.00, 100, 'on_sale', 'Apple iPhone 15 Pro 256GB'),
(2, 'MacBook Pro 14', 3, 14999.00, 50, 'on_sale', 'Apple MacBook Pro 14寸 M3 Pro'),
(3, 'AirPods Pro 2', 4, 1899.00, 200, 'on_sale', 'Apple AirPods Pro 第二代'),
(4, '华为 Mate 60 Pro', 2, 6999.00, 80, 'on_sale', '华为 Mate 60 Pro 512GB'),
(5, 'ThinkPad X1 Carbon', 3, 9999.00, 30, 'on_sale', '联想 ThinkPad X1 Carbon Gen 11'),
(6, '男款冲锋衣', 6, 899.00, 150, 'on_sale', '防水透气三合一冲锋衣'),
(7, '运动跑鞋', 8, 599.00, 300, 'on_sale', '轻量缓震跑步鞋'),
(8, '连衣裙', 7, 399.00, 100, 'on_sale', '夏季新款碎花连衣裙'),
(9, '智能手表', 4, 2499.00, 120, 'on_sale', '运动健康监测智能手表'),
(10, '蓝牙音箱', 4, 299.00, 500, 'on_sale', '便携式蓝牙音箱'),
(11, '机械键盘', 4, 799.00, 80, 'on_sale', 'RGB背光机械键盘'),
(12, '显示器', 4, 1999.00, 60, 'off_sale', '27寸 4K 显示器'),
(13, '旧款手机', 2, 1999.00, 0, 'sold_out', '已停产旧款手机');

-- 订单数据
INSERT INTO orders (id, order_no, user_id, total_amount, status, shipping_address) VALUES
(1, 'ORD20240101001', 1, 16898.00, 'completed', '北京市朝阳区xxx街道'),
(2, 'ORD20240102001', 2, 8999.00, 'shipped', '上海市浦东新区xxx路'),
(3, 'ORD20240103001', 3, 6498.00, 'paid', '广州市天河区xxx大道'),
(4, 'ORD20240104001', 1, 1899.00, 'completed', '北京市朝阳区xxx街道'),
(5, 'ORD20240105001', 5, 3999.00, 'pending', '深圳市南山区xxx街'),
(6, 'ORD20240106001', 7, 12498.00, 'completed', '成都市武侯区xxx路'),
(7, 'ORD20240107001', 8, 599.00, 'shipped', '杭州市西湖区xxx街'),
(8, 'ORD20240108001', 4, 10498.00, 'cancelled', '南京市鼓楼区xxx路'),
(9, 'ORD20240109001', 6, 2499.00, 'paid', '武汉市洪山区xxx街'),
(10, 'ORD20240110001', 10, 2998.00, 'pending', '西安市雁塔区xxx路');

-- 订单详情数据
INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
(1, 2, 1, 14999.00),
(1, 3, 1, 1899.00),
(2, 1, 1, 8999.00),
(3, 4, 1, 6999.00),
(4, 3, 1, 1899.00),
(5, 5, 1, 9999.00),
(6, 2, 1, 14999.00),
(6, 5, 1, 9999.00),
(6, 3, 2, 1899.00),
(7, 7, 1, 599.00),
(8, 1, 1, 8999.00),
(8, 9, 1, 2499.00),
(9, 9, 1, 2499.00),
(10, 10, 2, 299.00),
(10, 7, 2, 599.00),
(10, 11, 1, 799.00);

-- 支付记录
INSERT INTO payments (order_id, payment_method, amount, status, transaction_id, paid_at) VALUES
(1, 'alipay', 16898.00, 'success', 'ALI202401010001', '2024-01-01 10:30:00'),
(2, 'wechat', 8999.00, 'success', 'WX202401020001', '2024-01-02 14:20:00'),
(3, 'credit_card', 6498.00, 'success', 'CC202401030001', '2024-01-03 09:15:00'),
(4, 'alipay', 1899.00, 'success', 'ALI202401040001', '2024-01-04 16:45:00'),
(5, 'wechat', 3999.00, 'pending', NULL, NULL),
(6, 'alipay', 12498.00, 'success', 'ALI202401060001', '2024-01-06 11:00:00'),
(7, 'wechat', 599.00, 'success', 'WX202401070001', '2024-01-07 13:30:00'),
(8, 'credit_card', 10498.00, 'refunded', 'CC202401080001', '2024-01-08 10:00:00'),
(9, 'alipay', 2499.00, 'success', 'ALI202401090001', '2024-01-09 15:00:00'),
(10, 'wechat', 2998.00, 'pending', NULL, NULL);

-- ============================================
-- HR 数据库测试数据
-- ============================================
USE test_hr;

-- 部门数据
INSERT INTO departments (id, name, manager_id, budget) VALUES
(1, '技术部', 1, 5000000.00),
(2, '产品部', 4, 2000000.00),
(3, '市场部', 7, 3000000.00),
(4, '人力资源部', 10, 1000000.00),
(5, '财务部', 13, 1500000.00);

-- 员工数据
INSERT INTO employees (id, emp_no, name, email, phone, department_id, manager_id, position, salary, hire_date, status) VALUES
(1, 'EMP001', '张三', 'zhangsan@company.com', '13900000001', 1, NULL, '技术总监', 50000.00, '2020-01-15', 'active'),
(2, 'EMP002', '李四', 'lisi@company.com', '13900000002', 1, 1, '高级开发工程师', 30000.00, '2020-03-01', 'active'),
(3, 'EMP003', '王五', 'wangwu@company.com', '13900000003', 1, 1, '开发工程师', 20000.00, '2021-06-01', 'active'),
(4, 'EMP004', '赵六', 'zhaoliu@company.com', '13900000004', 2, NULL, '产品总监', 45000.00, '2019-08-01', 'active'),
(5, 'EMP005', '孙七', 'sunqi@company.com', '13900000005', 2, 4, '高级产品经理', 25000.00, '2020-05-15', 'active'),
(6, 'EMP006', '周八', 'zhouba@company.com', '13900000006', 2, 4, '产品经理', 18000.00, '2021-01-10', 'active'),
(7, 'EMP007', '吴九', 'wujiu@company.com', '13900000007', 3, NULL, '市场总监', 40000.00, '2019-03-01', 'active'),
(8, 'EMP008', '郑十', 'zhengshi@company.com', '13900000008', 3, 7, '市场经理', 22000.00, '2020-07-01', 'active'),
(9, 'EMP009', '钱十一', 'qianshiyi@company.com', '13900000009', 3, 7, '市场专员', 12000.00, '2022-03-15', 'active'),
(10, 'EMP010', '刘十二', 'liushier@company.com', '13900000010', 4, NULL, 'HR总监', 35000.00, '2018-06-01', 'active'),
(11, 'EMP011', '陈十三', 'chenshisan@company.com', '13900000011', 4, 10, 'HR经理', 18000.00, '2019-09-01', 'active'),
(12, 'EMP012', '林十四', 'linshisi@company.com', '13900000012', 4, 10, 'HR专员', 10000.00, '2021-11-01', 'active'),
(13, 'EMP013', '黄十五', 'huangshiwu@company.com', '13900000013', 5, NULL, '财务总监', 45000.00, '2018-01-01', 'active'),
(14, 'EMP014', '杨十六', 'yangshiliu@company.com', '13900000014', 5, 13, '财务经理', 25000.00, '2019-04-01', 'active'),
(15, 'EMP015', '何十七', 'heshiqi@company.com', '13900000015', 5, 13, '会计', 15000.00, '2020-08-01', 'active'),
(16, 'EMP016', '徐十八', 'xushiba@company.com', '13900000016', 1, 1, '开发工程师', 18000.00, '2022-02-01', 'resigned'),
(17, 'EMP017', '马十九', 'mashijiu@company.com', '13900000017', 1, 1, '实习生', 5000.00, '2023-07-01', 'active');

-- 更新部门经理 ID
UPDATE departments SET manager_id = 1 WHERE id = 1;
UPDATE departments SET manager_id = 4 WHERE id = 2;
UPDATE departments SET manager_id = 7 WHERE id = 3;
UPDATE departments SET manager_id = 10 WHERE id = 4;
UPDATE departments SET manager_id = 13 WHERE id = 5;

-- 考勤数据 (最近一周)
INSERT INTO attendances (employee_id, date, check_in, check_out, status) VALUES
(1, '2024-01-08', '08:55:00', '18:05:00', 'normal'),
(1, '2024-01-09', '09:02:00', '18:30:00', 'late'),
(1, '2024-01-10', '08:50:00', '18:00:00', 'normal'),
(2, '2024-01-08', '08:45:00', '18:15:00', 'normal'),
(2, '2024-01-09', '08:58:00', '18:00:00', 'normal'),
(2, '2024-01-10', '09:15:00', '18:30:00', 'late'),
(3, '2024-01-08', '08:30:00', '17:45:00', 'early_leave'),
(3, '2024-01-09', '08:55:00', '18:00:00', 'normal'),
(3, '2024-01-10', '08:50:00', '18:10:00', 'normal'),
(5, '2024-01-08', '09:05:00', '18:00:00', 'late'),
(5, '2024-01-09', '08:45:00', '18:20:00', 'normal'),
(5, '2024-01-10', NULL, NULL, 'absent');

-- ============================================
-- Analytics 数据库测试数据
-- ============================================
USE test_analytics;

-- 页面访问数据
INSERT INTO page_views (user_id, page_url, referrer, ip_address, user_agent, session_id, duration_ms) VALUES
(1, '/products/1', '/home', '192.168.1.100', 'Mozilla/5.0 Chrome/120.0', 'sess_001', 15000),
(1, '/products/2', '/products/1', '192.168.1.100', 'Mozilla/5.0 Chrome/120.0', 'sess_001', 30000),
(1, '/cart', '/products/2', '192.168.1.100', 'Mozilla/5.0 Chrome/120.0', 'sess_001', 45000),
(2, '/home', 'https://google.com', '192.168.1.101', 'Mozilla/5.0 Safari/17.0', 'sess_002', 20000),
(2, '/products', '/home', '192.168.1.101', 'Mozilla/5.0 Safari/17.0', 'sess_002', 60000),
(3, '/home', NULL, '192.168.1.102', 'Mozilla/5.0 Firefox/121.0', 'sess_003', 10000),
(NULL, '/home', 'https://baidu.com', '192.168.1.103', 'Mozilla/5.0 Chrome/119.0', 'sess_004', 5000),
(NULL, '/products/4', '/home', '192.168.1.103', 'Mozilla/5.0 Chrome/119.0', 'sess_004', 25000);

-- 事件数据
INSERT INTO events (user_id, event_type, event_name, properties, created_at) VALUES
(1, 'click', 'add_to_cart', '{"product_id": 1, "quantity": 1}', '2024-01-10 10:30:00'),
(1, 'click', 'checkout', '{"cart_total": 8999.00}', '2024-01-10 10:35:00'),
(1, 'conversion', 'purchase', '{"order_id": 1, "amount": 8999.00}', '2024-01-10 10:40:00'),
(2, 'click', 'view_product', '{"product_id": 2}', '2024-01-10 11:00:00'),
(2, 'click', 'add_to_wishlist', '{"product_id": 2}', '2024-01-10 11:05:00'),
(3, 'click', 'search', '{"keyword": "iPhone"}', '2024-01-10 11:30:00'),
(NULL, 'click', 'view_home', '{}', '2024-01-10 12:00:00'),
(NULL, 'click', 'register', '{"method": "email"}', '2024-01-10 12:05:00');
