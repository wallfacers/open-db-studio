-- =============================================================
-- 指标定义 & 知识图谱数据 — 核心测试数据
-- =============================================================



-- =============================================
-- 业务术语
-- =============================================
INSERT INTO sys_biz_term (term_code, term_name, term_alias, term_desc, term_formula) VALUES
('GMV',       'GMV',          '总交易额,交易总额,销售总额,成交总额',
 '一定时间内的订单总金额(含未付款、已取消订单)',
 'SUM(t_ord_hdr.ord_amt) — 不过滤状态'),
('REVENUE',   '营业收入',     '收入,营收,实际收入,净收入',
 '已完成订单的实付金额总和',
 'SUM(t_ord_hdr.pay_amt) WHERE ord_st IN (20,30,40)'),
('AOV',       '客单价',       '平均订单金额,单均价,avg order value',
 '平均每笔订单的实付金额',
 'SUM(pay_amt) / COUNT(DISTINCT ord_no) WHERE ord_st IN (20,30,40)'),
('RPR',       '复购率',       '回购率,重复购买率,repurchase rate',
 '一定周期内下单2次及以上的客户占比',
 'COUNT(下单>=2的客户) / COUNT(所有下单客户)'),
('ARPU',      'ARPU',         '用户平均收入,人均收入,每用户收入',
 '每个活跃客户的平均收入',
 'SUM(pay_amt) / COUNT(DISTINCT cst_no) WHERE ord_st IN (20,30,40)'),
('CHURN',     '客户流失率',   '流失率,流失比率',
 '统计周期内标记为流失的客户占比',
 'COUNT(stat_cd=3) / COUNT(全部客户)'),
('DSO',       '应收账款周转天数', 'DSO,回款天数,收款周期',
 '从开票到收款的平均天数',
 'AVG(t_fin_rcv.aging_days) WHERE sts_cd IN (0,1,3)'),
('GROSS_MARGIN','毛利率',     '毛利,利润率',
 '(收入-成本)/收入 的百分比',
 '(SUM(ln_amt - qty*cost_prc)) / SUM(ln_amt)'),
('FILL_RATE', '目标完成率',   '达成率,完成率,target achievement',
 '实际销售额 / 目标销售额',
 'SUM(实际销售) / SUM(t_sal_tgt.tgt_amt)'),
('SKU_CNT',   '动销SKU数',    '活跃SKU,有销SKU',
 '统计周期内有过销售记录的不同产品数',
 'COUNT(DISTINCT prd_cd) FROM t_ord_dtl JOIN t_ord_hdr');

-- =============================================
-- 指标定义
-- =============================================
INSERT INTO t_idx_def (idx_cd, idx_nm, idx_tp, idx_lvl, biz_domain, unit_cd, agg_method, src_tbl, src_col, calc_expr, stat_freq) VALUES
-- 原子指标（直接取数）
('IDX_ORD_AMT',    '订单金额',       'A', 1, 'SALE', 'CNY', 'SUM', 't_ord_hdr', 'ord_amt', 'SUM(ord_amt)', 'D'),
('IDX_PAY_AMT',    '实付金额',       'A', 1, 'SALE', 'CNY', 'SUM', 't_ord_hdr', 'pay_amt', 'SUM(pay_amt)', 'D'),
('IDX_ORD_CNT',    '订单数',         'A', 1, 'SALE', 'PCS', 'COUNT', 't_ord_hdr', 'ord_no', 'COUNT(DISTINCT ord_no)', 'D'),
('IDX_CST_CNT',    '下单客户数',     'A', 1, 'SALE', 'PCS', 'COUNT', 't_ord_hdr', 'cst_no', 'COUNT(DISTINCT cst_no)', 'D'),
('IDX_QTY',        '销售数量',       'A', 1, 'SALE', 'PCS', 'SUM', 't_ord_dtl', 'qty', 'SUM(qty)', 'D'),
('IDX_DSC_AMT',    '折扣金额',       'A', 1, 'SALE', 'CNY', 'SUM', 't_ord_hdr', 'dsc_amt', 'SUM(dsc_amt)', 'D'),
('IDX_RCV_AMT',    '应收金额',       'A', 1, 'FIN',  'CNY', 'SUM', 't_fin_rcv', 'rcv_amt', 'SUM(rcv_amt)', 'D'),
('IDX_ACT_AMT',    '实收金额',       'A', 1, 'FIN',  'CNY', 'SUM', 't_fin_rcv', 'act_amt', 'SUM(act_amt)', 'D'),
('IDX_STK_QTY',    '库存数量',       'A', 1, 'OPS',  'PCS', 'SUM', 't_prd_inf', 'stk_qty', 'SUM(stk_qty)', 'D'),
('IDX_NEW_CST',    '新客户数',       'A', 1, 'MKT',  'PCS', 'COUNT', 't_cst_bas', 'cst_no', 'COUNT(DISTINCT cst_no) WHERE reg_dt = stat_dt', 'D'),

