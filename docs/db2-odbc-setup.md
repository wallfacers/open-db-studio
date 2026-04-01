# DB2 ODBC Driver 安装指南

本项目的 DB2 数据源通过 ODBC 桥接访问 DB2 数据库，需要在开发/运行环境中安装 IBM DB2 ODBC 驱动。

## 前置条件

- Windows 10/11 x64（自带 ODBC 驱动管理器，无需额外安装）
- Rust 编译环境（用于启用 `db2-driver` feature）

## 安装方式

### 方式一：IBM Data Server Driver Package（推荐，仅客户端驱动）

最轻量方案，仅安装 ODBC 客户端驱动，不包含 DB2 服务端。

1. 前往 [IBM Fix Central](https://www.ibm.com/support/fixcentral/) 搜索 **"IBM Data Server Driver Package"**
2. 选择对应平台版本（Windows x64）下载，约 200MB
3. 运行安装程序，默认安装路径：`C:\Program Files\IBM\IBM DATA SERVER DRIVER\`
4. 安装完成后确认 PATH 环境变量包含驱动 bin 目录（安装程序通常自动配置）

### 方式二：IBM Db2 Community Edition（含服务端，适用于本地开发测试）

如果同时需要本地 DB2 实例做功能测试：

**Docker 方式（推荐）：**

```bash
docker run -d --name db2 --privileged=true \
  -p 50000:50000 \
  -e LICENSE=accept \
  -e DB2INST1_PASSWORD=password \
  -e DBNAME=testdb \
  icr.io/db2_community/db2
```

注意：Docker 中的 DB2 实例不包含宿主机的 ODBC 驱动，仍然需要在 Windows 上安装方式一的客户端驱动。

## 安装验证

### 1. 确认 ODBC 驱动已注册

打开 Windows ODBC 数据源管理器：

```
odbcad32.exe
```

在"驱动程序"标签页中应能看到 **IBM DB2 ODBC DRIVER**。

### 2. 确认编译通过

```bash
cd src-tauri
cargo check --features db2-driver
```

### 3. 确认运行时连接

应用启动后，新建 DB2 类型连接，填入主机、端口（默认 50000）、数据库名、用户名和密码，点击"测试连接"验证。

## 连接字符串说明

本项目使用 ODBC 连接字符串直连（非 DSN 模式），格式如下：

```
Driver={IBM DB2 ODBC DRIVER};Database=<db>;Hostname=<host>;Port=<port>;Protocol=TCPIP;Uid=<user>;Pwd=<pass>;
```

无需在 `odbcad32.exe` 中配置 DSN 数据源，驱动名 `IBM DB2 ODBC DRIVER` 由安装包自动注册。

## 故障排查

| 问题 | 原因 | 解决方式 |
|------|------|---------|
| `cargo check --features db2-driver` 报找不到 ODBC | 未安装 ODBC 驱动 | 按上述步骤安装 IBM Data Server Driver Package |
| 运行时报 "DB2 driver not enabled" | 未启用 feature flag | 确保构建时传入 `--features db2-driver` |
| 运行时报 "DB2 connection failed" | 驱动名不匹配或网络不通 | 用 `odbcad32.exe` 确认驱动名为 `IBM DB2 ODBC DRIVER`；检查防火墙和端口 |
| 连接超时 | DB2 服务端未启动或端口被占用 | 确认 DB2 实例状态：`db2 list active databases` |
