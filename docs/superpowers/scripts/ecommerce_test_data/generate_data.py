#!/usr/bin/env python3
"""
电商测试数据生成器
生成可直接执行的SQL文件，无需存储过程
"""

import random
import os
from datetime import datetime, timedelta
from pathlib import Path

# 配置
CONFIG = {
    'users': 1000,
    'products': 200,
    'orders': 5000,
    'refund_rate': 0.03,
    'cancel_rate': 0.05,
    'payment_fail_rate': 0.02,
}

# 基础日期
BASE_DATE = datetime(2026, 1, 1)

# 数据模板
SURNAMES = ['王','李','张','刘','陈','杨','黄','赵','周','吴','徐','孙','马','朱','胡','郭','何','高','林','罗']
GIVEN_NAMES = ['伟','芳','娜','秀英','敏','静','丽','强','磊','军','洋','勇','艳','杰','涛','明','超','霞','平','刚','华','飞','玲','英','梅','鹏','斌','俊','娟','浩']

CATEGORIES = [
    ('数码电子', [
        ('手机通讯', ['智能手机', '手机配件']),
        ('电脑办公', ['笔记本电脑', '电脑配件'])
    ]),
    ('服饰鞋包', [
        ('男装', ['T恤', '裤子']),
        ('女装', ['连衣裙', '上衣']),
        ('鞋靴', ['运动鞋', '休闲鞋'])
    ]),
    ('家居生活', [
        ('家具', ['沙发', '床品']),
        ('厨具', ['炊具', '餐具'])
    ]),
    ('食品生鲜', [
        ('零食', ['坚果', '糖果']),
        ('饮品', ['茶饮', '咖啡'])
    ])
]

PROVINCES = ['北京市', '上海市', '广东省', '浙江省', '江苏省', '四川省', '湖北省', '山东省', '河南省', '福建省']
CITIES = ['北京市', '上海市', '广州市', '深圳市', '杭州市', '南京市', '成都市', '武汉市', '青岛市', '厦门市']
DISTRICTS = ['朝阳区', '海淀区', '浦东新区', '天河区', '南山区', '西湖区', '鼓楼区', '武侯区', '洪山区', '思明区']
STREETS = ['中关村大街', '建国路', '南京路', '天河路', '科技园路', '文三路', '汉中路', '天府大道', '光谷大道', '软件园']

