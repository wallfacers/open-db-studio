#!/bin/bash
# 独立迁移性能测试（直接通过 MySQL 执行，不依赖 Tauri）
# 使用 LOAD DATA LOCAL INFILE 模拟迁移流程

set -e

echo "=========================================="
echo "   独立迁移性能测试"
echo "=========================================="

MYSQL_CONTAINER="open-db-studio-mysql"
SOURCE_DB="test_migration"
SOURCE_TABLE="all_types"
TARGET_DB="test_project"
TARGET_TABLE="all_types"
PARALLELISM=8
BATCH_SIZE=100000

echo ""
echo "配置:"
echo "  - 并行度: $PARALLELISM"
echo "  - 批次大小: $BATCH_SIZE 行"
echo "  - 源表: $SOURCE_DB.$SOURCE_TABLE"
echo "  - 目标表: $TARGET_DB.$TARGET_TABLE"
echo ""

# 1. 准备环境
echo "[1/5] 准备环境..."

# 获取源表总行数
TOTAL_ROWS=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM $SOURCE_DB.$SOURCE_TABLE" 2>/dev/null | tail -1)
echo "  源表总行数: $TOTAL_ROWS"

# 截断目标表
docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -e \
    "TRUNCATE TABLE $TARGET_DB.$TARGET_TABLE;" 2>/dev/null
echo "  目标表已截断"

# 2. 获取 PK 范围
echo ""
echo "[2/5] 计算 PK 范围..."
PK_MIN=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT MIN(id) FROM $SOURCE_DB.$SOURCE_TABLE" 2>/dev/null | tail -1)
PK_MAX=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT MAX(id) FROM $SOURCE_DB.$SOURCE_TABLE" 2>/dev/null | tail -1)
PK_RANGE=$((PK_MAX - PK_MIN + 1))
echo "  PK 范围: $PK_MIN ~ $PK_MAX (跨度: $PK_RANGE)"

# 3. 计算分片
echo ""
echo "[3/5] 计算分片..."
SHARD_SIZE=$((PK_RANGE / PARALLELISM))
echo "  每片大小: $SHARD_SIZE"

for i in $(seq 0 $((PARALLELISM - 1))); do
    START=$((PK_MIN + i * SHARD_SIZE))
    if [ $i -eq $((PARALLELISM - 1)) ]; then
        END=$PK_MAX
    else
        END=$((PK_MIN + (i + 1) * SHARD_SIZE - 1))
    fi
    echo "  分片 $i: [$START, $END]"
done

# 4. 并行迁移（使用 INSERT INTO ... SELECT）
echo ""
echo "[4/5] 开始并行迁移..."
echo "  方法: INSERT INTO ... SELECT (批量插入)"

START_TIME=$(date +%s)
echo "  开始时间: $(date)"

# 创建并行迁移脚本
for i in $(seq 0 $((PARALLELISM - 1))); do
    START=$((PK_MIN + i * SHARD_SIZE))
    if [ $i -eq $((PARALLELISM - 1)) ]; then
        END=$PK_MAX
    else
        END=$((PK_MIN + (i + 1) * SHARD_SIZE - 1))
    fi

    # 启动后台进程执行批量插入
    (
        # 分批执行避免内存溢出
        CURRENT=$START
        while [ $CURRENT -le $END ]; do
            BATCH_END=$((CURRENT + BATCH_SIZE - 1))
            if [ $BATCH_END -gt $END ]; then
                BATCH_END=$END
            fi

            docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -e \
                "INSERT INTO $TARGET_DB.$TARGET_TABLE SELECT * FROM $SOURCE_DB.$SOURCE_TABLE WHERE id >= $CURRENT AND id <= $BATCH_END;" 2>/dev/null

            CURRENT=$((BATCH_END + 1))
        done
        echo "    分片 $i 完成"
    ) &
done

# 等待所有后台进程完成
wait

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
echo "  结束时间: $(date)"
echo "  耗时: $ELAPSED 秒"

# 5. 验证结果
echo ""
echo "[5/5] 验证结果..."

TARGET_ROWS=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM $TARGET_DB.$TARGET_TABLE" 2>/dev/null | tail -1)
echo "  目标表行数: $TARGET_ROWS"

# 检查超大 BIGINT UNSIGNED
LARGE_UINT_SOURCE=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM $SOURCE_DB.$SOURCE_TABLE WHERE col_bigint_u > 9223372036854775807" 2>/dev/null | tail -1)
LARGE_UINT_TARGET=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM $TARGET_DB.$TARGET_TABLE WHERE col_bigint_u > 9223372036854775807" 2>/dev/null | tail -1)

if [ "$TARGET_ROWS" -eq "$TOTAL_ROWS" ]; then
    echo "  ✓ 行数一致: $TARGET_ROWS = $TOTAL_ROWS"
else
    echo "  ✗ 行数不一致: $TARGET_ROWS vs $TOTAL_ROWS"
fi

if [ "$LARGE_UINT_TARGET" -eq "$LARGE_UINT_SOURCE" ]; then
    echo "  ✓ 超大 BIGINT UNSIGNED 正确迁移: $LARGE_UINT_TARGET 行"
else
    echo "  ✗ 超大值丢失: $LARGE_UINT_TARGET vs $LARGE_UINT_SOURCE"
fi

# 性能统计
THROUGHPUT=$((TOTAL_ROWS / ELAPSED))
echo ""
echo "=========================================="
echo "   性能统计"
echo "=========================================="
echo "  总行数: $TOTAL_ROWS"
echo "  耗时: $ELAPSED 秒"
echo "  吞吐量: $THROUGHPUT 行/秒"
echo ""
echo "DataX 基准: 1000w / 180s = 55,555 行/秒"

if [ $THROUGHPUT -ge 50000 ]; then
    echo "  ✓ 性能达标！"
else
    echo "  性能未达标，需要进一步优化"
fi

# 抽样验证超大值
echo ""
echo "超大值抽样:"
docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -e \
    "SELECT id, col_bigint_u FROM $TARGET_DB.$TARGET_TABLE WHERE col_bigint_u > 9223372036854775807 ORDER BY col_bigint_u DESC LIMIT 3;" 2>/dev/null | tail -4