-- 派生指标（原子+条件/维度）
('IDX_GMV',        'GMV',            'D', 2, 'SALE', 'CNY', 'SUM', 't_ord_hdr', 'ord_amt',
 'SUM(ord_amt) -- 全部订单，不过滤状态', 'D'),
('IDX_REVENUE',    '营业收入',       'D', 2, 'SALE', 'CNY', 'SUM', 't_ord_hdr', 'pay_amt',
 'SUM(pay_amt) WHERE ord_st IN (''20'',''30'',''40'')', 'D'),
('IDX_CANCEL_AMT', '取消订单金额',   'D', 2, 'SALE', 'CNY', 'SUM', 't_ord_hdr', 'ord_amt',
 'SUM(ord_amt) WHERE ord_st = ''90''', 'D'),
('IDX_ONLINE_AMT', '线上销售额',     'D', 2, 'SALE', 'CNY', 'SUM', 't_ord_hdr', 'pay_amt',
 'SUM(pay_amt) WHERE chn_cd = ''ON'' AND ord_st IN (''20'',''30'',''40'')', 'D'),
('IDX_OVERDUE_AMT','逾期应收金额',   'D', 2, 'FIN',  'CNY', 'SUM', 't_fin_rcv', 'rcv_amt',
 'SUM(rcv_amt) WHERE sts_cd = ''3''', 'D'),

-- 复合指标（多指标运算）
('IDX_AOV',        '客单价',         'C', 3, 'SALE', 'CNY', 'AVG', NULL, NULL,
 'IDX_REVENUE / IDX_ORD_CNT', 'D'),
('IDX_ARPU',       'ARPU',           'C', 3, 'SALE', 'CNY', 'AVG', NULL, NULL,
 'IDX_REVENUE / IDX_CST_CNT', 'D'),
('IDX_RPR',        '复购率',         'C', 3, 'MKT',  'PCT', 'AVG', NULL, NULL,
 'COUNT(cst_no WHERE ord_cnt>=2) / IDX_CST_CNT', 'M'),
('IDX_CANCEL_RT',  '订单取消率',     'C', 3, 'OPS',  'PCT', 'AVG', NULL, NULL,
 'IDX_CANCEL_AMT / IDX_GMV * 100', 'D'),
('IDX_FILL_RATE',  '目标完成率',     'C', 3, 'SALE', 'PCT', 'AVG', NULL, NULL,
 'IDX_REVENUE / t_sal_tgt.tgt_amt * 100', 'M'),
('IDX_GROSS_MRG',  '毛利率',         'C', 3, 'FIN',  'PCT', 'AVG', NULL, NULL,
 '(SUM(ln_amt) - SUM(qty * cost_prc)) / SUM(ln_amt) * 100', 'M'),
('IDX_DSO',        '应收周转天数',   'C', 3, 'FIN',  'DAY', 'AVG', NULL, NULL,
 'AVG(aging_days) WHERE sts_cd IN (''0'',''1'',''3'')', 'M'),
('IDX_RCV_RATE',   '回款率',         'C', 3, 'FIN',  'PCT', 'AVG', NULL, NULL,
 'IDX_ACT_AMT / IDX_RCV_AMT * 100', 'M');

