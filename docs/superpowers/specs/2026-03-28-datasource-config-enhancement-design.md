# 数据源连接配置增强设计

> 日期: 2026-03-28
> 状态: 已确认
> 范围: 全部 8 种驱动

## 背景

当前 `ConnectionConfig` 仅支持用户名+密码认证，连接参数（超时、池化大小、SSL）硬编码在各驱动实现中。本次增强目标：

1. 支持 3 种新认证方式：SSL 证书认证、OS 原生认证、Token/API Key
2. 4 类连接参数可配置化：超时、连接池、数据库级选项、驱动特有参数
3. 结构化 JSON 承载驱动特有扩展参数
4. 全部 8 种驱动覆盖
5. 破坏性变更 + 数据迁移

## 方案选型

**选定：方案 A — ConnectionConfig 扁平化扩展**

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 扁平化扩展 | 类型安全、Tauri 序列化匹配、前端绑定直观 | 字段较多（~18 个） |
| B. 分层 Config | 语义清晰、关注点分离 | enum 序列化复杂、SQLite 存储拆表 |
| C. 纯 JSON | 无限扩展性 | 无类型安全、调试困难 |

理由：Tauri invoke 是扁平 JSON，方案 A 天然匹配；`extra_params` JSON 作为兜底处理驱动特有参数。

## 设计详情

### 1. 数据模型

#### 1.1 Rust ConnectionConfig

文件：`src-tauri/src/datasource/mod.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    // === 基础连接 ===
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub file_path: Option<String>,

    // === 认证 ===
    pub auth_type: Option<String>,  // "password"(默认) | "ssl_cert" | "os_native" | "token"
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,      // auth_type=token 时使用

    // === SSL/TLS ===
    pub ssl_mode: Option<String>,   // "disable"|"prefer"|"require"|"verify_ca"|"verify_full"
    pub ssl_ca_path: Option<String>,
    pub ssl_cert_path: Option<String>,
    pub ssl_key_path: Option<String>,

    // === 超时 ===
    pub connect_timeout_secs: Option<u32>,
    pub read_timeout_secs: Option<u32>,

    // === 连接池 ===
    pub pool_max_connections: Option<u32>,
    pub pool_idle_timeout_secs: Option<u32>,

    // === 驱动特有参数（JSON） ===
    pub extra_params: Option<String>,
}
```

#### 1.2 SQLite connections 表新增列

```sql
ALTER TABLE connections ADD COLUMN auth_type TEXT DEFAULT 'password';
ALTER TABLE connections ADD COLUMN token_enc TEXT;
ALTER TABLE connections ADD COLUMN ssl_mode TEXT;
ALTER TABLE connections ADD COLUMN ssl_ca_path TEXT;
ALTER TABLE connections ADD COLUMN ssl_cert_path TEXT;
ALTER TABLE connections ADD COLUMN ssl_key_path TEXT;
ALTER TABLE connections ADD COLUMN connect_timeout_secs INTEGER DEFAULT 30;
ALTER TABLE connections ADD COLUMN read_timeout_secs INTEGER DEFAULT 60;
ALTER TABLE connections ADD COLUMN pool_max_connections INTEGER DEFAULT 5;
ALTER TABLE connections ADD COLUMN pool_idle_timeout_secs INTEGER DEFAULT 300;
```

`token_enc` 与 `password_enc` 同样使用 AES-256 加密存储。

#### 1.3 TypeScript 类型

```typescript
export interface Connection {
  // ...现有字段...
  auth_type?: string;
  token?: string;
  ssl_mode?: string;
  ssl_ca_path?: string;
  ssl_cert_path?: string;
  ssl_key_path?: string;
  connect_timeout_secs?: number;
  read_timeout_secs?: number;
  pool_max_connections?: number;
  pool_idle_timeout_secs?: number;
}
```

### 2. 认证方式 × 驱动支持矩阵