PRODUCT_NAMES = {
    '智能手机': ['iPhone 15 Pro Max 256GB', '华为 Mate 60 Pro', '小米 14 Pro', 'OPPO Find X6', 'vivo X100', '三星 S24 Ultra', '荣耀 Magic6', '一加 12', '真我 GT5', '红米 K70'],
    '手机配件': ['Apple MagSafe充电器', '华为快充66W', '小米GaN充电器', 'Anker充电器', 'iPhone手机壳', '钢化膜2片装', '无线蓝牙耳机', '手机支架', 'Type-C数据线', '移动电源20000mAh'],
    '笔记本电脑': ['MacBook Pro 14寸', 'MacBook Air 15寸', 'ThinkPad X1 Carbon', 'Dell XPS 15', '华为 MateBook X Pro', '小米笔记本Pro', 'RedmiBook Pro', '联想小新Pro', 'ROG 幻16', '机械革命'],
    '电脑配件': ['罗技 MX Master鼠标', '罗技 MX Keys键盘', 'Apple Magic Keyboard', 'HHKB键盘', '三星990 PRO SSD', '戴尔27寸4K显示器', 'Thunderbolt扩展坞', '笔记本支架', '电脑包', '散热器'],
    'T恤': ['纯棉T恤白色', '纯棉T恤黑色', '商务T恤灰色', '印花T恤蓝色', '休闲T恤白色', '时尚T恤深蓝', '潮流T恤白色', '纯色T恤黑色', 'LogoT恤白色', '运动T恤灰色'],
    '裤子': ['直筒牛仔裤蓝色', '修身牛仔裤蓝色', '商务休闲裤黑色', '商务西裤灰色', '工装裤卡其色', '休闲裤黑色', '运动裤黑色', '运动长裤灰色', '牛仔裤深蓝', '运动裤蓝色'],
    '连衣裙': ['纯色连衣裙黑色', '碎花连衣裙粉色', '修身连衣裙蓝色', '夏装连衣裙白色', '印花连衣裙绿色', '时尚连衣裙黑色', '设计感连衣裙灰色', '棉麻连衣裙米色', '优雅连衣裙酒红', '浪漫连衣裙粉色'],
    '上衣': ['纯棉衬衫白色', '雪纺衫粉色', '针织衫米色', '休闲上衣蓝色', '设计上衣黑色', '时尚衬衫白色', '西装外套灰色', '棉麻上衣米色', '针织开衫驼色', '蕾丝上衣白色'],
    '运动鞋': ['Air Max 270黑色', 'Air Force 1白色', 'UltraBoost黑色', 'Stan Smith白色', 'NB 574灰色', 'Gel-Kayano蓝色', '韦德之道黑色', 'KT7白色', '态极灰色', '减震旋风蓝色'],
    '休闲鞋': ['Chuck Taylor黑色', 'Old Skool黑白', 'RS-X白色', 'Classic白色', 'Go Walk灰色', '经典帆布鞋白色', '真皮休闲鞋棕色', '休闲皮鞋黑色', '大黄靴黄色', '工装靴黄色'],
    '沙发': ['现代简约三人位沙发灰色', '头等舱电动沙发棕色', '北欧风布艺沙发米色', '简约双人沙发蓝色', '真皮沙发三人位黑色', '科技布沙发灰色', '小户型双人沙发米色', '现代简约单人沙发黄色', 'KIVIK三人沙发深灰色', '实木沙发组合胡桃木色'],
    '床品': ['纯棉四件套白色', '丝绸四件套粉色', '天丝四件套灰色', '全棉四件套蓝色', '羽绒被冬季款白色', '蚕丝被四季款米色', '乳胶床垫护脊款白色', '乳胶记忆棉床垫灰色', '记忆棉枕头白色', '深睡枕白色'],
    '炊具': ['不粘炒锅32cm', '不锈钢汤锅24cm', '电饭煲4L智能款', '电炖锅2L紫砂款', '不锈钢炒锅28cm', '不锈钢汤锅20cm', '高压锅6L', '蜂窝不粘锅32cm', '铁锅手工锻打32cm', '不粘平底锅26cm'],
    '餐具': ['陶瓷餐具套装56头', '陶瓷碗盘套装20头', '玻璃碗套装6件套', '玻璃餐具套装12件', '不锈钢刀具套装7件', '菜刀套装3件', '切菜刀单把', '玻璃杯套装6只', '陶瓷杯单只', '马克杯不锈钢'],
    '坚果': ['混合坚果500g', '每日坚果750g', '夏威夷果500g', '开心果500g', '瓜子五香500g', '碧根果500g', '巴旦木500g', '腰果500g', '每日坚果1kg', '坚果礼盒1.5kg'],
    '糖果': ['沙琪玛1kg', '牛奶糖500g', '奶糖500g', '巧克力30粒装', '巧克力500g'],
    '茶饮': ['红茶包100包', '东方树叶500ml*15', '乌龙茶500ml*15', '绿茶500ml*15', '冰红茶500ml*15', '铁观音茶叶250g', '普洱茶357g', '龙井250g', '小罐茶金罐40g', '袋泡茶50包'],
    '咖啡': ['雀巢速溶咖啡48包', '星巴克VIA速溶8包', '三顿半超即溶24颗', '永璞闪萃咖啡液10颗', '隅田川挂耳咖啡20包', 'illy咖啡豆250g', 'Lavazza咖啡豆1kg', '瑞幸即溶咖啡粉12杯', '麦斯威尔速溶咖啡1kg', 'UCC速溶咖啡90g']
}

def random_date(start_days=0, end_days=90):
    days = random.randint(start_days, end_days)
    hours = random.choice([10, 11, 15, 16, 20, 21]) if random.random() < 0.6 else random.randint(0, 23)
    minutes = random.randint(0, 59)
    return BASE_DATE + timedelta(days=days, hours=hours, minutes=minutes)

def format_datetime(dt):
    return dt.strftime('%Y-%m-%d %H:%M:%S')

