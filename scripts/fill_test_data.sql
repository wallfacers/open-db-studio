-- =============================================
-- test_store 数据库 - 订单真实场景数据填充
-- =============================================

-- 1. 状态10(待发货): 已付款待发货
UPDATE orders SET
  payment_method = CASE WHEN payment_method IS NULL THEN
    ELT(FLOOR(1 + RAND() * 4), 'alipay', 'wechat', 'credit_card', 'balance')
  ELSE payment_method END,
  payment_time = DATE_ADD(created_at, INTERVAL FLOOR(1 + RAND() * 30) MINUTE),
  freight_amount = CASE
    WHEN freight_amount IS NULL OR freight_amount = 0 THEN
      CASE WHEN total_amount > 500 THEN 0 ELSE ROUND(5 + RAND() * 10, 2) END
    ELSE freight_amount END,
  discount_amount = CASE WHEN RAND() > 0.7 THEN ROUND(total_amount * 0.05, 2) ELSE 0 END,
  user_remark = CASE WHEN RAND() > 0.85 THEN
    ELT(FLOOR(1 + RAND() * 6), '请尽快发货', '包装仔细一点', '送礼用的', '发顺丰快递', '不要放驿站', '周末送')
  ELSE user_remark END
WHERE status = 10;

-- 2. 状态20(待收货): 已发货待收货
UPDATE orders SET
  payment_method = CASE WHEN payment_method IS NULL THEN
    ELT(FLOOR(1 + RAND() * 4), 'alipay', 'wechat', 'credit_card', 'balance')
  ELSE payment_method END,
  payment_time = DATE_ADD(created_at, INTERVAL FLOOR(1 + RAND() * 30) MINUTE),
  ship_time = DATE_ADD(created_at, INTERVAL FLOOR(1 + RAND() * 48) HOUR),
  freight_amount = CASE
    WHEN freight_amount IS NULL OR freight_amount = 0 THEN
      CASE WHEN total_amount > 500 THEN 0 ELSE ROUND(5 + RAND() * 10, 2) END
    ELSE freight_amount END,
  discount_amount = CASE WHEN RAND() > 0.7 THEN ROUND(total_amount * 0.05, 2) ELSE 0 END,
  user_remark = CASE WHEN RAND() > 0.85 THEN
    ELT(FLOOR(1 + RAND() * 6), '请尽快发货', '包装仔细一点', '送礼用的', '发顺丰快递', '不要放驿站', '周末送')
  ELSE user_remark END
WHERE status = 20;

-- 3. 状态30(已完成): 完整流程
UPDATE orders SET
  payment_method = CASE WHEN payment_method IS NULL THEN
    ELT(FLOOR(1 + RAND() * 4), 'alipay', 'wechat', 'credit_card', 'balance')
  ELSE payment_method END,
  payment_time = DATE_ADD(created_at, INTERVAL FLOOR(1 + RAND() * 30) MINUTE),
  ship_time = DATE_ADD(created_at, INTERVAL FLOOR(1 + RAND() * 72) HOUR),
  receive_time = DATE_ADD(created_at, INTERVAL FLOOR(24 + RAND() * 168) HOUR),
  freight_amount = CASE
    WHEN freight_amount IS NULL OR freight_amount = 0 THEN
      CASE WHEN total_amount > 500 THEN 0 ELSE ROUND(5 + RAND() * 10, 2) END
    ELSE freight_amount END,
  discount_amount = CASE WHEN RAND() > 0.7 THEN ROUND(total_amount * 0.05, 2) ELSE 0 END,
  user_remark = CASE WHEN RAND() > 0.85 THEN
    ELT(FLOOR(1 + RAND() * 6), '请尽快发货', '包装仔细一点', '送礼用的', '发顺丰快递', '不要放驿站', '周末送')
  ELSE user_remark END
WHERE status = 30;

-- 4. 状态40(已取消): 取消信息
UPDATE orders SET
  payment_method = CASE WHEN payment_method IS NULL AND RAND() > 0.3 THEN
    ELT(FLOOR(1 + RAND() * 4), 'alipay', 'wechat', 'credit_card', 'balance')
  ELSE payment_method END,
  payment_time = CASE WHEN payment_method IS NOT NULL THEN
    DATE_ADD(created_at, INTERVAL FLOOR(1 + RAND() * 30) MINUTE)
  ELSE NULL END,
  cancel_time = DATE_ADD(created_at, INTERVAL FLOOR(1 + RAND() * 72) HOUR),
  cancel_reason = CASE WHEN cancel_reason IS NULL THEN
    ELT(FLOOR(1 + RAND() * 8), '不想要了', '拍错了', '价格太贵', '找到更便宜的', '等待时间太长', '商品信息有误', '重复下单', '其他原因')
  ELSE cancel_reason END,
  freight_amount = CASE
    WHEN freight_amount IS NULL OR freight_amount = 0 THEN
      CASE WHEN total_amount > 500 THEN 0 ELSE ROUND(5 + RAND() * 10, 2) END
    ELSE freight_amount END
WHERE status = 40;

-- 5. 状态0(待付款): 部分备注
UPDATE orders SET
  freight_amount = CASE
    WHEN freight_amount IS NULL OR freight_amount = 0 THEN
      CASE WHEN total_amount > 500 THEN 0 ELSE ROUND(5 + RAND() * 10, 2) END
    ELSE freight_amount END,
  user_remark = CASE WHEN RAND() > 0.92 THEN
    ELT(FLOOR(1 + RAND() * 6), '请尽快发货', '包装仔细一点', '送礼用的', '发顺丰快递', '不要放驿站', '周末送')
  ELSE user_remark END
WHERE status = 0;

-- 6. 重新计算 pay_amount (实付金额 = 总金额 + 运费 - 优惠)
UPDATE orders SET
  pay_amount = total_amount + IFNULL(freight_amount, 0) - IFNULL(discount_amount, 0);

SELECT 'All orders updated successfully!' as result;
