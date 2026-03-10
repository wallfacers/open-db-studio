# ADR-001: 选择 Tauri 而非 Electron

**状态**: 已接受
**日期**: 2026-03-10
**决策者**: @wushengzhou

## 背景

需要为 open-db-studio 选择桌面应用框架。主要候选方案为 Tauri 2.x 和 Electron。

## 决策

选择 **Tauri 2.x**。

## 后果

### 优点
- 安装包体积：Tauri ≈ 5-10MB vs Electron ≈ 80-150MB
- 内存占用：Tauri 使用系统 WebView，无捆绑 Chromium
- Rust 后端原生支持多数据库驱动（sqlx、rusqlite）
- 安全模型更严格（CSP、allowlist）

### 缺点
- Rust 学习成本高于 Node.js
- 跨平台 WebView 渲染一致性需要额外测试

### 风险
- WebView2（Windows）版本依赖：需确保目标用户 Windows 10 1803+ 已安装 WebView2