def generate_categories():
    lines = ['-- 分类数据', 'USE test_store;', '']
    cat_id = 1
    l3_cat_map = {}

    for l1_name, l2_cats in CATEGORIES:
        lines.append(f"INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES ({cat_id}, '{l1_name}', NULL, 1, {cat_id}, 1, NOW(), NOW());")
        l1_id = cat_id
        cat_id += 1

        for l2_name, l3_cats in l2_cats:
            lines.append(f"INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES ({cat_id}, '{l2_name}', {l1_id}, 2, {cat_id}, 1, NOW(), NOW());")
            l2_id = cat_id
            cat_id += 1

            for l3_name in l3_cats:
                l3_cat_map[l3_name] = cat_id
                lines.append(f"INSERT INTO categories (id, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES ({cat_id}, '{l3_name}', {l2_id}, 3, {cat_id}, 1, NOW(), NOW());")
                cat_id += 1

    lines.append(f"\nSELECT CONCAT('Created ', COUNT(*), ' categories') AS message FROM categories;")
    return '\n'.join(lines), l3_cat_map

def generate_products(l3_cat_map):
    lines = ['-- 商品数据 (200条)', 'USE test_store;', '']
    product_id = 1
    product_list = []

    for l3_name, products in PRODUCT_NAMES.items():
        cat_id = l3_cat_map.get(l3_name, 1)

        for product_name in products:
            # 根据分类设置价格范围
            if '手机' in l3_name:
                price = random.randint(3000, 12000)
            elif '电脑' in l3_name:
                price = random.randint(5000, 20000)
            elif '鞋' in l3_name:
                price = random.randint(200, 1500)
            elif '沙发' in l3_name or '床品' in l3_name:
                price = random.randint(500, 5000)
            elif '坚果' in l3_name or '糖果' in l3_name:
                price = random.randint(20, 200)
            elif '茶' in l3_name or '咖啡' in l3_name:
                price = random.randint(30, 300)
            else:
                price = random.randint(50, 1000)

            original_price = int(price * random.uniform(1.1, 1.3)) if random.random() < 0.7 else price
            stock = random.randint(20, 500)
            sales = random.randint(50, 5000)

            lines.append(f"INSERT INTO products (id, category_id, name, price, original_price, stock, sales_count, status, created_at, updated_at) VALUES ({product_id}, {cat_id}, '{product_name}', {price}.00, {original_price}.00, {stock}, {sales}, 1, NOW(), NOW());")
            product_list.append((product_id, price))
            product_id += 1

            if product_id > 200:
                break
        if product_id > 200:
            break

    lines.append(f"\nSELECT CONCAT('Created ', COUNT(*), ' products') AS message FROM products;")
    return '\n'.join(lines), product_list

def generate_users():
    lines = ['-- 用户数据 (1000条)', 'USE test_store;', '']
    used_phones = set()

    for i in range(1, CONFIG['users'] + 1):
        username = f'user{i:05d}'
        email = f'{username}@test.com'

        while True:
            phone = f'138{random.randint(10000000, 99999999):08d}'
            if phone not in used_phones:
                used_phones.add(phone)
                break

        nickname = random.choice(SURNAMES) + random.choice(GIVEN_NAMES)
        gender = random.randint(0, 2)
        source = random.choice(['web', 'app', 'wechat'])
        created_at = random_date()

        lines.append(f"INSERT INTO users (id, username, email, phone, password_hash, nickname, gender, status, register_source, created_at, updated_at) VALUES ({i}, '{username}', '{email}', '{phone}', '$2a$10$test12345678901234567890123456789012345678901234567890', '{nickname}', {gender}, 1, '{source}', '{format_datetime(created_at)}', '{format_datetime(created_at)}');")

    lines.append(f"\nSELECT CONCAT('Created ', COUNT(*), ' users') AS message FROM users;")
    return '\n'.join(lines)

