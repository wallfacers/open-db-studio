-- =============================================================
-- 指标 & 知识图谱 模拟环境 — MySQL Schema
-- 目的：模拟真实企业系统中表名/字段名不直观的场景，
--       AI 必须借助元数据和知识图谱才能正确理解并生成 SQL
-- =============================================================

CREATE DATABASE IF NOT EXISTS test_metrics DEFAULT CHARACTER SET utf8mb4;
USE test_metrics;

-- =============================================
-- Layer 1: 元数据层 — AI 的"知识词典"
-- =============================================

-- 表元数据：记录每张业务表的中文名和用途
CREATE TABLE IF NOT EXISTS sys_meta_tbl (
    tbl_id      INT PRIMARY KEY AUTO_INCREMENT,
    tbl_name    VARCHAR(64)  NOT NULL UNIQUE COMMENT '物理表名',
    tbl_cname   VARCHAR(128) NOT NULL COMMENT '中文表名',
    tbl_desc    TEXT         COMMENT '表用途说明',
    owner_sys   VARCHAR(32)  COMMENT '所属系统(ERP/CRM/FIN)',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) COMMENT='表元数据字典';

-- 列元数据：记录每列的中文名、业务含义
CREATE TABLE IF NOT EXISTS sys_meta_col (
    col_id      INT PRIMARY KEY AUTO_INCREMENT,
    tbl_name    VARCHAR(64)  NOT NULL COMMENT '物理表名',
    col_name    VARCHAR(64)  NOT NULL COMMENT '物理列名',
    col_cname   VARCHAR(128) NOT NULL COMMENT '中文列名',
    col_desc    TEXT         COMMENT '业务含义说明',
    data_type   VARCHAR(32)  COMMENT '逻辑数据类型',
    enum_values TEXT         COMMENT '枚举值说明(JSON)',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_tbl_col (tbl_name, col_name)
) COMMENT='列元数据字典';

-- 业务术语表：业务术语 → 含义映射
CREATE TABLE IF NOT EXISTS sys_biz_term (
    term_id     INT PRIMARY KEY AUTO_INCREMENT,
    term_code   VARCHAR(64)  NOT NULL UNIQUE COMMENT '术语编码',
    term_name   VARCHAR(128) NOT NULL COMMENT '术语名称',
    term_alias  VARCHAR(255) COMMENT '常用别名(逗号分隔)',
    term_desc   TEXT         COMMENT '术语定义',
    term_formula TEXT        COMMENT '计算口径说明',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) COMMENT='业务术语字典';

-- =============================================
-- Layer 2: 知识图谱层 — 实体关系网络
-- =============================================

-- 图谱节点：每个实体(表、字段、指标、维度、业务概念)
CREATE TABLE IF NOT EXISTS kg_node (
    node_id     INT PRIMARY KEY AUTO_INCREMENT,
    node_code   VARCHAR(64)  NOT NULL UNIQUE COMMENT '节点编码',
    node_name   VARCHAR(128) NOT NULL COMMENT '节点名称',
    node_type   VARCHAR(32)  NOT NULL COMMENT '节点类型: TABLE/COLUMN/METRIC/DIMENSION/CONCEPT',
    node_desc   TEXT         COMMENT '节点描述',
    ref_obj     VARCHAR(128) COMMENT '引用对象(表名.列名 或 指标编码)',
    extra_props JSON         COMMENT '扩展属性',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_node_type (node_type)
) COMMENT='知识图谱-节点';

