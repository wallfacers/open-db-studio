-- 分类数据
USE test_store;

INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (1, '数码电子', NULL, 1, 1, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (2, '手机通讯', 1, 2, 2, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (3, '智能手机', 2, 3, 3, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (4, '手机配件', 2, 3, 4, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (5, '电脑办公', 1, 2, 5, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (6, '笔记本电脑', 5, 3, 6, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (7, '电脑配件', 5, 3, 7, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (8, '服饰鞋包', NULL, 1, 8, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (9, '男装', 8, 2, 9, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (10, 'T恤', 9, 3, 10, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (11, '裤子', 9, 3, 11, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (12, '女装', 8, 2, 12, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (13, '连衣裙', 12, 3, 13, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (14, '上衣', 12, 3, 14, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (15, '鞋靴', 8, 2, 15, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (16, '运动鞋', 15, 3, 16, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (17, '休闲鞋', 15, 3, 17, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (18, '家居生活', NULL, 1, 18, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (19, '家具', 18, 2, 19, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (20, '沙发', 19, 3, 20, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (21, '床品', 19, 3, 21, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (22, '厨具', 18, 2, 22, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (23, '炊具', 22, 3, 23, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (24, '餐具', 22, 3, 24, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (25, '食品生鲜', NULL, 1, 25, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (26, '零食', 25, 2, 26, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (27, '坚果', 26, 3, 27, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (28, '糖果', 26, 3, 28, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (29, '饮品', 25, 2, 29, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (30, '茶饮', 29, 3, 30, 1, NOW(), NOW());
INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (31, '咖啡', 29, 3, 31, 1, NOW(), NOW());

SELECT CONCAT('Created ', COUNT(*), ' categories') AS message FROM categories;