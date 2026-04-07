-- =============================================================
-- 指标 & 知识图谱 模拟环境 — PostgreSQL Schema
-- 目的：模拟真实企业系统中表名/字段名不直观的场景，
--       AI 必须借助元数据和知识图谱才能正确理解并生成 SQL
-- =============================================================

-- 建库需要单独执行: CREATE DATABASE test_metrics;
-- 然后连接到 test_metrics 数据库执行以下脚本

-- =============================================
-- Layer 1: 元数据层 — AI 的"知识词典"
-- =============================================

CREATE TABLE IF NOT EXISTS sys_meta_tbl (
    tbl_id      SERIAL PRIMARY KEY,
    tbl_name    VARCHAR(64)  NOT NULL UNIQUE,
    tbl_cname   VARCHAR(128) NOT NULL,
    tbl_desc    TEXT,
    owner_sys   VARCHAR(32),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE sys_meta_tbl IS '表元数据字典';
COMMENT ON COLUMN sys_meta_tbl.tbl_name IS '物理表名';
COMMENT ON COLUMN sys_meta_tbl.tbl_cname IS '中文表名';
COMMENT ON COLUMN sys_meta_tbl.owner_sys IS '所属系统(ERP/CRM/FIN)';

CREATE TABLE IF NOT EXISTS sys_meta_col (
    col_id      SERIAL PRIMARY KEY,
    tbl_name    VARCHAR(64)  NOT NULL,
    col_name    VARCHAR(64)  NOT NULL,
    col_cname   VARCHAR(128) NOT NULL,
    col_desc    TEXT,
    data_type   VARCHAR(32),
    enum_values TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tbl_name, col_name)
);
COMMENT ON TABLE sys_meta_col IS '列元数据字典';
COMMENT ON COLUMN sys_meta_col.col_cname IS '中文列名';
COMMENT ON COLUMN sys_meta_col.enum_values IS '枚举值说明(JSON)';

