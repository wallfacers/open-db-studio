# 电商测试数据库设计文档

**日期**：2026-03-17
**状态**：待批准
**作者**：Claude Code + 用户协作
**用途**：为 open-db-studio 端到端流程、指标体系、实体图谱验证提供测试数据

---

## 1. 背景与目标

### 背景
open-db-studio V2 阶段已完成指标体系、GraphRAG 知识图谱、高精度 Text-to-SQL 等功能。需要一套真实的电商测试数据来验证：
- 端到端流程（连接 → 查询 → AI 生成 → 结果展示）
- 原子指标和复合指标的创建、查询、计算
- 实体图谱的构建和遍历
- Text-to-SQL 的准确性

### 目标
在 `localhost:3306` 的 `test_store` 数据库中创建一套中等规模的电商测试数据，包含完整交易链路和异常场景。

---

## 2. 需求确认

| 维度 | 选择 | 说明 |
|------|------|------|
| 数据规模 | 中等 | 用户~1000，商品~200，订单~5000 |
| 业务范围 | 完整交易链路 | 用户+地址+商品+分类+购物车+订单+支付+物流 |
| 时间分布 | 季度 | 2026-01-01 ~ 2026-03-31 |
| 特殊场景 | 含异常 | 取消订单5%、退款3%、支付失败2% |

---

## 3. 表结构设计

### 3.1 ER 关系

```
users ─┬─< addresses ─< orders
       │
       ├─< shopping_carts ─< products
       │
       └─< orders ─┬─< order_items ─< products
                    │
                    ├─< payments
                    │
                    ├─< shipments
                    │
                    └─< refund_records

products ─< categories
```

### 3.2 表定义

