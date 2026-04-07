-- =============================================================
-- 一键执行所有脚本 — MySQL
-- 使用: mysql -u root -p < run_all.sql
-- =============================================================

SOURCE scripts/sim/mysql/01_schema.sql;
SOURCE scripts/sim/mysql/02_metadata.sql;
SOURCE scripts/sim/mysql/03_metrics_and_graph.sql;
SOURCE scripts/sim/mysql/04_business_data.sql;
SOURCE scripts/sim/mysql/05_metric_values.sql;
