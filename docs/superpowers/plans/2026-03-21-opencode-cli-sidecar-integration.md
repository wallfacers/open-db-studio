# opencode-cli Sidecar 集成实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 opencode-cli v1.2.27 TUI CLI 二进制作为 Tauri sidecar 打包进应用，消除用户安装 opencode-cli 的外部依赖。

**Architecture:** 使用 Tauri `externalBin` 机制，将三平台（Windows x64、macOS ARM64、macOS x64）的 CLI 二进制放入 `src-tauri/binaries/`，Tauri 构建时自动选对应平台打包。运行时通过 `app_handle.path().resource_dir()` 解析 sidecar 路径，传入重构后的 `start_serve` 函数。

**Tech Stack:** Tauri 2.x, Rust, tokio::process::Command, PowerShell（下载脚本）

---

## 文件变更清单

| 操作 | 路径 | 说明 |
|------|------|------|
| 新建 | `src-tauri/binaries/opencode-cli-x86_64-pc-windows-msvc.exe` | Windows CLI binary |
| 新建 | `src-tauri/binaries/opencode-cli-aarch64-apple-darwin` | macOS ARM64 CLI binary |
| 新建 | `src-tauri/binaries/opencode-cli-x86_64-apple-darwin` | macOS x64 CLI binary |
| 修改 | `src-tauri/tauri.conf.json` | 新增 `externalBin` |
| 修改 | `src-tauri/src/agent/server.rs` | 4 个函数签名 + 3 处错误消息 |
| 修改 | `src-tauri/src/lib.rs` | 解析 cli_path，传入 start_serve |

---

## Task 1: 创建 binaries 目录并放入二进制文件

**Files:**
- Create: `src-tauri/binaries/opencode-cli-x86_64-pc-windows-msvc.exe`
- Create: `src-tauri/binaries/opencode-cli-aarch64-apple-darwin`
- Create: `src-tauri/binaries/opencode-cli-x86_64-apple-darwin`

- [ ] **Step 1: 创建 binaries 目录**

```bash
mkdir -p src-tauri/binaries
```

- [ ] **Step 2: 复制 Windows binary**

Windows binary 已存在于 `D:\software\OpenCode\opencode-cli.exe`，按 Tauri triple 命名规范复制：

```bash
cp /d/software/OpenCode/opencode-cli.exe src-tauri/binaries/opencode-cli-x86_64-pc-windows-msvc.exe
```

验证文件存在：
```bash
ls -lh src-tauri/binaries/opencode-cli-x86_64-pc-windows-msvc.exe
```
Expected: 显示文件大小（应为几十 MB 左右）

- [ ] **Step 3: 下载并解压 macOS ARM64 binary**

```bash
cd /tmp
curl -L -o opencode-darwin-arm64.zip \
  "https://github.com/anomalyco/opencode/releases/download/v1.2.27/opencode-darwin-arm64.zip"
```

> 若网络不通，在 Windows 上用 PowerShell：
> ```powershell
> Invoke-WebRequest -Uri "https://github.com/anomalyco/opencode/releases/download/v1.2.27/opencode-darwin-arm64.zip" -OutFile "$env:TEMP\opencode-darwin-arm64.zip"
> ```

解压并查看内容（确认二进制文件名）：
```bash
mkdir -p /tmp/opencode-arm64-extract
unzip /tmp/opencode-darwin-arm64.zip -d /tmp/opencode-arm64-extract
ls -la /tmp/opencode-arm64-extract/
```
Expected: 应看到一个可执行文件，名称可能为 `opencode` 或 `opencode-cli`

- [ ] **Step 4: 将 macOS ARM64 binary 重命名放入 binaries**

根据上一步看到的实际文件名（假设为 `opencode` 或 `opencode-cli`），执行对应命令：

```bash
# 若文件名为 opencode：
cp /tmp/opencode-arm64-extract/opencode \
   src-tauri/binaries/opencode-cli-aarch64-apple-darwin

# 若文件名为 opencode-cli：
cp /tmp/opencode-arm64-extract/opencode-cli \
   src-tauri/binaries/opencode-cli-aarch64-apple-darwin
```

- [ ] **Step 5: 下载并解压 macOS x64 binary**

```bash
curl -L -o /tmp/opencode-darwin-x64.zip \
  "https://github.com/anomalyco/opencode/releases/download/v1.2.27/opencode-darwin-x64.zip"
mkdir -p /tmp/opencode-x64-extract
unzip /tmp/opencode-darwin-x64.zip -d /tmp/opencode-x64-extract
ls -la /tmp/opencode-x64-extract/
```

