#!/usr/bin/env python3
"""
电商测试数据库初始化脚本
用法: python init_database.py
"""

import mysql.connector
import os
import sys
from pathlib import Path

# 数据库连接配置
DB_CONFIG = {
    'host': 'localhost',
    'port': 3306,
    'user': 'test_user',
    'password': 'test123456',
    'charset': 'utf8mb4',
    'autocommit': True
}

# 脚本目录
SCRIPT_DIR = Path(__file__).parent

def execute_sql_file(cursor, filepath: str):
    """执行SQL文件"""
    print(f"执行: {os.path.basename(filepath)}")

    with open(filepath, 'r', encoding='utf-8') as f:
        sql_content = f.read()

    # 分割SQL语句（按分号分割，处理存储过程）
    statements = []
    current_stmt = []
    in_delimiter = False
    custom_delimiter = ';'

    for line in sql_content.split('\n'):
        stripped = line.strip()

        # 处理DELIMITER
        if stripped.upper().startswith('DELIMITER'):
            parts = stripped.split(None, 1)
            if len(parts) == 2:
                if not in_delimiter:
                    in_delimiter = True
                    custom_delimiter = parts[1]
                else:
                    # 保存当前语句
                    if current_stmt:
                        stmt = '\n'.join(current_stmt).strip()
                        if stmt and not stmt.startswith('DELIMITER'):
                            statements.append(stmt)
                        current_stmt = []
                    in_delimiter = False
                    custom_delimiter = ';'
            continue

        current_stmt.append(line)

        # 检查语句结束
        if in_delimiter:
            if stripped.endswith(custom_delimiter):
                stmt = '\n'.join(current_stmt).strip()
                if stmt and not stmt.startswith('DELIMITER'):
                    # 移除末尾的分隔符
                    statements.append(stmt[:-len(custom_delimiter)].strip())
                current_stmt = []
        else:
            if stripped.endswith(';'):
                stmt = '\n'.join(current_stmt).strip()
                if stmt:
                    statements.append(stmt)
                current_stmt = []

    # 处理最后一个语句
    if current_stmt:
        stmt = '\n'.join(current_stmt).strip()
        if stmt:
            statements.append(stmt)

    # 执行语句
    success = 0
    errors = 0

    for stmt in statements:
        if not stmt or stmt.startswith('--') or stmt.startswith('/*'):
            continue
        try:
            # 处理SOURCE命令
            if stmt.upper().startswith('SOURCE'):
                source_file = stmt.split(None, 1)[1].strip().rstrip(';')
                source_path = SCRIPT_DIR / source_file
                if source_path.exists():
                    execute_sql_file(cursor, str(source_path))
                continue

            cursor.execute(stmt)
            success += 1

            # 如果是SELECT，显示结果
            if stmt.strip().upper().startswith('SELECT'):
                try:
                    results = cursor.fetchall()
                    if results:
                        for row in results:
                            print(f"  {row}")
                except:
                    pass

        except mysql.connector.Error as e:
            # 忽略某些错误
            if 'already exists' in str(e).lower() or 'duplicate' in str(e).lower():
                continue
            if 'PROCEDURE' in str(e) and 'does not exist' in str(e):
                continue
            errors += 1
            print(f"  警告: {e}")

    print(f"  完成: {success} 条成功, {errors} 条警告")
    return errors == 0


def main():
    print("=" * 50)
    print("电商测试数据库初始化脚本")
    print("=" * 50)

    # 连接数据库
    print("\n连接数据库...")
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        cursor = conn.cursor()
        print("连接成功!")
    except mysql.connector.Error as e:
        print(f"连接失败: {e}")
        print("\n请确保:")
        print("  1. MySQL服务正在运行")
        print("  2. 用户 test_user 有权限访问")
        print("  3. 可以创建数据库")
        sys.exit(1)

    # 执行SQL文件
    sql_files = [
        '01_schema.sql',
        '02_categories.sql',
        '03_products.sql',
        # 用户和订单需要存储过程，可能需要单独处理
    ]

    print("\n开始执行SQL脚本...\n")

    for sql_file in sql_files:
        filepath = SCRIPT_DIR / sql_file
        if filepath.exists():
            execute_sql_file(cursor, str(filepath))
            print()
        else:
            print(f"文件不存在: {sql_file}\n")

    # 统计
    print("\n" + "=" * 50)
    print("数据统计")
    print("=" * 50)

    try:
        cursor.execute("USE test_store")

        tables = ['users', 'addresses', 'categories', 'products']
        for table in tables:
            try:
                cursor.execute(f"SELECT COUNT(*) FROM {table}")
                count = cursor.fetchone()[0]
                print(f"  {table}: {count}")
            except:
                print(f"  {table}: 表不存在")

    except Exception as e:
        print(f"统计失败: {e}")

    cursor.close()
    conn.close()

    print("\n" + "=" * 50)
    print("初始化完成!")
    print("=" * 50)

    # 提示后续步骤
    print("""
后续步骤:
1. 用户和订单数据需要使用存储过程生成，请在MySQL客户端中执行:
   source 04_users.sql;
   source 05_addresses.sql;
   source 06_orders.sql;
   source 07_refunds.sql;
   source 08_shopping_carts.sql;

2. 或者使用 MySQL Workbench / Navicat 等工具执行剩余脚本
""")


if __name__ == '__main__':
    main()