| 驱动 | password | ssl_cert | os_native | token |
|------|----------|----------|-----------|-------|
| MySQL | ✅ | ✅ | ✅ (socket) | ❌ |
| PostgreSQL | ✅ | ✅ | ✅ (.pgpass/peer) | ❌ |
| SQLite | ❌ | ❌ | ✅ (文件路径) | ❌ |
| Oracle | ✅ | ❌ | ✅ (OS认证) | ❌ |
| SQL Server | ✅ | ✅ | ✅ (Windows SSPI) | ❌ |
| Doris | ✅ | ✅ | ❌ | ❌ |
| TiDB | ✅ | ✅ | ❌ | ❌ |
| ClickHouse | ✅ | ✅ | ❌ | ✅ (HTTP header) |

#### 各驱动认证实现

**MySQL/Doris/TiDB**：
- `ssl_cert`：`MySqlConnectOptions` 设置 `ssl_ca`/`ssl_client_cert`/`ssl_client_key`，`ssl_mode` 映射为 `MySqlSslMode`
- `os_native`：通过 `extra_params.socket_path` 指定 Unix socket 或 Windows named pipe

**PostgreSQL**：
- `ssl_cert`：`PgConnectOptions` 设置 `ssl_ca`/`ssl_client_cert`/`ssl_client_key`，`ssl_mode` 映射为 `PgSslMode`
- `os_native`：支持 `.pgpass` 文件自动读取和 peer 认证

**SQLite**：认证不适用，`auth_type` 强制忽略

**Oracle**：
- `os_native`：通过 `/` 连接字符串实现 OS 认证
- `extra_params` 支持 TNS 名称：`{ "tns_name": "PROD_DB" }`

**SQL Server**：
- `ssl_cert`：`tiberius::Config` 的 `encrypt(true)` + 证书路径
- `os_native`：`Authentication::Integrated`（Windows SSPI/Kerberos）
- `extra_params`：`{ "instance_name": "SQLEXPRESS", "encrypt": true }`

**ClickHouse**：
- `token`：HTTP 请求头 `Authorization: Bearer {token}`
- `ssl_cert`：HTTPS URL + 客户端证书
- `extra_params`：`{ "compress": true, "max_execution_time": 60 }`

#### 工厂函数分发

```rust
fn create_datasource(config: &ConnectionConfig) -> AppResult<Arc<dyn DataSource>> {
    let auth_type = config.auth_type.as_deref().unwrap_or("password");
    validate_auth_compatibility(&config.driver, auth_type)?;
    match config.driver.as_str() { ... }
}

fn validate_auth_compatibility(driver: &str, auth_type: &str) -> AppResult<()> {
    // 不兼容组合在创建连接时报错
}
```

### 3. 连接参数

#### 3.1 超时

| 驱动 | 连接超时 | 读取超时 |
|------|---------|---------|
| MySQL | `MySqlPoolOptions::acquire_timeout` | `extra_params.statement_timeout` |
| PostgreSQL | `PgPoolOptions::acquire_timeout` | `opts.options([("statement_timeout", "...")])` |
| SQLite | 不适用 | 不适用 |
| Oracle | `oracle::Connector::connect_time` | 不适用 |
| SQL Server | `TcpStream::connect_timeout` | `tiberius::Config::query_timeout` |
| ClickHouse | `reqwest::ClientBuilder::timeout` | HTTP 请求级 timeout |

#### 3.2 连接池

- 有池化的驱动（MySQL/PG）：`pool_max_connections` 覆盖 `max_connections`，`pool_idle_timeout_secs` 覆盖 `idle_timeout`
- 无池化的驱动：字段先存储，后续启用池化时直接使用

#### 3.3 SSL 模式映射

