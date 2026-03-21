# opencode-cli Sidecar 集成设计

**日期**：2026-03-21
**opencode-cli 版本**：1.2.27
**状态**：待实现

---

## 背景

项目已集成 opencode ACP 协议，`agent/server.rs` 通过 `tokio::process::Command::new("opencode-cli")` 启动服务进程，依赖用户系统 PATH 中存在 `opencode-cli`。这导致：

- 用户需手动安装 opencode-cli，增加部署门槛
- 不同用户安装的版本可能不一致，引发兼容问题
- 跨平台（Windows / Mac）安装体验不一致

**目标**：将 opencode-cli TUI CLI 二进制（v1.2.27）作为 Tauri sidecar 打包进应用，消除外部依赖。

---

## 范围

- **包含**：Windows x64、macOS ARM64（Apple Silicon）、macOS x64（Intel）三个平台的 CLI 二进制
- **不包含**：Linux（当前项目 `tauri.conf.json` targets 为 Windows + macOS，Linux 构建时见下文降级说明）
- **不包含**：opencode desktop / electron 版本

---

## 下载来源

官方 GitHub Release：`https://github.com/anomalyco/opencode/releases/tag/v1.2.27`

| 平台 | 下载文件 | ZIP 内二进制名 |
|------|---------|--------------|
| Windows x64 | `opencode-windows-x64.zip` | `opencode-cli.exe`（已有于 `D:\software\OpenCode\`） |
| macOS ARM64 | `opencode-darwin-arm64.zip` | 解压后确认名称，重命名为 `opencode-cli` |
| macOS x64   | `opencode-darwin-x64.zip`   | 解压后确认名称，重命名为 `opencode-cli` |

---

## 实现方案：Tauri externalBin（Sidecar）

### 目录结构

```
src-tauri/binaries/
├── opencode-cli-x86_64-pc-windows-msvc.exe   ← Windows CLI
├── opencode-cli-aarch64-apple-darwin          ← macOS Apple Silicon CLI
└── opencode-cli-x86_64-apple-darwin           ← macOS Intel CLI
```

命名遵循 Tauri sidecar 规范：`{binary-name}-{target-triple}[.exe]`。

**Tauri 工作原理**：
- 构建时：Tauri 根据 target triple 从 `binaries/` 目录找到对应文件，打包进安装包
- 运行时：binary 被安装到 resources 目录，文件名**不含** triple 后缀，即 `opencode-cli` / `opencode-cli.exe`

### tauri.conf.json 修改

在已有的 `bundle` 对象内新增 `externalBin` 字段（与 `active`、`targets`、`icon` 同级）：

```json
{
  "bundle": {
    "active": true,
    "targets": "all",
    "externalBin": ["binaries/opencode-cli"],
    "icon": [ ... ],
    "resources": [ ... ]
  }
}
```

> **格式说明**：`externalBin` 数组中的路径相对于 `src-tauri/`，**不含** target triple 后缀，不含 `.exe`。Tauri 构建工具会自动追加 `-{triple}[.exe]` 查找对应源文件。

### Rust 运行时路径解析

**运行时路径构造**（在 `lib.rs` app setup 处）：

使用 Tauri 2.x 官方 API `app_handle.path().resource_dir()` 获取 resource 目录（返回 `Result<PathBuf>`）：

```rust
// Tauri 2.x API：app_handle.path() 返回 &tauri::path::PathResolver
// resource_dir() 返回 Result<PathBuf, tauri::Error>
let resource_dir = app_handle.path().resource_dir()
    .map_err(|e| crate::AppError::Other(format!("Failed to get resource dir: {}", e)))?;

// Tauri 打包后 sidecar binary 文件名不含 triple 后缀，仅需区分 .exe
let cli_filename = if cfg!(target_os = "windows") {
    "opencode-cli.exe"
} else {
    "opencode-cli"
};

let cli_path = resource_dir.join(cli_filename);
```

> **API 说明**：
> - Tauri 2.x 用 `app_handle.path().resource_dir()`（`tauri::Manager::path()` + `PathResolver::resource_dir()`）
> - 与 Tauri 1.x 的 `app_handle.path_resolver().resource_dir()` 不同，注意区分
> - `cfg!(target_os)` 此处只判断文件扩展名，Triple 选择由 Tauri 构建工具在编译期完成，无交叉编译问题

### Rust 函数签名变更

**`src-tauri/src/agent/server.rs`** 涉及以下 4 个函数，均新增 `cli_path: &std::path::Path` / `cli_path: std::path::PathBuf` 参数：

```rust
// 1. spawn_child：直接调用 tokio::process::Command
fn spawn_child(cli_path: &std::path::Path, opencode_dir: &std::path::Path, port: u16)
    -> std::io::Result<tokio::process::Child>

// 2. try_start：调用 spawn_child
async fn try_start(cli_path: &std::path::Path, opencode_dir: &std::path::Path, port: u16)
    -> AppResult<Option<tokio::process::Child>>

// 3. crash_monitor：调用 try_start，需持有 cli_path 所有权以在循环中复用
async fn crash_monitor(
    app_handle: tauri::AppHandle,
    opencode_dir: std::path::PathBuf,
    port: u16,
    cli_path: std::path::PathBuf,     // ← 新增
)

