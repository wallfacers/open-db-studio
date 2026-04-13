#!/bin/bash
# 性能监控脚本 - 监控迁移过程中的 CPU、内存、磁盘

CONTAINER_NAME="open-db-studio-mysql"
INTERVAL=2  # 监控间隔（秒）
OUTPUT_FILE="migration_metrics.csv"

# CSV header
echo "timestamp,cpu_percent,mem_mb,disk_read_mb,disk_write_mb,mysql_conn,mysql_rows_sent,mysql_rows_inserted" > $OUTPUT_FILE

echo "=== 开始性能监控 ==="
echo "输出文件: $OUTPUT_FILE"
echo "监控间隔: ${INTERVAL}s"
echo ""

# 获取初始磁盘读/写字节数
INIT_DISK_READ=$(docker exec $CONTAINER_NAME cat /proc/vmstat 2>/dev/null | grep "pgpgin" | awk '{print $2}' || echo 0)
INIT_DISK_WRITE=$(docker exec $CONTAINER_NAME cat /proc/vmstat 2>/dev/null | grep "pgpgout" | awk '{print $2}' || echo 0)

while true; do
    TIMESTAMP=$(date +%H:%M:%S)

    # CPU 使用率（MySQL 容器）
    CPU_PERCENT=$(docker stats $CONTAINER_NAME --no-stream --format "{{.CPUPerc}}" 2>/dev/null | sed 's/%//' || echo "0")

    # 内存使用（MySQL 容器，MiB）
    MEM_MB=$(docker stats $CONTAINER_NAME --no-stream --format "{{.MemUsage}}" 2>/dev/null | grep -oP '\d+\.\d+MiB' | sed 's/MiB//' || echo "0")

    # 磁盘 I/O（通过 pgpgin/pgpgout 计算）
    DISK_READ=$(docker exec $CONTAINER_NAME cat /proc/vmstat 2>/dev/null | grep "pgpgin" | awk '{print $2}' || echo 0)
    DISK_WRITE=$(docker exec $CONTAINER_NAME cat /proc/vmstat 2>/dev/null | grep "pgpgout" | awk '{print $2}' || echo 0)
    DISK_READ_MB=$(( ($DISK_READ - $INIT_DISK_READ) / 1024 ))
    DISK_WRITE_MB=$(( ($DISK_WRITE - $INIT_DISK_WRITE) / 1024 ))

    # MySQL 连接数
    MYSQL_CONN=$(docker exec $CONTAINER_NAME mysql -uroot -proot123456 -N -e \
        "SHOW STATUS LIKE 'Threads_connected'" 2>/dev/null | tail -1 | awk '{print $2}' || echo "0")

    # MySQL 行发送/插入
    MYSQL_ROWS_SENT=$(docker exec $CONTAINER_NAME mysql -uroot -proot123456 -N -e \
        "SHOW STATUS LIKE 'Rows_sent'" 2>/dev/null | tail -1 | awk '{print $2}' || echo "0")
    MYSQL_ROWS_INSERTED=$(docker exec $CONTAINER_NAME mysql -uroot -proot123456 -N -e \
        "SHOW STATUS LIKE 'Rows_inserted'" 2>/dev/null | tail -1 | awk '{print $2}' || echo "0")

    echo "$TIMESTAMP,$CPU_PERCENT,$MEM_MB,$DISK_READ_MB,$DISK_WRITE_MB,$MYSQL_CONN,$MYSQL_ROWS_SENT,$MYSQL_ROWS_INSERTED"
    echo "$TIMESTAMP,$CPU_PERCENT,$MEM_MB,$DISK_READ_MB,$DISK_WRITE_MB,$MYSQL_CONN,$MYSQL_ROWS_SENT,$MYSQL_ROWS_INSERTED" >> $OUTPUT_FILE

    sleep $INTERVAL
done