```
"disable"     → MySQL: Disabled,  PG: Disable,   SQLServer: encrypt=false, CH: http://
"prefer"      → MySQL: Preferred, PG: Prefer,    SQLServer: -,             CH: -
"require"     → MySQL: Required,  PG: Require,    SQLServer: encrypt=true,  CH: https://
"verify_ca"   → MySQL: VerifyCa,  PG: VerifyCa,   SQLServer: trust_cert+ca, CH: https+ca
"verify_full" → MySQL: VerifyIdentity, PG: VerifyFull, SQLServer: -,       CH: -
```

默认值：`disable`，保持向后兼容。

#### 3.4 extra_params JSON 结构

```typescript
interface DriverExtraParams {
  // MySQL
  charset?: string;
  init_sql?: string;
  socket_path?: string;

  // PostgreSQL
  search_path?: string;
  application_name?: string;

  // Oracle
  tns_name?: string;
  service_name?: string;

  // SQL Server
  instance_name?: string;
  encrypt?: boolean;

  // ClickHouse
  compress?: boolean;
  max_execution_time?: number;
}
```

### 4. 前端 UI

#### 4.1 三层联动渲染

```
用户选择 driver → 决定基础字段显隐 + 可用认证方式
用户选择 auth_type → 决定认证字段显隐
driver + auth_type 联合 → 决定 extra_params 表单内容
```

#### 4.2 表单布局

```
┌─ 基础信息 ──────────────────────────────┐
│ 连接名称: [________]   驱动: [MySQL v]  │
│ 主机: [________]  端口: [3306]          │
│ 数据库: [________]                      │
└─────────────────────────────────────────┘

┌─ 认证方式 ──────────────────────────────┐
│ o 用户名密码  o SSL证书  o 系统认证     │
│  [根据选择动态显示下方字段]              │
└─────────────────────────────────────────┘

┌─ SSL/TLS（ssl_cert 认证时显示）─────────┐
│ SSL模式: [disable v]                    │
│ CA证书:  [选择文件...]                  │
│ 客户端证书: [选择文件...]               │
│ 客户端密钥: [选择文件...]               │
└─────────────────────────────────────────┘

┌─ 高级设置（可折叠）─────────────────────┐
│ 连接超时: [30]s    读取超时: [60]s      │
│ 最大连接数: [5]     空闲超时: [300]s    │
│ 驱动特有参数 (JSON): { ... }            │
└─────────────────────────────────────────┘
```

#### 4.3 DriverCapabilities 扩展

```rust
pub struct DriverCapabilities {
    // ...现有字段...
    pub supported_auth_types: Vec<String>,
    pub has_pool_config: bool,
    pub has_timeout_config: bool,
    pub has_ssl_config: bool,
    pub extra_params_schema: Option<String>,
}
```

### 5. 迁移与安全

#### 5.1 数据库迁移

新增 `schema_version` 表追踪迁移版本，v2 迁移添加所有新列（均有默认值）。

迁移逻辑在应用启动时自动执行，幂等设计。

#### 5.2 token 加密

`token_enc` 复用现有 AES-256 加密基础设施，与 `password_enc` 同等级别。

#### 5.3 统一校验

```rust
pub enum ConfigError {
    UnsupportedAuth { driver: String, auth_type: String },
    MissingField { field: String, reason: String },
    InvalidValue { field: String, value: String, constraint: String },
    FileNotFound { path: String },
}
```

校验链：driver 有效性 → auth_type 兼容性 → 必填字段完整性 → 文件路径存在性 → 端口/超时范围合法性。

### 6. 测试策略

| 层级 | 覆盖内容 |
|------|---------|
| 单元测试 | `validate_connection_config` 所有校验分支 |
| 单元测试 | 各驱动 `new()` 中 SSL/token/超时参数解析 |
| 集成测试 | MySQL/PG SSL 连接（需本地 CA，`#[ignore]`） |
| 集成测试 | 迁移脚本数据完整性 |
| 前端测试 | 连接表单 driver/auth_type 切换后字段显隐 |
