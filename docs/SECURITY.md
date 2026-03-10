# SECURITY.md — 安全策略

## 连接凭证安全

- 密码存储：AES-256-GCM 加密，密钥从 OS keychain 读取
- 密码传输：前端 → Rust 通过 invoke() 传明文（本地 IPC），Rust 加密后存储
- 密码读取：Rust 解密后直接用于建立连接，**永远不返回明文给前端**
- 前端可见字段：连接配置中 `password` 字段始终为 `null`

## API Key 安全

- 存储：使用 `tauri-plugin-store` 加密存储，不写入 SQLite 明文
- 使用：仅在 Rust `llm/client.rs` 中读取，不通过 invoke 返回前端
- 日志：**禁止**在任何日志中输出 API Key（包括 debug 级别）

## 禁止事项

- 禁止在前端代码中硬编码任何凭证
- 禁止将 .env 文件提交到 git（.gitignore 已配置）
- 禁止通过 invoke 返回包含密码的数据结构
