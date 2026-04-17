"""
MySQL 全类型测试数据生成脚本
生成 SQL 文件后通过 docker exec 导入 MySQL
一张表覆盖 MySQL 所有基本类型，1000 万条数据
"""
import random
import string
import json
import hashlib
import time
from datetime import datetime, timedelta, date, time as dtime

TOTAL_ROWS = 10_000_000
BATCH_SIZE = 5000  # 每批 INSERT 行数
OUTPUT_FILE = "/home/wallfacers/project/open-db-studio/test_migration_10m.sql"

CITIES = ['Beijing', 'Shanghai', 'Guangzhou', 'Shenzhen', 'Hangzhou']
STATUSES = ['pending', 'active', 'inactive', 'deleted']
COLORS = ['red', 'green', 'blue', 'yellow']


def rand_str(n=10):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))


def escape(s):
    """转义字符串用于 SQL"""
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"') + "'"


def gen_values(count):
    """生成 count 行的 VALUES 部分"""
    rows = []
    base_date = date(2020, 1, 1)
    for _ in range(count):
        tinyint = random.randint(-128, 127)
        tinyint_u = random.randint(0, 255)
        smallint = random.randint(-32768, 32767)
        smallint_u = random.randint(0, 65535)
        mediumint = random.randint(-8388608, 8388607)
        mediumint_u = random.randint(0, 16777215)
        int_val = random.randint(-2147483648, 2147483647)
        int_u = random.randint(0, 4294967295)
        bigint = random.randint(-9223372036854775808, 9223372036854775807)
        bigint_u = random.randint(0, 18446744073709551615)

        float_val = round(random.uniform(-99999.99, 99999.99), 2)
        double_val = round(random.uniform(-99999.99, 99999.99), 2)
        decimal_val = round(random.uniform(-99999.99, 99999.99), 2)
        bit_val = random.randint(0, 255)

        char_val = f"c{rand_str(9)}"
        varchar_val = f"v_{random.randint(0, 999999999)}_{rand_str(16)}"
        tinytext_val = f"tiny_{random.randint(0, 999999999)}"
        text_val = f"text_{random.randint(0, 999999999)}_para_" * random.randint(1, 3)
        mediumtext_val = "medium " * random.randint(5, 20) + str(random.randint(0, 999999999))
        longtext_val = "long " * random.randint(20, 60) + str(random.randint(0, 999999999))
        enum_val = random.choice(STATUSES)
        set_val = ','.join(random.sample(COLORS, random.randint(1, 4)))

        # 二进制用 HEX 编码后 UNHEX
        binary_hex = hashlib.md5(str(random.random()).encode()).hexdigest()
        varbinary_hex = hashlib.md5(f"vb_{random.random()}".encode()).hexdigest()
        tinyblob_hex = hashlib.md5(f"tb_{random.random()}".encode()).hexdigest()
        blob_hex = hashlib.md5(f"bl_{random.random()}".encode()).hexdigest()

        d = base_date + timedelta(days=random.randint(0, 3000))
        t = dtime(hour=random.randint(0, 23), minute=random.randint(0, 59), second=random.randint(0, 59))
        dt = datetime(2020, 1, 1) + timedelta(seconds=random.randint(0, 100000000))
        ts = datetime(2020, 1, 1) + timedelta(seconds=random.randint(0, 100000000))
        year_val = random.randint(2020, 2027)

        json_val = json.dumps({
            "seq": random.randint(0, 999999999),
            "name": f"item_{random.randint(0, 999999999)}",
            "active": random.choice([True, False]),
            "score": round(random.uniform(0, 100), 2),
            "tags": [f"t{random.randint(1, 10)}", f"t{random.randint(1, 10)}"],
            "addr": {"city": random.choice(CITIES), "zip": f"{random.randint(100000, 999999)}"},
            "ts": str(d)
        }, ensure_ascii=False)

        row = (
            f"({tinyint},{tinyint_u},{smallint},{smallint_u},{mediumint},{mediumint_u},"
            f"{int_val},{int_u},{bigint},{bigint_u},"
            f"{float_val},{double_val},{decimal_val},{bit_val},"
            f"{escape(char_val)},{escape(varchar_val)},{escape(tinytext_val)},{escape(text_val)},"
            f"{escape(mediumtext_val)},{escape(longtext_val)},"
            f"'{enum_val}','{set_val}',"
            f"UNHEX('{binary_hex}'),UNHEX('{varbinary_hex}'),UNHEX('{tinyblob_hex}'),UNHEX('{blob_hex}'),"
            f"'{d}','{t}','{dt}','{ts}',{year_val},"
            f"{escape(json_val)})"
        )
        rows.append(row)
    return ',\n'.join(rows)


def main():
    print(f"Generating SQL file: {OUTPUT_FILE}")
    start = time.time()

    with open(OUTPUT_FILE, 'w') as f:
        # 头部
        f.write("DROP DATABASE IF EXISTS test_migration;\n")
        f.write("CREATE DATABASE test_migration DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n")
        f.write("USE test_migration;\n\n")

        # 建表
        f.write("""CREATE TABLE all_types (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\n""")

        # 关闭自动提交，加速插入
        f.write("SET autocommit=0;\n")
        f.write("SET unique_checks=0;\n")
        f.write("SET foreign_key_checks=0;\n\n")

        # 分批生成数据
        remaining = TOTAL_ROWS
        batch_num = 0
        while remaining > 0:
            batch_num += 1
            count = min(BATCH_SIZE, remaining)
            f.write("INSERT INTO all_types (\n")
            f.write("    col_tinyint,col_tinyint_u,col_smallint,col_smallint_u,\n")
            f.write("    col_mediumint,col_mediumint_u,col_int,col_int_u,\n")
            f.write("    col_bigint,col_bigint_u,\n")
            f.write("    col_float,col_double,col_decimal,col_bit,\n")
            f.write("    col_char,col_varchar,col_tinytext,col_text,col_mediumtext,col_longtext,\n")
            f.write("    col_enum,col_set,\n")
            f.write("    col_binary,col_varbinary,col_tinyblob,col_blob,\n")
            f.write("    col_date,col_time,col_datetime,col_timestamp,col_year,\n")
            f.write("    col_json\n")
            f.write(") VALUES\n")
            f.write(gen_values(count))
            f.write(";\n\n")
            remaining -= count
            elapsed = time.time() - start
            done = TOTAL_ROWS - remaining
            speed = done / elapsed if elapsed > 0 else 0
            eta = remaining / speed if speed > 0 else 0
            print(f"  Batch {batch_num}: {done:,}/{TOTAL_ROWS:,} ({done/TOTAL_ROWS*100:.1f}%) "
                  f"- {speed:,.0f} rows/s - ETA: {eta:.0f}s")

        # 恢复设置
        f.write("SET foreign_key_checks=1;\n")
        f.write("SET unique_checks=1;\n")
        f.write("SET autocommit=1;\n")
        f.write("COMMIT;\n\n")

        # 验证
        f.write("SELECT COUNT(*) AS total_rows FROM all_types;\n")
        f.write("SHOW TABLE STATUS LIKE 'all_types';\n")

    elapsed = time.time() - start
    import os
    size_mb = os.path.getsize(OUTPUT_FILE) / 1024 / 1024
    print(f"\nSQL file generated: {OUTPUT_FILE} ({size_mb:.1f} MB)")
    print(f"Time: {elapsed:.1f}s")
    print(f"\n导入命令:")
    print(f"  docker exec -i open-db-studio-mysql mysql -uroot -proot123456 < {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