-- =============================================
-- 维度定义
-- =============================================
INSERT INTO t_dim_def (dim_cd, dim_nm, dim_tp, dim_tbl, dim_key, dim_label, hierarchy) VALUES
('DIM_TIME',     '时间维度',   'TIME', NULL,        NULL,      NULL,       '年,季,月,周,日'),
('DIM_RGN',      '区域维度',   'GEO',  't_dic_rgn', 'rgn_cd',  'rgn_nm',  '大区,省,市'),
('DIM_PRD_CLS',  '产品线维度', 'PROD', 't_prd_cls', 'cls_cd',  'cls_nm',  '一级分类,二级分类,三级分类'),
('DIM_CHN',      '渠道维度',   'ORG',  't_dic_chn', 'chn_cd',  'chn_nm',  '渠道'),
('DIM_CST_LVL',  '客户等级维度','CUST', 't_cst_bas', 'cst_lvl', 'cst_lvl', 'S,A,B,C,D'),
('DIM_CST_TP',   '客户类型维度','CUST', 't_cst_bas', 'cst_tp',  'cst_tp',  '个人,企业'),
('DIM_PAY_TP',   '支付方式维度','ORG',  NULL,        'pay_tp',  NULL,      '支付宝,微信,银行卡,对公'),
('DIM_ORD_ST',   '订单状态维度','ORG',  NULL,        'ord_st',  NULL,      '待付,已付,发货,完成,取消'),
('DIM_SLR',      '销售员维度', 'ORG',  't_sal_emp', 'emp_id',  'emp_nm',  '销售员');

-- =============================================
-- 指标-维度映射（哪些指标能按哪些维度下钻）
-- =============================================
INSERT INTO t_idx_dim_map (idx_cd, dim_cd, is_required) VALUES
-- GMV 可按时间(必选)、区域、产品线、渠道、客户等级下钻
('IDX_GMV',       'DIM_TIME',    1),
('IDX_GMV',       'DIM_RGN',     0),
('IDX_GMV',       'DIM_PRD_CLS', 0),
('IDX_GMV',       'DIM_CHN',     0),
('IDX_GMV',       'DIM_CST_LVL', 0),
-- 营业收入
('IDX_REVENUE',   'DIM_TIME',    1),
('IDX_REVENUE',   'DIM_RGN',     0),
('IDX_REVENUE',   'DIM_PRD_CLS', 0),
('IDX_REVENUE',   'DIM_CHN',     0),
('IDX_REVENUE',   'DIM_SLR',     0),
-- 客单价
('IDX_AOV',       'DIM_TIME',    1),
('IDX_AOV',       'DIM_RGN',     0),
('IDX_AOV',       'DIM_CHN',     0),
('IDX_AOV',       'DIM_CST_TP',  0),
-- ARPU
('IDX_ARPU',      'DIM_TIME',    1),
('IDX_ARPU',      'DIM_RGN',     0),
('IDX_ARPU',      'DIM_CST_LVL', 0),
-- 复购率
('IDX_RPR',       'DIM_TIME',    1),
('IDX_RPR',       'DIM_RGN',     0),
('IDX_RPR',       'DIM_CST_LVL', 0),
-- 毛利率
('IDX_GROSS_MRG', 'DIM_TIME',    1),
('IDX_GROSS_MRG', 'DIM_PRD_CLS', 0),
('IDX_GROSS_MRG', 'DIM_RGN',     0),
-- 目标完成率
('IDX_FILL_RATE', 'DIM_TIME',    1),
('IDX_FILL_RATE', 'DIM_RGN',     0),
('IDX_FILL_RATE', 'DIM_PRD_CLS', 0),
-- 回款率
('IDX_RCV_RATE',  'DIM_TIME',    1),
('IDX_RCV_RATE',  'DIM_RGN',     0),
-- 逾期应收
('IDX_OVERDUE_AMT','DIM_TIME',   1),
('IDX_OVERDUE_AMT','DIM_RGN',    0),
('IDX_OVERDUE_AMT','DIM_CST_LVL',0);

-- =============================================
-- 知识图谱 — 节点
-- =============================================
INSERT INTO kg_node (node_code, node_name, node_type, node_desc, ref_obj) VALUES
-- 表节点
('TBL_ORD_HDR',  '订单头表',       'TABLE',     '存储订单主信息',            't_ord_hdr'),
('TBL_ORD_DTL',  '订单明细表',     'TABLE',     '存储订单行项目',            't_ord_dtl'),
('TBL_CST_BAS',  '客户基本信息表', 'TABLE',     '客户主数据',                't_cst_bas'),
('TBL_PRD_INF',  '产品信息表',     'TABLE',     '产品主数据',                't_prd_inf'),
('TBL_PRD_CLS',  '产品分类表',     'TABLE',     '产品分类层级',              't_prd_cls'),
('TBL_SAL_TGT',  '销售目标表',     'TABLE',     '销售目标数据',              't_sal_tgt'),
('TBL_FIN_RCV',  '财务应收表',     'TABLE',     '应收账款',                  't_fin_rcv'),
('TBL_DIC_RGN',  '区域字典表',     'TABLE',     '区域编码表',                't_dic_rgn'),

