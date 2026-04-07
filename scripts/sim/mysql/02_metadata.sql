-- =============================================================
-- 元数据 & 业务术语 — AI 理解业务表的关键知识源
-- =============================================================

USE test_metrics;

-- =============================================
-- 表元数据
-- =============================================
INSERT INTO sys_meta_tbl (tbl_name, tbl_cname, tbl_desc, owner_sys) VALUES
('t_cst_bas',     '客户基本信息表', '存储所有客户的基础档案信息，包括类型、等级、区域等', 'CRM'),
('t_cst_grp',     '客户分组表',     '定义客户分组规则，如VIP、高潜力、沉睡客户等',     'CRM'),
('t_cst_grp_rel', '客户分组关联表', '客户与分组的多对多关联',                         'CRM'),
('t_prd_inf',     '产品信息表',     '产品主数据，包含编码、名称、价格、库存等',         'ERP'),
('t_prd_cls',     '产品分类表',     '产品分类层级树，支持多级分类',                     'ERP'),
('t_ord_hdr',     '订单头表',       '订单主信息，包含金额、状态、渠道、区域等',         'ERP'),
('t_ord_dtl',     '订单明细表',     '订单行项目，每行对应一个产品的数量和金额',         'ERP'),
('t_sal_tgt',     '销售目标表',     '按月/区域/产品线设定的销售目标',                   'FIN'),
('t_fin_rcv',     '财务应收表',     '应收账款记录，跟踪回款状态和账龄',                 'FIN'),
('t_dic_rgn',     '区域字典表',     '大区-省-市三级区域编码',                           'SYS'),
('t_dic_chn',     '渠道字典表',     '销售渠道编码(线上/线下/分销)',                      'SYS'),
('t_sal_emp',     '销售员表',       '销售人员档案及负责区域',                           'CRM'),
('t_idx_def',     '指标定义表',     '所有业务指标的定义、计算口径、来源',               'BI'),
('t_dim_def',     '维度定义表',     '分析维度定义(时间/区域/产品/客户)',                 'BI'),
('t_idx_dim_map', '指标维度映射表', '指标可以按哪些维度进行下钻分析',                   'BI'),
('t_idx_val_d',   '指标日值表',     '按天聚合的指标计算结果，支持多维度',               'BI'),
('kg_node',       '知识图谱节点表', '业务知识图谱的实体节点',                           'BI'),
('kg_edge',       '知识图谱关系表', '节点间的关系(计算来源、包含、同义等)',               'BI');

-- =============================================
-- 列元数据（选取最关键的、最不直观的列）
-- =============================================
INSERT INTO sys_meta_col (tbl_name, col_name, col_cname, col_desc, data_type, enum_values) VALUES
-- t_cst_bas
('t_cst_bas', 'cst_no',      '客户编号',     '客户唯一业务编号，格式: C+8位数字',    'VARCHAR', NULL),
('t_cst_bas', 'cst_nm',      '客户名称',     '个人为姓名，企业为公司全称',           'VARCHAR', NULL),
('t_cst_bas', 'cst_tp',      '客户类型',     '客户性质分类',                         'CHAR',    '{"P":"个人客户","E":"企业客户"}'),
('t_cst_bas', 'cst_lvl',     '客户等级',     '根据累计消费和活跃度评定',             'CHAR',    '{"S":"战略客户","A":"重要客户","B":"一般客户","C":"普通客户","D":"低价值客户"}'),
('t_cst_bas', 'rgn_cd',      '区域编码',     '客户所在区域，关联t_dic_rgn',          'VARCHAR', NULL),
('t_cst_bas', 'ind_cd',      '行业编码',     '企业客户所属行业分类编码',             'VARCHAR', NULL),
('t_cst_bas', 'lst_ord_dt',  '最近下单日期', '客户最近一次下单时间，用于活跃度判断', 'DATE',    NULL),
('t_cst_bas', 'tot_ord_amt', '累计下单金额', '客户历史累计下单总金额(元)',           'DECIMAL', NULL),
('t_cst_bas', 'tot_ord_cnt', '累计下单次数', '客户历史累计下单总次数',               'INT',     NULL),
('t_cst_bas', 'stat_cd',     '状态码',       '客户当前活跃状态',                     'CHAR',    '{"1":"活跃","2":"沉默(30天未下单)","3":"流失(90天未下单)","0":"注销"}'),

-- t_prd_inf
('t_prd_inf', 'prd_cd',      '产品编码',   '产品唯一编码，格式: P+6位数字',        'VARCHAR', NULL),
('t_prd_inf', 'prd_nm',      '产品名称',   '产品完整名称',                         'VARCHAR', NULL),
('t_prd_inf', 'prd_cls_cd',  '产品分类编码','关联t_prd_cls.cls_cd',                'VARCHAR', NULL),
('t_prd_inf', 'prd_brn',     '品牌',       '产品品牌名称',                         'VARCHAR', NULL),
('t_prd_inf', 'prd_spc',     '规格',       '产品规格描述(如500ml, 1kg)',           'VARCHAR', NULL),
('t_prd_inf', 'unit_prc',    '单价',       '产品标准售价(元)',                     'DECIMAL', NULL),
('t_prd_inf', 'cost_prc',    '成本价',     '产品采购/生产成本(元)',                'DECIMAL', NULL),
('t_prd_inf', 'stk_qty',     '库存数量',   '当前可售库存数量',                     'INT',     NULL),
('t_prd_inf', 'stat_cd',     '状态码',     '产品上下架状态',                       'CHAR',    '{"1":"在售","2":"停售","3":"预售"}'),

