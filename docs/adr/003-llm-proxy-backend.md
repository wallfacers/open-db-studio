# ADR-003: LLM 请求通过 Rust 后端统一代理

**状态**: 已接受
**日期**: 2026-03-10
**决策者**: @wushengzhou

## 背景

AI 请求可以从前端直接调用 OpenAI API，也可以通过 Rust 后端代理。

## 决策

所有 LLM 请求走 **Rust 层（src-tauri/src/llm/client.rs）统一代理**。

## 后果

### 优点
- API Key 不暴露在前端代码中
- 可在 Rust 层统一做限流、重试、错误处理
- schema 注入在 Rust 层完成，减少前端 IPC 数据量

### 缺点
- 流式响应实现更复杂（需要 Tauri event 机制）
- 调试链路比前端直调更长

### 风险
- streaming 响应目前使用轮询模拟，后续需改造为 Tauri emit/listen 事件流