-- 指标节点
('MTR_GMV',      'GMV',            'METRIC',    'Gross Merchandise Volume，总交易额', 'IDX_GMV'),
('MTR_REVENUE',  '营业收入',       'METRIC',    '已确认收入的实付金额',              'IDX_REVENUE'),
('MTR_AOV',      '客单价',         'METRIC',    '平均每单实付金额',                  'IDX_AOV'),
('MTR_ARPU',     'ARPU',           'METRIC',    '平均每用户收入',                    'IDX_ARPU'),
('MTR_RPR',      '复购率',         'METRIC',    '重复购买客户占比',                  'IDX_RPR'),
('MTR_GROSS',    '毛利率',         'METRIC',    '(收入-成本)/收入',                  'IDX_GROSS_MRG'),
('MTR_FILL',     '目标完成率',     'METRIC',    '实际/目标销售额',                   'IDX_FILL_RATE'),
('MTR_DSO',      '应收周转天数',   'METRIC',    '平均回款天数',                      'IDX_DSO'),
('MTR_CANCEL',   '订单取消率',     'METRIC',    '取消订单占比',                      'IDX_CANCEL_RT'),
('MTR_RCV_RATE', '回款率',         'METRIC',    '实收/应收',                         'IDX_RCV_RATE'),

-- 维度节点
('DIM_N_TIME',   '时间',           'DIMENSION', '日/周/月/季/年',                    'DIM_TIME'),
('DIM_N_RGN',    '区域',           'DIMENSION', '大区-省-市',                        'DIM_RGN'),
('DIM_N_PRD',    '产品线',         'DIMENSION', '产品分类层级',                      'DIM_PRD_CLS'),
('DIM_N_CHN',    '渠道',           'DIMENSION', '线上/线下/分销',                    'DIM_CHN'),
('DIM_N_CST',    '客户等级',       'DIMENSION', 'S/A/B/C/D',                         'DIM_CST_LVL'),

-- 业务概念节点
('CON_SALE',     '销售业务',       'CONCEPT',   '销售相关业务域',                    NULL),
('CON_FIN',      '财务业务',       'CONCEPT',   '财务相关业务域',                    NULL),
('CON_MKT',      '营销业务',       'CONCEPT',   '营销/客户运营',                     NULL),
('CON_ACTIVE',   '活跃客户',       'CONCEPT',   'stat_cd=1的客户',                   NULL),
('CON_CHURN',    '流失客户',       'CONCEPT',   'stat_cd=3的客户(90天未下单)',        NULL);

