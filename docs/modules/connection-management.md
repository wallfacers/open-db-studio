# 连接管理

> **模块类型**：核心功能
> **首次发布**：MVP
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

连接管理是 Open DB Studio 的核心入口模块，提供统一的多数据源连接管理能力。支持 MySQL、PostgreSQL、Oracle、SQL Server、SQLite、ClickHouse、Doris、TiDB 等 8 种数据库，提供连接分组、SSL/TLS 加密、连接池缓存等功能。

### 快速入门

**1. 新建连接**
- 点击左侧 ActivityBar 的 🔌 图标
- 选择数据库驱动类型
- 填写主机、端口、用户名、密码
- 点击「测试连接」验证
- 保存连接

**2. 连接分组**
- 右键点击连接列表空白处 → 「新建分组」
- 拖拽连接到分组中进行归类
- 支持生产环境/测试环境/开发环境等分组策略

**3. SQLite 本地连接**
- 选择 SQLite 驱动类型
- 点击文件选择器选择 `.db` 或 `.sqlite` 文件
- 无需网络配置，直接连接本地文件

### 操作说明

**新建连接流程**
1. 选择驱动类型（MySQL/PostgreSQL/Oracle/SQL Server/SQLite/ClickHouse/Doris/TiDB）
2. 配置连接参数：
   - 主机地址（SQLite 为文件路径）
   - 端口号（各数据库默认端口自动填充）
   - 数据库名
   - 用户名/密码
3. SSL/TLS 配置（可选）：
   - 启用 SSL 连接
   - 配置 CA 证书、客户端证书
4. 点击「测试连接」验证连通性
5. 保存连接配置

**连接分组管理**
- 新建分组：右键菜单 → 「新建分组」
- 编辑分组：右键分组 → 「重命名」/「删除」
- 移动连接：拖拽连接到目标分组

**连接操作**
- 双击连接：建立连接并展开数据库对象树
- 右键连接：编辑、删除、复制连接配置
- 连接状态：实时显示连接/断开状态

### 常见问题

**Q: 连接测试失败如何处理？**
A: 检查主机地址、端口号、防火墙设置，确保数据库服务正常运行。对于云数据库，检查安全组规则是否允许当前 IP 访问。

**Q: 密码如何存储？**
A: 使用 AES-256-GCM 加密存储，密钥派生自设备唯一标识，确保密码安全。

**Q: SQLite 文件权限问题？**
A: 确保应用有读写权限，检查文件是否被其他程序占用。

---

## 开发者指南

### 架构设计

连接管理模块采用分层架构：
- **前端层**：连接列表 UI、连接配置表单、分组管理
- **命令层**：Tauri invoke 命令封装
- **数据源层**：DataSource trait 统一抽象
- **驱动层**：各数据库具体实现

### 数据流

```
用户操作 → React 组件 → Tauri invoke → commands.rs
  → datasource/mod.rs → DataSource trait → 具体驱动实现
```

### API 接口

**连接 CRUD**
- `create_connection(config: ConnectionConfig) -> Result<Connection, Error>`
- `update_connection(id: i64, config: ConnectionConfig) -> Result<Connection, Error>`
- `delete_connection(id: i64) -> Result<(), Error>`
- `list_connections() -> Result<Vec<Connection>, Error>`
- `get_connection(id: i64) -> Result<Connection, Error>`

**连接操作**
- `test_connection(config: ConnectionConfig) -> Result<TestResult, Error>`
- `connect(id: i64) -> Result<ConnectionState, Error>`
- `disconnect(id: i64) -> Result<(), Error>`

**分组管理**
- `create_group(name: String, parent_id: Option<i64>) -> Result<Group, Error>`
- `update_group(id: i64, name: String) -> Result<Group, Error>`
- `delete_group(id: i64) -> Result<(), Error>`
- `list_groups() -> Result<Vec<Group>, Error>`
- `move_to_group(connection_id: i64, group_id: i64) -> Result<(), Error>`

### 扩展方式

**添加新数据库驱动**
1. 在 `src-tauri/src/datasource/` 创建新驱动模块
2. 实现 `DataSource` trait
3. 在 `src-tauri/src/datasource/mod.rs` 注册驱动
4. 前端添加驱动配置表单

**连接池配置**
修改 `src-tauri/src/datasource/pool.rs` 调整：
- 最大连接数
- 连接超时时间
- 空闲连接回收策略

### 相关文档

- 设计文档：[docs/superpowers/specs/2026-03-12-datasource-unified-pool-design.md](./2026-03-12-datasource-unified-pool-design.md)
- 数据源架构：[docs/design-docs/datasource-arch.md](../../design-docs/datasource-arch.md)
- 安全策略：[docs/SECURITY.md](../../SECURITY.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/ConnectionModal/` | 连接配置弹窗组件 |
| `src/components/ConnectionList/` | 连接列表组件 |
| `src/components/ActivityBar/` | ActivityBar 连接入口 |
| `src-tauri/src/datasource/` | Rust 数据源模块 |
| `src-tauri/src/datasource/mod.rs` | DataSource trait 定义 |
| `src-tauri/src/datasource/mysql.rs` | MySQL 驱动实现 |
| `src-tauri/src/datasource/postgres.rs` | PostgreSQL 驱动实现 |
| `src-tauri/src/crypto.rs` | AES-256-GCM 加密实现 |
| `schema/init.sql` | connections 表结构定义 |