// 4. start_serve：公开接口，接收 cli_path 并传入内部函数
pub async fn start_serve(
    app_handle: tauri::AppHandle,
    app_data_dir: &std::path::Path,
    port: u16,
    cli_path: std::path::PathBuf,     // ← 新增
) -> AppResult<()>
```

`start_serve` 向 `crash_monitor` 传递 `cli_path.clone()`。

### 错误消息更新

**1. `try_start` 健康检查超时错误**（`server.rs` 第 94–96 行），替换为：

```rust
// 改前（第 94–96 行完整替换）
return Err(crate::AppError::Other(
    "opencode serve did not become healthy within 10s. \
     Please check that opencode-cli is installed and accessible in PATH."
        .to_string(),
));

// 改后
return Err(crate::AppError::Other(format!(
    "opencode serve did not become healthy within 10s. \
     Bundled opencode-cli may be corrupted or incompatible with this system. \
     Binary path: {}",
    cli_path.display()
)));
```

**2. `spawn_child` 调用前增加存在性检查**（`try_start` 内，`spawn_child` 调用之前）：

```rust
if !cli_path.exists() {
    return Err(crate::AppError::Other(format!(
        "opencode-cli sidecar not found at expected path: {}. \
         This is a packaging error — please reinstall the application.",
        cli_path.display()
    )));
}
```

**3. `spawn_child` 内的 spawn 失败错误**，更新为含路径信息：

```rust
// 改前
.map_err(|e| crate::AppError::Other(format!("Failed to spawn opencode-cli: {}", e)))?;

// 改后
.map_err(|e| crate::AppError::Other(format!(
    "Failed to spawn opencode-cli at {}: {}", cli_path.display(), e
)))?;
```

### 关于 OPENCODE_DISABLE_AUTOUPDATE

`spawn_child` 的 `tokio::process::Command` builder 链中已有 `.env("OPENCODE_DISABLE_AUTOUPDATE", "true")`（现有代码已有），在重构函数签名时**必须保留**。此设置对 sidecar 场景尤为重要：若 opencode-cli 自动更新，会将新 binary 写入非 resource 目录，导致版本与打包版本不一致。

### macOS 可执行权限

Tauri 打包时会自动为 sidecar binary 设置 executable bit，发布包无需额外处理。

**本地开发场景（macOS 开发机）**，首次添加二进制后执行一次：

```bash
chmod +x src-tauri/binaries/opencode-cli-aarch64-apple-darwin
chmod +x src-tauri/binaries/opencode-cli-x86_64-apple-darwin
```

此步骤属于**手动开发者步骤**，需在 `docs/DEVELOPMENT.md` 或 README 中"本地开发环境初始化"章节明确说明，避免 macOS 开发者遇到 `Permission denied` 启动失败。

### Tauri 2 Capabilities 说明

本实现使用 `tokio::process::Command` 直接调用 sidecar 路径，**不使用** `tauri_plugin_shell`。因此**无需**在 `src-tauri/capabilities/` 中添加任何 capability 条目。`externalBin` 声明仅用于指示 Tauri 构建工具打包对应平台的二进制，不涉及运行时权限系统。

### .gitignore 确认

检查根目录 `.gitignore` 和 `src-tauri/.gitignore` 不含 `binaries/` 排除规则。二进制文件直接提交至 git（用户明确要求，避免网络问题）。

### Linux 降级处理

当前 `tauri.conf.json` `targets: "all"` 在 Linux 环境下构建时，Tauri 会寻找 `opencode-cli-x86_64-unknown-linux-gnu` 等文件但找不到，导致构建失败。

处理方式：将 `targets` 改为仅指定支持的平台，或在构建文档中说明 Linux 不受支持并在 CI 中跳过 Linux 构建。**此问题不在本次实现范围内，实现时确认后处理。**

---

## 完整数据流

```
lib.rs app setup
  ├─ app.path().resource_dir() → resource_dir
  ├─ resource_dir.join("opencode-cli[.exe]") → cli_path
  └─ start_serve(app_handle, app_data_dir, port, cli_path)
       ├─ cli_path.exists() 检查
       ├─ try_start(&opencode_dir, port, &cli_path)
       │    └─ spawn_child(cli_path, opencode_dir, port)
       │         ├─ cli_path.exists() 检查（二次防御）
       │         └─ tokio::process::Command::new(cli_path)
       │              .args(["serve", "--port", ...])
       │              .env("OPENCODE_DISABLE_AUTOUPDATE", "true")
       └─ crash_monitor(app_handle, opencode_dir, port, cli_path)
            └─ loop: try_start(&opencode_dir, port, &cli_path) on crash
```

---

## 测试要点

1. **Windows 本地 dev**：`cargo tauri dev` 启动，确认 opencode serve 正常启动，无 PATH 依赖
2. **Windows 打包**：`cargo tauri build`，安装后验证 sidecar binary 在 resources 目录
3. **macOS ARM64**：开发机上 `cargo tauri dev`，确认路径解析和进程启动
4. **macOS x64**：同上
5. **错误路径**：临时删除 sidecar binary，确认错误消息正确（"packaging error"，非 PATH 提示）
6. **崩溃重启**：手动 kill opencode-cli 进程，确认 crash_monitor 用 sidecar 路径重启

---

## 不涉及的改动

- `agent/client.rs`、`agent/config.rs`、`agent/stream.rs` 无需修改
- MCP server、ACP 通信逻辑无需修改
- 前端代码无需修改
