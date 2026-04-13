#!/bin/bash
# 端到端迁移测试脚本
# 测试 BIGINT UNSIGNED 修复 + 性能监控

set -e

MYSQL_HOST="localhost"
MYSQL_PORT="3306"
MYSQL_USER="root"
MYSQL_PASS="root123456"

echo "=== 端到端迁移测试 ==="
echo "时间: $(date)"
echo ""

# 1. 检查源表数据量
echo "[1/5] 检查源表数据量..."
SOURCE_ROWS=$(mysql -h$MYSQL_HOST -P$MYSQL_PORT -u$MYSQL_USER -p$MYSQL_PASS -N -e \
    "SELECT COUNT(*) FROM test_migration.all_types" 2>/dev/null)
echo "源表 test_migration.all_types: $SOURCE_ROWS 行"

# 2. 创建目标数据库和表（如果不存在）
echo "[2/5] 准备目标表..."
mysql -h$MYSQL_HOST -P$MYSQL_PORT -u$MYSQL_USER -p$MYSQL_PASS -e \
    "CREATE DATABASE IF NOT EXISTS test_project DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null

# 截断目标表（如果存在），或创建新表
mysql -h$MYSQL_HOST -P$MYSQL_PORT -u$MYSQL_USER -p$MYSQL_PASS test_project -e \
    "TRUNCATE TABLE IF EXISTS all_types;" 2>/dev/null || true

# 如果表不存在，创建表结构
mysql -h$MYSQL_HOST -P$MYSQL_PORT -u$MYSQL_USER -p$MYSQL_PASS test_project -e \
    "CREATE TABLE IF NOT EXISTS all_types (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        col_tinyint     TINYINT,
        col_tinyint_u   TINYINT UNSIGNED,
        col_smallint    SMALLINT,
        col_smallint_u  SMALLINT UNSIGNED,
        col_mediumint   MEDIUMINT,
        col_mediumint_u MEDIUMINT UNSIGNED,
        col_int         INT,
        col_int_u       INT UNSIGNED,
        col_bigint      BIGINT,
        col_bigint_u    BIGINT UNSIGNED,
        col_float       FLOAT(10,2),
        col_double      DOUBLE(10,2),
        col_decimal     DECIMAL(10,2),
        col_bit         BIT(8),
        col_char        CHAR(10),
        col_varchar     VARCHAR(255),
        col_tinytext    TINYTEXT,
        col_text        TEXT,
        col_mediumtext  MEDIUMTEXT,
        col_longtext    LONGTEXT,
        col_enum        ENUM('pending','active','inactive','deleted'),
        col_set         SET('red','green','blue','yellow'),
        col_binary      BINARY(16),
        col_varbinary   VARBINARY(255),
        col_tinyblob    TINYBLOB,
        col_blob        BLOB,
        col_date        DATE,
        col_time        TIME,
        col_datetime    DATETIME,
        col_timestamp   TIMESTAMP NULL,
        col_year        YEAR,
        col_json        JSON
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null

echo "目标表 test_project.all_types 已准备（TRUNCATE 完成）"

# 3. 检查超大 BIGINT UNSIGNED 值的数量
echo "[3/5] 检查超大 BIGINT UNSIGNED 值..."
LARGE_UINT_COUNT=$(mysql -h$MYSQL_HOST -P$MYSQL_PORT -u$MYSQL_USER -p$MYSQL_PASS -N -e \
    "SELECT COUNT(*) FROM test_migration.all_types WHERE col_bigint_u > 9223372036854775807" 2>/dev/null)
echo "超大 BIGINT UNSIGNED 值 (> i64::MAX): $LARGE_UINT_COUNT 行"
echo "预计占比: $(echo "scale=2; $LARGE_UINT_COUNT * 100 / $SOURCE_ROWS" | bc)%"

# 4. 性能基准
echo ""
echo "[4/5] 性能基准对比..."
echo "目标: DataX 2CPU 4GB 180s 同步 1000w 行"
echo "当前环境:"
echo "  - 源数据量: $SOURCE_ROWS 行"
echo "  - 目标吞吐: ~55,000 行/秒 (DataX)"

# 5. 显示迁移脚本
echo ""
echo "[5/5] 迁移脚本:"
echo "----------------------------------------"
cat << 'EOF'
USE src = CONNECTION('本地MySQL');
USE dst = CONNECTION('本地MySQL');

SET parallelism = 8,
    read_batch = 5000,
    write_batch = 2048;

MIGRATE FROM src.test_migration.all_types
        INTO dst.test_project.all_types
MAPPING (*)
CREATE IF NOT EXISTS;
EOF
echo "----------------------------------------"

echo ""
echo "=== 测试准备完成 ==="
echo "请在 Open DB Studio 中:"
echo "1. 确保已重新编译 (cargo build --release)"
echo "2. 创建迁移任务，粘贴上述脚本"
echo "3. 运行迁移，观察日志"
echo ""
echo "验证要点:"
echo "1. 不应出现 'Out of range value for column col_bigint_u' 错误"
echo "2. 迁移完成后，检查目标表行数 = 源表行数"
echo "3. 检查超大 BIGINT UNSIGNED 值是否正确迁移"

# 验证脚本（迁移后运行）
echo ""
echo "=== 迁移后验证命令 ==="
echo "# 检查行数一致:"
echo "mysql -h$MYSQL_HOST -u$MYSQL_USER -p$MYSQL_PASS -N -e \"SELECT COUNT(*) FROM test_project.all_types\""
echo ""
echo "# 检查超大值迁移正确:"
echo "mysql -h$MYSQL_HOST -u$MYSQL_USER -p$MYSQL_PASS -N -e \"SELECT COUNT(*) FROM test_project.all_types WHERE col_bigint_u > 9223372036854775807\""
echo ""
echo "# 抽样检查超大值:"
echo "mysql -h$MYSQL_HOST -u$MYSQL_USER -p$MYSQL_PASS -e \"SELECT id, col_bigint_u FROM test_project.all_types WHERE col_bigint_u > 9223372036854775807 LIMIT 5\""