-- 图谱边：节点间关系
CREATE TABLE IF NOT EXISTS kg_edge (
    edge_id     INT PRIMARY KEY AUTO_INCREMENT,
    src_node_id INT          NOT NULL COMMENT '源节点ID @ref:kg_node.node_id',
    tgt_node_id INT          NOT NULL COMMENT '目标节点ID [ref:kg_node.node_id]',
    rel_type    VARCHAR(32)  NOT NULL COMMENT '关系类型: CALC_FROM/CONTAINS/BELONGS_TO/SYNONYM/DEPENDS_ON/DRILL_DOWN',
    rel_desc    TEXT         COMMENT '关系说明',
    weight      DECIMAL(5,2) DEFAULT 1.0 COMMENT '关系权重',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (src_node_id) REFERENCES kg_node(node_id),
    FOREIGN KEY (tgt_node_id) REFERENCES kg_node(node_id),
    INDEX idx_edge_rel (rel_type),
    INDEX idx_edge_src (src_node_id),
    INDEX idx_edge_tgt (tgt_node_id)
) COMMENT='知识图谱-关系边';

-- =============================================
-- Layer 3: 指标体系层
-- =============================================

-- 指标定义
CREATE TABLE IF NOT EXISTS t_idx_def (
    idx_id      INT PRIMARY KEY AUTO_INCREMENT,
    idx_cd      VARCHAR(32)  NOT NULL UNIQUE COMMENT '指标编码',
    idx_nm      VARCHAR(128) NOT NULL COMMENT '指标名称',
    idx_tp      CHAR(1)      NOT NULL COMMENT '指标类型: A=原子/D=派生/C=复合',
    idx_lvl     TINYINT      DEFAULT 1 COMMENT '指标层级',
    biz_domain  VARCHAR(32)  COMMENT '业务域: SALE/FIN/OPS/MKT',
    unit_cd     VARCHAR(16)  COMMENT '单位: CNY/PCS/PCT/RATE',
    agg_method  VARCHAR(16)  COMMENT '聚合方式: SUM/AVG/COUNT/MAX/MIN',
    src_tbl     VARCHAR(64)  COMMENT '来源表',
    src_col     VARCHAR(64)  COMMENT '来源字段',
    calc_expr   TEXT         COMMENT '计算表达式',
    stat_freq   VARCHAR(8)   COMMENT '统计频率: D=日/W=周/M=月/Q=季/Y=年',
    status      CHAR(1)      DEFAULT '1' COMMENT '状态: 1=启用/0=停用',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_def_domain (biz_domain),
    INDEX idx_def_tp (idx_tp)
) COMMENT='指标定义表';

-- 维度定义
CREATE TABLE IF NOT EXISTS t_dim_def (
    dim_id      INT PRIMARY KEY AUTO_INCREMENT,
    dim_cd      VARCHAR(32)  NOT NULL UNIQUE COMMENT '维度编码',
    dim_nm      VARCHAR(128) NOT NULL COMMENT '维度名称',
    dim_tp      VARCHAR(16)  COMMENT '维度类型: TIME/GEO/ORG/PROD/CUST',
    dim_tbl     VARCHAR(64)  COMMENT '维度表',
    dim_key     VARCHAR(64)  COMMENT '维度主键列',
    dim_label   VARCHAR(64)  COMMENT '维度显示列',
    hierarchy   VARCHAR(255) COMMENT '层级路径(逗号分隔)',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) COMMENT='维度定义表';

-- 指标-维度映射
CREATE TABLE IF NOT EXISTS t_idx_dim_map (
    map_id      INT PRIMARY KEY AUTO_INCREMENT,
    idx_cd      VARCHAR(32) NOT NULL COMMENT '指标编码 @ref:t_idx_def.idx_cd',
    dim_cd      VARCHAR(32) NOT NULL COMMENT '维度编码 [ref:t_dim_def.dim_cd]',
    is_required TINYINT     DEFAULT 0 COMMENT '是否必选维度',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_idx_dim (idx_cd, dim_cd)
) COMMENT='指标维度映射表';

