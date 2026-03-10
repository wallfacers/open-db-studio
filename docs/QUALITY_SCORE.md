# QUALITY_SCORE.md — 代码质量标准

## TypeScript 规范

- `strict: true` 必须开启（见 tsconfig.json）
- 禁止 `any` 类型，使用 `unknown` + 类型守卫
- 所有 `invoke()` 调用必须有明确的返回类型标注
- 组件 props 必须定义 interface

## Rust 规范

- `cargo clippy` 必须 0 个 warning（CI 门控）
- 禁止 `.unwrap()`，使用 `?` 运算符或显式错误处理
- 所有公开函数必须有 doc comment (`///`)
- 异步函数统一使用 `async/await`

## 通用规范

- 函数长度：单函数不超过 50 行
- 注释：解释"为什么"而非"是什么"
- 提交信息：遵循 Conventional Commits（feat/fix/docs/refactor）
