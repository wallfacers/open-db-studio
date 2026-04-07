# 指标 & 知识图谱 模拟环境

模拟真实企业系统，用于测试 AI 在对话中如何利用**元数据**和**知识图谱**来理解不直观的表结构并生成正确 SQL。

## 设计思路

真实企业系统中，表名/字段名通常是缩写、编码，没有文档说明几乎无法理解含义。
AI 如果不借助元数据字典和知识图谱，就会产生"幻觉"——猜测字段含义、错误关联表。

### 四层架构

| 层级 | 表 | 用途 |
|------|-----|------|
| 元数据层 | `sys_meta_tbl`, `sys_meta_col`, `sys_biz_term` | AI 的"知识词典"，解释表/列/术语含义 |
| 知识图谱层 | `kg_node`, `kg_edge` | 实体关系网络：指标从哪些表计算、指标间依赖、表间关联 |
| 指标体系层 | `t_idx_def`, `t_dim_def`, `t_idx_dim_map`, `t_idx_val_d` | 指标定义+维度+预计算值 |
| 业务表层 | `t_cst_bas`, `t_prd_inf`, `t_ord_hdr` 等 | 故意用缩写命名的业务数据 |

### 典型测试场景

1. **"上个月 GMV 是多少？"** → AI 需查指标定义，知道 GMV = SUM(ord_amt) 不过滤状态
2. **"华东大区3月营收多少？"** → AI 需知道 rgn_cd='R01' 是华东，且营收排除取消订单
3. **"3月哪个渠道卖得最好？"** → AI 需关联渠道字典 t_dic_chn
4. **"GMV 和营收有什么区别？"** → AI 需查知识图谱的 SYNONYM 边，说明口径差异
5. **"毛利率怎么算？"** → AI 需遍历图谱 CALC_FROM 边，发现需要 t_ord_dtl + t_prd_inf

## 使用方法

### MySQL

```bash
mysql -u root -proot123456 < scripts/sim/mysql/01_schema.sql
mysql -u root -proot123456 test_metrics < scripts/sim/mysql/02_metadata.sql
mysql -u root -proot123456 test_metrics < scripts/sim/mysql/03_metrics_and_graph.sql
mysql -u root -proot123456 test_metrics < scripts/sim/mysql/04_business_data.sql
mysql -u root -proot123456 test_metrics < scripts/sim/mysql/05_metric_values.sql
```

### PostgreSQL

```bash
psql -U postgres -c "CREATE DATABASE test_metrics;"
psql -U postgres -d test_metrics -f scripts/sim/postgres/01_schema.sql
psql -U postgres -d test_metrics -f scripts/sim/postgres/02_metadata.sql
psql -U postgres -d test_metrics -f scripts/sim/postgres/03_metrics_and_graph.sql
psql -U postgres -d test_metrics -f scripts/sim/postgres/04_business_data.sql
psql -U postgres -d test_metrics -f scripts/sim/postgres/05_metric_values.sql
```

## 数据规模

| 类别 | 数量 |
|------|------|
| 客户 | 15 家 |
| 产品 | 15 个 |
| 订单 | ~40 笔 (2026年Q1+4月初) |
| 指标定义 | 23 个 (原子10+派生5+复合8) |
| 维度 | 9 个 |
| 知识图谱节点 | 30+ 个 |
| 知识图谱关系 | 25+ 条 |
| 元数据记录 | 18 表 + 55 列 + 10 术语 |