-- 指标日值（按天聚合的指标数据）
CREATE TABLE IF NOT EXISTS t_idx_val_d (
    val_id      BIGINT PRIMARY KEY AUTO_INCREMENT,
    idx_cd      VARCHAR(32)    NOT NULL COMMENT '指标编码 $$ref(t_idx_def.idx_cd)$$',
    stat_dt     DATE           NOT NULL COMMENT '统计日期',
    dim1_cd     VARCHAR(32)    COMMENT '维度1值(如区域编码)',
    dim2_cd     VARCHAR(32)    COMMENT '维度2值(如产品线编码)',
    dim3_cd     VARCHAR(32)    COMMENT '维度3值(如客户分组编码)',
    idx_val     DECIMAL(18,4)  COMMENT '指标值',
    cmp_val     DECIMAL(18,4)  COMMENT '对比值(同/环比基数)',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_val_dt (idx_cd, stat_dt),
    INDEX idx_val_dim1 (dim1_cd),
    INDEX idx_val_dim2 (dim2_cd)
) COMMENT='指标日值表';

-- =============================================
-- Layer 4: 业务表（故意用缩写命名，模拟真实系统）
-- =============================================

-- 客户基本信息
CREATE TABLE IF NOT EXISTS t_cst_bas (
    cst_id      INT PRIMARY KEY AUTO_INCREMENT,
    cst_no      VARCHAR(20)  NOT NULL UNIQUE COMMENT '客户编号',
    cst_nm      VARCHAR(64)  NOT NULL COMMENT '客户名称',
    cst_tp      CHAR(1)      NOT NULL COMMENT '客户类型: P=个人/E=企业',
    cst_lvl     CHAR(1)      DEFAULT 'C' COMMENT '客户等级: S/A/B/C/D',
    rgn_cd      VARCHAR(8)   COMMENT '区域编码 @ref:t_dic_rgn.rgn_cd',
    ind_cd      VARCHAR(8)   COMMENT '行业编码',
    reg_dt      DATE         COMMENT '注册日期',
    lst_ord_dt  DATE         COMMENT '最近下单日期',
    tot_ord_amt DECIMAL(14,2) DEFAULT 0 COMMENT '累计下单金额',
    tot_ord_cnt INT          DEFAULT 0 COMMENT '累计下单次数',
    stat_cd     CHAR(1)      DEFAULT '1' COMMENT '状态: 1=活跃/2=沉默/3=流失/0=注销',
    cr_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    up_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_cst_rgn (rgn_cd),
    INDEX idx_cst_lvl (cst_lvl),
    INDEX idx_cst_tp (cst_tp)
) COMMENT='客户基本信息表';

-- 客户分组
CREATE TABLE IF NOT EXISTS t_cst_grp (
    grp_id      INT PRIMARY KEY AUTO_INCREMENT,
    grp_cd      VARCHAR(16) NOT NULL UNIQUE COMMENT '分组编码',
    grp_nm      VARCHAR(64) NOT NULL COMMENT '分组名称',
    grp_rule    TEXT        COMMENT '分组规则说明',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) COMMENT='客户分组表';

-- 客户-分组关联
CREATE TABLE IF NOT EXISTS t_cst_grp_rel (
    id          INT PRIMARY KEY AUTO_INCREMENT,
    cst_no      VARCHAR(20) NOT NULL COMMENT '客户编号 @fk(table=t_cst_bas,col=cst_no,type=many_to_one)',
    grp_cd      VARCHAR(16) NOT NULL COMMENT '分组编码 [ref:t_cst_grp.grp_cd]',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_cst_grp (cst_no, grp_cd)
) COMMENT='客户分组关联表';

-- 产品信息
CREATE TABLE IF NOT EXISTS t_prd_inf (
    prd_id      INT PRIMARY KEY AUTO_INCREMENT,
    prd_cd      VARCHAR(20)  NOT NULL UNIQUE COMMENT '产品编码',
    prd_nm      VARCHAR(128) NOT NULL COMMENT '产品名称',
    prd_cls_cd  VARCHAR(8)   COMMENT '产品分类编码 [ref:t_prd_cls.cls_cd]',
    prd_brn     VARCHAR(32)  COMMENT '品牌',
    prd_spc     VARCHAR(64)  COMMENT '规格',
    unit_prc    DECIMAL(10,2) COMMENT '单价',
    cost_prc    DECIMAL(10,2) COMMENT '成本价',
    stk_qty     INT          DEFAULT 0 COMMENT '库存数量',
    stat_cd     CHAR(1)      DEFAULT '1' COMMENT '状态: 1=在售/2=停售/3=预售',
    cr_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    up_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_prd_cls (prd_cls_cd)
) COMMENT='产品信息表';

