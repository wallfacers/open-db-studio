#!/bin/bash
# 端到端迁移性能测试 + 资源监控
# 目标：达到 DataX 性能（2CPU 4GB, 180s 同步 1000w）

set -e

echo "=========================================="
echo "   端到端迁移性能测试 + 资源监控"
echo "=========================================="

MYSQL_CONTAINER="open-db-studio-mysql"
APP_PROCESS="open-db-studio"  # Tauri 应用进程名

# 1. 准备环境
echo ""
echo "[1/7] 准备测试环境..."

# 截断目标表
docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -e \
    "TRUNCATE TABLE test_project.all_types;" 2>/dev/null | tail -1
echo "  ✓ 目标表已截断"

# 2. 启动资源监控
echo ""
echo "[2/7] 启动资源监控..."

MONITOR_DIR="/tmp/migration_monitor"
mkdir -p $MONITOR_DIR

# 创建监控脚本（监控进程内存、系统内存、磁盘 I/O）
cat > $MONITOR_DIR/monitor.sh << 'EOF'
#!/bin/bash
OUTPUT="$1"
APP_PID="$2"

echo "timestamp,process_mem_mb,system_mem_used_mb,system_mem_avail_mb,mysql_mem_mb,disk_read_kb,disk_write_kb,mysql_threads,mysql_rows_inserted"

prev_disk_read=0
prev_disk_write=0
prev_mysql_rows=0

while true; do
    ts=$(date +%H:%M:%S)

    # 进程内存（如果找到进程）
    if [ -n "$APP_PID" ] && [ -d "/proc/$APP_PID" ]; then
        process_mem=$(cat /proc/$APP_PID/status 2>/dev/null | grep VmRSS | awk '{print $2}' || echo 0)
    else
        process_mem=0
    fi

    # 系统内存
    system_mem_used=$(free -m | grep Mem | awk '{print $3}')
    system_mem_avail=$(free -m | grep Mem | awk '{print $7}')

    # MySQL 容器内存
    mysql_mem=$(docker stats $MYSQL_CONTAINER --no-stream --format "{{.MemUsage}}" 2>/dev/null | grep -oP '\d+\.\d+MiB' | sed 's/MiB//' || echo 0)

    # 磁盘 I/O（累计）
    disk_read=$(cat /proc/vmstat 2>/dev/null | grep pgpgin | awk '{print $2}')
    disk_write=$(cat /proc/vmstat 2>/dev/null | grep pgpgout | awk '{print $2}')
    disk_read_kb=$((disk_read / 4))
    disk_write_kb=$((disk_write / 4))

    # MySQL 状态
    mysql_threads=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e "SHOW STATUS LIKE 'Threads_connected'" 2>/dev/null | tail -1 | awk '{print $2}')
    mysql_rows=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e "SHOW STATUS LIKE 'Rows_inserted'" 2>/dev/null | tail -1 | awk '{print $2}')
    mysql_rows_delta=$((mysql_rows - prev_mysql_rows))

    echo "$ts,$process_mem,$system_mem_used,$system_mem_avail,$mysql_mem,$disk_read_kb,$disk_write_kb,$mysql_threads,$mysql_rows,$mysql_rows_delta"

    prev_mysql_rows=$mysql_rows

    sleep 1
done
EOF

chmod +x $MONITOR_DIR/monitor.sh

echo "  ✓ 监控脚本已创建"

# 3. 显示迁移脚本
echo ""
echo "[3/7] 迁移脚本:"
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

# 4. 等待用户启动应用
echo ""
echo "[4/7] 请启动 Open DB Studio 应用..."
echo ""
echo "启动方式:"
echo "  - 开发模式: cd /home/wallfacers/project/open-db-studio && npm run tauri:dev"
echo "  - Release 版本: 运行编译后的应用"
echo ""
echo "启动后:"
echo "  1. 创建连接 '本地MySQL' (localhost:3306, root/root123456)"
echo "  2. 创建迁移任务，粘贴上述脚本"
echo "  3. 点击运行"
echo ""

# 查找应用进程
read -p "应用启动后按 Enter 继续... " -r

# 尝试找到应用进程
APP_PID=$(pgrep -f "open-db-studio" | head -1 || echo "")

if [ -n "$APP_PID" ]; then
    echo "  ✓ 找到应用进程 PID: $APP_PID"
else
    echo "  ⚠ 未找到应用进程，将仅监控系统级指标"
fi

# 启动监控
$MONITOR_DIR/monitor.sh "$MONITOR_DIR/metrics.csv" "$APP_PID" > "$MONITOR_DIR/metrics.csv" &
MONITOR_PID=$!
echo "  ✓ 监控已启动 (PID: $MONITOR_PID)"

