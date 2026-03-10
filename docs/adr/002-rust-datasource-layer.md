# ADR-002: 数据源连接层放在 Rust 而非前端

**状态**: 已接受
**日期**: 2026-03-10
**决策者**: @wushengzhou

## 背景

多数据源连接管理可以放在前端（Node.js 桥接）或 Rust 后端。

## 决策

所有数据源连接管理放在 **Rust 层（src-tauri/src/datasource/）**。

## 后果

### 优点
- 连接凭证（密码）不经过前端，安全边界清晰
- sqlx 连接池可跨标签页复用
- DataSource trait 提供统一抽象，新增数据源只需实现 trait

### 缺点
- 前端无法直接调试数据源连接
- Rust 编译时间增加（sqlx 编译较慢）

### 风险
- sqlx 的 Oracle/SQL Server 支持有限，后续可能需要 ODBC 桥接