-- 产品分类
CREATE TABLE IF NOT EXISTS t_prd_cls (
    cls_id      INT PRIMARY KEY AUTO_INCREMENT,
    cls_cd      VARCHAR(8)  NOT NULL UNIQUE COMMENT '分类编码',
    cls_nm      VARCHAR(64) NOT NULL COMMENT '分类名称',
    par_cd      VARCHAR(8)  COMMENT '父分类编码 $$ref(t_prd_cls.cls_cd)$$',
    cls_lvl     TINYINT     DEFAULT 1 COMMENT '分类层级',
    srt_no      INT         DEFAULT 0 COMMENT '排序号',
    INDEX idx_cls_par (par_cd)
) COMMENT='产品分类表';

-- 订单头
CREATE TABLE IF NOT EXISTS t_ord_hdr (
    ord_id      BIGINT PRIMARY KEY AUTO_INCREMENT,
    ord_no      VARCHAR(32) NOT NULL UNIQUE COMMENT '订单编号',
    cst_no      VARCHAR(20) NOT NULL COMMENT '客户编号 @ref:t_cst_bas.cst_no',
    ord_dt      DATE        NOT NULL COMMENT '下单日期',
    ord_tm      TIMESTAMP   COMMENT '下单时间',
    ord_amt     DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '订单金额',
    dsc_amt     DECIMAL(10,2) DEFAULT 0 COMMENT '折扣金额',
    pay_amt     DECIMAL(14,2) DEFAULT 0 COMMENT '实付金额',
    ord_st      CHAR(2)     DEFAULT '10' COMMENT '订单状态: 10=待付/20=已付/30=发货/40=完成/90=取消',
    pay_tp      CHAR(1)     COMMENT '支付方式: 1=支付宝/2=微信/3=银行卡/4=对公转账',
    rgn_cd      VARCHAR(8)  COMMENT '下单区域 [ref:t_dic_rgn.rgn_cd]',
    chn_cd      VARCHAR(8)  COMMENT '渠道编码: ON=线上/OF=线下/DL=分销 $$ref(t_dic_chn.chn_cd)$$',
    slr_id      INT         COMMENT '销售员ID @fk(table=t_sal_emp,col=emp_id,type=many_to_one)',
    rmk         VARCHAR(255) COMMENT '备注',
    cr_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    up_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ord_cst (cst_no),
    INDEX idx_ord_dt (ord_dt),
    INDEX idx_ord_st (ord_st),
    INDEX idx_ord_rgn (rgn_cd),
    INDEX idx_ord_chn (chn_cd)
) COMMENT='订单头表';

-- 订单明细
CREATE TABLE IF NOT EXISTS t_ord_dtl (
    dtl_id      BIGINT PRIMARY KEY AUTO_INCREMENT,
    ord_no      VARCHAR(32) NOT NULL COMMENT '订单编号 @fk(table=t_ord_hdr,col=ord_no,type=many_to_one)',
    ln_no       SMALLINT    NOT NULL COMMENT '行号',
    prd_cd      VARCHAR(20) NOT NULL COMMENT '产品编码 @ref:t_prd_inf.prd_cd',
    qty         INT         NOT NULL DEFAULT 1 COMMENT '数量',
    unit_prc    DECIMAL(10,2) NOT NULL COMMENT '单价',
    ln_amt      DECIMAL(12,2) NOT NULL COMMENT '行金额',
    dsc_amt     DECIMAL(10,2) DEFAULT 0 COMMENT '行折扣',
    cr_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ord_ln (ord_no, ln_no),
    INDEX idx_dtl_prd (prd_cd)
) COMMENT='订单明细表';