# 5. 等待迁移完成
echo ""
echo "[5/7] 等待迁移完成..."
read -p "迁移完成后按 Enter 继续... " -r

# 停止监控
kill $MONITOR_PID 2>/dev/null || true
sleep 1

# 6. 分析结果
echo ""
echo "[6/7] 分析性能和资源消耗..."

# 获取最终状态
TARGET_ROWS=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_project.all_types" 2>/dev/null | tail -1)

# 分析监控数据
if [ -f "$MONITOR_DIR/metrics.csv" ] && [ -s "$MONITOR_DIR/metrics.csv" ]; then
    echo ""
    echo "=== 资源消耗分析 ==="

    # 最大进程内存
    if [ -n "$APP_PID" ]; then
        MAX_PROCESS_MEM=$(tail -100 "$MONITOR_DIR/metrics.csv" | awk -F',' 'NR>1 {print $2}' | sort -n | tail -1)
        AVG_PROCESS_MEM=$(tail -100 "$MONITOR_DIR/metrics.csv" | awk -F',' 'NR>1 {sum+=$2; count++} END {if(count>0) printf "%.0f", sum/count}')
        echo "应用进程内存:"
        echo "  - 最大峰值: ${MAX_PROCESS_MEM} MB"
        echo "  - 平均使用: ${AVG_PROCESS_MEM} MB"
    fi

    # 系统内存
    MAX_SYSTEM_MEM=$(tail -100 "$MONITOR_DIR/metrics.csv" | awk -F',' 'NR>1 {print $3}' | sort -n | tail -1)
    echo "系统内存使用:"
    echo "  - 最大峰值: ${MAX_SYSTEM_MEM} MB"

    # MySQL 内存
    MAX_MYSQL_MEM=$(tail -100 "$MONITOR_DIR/metrics.csv" | awk -F',' 'NR>1 {print $5}' | sort -n | tail -1)
    echo "MySQL 容器内存:"
    echo "  - 最大峰值: ${MAX_MYSQL_MEM} MB"

    # 峰值写入速率
    PEAK_WRITE=$(tail -100 "$MONITOR_DIR/metrics.csv" | awk -F',' 'NR>1 {print $10}' | sort -n | tail -1)
    echo "峰值写入速率: ${PEAK_WRITE} 行/秒"

    # 磁盘 I/O
    FINAL_DISK_READ=$(tail -1 "$MONITOR_DIR/metrics.csv" | awk -F',' '{print $6}')
    FINAL_DISK_WRITE=$(tail -1 "$MONITOR_DIR/metrics.csv" | awk -F',' '{print $7}')
    echo "磁盘 I/O:"
    echo "  - 读取总量: ${FINAL_DISK_READ} KB"
    echo "  - 写入总量: ${FINAL_DISK_WRITE} KB"
fi

# 7. 数据完整性验证
echo ""
echo "[7/7] 数据完整性验证..."

SOURCE_ROWS=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_migration.all_types" 2>/dev/null | tail -1)

LARGE_UINT_SOURCE=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_migration.all_types WHERE col_bigint_u > 9223372036854775807" 2>/dev/null | tail -1)
LARGE_UINT_TARGET=$(docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -N -e \
    "SELECT COUNT(*) FROM test_project.all_types WHERE col_bigint_u > 9223372036854775807" 2>/dev/null | tail -1)

if [ "$TARGET_ROWS" -eq "$SOURCE_ROWS" ]; then
    echo "  ✓ 行数一致: $TARGET_ROWS = $SOURCE_ROWS"
else
    echo "  ✗ 行数不一致: $TARGET_ROWS vs $SOURCE_ROWS"
fi

if [ "$LARGE_UINT_TARGET" -eq "$LARGE_UINT_SOURCE" ]; then
    echo "  ✓ 超大 BIGINT UNSIGNED 正确迁移: $LARGE_UINT_TARGET 行"
else
    echo "  ✗ 超大值丢失: $LARGE_UINT_TARGET vs $LARGE_UINT_SOURCE"
fi

echo ""
echo "=========================================="
echo "   DataX 对比"
echo "=========================================="
echo "  DataX 基准: 2CPU 4GB, 180s, 1000w"
echo "  内存峰值: 4GB"
echo ""
echo "  当前测试:"
echo "  - 应用峰值: ${MAX_PROCESS_MEM:-N/A} MB"
echo "  - 系统峰值: ${MAX_SYSTEM_MEM:-N/A} MB"
echo ""

# 超大值抽样
echo "超大值抽样验证:"
docker exec $MYSQL_CONTAINER mysql -uroot -proot123456 -e \
    "SELECT id, col_bigint_u FROM test_project.all_types WHERE col_bigint_u > 18000000000000000000 LIMIT 3;" 2>/dev/null | tail -4

echo ""
echo "监控数据已保存: $MONITOR_DIR/metrics.csv"