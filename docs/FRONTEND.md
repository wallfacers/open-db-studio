# FRONTEND.md — 前端开发规范

## 组件结构

- 每个组件一个目录，入口文件为 `index.tsx`
- 子组件放在同目录（如 `Explorer/TreeItem.tsx`）
- 命名：PascalCase，目录与组件名一致

## 颜色系统使用规范

### 基本原则

1. **必须使用 CSS 变量**：禁止在代码中硬编码颜色值
2. **语义化选择**：根据用途选择变量，而非颜色外观

### 使用示例

```tsx
// ✅ 正确：使用 CSS 变量
<div className="bg-[var(--background-panel)] text-[var(--foreground)]">
<button className="bg-[var(--primary)] hover:bg-[var(--primary-hover)]">

// ❌ 错误：硬编码颜色值
<div className="bg-[#111922] text-[#c8daea]">
<button className="bg-[#00c9a7]">
```

### 常用场景速查表

| 场景 | 推荐变量 |
|------|----------|
| 页面/应用背景 | `--background-base` |
| 侧边栏/面板 | `--background-panel` |
| 卡片/弹窗 | `--background-card` |
| Hover 状态 | `--background-hover` |
| 主按钮 | `--primary` + `--primary-foreground` |
| 次按钮 | `--secondary` + `--secondary-foreground` |
| 执行/运行按钮 | `--accent` + `--accent-foreground` |
| 主文字 | `--foreground` |
| 次要文字 | `--foreground-muted` |
| 占位符文字 | `--foreground-subtle` |
| 默认边框 | `--border` |
| 焦点边框 | `--border-focus` |
| 成功状态 | `--success` / `--success-subtle` |
| 错误状态 | `--error` / `--error-subtle` |
| 警告状态 | `--warning` / `--warning-subtle` |

### 完整颜色定义

所有颜色变量定义在 `src/index.css` 的 `:root` 中，包含：
- 核心语义色（Primary / Secondary / Accent）
- 背景层级（Background Scale）
- 文字层级（Foreground Scale）
- 边框层级（Border Scale）
- 语义状态色（Success / Warning / Error / Info）
- 数据可视化色板

详见 [DESIGN.md](./DESIGN.md) 颜色系统章节。

## Zustand Store

- 每个业务领域一个 store 文件（`store/connections.ts` 等）
- Store 只存 UI 状态和从 Rust 同步的数据
- 异步操作（invoke 调用）放在 store action 中，不放在组件里

## Tauri invoke 封装规范

所有 invoke 调用封装在 `src/hooks/` 中，不在组件内直接调用：

```typescript
// 正确（封装在 hooks/useConnections.ts）
export function useConnections() {
  const setConnections = useConnectionStore(s => s.setConnections);
  const fetchConnections = async () => {
    const list = await invoke<Connection[]>('list_connections');
    setConnections(list);
  };
  return { fetchConnections };
}
```

## 类型定义

- Rust 数据结构在 `src/types/` 中对应定义 TypeScript 接口
- 字段名约定：Rust snake_case → TypeScript camelCase