-- t_ord_hdr
('t_ord_hdr', 'ord_no',  '订单编号',   '订单唯一编号，格式: ORD+年月日+序号',     'VARCHAR', NULL),
('t_ord_hdr', 'cst_no',  '客户编号',   '下单客户，关联t_cst_bas.cst_no',         'VARCHAR', NULL),
('t_ord_hdr', 'ord_dt',  '下单日期',   '订单创建日期',                           'DATE',    NULL),
('t_ord_hdr', 'ord_amt', '订单金额',   '订单原始总金额(折前)',                   'DECIMAL', NULL),
('t_ord_hdr', 'dsc_amt', '折扣金额',   '订单折扣减免金额',                       'DECIMAL', NULL),
('t_ord_hdr', 'pay_amt', '实付金额',   '客户实际支付金额 = ord_amt - dsc_amt',   'DECIMAL', NULL),
('t_ord_hdr', 'ord_st',  '订单状态',   '订单生命周期状态',                       'CHAR',    '{"10":"待付款","20":"已付款","30":"已发货","40":"已完成","90":"已取消"}'),
('t_ord_hdr', 'pay_tp',  '支付方式',   '客户选择的支付渠道',                     'CHAR',    '{"1":"支付宝","2":"微信支付","3":"银行卡","4":"对公转账"}'),
('t_ord_hdr', 'rgn_cd',  '下单区域',   '订单归属区域，关联t_dic_rgn',            'VARCHAR', NULL),
('t_ord_hdr', 'chn_cd',  '渠道编码',   '订单来源渠道，关联t_dic_chn',            'VARCHAR', NULL),
('t_ord_hdr', 'slr_id',  '销售员ID',   '负责该订单的销售人员，关联t_sal_emp',    'INT',     NULL),

-- t_ord_dtl
('t_ord_dtl', 'ord_no',   '订单编号', '关联t_ord_hdr.ord_no',                   'VARCHAR', NULL),
('t_ord_dtl', 'ln_no',    '行号',     '同一订单内的行项目序号',                 'SMALLINT',NULL),
('t_ord_dtl', 'prd_cd',   '产品编码', '关联t_prd_inf.prd_cd',                   'VARCHAR', NULL),
('t_ord_dtl', 'qty',      '数量',     '购买数量',                               'INT',     NULL),
('t_ord_dtl', 'unit_prc', '单价',     '成交单价(可能与产品标价不同)',           'DECIMAL', NULL),
('t_ord_dtl', 'ln_amt',   '行金额',   '该行总金额 = qty * unit_prc',           'DECIMAL', NULL),
('t_ord_dtl', 'dsc_amt',  '行折扣',   '该行折扣金额',                           'DECIMAL', NULL),

-- t_sal_tgt
('t_sal_tgt', 'tgt_yr',     '目标年份',   '销售目标年份',                       'SMALLINT',NULL),
('t_sal_tgt', 'tgt_mn',     '目标月份',   '销售目标月份(1-12)',                 'TINYINT', NULL),
('t_sal_tgt', 'rgn_cd',     '区域编码',   '目标归属区域',                       'VARCHAR', NULL),
('t_sal_tgt', 'prd_cls_cd', '产品线编码', '目标归属产品分类',                   'VARCHAR', NULL),
('t_sal_tgt', 'tgt_amt',    '目标金额',   '该月该维度的销售目标金额(元)',       'DECIMAL', NULL),
('t_sal_tgt', 'tgt_cnt',    '目标订单数', '该月该维度的目标订单数',             'INT',     NULL),

-- t_fin_rcv
('t_fin_rcv', 'rcv_no',     '应收编号',   '应收单据编号',                       'VARCHAR', NULL),
('t_fin_rcv', 'rcv_amt',    '应收金额',   '应收账款金额(元)',                   'DECIMAL', NULL),
('t_fin_rcv', 'act_amt',    '实收金额',   '实际收款金额(元)',                   'DECIMAL', NULL),
('t_fin_rcv', 'sts_cd',     '状态码',     '回款状态',                           'CHAR',    '{"0":"未收款","1":"部分收款","2":"已收齐","3":"逾期未收"}'),
('t_fin_rcv', 'aging_days', '账龄天数',   '从应收日期到当前的天数',             'INT',     NULL),

-- t_idx_def
('t_idx_def', 'idx_cd',     '指标编码',   '指标唯一编码',                       'VARCHAR', NULL),
('t_idx_def', 'idx_nm',     '指标名称',   '指标中文名称',                       'VARCHAR', NULL),
('t_idx_def', 'idx_tp',     '指标类型',   '指标抽象层级',                       'CHAR',    '{"A":"原子指标(直接取数)","D":"派生指标(原子+维度)","C":"复合指标(多指标计算)"}'),
('t_idx_def', 'biz_domain', '业务域',     '指标所属业务领域',                   'VARCHAR', '{"SALE":"销售","FIN":"财务","OPS":"运营","MKT":"营销"}'),
('t_idx_def', 'agg_method', '聚合方式',   '指标值的默认聚合方法',               'VARCHAR', NULL),
('t_idx_def', 'calc_expr',  '计算表达式', '指标计算SQL或公式',                   'TEXT',    NULL);
