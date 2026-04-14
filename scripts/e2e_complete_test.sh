#!/bin/bash
# 完整端到端迁移测试 + 实时内存监控
# 使用实际 pipeline 执行迁移并监控资源消耗

set -e

echo "=========================================="
echo "   完整端到端迁移测试"
echo "=========================================="
echo ""

MYSQL_CONTAINER="open-db-studio-mysql"

# 1. 准备环境
echo "[1/6] 准备测试环境..."

# 截断目标表
docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -e \
    "TRUNCATE TABLE test_project.all_types;" 2>/dev/null | tail -1

echo "  ✓ 目标表已截断"

# 获取源表统计
TOTAL_ROWS=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_migration.all_types" 2>/dev/null | tail -1)

AVG_ROW_BYTES=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT
        AVG(LENGTH(col_char)) +
        AVG(LENGTH(col_varchar)) +
        AVG(LENGTH(col_tinytext)) +
        AVG(LENGTH(col_text)) +
        AVG(LENGTH(col_mediumtext)) +
        AVG(LENGTH(col_longtext)) +
        AVG(LENGTH(col_json)) +
        AVG(LENGTH(col_binary)) +
        AVG(LENGTH(col_varbinary)) +
        AVG(LENGTH(col_tinyblob)) +
        AVG(LENGTH(col_blob))
    FROM test_migration.all_types" 2>/dev/null | tail -1)

echo "  ✓ 源表行数: $TOTAL_ROWS"
echo "  ✓ 平均行大小: $AVG_ROW_BYTES 字节"

# 2. 计算理论内存消耗
echo ""
echo "[2/6] 理论内存消耗计算..."

PARALLELISM=8
READ_BATCH=5000
WRITE_BATCH=2048
CHANNEL_CAP=32
BYTE_CAP_MB=8

# 计算通道最大内存（不受 byte_gate 控制）
CHANNEL_MEM_MB=$(( PARALLELISM * CHANNEL_CAP * READ_BATCH * AVG_ROW_BYTES / 1024 / 1024 ))
echo "  通道最大内存（无背压）: $CHANNEL_MEM_MB MB"

# 计算期望内存（byte_gate 控制）
EXPECTED_MEM_MB=$(( BYTE_CAP_MB + PARALLELISM * WRITE_BATCH * AVG_ROW_BYTES / 1024 / 1024 ))
echo "  期望内存（byte_gate 控制）: $EXPECTED_MEM_MB MB"

# 3. 显示迁移脚本
echo ""
echo "[3/6] 迁移脚本:"
cat << 'EOF'
USE src = CONNECTION('本地MySQL');
USE dst = CONNECTION('本地MySQL');

SET parallelism = 8,
    read_batch = 1000,
    write_batch = 500,
    channel_capacity = 8,
    byte_capacity = 4194304;  -- 4MB

MIGRATE FROM src.test_migration.all_types
        INTO dst.test_project.all_types
MAPPING (*)
CREATE IF NOT EXISTS;
EOF

echo ""
echo "优化说明:"
echo "  - read_batch 降低: 5000 -> 1000 (减少 5x 内存压力)"
echo "  - channel_capacity 降低: 32 -> 8 (减少 4x 消息积压)"
echo "  - byte_capacity 显式设置: 4MB (确保背压生效)"

# 4. 启动实时内存监控
echo ""
echo "[4/6] 启动实时内存监控..."

MONITOR_LOG="migration_memory.log"

cat > /tmp/monitor_app.sh << 'EOF'
#!/bin/bash
APP_NAME="$1"
echo "timestamp,app_mem_mb,system_mem_used_mb,mysql_mem_mb,rows_written"