def generate_addresses():
    lines = ['-- 地址数据 (~1500条)', 'USE test_store;', '']
    addr_id = 1

    for user_id in range(1, CONFIG['users'] + 1):
        addr_count = random.randint(1, 2)
        for j in range(addr_count):
            receiver = random.choice(SURNAMES) + random.choice(GIVEN_NAMES)
            phone = f'138{random.randint(10000000, 99999999):08d}'
            province = random.choice(PROVINCES)
            city = random.choice(CITIES)
            district = random.choice(DISTRICTS)
            street = random.choice(STREETS)
            detail = f'{street}{random.randint(1, 1000)}号'
            is_default = 1 if j == 0 else 0
            created_at = random_date()

            lines.append(f"INSERT INTO addresses (id, user_id, receiver_name, phone, province, city, district, detail, is_default, created_at, updated_at) VALUES ({addr_id}, {user_id}, '{receiver}', '{phone}', '{province}', '{city}', '{district}', '{detail}', {is_default}, '{format_datetime(created_at)}', '{format_datetime(created_at)}');")
            addr_id += 1

    lines.append(f"\nSELECT CONCAT('Created ', COUNT(*), ' addresses') AS message FROM addresses;")
    return '\n'.join(lines)

def generate_orders(product_list):
    lines = ['-- 订单数据 (5000条)', 'USE test_store;', '']

    # 取消订单索引
    cancel_orders = set(random.sample(range(1, CONFIG['orders'] + 1), int(CONFIG['orders'] * CONFIG['cancel_rate'])))
    # 支付失败订单索引
    remaining = list(set(range(1, CONFIG['orders'] + 1)) - cancel_orders)
    fail_payments = set(random.sample(remaining, int(CONFIG['orders'] * CONFIG['payment_fail_rate'])))

    payment_id = 1
    shipment_id = 1
    item_id = 1

    for order_id in range(1, CONFIG['orders'] + 1):
        user_id = random.randint(1, CONFIG['users'])
        address_id = (user_id - 1) * 2 + random.randint(1, 2)
        order_date = random_date()
        order_no = f'ORD{order_id:010d}'

        # 生成订单明细
        item_count = random.randint(1, 4)
        total_amount = 0
        order_items_sql = []

        for _ in range(item_count):
            pid, price = random.choice(product_list[:100])
            qty = random.randint(1, 3)
            amount = price * qty
            total_amount += amount
            order_items_sql.append(f"INSERT INTO order_items (id, order_id, product_id, product_name, price, quantity, amount, created_at) VALUES ({item_id}, {order_id}, {pid}, '商品{pid}', {price}.00, {qty}, {amount}.00, '{format_datetime(order_date)}');")
            item_id += 1

        freight = random.choice([0, 0, 10, 15])
        total_amount += freight

        # 确定订单状态
        if order_id in cancel_orders:
            status = 40
            cancel_time = format_datetime(order_date + timedelta(minutes=random.randint(5, 120)))
            cancel_reason = random.choice(['不想要了', '价格变动', '商品缺货', '拍错了'])
        elif order_id in fail_payments:
            status = 0
            cancel_time = 'NULL'
            cancel_reason = 'NULL'
        else:
            status = random.choice([0, 10, 20, 30])
            cancel_time = 'NULL'
            cancel_reason = 'NULL'

        payment_method = random.choice(['alipay', 'wechat', 'bank'])

        # 插入订单
        if cancel_time != 'NULL':
            lines.append(f"INSERT INTO orders (id, order_no, user_id, address_id, total_amount, pay_amount, discount_amount, freight_amount, status, payment_method, cancel_time, cancel_reason, created_at, updated_at) VALUES ({order_id}, '{order_no}', {user_id}, {address_id}, {total_amount}.00, {total_amount}.00, 0.00, {freight}.00, {status}, '{payment_method}', '{cancel_time}', '{cancel_reason}', '{format_datetime(order_date)}', '{format_datetime(order_date)}');")
        else:
            lines.append(f"INSERT INTO orders (id, order_no, user_id, address_id, total_amount, pay_amount, discount_amount, freight_amount, status, payment_method, created_at, updated_at) VALUES ({order_id}, '{order_no}', {user_id}, {address_id}, {total_amount}.00, {total_amount}.00, 0.00, {freight}.00, {status}, '{payment_method}', '{format_datetime(order_date)}', '{format_datetime(order_date)}');")

        # 插入订单明细
        lines.extend(order_items_sql)

        # 插入支付记录
        payment_no = f'PAY{order_id:010d}'
        if status == 40:
            # 取消订单没有支付记录
            pass
        elif status == 0 and order_id in fail_payments:
            pay_status = 2
            lines.append(f"INSERT INTO payments (id, payment_no, order_id, user_id, amount, payment_method, status, failure_reason, created_at) VALUES ({payment_id}, '{payment_no}', {order_id}, {user_id}, {total_amount}.00, '{payment_method}', {pay_status}, '支付超时', '{format_datetime(order_date)}');")
            payment_id += 1
        elif status == 0:
            pay_status = 0
            lines.append(f"INSERT INTO payments (id, payment_no, order_id, user_id, amount, payment_method, status, created_at) VALUES ({payment_id}, '{payment_no}', {order_id}, {user_id}, {total_amount}.00, '{payment_method}', {pay_status}, '{format_datetime(order_date)}');")
            payment_id += 1
        else:
            pay_status = 1
            paid_at = order_date + timedelta(minutes=random.randint(1, 60))
            lines.append(f"INSERT INTO payments (id, payment_no, order_id, user_id, amount, payment_method, status, paid_at, created_at) VALUES ({payment_id}, '{payment_no}', {order_id}, {user_id}, {total_amount}.00, '{payment_method}', {pay_status}, '{format_datetime(paid_at)}', '{format_datetime(order_date)}');")
            payment_id += 1

        # 插入物流记录
        if status >= 20:
            ship_company = random.choice(['顺丰速运', '圆通速递', '中通快递', '韵达快递', '申通快递'])
            ship_prefix = random.choice(['SF', 'YT', 'ZT', 'YD', 'ST'])
            tracking_no = f"{ship_prefix}{order_date.strftime('%Y%m%d')}{random.randint(100000, 999999)}"
            ship_time = order_date + timedelta(hours=random.randint(24, 72))

            if status == 30:
                ship_status = 3
                receive_time = ship_time + timedelta(hours=random.randint(24, 120))
                lines.append(f"INSERT INTO shipments (id, order_id, company, tracking_no, status, shipped_at, received_at, created_at, updated_at) VALUES ({shipment_id}, {order_id}, '{ship_company}', '{tracking_no}', {ship_status}, '{format_datetime(ship_time)}', '{format_datetime(receive_time)}', '{format_datetime(ship_time)}', '{format_datetime(receive_time)}');")
            else:
                ship_status = random.choice([1, 2])
                lines.append(f"INSERT INTO shipments (id, order_id, company, tracking_no, status, shipped_at, created_at, updated_at) VALUES ({shipment_id}, {order_id}, '{ship_company}', '{tracking_no}', {ship_status}, '{format_datetime(ship_time)}', '{format_datetime(ship_time)}', '{format_datetime(ship_time)}');")
            shipment_id += 1

    lines.append(f"\nSELECT CONCAT('Created ', COUNT(*), ' orders') AS message FROM orders;")
    lines.append(f"SELECT CONCAT('Created ', COUNT(*), ' order_items') AS message FROM order_items;")
    lines.append(f"SELECT CONCAT('Created ', COUNT(*), ' payments') AS message FROM payments;")
    lines.append(f"SELECT CONCAT('Created ', COUNT(*), ' shipments') AS message FROM shipments;")

    return '\n'.join(lines)

