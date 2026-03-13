-- 订单数据
INSERT INTO orders (user_id, total_amount, status) VALUES
(1, 16898.00, 'completed'),
(2, 8999.00, 'shipped'),
(3, 6498.00, 'paid'),
(1, 1899.00, 'completed'),
(5, 3999.00, 'pending'),
(7, 12498.00, 'completed'),
(8, 599.00, 'shipped'),
(4, 10498.00, 'cancelled');

-- 订单详情数据
INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
(1, 1, 1, 14999.00),
(1, 3, 1, 1899.00),
(2, 2, 1, 8999.00),
(3, 4, 1, 3999.00),
(3, 7, 1, 599.00),
(3, 8, 1, 2499.00),
(4, 3, 1, 1899.00),
(5, 4, 1, 3999.00),
(6, 1, 1, 14999.00),
(6, 5, 1, 9999.00),
(6, 7, 2, 599.00),
(7, 7, 1, 599.00),
(8, 5, 1, 9999.00),
(8, 9, 1, 7999.00);
