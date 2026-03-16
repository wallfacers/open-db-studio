#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
电商测试数据库执行脚本
直接连接MySQL执行SQL脚本
"""

import mysql.connector
from mysql.connector import Error
import os
import sys
from pathlib import Path
from datetime import datetime

# 数据库连接配置
DB_CONFIG = {
    'host': 'localhost',
    'port': 3306,
    'user': 'test_user',
    'password': 'test123456',
    'charset': 'utf8mb4',
    'autocommit': False
}

SCRIPT_DIR = Path(__file__).parent

SQL_FILES = [
    '01_schema.sql',
    '02_categories.sql',
    '03_products.sql',
    '04_users.sql',
    '05_addresses.sql',
    '06_orders.sql',
    '07_refunds.sql',
    '08_shopping_carts.sql',
]


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def execute_sql_file(conn, filepath):
    """执行单个SQL文件，使用独立连接避免cursor问题"""
    filename = os.path.basename(filepath)
    log(f"执行: {filename}")

    with open(filepath, 'r', encoding='utf-8') as f:
        sql_content = f.read()

    # 每个文件使用新的cursor
    cursor = conn.cursor(buffered=True)
    success = 0

    try:
        statements = []
        current_stmt = []

        for line in sql_content.split('\n'):
            stripped = line.strip()
            if not stripped or stripped.startswith('--'):
                continue
            current_stmt.append(line)
            if stripped.endswith(';'):
                full_stmt = '\n'.join(current_stmt)
                statements.append(full_stmt)
                current_stmt = []

        if current_stmt:
            statements.append('\n'.join(current_stmt))

        for stmt in statements:
            stmt = stmt.strip()
            if not stmt:
                continue
            try:
                cursor.execute(stmt)
                # 消耗所有结果
                if cursor.with_rows:
                    cursor.fetchall()
                success += 1
            except Error as e:
                err_msg = str(e).lower()
                if 'already exists' in err_msg or 'unknown database' in err_msg or 'duplicate' in err_msg:
                    continue
                log(f"  警告: {e}")

        conn.commit()
        log(f"  {filename} 执行完成: {success} 条语句成功")
        return success

    except Exception as e:
        log(f"  错误: {e}")
        conn.rollback()
        return 0
    finally:
        cursor.close()


def main():
    print("=" * 60)
    print("电商测试数据库初始化")
    print("=" * 60)

    print("\n连接MySQL...")

    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        print("连接成功!")
    except Error as e:
        print(f"连接失败: {e}")
        print("\n请确保:")
        print("  1. MySQL服务正在运行")
        print("  2. 用户 test_user 有权限访问")
        print("  3. 可以创建数据库")
        sys.exit(1)

    print("\n开始执行SQL脚本...")

    total_success = 0
    for filename in SQL_FILES:
        filepath = SCRIPT_DIR / filename
        if filepath.exists():
            success = execute_sql_file(conn, str(filepath))
            total_success += success
        else:
            log(f"文件不存在: {filename}")

    print("\n" + "=" * 60)
    print("数据统计")
    print("=" * 60)

    try:
        cursor = conn.cursor(buffered=True)
        cursor.execute("USE test_store")

        tables = [
            ('users', '用户'),
            ('addresses', '地址'),
            ('categories', '分类'),
            ('products', '商品'),
            ('orders', '订单'),
            ('order_items', '订单明细'),
            ('payments', '支付'),
            ('shipments', '物流'),
            ('refund_records', '退款'),
            ('shopping_carts', '购物车'),
        ]

        for table, name in tables:
            try:
                cursor.execute(f"SELECT COUNT(*) FROM {table}")
                result = cursor.fetchone()
                count = result[0] if result else 0
                print(f"  {table}: {count:,}")
            except Error:
                print(f"  {table}: 表不存在")

        print("\n" + "=" * 60)
        print("指标验证")
        print("=" * 60)

        cursor.execute("SELECT SUM(pay_amount) FROM orders WHERE status = 30")
        result = cursor.fetchone()
        total = result[0] if result and result[0] else 0
        print(f"总销售额: {total:,.2f}")

        cursor.execute("SELECT COUNT(DISTINCT user_id) FROM orders")
        result = cursor.fetchone()
        active_users = result[0] if result else 0
        print(f"活跃用户数: {active_users:,}")

        cursor.execute("SELECT AVG(pay_amount) FROM orders WHERE status IN (20, 30)")
        result = cursor.fetchone()
        avg = result[0] if result and result[0] else 0
        print(f"平均客单价: {avg:.2f}")

        cursor.execute("SELECT COUNT(CASE WHEN status = 1 THEN 1 END), COUNT(*) FROM payments")
        result = cursor.fetchone()
        if result and result[1] and result[1] > 0:
            rate = result[0] / result[1] * 100
            print(f"支付成功率: {rate:.2f}%")
        else:
            print("支付成功率: 0.00%")

        cursor.close()

    except Error as e:
        print(f"统计失败: {e}")

    conn.close()

    print("\n" + "=" * 60)
    print("初始化完成!")
    print("=" * 60)


if __name__ == '__main__':
    main()