- [ ] **Step 6: 将 macOS x64 binary 放入 binaries**

```bash
# 根据实际文件名选择：
cp /tmp/opencode-x64-extract/opencode \
   src-tauri/binaries/opencode-cli-x86_64-apple-darwin
# 或：
cp /tmp/opencode-x64-extract/opencode-cli \
   src-tauri/binaries/opencode-cli-x86_64-apple-darwin
```

- [ ] **Step 7: 验证三个文件均存在**

```bash
ls -lh src-tauri/binaries/
```
Expected:
```
opencode-cli-aarch64-apple-darwin
opencode-cli-x86_64-apple-darwin
opencode-cli-x86_64-pc-windows-msvc.exe
```
三个文件均有合理大小（不为 0）

- [ ] **Step 8: 在 macOS 上设置可执行权限（macOS 开发机执行，Windows 上跳过）**

```bash
chmod +x src-tauri/binaries/opencode-cli-aarch64-apple-darwin
chmod +x src-tauri/binaries/opencode-cli-x86_64-apple-darwin
```

- [ ] **Step 9: 确认 .gitignore 不排除 binaries 目录**

```bash
cat .gitignore | grep -i "binaries"
cat src-tauri/.gitignore 2>/dev/null | grep -i "binaries"
```
Expected: 无输出（未排除）。若有排除规则，删除或注释掉。

- [ ] **Step 10: 提交二进制文件**

```bash
git add src-tauri/binaries/
git status
```
确认三个文件出现在 staged changes，然后：

```bash
git commit -m "feat: add opencode-cli v1.2.27 sidecar binaries (win/mac-arm64/mac-x64)"
```

---

## Task 2: 更新 tauri.conf.json

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: 在 bundle 对象内新增 externalBin**

打开 `src-tauri/tauri.conf.json`，在 `bundle` 对象内（与 `active`、`targets`、`icon`、`resources` 同级）新增 `externalBin` 字段：

```json
{
  "productName": "open-db-studio",
  "version": "0.1.0",
  "identifier": "com.open-db-studio.app",
  "build": { ... },
  "app": { ... },
  "bundle": {
    "active": true,
    "targets": "all",
    "externalBin": ["binaries/opencode-cli"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "resources": [
      "skills/db-read/SKILL.md",
      ...
    ]
  }
}
```

> **注意**：路径为 `"binaries/opencode-cli"`，相对于 `src-tauri/`，**不含** triple 后缀，**不含** `.exe`。

- [ ] **Step 2: 验证 JSON 格式正确**

```bash
cd src-tauri && node -e "JSON.parse(require('fs').readFileSync('tauri.conf.json','utf8')); console.log('JSON valid')"
```
Expected: `JSON valid`