-- =============================================
-- 知识图谱 — 关系边
-- =============================================
INSERT INTO kg_edge (src_node_id, tgt_node_id, rel_type, rel_desc, weight) VALUES
-- GMV 的计算来源：从订单头表取 ord_amt
((SELECT node_id FROM kg_node WHERE node_code='MTR_GMV'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_ORD_HDR'),
 'CALC_FROM', 'GMV = SUM(t_ord_hdr.ord_amt)', 1.0),

-- 营业收入的计算来源
((SELECT node_id FROM kg_node WHERE node_code='MTR_REVENUE'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_ORD_HDR'),
 'CALC_FROM', '营业收入 = SUM(pay_amt) WHERE ord_st IN (20,30,40)', 1.0),

-- 客单价依赖营业收入和订单数
((SELECT node_id FROM kg_node WHERE node_code='MTR_AOV'),
 (SELECT node_id FROM kg_node WHERE node_code='MTR_REVENUE'),
 'DEPENDS_ON', '客单价 = 营业收入 / 订单数', 1.0),

-- ARPU 依赖营业收入和客户数
((SELECT node_id FROM kg_node WHERE node_code='MTR_ARPU'),
 (SELECT node_id FROM kg_node WHERE node_code='MTR_REVENUE'),
 'DEPENDS_ON', 'ARPU = 营业收入 / 下单客户数', 1.0),

-- 毛利率从订单明细和产品成本计算
((SELECT node_id FROM kg_node WHERE node_code='MTR_GROSS'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_ORD_DTL'),
 'CALC_FROM', '毛利率需要订单明细的行金额', 1.0),
((SELECT node_id FROM kg_node WHERE node_code='MTR_GROSS'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_PRD_INF'),
 'CALC_FROM', '毛利率需要产品成本价', 1.0),

-- 目标完成率依赖营业收入和销售目标
((SELECT node_id FROM kg_node WHERE node_code='MTR_FILL'),
 (SELECT node_id FROM kg_node WHERE node_code='MTR_REVENUE'),
 'DEPENDS_ON', '完成率 = 实际收入 / 目标', 1.0),
((SELECT node_id FROM kg_node WHERE node_code='MTR_FILL'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_SAL_TGT'),
 'CALC_FROM', '完成率需要目标金额', 1.0),

-- 回款率从应收表计算
((SELECT node_id FROM kg_node WHERE node_code='MTR_RCV_RATE'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_FIN_RCV'),
 'CALC_FROM', '回款率 = 实收 / 应收', 1.0),

-- 应收周转天数从应收表计算
((SELECT node_id FROM kg_node WHERE node_code='MTR_DSO'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_FIN_RCV'),
 'CALC_FROM', 'DSO = AVG(aging_days)', 1.0),

-- 订单取消率依赖 GMV
((SELECT node_id FROM kg_node WHERE node_code='MTR_CANCEL'),
 (SELECT node_id FROM kg_node WHERE node_code='MTR_GMV'),
 'DEPENDS_ON', '取消率 = 取消金额 / GMV', 1.0),

-- 表之间的关联关系
((SELECT node_id FROM kg_node WHERE node_code='TBL_ORD_HDR'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_ORD_DTL'),
 'CONTAINS', '订单头包含多个订单明细行(ord_no)', 1.0),
((SELECT node_id FROM kg_node WHERE node_code='TBL_ORD_HDR'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_CST_BAS'),
 'CONTAINS', '订单关联客户(cst_no)', 0.8),
((SELECT node_id FROM kg_node WHERE node_code='TBL_ORD_DTL'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_PRD_INF'),
 'CONTAINS', '订单明细关联产品(prd_cd)', 0.8),
((SELECT node_id FROM kg_node WHERE node_code='TBL_PRD_INF'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_PRD_CLS'),
 'BELONGS_TO', '产品属于某个分类(prd_cls_cd)', 0.8),
((SELECT node_id FROM kg_node WHERE node_code='TBL_ORD_HDR'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_DIC_RGN'),
 'BELONGS_TO', '订单归属区域(rgn_cd)', 0.6),

-- 指标属于业务域
((SELECT node_id FROM kg_node WHERE node_code='MTR_GMV'),
 (SELECT node_id FROM kg_node WHERE node_code='CON_SALE'),
 'BELONGS_TO', 'GMV是销售核心指标', 1.0),
((SELECT node_id FROM kg_node WHERE node_code='MTR_REVENUE'),
 (SELECT node_id FROM kg_node WHERE node_code='CON_SALE'),
 'BELONGS_TO', '营业收入是销售核心指标', 1.0),
((SELECT node_id FROM kg_node WHERE node_code='MTR_GROSS'),
 (SELECT node_id FROM kg_node WHERE node_code='CON_FIN'),
 'BELONGS_TO', '毛利率是财务指标', 1.0),
((SELECT node_id FROM kg_node WHERE node_code='MTR_RPR'),
 (SELECT node_id FROM kg_node WHERE node_code='CON_MKT'),
 'BELONGS_TO', '复购率是营销指标', 1.0),

-- 维度可下钻关系
((SELECT node_id FROM kg_node WHERE node_code='DIM_N_RGN'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_DIC_RGN'),
 'DRILL_DOWN', '区域维度下钻到区域字典', 1.0),
((SELECT node_id FROM kg_node WHERE node_code='DIM_N_PRD'),
 (SELECT node_id FROM kg_node WHERE node_code='TBL_PRD_CLS'),
 'DRILL_DOWN', '产品维度下钻到产品分类', 1.0),

-- 同义词关系
((SELECT node_id FROM kg_node WHERE node_code='MTR_GMV'),
 (SELECT node_id FROM kg_node WHERE node_code='MTR_REVENUE'),
 'SYNONYM', '注意: GMV包含未付款订单，营业收入不包含。常被混淆', 0.5);