#### users（用户表）
```sql
CREATE TABLE users (
    id              BIGINT PRIMARY KEY AUTO_INCREMENT,
    username        VARCHAR(50) NOT NULL UNIQUE,
    email           VARCHAR(100) NOT NULL UNIQUE,
    phone           VARCHAR(20),
    password_hash   VARCHAR(255) NOT NULL,
    nickname        VARCHAR(50),
    avatar_url      VARCHAR(255),
    gender          TINYINT DEFAULT 0,        -- 0:未知 1:男 2:女
    birthday        DATE,
    status          TINYINT DEFAULT 1,        -- 1:正常 0:禁用
    register_source VARCHAR(20),              -- web/app/wechat
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL,
    last_login_at   DATETIME,
    INDEX idx_email (email),
    INDEX idx_phone (phone),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### addresses（收货地址）
```sql
CREATE TABLE addresses (
    id            BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id       BIGINT NOT NULL,
    receiver_name VARCHAR(50) NOT NULL,
    phone         VARCHAR(20) NOT NULL,
    province      VARCHAR(50) NOT NULL,
    city          VARCHAR(50) NOT NULL,
    district      VARCHAR(50) NOT NULL,
    detail        VARCHAR(255) NOT NULL,
    is_default    TINYINT DEFAULT 0,
    created_at    DATETIME NOT NULL,
    updated_at    DATETIME NOT NULL,
    INDEX idx_user_id (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### categories（商品分类）
```sql
CREATE TABLE categories (
    id          INT PRIMARY KEY AUTO_INCREMENT,
    name        VARCHAR(50) NOT NULL,
    parent_id   INT DEFAULT NULL,
    level       TINYINT NOT NULL,           -- 1/2/3 级分类
    sort_order  INT DEFAULT 0,
    icon_url    VARCHAR(255),
    status      TINYINT DEFAULT 1,
    created_at  DATETIME NOT NULL,
    INDEX idx_parent_id (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### products（商品）
```sql
CREATE TABLE products (
    id             BIGINT PRIMARY KEY AUTO_INCREMENT,
    category_id    INT NOT NULL,
    name           VARCHAR(200) NOT NULL,
    description    TEXT,
    price          DECIMAL(10,2) NOT NULL,
    original_price DECIMAL(10,2),
    stock          INT DEFAULT 0,
    sales_count    INT DEFAULT 0,
    main_image     VARCHAR(255),
    status         TINYINT DEFAULT 1,       -- 1:上架 0:下架
    created_at     DATETIME NOT NULL,
    updated_at     DATETIME NOT NULL,
    INDEX idx_category_id (category_id),
    INDEX idx_status (status),
    FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### shopping_carts（购物车）
```sql
CREATE TABLE shopping_carts (
    id         BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id    BIGINT NOT NULL,
    product_id BIGINT NOT NULL,
    quantity   INT NOT NULL DEFAULT 1,
    selected   TINYINT DEFAULT 1,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_user_product (user_id, product_id),
    INDEX idx_user_id (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### orders（订单）
```sql
CREATE TABLE orders (
    id               BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_no         VARCHAR(32) NOT NULL UNIQUE,
    user_id          BIGINT NOT NULL,
    address_id       BIGINT NOT NULL,
    total_amount     DECIMAL(10,2) NOT NULL,
    pay_amount       DECIMAL(10,2) NOT NULL,
    discount_amount  DECIMAL(10,2) DEFAULT 0,
    freight_amount   DECIMAL(10,2) DEFAULT 0,
    status           TINYINT NOT NULL,       -- 见状态说明
    payment_method   VARCHAR(20),            -- alipay/wechat/bank
    payment_time     DATETIME,
    ship_time        DATETIME,
    receive_time     DATETIME,
    cancel_time      DATETIME,
    cancel_reason    VARCHAR(255),
    user_remark      VARCHAR(500),
    created_at       DATETIME NOT NULL,
    updated_at       DATETIME NOT NULL,
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (address_id) REFERENCES addresses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**订单状态说明：**
| 值 | 状态 | 说明 |
|----|------|------|
| 0 | 待支付 | 订单创建，等待付款 |
| 10 | 已支付 | 付款成功，等待发货 |
| 20 | 已发货 | 已发货，等待收货 |
| 30 | 已完成 | 用户确认收货 |
| 40 | 已取消 | 用户取消或超时取消 |

#### order_items（订单明细）
```sql
CREATE TABLE order_items (
    id          BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id    BIGINT NOT NULL,
    product_id  BIGINT NOT NULL,
    product_name VARCHAR(200) NOT NULL,
    price       DECIMAL(10,2) NOT NULL,
    quantity    INT NOT NULL,
    amount      DECIMAL(10,2) NOT NULL,
    created_at  DATETIME NOT NULL,
    INDEX idx_order_id (order_id),
    INDEX idx_product_id (product_id),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### payments（支付记录）
```sql
CREATE TABLE payments (
    id             BIGINT PRIMARY KEY AUTO_INCREMENT,
    payment_no     VARCHAR(32) NOT NULL UNIQUE,
    order_id       BIGINT NOT NULL,
    user_id        BIGINT NOT NULL,
    amount         DECIMAL(10,2) NOT NULL,
    payment_method VARCHAR(20) NOT NULL,
    status         TINYINT NOT NULL,       -- 0:待支付 1:成功 2:失败
    failure_reason VARCHAR(255),
    paid_at        DATETIME,
    created_at     DATETIME NOT NULL,
    INDEX idx_order_id (order_id),
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### shipments（物流记录）
```sql
CREATE TABLE shipments (
    id              BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id        BIGINT NOT NULL,
    company         VARCHAR(50) NOT NULL,   -- 顺丰/圆通/中通等
    tracking_no     VARCHAR(50) NOT NULL,
    status          TINYINT NOT NULL,       -- 0:已揽收 1:运输中 2:派送中 3:已签收
    shipped_at      DATETIME,
    received_at     DATETIME,
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL,
    INDEX idx_order_id (order_id),
    INDEX idx_tracking_no (tracking_no),
    FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### refund_records（退款记录）
```sql
CREATE TABLE refund_records (
    id             BIGINT PRIMARY KEY AUTO_INCREMENT,
    refund_no      VARCHAR(32) NOT NULL UNIQUE,
    order_id       BIGINT NOT NULL,
    user_id        BIGINT NOT NULL,
    amount         DECIMAL(10,2) NOT NULL,
    reason         VARCHAR(255),
    status         TINYINT NOT NULL,       -- 0:申请中 1:已退款 2:已拒绝
    refunded_at    DATETIME,
    created_at     DATETIME NOT NULL,
    updated_at     DATETIME NOT NULL,
    INDEX idx_order_id (order_id),
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 4. 数据规模与分布

### 4.1 数据量统计

| 表 | 数量 | 说明 |
|----|------|------|
| users | 1,000 | 3 个月均匀注册 |
| addresses | 1,500 | 每用户 1-2 个地址 |
| categories | 20 | 3 级分类树 |
| products | 200 | 关联分类，价格 10-5000 |
| orders | 5,000 | 3 个月分布 + 周末波动 |
| order_items | 12,000 | 每单 1-4 件商品 |
| shopping_carts | 800 | 部分用户未结算商品 |
| payments | 5,000 | 含 2% 失败 |
| shipments | 4,750 | 取消/失败订单无物流 |
| refund_records | 150 | 约 3% 订单有退款 |

### 4.2 时间分布策略

**用户注册**：2026-01-01 ~ 2026-03-31 均匀分布

**订单创建**：
- 基础分布：3 个月均匀分布
- 周末波动：周六日订单量 +30%
- 日内分布：10:00-12:00、14:00-16:00、20:00-22:00 高峰

### 4.3 异常场景分布

| 场景 | 数量 | 占比 | 实现方式 |
|------|------|------|----------|
| 取消订单 | 250 | 5% | orders.status = 40 |
| 支付失败 | 100 | 2% | payments.status = 2 |
| 退款记录 | 150 | 3% | refund_records 表 |

---

## 5. 可验证指标

### 5.1 原子指标示例

| 指标名称 | 英文标识 | 表 | 列 | 聚合 | 过滤条件 |
|----------|----------|----|----|------|----------|
| 总销售额 | total_revenue | orders | pay_amount | SUM | status = 30 |
| 订单数 | order_count | orders | id | COUNT | - |
| 完成订单数 | completed_order_count | orders | id | COUNT | status = 30 |
| 取消订单数 | canceled_order_count | orders | id | COUNT | status = 40 |
| 活跃用户数 | active_users | orders | user_id | COUNT | DISTINCT |
| 平均客单价 | avg_order_amount | orders | pay_amount | AVG | status IN (20, 30) |
| 商品销量 | product_sales | order_items | quantity | SUM | - |
| 支付成功率 | payment_success_rate | payments | id | - | status = 1 / COUNT(*) |

### 5.2 复合指标示例

| 指标名称 | 公式 | 说明 |
|----------|------|------|
| 订单完成率 | completed_order_count / order_count × 100 | 完成订单占比 |
| DAU 占比 | active_users_daily / total_users × 100 | 当日活跃用户占比 |
| 退款率 | refund_count / completed_order_count × 100 | 退款订单占比 |
| 客单价指数 | avg_order_amount / baseline_amount | 相对基准的变化 |

---

## 6. 分类树设计

```
数码电子（L1）
├── 手机通讯（L2）
│   ├── 智能手机（L3）
│   └── 手机配件（L3）
├── 电脑办公（L2）
│   ├── 笔记本电脑（L3）
│   └── 电脑配件（L3）

服饰鞋包（L1）
├── 男装（L2）
│   ├── T恤（L3）
│   └── 裤子（L3）
├── 女装（L2）
│   ├── 连衣裙（L3）
│   └── 上衣（L3）
├── 鞋靴（L2）
│   ├── 运动鞋（L3）
│   └── 休闲鞋（L3）

家居生活（L1）
├── 家具（L2）
│   ├── 沙发（L3）
│   └── 床品（L3）
├── 厨具（L2）
│   ├── 炊具（L3）
│   └── 餐具（L3）

食品生鲜（L1）
├── 零食（L2）
│   ├── 坚果（L3）
│   └── 糖果（L3）
└── 饮品（L2）
    ├── 茶饮（L3）
    └── 咖啡（L3）
```

---

## 7. 实现方式

### 7.1 脚本结构

```
docs/superpowers/scripts/
├── ecommerce_test_data/
│   ├── 01_schema.sql          # 建表脚本
│   ├── 02_categories.sql      # 分类数据
│   ├── 03_products.sql        # 商品数据
│   ├── 04_users.sql           # 用户数据
│   ├── 05_addresses.sql       # 地址数据
│   ├── 06_orders.sql          # 订单 + 明细 + 支付 + 物流
│   ├── 07_refunds.sql         # 退款数据
│   ├── 08_shopping_carts.sql  # 购物车数据
│   └── run_all.sql            # 一次性执行所有脚本
```

### 7.2 数据生成策略

- 使用 MySQL 存储过程 + 随机函数批量生成
- 中文姓名/地址使用预定义数组随机组合
- 时间戳使用 `DATE_ADD` + `FLOOR(RAND() * N)` 生成随机偏移
- 订单号/支付号使用 `CONCAT('前缀', LPAD(id, 10, '0'))` 格式

### 7.3 执行顺序

1. 创建数据库 `test_store`
2. 执行 `01_schema.sql` 建表
3. 按序执行数据脚本（有外键依赖）

---

## 8. 验收标准

- [ ] 10 张表全部创建成功
- [ ] 数据量符合设计要求（±5%）
- [ ] 时间分布符合季度要求
- [ ] 异常场景占比正确
- [ ] 可执行典型指标 SQL 并返回合理结果
- [ ] 外键关联完整性（无孤儿记录）