- [ ] **Step 3: 提交**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat: add externalBin for opencode-cli sidecar in tauri.conf.json"
```

---

## Task 3: 重构 agent/server.rs

**Files:**
- Modify: `src-tauri/src/agent/server.rs`

本任务修改 4 个函数签名并更新 3 处错误消息。

- [ ] **Step 1: 修改 spawn_child 函数签名，接收 cli_path**

找到 `fn spawn_child` 函数（当前在文件第 49–63 行附近），将其改为：

```rust
fn spawn_child(
    cli_path: &std::path::Path,
    opencode_dir: &std::path::Path,
    port: u16,
) -> std::io::Result<tokio::process::Child> {
    let config_file = opencode_dir.join("opencode.json");
    tokio::process::Command::new(cli_path)    // ← 改为 cli_path
        .args(["serve", "--port", &port.to_string()])
        .current_dir(opencode_dir)
        .env("OPENCODE_CONFIG", &config_file)
        .env("OPENCODE_CONFIG_DIR", opencode_dir)
        .env("OPENCODE_DISABLE_AUTOUPDATE", "true")   // ← 保持不变
        .kill_on_drop(false)
        .spawn()
        .map_err(|e| std::io::Error::new(
            e.kind(),
            format!("Failed to spawn opencode-cli at {}: {}", cli_path.display(), e)
        ))
}
```

- [ ] **Step 2: 修改 try_start 函数签名，传入 cli_path**

找到 `async fn try_start` 函数，将签名和内部调用改为：

```rust
async fn try_start(
    cli_path: &std::path::Path,    // ← 新增
    opencode_dir: &std::path::Path,
    port: u16,
) -> AppResult<Option<tokio::process::Child>> {
    let client = reqwest::Client::new();

    if check_health(&client, port).await {
        log::info!(
            "opencode serve already running on port {}; skipping spawn",
            port
        );
        return Ok(None);
    }

    std::fs::create_dir_all(opencode_dir)
        .map_err(|e| crate::AppError::Other(format!("Failed to create agent dir: {}", e)))?;

    // 存在性检查：二进制不存在说明打包有问题
    if !cli_path.exists() {
        return Err(crate::AppError::Other(format!(
            "opencode-cli sidecar not found at expected path: {}. \
             This is a packaging error — please reinstall the application.",
            cli_path.display()
        )));
    }

    let child = spawn_child(cli_path, opencode_dir, port)    // ← 传入 cli_path
        .map_err(|e| crate::AppError::Other(e.to_string()))?;

    if !wait_for_health(&client, port).await {
        return Err(crate::AppError::Other(format!(
            "opencode serve did not become healthy within 10s. \
             Bundled opencode-cli may be corrupted or incompatible with this system. \
             Binary path: {}",
            cli_path.display()
        )));
    }

    log::info!("opencode serve started successfully on port {}", port);
    Ok(Some(child))
}
```

- [ ] **Step 3: 修改 crash_monitor 函数签名，传入 cli_path**

找到 `async fn crash_monitor` 函数，新增 `cli_path` 参数并更新 `try_start` 调用：

```rust
async fn crash_monitor(
    app_handle: tauri::AppHandle,
    opencode_dir: std::path::PathBuf,
    port: u16,
    cli_path: std::path::PathBuf,    // ← 新增
) {
    let mut retry_count: u32 = 0;

    loop {
        let maybe_child = {
            let state = app_handle.state::<crate::AppState>();
            let mut guard = state.serve_child.lock().await;

            if guard.is_none() {
                drop(guard);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }

            guard.take()
        };

        if let Some(mut child) = maybe_child {
            match child.wait().await {
                Ok(status) => log::warn!("opencode serve exited with status: {}", status),
                Err(e) => log::warn!("opencode serve wait error: {}", e),
            }
        }

        log::info!(
            "Attempting to restart opencode serve (attempt {})...",
            retry_count + 1
        );
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        match try_start(&cli_path, &opencode_dir, port).await {    // ← 传入 &cli_path
            Ok(new_child_opt) => {
                let state = app_handle.state::<crate::AppState>();
                let mut guard = state.serve_child.lock().await;
                *guard = new_child_opt;
                retry_count = 0;
                log::info!("opencode serve restarted successfully");
                let _ = app_handle.emit("serve_restarted", ());
            }
            Err(e) => {
                log::error!("Failed to restart opencode serve: {}", e);
                retry_count += 1;
                if retry_count >= 3 {
                    log::error!(
                        "opencode serve failed to restart {} time(s); giving up",
                        retry_count
                    );
                    let _ = app_handle.emit("serve_failed", ());
                    break;
                }
            }
        }
    }
}
```

- [ ] **Step 4: 修改 start_serve 函数签名，接收并传递 cli_path**

找到 `pub async fn start_serve` 函数，新增 `cli_path` 参数：

```rust
pub async fn start_serve(
    app_handle: tauri::AppHandle,
    app_data_dir: &std::path::Path,
    port: u16,
    cli_path: std::path::PathBuf,    // ← 新增
) -> AppResult<()> {
    let opencode_dir = app_data_dir.join("opencode");

    match try_start(&cli_path, &opencode_dir, port).await {    // ← 传入 &cli_path
        Ok(child_opt) => {
            {
                let state = app_handle.state::<crate::AppState>();
                let mut guard = state.serve_child.lock().await;
                *guard = child_opt;
            }

            let handle_clone = app_handle.clone();
            let dir_clone = opencode_dir.clone();
            let path_clone = cli_path.clone();    // ← clone 传给 crash_monitor
            tauri::async_runtime::spawn(async move {
                crash_monitor(handle_clone, dir_clone, port, path_clone).await;    // ← 传入
            });

            Ok(())
        }
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 5: 编译检查**

```bash
cd src-tauri && cargo check 2>&1
```
Expected: 只有 warnings，没有 errors。
若有错误，根据错误信息修正。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/agent/server.rs
git commit -m "refactor(agent): pass cli_path to server functions, update error messages"
```

---

## Task 4: 更新 lib.rs — 解析 cli_path 并传入 start_serve

**Files:**
- Modify: `src-tauri/src/lib.rs:108-115`

- [ ] **Step 1: 在 start_serve 调用前解析 cli_path**

找到 `lib.rs` 中的这段代码（第 108–115 行附近）：

```rust
// 3. 启动 opencode serve 进程（健康检查最多等 10s）
if let Err(e) = crate::agent::server::start_serve(handle.clone(), &data_dir_clone, serve_port).await {
```

将其替换为（在同一 async block 内）：

```rust
// 3. 解析 opencode-cli sidecar 路径并启动 serve 进程
// Tauri 2.x API: handle.path().resource_dir() 返回 Result<PathBuf>
// 运行时 sidecar binary 不含 triple 后缀，仅需区分 .exe
let cli_path = match handle.path().resource_dir() {
    Ok(resource_dir) => {
        let filename = if cfg!(target_os = "windows") {
            "opencode-cli.exe"
        } else {
            "opencode-cli"
        };
        resource_dir.join(filename)
    }
    Err(e) => {
        log::warn!("Failed to get resource dir for opencode-cli sidecar: {}", e);
        // 降级：尝试从 PATH 查找（兼容 dev 模式下未打包场景）
        std::path::PathBuf::from(if cfg!(target_os = "windows") {
            "opencode-cli.exe"
        } else {
            "opencode-cli"
        })
    }
};

if let Err(e) = crate::agent::server::start_serve(
    handle.clone(),
    &data_dir_clone,
    serve_port,
    cli_path,    // ← 新增
).await {
    log::warn!(
        "opencode serve failed to start (port {}): {}. \
         Other features remain available.",
        serve_port, e
    );
}
```

> **说明**：
> - `handle.path()` 返回 `&tauri::path::PathResolver`（Tauri 2.x API，非 Tauri 1.x 的 `path_resolver()`）
> - 降级路径（`PathBuf::from("opencode-cli")`）仅在 `resource_dir()` 异常时触发，通常不会发生

- [ ] **Step 2: 编译检查**

```bash
cd src-tauri && cargo check 2>&1
```
Expected: 只有 warnings，没有 errors。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(lib): resolve sidecar cli_path at startup, pass to start_serve"
```

---

## Task 5: 验证并最终确认

- [ ] **Step 1: 完整编译检查**

```bash
cd src-tauri && cargo check 2>&1
```
Expected: 无 errors

- [ ] **Step 2: 确认二进制文件在 git 中**

```bash
git log --oneline -5
git show --stat HEAD~3
```
确认 Task 1 提交中包含 3 个 binary 文件。

- [ ] **Step 3: Windows 本地 dev 验证**

```bash
npm run tauri:dev
```

启动后观察日志，确认出现：
```
opencode serve started successfully on port XXXX
```
而非 PATH 相关错误。在系统任务管理器中能看到 `opencode-cli.exe` 进程。

- [ ] **Step 4: 验证错误路径（可选，仅在开发调试时）**

临时将 `lib.rs` 中的 `cli_filename` 改为一个不存在的名字（如 `"opencode-cli-test-nonexistent"`），运行 `cargo tauri dev`，确认日志中出现：

```
opencode-cli sidecar not found at expected path: ...
This is a packaging error — please reinstall the application.
```

验证后恢复原始文件名。

- [ ] **Step 5: 更新开发文档（macOS 开发者步骤）**

若项目有 `docs/DEVELOPMENT.md` 或 `README.md`，在"本地开发环境初始化"章节添加：

```markdown
### macOS 开发者注意事项

首次 clone 仓库后，需为 macOS sidecar binary 设置可执行权限：

```bash
chmod +x src-tauri/binaries/opencode-cli-aarch64-apple-darwin
chmod +x src-tauri/binaries/opencode-cli-x86_64-apple-darwin
```
```

若无此文档，跳过此步。

---

## 注意事项

1. **Task 3 的顺序**：`spawn_child` → `try_start` → `crash_monitor` → `start_serve` 按依赖顺序修改，避免中间状态编译失败
2. **ZIP 内文件名不确定**：Step 3/5 解压后需用 `ls` 实际确认文件名，再执行 `cp` 命令
3. **Windows 下执行 curl/unzip**：若 bash 环境不可用，改用 PowerShell（见 Step 3 注释）
4. **cargo check vs cargo build**：check 速度更快，仅验证编译；完整打包测试用 `npm run tauri:build`
