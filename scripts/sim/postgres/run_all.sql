-- =============================================================
-- 一键执行所有脚本 — PostgreSQL
-- 先手动创建数据库: CREATE DATABASE test_metrics;
-- 然后连接到 test_metrics 执行:
--   psql -U postgres -d test_metrics -f scripts/sim/postgres/run_all.sql
-- =============================================================

\i scripts/sim/postgres/01_schema.sql
\i scripts/sim/postgres/02_metadata.sql
\i scripts/sim/postgres/03_metrics_and_graph.sql
\i scripts/sim/postgres/04_business_data.sql
\i scripts/sim/postgres/05_metric_values.sql