prev_mysql_rows=0
while true; do
    ts=$(date +%H:%M:%S)

    # 应用进程内存
    app_mem=$(ps aux | grep "$APP_NAME" | grep -v grep | awk '{print $6}' | awk '{sum+=$1} END {printf "%.0f", sum/1024}' || echo 0)

    # 系统内存
    sys_mem=$(free -m | grep Mem | awk '{print $3}')

    # MySQL 内存
    mysql_mem=$(docker stats $MYSQL_CONTAINER --no-stream --format "{{.MemUsage}}" 2>/dev/null | grep -oP '\d+\.\d+MiB' | sed 's/MiB//' || echo 0)

    # MySQL rows_inserted
    mysql_rows=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e "SHOW STATUS LIKE 'Rows_inserted'" 2>/dev/null | tail -1 | awk '{print $2}')

    echo "$ts,$app_mem,$sys_mem,$mysql_mem,$mysql_rows"

    sleep 1
done
EOF

chmod +x /tmp/monitor_app.sh

echo "  ✓ 监控脚本已准备"

# 5. 提示用户执行迁移
echo ""
echo "[5/6] 执行迁移..."
echo ""
echo "请在 Open DB Studio 中执行迁移："
echo "  1. 启动应用（如果未启动）"
echo "  2. 确保连接 '本地MySQL' 存在"
echo "  3. 创建迁移任务，使用上述脚本"
echo "  4. 点击运行"
echo ""
echo "同时，请在另一个终端运行监控："
echo "  /tmp/monitor_app.sh open-db-studio > $MONITOR_LOG"
echo ""

read -p "迁移完成后按 Enter 继续... " -r

# 6. 分析结果
echo ""
echo "[6/6] 分析结果..."

TARGET_ROWS=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_project.all_types" 2>/dev/null | tail -1)

LARGE_UINT_SOURCE=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_migration.all_types WHERE col_bigint_u > 9223372036854775807" 2>/dev/null | tail -1)

LARGE_UINT_TARGET=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_project.all_types WHERE col_bigint_u > 9223372036854775807" 2>/dev/null | tail -1)

echo "数据验证:"
echo "  - 目标行数: $TARGET_ROWS"
echo "  - 源表超大值: $LARGE_UINT_SOURCE"
echo "  - 目标超大值: $LARGE_UINT_TARGET"

if [ "$TARGET_ROWS" -eq "$TOTAL_ROWS" ]; then
    echo "  ✓ 行数一致"
else
    echo "  ✗ 行数不一致: $TARGET_ROWS vs $TOTAL_ROWS"
fi

if [ "$LARGE_UINT_TARGET" -eq "$LARGE_UINT_SOURCE" ]; then
    echo "  ✓ 超大 BIGINT UNSIGNED 正确迁移"
else
    echo "  ✗ 超大值丢失: $LARGE_UINT_TARGET vs $LARGE_UINT_SOURCE"
fi

# 分析内存日志
if [ -f "$MONITOR_LOG" ] && [ -s "$MONITOR_LOG" ]; then
    echo ""
    echo "内存分析:"
    MAX_APP_MEM=$(awk -F',' 'NR>1 {print $2}' "$MONITOR_LOG" | sort -n | tail -1)
    AVG_APP_MEM=$(awk -F',' 'NR>1 {sum+=$2; count++} END {if(count>0) printf "%.0f", sum/count}' "$MONITOR_LOG")

    echo "  - 应用峰值内存: $MAX_APP_MEM MB"
    echo "  - 应用平均内存: $AVG_APP_MEM MB"

    if [ "$MAX_APP_MEM" -le "$EXPECTED_MEM_MB" ]; then
        echo "  ✓ 内存消耗达标（<= $EXPECTED_MEM_MB MB）"
    elif [ "$MAX_APP_MEM" -le 4000 ]; then
        echo "  ⚠ 内存消耗偏高但仍可接受（<= 4GB）"
    else
        echo "  ✗ 内存消耗超标（> 4GB）"
    fi
fi

echo ""
echo "=========================================="
echo "   DataX 对比"
echo "=========================================="
echo "  DataX 基准: 2CPU 4GB, 180s, 1000w"
echo "  内存峰值: 4GB"
echo ""
echo "  当前测试:"
echo "    - 应用峰值: ${MAX_APP_MEM:-N/A} MB"
echo ""
echo "如果峰值 <= 4000 MB，性能达标！"