CREATE TABLE IF NOT EXISTS sys_biz_term (
    term_id     SERIAL PRIMARY KEY,
    term_code   VARCHAR(64)  NOT NULL UNIQUE,
    term_name   VARCHAR(128) NOT NULL,
    term_alias  VARCHAR(255),
    term_desc   TEXT,
    term_formula TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE sys_biz_term IS '业务术语字典';

-- =============================================
-- Layer 2: 知识图谱层
-- =============================================

CREATE TABLE IF NOT EXISTS kg_node (
    node_id     SERIAL PRIMARY KEY,
    node_code   VARCHAR(64)  NOT NULL UNIQUE,
    node_name   VARCHAR(128) NOT NULL,
    node_type   VARCHAR(32)  NOT NULL,
    node_desc   TEXT,
    ref_obj     VARCHAR(128),
    extra_props JSONB,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE kg_node IS '知识图谱-节点';
COMMENT ON COLUMN kg_node.node_type IS '节点类型: TABLE/COLUMN/METRIC/DIMENSION/CONCEPT';
CREATE INDEX IF NOT EXISTS idx_node_type ON kg_node(node_type);

CREATE TABLE IF NOT EXISTS kg_edge (
    edge_id     SERIAL PRIMARY KEY,
    src_node_id INT NOT NULL REFERENCES kg_node(node_id),
    tgt_node_id INT NOT NULL REFERENCES kg_node(node_id),
    rel_type    VARCHAR(32) NOT NULL,
    rel_desc    TEXT,
    weight      DECIMAL(5,2) DEFAULT 1.0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE kg_edge IS '知识图谱-关系边';
COMMENT ON COLUMN kg_edge.rel_type IS '关系类型: CALC_FROM/CONTAINS/BELONGS_TO/SYNONYM/DEPENDS_ON/DRILL_DOWN';
CREATE INDEX IF NOT EXISTS idx_edge_rel ON kg_edge(rel_type);
CREATE INDEX IF NOT EXISTS idx_edge_src ON kg_edge(src_node_id);
CREATE INDEX IF NOT EXISTS idx_edge_tgt ON kg_edge(tgt_node_id);

-- =============================================
-- Layer 3: 指标体系层
-- =============================================

CREATE TABLE IF NOT EXISTS t_idx_def (
    idx_id      SERIAL PRIMARY KEY,
    idx_cd      VARCHAR(32)  NOT NULL UNIQUE,
    idx_nm      VARCHAR(128) NOT NULL,
    idx_tp      CHAR(1)      NOT NULL,
    idx_lvl     SMALLINT     DEFAULT 1,
    biz_domain  VARCHAR(32),
    unit_cd     VARCHAR(16),
    agg_method  VARCHAR(16),
    src_tbl     VARCHAR(64),
    src_col     VARCHAR(64),
    calc_expr   TEXT,
    stat_freq   VARCHAR(8),
    status      CHAR(1)      DEFAULT '1',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE t_idx_def IS '指标定义表';
COMMENT ON COLUMN t_idx_def.idx_tp IS '指标类型: A=原子/D=派生/C=复合';
COMMENT ON COLUMN t_idx_def.biz_domain IS '业务域: SALE/FIN/OPS/MKT';
CREATE INDEX IF NOT EXISTS idx_def_domain ON t_idx_def(biz_domain);
CREATE INDEX IF NOT EXISTS idx_def_tp ON t_idx_def(idx_tp);

CREATE TABLE IF NOT EXISTS t_dim_def (
    dim_id      SERIAL PRIMARY KEY,
    dim_cd      VARCHAR(32)  NOT NULL UNIQUE,
    dim_nm      VARCHAR(128) NOT NULL,
    dim_tp      VARCHAR(16),
    dim_tbl     VARCHAR(64),
    dim_key     VARCHAR(64),
    dim_label   VARCHAR(64),
    hierarchy   VARCHAR(255),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE t_dim_def IS '维度定义表';

CREATE TABLE IF NOT EXISTS t_idx_dim_map (
    map_id      SERIAL PRIMARY KEY,
    idx_cd      VARCHAR(32) NOT NULL,
    dim_cd      VARCHAR(32) NOT NULL,
    is_required SMALLINT    DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (idx_cd, dim_cd)
);
COMMENT ON TABLE t_idx_dim_map IS '指标维度映射表';

CREATE TABLE IF NOT EXISTS t_idx_val_d (
    val_id      BIGSERIAL PRIMARY KEY,
    idx_cd      VARCHAR(32)    NOT NULL,
    stat_dt     DATE           NOT NULL,
    dim1_cd     VARCHAR(32),
    dim2_cd     VARCHAR(32),
    dim3_cd     VARCHAR(32),
    idx_val     DECIMAL(18,4),
    cmp_val     DECIMAL(18,4),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE t_idx_val_d IS '指标日值表';
CREATE INDEX IF NOT EXISTS idx_val_dt ON t_idx_val_d(idx_cd, stat_dt);
CREATE INDEX IF NOT EXISTS idx_val_dim1 ON t_idx_val_d(dim1_cd);

-- =============================================
-- Layer 4: 业务表
-- =============================================

CREATE TABLE IF NOT EXISTS t_cst_bas (
    cst_id      SERIAL PRIMARY KEY,
    cst_no      VARCHAR(20)  NOT NULL UNIQUE,
    cst_nm      VARCHAR(64)  NOT NULL,
    cst_tp      CHAR(1)      NOT NULL,
    cst_lvl     CHAR(1)      DEFAULT 'C',
    rgn_cd      VARCHAR(8),
    ind_cd      VARCHAR(8),
    reg_dt      DATE,
    lst_ord_dt  DATE,
    tot_ord_amt DECIMAL(14,2) DEFAULT 0,
    tot_ord_cnt INT          DEFAULT 0,
    stat_cd     CHAR(1)      DEFAULT '1',
    cr_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    up_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE t_cst_bas IS '客户基本信息表';
COMMENT ON COLUMN t_cst_bas.cst_tp IS '客户类型: P=个人/E=企业';
COMMENT ON COLUMN t_cst_bas.cst_lvl IS '客户等级: S/A/B/C/D';
COMMENT ON COLUMN t_cst_bas.stat_cd IS '状态: 1=活跃/2=沉默/3=流失/0=注销';

CREATE TABLE IF NOT EXISTS t_cst_grp (
    grp_id      SERIAL PRIMARY KEY,
    grp_cd      VARCHAR(16) NOT NULL UNIQUE,
    grp_nm      VARCHAR(64) NOT NULL,
    grp_rule    TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS t_cst_grp_rel (
    id          SERIAL PRIMARY KEY,
    cst_no      VARCHAR(20) NOT NULL,
    grp_cd      VARCHAR(16) NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (cst_no, grp_cd)
);

CREATE TABLE IF NOT EXISTS t_prd_inf (
    prd_id      SERIAL PRIMARY KEY,
    prd_cd      VARCHAR(20)  NOT NULL UNIQUE,
    prd_nm      VARCHAR(128) NOT NULL,
    prd_cls_cd  VARCHAR(8),
    prd_brn     VARCHAR(32),
    prd_spc     VARCHAR(64),
    unit_prc    DECIMAL(10,2),
    cost_prc    DECIMAL(10,2),
    stk_qty     INT          DEFAULT 0,
    stat_cd     CHAR(1)      DEFAULT '1',
    cr_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    up_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE t_prd_inf IS '产品信息表';
COMMENT ON COLUMN t_prd_inf.stat_cd IS '状态: 1=在售/2=停售/3=预售';

CREATE TABLE IF NOT EXISTS t_prd_cls (
    cls_id      SERIAL PRIMARY KEY,
    cls_cd      VARCHAR(8)  NOT NULL UNIQUE,
    cls_nm      VARCHAR(64) NOT NULL,
    par_cd      VARCHAR(8),
    cls_lvl     SMALLINT    DEFAULT 1,
    srt_no      INT         DEFAULT 0
);
COMMENT ON TABLE t_prd_cls IS '产品分类表';

CREATE TABLE IF NOT EXISTS t_ord_hdr (
    ord_id      BIGSERIAL PRIMARY KEY,
    ord_no      VARCHAR(32) NOT NULL UNIQUE,
    cst_no      VARCHAR(20) NOT NULL,
    ord_dt      DATE        NOT NULL,
    ord_tm      TIMESTAMP,
    ord_amt     DECIMAL(14,2) NOT NULL DEFAULT 0,
    dsc_amt     DECIMAL(10,2) DEFAULT 0,
    pay_amt     DECIMAL(14,2) DEFAULT 0,
    ord_st      CHAR(2)     DEFAULT '10',
    pay_tp      CHAR(1),
    rgn_cd      VARCHAR(8),
    chn_cd      VARCHAR(8),
    slr_id      INT,
    rmk         VARCHAR(255),
    cr_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    up_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE t_ord_hdr IS '订单头表';
COMMENT ON COLUMN t_ord_hdr.ord_st IS '订单状态: 10=待付/20=已付/30=发货/40=完成/90=取消';
COMMENT ON COLUMN t_ord_hdr.pay_tp IS '支付方式: 1=支付宝/2=微信/3=银行卡/4=对公转账';
COMMENT ON COLUMN t_ord_hdr.chn_cd IS '渠道: ON=线上/OF=线下/DL=分销';
CREATE INDEX IF NOT EXISTS idx_ord_cst ON t_ord_hdr(cst_no);
CREATE INDEX IF NOT EXISTS idx_ord_dt ON t_ord_hdr(ord_dt);
CREATE INDEX IF NOT EXISTS idx_ord_st ON t_ord_hdr(ord_st);

CREATE TABLE IF NOT EXISTS t_ord_dtl (
    dtl_id      BIGSERIAL PRIMARY KEY,
    ord_no      VARCHAR(32) NOT NULL,
    ln_no       SMALLINT    NOT NULL,
    prd_cd      VARCHAR(20) NOT NULL,
    qty         INT         NOT NULL DEFAULT 1,
    unit_prc    DECIMAL(10,2) NOT NULL,
    ln_amt      DECIMAL(12,2) NOT NULL,
    dsc_amt     DECIMAL(10,2) DEFAULT 0,
    cr_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (ord_no, ln_no)
);
COMMENT ON TABLE t_ord_dtl IS '订单明细表';

CREATE TABLE IF NOT EXISTS t_sal_tgt (
    tgt_id      SERIAL PRIMARY KEY,
    tgt_yr      SMALLINT    NOT NULL,
    tgt_mn      SMALLINT    NOT NULL,
    rgn_cd      VARCHAR(8),
    prd_cls_cd  VARCHAR(8),
    tgt_amt     DECIMAL(14,2) NOT NULL,
    tgt_cnt     INT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tgt_yr, tgt_mn, rgn_cd, prd_cls_cd)
);
COMMENT ON TABLE t_sal_tgt IS '销售目标表';

CREATE TABLE IF NOT EXISTS t_fin_rcv (
    rcv_id      BIGSERIAL PRIMARY KEY,
    rcv_no      VARCHAR(32) NOT NULL UNIQUE,
    ord_no      VARCHAR(32) NOT NULL,
    cst_no      VARCHAR(20) NOT NULL,
    rcv_amt     DECIMAL(14,2) NOT NULL,
    rcv_dt      DATE        NOT NULL,
    act_amt     DECIMAL(14,2) DEFAULT 0,
    act_dt      DATE,
    sts_cd      CHAR(1)     DEFAULT '0',
    aging_days  INT         DEFAULT 0,
    cr_tm       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE t_fin_rcv IS '财务应收表';
COMMENT ON COLUMN t_fin_rcv.sts_cd IS '状态: 0=未收/1=部分/2=已收/3=逾期';
CREATE INDEX IF NOT EXISTS idx_rcv_cst ON t_fin_rcv(cst_no);
CREATE INDEX IF NOT EXISTS idx_rcv_sts ON t_fin_rcv(sts_cd);

CREATE TABLE IF NOT EXISTS t_dic_rgn (
    rgn_cd      VARCHAR(8) PRIMARY KEY,
    rgn_nm      VARCHAR(32) NOT NULL,
    par_cd      VARCHAR(8),
    rgn_lvl     SMALLINT    DEFAULT 1
);
COMMENT ON TABLE t_dic_rgn IS '区域字典表';

CREATE TABLE IF NOT EXISTS t_dic_chn (
    chn_cd      VARCHAR(8) PRIMARY KEY,
    chn_nm      VARCHAR(32) NOT NULL
);
COMMENT ON TABLE t_dic_chn IS '渠道字典表';

CREATE TABLE IF NOT EXISTS t_sal_emp (
    emp_id      SERIAL PRIMARY KEY,
    emp_no      VARCHAR(16) NOT NULL UNIQUE,
    emp_nm      VARCHAR(32) NOT NULL,
    rgn_cd      VARCHAR(8),
    dept_cd     VARCHAR(16),
    stat_cd     CHAR(1)     DEFAULT '1'
);
COMMENT ON TABLE t_sal_emp IS '销售员表';

-- =============================================
-- 虚拟关系标记（4种格式覆盖）
-- comment_parser.rs 会从这些注释中提取关系
-- =============================================

-- 格式1: @ref:table.col（简写，默认 fk）
COMMENT ON COLUMN kg_edge.src_node_id IS '源节点ID @ref:kg_node.node_id';
COMMENT ON COLUMN t_cst_bas.rgn_cd IS '区域编码 @ref:t_dic_rgn.rgn_cd';
COMMENT ON COLUMN t_ord_hdr.cst_no IS '客户编号 @ref:t_cst_bas.cst_no';
COMMENT ON COLUMN t_ord_dtl.prd_cd IS '产品编码 @ref:t_prd_inf.prd_cd';
COMMENT ON COLUMN t_fin_rcv.cst_no IS '客户编号 @ref:t_cst_bas.cst_no';
COMMENT ON COLUMN t_sal_emp.rgn_cd IS '负责区域 @ref:t_dic_rgn.rgn_cd';

-- 格式2: @fk(table=X,col=Y,type=Z)（完整写法，type 可选）
COMMENT ON COLUMN t_cst_grp_rel.cst_no IS '客户编号 @fk(table=t_cst_bas,col=cst_no,type=many_to_one)';
COMMENT ON COLUMN t_ord_hdr.slr_id IS '销售员ID @fk(table=t_sal_emp,col=emp_id,type=many_to_one)';
COMMENT ON COLUMN t_ord_dtl.ord_no IS '订单编号 @fk(table=t_ord_hdr,col=ord_no,type=many_to_one)';
COMMENT ON COLUMN t_fin_rcv.ord_no IS '关联订单号 @fk(table=t_ord_hdr,col=ord_no,type=one_to_one)';

-- 格式3: [ref:table.col]（方括号格式）
COMMENT ON COLUMN kg_edge.tgt_node_id IS '目标节点ID [ref:kg_node.node_id]';
COMMENT ON COLUMN t_cst_grp_rel.grp_cd IS '分组编码 [ref:t_cst_grp.grp_cd]';
COMMENT ON COLUMN t_prd_inf.prd_cls_cd IS '产品分类编码 [ref:t_prd_cls.cls_cd]';
COMMENT ON COLUMN t_ord_hdr.rgn_cd IS '下单区域 [ref:t_dic_rgn.rgn_cd]';
COMMENT ON COLUMN t_sal_tgt.rgn_cd IS '区域编码 [ref:t_dic_rgn.rgn_cd]';
COMMENT ON COLUMN t_idx_dim_map.idx_cd IS '指标编码 @ref:t_idx_def.idx_cd';
COMMENT ON COLUMN t_idx_dim_map.dim_cd IS '维度编码 [ref:t_dim_def.dim_cd]';

-- 格式4: $$ref(table.col)$$（双美元符格式）
COMMENT ON COLUMN t_prd_cls.par_cd IS '父分类编码 $$ref(t_prd_cls.cls_cd)$$';
COMMENT ON COLUMN t_ord_hdr.chn_cd IS '渠道编码: ON=线上/OF=线下/DL=分销 $$ref(t_dic_chn.chn_cd)$$';
COMMENT ON COLUMN t_dic_rgn.par_cd IS '上级区域 $$ref(t_dic_rgn.rgn_cd)$$';
COMMENT ON COLUMN t_sal_tgt.prd_cls_cd IS '产品线编码 $$ref(t_prd_cls.cls_cd)$$';
COMMENT ON COLUMN t_idx_val_d.idx_cd IS '指标编码 $$ref(t_idx_def.idx_cd)$$';