def generate_refunds():
    lines = ['-- 退款记录 (~150条)', 'USE test_store;', '']

    # 随机选择150个订单作为退款订单
    refund_orders = random.sample(range(1, 4001), 150)

    for idx, order_id in enumerate(refund_orders):
        refund_no = f'REF{idx+1:010d}'
        amount = random.randint(50, 5000)
        reason = random.choice(['商品质量问题', '商品与描述不符', '收到商品损坏', '七天无理由退货', '其他原因'])
        user_id = random.randint(1, CONFIG['users'])
        created_at = random_date(20, 85)

        if random.random() < 0.85:
            status = 1
            refunded_at = format_datetime(random_date(30, 89))
            lines.append(f"INSERT INTO refund_records (refund_no, order_id, user_id, amount, reason, status, refunded_at, created_at, updated_at) VALUES ('{refund_no}', {order_id}, {user_id}, {amount}.00, '{reason}', {status}, '{refunded_at}', '{format_datetime(created_at)}', '{refunded_at}');")
        elif random.random() < 0.5:
            status = 0
            lines.append(f"INSERT INTO refund_records (refund_no, order_id, user_id, amount, reason, status, created_at, updated_at) VALUES ('{refund_no}', {order_id}, {user_id}, {amount}.00, '{reason}', {status}, '{format_datetime(created_at)}', '{format_datetime(created_at)}');")
        else:
            status = 2
            lines.append(f"INSERT INTO refund_records (refund_no, order_id, user_id, amount, reason, status, created_at, updated_at) VALUES ('{refund_no}', {order_id}, {user_id}, {amount}.00, '{reason}', {status}, '{format_datetime(created_at)}', '{format_datetime(created_at)}');")

    lines.append(f"\nSELECT CONCAT('Created ', COUNT(*), ' refund_records') AS message FROM refund_records;")
    return '\n'.join(lines)