-- 销售目标
CREATE TABLE IF NOT EXISTS t_sal_tgt (
    tgt_id      INT PRIMARY KEY AUTO_INCREMENT,
    tgt_yr      SMALLINT    NOT NULL COMMENT '目标年份',
    tgt_mn      TINYINT     NOT NULL COMMENT '目标月份',
    rgn_cd      VARCHAR(8)  COMMENT '区域编码 [ref:t_dic_rgn.rgn_cd]',
    prd_cls_cd  VARCHAR(8)  COMMENT '产品线编码 $$ref(t_prd_cls.cls_cd)$$',
    tgt_amt     DECIMAL(14,2) NOT NULL COMMENT '目标金额',
    tgt_cnt     INT         COMMENT '目标订单数',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_tgt (tgt_yr, tgt_mn, rgn_cd, prd_cls_cd)
) COMMENT='销售目标表';

-- 财务应收
CREATE TABLE IF NOT EXISTS t_fin_rcv (
    rcv_id      BIGINT PRIMARY KEY AUTO_INCREMENT,
    rcv_no      VARCHAR(32) NOT NULL UNIQUE COMMENT '应收编号',
    ord_no      VARCHAR(32) NOT NULL COMMENT '关联订单号 @fk(table=t_ord_hdr,col=ord_no,type=one_to_one)',
    cst_no      VARCHAR(20) NOT NULL COMMENT '客户编号 @ref:t_cst_bas.cst_no',
    rcv_amt     DECIMAL(14,2) NOT NULL COMMENT '应收金额',
    rcv_dt      DATE        NOT NULL COMMENT '应收日期',
    act_amt     DECIMAL(14,2) DEFAULT 0 COMMENT '实收金额',
    act_dt      DATE        COMMENT '实收日期',
    sts_cd      CHAR(1)     DEFAULT '0' COMMENT '状态: 0=未收/1=部分/2=已收/3=逾期',
    aging_days  INT         DEFAULT 0 COMMENT '账龄天数',
    cr_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_rcv_cst (cst_no),
    INDEX idx_rcv_sts (sts_cd),
    INDEX idx_rcv_dt (rcv_dt)
) COMMENT='财务应收表';

-- 区域字典
CREATE TABLE IF NOT EXISTS t_dic_rgn (
    rgn_cd      VARCHAR(8) PRIMARY KEY COMMENT '区域编码',
    rgn_nm      VARCHAR(32) NOT NULL COMMENT '区域名称',
    par_cd      VARCHAR(8)  COMMENT '上级区域 $$ref(t_dic_rgn.rgn_cd)$$',
    rgn_lvl     TINYINT     DEFAULT 1 COMMENT '层级: 1=大区/2=省/3=市',
    INDEX idx_rgn_par (par_cd)
) COMMENT='区域字典表';

-- 渠道字典
CREATE TABLE IF NOT EXISTS t_dic_chn (
    chn_cd      VARCHAR(8) PRIMARY KEY COMMENT '渠道编码',
    chn_nm      VARCHAR(32) NOT NULL COMMENT '渠道名称'
) COMMENT='渠道字典表';

-- 销售员表
CREATE TABLE IF NOT EXISTS t_sal_emp (
    emp_id      INT PRIMARY KEY AUTO_INCREMENT,
    emp_no      VARCHAR(16) NOT NULL UNIQUE COMMENT '工号',
    emp_nm      VARCHAR(32) NOT NULL COMMENT '姓名',
    rgn_cd      VARCHAR(8)  COMMENT '负责区域 @ref:t_dic_rgn.rgn_cd',
    dept_cd     VARCHAR(16) COMMENT '部门编码',
    stat_cd     CHAR(1)     DEFAULT '1' COMMENT '状态: 1=在职/0=离职',
    INDEX idx_emp_rgn (rgn_cd)
) COMMENT='销售员表';
