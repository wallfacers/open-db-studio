-- =====================================================
-- 电商测试数据库 - 完整执行脚本（无存储过程版本）
-- 数据库: test_store
-- 连接信息: localhost:3306, test_user:test123456
-- =====================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- =====================================================
-- 创建数据库
-- =====================================================
CREATE DATABASE IF NOT EXISTS test_store DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE test_store;

-- =====================================================
-- 删除旧表
-- =====================================================
DROP TABLE IF EXISTS refund_records;
DROP TABLE IF EXISTS shipments;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS shopping_carts;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS addresses;
DROP TABLE IF EXISTS users;

-- =====================================================
-- 用户表
-- =====================================================
CREATE TABLE users (
    id              BIGINT PRIMARY KEY AUTO_INCREMENT,
    username        VARCHAR(50) NOT NULL UNIQUE,
    email           VARCHAR(100) NOT NULL UNIQUE,
    phone           VARCHAR(20),
    password_hash   VARCHAR(255) NOT NULL,
    nickname        VARCHAR(50),
    avatar_url      VARCHAR(255),
    gender          TINYINT DEFAULT 0,
    birthday        DATE,
    status          TINYINT DEFAULT 1,
    register_source VARCHAR(20),
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL,
    last_login_at   DATETIME,
    INDEX idx_email (email),
    INDEX idx_phone (phone),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';

-- =====================================================
-- 收货地址表
-- =====================================================
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='收货地址表';

-- =====================================================
-- 商品分类表
-- =====================================================
CREATE TABLE categories (
    id          INT PRIMARY KEY AUTO_INCREMENT,
    name        VARCHAR(50) NOT NULL,
    parent_id   INT DEFAULT NULL,
    level       TINYINT NOT NULL,
    sort_order  INT DEFAULT 0,
    icon_url    VARCHAR(255),
    status      TINYINT DEFAULT 1,
    created_at  DATETIME NOT NULL,
    updated_at  DATETIME NOT NULL,
    INDEX idx_parent_id (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品分类表';

-- =====================================================
-- 商品表
-- =====================================================
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
    status         TINYINT DEFAULT 1,
    created_at     DATETIME NOT NULL,
    updated_at     DATETIME NOT NULL,
    INDEX idx_category_id (category_id),
    INDEX idx_status (status),
    FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品表';

-- =====================================================
-- 购物车表
-- =====================================================
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='购物车表';

-- =====================================================
-- 订单表
-- =====================================================
CREATE TABLE orders (
    id               BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_no         VARCHAR(32) NOT NULL UNIQUE,
    user_id          BIGINT NOT NULL,
    address_id       BIGINT NOT NULL,
    total_amount     DECIMAL(10,2) NOT NULL,
    pay_amount       DECIMAL(10,2) NOT NULL,
    discount_amount  DECIMAL(10,2) DEFAULT 0,
    freight_amount   DECIMAL(10,2) DEFAULT 0,
    status           TINYINT NOT NULL,
    payment_method   VARCHAR(20),
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';

-- =====================================================
-- 订单明细表
-- =====================================================
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单明细表';

-- =====================================================
-- 支付记录表
-- =====================================================
CREATE TABLE payments (
    id             BIGINT PRIMARY KEY AUTO_INCREMENT,
    payment_no     VARCHAR(32) NOT NULL UNIQUE,
    order_id       BIGINT NOT NULL,
    user_id        BIGINT NOT NULL,
    amount         DECIMAL(10,2) NOT NULL,
    payment_method VARCHAR(20) NOT NULL,
    status         TINYINT NOT NULL,
    failure_reason VARCHAR(255),
    paid_at        DATETIME,
    created_at     DATETIME NOT NULL,
    INDEX idx_order_id (order_id),
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付记录表';

-- =====================================================
-- 物流记录表
-- =====================================================
CREATE TABLE shipments (
    id              BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id        BIGINT NOT NULL,
    company         VARCHAR(50) NOT NULL,
    tracking_no     VARCHAR(50) NOT NULL,
    status          TINYINT NOT NULL,
    shipped_at      DATETIME,
    received_at     DATETIME,
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL,
    INDEX idx_order_id (order_id),
    INDEX idx_tracking_no (tracking_no),
    FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='物流记录表';

-- =====================================================
-- 退款记录表
-- =====================================================
CREATE TABLE refund_records (
    id             BIGINT PRIMARY KEY AUTO_INCREMENT,
    refund_no      VARCHAR(32) NOT NULL UNIQUE,
    order_id       BIGINT NOT NULL,
    user_id        BIGINT NOT NULL,
    amount         DECIMAL(10,2) NOT NULL,
    reason         VARCHAR(255),
    status         TINYINT NOT NULL,
    refunded_at    DATETIME,
    created_at     DATETIME NOT NULL,
    updated_at     DATETIME NOT NULL,
    INDEX idx_order_id (order_id),
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='退款记录表';

SELECT '✓ 表结构创建完成' AS message;

SET FOREIGN_KEY_CHECKS = 1;
