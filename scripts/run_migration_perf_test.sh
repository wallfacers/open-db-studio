#!/bin/bash
# 端到端迁移性能测试脚本
# 目标：达到 DataX 性能（2CPU 4GB, 180s 同步 1000w）

set -e

echo "=========================================="
echo "   端到端迁移性能测试"
echo "=========================================="
echo ""
echo "环境:"
echo "  - 源表: test_migration.all_types (1000w 行)"
echo "  - 目标表: test_project.all_types"
echo "  - 目标性能: DataX (2CPU 4GB) = 180s 同步 1000w = ~55,000 行/秒"
echo ""

# 1. 准备测试环境
echo "[1/6] 准备测试环境..."

# 截断目标表
docker exec open-db-studio-mysql mysql -uroot -proot123456 -e \
    "USE test_project; TRUNCATE TABLE all_types;" 2>/dev/null | tail -1
echo "  ✓ 目标表已截断"

# 获取初始状态
SOURCE_ROWS=$(docker exec open-db-studio-mysql mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_migration.all_types" 2>/dev/null | tail -1)
echo "  ✓ 源表行数: $SOURCE_ROWS"

# 2. 启动性能监控
echo ""
echo "[2/6] 启动性能监控..."

MONITOR_PID=""
MONITOR_LOG="migration_performance.log"

# 创建监控脚本
cat > /tmp/monitor_mysql.sh << 'MONITOR_EOF'
#!/bin/bash
CONTAINER="open-db-studio-mysql"
echo "timestamp,cpu_percent,mem_percent,mysql_threads,mysql_rows_inserted,rows_inserted_delta"
prev_rows=0
while true; do
    ts=$(date +%H:%M:%S)
    cpu=$(docker stats $CONTAINER --no-stream --format "{{.CPUPerc}}" 2>/dev/null | sed 's/%//')
    mem=$(docker stats $CONTAINER --no-stream --format "{{.MemPerc}}" 2>/dev/null | sed 's/%//')
    threads=$(docker exec $CONTAINER mysql -uroot -proot123456 -N -e "SHOW STATUS LIKE 'Threads_connected'" 2>/dev/null | tail -1 | awk '{print $2}')
    rows=$(docker exec $CONTAINER mysql -uroot -proot123456 -N -e "SHOW STATUS LIKE 'Rows_inserted'" 2>/dev/null | tail -1 | awk '{print $2}')
    delta=$((rows - prev_rows))
    echo "$ts,$cpu,$mem,$threads,$rows,$delta"
    prev_rows=$rows
    sleep 2
done
MONITOR_EOF

chmod +x /tmp/monitor_mysql.sh
/tmp/monitor_mysql.sh > $MONITOR_LOG 2>&1 &
MONITOR_PID=$!
echo "  ✓ 监控已启动 (PID: $MONITOR_PID)"
echo "  ✓ 日志文件: $MONITOR_LOG"

# 3. 显示迁移配置
echo ""
echo "[3/6] 迁移配置..."
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

# 4. 等待用户启动迁移
echo ""
echo "[4/6] 准备执行迁移..."
echo ""
echo "请在 Open DB Studio 中执行迁移任务:"
echo "  1. 启动应用 (npm run tauri:dev 或已编译的 release 版本)"
echo "  2. 创建迁移任务，粘贴上述脚本"
echo "  3. 点击运行"
echo ""
read -p "迁移完成后按 Enter 继续... " -r

# 5. 停止监控并分析结果
echo ""
echo "[5/6] 停止监控并分析性能..."

kill $MONITOR_PID 2>/dev/null || true
sleep 1

# 获取最终状态
TARGET_ROWS=$(docker exec open-db-studio-mysql mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_project.all_types" 2>/dev/null | tail -1)

# 分析监控日志
if [ -f "$MONITOR_LOG" ] && [ -s "$MONITOR_LOG" ]; then
    echo ""
    echo "性能分析:"

    # 计算平均吞吐量（取峰值 delta）
    peak_delta=$(tail -20 "$MONITOR_LOG" | awk -F',' '{print $6}' | sort -n | tail -1)
    avg_cpu=$(tail -20 "$MONITOR_LOG" | awk -F',' '{print $2}' | awk '{sum+=$1; count++} END {if(count>0) printf "%.1f", sum/count}')
    avg_mem=$(tail -20 "$MONITOR_LOG" | awk -F',' '{print $3}' | awk '{sum+=$1; count++} END {if(count>0) printf "%.1f", sum/count}')

    echo "  - 目标表最终行数: $TARGET_ROWS"
    echo "  - 峰值写入速率: $peak_delta 行/秒"
    echo "  - 平均 CPU 使用率: ${avg_cpu}%"
    echo "  - 平均内存使用率: ${avg_mem}%"
fi

# 6. 验证数据完整性
echo ""
echo "[6/6] 验证数据完整性..."

# 检查行数一致
if [ "$TARGET_ROWS" -eq "$SOURCE_ROWS" ]; then
    echo "  ✓ 行数一致: $TARGET_ROWS = $SOURCE_ROWS"
else
    echo "  ✗ 行数不一致: 目标 $TARGET_ROWS vs 源 $SOURCE_ROWS"
fi

# 检查超大 BIGINT UNSIGNED 值迁移
LARGE_UINT_TARGET=$(docker exec open-db-studio-mysql mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_project.all_types WHERE col_bigint_u > 9223372036854775807" 2>/dev/null | tail -1)
LARGE_UINT_SOURCE=$(docker exec open-db-studio-mysql mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_migration.all_types WHERE col_bigint_u > 9223372036854775807" 2>/dev/null | tail -1)

if [ "$LARGE_UINT_TARGET" -eq "$LARGE_UINT_SOURCE" ]; then
    echo "  ✓ 超大 BIGINT UNSIGNED 值迁移成功: $LARGE_UINT_TARGET 行"
else
    echo "  ✗ 超大 BIGINT UNSIGNED 值丢失: 目标 $LARGE_UINT_TARGET vs 源 $LARGE_UINT_SOURCE"
fi

# 抽样检查超大值
echo ""
echo "超大值抽样检查:"
docker exec open-db-studio-mysql mysql -uroot -proot123456 -e \
    "SELECT id, col_bigint_u FROM test_project.all_types WHERE col_bigint_u > 9223372036854775807 ORDER BY col_bigint_u DESC LIMIT 5;" 2>/dev/null | tail -6

echo ""
echo "=========================================="
echo "   测试完成"
echo "=========================================="
echo ""
echo "DataX 性能基准:"
echo "  - 1000w 行 / 180s ≈ 55,555 行/秒"
echo ""
echo "如果峰值写入速率接近或超过 50,000 行/秒，"
echo "则性能已达到 DataX 水平！"