def generate_carts():
    lines = ['-- 购物车数据 (~800条)', 'USE test_store;', '']

    used = set()
    cart_id = 1

    while cart_id <= 800:
        user_id = random.randint(1, CONFIG['users'])
        product_id = random.randint(1, 100)

        if (user_id, product_id) in used:
            continue

        used.add((user_id, product_id))
        quantity = random.randint(1, 3)
        selected = 1 if random.random() < 0.8 else 0
        created_at = random_date()

        lines.append(f"INSERT INTO shopping_carts (id, user_id, product_id, quantity, selected, created_at, updated_at) VALUES ({cart_id}, {user_id}, {product_id}, {quantity}, {selected}, '{format_datetime(created_at)}', '{format_datetime(created_at)}');")
        cart_id += 1

    lines.append(f"\nSELECT CONCAT('Created ', COUNT(*), ' shopping_carts') AS message FROM shopping_carts;")
    return '\n'.join(lines)

def main():
    output_dir = Path(__file__).parent

    print("=" * 50)
    print("电商测试数据生成器")
    print("=" * 50)
    print("\n生成SQL文件...\n")

    # 生成分类数据
    print("  [1/7] 分类数据...")
    cat_sql, l3_cat_map = generate_categories()
    with open(output_dir / '02_categories.sql', 'w', encoding='utf-8') as f:
        f.write(cat_sql)

    # 生成商品数据
    print("  [2/7] 商品数据...")
    product_sql, product_list = generate_products(l3_cat_map)
    with open(output_dir / '03_products.sql', 'w', encoding='utf-8') as f:
        f.write(product_sql)

    # 生成用户数据
    print("  [3/7] 用户数据...")
    with open(output_dir / '04_users.sql', 'w', encoding='utf-8') as f:
        f.write(generate_users())

    # 生成地址数据
    print("  [4/7] 地址数据...")
    with open(output_dir / '05_addresses.sql', 'w', encoding='utf-8') as f:
        f.write(generate_addresses())

    # 生成订单数据
    print("  [5/7] 订单数据...")
    with open(output_dir / '06_orders.sql', 'w', encoding='utf-8') as f:
        f.write(generate_orders(product_list))

    # 生成退款数据
    print("  [6/7] 退款数据...")
    with open(output_dir / '07_refunds.sql', 'w', encoding='utf-8') as f:
        f.write(generate_refunds())

    # 生成购物车数据
    print("  [7/7] 购物车数据...")
    with open(output_dir / '08_shopping_carts.sql', 'w', encoding='utf-8') as f:
        f.write(generate_carts())

    print("\n" + "=" * 50)
    print("完成！SQL文件已生成到:")
    print(f"  {output_dir}")
    print("\n执行方式:")
    print("  mysql -h localhost -P 3306 -u test_user -ptest123456 < 01_schema.sql")
    print("  mysql -h localhost -P 3306 -u test_user -ptest123456 < 02_categories.sql")
    print("  mysql -h localhost -P 3306 -u test_user -ptest123456 < 03_products.sql")
    print("  ...")
    print("  或在MySQL客户端中执行: source 01_schema.sql; source 02_categories.sql; ...")
    print("=" * 50)

if __name__ == '__main__':
    main()
